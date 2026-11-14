import { randomUUID } from 'node:crypto';
import { keyOf, reject, sameIdentity, sameRef } from './contract.mjs';

export const callRecords = 'platform-calls';
export const waitRecords = 'platform-waits';

export function errorResult(error) {
  if (error.status && error.code) return { code: error.code, error: error.message, status: error.status, details: error.details };
  if (error.status && error.status < 500) return { code: 'request_rejected', error: error.message, status: error.status };
  return { code: 'operation_failed', error: 'The operation failed in the host', status: 500 };
}

export class Calls {
  constructor({ store, deliver, canReadTarget, spaceFor }) {
    Object.assign(this, { store, deliver, canReadTarget, spaceFor });
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
        target: call.target, status: 'waiting', result_position: null });
      this.store.save(callRecords, { id, return_refs: [...call.return_refs, wait.id] });
      if (call.result_ref?.kind === 'event') {
        const event = this.store.get('platform-events', call.result_ref.id);
        if (event) {
          const pending = this.store.save(waitRecords, { id: wait.id, status: 'pending_delivery', latest_event_id: event.id });
          this.deliver(event, [pending]);
        }
      }
      return this.store.get(waitRecords, wait.id);
    });
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
      const call = this.get(id);
      this.store.save(callRecords, { id, status, result, result_ref: { kind: 'call', id } });
      for (const waitId of call.return_refs) {
        this.store.save(waitRecords, { id: waitId, status: 'inline', target: call.target, result_position: 'inline' });
      }
      return result;
    });
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
    if (call.target && !this.canReadTarget(context.actor, call.target, context)) {
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
      const result = { kind: 'call', id, status: receipt.status, target: target || call.target,
        output: receipt.output, input_targets: receipt.input_targets, native: receipt.native,
        safe_to_disconnect: receipt.safe_to_disconnect,
        ...(receipt.error ? { error: receipt.error } : {}) };
      const event = this.store.save('platform-events', { id: eventId, kind: 'event', type: 'call.receipt',
        author: { kind: 'platform', id: 'platform' }, call_id: id, target: result.target,
        space: this.spaceFor(result.target),
        result_position: position, status: receipt.status, result, time: new Date().toISOString() });
      const terminal = ['completed', 'failed', 'stopped', 'unknown', 'unsupported', 'cancelled', 'not_submitted'].includes(receipt.status);
      const canAdvance = !['completed', 'stopped', 'failed', 'cancelled', 'not_submitted', 'unsupported'].includes(call.status) || terminal;
      if (canAdvance) this.store.save(callRecords, { id, status: terminal ? receipt.status : 'submitted', safe_to_disconnect: receipt.safe_to_disconnect,
        result: { ...result, event: { kind: 'event', id: event.id } }, result_ref: { kind: 'event', id: event.id } });
      const waits = call.return_refs.map(waitId => this.store.get(waitRecords, waitId)).filter(wait => wait &&
        !(wait.status === 'inline' && call.status !== 'unknown'));
      for (const wait of waits) {
        this.store.save(waitRecords, { id: wait.id, status: 'pending_delivery', availability: null, latest_event_id: event.id });
      }
      this.deliver(event, waits);
      return event;
    });
  }

  canRead(actor, call, context) {
    const hasOrigin = actor.kind === 'user' || sameIdentity(actor, call.submitted_by) || call.return_refs.some(id =>
      this.store.get(waitRecords, id)?.bot_id === actor.id);
    const profile = call.workspaceProfileId ?? (call.origin_bot ? this.store.get('platform-bots', call.origin_bot)?.workspaceProfileId : null) ?? null;
    return profile === (context.workspaceProfileId ?? null) && hasOrigin &&
      (!context.session || sameRef(context.session, call.target) || call.origin?.session_id === context.session.id);
  }

  view(call, context) {
    if (!this.canRead(context.actor, call, context)) reject('call_not_found', 'Call not found', 404);
    const { id, tool, submitted_by, initiating_principal, execution_actor, origin, source_event_ids, status, controls, target, result_ref, client_id } = call;
    const targetReadable = !target || this.canReadTarget(context.actor, target, context);
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
