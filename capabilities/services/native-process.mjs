import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nativeCommand, nativeEnvironment, nativeSpawnFailureCode, redactNative, redactNativeCredentials } from './native-host.mjs';
import { guardStillMatches, heartbeatExpiryMs } from './session-processes.mjs';
import { pipeNativeText } from './windows-native-text.mjs';
import { terminateTree } from '../../bot/src/runtime/process-tools.mjs';
import { samePath } from '../../bot/src/capabilities/file-policy.mjs';

const directory = process.argv[2];
const manifest = JSON.parse(readFileSync(join(directory, 'launch.json'), 'utf8'));
const now = () => new Date().toISOString();
const heartbeatPath = join(directory, 'state.json');
const finishedPath = join(directory, 'finished.json');
const own = join(directory, 'started');
const json = (path, value) => {
  const temporary = path + '.' + process.pid + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
};
const append = (name, text) => appendFileSync(join(directory, name), text, { mode: 0o600 });
// If the launching service lost its receipt it must never start this action a second time.
writeFileSync(own, String(process.pid), { flag: 'wx', mode: 0o600 });

let child, timer, stopTimer, stopTree, drainTimer, pollTask, heartbeatFailure, stopping = false, finished = false, secrets = [];
const nativeInputs = new Map(), answers = new Set();
const heartbeatDelays = new Set();
const managedAdapter = manifest.managedAdapter === true;
const state = { nonce: manifest.nonce, runnerPid: process.pid, status: 'starting', pending: [],
  stdinOpen: false, nativeSessionId: managedAdapter ? null : manifest.sessionId || null };
const codex = manifest.protocol === 'codex';
const eventProtocol = codex || manifest.protocol === 'summon-jsonl';
const reportsOutcome = codex || managedAdapter;
const promptFile = manifest.usesPromptFile === true ? join(directory, 'connector-prompt.txt') : null;
const adapterFile = manifest.cleanupAdapter === true ? join(directory, 'adapter.mjs') : null;
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
  try {
    json(heartbeatPath, state);
  } catch (error) {
    if (process.platform !== 'win32' || error.syscall !== 'rename' || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
    if (state.finishedAt) {
      // Publish the terminal snapshot separately when the heartbeat is locked.
      renameSync(heartbeatPath + '.' + process.pid + '.tmp', finishedPath);
      return;
    }
    const failure = heartbeatFailure ??= { since: Date.now(), reported: false };
    const delay = `${state.status}:${error.code}`;
    if (!heartbeatDelays.has(delay)) {
      event('state-write-delayed', { status: state.status, error: error.code });
      heartbeatDelays.add(delay);
    }
    const elapsedMs = Date.now() - failure.since;
    if (!failure.reported && elapsedMs >= heartbeatExpiryMs) {
      event('state-write-unavailable', { status: state.status, error: error.code, elapsedMs });
      failure.reported = true;
    }
    return;
  }
  if (heartbeatFailure?.reported) event('state-write-restored', { status: state.status, elapsedMs: Date.now() - heartbeatFailure.since });
  heartbeatFailure = undefined;
};
const event = (type, value) => append('events.jsonl', JSON.stringify({ type, at: now(), ...value }) + '\n');
const field = (value, size) => typeof value === 'string' ? clean(value).slice(0, size) : null;
const maxNativeLine = 262_144;
const nativeText = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0');
const credentialFree = value => redactNativeCredentials(value, secrets) === value;

function unsupportedRequest(error, requestId) {
  record({ error, code: 'native_request_unsupported', status: 'awaiting-input' });
  event('input-error', { requestId, error });
}

