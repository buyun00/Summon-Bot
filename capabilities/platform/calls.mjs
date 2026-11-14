import { randomUUID } from 'node:crypto';
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

export function errorResult(error) {
  if (error.status && error.code) return { code: error.code, error: error.message, status: error.status, details: error.details };
  if (error.status && error.status < 500) return { code: 'request_rejected', error: error.message, status: error.status };
  return { code: 'operation_failed', error: 'The operation failed in the host', status: 500 };
}

export class Calls {
  constructor({ store, deliver, canReadTarget, spaceFor }) {
    Object.assign(this, { store, deliver, canReadTarget, spaceFor });
    this.linkedWaits = store.db.prepare(`SELECT data FROM records WHERE kind='platform-waits'
      AND json_extract(data,'$.run_id')=? AND json_extract(data,'$.input_call_id') IS NOT NULL`);
  }

  clientCall(actor, clientId, profile) {
    const id = this.store.get('platform-client-calls', keyOf(actor.kind, actor.id, profile ?? null, clientId))?.call_id;
    return id && this.store.get(callRecords, id);
  }

  begin(name, context) {
    return this.store.transaction(() => {
      const prior = context.clientId ? this.clientCall(context.actor, context.clientId, context.workspaceProfileId)
        : context.call_id && this.store.get(callRecords, context.call_id);
      if (prior) {
        if (!sameIdentity(prior.submitted_by, context.actor) || (prior.workspaceProfileId ?? null) !== (context.workspaceProfileId ?? null) || prior.tool !== name ||
          prior.origin?.conversation_id !== context.origin?.conversation_id || prior.origin?.run_id !== context.origin?.run_id) {
          reject('call_conflict', 'This request identity belongs to another invocation', 409);
        }
        return { record: prior, existing: true };
      }
      const id = context.call_id || randomUUID();
      const record = this.store.save(callRecords, { id, tool: name, submitted_by: context.actor, execution_actor: context.actor,
        initiating_principal: context.submitted_by || context.actor,
        workspaceProfileId: context.workspaceProfileId ?? null,
        origin_bot: context.actor.kind === 'bot' ? context.actor.id : null, origin: context.origin || null,
        source_event_ids: context.origin?.event_ids ?? [], target: null, controls: context.controls || [],
        client_id: context.clientId || null, charge_account: 'host', status: 'prepared', result_ref: null, return_refs: [] });
      if (context.clientId) this.store.save('platform-client-calls', { id: keyOf(context.actor.kind, context.actor.id, context.workspaceProfileId ?? null, context.clientId), call_id: id });
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
      const wait = this.store.save(waitRecords, { id: waitId, call_id: id, bot_id: origin.bot_id,
        conversation_id: origin.conversation_id, run_id: origin.run_id, control_version: origin.control_version,
        session_id: origin.session_id || null, workspaceProfileId: call.workspaceProfileId,
        ...(origin.input_call_id ? { input_call_id: origin.input_call_id, initiating_principal: origin.initiating_principal } : {}),
        target: call.target, status: 'waiting', result_position: null });
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

  reserveExternal(id, limits) {
    const count = this.store.list(callRecords).filter(call => call.external &&
      (call.status === 'submitted' || call.status === 'unknown' && call.safe_to_disconnect !== true)).length;
    limits.assertCapacity('reserved_calls', count);
    return this.store.save(callRecords, { id, external: true, status: 'submitted' });
  }

  bind(id, binding) {
    const call = this.store.save(callRecords, { id, ...binding });
    if (binding.target) for (const waitId of call.return_refs) this.store.save(waitRecords, { id: waitId, target: binding.target });
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
      input_targets: receipt.input_targets, native: receipt.native, safe_to_disconnect: receipt.safe_to_disconnect,
      ...(receipt.error ? { error: receipt.error } : {}) };
    return this.store.save('platform-events', { id: keyOf('call', call.id, position), kind: 'event', type: 'call.receipt',
      author: { kind: 'platform', id: 'platform' }, call_id: call.id, target, space: this.spaceFor(target),
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
      const result = errorResult(error);
      return this.finish(id, 'failed', result);
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

  recordReceipt(id, receipt, target) {
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
        !(wait.status === 'inline' && call.status !== 'unknown')) : [];
      this.deliverWaits(event, waits);
      return event;
    });
  }

  canRead(actor, call, context) {
    const waits = call.return_refs.map(id => this.store.get(waitRecords, id)).filter(wait =>
      wait?.bot_id === actor.id && (!wait.input_call_id || isWaitOrigin(wait, context.origin)));
    const hasOrigin = actor.kind === 'user' || sameIdentity(actor, call.submitted_by) || waits.length > 0;
    const profile = call.workspaceProfileId ?? (call.origin_bot ? this.store.get('platform-bots', call.origin_bot)?.workspaceProfileId : null) ?? null;
    return profile === (context.workspaceProfileId ?? null) && hasOrigin &&
      (!context.session || sameRef(context.session, call.target) || call.origin?.session_id === context.session.id ||
        waits.some(wait => wait.input_call_id && wait.session_id === context.session.id));
  }

  view(call, context) {
    if (!this.canRead(context.actor, call, context)) reject('call_not_found', 'Call not found', 404);
    const { id, tool, submitted_by, initiating_principal, execution_actor, origin, source_event_ids, status, controls, target, result_ref, client_id } = call;
    const targetReadable = !target || this.canReadTarget(context.actor, target, context, call);
    const own = context.actor.kind === 'user' || sameIdentity(context.actor, submitted_by);
    const wait_refs = call.return_refs.map(key => this.store.get(waitRecords, key)).filter(wait => wait &&
      (context.actor.kind === 'user' || wait.bot_id === context.actor.id) && (!context.session || wait.session_id === context.session.id));
    return { kind: 'call', id, tool, submitted_by, initiating_principal, execution_actor, ...(own ? { origin, source_event_ids, client_id, controls } : {}),
      status, target: targetReadable ? target : undefined, wait_refs, result_ref: targetReadable ? result_ref : null,
      result: targetReadable ? (own || !call.result ? call.result : {
        status: call.status, output: call.result.output, native: call.result.native, input_targets: call.result.input_targets,
        event: call.result.event, error: call.result.error,
      }) : undefined, result_access: targetReadable ? 'available' : 'revoked' };
  }

  unfinishedFor(conversationId, actor) {
    return this.store.list(callRecords).filter(call => call.origin?.conversation_id === conversationId && sameIdentity(call.submitted_by, actor) &&
      ['prepared', 'submitted', 'unknown'].includes(call.status)).map(call => ({ kind: 'call', id: call.id, status: call.status, target: call.target }));
  }
}
