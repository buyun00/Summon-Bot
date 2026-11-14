import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { reject } from '../platform/contract.mjs';
import { inputRecords, operationDirectory, operationRecords, optionalJson } from './session-processes.mjs';

export const connectionRecords = 'platform-connections';
export const executionRecords = 'platform-sessions';
export const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const kinds = ['cli', 'codex', 'http', 'mcp'];
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function connectionAllowed(entry, actor) {
  return Boolean(entry && actor && (actor.kind === 'user' || entry.allowed_bot_ids?.includes('*') || entry.allowed_bot_ids?.includes(actor.id)));
}

export function convertConnectionEntry(entry, hostId) {
  if (!['cli', 'http', 'mcp'].includes(entry.kind)) return null;
  if (entry.kind === 'cli' && entry.native?.hostId && entry.native.hostId !== hostId) return null;
  const current = (entry.native?.methods || []).filter(method => method.resourceRevision === entry.native.resourceRevision);
  const codex = entry.kind === 'cli' && current.some(method => method.adapter === 'codex-app-server');
  const methods = current.filter(method => !method.adapter && !method.role).map(method => {
    const { id, name, description, args, fileArgs, input, keepInput, protocol, env, tool, arguments: parameters, script } = method;
    return { id, name, description, args, file_args: fileArgs, input, keep_input: keepInput === true,
      protocol, env, method: tool, parameters, effect: method.effect, ...(script ? { script } : {}) };
  });
  const config = entry.kind === 'cli' ? { file: entry.config.file, canonical_file: entry.config.canonicalFile,
    credential_refs: entry.native?.credentialRefs || [], methods } : { ...entry.config, methods };
  if (entry.kind === 'http') delete config.taskContext;
  return { id: entry.id, kind: codex ? 'codex' : entry.kind, name: entry.name, description: entry.description,
    revision: entry.revision ?? 1, binding_version: 1, config, enabled: entry.enabled === true,
    allowed_bot_ids: [...new Set(entry.allowedBotIds || [])], direct_bot_ids: entry.ownerBotId && entry.ownerBotId !== 'controller' ? [entry.ownerBotId] : [],
    dependencies: [...(entry.dependencies || [])],
    availability: entry.native?.status, version: entry.native?.version, host_id: entry.native?.hostId };
}

export function validateConnection(entry) {
  if (!kinds.includes(entry.kind) || !plain(entry.config)) reject('invalid_connection', 'Invalid connection kind or configuration');
  if (!Array.isArray(entry.allowed_bot_ids) || entry.allowed_bot_ids.some(id => typeof id !== 'string' || !id)) {
    reject('invalid_connection', 'Specify the granted Bot identities');
  }
  if (typeof entry.enabled !== 'boolean') reject('invalid_connection', 'Connection enabled must be a boolean');
  if (entry.dependencies && (!Array.isArray(entry.dependencies) || entry.dependencies.some(id => typeof id !== 'string' || !id))) {
    reject('invalid_connection', 'Invalid connection dependencies');
  }
  if (entry.kind === 'cli' || entry.kind === 'codex') {
    const { credential_refs, methods, allow_arguments, workspace_write, model, effort } = entry.config;
    if (credential_refs !== undefined && (!Array.isArray(credential_refs) ||
        credential_refs.some(name => typeof name !== 'string' || !envName.test(name)))) reject('invalid_connection', 'Invalid native credential references');
    if (allow_arguments !== undefined && typeof allow_arguments !== 'boolean' || workspace_write !== undefined && typeof workspace_write !== 'boolean')
      reject('invalid_connection', 'Invalid native workspace or argument access');
    if (methods !== undefined && (!Array.isArray(methods) || methods.some(method => !plain(method) ||
        typeof method.id !== 'string' || !method.id || !Array.isArray(method.args) ||
        method.args.some(arg => typeof arg !== 'string') || method.env !== undefined && !plain(method.env))))
      reject('invalid_connection', 'Native methods need an identity and argument template');
    if (entry.kind === 'codex' && (model !== undefined && (typeof model !== 'string' || !model.trim()) ||
        effort !== undefined && (typeof effort !== 'string' || !effort.trim() || !model)))
      reject('invalid_connection', 'Codex defaults require an explicit model and reasoning effort');
  }
}

const id = value => typeof value === 'string' && value.length > 0 ? value : undefined;

