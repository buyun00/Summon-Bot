import { activeControl, assertResume, canResume, resumeReference } from '../bot-management/service.mjs';
import { assertRevision, idOf, identity, keyOf, reject, sameIdentity, sameRef } from './contract.mjs';
import { callRecords, errorResult, mayAdvanceReceipt } from './calls.mjs';
import { allowsConnection, enclosesExecutableScope, executableScope } from '../services/executable-scope.mjs';
import { executionGuide } from '../connectors/initialization.mjs';
import { operationRecords } from '../services/session-processes.mjs';
import { forwardInputs, unresolvedForward } from './session-work.mjs';

export const sessionRecords = 'platform-sessions';
export const conversationRecords = 'platform-conversations';
const inputRecords = 'platform-inputs';
const terminal = new Set(['completed', 'failed', 'stopped', 'unknown', 'unsupported', 'idle', 'cancelled', 'not_submitted']);
const inputFields = {
  codex_turn: ['turn_id', 'request_id'], pi_run: ['run_id', 'request_id'], cli_process: ['instance_id', 'launch_call_id', 'request_id'],
  service_call: ['call_id', 'request_id', 'operation_id'], idle_input: ['input_revision'],
};

const settledStop = (status, safe) => status === 'idle' || ['completed', 'failed', 'stopped', 'not_submitted'].includes(status) && safe === true;

export function sameInput(a, b) {
  return a?.kind === b?.kind && Boolean(inputFields[a?.kind]?.every(field => a[field] === b[field]));
}

function matchesOperation(call, inputTarget) {
  const native = call.result?.native;
  switch (inputTarget.kind) {
    case 'codex_turn': return native?.turn_id == null || native.turn_id === inputTarget.turn_id;
    case 'pi_run': return native?.run_id == null || native.run_id === inputTarget.run_id;
    case 'cli_process': return call.id === inputTarget.launch_call_id && (native?.instance_id == null || native.instance_id === inputTarget.instance_id);
    case 'service_call': return call.id === inputTarget.call_id &&
      (native?.operation_id == null || String(native.operation_id) === inputTarget.operation_id);
    default: return false;
  }
}

const roomMember = (members, actor) => members.includes(actor.id);
const granted = (values, actor, members, roomId) => values?.some(principal => principal.kind === 'room_members'
  ? principal.id === roomId && roomMember(members, actor) : sameIdentity(principal, actor));

function compactText(value, limit = 280) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

function compactPendingInput(pending) {
  if (!Array.isArray(pending) || !pending.length) return [];
  return pending.map(item => ({
    id: item.id,
    kind: item.kind || null,
    plain_text: item.plain_text,
    answer_format: item.answer_format,
    question: item.question ?? item.text ?? item.prompt,
    ...(Array.isArray(item.choices) && item.choices.length
      ? { choices: item.choices.map(choice => ({ id: choice.id, label: choice.label ?? choice.id })) }
      : {}),
    ...(item.schema ? { has_schema: true } : {}),
  }));
}

function outputPreview(output) {
  if (typeof output === 'string') return compactText(output, 280);
  if (output && typeof output === 'object') {
    if (typeof output.text === 'string') return compactText(output.text, 280);
    if (typeof output.error === 'string') return compactText(output.error, 240);
  }
  return null;
}

function unconfirmedPiSubmission(call) {
  if (call.status === 'submitted') return !call.result_ref;
  if (call.status !== 'unknown') return false;
  return call.result?.code === 'pi_submission_unconfirmed' ||
    call.result_ref?.id === keyOf('call', call.id, keyOf('submission', call.id, 'unknown'));
}

export class Executions {
  constructor({ store, platform, calls, resources }) { Object.assign(this, { store, platform, calls, resources }); }

  record(target) {
    return this.store.get(target.kind === 'session' ? sessionRecords : conversationRecords, target.id);
  }

