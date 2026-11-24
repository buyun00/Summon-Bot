import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reject } from '../platform/contract.mjs';
import { workspaceGranted } from '../platform/workspace-access.mjs';
import { isProcessAlive, terminatePidTree } from '../../bot/src/runtime/process-tools.mjs';
import { connectionAuthorized, connectionRecords } from './connection-records.mjs';
import { nativeSpawnFailureCode } from './native-host.mjs';

export const operationRecords = 'session-operations';
export const inputRecords = 'session-inputs';
export const heartbeatExpiryMs = 15_000;
export const settled = status => ['completed', 'failed', 'stopped', 'unknown', 'unsupported', 'not_submitted'].includes(status);
export const connectionStartupFailures = Object.freeze(['connection_unavailable', 'executable_binding_changed', 'connection_binding_changed', 'native_spawn_failed']);
const worker = fileURLToPath(new URL('./native-process.mjs', import.meta.url));

export async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

async function atomic(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
    await rename(temp, path);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

function utf8End(buffer, bytesRead) {
  let start = bytesRead - 1;
  while (start > 0 && (buffer[start] & 192) === 128) start--;
  const leading = buffer[start], expected = leading >= 240 ? 4 : leading >= 224 ? 3 : leading >= 192 ? 2 : 1;
  return bytesRead - start < expected ? start : bytesRead;
}

export async function processPage(path, offset, limit, lines = false) {
  const file = await open(path, 'r').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) return { text: '', next_offset: offset, more: false };
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(limit, Math.max(size - offset, 0)));
    if (!buffer.length) return { text: '', next_offset: offset, more: false };
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    let end = bytesRead;
    const newline = lines && bytesRead ? buffer.lastIndexOf(10, bytesRead - 1) + 1 : 0;
    if (newline) end = newline;
    else if (offset + bytesRead < size && bytesRead) end = utf8End(buffer, bytesRead);
    return { text: buffer.toString('utf8', 0, end), next_offset: offset + end, more: offset + end < size };
  } finally { await file.close(); }
}

export function operationDirectory(dataRoot, operation) {
  if (!/^[0-9a-f-]{36}$/i.test(operation.instance_id || '')) throw new Error('Invalid persisted process instance id');
  return join(dataRoot, 'capabilities', 'native-executions', operation.instance_id);
}

export class SessionProcesses {
  constructor({ store, dataRoot, clean }) {
    Object.assign(this, { store, dataRoot, clean });
  }
  directory(operation) { return operationDirectory(this.dataRoot, operation); }
  save(operation, patch) { return this.store.save(operationRecords, { id: operation.id, ...patch }); }

  isAlive(operation) {
    return isProcessAlive(operation?.runner_pid) || isProcessAlive(operation?.child_pid);
  }

  async forceKill(operation) {
    const results = [];
    if (operation?.child_pid) results.push(await terminatePidTree(operation.child_pid));
    if (operation?.runner_pid) results.push(await terminatePidTree(operation.runner_pid));
    return !this.isAlive(operation) || results.some(Boolean);
  }