export async function readLegacyOperationFacts(dataRoot, row) {
  const directory = operationDirectory(dataRoot, { instance_id: row.nonce });
  const state = await optionalJson(join(directory, 'state.json'));
  const source = state?.nonce === row.nonce && (!row.runnerPid || row.runnerPid === state.runnerPid) ? state : {};
  let thread = id(source.nativeSessionId) || id(row.nativeSessionId);
  let turn = id(source.nativeTurnId) || id(row.nativeTurnId);
  let model = id(source.binding?.model) || id(source.model) || id(row.model);
  let effort = id(source.binding?.effort) || id(source.effort) || id(row.effort);
  if (row.engine && (!thread || !turn || !model || !effort)) {
    const stream = createReadStream(join(directory, 'events.jsonl'), { encoding: 'utf8' });
    try {
      for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!['session', 'turn'].includes(event.type) || !id(event.nativeSessionId) || thread && event.nativeSessionId !== thread) continue;
        thread ||= event.nativeSessionId;
        turn ||= id(event.nativeTurnId);
        model ||= id(event.binding?.model) || id(event.model);
        effort ||= id(event.binding?.effort) || id(event.effort);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { thread_id: thread, turn_id: turn, binding: model ? { model, effort } : undefined,
    finished_at: source.finishedAt || row.finishedAt, stdin_open: source.stdinOpen === true,
    turn_attempted: source.turnSubmitted === true, observed_at: source.observedAt || row.observedAt };
}

export async function readLegacyInputFacts(dataRoot, row, operation, operationFacts = {}) {
  if (typeof row.file !== 'string' || !/^\d+-[a-f0-9-]+\.json$/i.test(row.file))
    return { status: 'unknown', receipt: { status: 'unknown', error: 'The original command file identity is unavailable' } };
  const directory = operationDirectory(dataRoot, { instance_id: operation.nonce });
  const path = join(directory, 'inputs', row.file);
  const [receipt, native, command] = await Promise.all([
    optionalJson(path + '.receipt'), optionalJson(path + '.receipt.native'), optionalJson(path),
  ]);
  if (native?.inputId === row.inputId || native?.id === row.inputId)
    return { status: native.status, receipt: { ...native, layer: 'codex' } };
  if (receipt?.id === row.inputId) {
    if (receipt.status === 'rejected') return { status: 'not_submitted', receipt: { ...receipt, status: 'not_submitted' } };
    if (receipt.status === 'delivered' && !operation.engine && !row.requestId)
      return { status: 'delivered', receipt: { ...receipt, layer: 'stdin' } };
    return { status: 'unknown', receipt: { ...receipt, status: 'unknown', transport_status: receipt.status, layer: 'stdin' } };
  }
  if ((!command && row.status === 'recorded') ||
      (command?.id === row.inputId && command.nonce === operation.nonce && operationFacts.finished_at)) {
    return { status: 'not_submitted', receipt: { status: 'not_submitted' } };
  }
  return { status: 'unknown', receipt: { status: 'unknown', error: 'No matching original input receipt is available' } };
}

export function importNativeOperation(store, row, { sessionId, callId = row.operationId, inputRevision = 1, facts = {} } = {}) {
  if (!sessionId || !callId || !row.nonce || !row.resourceId) throw new Error('Native operation migration requires its existing call and Session mapping');
  const protocol = row.engine ? 'codex' : row.launch?.protocol || 'stdin';
  const status = row.status === 'queued' || row.status === 'superseded' ? 'not_submitted' : row.status;
  const threadId = facts.thread_id ?? row.nativeSessionId;
  const turnId = facts.turn_id ?? row.nativeTurnId;
  const finishedAt = facts.finished_at ?? row.finishedAt;
  return store.import(operationRecords, { id: callId, session_id: sessionId, connection_id: row.resourceId,
    protocol, instance_id: row.nonce, launch_call_id: callId, original_operation_id: row.operationId,
    native_bound: Boolean(threadId), thread_id: row.engine ? threadId : null, turn_id: row.engine ? turnId : null,
    original_native_id: !row.engine ? threadId : undefined,
    binding: facts.binding ?? (row.model ? { model: row.model, effort: row.effort } : undefined),
    cwd: row.cwd, submitted_by: { kind: 'bot', id: row.actor }, input_revision: inputRevision,
    status, submitted_at: row.launchedAt, observed_at: facts.observed_at ?? row.observedAt, finished_at: finishedAt,
    runtime_ended: Boolean(finishedAt), stop_verified: row.status === 'stopped' && Boolean(finishedAt),
    runner_pid: row.runnerPid, child_pid: row.pid, offset: row.eventOffset || 0,
    stdin_open: facts.stdin_open ?? false, turn_attempted: facts.turn_attempted, pending: row.pending,
    result: row.final, error: row.error, createdAt: row.createdAt, updatedAt: row.updatedAt, migrated: true });
}

export function importNativeInput(store, row, { operationId, callId = row.inputId, facts = {} }) {
  const operation = store.get(operationRecords, operationId);
  const target = operation?.protocol === 'codex'
    ? operation.turn_id ? { kind: 'codex_turn', turn_id: operation.turn_id } : undefined
    : operation?.instance_id ? { kind: 'cli_process', instance_id: operation.instance_id, launch_call_id: operation.launch_call_id } : undefined;
  return store.import(inputRecords, { id: callId, operation_id: operationId,
    kind: row.type === 'stop' ? 'stop' : row.requestId ? 'reply' : 'steer',
    target: target && row.requestId ? { ...target, request_id: row.requestId } : target,
    original_request_id: row.requestId || null, file: row.file,
    status: facts.status ?? 'unknown', receipt: facts.receipt ?? { status: 'unknown' }, suppressed: true, migrated: true,
    createdAt: row.createdAt, updatedAt: row.updatedAt });
}

export function importNetworkOperation(store, row, { sessionId, callId = row.operationId } = {}) {
  if (!sessionId || !callId) throw new Error('Network operation migration requires its existing call and Session mapping');
  return store.import(operationRecords, { id: callId, session_id: sessionId, connection_id: row.entryId, protocol: 'service',
    launch_call_id: callId, original_operation_id: row.operationId,
    submitted_by: { kind: 'bot', id: row.actor }, status: row.status === 'running' ? 'unknown' : row.status,
    submitted_at: row.startedAt, finished_at: row.finishedAt, runtime_ended: Boolean(row.finishedAt),
    result: row.result, error: row.error, method: row.tool, input_revision: 1,
    createdAt: row.createdAt, updatedAt: row.updatedAt, surfaced: true, migrated: true });
}