  followupSessions(botId, roomId) {
    return this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-sessions'
      AND json_extract(data,'$.owner.id')=? AND json_extract(data,'$.acceptance_state')='open'
      AND json_extract(data,'$.origin_execution.kind')='conversation' AND
      (json_extract(data,'$.origin_room.id')=? OR ? IN (SELECT value FROM json_each(data,'$.allowed_followup_rooms')))`)
      .all(botId, roomId, roomId).map(row => JSON.parse(row.data));
  }

  withdrawnFollowups(botId, roomId) {
    return this.store.db.prepare(`SELECT data FROM records WHERE kind='room-intake-withdrawals'
      AND json_extract(data,'$.bot_id')=? AND json_extract(data,'$.room_id')=? ORDER BY rowid DESC LIMIT 12`)
      .all(botId, roomId).map(({ data }) => {
        const { withdrawn_at, local_message_ids } = JSON.parse(data);
        return { withdrawn_at, local_message_ids };
      });
  }

  directWork(conversationId) {
    return this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-sessions'
      AND json_extract(data,'$.owner_conversation_id')=?`).all(conversationId).map(row => JSON.parse(row.data));
  }

  checkContinuation(args, context, room, question) {
    if (!room || !question || !context.origin?.conversation_id) return;
    const replacement = args.replaces_session && this.require({ kind: 'session', id: idOf(args.replaces_session, 'session') }, context, 'control');
    if (replacement && (!sameRef(replacement.origin_room, room) || replacement.origin_message_id !== question ||
        replacement.owner_conversation_id !== context.origin.conversation_id))
      reject('work_origin_mismatch', 'A replacement must keep the direct owner and original question of the work', 409);
    const implicated = new Set(replacement ? [replacement.id] : []);
    if (!replacement && context.conversation?.space?.kind === 'room') {
      const forwards = this.calls.forwardsFor(context.actor.id, context.conversation.space.id, context.origin.event_ids);
      for (const call of forwards.values()) {
        const target = call.target ?? call.origin.forward_target;
        if (target?.kind === 'session') implicated.add(target.id);
      }
    }
    for (const id of context.origin.event_ids) {
      const event = this.store.get('platform-events', id);
      if (event?.type !== 'call.receipt' || event.target?.kind !== 'session') continue;
      if (!replacement || replacement.id === event.target.id) implicated.add(event.target.id);
      const original = this.store.get(callRecords, event.call_id);
      if (unresolvedForward(original) &&
          sameRef(event.origin_room, room) && event.origin_message_id === question && (!replacement || replacement.id === event.target.id))
        reject('call_result_unknown', 'The original material input has an unresolved result. Read the original call and its native input receipt before continuing.', 409,
          { call_id: original.id, target: original.target });
    }
    for (const id of implicated) {
      const work = this.record({ kind: 'session', id });
      if (work?.owner_conversation_id === context.origin.conversation_id && sameRef(work.origin_room, room) &&
          work.origin_message_id === question && work.control.state === 'paused')
        reject('work_paused', 'This continuation depends on a paused execution. Wait for its authorized resume and the original user’s handover conditions.', 409,
          { session_id: id, control: work.control });
    }
  }

  reserveForwardRecovery(args, context, attempt, work) {
    if (context.origin?.fast_read_forward) return;
    if (work?.origin_execution?.kind !== 'conversation') {
      if (args.recovery_of) reject('recovery_source_mismatch', 'Material recovery needs the original Room work', 409);
      return;
    }
    const room = context.conversation?.space;
    const sources = context.origin?.event_ids || [];
    const candidates = new Map();
    const consider = call => {
      if (!call?.origin?.fast_read_forward) return;
      const target = call.target ?? call.origin.forward_target;
      const original = target && this.record(target);
      if (!original || original.owner_conversation_id !== work.owner_conversation_id ||
          !sameRef(original.origin_room, work.origin_room) || original.origin_message_id !== work.origin_message_id) return;
      if (work.id && work.id !== original.id && work.replaces_session !== original.id && !args.recovery_of) return;
      if (context.actor.kind !== 'user' && !sameIdentity(context.actor, original.owner)) return;
      candidates.set(call.id, call);
    };
    if (args.recovery_of) {
      consider(this.store.get(callRecords, idOf(args.recovery_of, 'call')));
      if (!candidates.size) reject('recovery_source_mismatch', 'Select the original material call for this work and owner', 409);
    } else {
      if (!sources.length || room?.kind !== 'room') return;
      for (const call of this.calls.forwardsFor(context.actor.id, room.id, sources).values()) {
        const route = this.platform.runtime.forwardRoute(context.actor.id, call.source_event_ids[0]);
        if (route?.fast_read_forward_fallback || unresolvedForward(call) || call.status === 'not_submitted') consider(call);
      }
      for (const id of sources) {
        const event = this.store.get('platform-events', id);
        if (event?.type !== 'call.receipt' || !['not_submitted', 'unknown', 'failed'].includes(event.status)) continue;
        consider(this.store.get(callRecords, event.call_id));
      }
      if (!candidates.size) return;
      const relevant = new Set([work.origin_message_id, ...[...candidates.values()].map(call => call.source_event_ids[0])]);
      if (sources.some(id => !relevant.has(id) && this.store.get('messages', id))) return;
      if (candidates.size !== 1) reject('recovery_source_required', 'Identify the material being retried in recovery_of.', 409,
        { call_ids: [...candidates.keys()] });
    }
    const [original] = candidates.values();
    const latest = original.forward_recovery_call_id ? this.calls.get(original.forward_recovery_call_id) : original;
    const input = latest.input_id && this.store.get(inputRecords, latest.input_id);
    const notSubmitted = latest.status === 'not_submitted' || latest.submission_outcome === 'not_submitted' || latest.status === 'failed' &&
      (latest.result?.input_status === 'rejected' || input?.call_id === latest.id && input.status === 'not_submitted' ||
        !latest.external && !latest.pi_writer_pid && latest.result_ref?.kind === 'call' && !latest.result?.native);
    if (!notSubmitted)
      reject(unresolvedForward(original) || ['prepared', 'submitted', 'unknown'].includes(latest.status) ? 'call_result_unknown' : 'material_already_handled',
        'Read the existing attempt for this material. Retry only after it is confirmed not submitted.', 409,
        { source_call_id: original.id, call_id: latest.id, status: latest.status });
    this.calls.bind(original.id, { forward_recovery_call_id: attempt.id });
    this.calls.bind(attempt.id, { recovery_of: original.id });
  }

  openChildren(session) {
    return this.directWork(session.conversation_id || session.id).filter(child => child.acceptance_state === 'open' &&
      child.origin_execution?.kind === 'session' && child.origin_execution.id === session.id);
  }

  childReviews(sessionId) {
    const session = this.record({ kind: 'session', id: sessionId });
    return this.openChildren(session).map(child => {
      const result = this.store.get(callRecords, child.latest_call_id)?.result_ref?.id;
      const held = child.acceptance_hold?.call_id === child.latest_call_id && child.acceptance_hold.result_id === result;
      return { id: child.id, status: child.status, call_id: child.latest_call_id, result_id: result,
        review_due: terminal.has(child.status) && !held };
    });
  }

  roomReply(args, context, room, reply) {
    const label = args.work_reply;
    if (context.actor.kind !== 'bot') {
      if (label) reject('session_owner_required', 'The original Room owner publishes delegated work', 403);
      return { reply };
    }
    const selected = label && this.record({ kind: 'session', id: idOf(label.session, 'session') });
    const question = label?.stage === 'complete' ? selected?.origin_message_id : reply?.id;
    if (question && (!label || label.stage === 'complete')) {
      const crossRoom = !sameRef(context.conversation?.space, room);
      const peers = this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-sessions'
        AND json_extract(data,'$.origin_room.id')=? AND json_extract(data,'$.origin_message_id')=?
        AND (? OR json_extract(data,'$.owner.id')=?) AND json_extract(data,'$.origin_execution.kind')='conversation'`)
        .all(room.id, question, Number(crossRoom && !label), context.actor.id).map(row => JSON.parse(row.data));
      for (const peer of peers) {
        const previous = this.originalReplies(peer).findLast(({ message, stage }) =>
          ['complete', 'correction'].includes(stage) || peer.acceptance?.outcome === 'delivered' && peer.acceptance.message_id === message.id);
        if (previous && (!label || selected?.owner_conversation_id === context.conversation.id && sameRef(selected.origin_room, room)))
          return { reply: { kind: 'event', id: question }, retained: previous.message };
      }
    }
    // A result turn can refer to the material it just processed. Preserve
    // ordinary replies to new messages and explicit progress acknowledgements.
    const forward = reply && this.calls.forwardsFor(context.actor.id, room.id, [reply.id]).get(reply.id);
    const fromResult = forward && context.origin.event_ids.some(id => {
      const event = this.store.get('platform-events', id);
      return event?.type === 'call.receipt' && event.call_id === forward.id && event.status === 'completed';
    });
    const recovery = !label && !fromResult && reply && context.origin.event_ids.map(id => this.store.get('platform-events', id))
      .filter(event => event?.type === 'call.receipt' && event.target?.kind === 'session')
      .map(event => this.record(event.target)).find(work => work?.retained_delivery && work.origin_message_id === reply.id);
    if (!label && !fromResult && !recovery) return { reply };
    const target = label ? { kind: 'session', id: idOf(label.session, 'session') } :
      recovery ? { kind: 'session', id: recovery.id } : forward.target;
    const work = target && this.record(target);
    if (work?.origin_execution?.kind !== 'conversation' || work.owner_conversation_id !== context.conversation.id ||
        !sameIdentity(work.owner, context.actor) || !sameRef(work.origin_room, room) || !work.origin_message_id) {
      if (label) reject('work_origin_mismatch', 'Publish the result from the original owner in the work’s original Room', 409);
      return { reply };
    }
    if (!label && fromResult && !recovery)
      reject('work_reply_stage_required', 'This reply refers to material whose result just returned. Use work_reply with progress to acknowledge the material, or complete to deliver the full result on its original question.', 409,
        { session: work.id, origin_message_id: work.origin_message_id });
    const stage = label?.stage || 'complete';
    if (label && reply && reply.id !== work.origin_message_id && stage !== 'progress' && !sameRef(forward?.target, target))
      reject('work_origin_mismatch', 'The selected reply belongs to another question. Use the work’s original question.', 409,
        { origin_message_id: work.origin_message_id });
    const retained = work.retained_delivery && !['progress', 'correction'].includes(stage) &&
      this.originalReplies(work).find(item => item.message.id === work.retained_delivery.message_id)?.message;
    return { reply: stage === 'progress' && reply ? reply : { kind: 'event', id: work.origin_message_id },
      retained, work_reply: { session_id: work.id, stage } };
  }

  originalReplies(work) {
    return this.store.db.prepare(`SELECT data FROM records WHERE kind='messages' AND json_extract(data,'$.roomId')=?
      AND json_extract(data,'$.senderId')=? AND json_extract(data,'$.replyTo')=? ORDER BY rowid`)
      .all(work.origin_room.id, work.owner.id, work.origin_message_id).map(row => JSON.parse(row.data)).flatMap(message => {
        const call = message.callId && this.store.get(callRecords, message.callId);
        return call?.tool === 'send' && call.status === 'completed' && sameRef(call.target, work.origin_room) &&
          call.origin?.conversation_id === work.owner_conversation_id && call.result?.message?.id === message.id
          ? [{ message, stage: call.work_reply?.stage, session_id: call.work_reply?.session_id }] : [];
      });
  }

  acceptance(current, args, context, hostReview) {
    const children = this.openChildren(current);
    if (children.length) reject('child_acceptance_pending', 'The direct parent Pi must review its open children before closing. Continue that Pi for review, or leave the parent open pending the recorded work.',
      409, { children: children.map(child => ({ id: child.id, status: child.status, waiting_summary: child.waiting_summary })) });
    if (!terminal.has(current.status) || current.status === 'unknown' && current.safe_to_disconnect !== true &&
        !(hostReview && current.authority_revoked && current.engine === 'pi' && this.platform.runtime.piAtRest(current)))
      reject('work_in_progress', 'Review the final execution result, or stop the active execution before closing it', 409);
    const publicWork = current.origin_room && current.origin_message_id && current.origin_execution?.kind === 'conversation';
    if (args.close_reason) return { outcome: args.close_reason, ...(args.disposition_note && { note: args.disposition_note.trim() }) };
    if (['failed', 'cancelled', 'stopped', 'not_submitted', 'unsupported'].includes(current.status) && !args.delivery_message_id)
      return { outcome: current.status };
    if (!publicWork) return { outcome: 'reviewed' };
    const id = args.delivery_message_id ? idOf(args.delivery_message_id, 'event') : current.retained_delivery?.message_id;
    const latest = this.store.get(callRecords, current.latest_call_id);
    const resultAt = (latest?.result_ref?.kind === 'event' && this.store.get('platform-events', latest.result_ref.id)?.time) || latest?.updatedAt;
    const published = this.originalReplies(current);
    const final = published.findLast(item => item.session_id === current.id && ['complete', 'correction'].includes(item.stage));
    const replies = published.filter(({ message, stage }) => stage !== 'progress' && (!id || message.id === id) &&
      (!final || message.createdAt >= final.message.createdAt) &&
      (!resultAt || message.createdAt >= resultAt || id && (args.disposition_note?.trim() ||
        current.retained_delivery?.message_id === id))).map(item => item.message);
    if (replies.length !== 1)
      reject('room_delivery_required', replies.length ? 'Select the confirmed complete reply using delivery_message_id.' :
        'Review the original requirements and send the complete answer replying to the original question before closing. If a previous delivery already covers this result, identify it and explain in disposition_note.',
        409, { replies: published.slice(-5).map(({ message, stage }) => ({ id: message.id, stage, text: message.content.slice(0, 1200) })) });
    return { outcome: 'delivered', message_id: replies[0].id, call_id: replies[0].callId,
      ...(args.disposition_note && { note: args.disposition_note.trim() }) };
  }

  retainUndelivered(event, botId) {
    const target = event.target ?? this.store.get(callRecords, event.call_id)?.target;
    const session = target?.kind === 'session' && this.record(target);
    if (!session?.origin_room || session.acceptance_state === 'closed' || session.origin_execution?.kind !== 'conversation' || session.owner?.id !== botId ||
        this.store.get(callRecords, event.call_id)?.result_ref?.id !== event.id ||
        this.platform.canReadSpace(session.owner, session.origin_room) || session.pending_delivery?.receipt?.id === event.id) return;
    this.store.save(sessionRecords, { id: session.id, pending_delivery: { reason: 'origin_room_unavailable',
      origin_room: session.origin_room, origin_message_id: session.origin_message_id, call_id: event.call_id,
      status: event.status, receipt: { kind: 'event', id: event.id } } });
  }

  retainRoomResults(roomId) {
    const work = this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-sessions' AND
      json_extract(data,'$.origin_room.id')=? AND json_extract(data,'$.acceptance_state')='open' AND
      json_extract(data,'$.origin_execution.kind')='conversation'`).all(roomId);
    for (const row of work) {
      const session = JSON.parse(row.data);
      const call = this.store.get(callRecords, session.latest_call_id);
      if (call?.result_ref?.kind !== 'event') continue;
      const event = this.store.get('platform-events', call.result_ref.id);
      if (event) this.retainUndelivered(event, session.owner.id);
    }
  }

  sameOperationTarget(left, right, pi) {
    if (sameRef(left, right)) return true;
    if (!pi || !left || !right || left.kind === right.kind) return false;
    const [session, conversation] = left.kind === 'session' ? [left, right] : [right, left];
    return session.kind === 'session' && conversation.kind === 'conversation' &&
      this.record(session)?.engine === 'pi' && this.record(conversation)?.session_id === session.id;
  }

  registerConversation(record) {
    const existing = this.store.get(conversationRecords, record.id);
    if (existing) {
      if (existing.bot_id !== record.bot_id) reject('conversation_conflict', 'Conversation belongs to another Bot', 409);
      return existing;
    }
    const actor = { kind: 'bot', id: record.bot_id };
    this.platform.getBot(record.bot_id);
    if (record.session_id) {
      const session = this.record({ kind: 'session', id: record.session_id });
      if (!session || !sameIdentity(session.execution_actor, actor)) reject('session_conflict', 'Conversation does not belong to the Session', 409);
    }
    return this.store.save(conversationRecords, { id: record.id, kind: record.kind, bot_id: record.bot_id, space: record.space ?? actor,
      owner: record.owner ?? actor, session_id: record.session_id ?? null,
      ...(record.connection_setup ? { connection_setup: record.connection_setup } : {}),
      control: activeControl(), input_revision: record.input_revision ?? 0 });
  }

  permission(target, record, context, operation = 'read') {
    if (!record) return false;
    const { actor, session } = context;
    const execution = target.kind === 'session' ? record : record.session_id && this.record({ kind: 'session', id: record.session_id });
    if (execution?.project_room && actor.kind !== 'user') {
      const origin = this.platform.projectRoom(context);
      if (origin && !sameRef(origin, execution.project_room)) return false;
      if (execution.room_workspace_id && !this.platform.roomMembers(execution.project_room.id).includes(actor.id)) return false;
    }
    if (context.executable_scope !== undefined) {
      const native = target.kind === 'session' && record.engine !== 'pi';
      const get = id => this.platform.connections.get(id);
      const internalScope = target.kind === 'session' ? record.executable_scope : executableScope({ conversation: record,
        session: record.session_id && this.record({ kind: 'session', id: record.session_id }) });
      if (native ? !allowsConnection(context.executable_scope, get(record.engine), get) :
          !enclosesExecutableScope(context.executable_scope, internalScope)) return false;
    }
    if (session) {
      const current = { kind: 'session', id: session.id };
      const child = target.kind === 'session' && sameRef(record.origin_execution, current);
      if (target.kind === 'session' ? session.id !== target.id && !child : record.session_id !== session.id) return false;
    }
    if (actor.kind === 'user') return true;
    if (target.kind === 'conversation') {
      if (record.bot_id !== actor.id) return false;
      if (record.connection_setup && context.origin?.conversation_id !== record.id) return false;
      return record.space?.kind !== 'room' || this.platform.roomMembers(record.space.id).includes(actor.id);
    }
    if (sameIdentity(record.owner, actor)) return !record.sharing || this.platform.roomMembers(record.space.id).includes(actor.id);
    if (!record.sharing) return false;
    const members = this.platform.roomMembers(record.space.id);
    const key = operation === 'input' ? 'submitters' : operation === 'control' ? 'controllers' : 'readers';
    return granted(record.sharing[key], actor, members, record.space.id);
  }

  require(target, context, operation) {
    const record = this.record(target);
    if (!this.permission(target, record, context, operation)) reject('execution_not_found', 'Execution is unavailable', 404);
    return record;
  }

  active(record, version) {
    assertRevision(record.control.control_version, version, 'control_version');
    if (record.control.state !== 'active') reject('execution_paused', 'Execution is paused', 409, { control_version: record.control.control_version });
  }

  checkSubmitResources(target, record, context) {
    const session = target.kind === 'session' ? record : record.session_id && this.record({ kind: 'session', id: record.session_id });
    if (session) this.platform.assertCanSubmit(context, session);
  }

  list(context, scope) {
    return [{ kind: 'session', records: sessionRecords }, { kind: 'conversation', records: conversationRecords }].flatMap(({ kind, records }) =>
      this.store.list(records).filter(record => (!scope || sameRef(record.space, scope) || sameRef(record.source_space, scope) ||
        scope.kind === 'bot' && record.bot_id === scope.id) &&
        this.permission({ kind, id: record.id }, record, context)).map(record => this.baseView({ kind, id: record.id }, record, context)));
  }

  baseView(target, record, context, observation) {
    const controlled = this.permission(target, record, context, 'control');
    const { control } = record;
    const conversation = target.kind === 'conversation';
    const facts = conversation ? observation ?? this.platform.runtime.conversationSummary(record.id) : observation;
    const status = facts?.status || (conversation ? 'unknown' : record.status ?? 'idle');
    const error = conversation && facts?.last_error;
    const sessionMeta = !conversation ? {
      ...(record.origin_room && this.platform.canReadSpace(context.actor, record.origin_room, context) ? { origin_room: record.origin_room } : {}),
      ...(record.origin_message_id ? { origin_message_id: record.origin_message_id } : {}),
      ...(record.owner_conversation_id ? { owner_conversation_id: record.owner_conversation_id } : {}),
      ...(record.work_summary ? { work_summary: record.work_summary } : {}),
      ...(record.waiting_summary !== undefined ? { waiting_summary: record.waiting_summary } : {}),
      ...(record.last_output_summary ? { last_output_summary: record.last_output_summary } : {}),
      ...(record.acceptance_state ? { acceptance_state: record.acceptance_state } : {}),
      ...(record.pending_delivery && (context.actor.kind === 'user' || sameIdentity(context.actor, record.owner)) ?
        { pending_delivery: record.pending_delivery } : {}),
      ...(context.actor.kind === 'user' && { authority_revoked: Boolean(record.authority_revoked),
        revocation_call_id: record.revocation_call_id ?? null, acceptance: record.acceptance }),
      ...(Array.isArray(record.allowed_followup_rooms) ? { allowed_followup_rooms: record.allowed_followup_rooms } : {}),
      followup_room_details: this.platform.roomWork.intakes(record, context.actor),
    } : {};
    return { kind: target.kind, id: record.id, execution_ref: target, bot_id: record.bot_id, space: record.space, engine: record.engine,
      source_space: record.source_space && this.platform.canReadSpace(context.actor, record.source_space, context) ? record.source_space : undefined,
      model: record.model, execution_actor: record.execution_actor, submitted_by: record.submitted_by, latest_call_id: record.latest_call_id,
      status, ...(error ? { last_error: { code: error.code, message: error.message } } : {}), ...sessionMeta,
      control, control_version: control.control_version, input_revision: record.input_revision,
      can_stop: controlled, can_submit: this.permission(target, record, context, 'input') && !record.authority_revoked,
      resume_ref: controlled && canResume(context.actor, control, record.owner) ? resumeReference(target, control) : null };
  }

  async inspect(target, record, options = {}) {
    if (target.kind === 'conversation') return this.platform.runtime.inspectConversation(record.id, options);
    if (record.engine === 'pi') return this.platform.runtime.pi.inspect(record, options);
    return await this.platform.connections.inspect(record, options) ?? {};
  }

  async read(target, context, args = {}) {
    const record = this.require(target, context, 'read');
    const observation = await this.inspect(target, record, { cursor: args.cursor, limit: args.limit });
    const current = this.require(target, context, 'read');
    const safe = observation.safe_to_disconnect;
    if (target.kind === 'session' && current.control.state === 'paused' && current.control.stop_status !== 'stopped' &&
        current.latest_call_id === record.latest_call_id && current.control.control_version === record.control.control_version &&
        (observation.input_revision === undefined || observation.input_revision >= current.input_revision) &&
        settledStop(observation.session_status || observation.status, current.engine === 'pi' || safe === true)) {
      current.control = this.saveControl(target, { ...current.control, stop_status: 'stopped' }).control;
    }
    const base = this.baseView(target, current, context, observation);
    if (target.kind === 'session' && base.can_submit) {
      try { this.platform.assertSessionAuthority(current); }
      catch (error) {
        base.can_submit = false;
        base.last_error = error.code === 'session_authority_revoked' ? { code: error.code, message: 'Session authority was revoked' }
          : { code: 'session_authority_unavailable', message: 'The Session authority could not be verified' };
      }
    }
    const inputTargets = observation.input_targets || current.input_targets || [];
    const questions = observation.pending_input ?? current.pending_input ?? [];
    const output = observation.output ?? (observation.output_page?.text ? observation.output_page.text : undefined);
    return { ...observation, ...base, output, input_revision: observation.input_revision ?? base.input_revision,
      input_targets: base.can_submit && current.control.state === 'active' ? inputTargets.map(option => {
        const question = option.input_target?.request_id && questions.find(item => item.id === option.input_target.request_id);
        return question ? { ...option, question: question.question ?? question.text, choices: question.choices,
          request_kind: question.kind, answer_format: question.answer_format, plain_text: question.plain_text } : option;
      }) : [] };
  }

  sharing(args, actor, space, context) {
    if (!args.sharing) {
      if (space.kind !== actor.kind || space.id !== actor.id) reject('private_session_scope', 'A private Session uses the caller’s private space', 403);
      return null;
    }
    if (!args.space || space.kind !== 'room' || !Array.isArray(args.resource_refs) || !this.platform.canReadSpace(actor, space, context)) {
      reject('invalid_sharing', 'Explicit sharing requires an accessible Room and resource_refs');
    }
    const members = this.platform.roomMembers(space.id);
    return Object.fromEntries(Object.entries(args.sharing).map(([key, values]) => [key, values.map(value => {
      if (value?.kind === 'room_members') {
        if (value.id !== space.id) reject('invalid_sharing', 'Membership grant belongs to a different Room');
        return { kind: 'room_members', id: value.id };
      }
      const principal = identity(value);
      if (!members.includes(principal.id)) reject('invalid_sharing', 'The sharing principal cannot join this Session', 403);
      return principal;
    })]));
  }

  async open(args, context, call) {
    let input = args.input;
    if (args.include_execution_guide) {
      const text = typeof input === 'string' ? input : input?.text;
      if (typeof text !== 'string' || !text.trim()) reject('invalid_input', 'Provide a text task for the execution guide');
      const guide = await executionGuide({ includeExamples: true });
      const combined = `${text}\n\nSummon Bot ${guide.version} execution onboarding guide\n\n${guide.text}`;
      input = typeof input === 'string' ? combined : { ...input, text: combined };
      this.platform.assertRunAllowed(context);
    }
    const session = this.platform.prepareSession(args, context, call, {
      sharing: (actor, space) => this.sharing(args, actor, space, context),
    });
    const target = { kind: 'session', id: session.id };
    let facts;
    try {
      let started = false;
      const beforeSubmit = () => {
        this.platform.assertCanSubmit(context, this.record(target));
        if (started) return;
        this.checkContinuation(args, context, session.origin_room, session.origin_message_id);
        this.bindSubmission(call.id, session, context);
        started = true;
      };
      const options = { session, call: this.calls.get(call.id), input, beforeSubmit, signal: context.signal };
      const result = session.engine === 'pi' ? await this.platform.runtime.pi.start(options) : await this.platform.connections.open(options);
      facts = this.applyResponse(session, call.id, result);
    } catch (error) {
      this.failedSubmission(session, call.id, error);
      throw error;
    }
    const updated = this.record(target);
    return { ...this.baseView(target, updated, context), status: facts.status, target, call_id: call.id, input_targets: facts.input_targets || [] };
  }

  bindSubmission(callId, session, context) {
    if (!session || session.engine === 'pi') {
      this.calls.bind(callId, { status: 'submitted', pi_writer_pid: process.pid });
      return;
    }
    this.store.transaction(() => {
      this.calls.reserveExternal(callId, this.resources);
      const resource = this.resources.acquire('external', this.platform.resourceSource(context, session), { id: callId });
      this.calls.bind(callId, { lease_id: resource.id });
    });
  }

  pendingPiSubmissions() {
    return this.store.list(callRecords).flatMap(call => {
      if (!call.target || !unconfirmedPiSubmission(call) ||
          (call.tool !== 'open_session' && (!['send_input', 'initialize_connections'].includes(call.tool) || !call.input_id))) return [];
      const target = this.record(call.target);
      if (!target) return [];
      if (call.target.kind === 'session' && target.engine === 'pi' && target.execution_actor?.id) return [{
        call_id: call.id, writer_pid: call.pi_writer_pid, bot_id: target.execution_actor.id,
        session_id: target.id, conversation_id: target.conversation_id || target.id,
      }];
      if (call.target.kind === 'conversation' && target.bot_id) return [{
        call_id: call.id, writer_pid: call.pi_writer_pid, bot_id: target.bot_id, conversation_id: target.id,
      }];
      return [];
    });
  }

  reconcilePiSubmission(submission, outcome, facts) {
    return this.store.transaction(() => {
      const call = this.calls.get(submission.call_id);
      if (!unconfirmedPiSubmission(call)) return true;
      if (outcome === 'unknown') {
        if (!call.result_ref) this.calls.bind(call.id, { status: 'unknown',
          result: { status: 'unknown', code: 'pi_submission_unconfirmed' }, result_ref: { kind: 'call', id: call.id } });
        return false;
      }
      const session = submission.session_id && this.record(call.target);
      if (outcome === 'not_submitted') {
        const receipt = { status: outcome, position: keyOf('pi', call.id, outcome), safe_to_disconnect: true };
        if (session?.latest_call_id === call.id) this.saveFacts(session.id, call.id, receipt);
        this.calls.recordReceipt(call.id, receipt, call.target);
      } else {
        if (call.status === 'unknown') this.calls.bind(call.id, { status: 'submitted', result_ref: null });
        this.applyResponse(session, call.id, { status: 'submitted', ...facts });
      }
      if (call.input_id) this.settleInput(call.input_id, call.id, resultStatus(outcome));
      return true;
    });
  }

  async submit(args, context, call) {
    const { target } = args;
    const record = this.require(target, context, args.kind === 'resume' ? 'control' : 'input');
    if (record.connection_setup && context.actor.kind !== 'user')
      reject('initialization_forbidden', 'Only the host user can submit input to connection initialization', 403);
    if (args.kind === 'resume') return this.resume(args, context, call, record);
    if (args.input === undefined || args.input === null || !args.input_target || args.resume_ref) {
      reject('input_target_required', 'Input and a current typed input target are required');
    }
    this.active(record, args.control_version);
    this.checkSubmitResources(target, record, context);
    if (context.origin?.fast_read_forward) this.calls.bind(call.id, { target });
    if (this.platform.draining && args.kind !== 'reply') reject('updating', 'New execution input is temporarily paused', 503);
    const fresh = async () => {
      const current = this.require(target, context, 'input');
      this.active(current, args.control_version);
      this.checkSubmitResources(target, current, context);
      if (!context.origin?.fast_read_forward && current.origin_room && context.origin?.event_ids?.length) {
        const sources = context.origin.event_ids;
        const room = context.conversation?.space;
        const forwards = room?.kind === 'room' ? this.calls.forwardsFor(context.actor.id, room.id, sources) : new Map();
        for (const id of sources) {
          const receipt = this.store.get('platform-events', id);
          const prior = forwards.get(id) || (receipt?.call_id && this.store.get(callRecords, receipt.call_id));
          if (!unresolvedForward(prior) || !sameRef(prior.target, target)) continue;
          const submitted = prior.input_id && this.store.get(inputRecords, prior.input_id);
          const source = this.store.get('messages', prior.source_event_ids[0]);
          const otherMaterial = sources.some(id => id !== source?.id && id !== current.origin_message_id && this.store.get('messages', id));
          if (!otherMaterial || submitted?.call_id === prior.id && (submitted.input === args.input || source?.content === args.input ||
              args.kind === 'reply' && sameInput(args.input_target, submitted.input_target)))
            reject('call_result_unknown', 'This material already has an unresolved native input. Read the original call and wait for its actual receipt.', 409,
              { call_id: prior.id, target });
        }
      }
      const observation = await this.inspect(target, current);
      const observed = observation.input_targets ?? current.input_targets ?? [];
      this.assertTarget(args, target, observed);
      const requested = args.kind === 'steer' && this.platform.runtime.roomAnswerTarget(context, target);
      if (requested && observed.some(option => option.kinds.includes('reply') && sameInput(option.input_target, requested)))
        reject('native_reply_required', 'This message answers a native request. Read the request and use reply with its real answer format.', 409,
          { target, input_target: requested });
      if (context.origin?.fast_read_forward) {
        const options = forwardInputs(observed, observation.pending_input ?? [], this.platform.connections.get(current.engine));
        if (!options.forwardable.some(option => option.kind === args.kind && sameInput(option.input_target, args.input_target)))
          reject('input_target_expired', 'The execution now requires a different input', 409);
      }
      return current;
    };
    const current = await fresh();
    const inputKey = args.kind === 'reply' ? keyOf(target.kind, target.id, args.input_target.kind, args.input_target.request_id,
      ...inputFields[args.input_target.kind].map(field => args.input_target[field])) : call.id;
    this.store.transaction(() => {
      const existing = this.store.get(inputRecords, inputKey);
      if (existing && !['cancelled', 'not_submitted'].includes(existing.status)) {
        reject('input_already_submitted', 'The native request already has a submitted answer', 409, { call_id: existing.call_id });
      }
      if (target.kind === 'session') this.reserveForwardRecovery(args, context, call, current);
      const sourceIds = target.kind === 'session' ? this.platform.roomWork.inputSources(args, context, current, this.calls.get(call.id)) : [];
      this.store.save(inputRecords, { id: inputKey, target, call_id: call.id, input_target: args.input_target, kind: args.kind,
        submitted_by: context.actor, origin: context.origin, control_version: args.control_version, status: 'prepared', input: args.input });
      this.calls.bind(call.id, { target, input_id: inputKey, material_source_ids: sourceIds,
        execution_actor: record.execution_actor || { kind: 'bot', id: record.bot_id } });
    });
    const beforeSubmit = async () => {
      await fresh();
      this.store.transaction(() => {
        const latest = this.require(target, context, 'input');
        const currentInput = this.store.get(inputRecords, inputKey);
        if (currentInput?.status === 'submitted') return;
        if (currentInput?.status !== 'prepared') reject('input_cancelled', 'The queued input was invalidated', 409);
        this.active(latest, args.control_version);
        this.checkSubmitResources(target, latest, context);
        if (target.kind === 'session') this.platform.roomWork.inputSources(args, context, latest, this.calls.get(call.id));
        this.platform.assertRunAllowed(context, { allowUser: true });
        if (target.kind === 'session' && args.kind === 'next' && !this.platform.isActiveSession(latest)) {
          this.resources.assertCapacity('sessions', this.platform.activeSessions(target.id));
          this.store.save(sessionRecords, { id: target.id, status: 'submitted', latest_call_id: call.id });
        }
        this.bindSubmission(call.id, target.kind === 'session' ? latest : null, context);
        this.store.save(inputRecords, { id: inputKey, status: 'submitted' });
      });
    };
    try {
      const linked = this.calls.get(call.id);
      let input = args.input;
      if (args.kind !== 'reply' && !context.origin?.fast_read_forward && linked.material_source_ids?.length &&
          this.platform.connections.get(current.engine)?.kind === 'codex') {
        const sources = this.platform.roomWork.sourceFacts(linked.material_source_ids);
        const text = typeof input === 'string' ? input : input?.text;
        if (typeof text === 'string') {
          const attributed = JSON.stringify({ instructions: text, room_originals: sources });
          input = typeof input === 'string' ? attributed : { ...input, text: attributed };
        }
      }
      const options = { session: current, conversation: current, call: linked, kind: args.kind,
        input_target: args.input_target, input, beforeSubmit, signal: context.signal };
      const result = target.kind === 'conversation' ? await this.platform.runtime.submitConversation(options)
        : current.engine === 'pi' ? await this.platform.runtime.pi.submit(options) : await this.platform.connections.input(options);
      const facts = this.applyResponse(target.kind === 'session' ? current : null, call.id, result);
      this.settleInput(inputKey, call.id, resultStatus(facts.status));
      return { ...facts, call_id: call.id, target, execution_ref: target };
    } catch (error) {
      this.failedSubmission(target.kind === 'session' ? current : null, call.id, error, inputKey);
      throw error;
    }
  }

  assertTarget(args, target, observed) {
    const options = Array.isArray(observed) ? observed : Object.entries(observed).flatMap(([kind, value]) => value ? [{ input_target: value, kinds: [kind] }] : []);
    const supplied = args.input_target;
    if (args.kind === 'reply' && !supplied.request_id || args.kind === 'next' && supplied.kind !== 'idle_input' ||
        args.kind === 'steer' && supplied.kind === 'idle_input') reject('invalid_input_target', 'The native input target does not match the requested operation');
    const matched = options.some(option => sameInput(option.input_target || option.target || option, supplied) &&
      (option.kinds || option.supports || [option.action || option.input_kind]).includes(args.kind));
    if (!matched) reject('input_target_expired', 'The execution no longer accepts this input target', 409, { target });
  }

  resume(args, context, call, before) {
    if (args.input !== undefined || args.input_target || args.recovery_of || !args.resume_ref) reject('invalid_resume', 'Resume requires only the current stop reference');
    const { target } = args;
    const record = this.store.transaction(() => {
      const current = this.require(target, context, 'control');
      assertRevision(current.control.control_version, args.control_version, 'control_version');
      assertResume(context.actor, target, current.control, args.resume_ref, before.owner);
      const session = target.kind === 'session' ? current : current.session_id && this.record({ kind: 'session', id: current.session_id });
      if (session) this.platform.assertSessionAuthority(session);
      const saved = this.saveControl(target, { ...current.control, state: 'active', control_version: current.control.control_version + 1 });
      this.calls.bind(call.id, { target });
      return saved;
    });
    if (target.kind === 'conversation') this.platform.runtime.controlChanged(record);
    this.platform.runtime.wake();
    return this.baseView(target, record, context);
  }

  notifyOwnerResume(target, call) {
    const work = target.kind === 'session' && this.record(target);
    if (!work?.owner_run_id || work.acceptance_state !== 'open' || call.origin?.conversation_id === work.owner_conversation_id) return;
    const owner = this.record({ kind: 'conversation', id: work.owner_conversation_id });
    if (!owner || owner.bot_id !== work.owner.id) return;
    const wait = this.calls.addWait(call.id, { bot_id: owner.bot_id, conversation_id: owner.id, run_id: work.owner_run_id,
      session_id: owner.session_id, control_version: owner.control.control_version });
    const event = this.calls.saveReceiptEvent(call, { status: 'completed', output: { action: 'resumed', control: work.control } }, target, 'resumed');
    this.calls.deliverWaits(event, [wait], false);
  }

  restorePiAuthority(work, args, context, call) {
    const observed = args.restore_pi_authority;
    if (context.actor.kind !== 'user') reject('host_required', 'Only the host can renew the original Pi authority', 403);
    assertRevision(work.control.control_version, observed.control_version, 'control_version');
    if (!work.authority_revoked || work.engine !== 'pi' || work.acceptance_state !== 'open' ||
        (work.revocation_call_id ?? null) !== (observed.revocation_call_id ?? null) || !this.platform.runtime.piAtRest(work))
      reject('restore_unavailable', 'Select the current revoked, inactive Pi work and its recorded revocation', 409);
    if (!work.origin_room || !this.platform.canReadSpace(work.owner, work.origin_room) ||
        !this.platform.getBot(work.owner.id).enabled || work.control.state !== 'active')
      reject('restore_unavailable', 'The original Room membership, Bot and work controls must be active', 409);
    const owner = this.record({ kind: 'conversation', id: work.owner_conversation_id });
    if (!owner || owner.control.state !== 'active') reject('restore_unavailable', 'The original owner is unavailable or paused', 409);
    if (owner.session_id) {
      const parent = this.record({ kind: 'session', id: owner.session_id });
      if (!parent || parent.control.state !== 'active' || parent.acceptance_state !== 'open')
        reject('restore_unavailable', 'The direct parent must be active and open', 409);
      this.platform.assertSessionAuthority(parent, { checkWorkspacePath: true });
    }
    this.platform.assertSessionAuthority({ ...work, authority_revoked: false }, { checkWorkspacePath: true });
    let retained;
    if (args.delivery_message_id) {
      const id = idOf(args.delivery_message_id, 'event');
      const sent = work.pending_delivery && this.originalReplies(work).find(item => item.message.id === id && item.stage !== 'progress');
      if (!sent || !args.disposition_note?.trim())
        reject('confirmed_delivery_required', 'Select the confirmed complete original-room reply and explain its coverage', 409);
      retained = { message_id: id, call_id: sent.message.callId, note: args.disposition_note.trim(), claimed_by: context.actor };
    }
    const saved = this.store.save(sessionRecords, { id: work.id, authority_revoked: false,
      ...(retained && { retained_delivery: retained }),
      authority_restore_call_id: call.id, control: { ...work.control, control_version: work.control.control_version + 1 } });
    this.calls.bind(call.id, { target: { kind: 'session', id: work.id } });
    return this.baseView({ kind: 'session', id: work.id }, saved, context);
  }

  hostReview(work, args, context, call) {
    const receipt = idOf(args.host_review_receipt, 'event');
    const result = this.store.get(callRecords, work.latest_call_id)?.result_ref;
    const parent = work.origin_execution?.kind === 'session' && this.record(work.origin_execution);
    const unavailable = parent || work;
    if (context.actor.kind !== 'user') reject('host_required', 'Only the host may claim an unavailable parent’s review', 403);
    if (args.acceptance_state !== 'closed' || !args.disposition_note?.trim() || result?.kind !== 'event' || result.id !== receipt ||
        unavailable.engine !== 'pi' || !unavailable.authority_revoked || !this.platform.runtime.piAtRest(unavailable))
      reject('host_review_unavailable', 'Claim the latest receipt with a reason only when the original Pi is revoked and inactive', 409);
    return { receipt_id: receipt, call_id: call.id, reviewer: context.actor, direct_parent: work.origin_execution, note: args.disposition_note.trim() };
  }

  configure(args, context, call) {
    const target = { kind: 'session', id: idOf(args.target, 'session') };
    const current = this.require(target, context, 'control');
    if (context.actor.kind !== 'user' && current.origin_execution && !sameRef(current.origin_execution, context.session
      ? { kind: 'session', id: context.session.id } : { kind: 'conversation', id: context.conversation?.id })) {
      reject('session_owner_required', 'Manage this work from its direct parent conversation', 403);
    }
    const patch = { id: current.id };
    if (args.restore_pi_authority) {
      if (Object.keys(args).some(key => !['target', 'restore_pi_authority', 'delivery_message_id', 'disposition_note'].includes(key)))
        reject('invalid_restore', 'Renew the original authority in a separate operation');
      return this.restorePiAuthority(current, args, context, call);
    }
    const hostReview = args.host_review_receipt && this.hostReview(current, args, context, call);
    if (args.acceptance_state !== undefined) patch.acceptance_state = args.acceptance_state;
    if (args.acceptance_state === 'closed' && current.acceptance_state !== 'closed') {
      patch.acceptance = { ...this.acceptance(current, args, context, hostReview), reviewer: context.actor,
        direct_parent: current.origin_execution, ...(hostReview && { host_review: hostReview }) };
      if (hostReview && current.authority_revoked && current.engine === 'pi' && this.platform.runtime.piAtRest(current)) {
        patch.safe_to_disconnect = true;
        patch.revocation_stop = 'stopped';
      }
      patch.pending_delivery = null;
      patch.acceptance_hold = null;
    } else if (args.acceptance_state === 'open' && current.acceptance_state !== 'open') {
      patch.acceptance = null;
    }
    if (args.work_summary !== undefined) {
      const cleaned = args.work_summary.trim();
      if (!cleaned) reject('invalid_arguments', 'work_summary must be non-empty text');
      patch.work_summary = cleaned;
    }
    if (args.waiting_summary !== undefined) {
      patch.waiting_summary = args.waiting_summary?.trim() || null;
      patch.acceptance_hold = patch.waiting_summary && {
        call_id: current.latest_call_id, result_id: this.store.get(callRecords, current.latest_call_id)?.result_ref?.id };
    }
    if (args.add_followup_rooms !== undefined || args.remove_followup_rooms !== undefined) {
      const next = new Set(Array.isArray(current.allowed_followup_rooms) ? current.allowed_followup_rooms : []);
      for (const roomId of this.platform.roomWork.followupRooms(args.add_followup_rooms, context, current.origin_room)) {
        next.add(roomId);
        this.store.remove('room-intake-withdrawals', keyOf(current.id, roomId));
      }
      for (const roomRef of args.remove_followup_rooms || []) {
        const roomId = idOf(roomRef, 'room');
        if (next.delete(roomId) && roomId !== current.origin_room?.id) {
          const sources = this.store.db.prepare(`SELECT json_extract(data,'$.source_event_ids[0]') AS id FROM records
            WHERE kind='platform-calls' AND json_extract(data,'$.origin.fast_read_forward')=1
            AND json_extract(data,'$.target.id')=? AND json_extract(data,'$.origin.source_room.id')=? ORDER BY rowid DESC LIMIT 8`)
            .all(current.id, roomId);
          this.store.save('room-intake-withdrawals', { id: keyOf(current.id, roomId), bot_id: current.owner.id, room_id: roomId,
            withdrawn_at: new Date().toISOString(), local_message_ids: sources.map(source => source.id) });
        }
      }
      patch.allowed_followup_rooms = [...next];
    }
    const saved = this.store.save(sessionRecords, patch);
    this.calls.bind(call.id, { target });
    return this.baseView(target, saved, context);
  }

  saveControl(target, control) {
    const record = this.store.save(target.kind === 'session' ? sessionRecords : conversationRecords, { id: target.id, control });
    if (target.kind === 'conversation' && !this.store.inTransaction) this.platform.runtime.controlChanged(record);
    if (control.state === 'paused') this.projectStop(target, control);
    return record;
  }

  projectStop(target, control) {
    const call = control.stop_id && this.store.get('platform-calls', control.stop_id);
    if (call?.tool !== 'stop_session' || !call.result?.targets?.some(item => sameRef(item.target, target))) return;
    const targets = call.result.targets.map(item => sameRef(item.target, target) ? { ...item, control } : item);
    const status = targets.every(item => item.control.stop_status === 'stopped') ? 'stopped' : 'stop_requested';
    this.calls.bind(call.id, { result: { ...call.result, status, targets } });
  }

  async stop(args, context, call) {
    const affected = this.store.transaction(() => {
      const record = this.require(args.target, context, 'control');
      assertRevision(record.control.control_version, args.control_version, 'control_version');
      if (record.control.state === 'paused' && !canResume(context.actor, record.control, record.owner)) {
        reject('stop_owned', 'The current pause is controlled by another principal', 409, { control_version: record.control.control_version });
      }
      const selected = [{ target: args.target, record }];
      if (args.scope === 'target_and_owned_calls') {
        for (const child of this.store.list(sessionRecords)) {
          const target = { kind: 'session', id: child.id };
          if (!child.sharing && child.control.state !== 'paused' && sameRef(child.origin_execution, args.target) &&
              this.permission(target, child, context, 'control')) selected.push({ target, record: child });
        }
      }
      const targets = selected.map(item => item.target);
      for (const { target, record: selectedRecord } of selected) {
        const control = { state: 'paused', control_version: selectedRecord.control.control_version + 1, stop_id: call.id,
          requested_by: selectedRecord.control.state === 'paused' ? selectedRecord.control.requested_by : context.actor,
          scope: args.scope || 'target', affected_targets: targets, stop_status: 'pending' };
        this.saveControl(target, control);
        for (const input of this.store.list(inputRecords)) {
          if (input.status === 'prepared' && (sameRef(input.target, target) || target.kind === 'conversation' && input.origin?.conversation_id === target.id)) {
            this.store.save(inputRecords, { id: input.id, status: 'cancelled' });
          }
        }
      }
      this.calls.bind(call.id, { target: args.target, status: 'submitted' });
      this.calls.bind(call.id, { result: { status: 'stop_requested', targets: targets.map(target => ({ target, control: this.record(target).control })) } });
      return selected;
    });

    const results = [];
    for (const item of affected) {
      const { target, record } = item;
      let result;
      try {
        if (target.kind === 'conversation') result = await this.platform.runtime.stopConversation(target.id);
        else if (record.engine === 'pi') result = await this.platform.runtime.pi.stop({ session: record, call });
        else result = await this.platform.connections.stop({ session: record, call });
      } catch { result = { status: 'unknown' }; }
      const stopStatus = result?.stopped === true || result?.status === 'stopped' || result?.status === 'completed' || result?.status === 'idle' ? 'stopped'
        : result?.status === 'unsupported' ? 'unsupported' : result?.status === 'pending' || result?.status === 'stopping' ? 'pending' : 'unknown';
      const latest = this.record(target);
      const control = latest.control.stop_id === call.id && !(latest.control.stop_status === 'stopped' && stopStatus !== 'stopped')
        ? this.saveControl(target, { ...latest.control, stop_status: stopStatus }).control : latest.control;
      results.push({ target, control, resume_ref: canResume(context.actor, control, record.owner) ? resumeReference(target, control) : null });
    }
    const targets = results.map(item => {
      const control = this.record(item.target).control;
      return control.stop_id === call.id ? { ...item, control } : item;
    });
    const status = targets.every(item => item.control.stop_status === 'stopped') ? 'stopped' : 'stop_requested';
    return this.calls.finish(call.id, 'completed', { status, targets });
  }

  confirmInput(call, confirmed) {
    if (typeof confirmed?.operation_call_id !== 'string' || !confirmed.operation_call_id || !call.input_id ||
        call.tool !== 'send_input' || call.submitted_by?.kind !== 'bot') return;
    const input = this.store.get(inputRecords, call.input_id);
    const origin = call.origin;
    if (!input || input.call_id !== call.id || !sameIdentity(input.submitted_by, call.submitted_by) || !sameRef(input.target, call.target) ||
        !['steer', 'reply'].includes(input.kind) || ['prepared', 'cancelled', 'not_submitted'].includes(input.status) ||
        !sameInput(input.input_target, confirmed.input_target) || !origin?.run_id || !origin.conversation_id || origin.bot_id !== call.submitted_by.id ||
        origin.conversation_id !== input.origin?.conversation_id || origin.run_id !== input.origin.run_id ||
        origin.control_version !== input.origin.control_version || input.confirmed_operation_call_id) return;
    if (input.input_target.kind === 'pi_run' && input.input_target.run_id === origin.run_id) return;

    const operation = this.store.get(callRecords, confirmed.operation_call_id);
    if (!operation || operation.id === call.id || operation.status === 'prepared' ||
        !this.sameOperationTarget(operation.target, call.target, input.input_target.kind === 'pi_run') ||
        !matchesOperation(operation, input.input_target)) return;
    if (operation.tool !== 'open_session') {
      const start = operation.input_id && this.store.get(inputRecords, operation.input_id);
      if (operation.tool !== 'send_input' || start?.kind !== 'next' || start.call_id !== operation.id ||
          !sameRef(start.target, operation.target)) return;
    }
    if (operation.origin?.run_id === origin.run_id && operation.origin.conversation_id === origin.conversation_id) return;

    this.calls.addWait(operation.id, { ...origin, input_call_id: call.id, initiating_principal: call.initiating_principal });
    this.store.save(inputRecords, { id: input.id, confirmed_operation_call_id: operation.id });
  }

  applyResponse(session, callId, result) {
    if (typeof result?.status !== 'string') throw new Error('Execution adapter did not return its actual status');
    const { confirmed_input, ...facts } = result;
    this.store.transaction(() => {
      const call = this.calls.get(callId);
      this.confirmInput(call, confirmed_input);
      if (call.result_ref?.kind === 'event') return;
      if (session) this.saveFacts(session.id, callId, facts);
      if (facts.status === 'unknown' && call.status === 'submitted') {
        this.calls.recordReceipt(callId, { ...facts, position: keyOf('submission', callId, 'unknown') }, call.target);
        if (call.lease_id && facts.safe_to_disconnect === true) this.resources.finish(call.lease_id, { outcome: 'unknown' });
        return;
      }
      if (terminal.has(facts.status)) {
        this.calls.bind(callId, { safe_to_disconnect: facts.safe_to_disconnect });
        if (call.origin?.fast_read_forward) this.calls.recordReceipt(callId, { ...facts, position: 'inline' }, call.target);
        else this.calls.finish(callId, facts.status, facts);
        this.platform.noteConnectionFailure(session, call, facts);
        if (call.lease_id) this.resources.finish(call.lease_id, { outcome: facts.status });
      } else {
        if (call.status === 'prepared') throw new Error('Adapter accepted an execution before saving the submission');
        this.calls.bind(callId, { result: facts, result_ref: { kind: 'call', id: callId } });
      }
    });
    return facts;
  }

  failedSubmission(session, callId, error, inputId) {
    this.store.transaction(() => {
      const call = this.calls.get(callId);
      if (call.result_ref?.kind === 'event' && terminal.has(call.status)) return;
      const known = call.status === 'prepared' || error.beforeSubmit === true;
      const status = known ? 'failed' : 'unknown';
      const current = session && call.target && this.record(call.target);
      if (current?.latest_call_id === callId && call.result_ref?.kind !== 'event')
        this.saveFacts(session.id, callId, { status, safe_to_disconnect: known });
      if (known) {
        this.calls.bind(callId, { status: 'prepared', ...(call.result_ref?.kind !== 'event' && { submission_outcome: 'not_submitted' }) });
        this.calls.fail(callId, error);
        if (call.result_ref?.kind !== 'event') this.platform.noteConnectionFailure(current, call, { status, code: error.code });
        if (current?.group_work && current.engine !== 'pi' && !this.store.get(operationRecords, callId))
          this.platform.roomWork.publish(current.id, callId, ['status', 'not_submitted'], { phase: 'execution',
            status: 'not_submitted', code: error.code, text: error.message?.slice(0, 2000) });
        if (inputId && ['prepared', 'submitted'].includes(this.store.get(inputRecords, inputId)?.status))
          this.settleInput(inputId, callId, 'not_submitted');
      } else if (call.status === 'submitted') {
        this.calls.recordReceipt(callId, { status: 'unknown', position: keyOf('submission', callId, 'unknown'), output: errorResult(error) }, call.target);
      }
      if (call.lease_id && known) this.resources.finish(call.lease_id, { outcome: status });
    });
  }

  saveFacts(sessionId, callId, facts) {
    const session = this.record({ kind: 'session', id: sessionId });
    if (!session) return;
    if (Number.isSafeInteger(facts.input_revision) && facts.input_revision < session.input_revision) return session;
    const status = facts.session_status || facts.status;
    const ended = settledStop(status, session.engine === 'pi' || facts.safe_to_disconnect === true);
    const stop_status = ended ? 'stopped' : status === 'unknown' && session.control.stop_status === 'pending' ? 'unknown' : session.control.stop_status;
    const control = session.control.state === 'paused' ? { ...session.control, stop_status } : session.control;
    const call = this.calls.get(callId);
    const pendingInput = facts.input_targets !== undefined || facts.pending_input !== undefined
      ? compactPendingInput(facts.pending_input) : session.pending_input || [];
    const preview = outputPreview(facts.output);
    let waitingSummary = session.waiting_summary ?? null;
    if (pendingInput.length) {
      waitingSummary = compactText(pendingInput.map(item => item.question || item.kind || '等待输入').join('；'), 240);
    } else if (['waiting', 'needs_input', 'awaiting_input', 'completed', 'idle'].includes(status) && preview && !facts.input_status) {
      waitingSummary = preview;
    } else if (facts.input_targets !== undefined && !facts.input_status) {
      waitingSummary = null;
    }
    const updated = this.store.save(sessionRecords, { id: sessionId, status, control, submitted_by: call.submitted_by,
      native: facts.native ? { ...session.native, ...facts.native } : session.native, input_targets: facts.input_targets ?? session.input_targets,
      pending_input: pendingInput,
      waiting_summary: waitingSummary,
      ...(preview && !facts.input_status ? { last_output_summary: preview } : {}),
      safe_to_disconnect: facts.safe_to_disconnect,
      ...(session.authority_revoked && ended ? { revocation_stop: 'stopped' } : {}),
      input_revision: facts.input_revision ?? session.input_revision, latest_call_id: callId });
    if (control.stop_status !== session.control.stop_status) this.projectStop({ kind: 'session', id: sessionId }, control);
    return updated;
  }

  receipt(sessionId, callId, { confirmed_input, ...facts }) {
    return this.store.transaction(() => {
      const call = this.calls.get(callId);
      const target = call.target;
      const source = sessionId ? { kind: 'session', id: sessionId } : target;
      if (!this.sameOperationTarget(source, target, Boolean(facts.native?.run_id))) {
        reject('call_target_conflict', 'Execution result belongs to another call target', 409);
      }
      this.confirmInput(call, confirmed_input);
      const eventId = keyOf('call', callId, facts.position ?? facts.id);
      const existing = this.store.get('platform-events', eventId);
      if (existing) return existing;
      if (call.status === 'not_submitted') return this.calls.saveReceiptEvent(call, facts, target, facts.position ?? facts.id);
      if (call.status === 'stopped') {
        const owner = facts.native?.run_id && this.record(source);
        const conversation = owner?.engine === 'pi' && this.record({ kind: 'conversation', id: owner.conversation_id || owner.id });
        const resumedPi = owner && (source.kind === 'conversation' || owner.engine === 'pi') &&
          [owner, conversation].filter(Boolean).some(item => item.control.state === 'active' && item.control.stop_id && item.control.stop_status === 'stopped') &&
          owner.acceptance_state !== 'closed' && facts.status === 'completed' && facts.native.run_id === call.result?.native?.run_id;
        if (!resumedPi) return this.calls.saveReceiptEvent(call, facts, target, facts.position ?? facts.id);
      }
      const advances = mayAdvanceReceipt(call, facts.status);
      const session = advances && target?.kind === 'session' ? this.saveFacts(target.id, callId, facts) : null;
      const event = this.calls.recordReceipt(callId, facts, target);
      if (!advances) return event;
      this.platform.noteConnectionFailure(session, call, facts);
      if (call.input_id) this.settleInput(call.input_id, callId, resultStatus(facts.status));
      if (call.lease_id && (terminal.has(facts.status) && (facts.status !== 'unknown' || facts.safe_to_disconnect === true) ||
          ['needs_input', 'awaiting_input'].includes(facts.status))) {
        this.resources.finish(call.lease_id, { outcome: facts.status });
      }
      return event;
    });
  }

  settleInput(id, callId, status) {
    const existing = this.store.get(inputRecords, id);
    if (existing?.call_id === callId && !['cancelled', 'not_submitted'].includes(existing.status) &&
        !(terminal.has(existing.status) && existing.status !== 'unknown' && (!terminal.has(status) || status === 'unknown'))) {
      this.store.save(inputRecords, { id, status });
    }
  }
}

function resultStatus(status) { return terminal.has(status) ? status : 'submitted'; }