function protocolLine(line) {
  if (!eventProtocol || !line.trim().startsWith('{')) return;
  let message;
  try { message = JSON.parse(line).summonEvent; } catch { return; }
  if (!message || typeof message !== 'object') return;
  if (codex && message.type === 'session' && field(message.sessionId, 512)) {
    const nativeSessionId = field(message.sessionId, 512);
    if (state.nativeSessionId && state.nativeSessionId !== nativeSessionId) return;
    const binding = { model: field(message.model, 128), effort: field(message.effort, 40),
      ...(message.sandbox && { sandbox: field(message.sandbox, 40), approval_policy: field(message.approvalPolicy, 40) }) };
    const bindingRejected = message.bindingRejected === true;
    record({ nativeSessionId, binding, bindingRejected });
    event('session', { nativeSessionId, binding, bindingRejected });
  }
  if (!codex && message.type === 'session' && field(message.sessionId, 512)) {
    const nativeSessionId = field(message.sessionId, 512);
    if (managedAdapter && manifest.sessionId && nativeSessionId !== manifest.sessionId) return;
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
    event('item', { turnId: state.nativeTurnId, itemId: field(message.itemId, 512), itemType: field(message.itemType, 80), tool: field(message.tool, 120),
      status: field(message.status, 80), phase: field(message.phase, 80), command: field(message.command, 2000),
      files: Array.isArray(message.files) ? message.files.slice(0, 20).map(file => field(file, 512)) : undefined,
      output: field(message.output, 4000), exitCode: Number.isInteger(exitCode) ? exitCode : null });
  }
  if (!codex && message.type === 'tool') {
    event('tool', { itemId: field(message.itemId, 512), tool: field(message.tool, 120),
      phase: field(message.phase, 32), status: field(message.status, 32), command: field(message.command, 2000), text: field(message.text, 2000) });
  }
  if (reportsOutcome && message.type === 'outcome' && ['completed', 'failed', 'stopped', 'unknown', 'not_submitted', 'unsupported'].includes(message.status)) {
    record({ nativeOutcome: message.status, stdinOpen: false, error: field(message.error, 4000),
      ...(codex && message.status === 'failed' && message.code === 'native_spawn_failed' ? { code: 'native_spawn_failed' } : {}) });
    event('outcome', { status: message.status, nativeTurnId: state.nativeTurnId, error: state.error });
    drainExitedBridge();
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
      json(pending.path, { ...result, at: now(), ...(!codex && result.status === 'accepted' ? { explicitAck: true } : {}) });
      nativeInputs.delete(result.inputId);
    }
    event('input-result', result);
  }
  if (message.type === 'request' && !stopping) {
    if (codex && message.turnId !== state.nativeTurnId) return;
    const id = nativeText(message.id, 256) && credentialFree(message.id) ? message.id : undefined;
    if (id && state.pending.some(item => item.id === id)) return;
    if (message.isSecret === true) return unsupportedRequest('The native question requires a channel that can protect secret input', id);
    if (!id || !nativeText(message.text, 32_768))
      return unsupportedRequest('The native request has an invalid ID or exceeds the question size limit', id);
    if (state.pending.length >= 32) return unsupportedRequest('The native process has more than 32 unanswered requests', id);
    const options = message.choices ?? [];
    if (!Array.isArray(options) || options.some(choice => !nativeText(choice?.id, 32_768) ||
        !nativeText(choice?.label, 32_768) || !credentialFree(choice.id)) ||
        new Set(options.map(choice => choice.id)).size !== options.length) {
      return unsupportedRequest('The native request provided invalid, ambiguous, or unsupported choices', id);
    }
    const choices = options.map(choice => ({ id: choice.id, label: clean(choice.label) }));
    const request = { id, text: clean(message.text), turnId: state.nativeTurnId,
      kind: ['question', 'approval', 'login'].includes(message.kind) ? message.kind : 'question', choices,
      ...(codex && ['choice_id', 'text', 'one_answer_per_line', 'json_text'].includes(message.answer_format) && { answer_format: message.answer_format }),
      plain_text: !choices.length && !message.schema && (message.plain_text ?? (manifest.protocol !== 'codex')) === true };
    if (request.kind === 'approval' && !choices.length)
      return unsupportedRequest('The native approval does not offer a supported decision', id);
    record({ status: 'awaiting-input', pending: [...state.pending, request] });
    event('request', { request });
  }
  if ((message.type === 'resolved' || message.type === 'withdrawn') && state.pending.some(item => item.id === message.id)) {
    if (!codex && message.type === 'resolved') {
      for (const [inputId, item] of nativeInputs) if (item.requestId === message.id && !item.resolved) {
        json(item.path + '.resolved', { inputId, status: 'accepted', at: now() });
        item.resolved = true;
      }
    }
    const pending = state.pending.filter(item => item.id !== message.id);
    record({ status: stopping ? 'stopping' : pending.length ? 'awaiting-input' : 'running', pending });
    event(message.type, { requestId: message.id });
  }
}

function pipe(stream, name) {
  let buffer = '', fragmented = false;
  const line = (value, complete = true) => {
    append(name, clean(value));
    if (name === 'stdout.log' && eventProtocol && !fragmented) {
      if (complete && value.length <= maxNativeLine) protocolLine(value);
      else if (/^\s*\{\s*"summonEvent"\s*:/.test(value)) {
        const error = 'The native protocol event exceeds the size limit and was not decoded';
        if (/"type"\s*:\s*"request"/.test(value.slice(0, 1024))) unsupportedRequest(error);
        else {
          record({ error, code: 'native_event_unsupported' });
          event('input-error', { error });
        }
      }
    }
    fragmented = !complete;
  };
  const write = chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      line(buffer.slice(0, end + 1));
      buffer = buffer.slice(end + 1);
    }
    if (buffer.length > maxNativeLine) {
      line(buffer.slice(0, -65_536), false);
      buffer = buffer.slice(-65_536);
    }
  };
  if (eventProtocol) {
    stream.setEncoding('utf8');
    stream.on('data', write);
  } else pipeNativeText(stream, write, manifest.encoding?.[name === 'stdout.log' ? 'stdout' : 'stderr']);
  stream.on('end', () => { if (buffer) line(buffer); });
}

