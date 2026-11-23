import { isDeepStrictEqual } from 'node:util';
import { bindingOf, httpMethods, httpTarget } from '../services/connection-binding.mjs';
import { operationRecords } from '../services/session-processes.mjs';
import { callRecords } from './calls.mjs';
import { idOf, identity, keyOf, reject, repairRequestType, repairResultType, sameIdentity, sameRef } from './contract.mjs';

const repairRecords = 'connection-repair-requests';
const eventRecords = 'platform-events';
const refFor = (kind, id) => ({ kind, id });
const refKey = ref => keyOf(ref.kind, ref.id);

function repairBinding(entry) {
  const http = entry.kind === 'http' && httpMethods(entry.config).map(method => keyOf(httpTarget(method),
    Object.entries(method.headersEnv ?? {}).sort(([a], [b]) => a.localeCompare(b))));
  return { ...bindingOf(entry), runner: entry.config.adapter?.runner ?? null,
    ...(http ? { targets: [...new Set(http)].sort() } : {}) };
}

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
    const request = this.store.get(repairRecords, event.id);
    if (!request) return false;
    if (context.actor.kind === 'user') return true;
    const entry = this.platform.connections.get(request.connection_id);
    return context.actor.id === request.maintainer_id && this.acceptsReply(request, entry) &&
      this.platform.probeRepairAllowed(entry, context);
  }

  canReadResult(call, context) {
    if (context.actor.kind === 'user') return true;
    const entry = this.platform.connections.get(call.target.id);
    const source = refFor('conversation', call.origin.conversation_id);
    return sameIdentity(call.submitted_by, context.actor) && this.canUse(entry, { ...context, submitted_by: call.initiating_principal }) &&
      this.platform.executions.permission(source, this.platform.executions.record(source), context);
  }

  hasReports(id) { return Boolean(this.store.get(repairRecords, id)?.reports.length); }

  acceptsReply(request, entry) {
    return entry?.enabled && this.platform.manager.maintainer(entry)?.id === request.maintainer_id &&
      isDeepStrictEqual(request.binding, repairBinding(entry));
  }

  eventView(event, context) {
    const request = this.store.get(repairRecords, event.id);
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
        probe_id: call?.result?.maintenance?.event?.id,
      };
    }
    return { reference: ref };
  }

  send(args, context, call) {
    const { platform } = this;
    if (args.mentions?.length || args.attachments?.length || (args.references?.length ?? 0) > 20 ||
        !args.text?.trim() || args.text.length > 16000 || args.repair_key !== undefined &&
        (!args.repair_key.trim() || args.repair_key.length > 160)) {
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
    const maintainer = platform.manager.maintainer(entry);
    if (!maintainer) reject('maintainer_required', 'Assign a maintainer to this connection before requesting repair', 409);
    const recipient = refFor('bot', maintainer.id);
    if (sameIdentity(recipient, context.actor))
      reject('maintainer_is_caller', 'You are the assigned maintainer. Use your repair grants to handle this connection', 409);
    const blocker = platform.repairBlocker(entry, maintainer);
    if (blocker) reject(blocker.code, blocker.message, 409);
    const evidence = (args.references ?? []).map(ref => this.source(ref, entry, context, recipient));
    const source = evidence.map(item => item.source).filter(Boolean);
    const sourceKeys = source.map(item => item.call_id ? keyOf('call', item.call_id) : refKey(item.ref));
    const references = evidence.map(item => item.reference).filter(Boolean);
    const faultKey = args.repair_key?.trim() ?? null;
    const probe = platform.deliveries.openProbeFailure(entry.id);
    const relatedProbe = probe?.bot_id === recipient.id &&
      probe.binding_version === (entry.binding_version ?? 1) && evidence.some(item => item.probe_id === probe.id || sameRef(item.source?.ref, refFor('event', probe.id)));
    const binding = repairBinding(entry);
    const pending = this.openRecords.all(entry.id, entry.id).map(row => JSON.parse(row.data))
      .find(item => item.maintainer_id === recipient.id && isDeepStrictEqual(item.binding, binding) &&
        (faultKey !== null && item.fault_keys.includes(faultKey) || sourceKeys.some(key => item.source_keys.includes(key)) ||
          relatedProbe && item.id === probe.id));
    const id = pending?.id ?? (relatedProbe ? probe.id : keyOf('connection.repair', call.id));
    const reportKey = keyOf(context.actor.kind, context.actor.id, context.origin?.conversation_id, context.origin?.run_id);
    const reports = pending?.reports ?? [];
    const previous = reports.find(item => item.key === reportKey);
    const request = refFor('event', id);
    const report = { key: reportKey, call_id: previous?.call_id ?? call.id, author: context.actor, text,
      source: platform.connections.clean(source), references };
    this.store.save(repairRecords, { id, binding, connection_id: entry.id, maintainer_id: recipient.id, status: 'pending',
      fault_keys: [...new Set([...(pending?.fault_keys ?? []), ...(faultKey ? [faultKey] : [])])],
      source_keys: [...new Set([...(pending?.source_keys ?? []), ...sourceKeys])],
      reports: previous ? reports.map(item => item === previous ? {
        ...report,
        text: previous.text === text ? text : `${previous.text}\n${text}`.slice(-16000),
        source: [...new Map([...previous.source, ...report.source].map(value => [refKey(value.ref), value])).values()].slice(-20),
        references: [...new Map([...previous.references, ...report.references].map(value => [refKey(value), value])).values()].slice(-20),
      } : item) : [...reports, report] });
    for (const { call_id } of source) {
      if (!call_id) continue;
      const original = this.store.get(callRecords, call_id);
      if (original && !original.repair_request_ids?.includes(id))
        platform.calls.bind(call_id, { repair_request_ids: [...(original.repair_request_ids ?? []), id] });
    }
    if (!pending && !relatedProbe) {
      const event = { id, kind: 'event', type: repairRequestType, ref: target, bot_id: recipient.id, space: recipient,
        author: context.actor, time: new Date().toISOString(), text, connection_revision: entry.revision, source: report.source };
      platform.deliveries.queueEvent(event, [], false);
      platform.deliveries.enqueue(recipient.id, event, [{ id, revision: 1, kind: 'connection_repair' }], []);
    }
    if (previous) return platform.calls.finish(call.id, 'completed', { status: 'already_requested', request, target,
      repair_call: refFor('call', previous.call_id) });
    const result = { status: 'submitted', disposition: pending || relatedProbe ? 'joined' : 'requested', request, target };
    platform.calls.bind(call.id, { status: 'submitted', repair_request_id: id, result, result_ref: refFor('call', call.id) });
    return result;
  }

  reply(entry, args, text, context, call) {
    const { platform } = this;
    if (args.repair_key !== undefined) reject('invalid_repair_message', 'Reply to the existing event without a new repair key');
    const id = idOf(args.reply_to, 'event');
    const request = this.store.get(repairRecords, id);
    if (!request || request.connection_id !== entry.id || context.actor.kind !== 'bot' ||
        request.maintainer_id !== context.actor.id || !this.acceptsReply(request, entry) || !platform.probeRepairAllowed(entry, context))
      reject('repair_reply_forbidden', 'Only the current authorized maintainer can reply to this connection repair request', 403);
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
    const replies = this.finish(request, call.id, { text, author: context.actor, outcome: args.repair_outcome ?? 'reported' }, references);
    return platform.calls.finish(call.id, 'completed', { status: 'replied', request: reference, replies });
  }

  finish(request, replyId, result, references = []) {
    const { platform } = this;
    const target = refFor('connection', request.connection_id);
    const output = { type: repairResultType, request: refFor('event', request.id), connection: target, ...result };
    this.store.save(repairRecords, { id: request.id, reply_call_id: replyId, status: result.outcome });
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

  reconcile() {
    for (const row of this.openRecords.all(null, null)) {
      const request = JSON.parse(row.data);
      const entry = this.platform.connections.get(request.connection_id);
      if (this.acceptsReply(request, entry)) continue;
      this.store.transaction(() => this.finish(request, keyOf('repair_closed', request.id), { outcome: 'blocked',
        author: { kind: 'platform', id: 'platform' }, text: 'The connection binding or assigned maintainer changed. Check the current connection before continuing.' }));
    }
  }
}
