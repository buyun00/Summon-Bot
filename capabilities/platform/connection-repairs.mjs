import { operationRecords } from '../services/session-processes.mjs';
import { callRecords } from './calls.mjs';
import { idOf, identity, keyOf, reject, repairRequestType, repairResultType, sameIdentity, sameRef } from './contract.mjs';

const repairRecords = 'connection-repair-requests';
const eventRecords = 'platform-events';
const refFor = (kind, id) => ({ kind, id });
const refKey = ref => keyOf(ref.kind, ref.id);
const MAX_UNCHANGED_REPAIR_REPEATS = 3;

export class ConnectionRepairs {
  constructor(platform) {
    this.platform = platform;
    this.store = platform.store;
    this.openRecords = this.store.db.prepare(`SELECT data FROM records WHERE kind='${repairRecords}'
      AND json_extract(data,'$.reply_call_id') IS NULL
      AND (? IS NULL OR json_extract(data,'$.connection_id')=?) ORDER BY rowid`);
  }

  canUse(entry, context) {
    const { platform } = this;
    if (!entry?.enabled || !platform.canUseConnection(context.actor, entry.id, context) ||
        !platform.connections.authorized(entry, context.actor)) return false;
    const submitter = identity(context.submitted_by ?? context.actor);
    return sameIdentity(submitter, context.actor) || platform.canUseConnection(submitter, entry.id) &&
      platform.connections.authorized(entry, submitter);
  }

  canRead(event, context) {
    const request = this.store.get(repairRecords, event.request_id || event.id);
    if (!request) return false;
    if (context.actor.kind === 'user') return true;
    const entry = this.platform.connections.get(request.connection_id);
    return Boolean(entry?.enabled && (context.actor.id === request.maintainer_id || this.platform.repairableConnection(entry, context)));
  }

  canReadResult(call, context) {
    if (context.actor.kind === 'user') return true;
    const entry = this.platform.connections.get(call.target.id);
    const source = refFor('conversation', call.origin.conversation_id);
    return sameIdentity(call.submitted_by, context.actor) && this.canUse(entry, { ...context, submitted_by: call.initiating_principal }) &&
      this.platform.executions.permission(source, this.platform.executions.record(source), context);
  }

  hasOpenRepair(connectionId) {
    return this.openRecords.all(connectionId, connectionId).length > 0;
  }

  hasReports(id) { return Boolean(this.store.get(repairRecords, id)?.reports.length); }

  eventView(event, context) {
    const request = this.store.get(repairRecords, event.request_id || event.id);
    if (!request || !this.canRead(event, context)) return event;
    return { ...event, repair_status: request.status, report_count: request.reports.length, reports: request.reports.slice(-8).map(report => ({
      author: report.author, text: report.text.slice(0, 2000), source: report.source,
      references: report.references.filter(ref => this.platform.canReadReference(ref, context)),
    })) };
  }

  source(ref, entry, context, recipient) {
    if (!this.platform.canReadReference(ref, context))
      reject('share_forbidden', 'The repair source is unavailable to the sender', 403);
    const event = ref.kind === 'event' && this.store.get(eventRecords, ref.id);
    const inputCallId = ref.kind === 'call' ? ref.id : event?.type === 'work.tool' ? event.call_ref?.id : null;
    const call = inputCallId && this.store.get(callRecords, inputCallId);
    if (call && recipient?.id && !call.shared_with?.includes(recipient.id)) {
      this.store.save(callRecords, { id: call.id, shared_with: [...(call.shared_with || []), recipient.id] });
    }
    const target = call?.target;
    const operation = call && this.store.get(operationRecords, call.id);
    const session = target?.kind === 'session' ? this.platform.executions.record(target) : null;
    const matches = session?.engine === entry.id || sameRef(target, refFor('connection', entry.id)) ||
      sameRef(event?.connection ?? event?.ref, refFor('connection', entry.id));
    if (matches && (call || event?.type === 'connection.failure')) {
      const version = operation?.connection_binding_version ?? session?.connection_binding_version ?? event?.binding_version;
      return {
        reference: ref,
        source: {
          ref, ...(call ? { call_id: call.id } : {}), status: operation?.status ?? event?.status ?? call?.status,
          code: operation?.code ?? event?.code ?? call?.result?.code, method: operation?.method ?? operation?.work_method ?? event?.method,
          binding_version: version,
        },
      };
    }
    return { reference: ref };
  }

  send(args, context, call) {
    const { platform } = this;
    if (args.mentions?.length || args.attachments?.length || (args.references?.length ?? 0) > 20 ||
        !args.text?.trim() || args.text.length > 16000) {
      reject('invalid_repair_message', 'Supply repair text and up to 20 shareable references');
    }
    const target = refFor('connection', idOf(args.to, 'connection'));
    const entry = platform.connections.get(target.id);
    if (!this.canUse(entry, context)) reject('connection_forbidden', 'This repair target requires current use access to the connection and its dependencies', 403);
    if (context.actor.kind === 'bot') platform.resources.acquire('message', platform.resourceSource(context), { id: call.id }).finish();
    platform.calls.bind(call.id, { target });
    const text = platform.connections.clean(args.text.trim());
    return args.reply_to ? this.reply(entry, args, text, context, call) : this.request(entry, args, text, context, call, target);
  }