function finish(patch) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  clearTimeout(stopTimer);
  clearTimeout(drainTimer);
  const settle = () => {
    guardDb?.close();
    for (const scratch of [promptFile, adapterFile].filter(Boolean)) {
      try { unlinkSync(scratch); }
      catch (error) { if (error.code !== 'ENOENT') event('connector-cleanup-error', { error: clean(error.code) }); }
    }
    event('exit', { status: patch.status, exitCode: patch.exitCode, exitSignal: patch.exitSignal, error: patch.error ?? state.error });
    try { record({ ...patch, stdinOpen: false, finishedAt: now(), pending: [] }); }
    catch (error) {
      process.exitCode = 1;
      event('terminal-state-write-failed', { status: patch.status, code: error.code, syscall: error.syscall, error: clean(error.message) });
    }
  };
  if (pollTask) void pollTask.then(settle);
  else settle();
}

function drainExitedBridge() {
  if (!reportsOutcome || finished || drainTimer || !state.nativeOutcome) return;
  // Once the bridge reports a terminal outcome, give it a brief window to exit
  // cleanly, then terminate its owned process tree and close inherited pipes.
  drainTimer = setTimeout(() => {
    const cleanup = child && !finished ? terminateTree(child).catch(() => {}) : Promise.resolve();
    void cleanup.finally(() => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    });
  }, 2_000);
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
    if (managedAdapter) {
      if (child.exitCode === null && child.signalCode === null) stopTree = terminateTree(child);
    } else if (eventProtocol) {
      void writeInput(JSON.stringify({ summonInput: { type: 'stop', id: command.id } }) + '\n').catch(() => {});
      stopTimer = setTimeout(() => {
        if (!finished && child.exitCode === null && child.signalCode === null) void terminateTree(child);
      }, codex ? 10_000 : 3_000);
    } else if (child.exitCode === null && child.signalCode === null) void terminateTree(child);
    return;
  }
  if (stopping || finished || !state.stdinOpen || !child.stdin.writable || !allowed(command.guard)) {
    receipt({ status: 'not_submitted', error: 'The process input is closed or its authorization changed' }); return;
  }
  if (!nativeText(command.text, 32_768)) {
    receipt({ status: 'not_submitted', error: 'The native input must be text of up to 32768 characters without NUL' }); return;
  }
  if (!credentialFree(command.text)) {
    receipt({ status: 'not_submitted', error: 'Use the configured process credential reference' }); return;
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
  if (eventProtocol) nativeInputs.set(command.id, { path: path + '.native', requestId: command.requestId });
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
  const bindingError = 'The selected executable binding changed before process launch';
  let executableUnchanged;
  try {
    executableUnchanged = (manifest.guard?.executable_bindings ?? []).every(({ file, canonical_file }) =>
      samePath(realpathSync(file), canonical_file) && samePath(realpathSync(canonical_file), canonical_file));
  } catch (error) {
    const code = ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'connection_unavailable' : undefined;
    return finish({ status: 'not_submitted', error: bindingError, code });
  }
  if (!executableUnchanged) return finish({ status: 'not_submitted', error: bindingError, code: 'executable_binding_changed' });
  const environment = nativeEnvironment(manifest.env, manifest.authorizedEnv, { codex });
  secrets = environment.secrets;
  const command = nativeCommand(manifest.file, promptFile ? [...manifest.args, promptFile] : manifest.args);
  record({});
  try {
    child = spawn(command.file, command.args, { ...command.options, cwd: manifest.cwd, env: environment.env,
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return finish({ status: 'not_submitted', error: clean(error.message), code: nativeSpawnFailureCode(error) });
  }
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
  child.once('error', error => finish({ status: state.startedAt ? 'failed' : 'not_submitted', error: clean(error.message),
    ...(!state.startedAt && !stopping ? { code: nativeSpawnFailureCode(error) } : {}) }));
  if (reportsOutcome) child.once('exit', drainExitedBridge);
  child.once('close', async (exitCode, exitSignal) => {
    const terminal = { exitCode, exitSignal };
    if (managedAdapter && stopping && !['completed', 'failed', 'not_submitted', 'unsupported'].includes(state.nativeOutcome)) {
      const verified = await stopTree;
      if (verified) return finish({ ...terminal, status: 'stopped' });
      return finish({ ...terminal, status: 'unknown', stopUnconfirmed: true,
        error: 'The CLI process exited, but termination of its owned process tree was not confirmed' });
    }
    const fallback = codex && (state.nativeTurnId || state.turnSubmitted || state.threadSubmitted) ? 'unknown' : stopping ? 'stopped' :
      managedAdapter ? 'unknown' : !codex && exitCode === 0 ? 'completed' : 'failed';
    finish({ ...terminal, status: state.nativeOutcome || fallback });
  });
}

try { start(); }
catch (error) { finish({ status: child ? 'failed' : 'not_submitted', error: clean(error.message) }); }
