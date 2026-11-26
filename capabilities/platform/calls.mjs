import { randomUUID } from 'node:crypto';
import { modelError } from '../../bot/src/agent/connections.mjs';
import { keyOf, reject, sameIdentity, sameRef } from './contract.mjs';

export const callRecords = 'platform-calls';
export const waitRecords = 'platform-waits';
const settledOutcomes = new Set(['completed', 'failed', 'stopped', 'unsupported', 'cancelled', 'not_submitted']);
const receiptOutcomes = new Set([...settledOutcomes, 'unknown']);

export function mayAdvanceReceipt(call, status) {
  return !settledOutcomes.has(call.status) || settledOutcomes.has(status);
}

export function isWaitOrigin(wait, origin) {
  return Boolean(wait && origin && wait.conversation_id === origin.conversation_id && wait.run_id === origin.run_id);
}

const sensitiveKeyPattern = /token|api[_-]?key|authorization|password|passwd|secret|cookie|credential|private[_-]?key|^(?:key|access|refresh)$/i;
const tokenMetricKeyPattern = /(?:^(?:input|output|total|prompt|completion|cached|cache[_-]?(?:hit|miss|known[_-]?input)?|reasoning|max|min|avg|reserve|context|remaining|used|billed)[_-]?tokens?$|token[_-]?(?:count|limit|budget|usage|window|rate|price|cost)$)/i;

function sanitizeDetails(value, depth = 0, key = '') {
  if (value === null || value === undefined) return value;
  if (depth > 32) return '[truncated]';
  if (key && sensitiveKeyPattern.test(key) && !tokenMetricKeyPattern.test(key) && (typeof value === 'string' || typeof value === 'number')) return '[redacted]';
  if (typeof value === 'string') return modelError(value);
  if (Array.isArray(value)) return value.map(item => sanitizeDetails(item, depth + 1, key));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDetails(v, depth + 1, k);
    return out;
  }
  return value;
}

export function errorResult(error) {
  const message = modelError(error?.message || error || 'The operation failed in the host');
  if (error?.status && error?.code) return { code: error.code, error: message, status: error.status, details: sanitizeDetails(error.details) };
  if (error?.status && error.status < 500) return { code: error.code || 'request_rejected', error: message, status: error.status };
  return { code: error?.code || error?.name || 'operation_failed', error: message, status: error?.status || 500 };
}

export class Calls {
  constructor({ store, deliver, canReadTarget, spaceFor, sessionMeta, inSharedRoom, resolveTargetOwner }) {
    Object.assign(this, { store, deliver, canReadTarget, spaceFor, sessionMeta, inSharedRoom, resolveTargetOwner });
    this.linkedWaits = store.db.prepare(`SELECT data FROM records WHERE kind='platform-waits'
      AND json_extract(data,'$.run_id')=? AND json_extract(data,'$.input_call_id') IS NOT NULL`);
  }

  activeWaitGraph() {
    const edges = new Map();
    const link = (from, to) => {
      if (!from || !to || from === to) return;
      if (!edges.has(from)) edges.set(from, new Set());
      edges.get(from).add(to);
    };
    for (const wait of this.store.list(waitRecords)) {
      if (!['waiting', 'pending_delivery', 'received'].includes(wait.status) || !wait.target) continue;
      const fromExec = wait.session_id ? keyOf('session', wait.session_id) : keyOf('conversation', wait.conversation_id);
      const fromBot = wait.bot_id ? keyOf('bot', wait.bot_id) : null;
      const toExec = keyOf(wait.target.kind, wait.target.id);
      const targetOwner = this.resolveTargetOwner?.(wait.target);
      const toBot = targetOwner ? keyOf('bot', targetOwner) : null;
      link(fromExec, toExec);
      if (toBot && toBot !== fromBot) link(fromExec, toBot);
      if (fromBot && toBot && fromBot !== toBot) link(fromBot, toBot);
    }
    return edges;
  }