  request(entry, args, text, context, call, target) {
    const { platform } = this;
    if (args.repair_outcome) reject('invalid_repair_message', 'An outcome belongs to a reply to an existing repair request');
    const maintainer = platform.probeMaintainer(entry);
    if (!maintainer) reject('maintainer_required', 'Assign a maintainer or ensure the tool-onboarding Bot is active before requesting repair', 409);
    const recipient = refFor('bot', maintainer.id);
    if (sameIdentity(recipient, context.actor))
      reject('maintainer_is_caller', 'You are the assigned maintainer. Inspect and update this connection directly', 409);
    const blocker = platform.repairBlocker(entry, maintainer);
    if (blocker) reject(blocker.code, blocker.message, 409);

    const evidence = (args.references ?? []).map(ref => this.source(ref, entry, context, recipient));
    const source = evidence.map(item => item.source).filter(Boolean);
    const references = evidence.map(item => item.reference).filter(Boolean);

    // Join any open in-flight repair for this connection so concurrent callers never flood the maintainer.
    const pending = this.openRecords.all(entry.id, entry.id).map(row => JSON.parse(row.data))
      .find(item => item.maintainer_id === recipient.id) || null;

    // Invisible ping-pong fuse: if the same caller conversation repeatedly requests repair on an
    // unchanged connection revision after recent completed repairs, stop waking the maintainer.
    const reportKey = keyOf(context.actor.kind, context.actor.id, context.origin?.conversation_id, context.origin?.run_id);
    const callerScope = keyOf(context.actor.kind, context.actor.id, context.origin?.conversation_id);
    if (!pending) {
      const sameRevClosed = this.store.list(repairRecords)
        .filter(item => item.connection_id === entry.id && item.reply_call_id &&
          (item.replied_connection_revision ?? item.reported_connection_revision) === entry.revision &&
          item.reports?.some(r => r.caller_scope === callerScope));
      if (sameRevClosed.length >= MAX_UNCHANGED_REPAIR_REPEATS) {
        const last = sameRevClosed.at(-1);
        return platform.calls.finish(call.id, 'completed', {
          status: 'repair_fuse_tripped',
          target,
          current_revision: entry.revision,
          current_binding_version: entry.binding_version ?? 1,
          last_repair_reply: last?.last_reply_text || null,
          guidance: 'This connection has already been checked multiple times without a configuration change. Report the native error and maintainer feedback directly to the user instead of requesting another repair.',
        });
      }
    }

    const id = pending?.id ?? keyOf('connection.repair', call.id);
    const reports = pending?.reports ?? [];
    const previous = reports.find(item => item.key === reportKey);
    const request = refFor('event', id);
    const report = { key: reportKey, caller_scope: callerScope, call_id: previous?.call_id ?? call.id,
      author: context.actor, text, source: platform.connections.clean(source), references };
    this.store.save(repairRecords, {
      id,
      connection_id: entry.id,
      maintainer_id: recipient.id,
      status: 'pending',
      reported_binding_version: pending?.reported_binding_version ?? (entry.binding_version ?? 1),
      reported_connection_revision: pending?.reported_connection_revision ?? entry.revision,
      reports: previous ? reports.map(item => item === previous ? {
        ...report,
        text: previous.text === text ? text : `${previous.text}\n${text}`.slice(-16000),
        source: [...new Map([...previous.source, ...report.source].map(value => [refKey(value.ref), value])).values()].slice(-20),
        references: [...new Map([...previous.references, ...report.references].map(value => [refKey(value), value])).values()].slice(-20),
      } : item) : [...reports, report],
    });
    for (const { call_id } of source) {
      if (!call_id) continue;
      const original = this.store.get(callRecords, call_id);
      if (original && !original.repair_request_ids?.includes(id))
        platform.calls.bind(call_id, { repair_request_ids: [...(original.repair_request_ids ?? []), id] });
    }
    if (!pending) {
      const event = { id, kind: 'event', type: repairRequestType, ref: target, bot_id: recipient.id, space: recipient,
        author: context.actor, time: new Date().toISOString(), text, connection_revision: entry.revision,
        binding_version: entry.binding_version ?? 1, source: report.source };
      platform.deliveries.queueEvent(event, [], false);
      platform.deliveries.enqueue(recipient.id, event, [{ id, revision: 1, kind: 'connection_repair' }], []);
    } else if (pending.status === 'need_info') {
      const followEvent = { id: keyOf('connection.repair.followup', id, call.id), kind: 'event', type: repairRequestType,
        ref: target, request_id: id, bot_id: recipient.id, space: recipient, author: context.actor,
        time: new Date().toISOString(), text, connection_revision: entry.revision, source: report.source };
      platform.deliveries.queueEvent(followEvent, [], false);
      platform.deliveries.enqueue(recipient.id, followEvent, [{ id, revision: (pending.followup_count || 0) + 2, kind: 'connection_repair_followup' }], []);
      this.store.save(repairRecords, { id, status: 'pending', followup_count: (pending.followup_count || 0) + 1 });
    }
    if (previous) return platform.calls.finish(call.id, 'completed', { status: 'already_requested', request, target,
      repair_call: refFor('call', previous.call_id) });
    const result = { status: 'submitted', disposition: pending ? 'joined' : 'requested', request, target,
      current_binding_version: entry.binding_version ?? 1, connection_revision: entry.revision };
    platform.calls.bind(call.id, { status: 'submitted', repair_request_id: id, result, result_ref: refFor('call', call.id) });
    return result;
  }