  async partialSnapshot(operation) {
    if (!operation?.instance_id) return null;
    try {
      const directory = this.directory(operation);
      const touched = new Set();
      let lastProgress = null;
      const eventsPage = await processPage(join(directory, 'events.jsonl'), 0, 65_536, true);
      for (const line of eventsPage.text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'progress' && ev.text) lastProgress = ev.text.slice(0, 600);
          if (Array.isArray(ev.files)) for (const f of ev.files) if (typeof f === 'string') touched.add(f);
        } catch {}
      }
      const stdoutPage = await processPage(join(directory, 'stdout.log'), 0, 65_536);
      const stderrPage = await processPage(join(directory, 'stderr.log'), 0, 16_384);
      const tailSource = (stdoutPage.text || stderrPage.text || '').trim();
      const tailOutput = tailSource ? tailSource.slice(-1200) : null;
      const files = [...touched].slice(0, 40);
      if (!lastProgress && !files.length && !tailOutput) return null;
      return {
        ...(lastProgress ? { last_progress: this.clean(lastProgress) } : {}),
        ...(files.length ? { touched_files: files } : {}),
        ...(tailOutput ? { tail_output: this.clean(tailOutput) } : {}),
      };
    } catch { return null; }
  }

  async launch(operation, launch, beforeSubmit) {
    const directory = this.directory(operation);
    const { adapterSource, method, ...manifest } = launch;
    const script = adapterSource !== undefined ? join(directory, 'adapter.mjs') : null;
    try {
      await mkdir(join(directory, 'inputs'), { recursive: true, mode: 0o700 });
      if (script) await writeFile(script, adapterSource, { mode: 0o600, flag: 'wx' });
      await atomic(join(directory, 'launch.json'), { ...manifest, ...(script ? { args: [script], cleanupAdapter: true } : {}), nonce: operation.instance_id });
      await beforeSubmit();
    } catch (error) {
      if (script) await unlink(script).catch(() => {});
      return this.save(operation, { status: 'not_submitted', runtime_ended: true,
        finished_at: new Date().toISOString(), error: this.clean(error.message),
        code: connectionStartupFailures.includes(error.code) ? error.code : undefined });
    }
    // After this boundary a restart can only inspect the original instance.
    this.save(operation, { status: 'starting', submitted_at: new Date().toISOString() });
    let child;
    try {
      child = spawn(process.execPath, [worker, directory], {
        detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
      });
      await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
    } catch (error) {
      if (script) await unlink(script).catch(() => {});
      return this.save(operation, { status: 'not_submitted', runtime_ended: true,
        finished_at: new Date().toISOString(), error: this.clean(error.message), code: nativeSpawnFailureCode(error) });
    }
    child.unref();
    return this.save(operation, { runner_pid: child.pid });
  }

  async refresh(operation) {
    if (settled(operation.status) && operation.status !== 'unknown') return operation;
    if (operation.status === 'prepared') return operation;
    const directory = this.directory(operation);
    const heartbeat = await optionalJson(join(directory, 'state.json'));
    const matches = state => state?.nonce === operation.instance_id && (!operation.runner_pid || state.runnerPid === operation.runner_pid);
    const final = process.platform === 'win32' && !heartbeat?.finishedAt ? await optionalJson(join(directory, 'finished.json')) : null;
    const state = final?.finishedAt && settled(final.status) && matches(final) && (!operation.child_pid || final.pid === operation.child_pid)
      ? final : heartbeat;
    const deadTerminalStatus = (op, st) => (op.detached_at || op.stop_requested_at || st?.status === 'stopping' ? 'stopped' : 'failed');
    if (matches(state)) {
      const stale = !settled(state.status) && Date.now() - Date.parse(state.observedAt) > heartbeatExpiryMs;
      const status = stale ? 'unknown' : state.status;
      if (status === 'unknown' && operation.recovered_at) return operation;
      if (stale) {
        const alive = isProcessAlive(state.runnerPid ?? operation.runner_pid) || isProcessAlive(state.pid ?? operation.child_pid);
        if (!alive) {
          const now = new Date().toISOString();
          return this.save(operation, {
            status: deadTerminalStatus(operation, state), runtime_ended: true,
            runtime_exit_observed_at: operation.runtime_exit_observed_at ?? now,
            finished_at: operation.finished_at ?? now, pending: [], stdin_open: false,
            exit_code: null,
            code: 'crashed_or_exited_unknown',
            error: 'The external process exited without returning a terminal receipt',
          });
        }
        if (operation.runtime_exit_observed_at) return operation;
      }
      if (operation.status === status && operation.observed_at === state.observedAt && operation.finished_at === (state.finishedAt ?? null) &&
          operation.stdin_open === (state.stdinOpen === true) && operation.turn_id === (state.nativeTurnId ?? operation.turn_id) &&
          (operation.protocol === 'codex' ? operation.thread_id === (state.nativeSessionId || operation.thread_id) :
            operation.original_native_id === (state.nativeSessionId || operation.original_native_id)) &&
          operation.binding_rejected === (state.bindingRejected === true)) return operation;
      return this.save(operation, { status, observed_at: state.observedAt, finished_at: state.finishedAt ?? null,
        runner_pid: state.runnerPid, child_pid: state.pid, exit_code: state.exitCode, exit_signal: state.exitSignal,
        pending: stale ? [] : state.pending, stdin_open: state.stdinOpen === true,
        ...(operation.protocol === 'codex' ? { thread_id: state.nativeSessionId || operation.thread_id, turn_id: state.nativeTurnId ?? operation.turn_id } :
          { original_native_id: state.nativeSessionId || operation.original_native_id }),
        native_bound: Boolean(state.nativeSessionId) || operation.native_bound, binding: state.binding || operation.binding,
        binding_rejected: state.bindingRejected === true, thread_attempted: state.threadSubmitted === true, thread_active: state.threadActive === true,
        turn_attempted: state.turnSubmitted === true, result: state.final, reroute: state.reroute,
        stop_verified: Boolean(state.finishedAt && status === 'stopped'),
        runtime_ended: Boolean(state.finishedAt && !state.stopUnconfirmed), runtime_exit_observed_at: null,
        error: stale ? 'The process heartbeat expired before a terminal result' : state.error,
        code: stale ? null : state.code });
    }
    if (Date.now() - Date.parse(operation.submitted_at) > 15_000 && operation.status !== 'unknown') {
      const alive = this.isAlive(operation);
      const now = new Date().toISOString();
      return this.save(operation, { status: alive ? 'unknown' : deadTerminalStatus(operation, null), runtime_ended: !alive,
        ...(alive ? {} : { runtime_exit_observed_at: now, finished_at: operation.finished_at ?? now, exit_code: null, code: 'crashed_or_exited_unknown' }),
        error: alive ? 'The original process did not provide a launch receipt' : 'The original process exited without providing a launch receipt' });
    }
    if (operation.status === 'unknown' && !this.isAlive(operation)) {
      const now = new Date().toISOString();
      return this.save(operation, { status: deadTerminalStatus(operation, null), runtime_ended: true,
        runtime_exit_observed_at: operation.runtime_exit_observed_at ?? now,
        finished_at: operation.finished_at ?? now, pending: [], stdin_open: false, exit_code: null,
        code: operation.code || 'crashed_or_exited_unknown',
        error: operation.error || 'The external process exited without returning a terminal receipt' });
    }
    return operation;
  }

  async output(operation, { stream = 'stdout', offset = 0, limit = 65_536 } = {}) {
    if (!['stdout', 'stderr', 'events'].includes(stream) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1024 || limit > 262_144) reject('invalid_cursor', 'Invalid process output page');
    const path = join(this.directory(operation), stream === 'events' ? 'events.jsonl' : stream + '.log');
    return processPage(path, offset, limit, stream === 'events');
  }

  async command(operation, call, kind, target, text, beforeSubmit, guard) {
    const prior = this.store.get(inputRecords, call.id);
    if (prior) return this.inputReceipt(operation, prior);
    const requestId = target?.request_id;
    if (requestId && this.store.list(inputRecords).some(record => record.operation_id === operation.id && record.target?.request_id === requestId &&
        !['not_submitted', 'rejected'].includes(record.receipt?.status))) reject('request_already_answered', 'The native request already has an answer receipt', 409);
    const record = this.store.save(inputRecords, { id: call.id, operation_id: operation.id,
      kind, target, submitted_by: call.submitted_by, guard, status: 'prepared',
      file: String(Date.now()).padStart(15, '0') + '-' + randomUUID() + '.json' });
    const dir = join(this.directory(operation), 'inputs');
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await beforeSubmit();
    } catch (error) {
      return this.store.save(inputRecords, { id: record.id, status: 'not_submitted',
        receipt: { status: 'not_submitted', error: this.clean(error.message) } });
    }
    this.store.save(inputRecords, { id: record.id, status: 'writing' });
    await atomic(join(dir, record.file), { id: call.id, nonce: operation.instance_id,
      type: kind === 'stop' ? 'stop' : 'input', kind, requestId, expectedTurnId: target?.turn_id, guard, text });
    return this.store.save(inputRecords, { id: record.id, status: 'submitted' });
  }

  async inputReceipt(operation, record) {
    if (record.migrated || record.receipt?.status === 'not_submitted') return record;
    const path = join(this.directory(operation), 'inputs', record.file + '.receipt');
    const receipt = await optionalJson(path);
    const nativeFile = (operation.protocol === 'codex' || operation.protocol === 'summon-jsonl') && (await optionalJson(path + '.native') ??
      (operation.protocol === 'summon-jsonl' && record.kind === 'reply' ? await optionalJson(path + '.native.resolved') : null));
    const native = nativeFile?.inputId === record.id ? nativeFile : null;
    let next = native || receipt || record.receipt;
    let native_acknowledged = record.native_acknowledged === true;
    if (native) {
      const { explicitAck, ...result } = native;
      native_acknowledged = operation.protocol === 'summon-jsonl' && native.status === 'accepted' && explicitAck === true;
      next = { ...result, layer: operation.protocol };
    } else if (receipt?.status === 'delivered' && (operation.protocol === 'codex' || operation.protocol === 'summon-jsonl' && record.kind === 'reply')) {
      next = { ...receipt, status: settled(operation.status) ? 'unknown' : 'sent-to-bridge', layer: 'stdin' };
    } else if (receipt?.status === 'submitting' && settled(operation.status)) {
      next = { ...receipt, status: 'unknown', layer: 'stdin' };
    } else if (!receipt && !next) {
      const original = await optionalJson(path.slice(0, -8));
      if (!original) {
        if (['prepared', 'writing'].includes(record.status) || settled(operation.status)) {
          next = { status: 'not_submitted', error: 'The original command was never written to the process queue' };
        }
      } else if (settled(operation.status)) next = { status: operation.runtime_ended ? 'not_submitted' : 'unknown' };
    }
    if (record.kind === 'stop') {
      if (operation.runtime_ended && operation.status !== 'unknown') next = { status: 'completed', execution_status: operation.status };
      else if (operation.status === 'unknown' && next?.status !== 'not_submitted') next = { status: 'unknown' };
    }
    if (JSON.stringify(next) === JSON.stringify(record.receipt) && native_acknowledged === (record.native_acknowledged === true)) return record;
    return this.store.save(inputRecords, { id: record.id, receipt: next, native_acknowledged });
  }
}