  assertNoWaitCycle(origin, target, callId) {
    if (!origin || !target) return;
    const fromExec = origin.session_id ? keyOf('session', origin.session_id) : keyOf('conversation', origin.conversation_id);
    const fromBot = origin.bot_id ? keyOf('bot', origin.bot_id) : null;
    const toExec = keyOf(target.kind, target.id);
    const targetOwner = this.resolveTargetOwner?.(target);
    const toBot = targetOwner ? keyOf('bot', targetOwner) : null;
    if (fromExec === toExec) {
      reject('wait_cycle_detected', 'An execution cannot wait on itself', 409, { from: fromExec, to: toExec, call_id: callId });
    }
    const graph = this.activeWaitGraph();
    const starts = [toExec, ...(toBot && toBot !== fromBot ? [toBot] : [])];
    const goals = new Set([fromExec, ...(fromBot && toBot && fromBot !== toBot ? [fromBot] : [])]);
    const visited = new Set();
    const stack = [...starts];
    while (stack.length) {
      const node = stack.pop();
      if (goals.has(node)) {
        reject('wait_cycle_detected', 'Mutual wait cycle detected; return missing information to the caller instead of waiting back', 409, {
          from: fromExec,
          to: toExec,
          cycle_node: node,
          call_id: callId,
        });
      }
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of graph.get(node) || []) stack.push(next);
    }
  }

  clientCall(actor, clientId) {
    const id = this.store.get('platform-client-calls', keyOf(actor.kind, actor.id, clientId))?.call_id;
    return id && this.store.get(callRecords, id);
  }

  begin(name, context) {
    return this.store.transaction(() => {
      const prior = context.clientId ? this.clientCall(context.actor, context.clientId)
        : context.call_id && this.store.get(callRecords, context.call_id);
      if (prior) {
        if (!sameIdentity(prior.submitted_by, context.actor) || prior.tool !== name ||
          prior.origin?.conversation_id !== context.origin?.conversation_id || prior.origin?.run_id !== context.origin?.run_id) {
          reject('call_conflict', 'This request identity belongs to another invocation', 409);
        }
        const retryableClientFailure = Boolean(
          context.clientId && !context.call_id && !prior.external && (
            prior.status === 'not_submitted' ||
            (prior.status === 'failed' && (!prior.result?.status || prior.result.status >= 500))
          ),
        );
        if (!retryableClientFailure) return { record: prior, existing: true };
      }
      const id = context.call_id || randomUUID();
      const record = this.store.save(callRecords, { id, tool: name, submitted_by: context.actor, execution_actor: context.actor,
        initiating_principal: context.submitted_by || context.actor,
        origin_bot: context.actor.kind === 'bot' ? context.actor.id : null, origin: context.origin || null,
        source_event_ids: context.origin?.event_ids ?? [], target: null, controls: context.controls || [],
        client_id: context.clientId || null, charge_account: 'host', status: 'prepared', result_ref: null, return_refs: [],
        created_at: new Date().toISOString() });
      if (context.clientId) this.store.save('platform-client-calls', { id: keyOf(context.actor.kind, context.actor.id, context.clientId), call_id: id });
      if (context.origin?.conversation_id) this.addWait(id, { bot_id: context.actor.id, ...context.origin });
      return { record: this.get(id), existing: false };
    });
  }

  get(id) {
    const record = this.store.get(callRecords, id);
    if (!record) reject('call_not_found', 'Call not found', 404);
    return record;
  }

  addWait(id, origin) {
    return this.store.transaction(() => {
      const call = this.get(id);
      const waitId = origin.wait_ref || keyOf(id, origin.bot_id, origin.conversation_id, origin.run_id);
      const saved = this.store.get(waitRecords, waitId);
      if (saved) return saved;
      if (call.target) this.assertNoWaitCycle(origin, call.target, id);
      const nowIso = new Date().toISOString();
      const wait = this.store.save(waitRecords, { id: waitId, call_id: id, bot_id: origin.bot_id,
        conversation_id: origin.conversation_id, run_id: origin.run_id, control_version: origin.control_version,
        session_id: origin.session_id || null,
        ...(origin.input_call_id ? { input_call_id: origin.input_call_id, initiating_principal: origin.initiating_principal } : {}),
        target: call.target, status: 'waiting', result_position: null, created_at: nowIso, updated_at: nowIso });
      this.store.save(callRecords, { id, return_refs: [...call.return_refs, wait.id] });
      if (origin.input_call_id && receiptOutcomes.has(call.status)) {
        const event = call.result_ref?.kind === 'event' ? this.store.get('platform-events', call.result_ref.id)
          : call.result_ref?.kind === 'call' ? this.inlineEvent(call) : null;
        if (event?.call_id === id && receiptOutcomes.has(event.status)) this.deliverWaits(event, [wait], false);
      }
      return this.store.get(waitRecords, wait.id);
    });
  }

  returnWaits(origin, actor) {
    return this.linkedWaits.all(origin.run_id).map(row => JSON.parse(row.data))
      .filter(wait => wait.bot_id === actor.id && isWaitOrigin(wait, origin));
  }

  reserveExternal(id) {
    return this.store.save(callRecords, { id, external: true, status: 'submitted' });
  }

  bind(id, binding) {
    const prior = this.store.get(callRecords, id);
    if (binding.target && prior?.return_refs?.length) {
      for (const waitId of prior.return_refs) {
        const wait = this.store.get(waitRecords, waitId);
        if (wait && ['waiting', 'pending_delivery', 'received'].includes(wait.status)) {
          this.assertNoWaitCycle(wait, binding.target, id);
        }
      }
    }
    const call = this.store.save(callRecords, { id, ...binding });
    if (binding.target) {
      const nowIso = new Date().toISOString();
      for (const waitId of call.return_refs) this.store.save(waitRecords, { id: waitId, target: binding.target, updated_at: nowIso });
    }
    return call;
  }

  finish(id, status, result) {
    return this.store.transaction(() => {
      const call = this.store.save(callRecords, { id, status, result, result_ref: { kind: 'call', id } });
      const linked = [];
      for (const id of call.return_refs) {
        const wait = this.store.get(waitRecords, id);
        if (wait?.input_call_id) linked.push(wait);
        else this.store.save(waitRecords, { id, status: 'inline', target: call.target, result_position: 'inline' });
      }
      if (linked.length) this.deliverWaits(this.inlineEvent(call), linked, false);
      return result;
    });
  }

  inlineEvent(call) {
    const position = 'inline';
    return this.store.get('platform-events', keyOf('call', call.id, position)) ??
      this.saveReceiptEvent(call, { ...call.result, status: call.status }, call.target, position);
  }

  saveReceiptEvent(call, receipt, target, position) {
    const result = { kind: 'call', id: call.id, status: receipt.status, target, output: receipt.output,
      native: receipt.native, safe_to_disconnect: receipt.safe_to_disconnect,
      ...(receipt.input_status ? { input_status: receipt.input_status } : {}),
      ...(receipt.session_status ? { session_status: receipt.session_status } : {}),
      ...(receipt.partial_snapshot ? { partial_snapshot: receipt.partial_snapshot } : {}),
      ...(Number.isInteger(receipt.exit_code) ? { exit_code: receipt.exit_code } : {}),
      ...(receipt.exit_signal ? { exit_signal: receipt.exit_signal } : {}),
      ...(receipt.code ? { code: receipt.code } : {}),
      ...(receipt.error ? { error: receipt.error } : {}) };
    const meta = this.sessionMeta?.(target) || null;
    return this.store.save('platform-events', { id: keyOf('call', call.id, position), kind: 'event', type: 'call.receipt',
      author: { kind: 'platform', id: 'platform' }, call_id: call.id, target, space: this.spaceFor(target),
      ...(meta?.origin_room ? { origin_room: meta.origin_room } : {}),
      ...(meta?.origin_message_id ? { origin_message_id: meta.origin_message_id } : {}),
      ...(meta?.owner_conversation_id ? { owner_conversation_id: meta.owner_conversation_id } : {}),
      result_position: position, status: receipt.status, result, time: new Date().toISOString() });
  }

  deliverWaits(event, waits, matchWakeups = true) {
    const pending = waits.map(wait => this.store.save(waitRecords, { id: wait.id, status: 'pending_delivery',
      availability: null, latest_event_id: event.id }));
    this.deliver(event, pending, matchWakeups);
  }

  fail(id, error) {
    return this.store.transaction(() => {
      const call = this.get(id);
      if (call.status !== 'prepared') return call;
      return this.finish(id, 'failed', errorResult(error));
    });
  }

  replay(call, context) {
    if (call.status === 'failed' && !call.external && call.result?.error) {
      const { code, error, status, details } = call.result;
      reject(code, error, status, details);
    }
    if (call.target && !this.canReadTarget(context.actor, call.target, context, call)) {
      return { status: call.status, result_access: 'revoked', ref: { kind: 'call', id: call.id } };
    }
    return call.result ?? { status: call.status, ref: { kind: 'call', id: call.id } };
  }

  recordReceipt(id, receipt, target, matchWakeups = true) {
    return this.store.transaction(() => {
      const call = this.get(id);
      const position = receipt.position ?? receipt.id;
      if (position === undefined || position === null || position === '') throw new Error('Adapter receipt requires a durable result position');
      const eventId = keyOf('call', call.id, position);
      const existing = this.store.get('platform-events', eventId);
      if (existing) return existing;
      const event = this.saveReceiptEvent(call, receipt, target || call.target, position);
      const terminal = receiptOutcomes.has(receipt.status);
      const canAdvance = mayAdvanceReceipt(call, receipt.status);
      if (canAdvance) this.store.save(callRecords, { id, status: terminal ? receipt.status : 'submitted', safe_to_disconnect: receipt.safe_to_disconnect,
        result: { ...event.result, event: { kind: 'event', id: event.id } }, result_ref: { kind: 'event', id: event.id } });
      const waits = canAdvance ? call.return_refs.map(waitId => this.store.get(waitRecords, waitId)).filter(wait => wait &&
        (wait.status !== 'inline' || call.status === 'unknown' || terminal && event.target?.kind === 'session')) : [];
      this.deliverWaits(event, waits, matchWakeups);
      return event;
    });
  }

  canRead(actor, call, context) {
    if (actor.kind === 'user' || sameIdentity(actor, call.submitted_by)) return true;
    if (call.shared_with?.includes(actor.id)) return true;
    if (call.shared_rooms?.length && this.inSharedRoom?.(actor, call.shared_rooms)) return true;
    const waits = call.return_refs.map(id => this.store.get(waitRecords, id)).filter(wait =>
      wait?.bot_id === actor.id && (!wait.input_call_id || isWaitOrigin(wait, context.origin)));
    return waits.length > 0;
  }

  view(call, context) {
    if (!this.canRead(context.actor, call, context)) reject('call_not_found', 'Call not found', 404);
    const { id, tool, submitted_by, initiating_principal, execution_actor, origin, source_event_ids, status, controls, target, result_ref, client_id,
      repair_request_ids } = call;
    const targetReadable = !target || this.canReadTarget(context.actor, target, context, call);
    const own = context.actor.kind === 'user' || sameIdentity(context.actor, submitted_by);
    const shared = call.shared_with?.includes(context.actor.id) ||
      Boolean(call.shared_rooms?.length && this.inSharedRoom?.(context.actor, call.shared_rooms));
    const wait_refs = call.return_refs.map(key => this.store.get(waitRecords, key)).filter(wait => wait &&
      (context.actor.kind === 'user' || wait.bot_id === context.actor.id) && (!context.session || wait.session_id === context.session.id));
    const summaryResult = !call.result ? call.result : {
      status: call.status, output: call.result.output, native: call.result.native,
      event: call.result.event, error: call.result.error,
    };
    return { kind: 'call', id, tool, submitted_by, initiating_principal, execution_actor,
      ...(own ? { origin, source_event_ids, client_id, controls, repair_request_ids } : {}),
      status, target: targetReadable ? target : undefined, wait_refs, result_ref: targetReadable ? result_ref : null,
      result: targetReadable ? (own ? call.result : summaryResult) : (shared ? summaryResult : undefined),
      result_access: targetReadable || shared ? 'available' : 'revoked' };
  }

  unfinishedFor(conversationId, actor) {
    return this.store.list(callRecords).filter(call => call.origin?.conversation_id === conversationId && sameIdentity(call.submitted_by, actor) &&
      ['prepared', 'submitted', 'unknown'].includes(call.status)).map(call => ({ kind: 'call', id: call.id, status: call.status, target: call.target }));
  }
}
