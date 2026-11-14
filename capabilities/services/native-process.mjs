import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeCommand, nativeEnvironment, redactNative } from './native-host.mjs';
import { guardStillMatches } from './session-processes.mjs';
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

let child, timer, stopTimer, pollTask, stopping = false, finished = false, secrets = [];
const nativeInputs = new Map(), answers = new Set();
const state = { nonce: manifest.nonce, runnerPid: process.pid, status: 'starting', pending: [],
  stdinOpen: false, nativeSessionId: manifest.sessionId || null };
const codex = manifest.protocol === 'codex';
const eventProtocol = codex || manifest.protocol === 'summon-jsonl';
let guardDb;
function allowed(guard) {
  if (!guard) return true;
  try {
    guardDb ||= new DatabaseSync(manifest.storePath, { readOnly: true, timeout: 3000 });
    return guardStillMatches(guardDb, guard);
  } catch { return false; }
}
const clean = value => redactNative(value, secrets);
const record = patch => {
  Object.assign(state, patch, { observedAt: now() });
  json(heartbeatPath, state);
};
const event = (type, value) => append('events.jsonl', JSON.stringify({ type, at: now(), ...value }) + '\n');
const field = (value, size) => typeof value === 'string' ? clean(value).slice(0, size) : null;

function protocolLine(line) {
  if (!eventProtocol || !line.trim().startsWith('{')) return;
  let message;
  try { message = JSON.parse(line).summonEvent; } catch { return; }
  if (!message || typeof message !== 'object') return;
  if (codex && message.type === 'session' && field(message.sessionId, 512)) {
    const nativeSessionId = field(message.sessionId, 512);
    if (state.nativeSessionId && state.nativeSessionId !== nativeSessionId) return;
    const binding = { model: field(message.model, 128), effort: field(message.effort, 40) };
    const bindingRejected = message.bindingRejected === true;
    record({ nativeSessionId, binding, bindingRejected });
    event('session', { nativeSessionId, binding, bindingRejected });
  }
  if (!codex && message.type === 'session' && field(message.sessionId, 512)) {
    const nativeSessionId = field(message.sessionId, 512);
    if (!state.nativeSessionId || state.nativeSessionId === nativeSessionId) {
      record({ nativeSessionId });
      event('session', { nativeSessionId, ref: field(message.ref, 1024) });
    }
  }
  if (codex && message.type === 'turn' && message.sessionId === state.nativeSessionId && field(message.turnId, 512)) {
    const nativeTurnId = field(message.turnId, 512), turnStartedAt = field(message.startedAt, 64) || now();
    record({ nativeTurnId, turnStartedAt });
    event('turn', { nativeSessionId: state.nativeSessionId, nativeTurnId, turnStartedAt });
  }
  if (codex && message.type === 'turn-submitting' && message.sessionId === state.nativeSessionId)
    record({ turnSubmitted: true });
  if (codex && message.type === 'thread-submitting') record({ threadSubmitted: true });
  if (codex && message.type === 'thread-active' && message.sessionId === state.nativeSessionId) record({ threadActive: true });
  if (message.type === 'progress' || message.type === 'result') {
    const text = field(message.text, message.type === 'result' ? 16000 : 4000);
    if (text) {
      const evidence = { text, itemId: field(message.itemId, 512), turnId: field(message.turnId, 512),
        phase: field(message.phase, 64), confirmed: message.confirmed === true };
      if (message.type === 'result' && (!codex || evidence.turnId === state.nativeTurnId)) record({ final: evidence });
      event(message.type, evidence);
    }
  }
  if (codex && message.type === 'item' && message.turnId === state.nativeTurnId) {
    const { exitCode } = message;
    event('item', { turnId: state.nativeTurnId, itemId: field(message.itemId, 512), itemType: field(message.itemType, 80),
      status: field(message.status, 80), phase: field(message.phase, 80), command: field(message.command, 2000),
      files: Array.isArray(message.files) ? message.files.slice(0, 20).map(file => field(file, 512)) : undefined,
      output: field(message.output, 4000), exitCode: Number.isInteger(exitCode) ? exitCode : null });
  }
  if (codex && message.type === 'outcome' && ['completed', 'failed', 'stopped', 'unknown', 'not_submitted'].includes(message.status)) {
    record({ nativeOutcome: message.status, error: field(message.error, 4000) });
    event('outcome', { status: message.status, nativeTurnId: state.nativeTurnId, error: state.error });
  }
  if (codex && message.type === 'model-rerouted' && message.turnId === state.nativeTurnId) {
    const reroute = { from: field(message.from, 128), to: field(message.to, 128), reason: field(message.reason, 256) };
    record({ reroute });
    event('model-rerouted', { turnId: state.nativeTurnId, ...reroute });
  }
  if (eventProtocol && message.type === 'input-result' && field(message.inputId, 512) &&
    ['accepted', 'rejected', 'not_submitted', 'unknown'].includes(message.status)) {
    const result = { inputId: field(message.inputId, 256), status: message.status,
      turnId: field(message.turnId, 512), error: field(message.error, 4000) };
    const pending = nativeInputs.get(result.inputId);
    if (pending) {
      if (['rejected', 'not_submitted'].includes(result.status) && pending.requestId) answers.delete(pending.requestId);
      json(pending.path, { ...result, at: now() });
      nativeInputs.delete(result.inputId);
    }
    event('input-result', result);
  }
  if (message.type === 'request' && !stopping) {
    const id = field(message.id, 256), text = field(message.text, 4000);
    if (!id || !text || state.pending.some(item => item.id === id) || state.pending.length >= 32) return;
    const choices = Array.isArray(message.choices) ? message.choices.slice(0, 12)
      .filter(choice => field(choice?.id, 256) && field(choice?.label, 256))
      .map(choice => ({ id: field(choice.id, 256), label: field(choice.label, 256) })) : [];
    if (codex && message.turnId !== state.nativeTurnId) return;
    const request = { id, text, turnId: state.nativeTurnId,
      kind: ['question', 'approval', 'login'].includes(message.kind) ? message.kind : 'question', choices };
    if (request.kind === 'approval' && !choices.length) return;
    record({ status: 'awaiting-input', pending: [...state.pending, request] });
    event('request', { request });
  }
  if ((message.type === 'resolved' || message.type === 'withdrawn') && state.pending.some(item => item.id === message.id)) {
    if (!codex && message.type === 'resolved') {
      for (const [inputId, item] of nativeInputs) if (item.requestId === message.id) {
        json(item.path, { inputId, status: 'accepted', at: now() });
        nativeInputs.delete(inputId);
      }
    }
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
  const settle = () => {
    guardDb?.close();
    event('exit', { status: patch.status, exitCode: patch.exitCode, exitSignal: patch.exitSignal, error: patch.error ?? state.error });
    record({ ...patch, stdinOpen: false, finishedAt: now(), pending: [] });
  };
  if (pollTask) void pollTask.then(settle);
  else settle();
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
    if (eventProtocol) {
      void writeInput(JSON.stringify({ summonInput: { type: 'stop', id: command.id } }) + '\n').catch(() => {});
      if (!codex) stopTimer = setTimeout(() => { if (!finished) void terminateTree(child); }, 3000);
    } else void terminateTree(child);
    return;
  }
  if (stopping || finished || !state.stdinOpen || !child.stdin.writable || !allowed(command.guard)) {
    receipt({ status: 'not_submitted', error: 'The process input is closed or its authorization changed' }); return;
  }
  if (codex && (!state.nativeTurnId || command.expectedTurnId !== state.nativeTurnId || state.nativeOutcome)) {
    receipt({ status: 'rejected', error: 'The requested Codex turn is no longer active' }); return;
  }
  const request = command.requestId && state.pending.find(item => item.id === command.requestId);
  if (command.requestId && (!request || answers.has(command.requestId) || request.choices.length && !request.choices.some(item => item.id === command.text))) {
    receipt({ status: 'rejected', error: 'The native request or choice is no longer pending' });
    return;
  }
  if (request) answers.add(request.id);
  const input = eventProtocol
    ? JSON.stringify({ summonInput: { type: request ? 'answer' : 'message', id: command.id, requestId: command.requestId || null,
      expectedTurnId: command.expectedTurnId, guard: codex ? command.guard : undefined, text: command.text } }) + '\n'
    : command.text;
  receipt({ status: 'submitting', requestId: command.requestId || null });
  if (codex || request) nativeInputs.set(command.id, { path: path + '.native', requestId: command.requestId });
  try {
    await writeInput(input);
    receipt({ status: 'delivered', requestId: command.requestId || null });
    event('input', { inputId: command.id, requestId: command.requestId || null });
  } catch (error) { receipt({ status: 'unknown', error: clean(error.message) }); }
}

