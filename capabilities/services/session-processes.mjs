import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reject } from '../platform/contract.mjs';

export const operationRecords = 'session-operations';
export const inputRecords = 'session-inputs';
export const settled = status => ['completed', 'failed', 'stopped', 'unknown', 'unsupported', 'not_submitted'].includes(status);
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
    if (lines) end = buffer.lastIndexOf(10, bytesRead - 1) + 1;
    else if (offset + bytesRead < size && bytesRead) end = utf8End(buffer, bytesRead);
    return { text: buffer.toString('utf8', 0, end), next_offset: offset + end, more: offset + end < size };
  } finally { await file.close(); }
}

export function operationDirectory(dataRoot, operation) {
  if (!/^[0-9a-f-]{36}$/i.test(operation.instance_id || '')) throw new Error('Invalid persisted process instance id');
  return join(dataRoot, 'capabilities', 'native-executions', operation.instance_id);
}

export class SessionProcesses {
  constructor({ store, dataRoot, clean }) { Object.assign(this, { store, dataRoot, clean }); }
  directory(operation) { return operationDirectory(this.dataRoot, operation); }
  save(operation, patch) { return this.store.save(operationRecords, { id: operation.id, ...patch }); }

  async launch(operation, launch, beforeSubmit) {
    const directory = this.directory(operation);
    try {
      await mkdir(join(directory, 'inputs'), { recursive: true, mode: 0o700 });
      await atomic(join(directory, 'launch.json'), { ...launch, nonce: operation.instance_id });
      await beforeSubmit();
    } catch (error) {
      return this.save(operation, { status: 'not_submitted', runtime_ended: true,
        finished_at: new Date().toISOString(), error: this.clean(error.message) });
    }
    // After this boundary a restart can only inspect the original instance.
    this.save(operation, { status: 'starting', submitted_at: new Date().toISOString() });
    try {
      const child = spawn(process.execPath, [worker, directory], {
        detached: true, windowsHide: true, stdio: 'ignore', env: process.env,
      });
      await new Promise((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
      child.unref();
      return this.save(operation, { runner_pid: child.pid });
    } catch (error) {
      return this.save(operation, { status: 'not_submitted', runtime_ended: true,
        finished_at: new Date().toISOString(), error: this.clean(error.message) });
    }
  }

  async refresh(operation) {
    if (settled(operation.status) && operation.status !== 'unknown') return operation;
    if (operation.status === 'prepared') return operation;
    const state = await optionalJson(join(this.directory(operation), 'state.json'));
    if (state?.nonce === operation.instance_id && (!operation.runner_pid || state.runnerPid === operation.runner_pid)) {
      const stale = !settled(state.status) && Date.now() - Date.parse(state.observedAt) > 15_000;
      const status = stale ? 'unknown' : state.status;
      if (operation.recovered_at && status === 'unknown') return operation;
      if (operation.status === status && operation.observed_at === state.observedAt && operation.finished_at === (state.finishedAt ?? null) &&
          operation.stdin_open === (state.stdinOpen === true) && operation.turn_id === (state.nativeTurnId ?? operation.turn_id) &&
          (operation.protocol !== 'codex' || operation.thread_id === (state.nativeSessionId || operation.thread_id)) &&
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
        runtime_ended: Boolean(state.finishedAt), error: stale ? 'The process heartbeat expired before a terminal result' : state.error });
    }
    if (Date.now() - Date.parse(operation.submitted_at) > 15_000 && operation.status !== 'unknown')
      return this.save(operation, { status: 'unknown', runtime_ended: false, error: 'The original process did not provide a launch receipt' });
    return operation;
  }

  async output(operation, { stream = 'stdout', offset = 0, limit = 16_384 } = {}) {
    if (!['stdout', 'stderr', 'events'].includes(stream) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1024 || limit > 65_536) reject('invalid_cursor', 'Invalid process output page');
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
    const native = (operation.protocol === 'codex' || operation.protocol === 'summon-jsonl') && await optionalJson(path + '.native');
    let next = native || receipt || record.receipt;
    if (native) next = { ...native, layer: operation.protocol };
    else if (receipt?.status === 'delivered' && (operation.protocol === 'codex' || operation.protocol === 'summon-jsonl' && record.kind === 'reply')) {
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
    if (JSON.stringify(next) === JSON.stringify(record.receipt)) return record;
    return this.store.save(inputRecords, { id: record.id, receipt: next });
  }
}

// The detached runner must recheck control and connection access at the moment it
// dequeues input. A closed or unavailable host store cannot authorize a write.
export function guardStillMatches(db, guard) {
  if (!guard || !db) return false;
  const get = (kind, id) => {
    const row = db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id);
    return row && JSON.parse(row.data);
  };
  const connection = get('platform-connections', guard.connection_id);
  const session = get('platform-sessions', guard.session_id);
  if (!connection?.enabled || (connection.binding_version ?? 1) !== guard.binding_version || !session ||
      (connection.workspaceProfileId ?? null) !== (session.workspaceProfileId ?? null) || session.authority_revoked ||
      session.control?.state !== 'active' || session.control.control_version !== guard.control_version) return false;
  if (guard.origin_conversation_id) {
    const origin = get('platform-conversations', guard.origin_conversation_id);
    if (origin?.control?.state !== 'active' || origin.control.control_version !== guard.origin_control_version) return false;
  }
  const workspace = guard.workspace_id && get('platform-workspaces', guard.workspace_id);
  if (workspace && (workspace.path !== session.workspace?.root ||
      (workspace.workspaceProfileId ?? null) !== (session.workspaceProfileId ?? null) ||
      session.workspace?.write && workspace.write === false)) return false;
  for (const control of guard.controls || []) {
    const kinds = { session: 'platform-sessions', conversation: 'platform-conversations', bot: 'platform-bots' };
    const selected = kinds[control.target?.kind] && get(kinds[control.target.kind], control.target.id);
    if (selected?.control?.state !== 'active' || selected.control.control_version !== control.control_version) return false;
  }
  for (const actor of guard.actors || []) {
    if (actor.kind === 'user') continue;
    const bot = get('platform-bots', actor.id);
    if (!bot || (bot.workspaceProfileId ?? null) !== (session.workspaceProfileId ?? null) ||
        !connection.allowed_bot_ids?.includes('*') && !connection.allowed_bot_ids?.includes(actor.id)) return false;
    if (guard.workspace_id && !get('platform-access', actor.id)?.workspace_ids?.includes(guard.workspace_id)) return false;
  }
  if (guard.room_owner && !get('rooms', guard.room_id)?.members?.includes(guard.room_owner)) return false;
  if (guard.submitting_id && guard.submitting_id !== guard.room_owner) {
    const grants = session.sharing?.submitters || [];
    if (!grants.some(principal => principal.kind === 'bot' && principal.id === guard.submitting_id ||
        principal.kind === 'room_members' && principal.id === guard.room_id && get('rooms', guard.room_id)?.members?.includes(guard.submitting_id))) return false;
  }
  return true;
}

export function makeProcessGuard(session, connection, call) {
  const shared = session.space?.kind === 'room' && session.sharing;
  const actors = [session.execution_actor, call.submitted_by].filter(Boolean);
  return { session_id: session.id, connection_id: connection.id, binding_version: connection.binding_version ?? 1,
    control_version: session.control.control_version, actors, controls: call.controls, workspace_id: session.workspace_ref?.id,
    ...(call.origin?.conversation_id && Number.isInteger(call.origin.control_version) ?
      { origin_conversation_id: call.origin.conversation_id, origin_control_version: call.origin.control_version } : {}),
    ...(shared ? { room_id: session.space.id, room_owner: session.owner.id,
      submitting_id: call.submitted_by.kind === 'bot' ? call.submitted_by.id : undefined } : {}) };
}