  reply(entry, args, text, context, call) {
    const { platform } = this;
    const replyEventId = idOf(args.reply_to, 'event');
    const replyEvent = this.store.get(eventRecords, replyEventId);
    const id = replyEvent?.request_id || replyEventId;
    const request = this.store.get(repairRecords, id);
    if (!request || request.connection_id !== entry.id || context.actor.kind !== 'bot' ||
        !platform.repairableConnection(entry, context))
      reject('repair_reply_forbidden', 'Only an authorized maintainer or tool-onboarding Bot can reply to this connection repair request', 403);
    const reference = refFor('event', id);
    if (request.reply_call_id)
      return platform.calls.finish(call.id, 'completed', { status: 'already_replied', request: reference });
    const references = args.references ?? [];
    for (const ref of references) {
      if (ref.kind === 'call') {
        const cited = this.store.get(callRecords, ref.id);
        if (cited) {
          const shareIds = request.reports.map(r => r.author?.id).filter(Boolean);
          const merged = [...new Set([...(cited.shared_with || []), ...shareIds])];
          if (merged.length !== (cited.shared_with?.length ?? 0)) this.store.save(callRecords, { id: cited.id, shared_with: merged });
        }
      }
    }
    if (args.repair_outcome === 'need_info') {
      const notified = this.requestMoreInfo(request, call.id, { text, author: context.actor, outcome: 'need_info' }, references);
      return platform.calls.finish(call.id, 'completed', { status: 'need_info_sent', request: reference, replies: notified });
    }
    const replies = this.finish(request, entry, call.id, { text, author: context.actor, outcome: args.repair_outcome ?? 'repaired' }, references);
    return platform.calls.finish(call.id, 'completed', { status: 'replied', request: reference, replies,
      current_binding_version: entry.binding_version ?? 1, connection_revision: entry.revision });
  }

  requestMoreInfo(request, replyId, result, references = []) {
    const { platform } = this;
    const target = refFor('connection', request.connection_id);
    const output = { type: repairResultType, request: refFor('event', request.id), connection: target, ...result, non_terminal: true };
    const questions = [...(request.questions ?? []), { call_id: replyId, text: result.text, time: new Date().toISOString() }].slice(-8);
    this.store.save(repairRecords, { id: request.id, status: 'need_info', questions });
    let count = 0;
    for (const report of request.reports) {
      const orig = this.store.get(callRecords, report.call_id);
      if (!orig || orig.status !== 'submitted') continue;
      const recipient = { actor: orig.submitted_by };
      platform.calls.recordReceipt(orig.id, { position: keyOf('repair_need_info', request.id, replyId), status: 'needs_input',
        output: { ...output, references: references.filter(ref => platform.canReadReference(ref, recipient)) },
      }, target, false);
      count++;
    }
    return count;
  }

  finish(request, entry, replyId, result, references = []) {
    const { platform } = this;
    const target = refFor('connection', request.connection_id);
    const output = { type: repairResultType, request: refFor('event', request.id), connection: target, ...result,
      current_binding_version: entry?.binding_version ?? null, connection_revision: entry?.revision ?? null };
    this.store.save(repairRecords, { id: request.id, reply_call_id: replyId, status: result.outcome,
      replied_binding_version: entry?.binding_version ?? null,
      replied_connection_revision: entry?.revision ?? null,
      last_reply_text: result.text?.slice(0, 1000) || null });
    for (const report of request.reports) {
      const orig = this.store.get(callRecords, report.call_id);
      if (!orig || orig.status !== 'submitted') continue;
      const recipient = { actor: orig.submitted_by };
      platform.calls.recordReceipt(orig.id, { position: keyOf('repair_result', request.id), status: 'completed',
        output: { ...output, references: references.filter(ref => platform.canReadReference(ref, recipient)) },
      }, target, false);
    }
    return request.reports.length;
  }

  // Only close open requests if the connection itself was deleted or disabled;
  // updating config or upgrading binding_version during repair NEVER cancels the open ticket.
  reconcile() {
    for (const row of this.openRecords.all(null, null)) {
      const request = JSON.parse(row.data);
      const entry = this.platform.connections.get(request.connection_id);
      if (entry?.enabled) continue;
      this.store.transaction(() => this.finish(request, entry, keyOf('repair_closed', request.id), { outcome: 'blocked',
        author: { kind: 'platform', id: 'platform' }, text: 'The connection was disabled or removed.' }));
    }
  }
}