async function poll() {
  record({});
  const inputs = join(directory, 'inputs');
  for (const name of readdirSync(inputs).filter(name => /^\d+-[a-f0-9-]+\.json$/.test(name)).sort()) {
    if (finished) return;
    const path = join(inputs, name), receipt = path + '.receipt';
    if (!existsSync(receipt)) await applyCommand(JSON.parse(readFileSync(path, 'utf8')), receipt);
  }
}

function start() {
  if (!allowed(manifest.guard)) return finish({ status: 'not_submitted', error: 'The Session or connection changed before process launch' });
  const environment = nativeEnvironment(manifest.env, manifest.authorizedEnv);
  secrets = environment.secrets;
  const command = nativeCommand(manifest.file, manifest.args);
  record({});
  child = spawn(command.file, command.args, { ...command.options, cwd: manifest.cwd, env: environment.env,
    windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => { if (!finished) record({ stdinOpen: false }); });
  child.stdin.once('close', () => { if (!finished) record({ stdinOpen: false }); });
  pipe(child.stdout, 'stdout.log');
  pipe(child.stderr, 'stderr.log');
  child.once('spawn', () => {
    record({ pid: child.pid, status: 'running', startedAt: now(), stdinOpen: manifest.keepInput === true });
    event('started', { pid: child.pid, nativeSessionId: state.nativeSessionId });
    if (manifest.input && allowed(manifest.guard)) {
      void writeInput(manifest.input).catch(error => event('input-error', { error: clean(error.message) }));
    } else if (manifest.input) {
      event('input-error', { error: 'The Session authority changed before the initial input was sent' });
      child.stdin.end();
    }
    if (!manifest.keepInput) child.stdin.end();
    timer = setInterval(() => {
      if (finished || pollTask) return;
      pollTask = poll().catch(error => event('supervisor-error', { error: clean(error.message) })).finally(() => { pollTask = null; });
    }, 750);
  });
  child.once('error', error => finish({ status: 'failed', error: clean(error.message) }));
  child.once('close', (exitCode, exitSignal) => finish({
    status: codex ? state.nativeOutcome || (state.nativeTurnId || state.turnSubmitted || state.threadSubmitted ? 'unknown' : stopping ? 'stopped' : 'failed') :
      stopping ? 'stopped' : exitCode === 0 ? 'completed' : 'failed', exitCode, exitSignal,
  }));
}

try { start(); }
catch (error) { finish({ status: 'failed', error: clean(error.message) }); }