// The detached runner checks whether the connection or session was explicitly
// disabled, stopped, or revoked before dequeuing input.
export function guardStillMatches(db, guard) {
  if (!guard || !db) return false;
  const get = (kind, id) => {
    const row = db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    return row && JSON.parse(row.data);
  };
  const connection = get(connectionRecords, guard.connection_id);
  const session = get('platform-sessions', guard.session_id);
  if (!connection?.enabled || !session || session.authority_revoked || session.control?.state !== 'active') return false;
  for (const control of guard.controls || []) {
    const kinds = { session: 'platform-sessions', conversation: 'platform-conversations', bot: 'platform-bots' };
    const selected = kinds[control.target?.kind] && get(kinds[control.target.kind], control.target.id);
    if (selected && selected.control?.state !== 'active') return false;
  }
  return true;
}

export function makeProcessGuard(session, connection, call) {
  const shared = session.space?.kind === 'room' && session.sharing;
  const actors = [session.execution_actor, call.submitted_by,
    ...(session.room_workspace_id || connection.config.adapter?.runner ? [call.initiating_principal] : [])].filter(Boolean);
  return { session_id: session.id, connection_id: connection.id, binding_version: connection.binding_version ?? 1,
    control_version: session.control.control_version, actors, controls: call.controls, workspace_id: session.workspace_ref?.id,
    ...(call.origin?.conversation_id && Number.isInteger(call.origin.control_version) ?
      { origin_conversation_id: call.origin.conversation_id, origin_control_version: call.origin.control_version } : {}),
    ...(shared ? { room_id: session.space.id, room_owner: session.owner.id,
      submitting_id: call.submitted_by.kind === 'bot' ? call.submitted_by.id : undefined } : {}) };
}
