import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeCommand, nativeEnvironment, redactNative } from './native-host.mjs';
import { terminateTree } from '../../bot/src/runtime/process-tools.mjs';

const directory = process.argv[2];
const manifest = JSON.parse(readFileSync(join(directory, 'launch.json'), 'utf8'));
const now = () => new Date().toISOString();
const heartbeatPath = join(directory, 'state.json');
const own = join(directory, 'started');
const json = (path, value) => {
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
};
const append = (name, text) => appendFileSync(join(directory, name), text, { mode: 0o600 });
// If the launching service lost its receipt it must never start this action a second time.
writeFileSync(own, String(process.pid), { flag: 'wx', mode: 0o600 });

let child, timer, stopTimer, stopping = false, finished = false, secrets = [];
const state = { nonce: manifest.nonce, runnerPid: process.pid, status: 'starting', pending: [], nativeSessionId: manifest.sessionId || null };
const clean = value => redactNative(value, secrets);
const record = patch => {
  Object.assign(state, patch, { observedAt: now() });
  json(heartbeatPath, state);
};
const event = (type, value) => append('events.jsonl', JSON.stringify({ type, at: now(), ...value }) + '\n');
const field = (value, size) => typeof value === 'string' ? clean(value).slice(0, size) : null;

function protocolLine(line) {
  if (manifest.protocol !== 'summon-jsonl' || !line.trim().startsWith('{')) return;
  let message;
  try { message = JSON.parse(line).summonEvent; } catch { return; }
  if (!message || typeof message !== 'object') return;
  if (message.type === 'session' && field(message.sessionId, 512)) {
    const nativeSessionId = field(message.sessionId, 512);
    record({ nativeSessionId });
    event('session', { nativeSessionId, ref: field(message.ref, 1024) });
  }
  if (message.type === 'progress' || message.type === 'result') {
    const text = field(message.text, 4000);
    if (text) event(message.type, { text });
  }
  if (message.type === 'request' && !stopping) {
    const id = field(message.id, 256), text = field(message.text, 4000);
    if (!id || !text || state.pending.some(item => item.id === id) || state.pending.length >= 32) return;
    const choices = Array.isArray(message.choices) ? message.choices.slice(0, 12)
      .filter(choice => field(choice?.id, 256) && field(choice?.label, 256))
      .map(choice => ({ id: field(choice.id, 256), label: field(choice.label, 256) })) : [];
    const request = { id, text, kind: ['question', 'approval', 'login'].includes(message.kind) ? message.kind : 'question', choices };
    if (request.kind === 'approval' && !choices.length) return;
    record({ status: 'awaiting-input', pending: [...state.pending, request] });
    event('request', { request });
  }
  if ((message.type === 'resolved' || message.type === 'withdrawn') && state.pending.some(item => item.id === message.id)) {
    const pending = state.pending.filter(item => item.id !== message.id);
    record({ status: stopping ? 'stopping' : pending.length ? 'awaiting-input' : 'running', pending });
    event(message.type, { requestId: message.id });
  }
}

function pipe(stream, name) {
  let buffer = '';
  stream.setEncoding('utf8');
  const line = value => {
    append(name, clean(value));
    if (name === 'stdout.log') protocolLine(value);
  };
  stream.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      line(buffer.slice(0, end + 1));
      buffer = buffer.slice(end + 1);
    }
    if (buffer.length > 262_144) {
      append(name, clean(buffer.slice(0, -65_536)));
      buffer = buffer.slice(-65_536);
    }
  });
  stream.on('end', () => { if (buffer) line(buffer); });
}

function finish(patch) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  clearTimeout(stopTimer);
  record({ ...patch, finishedAt: now(), pending: [] });
  event('exit', { status: state.status, exitCode: state.exitCode, exitSignal: state.exitSignal, error: state.error });
}

function writeInput(text) {
  return new Promise((accept, reject) => {
    if (!child?.stdin.writable) { reject(new Error('Native input is closed')); return; }
    child.stdin.write(text, error => error ? reject(error) : accept());
  });
}

async function applyCommand(command, path) {
  if (command.nonce !== manifest.nonce || !['input', 'stop'].includes(command.type)) return;
  const receipt = patch => json(path, { id: command.id, at: now(), ...patch });
  if (command.type === 'stop') {
    if (stopping || finished) { receipt({ status: 'already-settling' }); return; }
    stopping = true;
    record({ status: 'stopping' });
    receipt({ status: 'requested' });
    if (manifest.protocol === 'summon-jsonl') {
      void writeInput(JSON.stringify({ summonInput: { type: 'stop', id: command.id } }) + '\n').catch(() => {});
      stopTimer = setTimeout(() => { if (!finished) void terminateTree(child); }, 3000);
    } else void terminateTree(child);
    return;
  }
  if (stopping || finished) { receipt({ status: 'rejected', error: 'The operation has stopped' }); return; }
  const request = command.requestId && state.pending.find(item => item.id === command.requestId);
  if (command.requestId && (!request || request.choices.length && !request.choices.some(item => item.id === command.text))) {
    receipt({ status: 'rejected', error: 'The native request or choice is no longer pending' });
    return;
  }
  const input = manifest.protocol === 'summon-jsonl'
    ? JSON.stringify({ summonInput: { type: request ? 'answer' : 'message', id: command.id, requestId: command.requestId || null, text: command.text } }) + '\n'
    : command.text;
  receipt({ status: 'submitting', requestId: command.requestId || null });
  try {
    await writeInput(input);
    receipt({ status: 'delivered', requestId: command.requestId || null });
    event('input', { inputId: command.id, requestId: command.requestId || null });
  } catch (error) { receipt({ status: 'unknown', error: clean(error.message) }); }
}

let busy = false;
async function poll() {
  if (finished || busy) return;
  busy = true;
  try {
    record({});
    const inputs = join(directory, 'inputs');
    for (const name of readdirSync(inputs).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort()) {
      const path = join(inputs, name), receipt = path + '.receipt';
      if (!existsSync(receipt)) await applyCommand(JSON.parse(readFileSync(path, 'utf8')), receipt);
    }
  } finally { busy = false; }
}

try {
  const environment = nativeEnvironment(manifest.env, manifest.authorizedEnv);
  secrets = environment.secrets;
  const command = nativeCommand(manifest.file, manifest.args);
  record({});
  child = spawn(command.file, command.args, { ...command.options, cwd: manifest.cwd, env: environment.env,
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // The write callback records the outcome.
  pipe(child.stdout, 'stdout.log');
  pipe(child.stderr, 'stderr.log');
  child.once('spawn', () => {
    record({ pid: child.pid, status: 'running', startedAt: now() });
    event('started', { pid: child.pid, nativeSessionId: state.nativeSessionId });
    if (manifest.input) void writeInput(manifest.input).catch(error => event('input-error', { error: clean(error.message) }));
    if (!manifest.keepInput) child.stdin.end();
    timer = setInterval(() => { void poll().catch(error => event('supervisor-error', { error: clean(error.message) })); }, 750);
  });
  child.once('error', error => finish({ status: 'failed', error: clean(error.message) }));
  child.once('close', (exitCode, exitSignal) => finish({ status: stopping ? 'stopped' : exitCode === 0 ? 'completed' : 'failed', exitCode, exitSignal }));
} catch (error) { finish({ status: 'failed', error: clean(error.message) }); }
