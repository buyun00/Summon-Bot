import { activeControl } from '../bot-management/service.mjs';
import { assertRevision, idOf, identity, keyOf, reject, sameIdentity, sameRef } from './contract.mjs';
import { callRecords, errorResult, mayAdvanceReceipt } from './calls.mjs';
import { allowsConnection, enclosesExecutableScope, executableScope } from '../services/executable-scope.mjs';
import { executionGuide } from '../connectors/initialization.mjs';
import { operationRecords } from '../services/session-processes.mjs';
import { forwardInputs } from './session-work.mjs';

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

  directWork(conversationId) {
    return this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-sessions'
      AND json_extract(data,'$.owner_conversation_id')=?`).all(conversationId).map(row => JSON.parse(row.data));
  }

  openChildren(sessionId) {
    const session = this.record({ kind: 'session', id: sessionId });
    if (!session) return [];
    return this.directWork(session.conversation_id || session.id).filter(child =>
      child.acceptance_state === 'open' && sameRef(child.origin_execution, { kind: 'session', id: session.id }));
  }

  descendantSessions(sessionId) {
    const all = this.store.list(sessionRecords);
    const byParent = new Map();
    for (const item of all) {
      if (item.origin_execution?.kind !== 'session') continue;
      const list = byParent.get(item.origin_execution.id) || [];
      list.push(item);
      byParent.set(item.origin_execution.id, list);
    }
    const result = [];
    const visited = new Set([sessionId]);
    const queue = [sessionId];
    while (queue.length) {
      const currentId = queue.shift();
      for (const child of byParent.get(currentId) || []) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        result.push(child);
        queue.push(child.id);
      }
    }
    return result;
  }

  sessionOrAncestorClosed(session) {
    let cursor = session;
    const visited = new Set();
    while (cursor && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (cursor.acceptance_state === 'closed' || cursor.authority_revoked === true) return true;
      if (cursor.origin_execution?.kind !== 'session') break;
      cursor = this.record(cursor.origin_execution);
    }
    return false;
  }

  isAncestorExecution(session, callerRef) {
    if (!callerRef) return false;
    let cursor = session;
    const visited = new Set();
    while (cursor?.origin_execution && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      if (sameRef(cursor.origin_execution, callerRef)) return true;
      if (cursor.origin_execution.kind !== 'session') break;
      cursor = this.record(cursor.origin_execution);
    }
    return false;
  }

  cascadeCloseDescendants(sessionId) {
    const closed = [];
    for (const child of this.descendantSessions(sessionId)) {
      if (child.acceptance_state !== 'open') continue;
      if (terminal.has(child.status) || child.control?.state === 'paused' || child.safe_to_disconnect === true) {
        const updated = this.store.save(sessionRecords, { id: child.id, acceptance_state: 'closed', pending_delivery: null,
          ...(Array.isArray(child.allowed_followup_rooms) && child.allowed_followup_rooms.length ? { allowed_followup_rooms: [] } : {}) });
        closed.push({ session_id: updated.id, engine: updated.engine, parent_session_id: updated.origin_execution?.id ?? null,
          status: updated.status, acceptance_state: updated.acceptance_state });
      }
    }
    return closed;
  }

  reconcileClosedDescendants() {
    this.store.transaction(() => {
      for (const session of this.store.list(sessionRecords)) {
        if (session.acceptance_state === 'closed') this.cascadeCloseDescendants(session.id);
      }
    });
  }

  retainRoomResults(roomId) {
    for (const session of this.store.list(sessionRecords)) {
      if (session.origin_room?.id !== roomId || session.origin_execution?.kind !== 'conversation' ||
          session.acceptance_state !== 'open' || session.pending_delivery) continue;
      const call = session.latest_call_id && this.store.get(callRecords, session.latest_call_id);
      if (!call || call.result_ref?.kind !== 'event') continue;
      this.store.save(sessionRecords, { id: session.id, pending_delivery: { reason: 'origin_room_deleted',
        origin_room: session.origin_room, origin_message_id: session.origin_message_id, call_id: call.id,
        status: call.status, receipt: call.result_ref } });
    }
  }

  retainUndelivered(event, botId) {
    const target = event.target ?? this.store.get(callRecords, event.call_id)?.target;
    const session = target?.kind === 'session' && this.record(target);
    if (!session?.origin_room || session.origin_execution?.kind !== 'conversation' || session.owner?.id !== botId ||
        this.platform.canReadSpace(session.owner, session.origin_room) || session.pending_delivery?.receipt?.id === event.id) return;
    this.store.save(sessionRecords, { id: session.id, pending_delivery: { reason: 'origin_room_unavailable',
      origin_room: session.origin_room, origin_message_id: session.origin_message_id, call_id: event.call_id,
      status: event.status, receipt: { kind: 'event', id: event.id } } });
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

  permission(target, record, context) {
    if (!record) return false;
    const { actor } = context;
    if (actor.kind === 'user') return true;
    if (target.kind === 'conversation') {
      if (record.bot_id !== actor.id) return false;
      return record.space?.kind !== 'room' || this.platform.roomMembers(record.space.id).includes(actor.id);
    }
    if (record.sharing || record.space?.kind === 'room') {
      return this.platform.roomMembers(record.space.id).includes(actor.id);
    }
    return sameIdentity(record.owner, actor) || sameIdentity(record.execution_actor, actor);
  }

  require(target, context, operation) {
    const record = this.record(target);
    if (!this.permission(target, record, context, operation)) reject('execution_not_found', 'Execution is unavailable', 404);
    return record;
  }

  active(record) {
    if (record.control.state !== 'active') reject('execution_paused', 'Execution is paused', 409, { control_version: record.control.control_version });
  }

  checkSubmitResources(target, record, context) {
    const session = target.kind === 'session' ? record : record.session_id && this.record({ kind: 'session', id: record.session_id });
    if (session) this.platform.assertCanSubmit(context, session);
  }

  list(context, scope) {
    return [{ kind: 'session', records: sessionRecords }, { kind: 'conversation', records: conversationRecords }].flatMap(({ kind, records }) =>
      this.store.list(records).filter(record => (!scope || sameRef(record.space, scope) || sameRef(record.source_space, scope) ||
        scope.kind === 'room' && Array.isArray(record.allowed_followup_rooms) && record.allowed_followup_rooms.includes(scope.id) ||
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
      ...(Array.isArray(record.allowed_followup_rooms) ? { allowed_followup_rooms: record.allowed_followup_rooms } : {}),
    } : {};
    return { kind: target.kind, id: record.id, execution_ref: target, bot_id: record.bot_id, space: record.space, engine: record.engine,
      source_space: record.source_space && this.platform.canReadSpace(context.actor, record.source_space, context) ? record.source_space : undefined,
      model: record.model, execution_actor: record.execution_actor, submitted_by: record.submitted_by, latest_call_id: record.latest_call_id,
      status, ...(error ? { last_error: { code: error.code, message: error.message } } : {}), ...sessionMeta,
      control, control_version: control.control_version, input_revision: record.input_revision,
      can_stop: controlled, can_submit: this.permission(target, record, context, 'input') && !record.authority_revoked };
  }

  async inspect(target, record, options = {}) {
    if (target.kind === 'conversation') return this.platform.runtime.inspectConversation(record.id, options);
    if (record.engine === 'pi') return this.platform.runtime.pi.inspect(record, options);
    return await this.platform.connections.inspect(record, options) ?? {};
  }

  async read(target, context, args = {}) {
    const record = this.require(target, context, 'read');
    const observation = await this.inspect(target, record, { cursor: args.cursor, limit: args.limit, modelPage: context.actor.kind === 'bot' });
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
    const output = observation.output !== undefined && observation.output !== observation.output_page?.text
      ? observation.output
      : undefined;
    const view = { ...observation, ...base, input_revision: observation.input_revision ?? base.input_revision,
      input_targets: base.can_submit && current.control.state === 'active' ? inputTargets.map(option => {
        const question = option.input_target?.request_id && questions.find(item => item.id === option.input_target.request_id);
        return question ? { ...option, question: question.question ?? question.text, choices: question.choices,
          request_kind: question.kind, answer_format: question.answer_format, plain_text: question.plain_text } : option;
      }) : [] };
    if (output !== undefined) view.output = output;
    else delete view.output;
    if (context.actor.kind === 'bot' && typeof view.last_output_summary === 'string' &&
        (view.last_output_summary === view.waiting_summary ||
         view.last_output_summary === view.output ||
         view.last_output_summary === view.output?.text)) {
      delete view.last_output_summary;
    }
    return view;
  }

  sharing(args, actor, space, context) {
    const wantsShared = Boolean(args.sharing) || space?.kind === 'room';
    if (!wantsShared) {
      if (space.kind !== actor.kind || space.id !== actor.id) reject('private_session_scope', 'A private Session uses the caller’s private space', 403);
      return null;
    }
    if (space?.kind !== 'room' || !this.platform.canReadSpace(actor, space, context)) {
      reject('invalid_sharing', 'Shared execution requires an accessible Room as space');
    }
    const all = [{ kind: 'room_members', id: space.id }];
    return { readers: all, submitters: all, controllers: all };
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
    const record = this.require(target, context, 'input');
    if (args.input === undefined || args.input === null) {
      reject('input_target_required', 'Input is required');
    }
    this.active(record);
    this.checkSubmitResources(target, record, context);
    if (context.origin?.fast_read_forward) this.calls.bind(call.id, { target });
    if (this.platform.draining && args.kind !== 'reply') reject('updating', 'New execution input is temporarily paused', 503);
    let resolvedInputTarget = args.input_target || null;
    const fresh = async () => {
      const current = this.require(target, context, 'input');
      this.active(current);
      this.checkSubmitResources(target, current, context);
      const observation = await this.inspect(target, current);
      const observed = observation.input_targets ?? current.input_targets ?? [];
      if (!resolvedInputTarget) {
        const auto = (Array.isArray(observed) ? observed : []).find(option => (option.kinds || option.supports || [option.action || option.input_kind]).includes(args.kind));
        if (auto) resolvedInputTarget = auto.input_target || auto.target || auto;
      }
      if (!resolvedInputTarget) reject('input_target_expired', 'The execution is not currently accepting this input kind', 409, { target, current_input_targets: observed });
      this.assertTarget({ ...args, input_target: resolvedInputTarget }, target, observed);
      return current;
    };
    const current = await fresh();
    const inputKey = args.kind === 'reply' ? keyOf(target.kind, target.id, resolvedInputTarget.kind, resolvedInputTarget.request_id,
      ...inputFields[resolvedInputTarget.kind].map(field => resolvedInputTarget[field])) : call.id;
    this.store.transaction(() => {
      const existing = this.store.get(inputRecords, inputKey);
      const existingCall = existing?.call_id && this.store.get(callRecords, existing.call_id);
      const notSubmitted = existing && (['cancelled', 'not_submitted'].includes(existing.status) ||
        existingCall?.submission_outcome === 'not_submitted' || existingCall?.status === 'not_submitted');
      if (existing && !notSubmitted) {
        reject('input_already_submitted', 'The native request already has a submitted answer', 409, { call_id: existing.call_id });
      }
      this.store.save(inputRecords, { id: inputKey, target, call_id: call.id, input_target: resolvedInputTarget, kind: args.kind,
        submitted_by: context.actor, origin: context.origin, control_version: current.control.control_version, status: 'prepared', input: args.input });
      this.calls.bind(call.id, { target, input_id: inputKey, execution_actor: record.execution_actor || { kind: 'bot', id: record.bot_id } });
    });
    const beforeSubmit = async () => {
      await fresh();
      this.store.transaction(() => {
        const latest = this.require(target, context, 'input');
        const currentInput = this.store.get(inputRecords, inputKey);
        if (currentInput?.status === 'submitted') return;
        if (currentInput?.status !== 'prepared') reject('input_cancelled', 'The queued input was invalidated', 409);
        this.active(latest);
        this.checkSubmitResources(target, latest, context);
        this.platform.assertRunAllowed(context, { allowUser: true });
        if (target.kind === 'session' && args.kind === 'next' && !this.platform.isActiveSession(latest)) {
          this.store.save(sessionRecords, { id: target.id, status: 'submitted', latest_call_id: call.id });
        }
        this.bindSubmission(call.id, target.kind === 'session' ? latest : null, context);
        this.store.save(inputRecords, { id: inputKey, status: 'submitted' });
      });
    };
    try {
      const options = { session: current, conversation: current, call: this.calls.get(call.id), kind: args.kind,
        input_target: resolvedInputTarget, input: args.input, beforeSubmit, signal: context.signal };
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
    if (!matched) reject('input_target_expired', 'The execution no longer accepts this input target', 409, { target, current_input_targets: options });
  }

  configure(args, context, call) {
    const target = { kind: 'session', id: idOf(args.target, 'session') };
    const current = this.require(target, context, 'control');
    const patch = { id: current.id };
    if (args.acceptance_state !== undefined) patch.acceptance_state = args.acceptance_state;
    if (args.acceptance_state === 'closed') {
      if (args.add_followup_rooms?.length) {
        reject('invalid_arguments', 'Cannot add follow-up Rooms while closing a Session');
      }
      patch.pending_delivery = null;
      patch.allowed_followup_rooms = [];
      if (context.actor.kind === 'user' && current.authority_revoked && current.engine === 'pi' && this.platform.runtime.piAtRest(current)) {
        patch.safe_to_disconnect = true;
        patch.revocation_stop = 'stopped';
      }
    }
    if (args.work_summary !== undefined) {
      const cleaned = args.work_summary.trim();
      if (!cleaned) reject('invalid_arguments', 'work_summary must be non-empty text');
      patch.work_summary = cleaned;
    }
    if (args.waiting_summary !== undefined) {
      patch.waiting_summary = args.waiting_summary?.trim() || null;
    }
    if (args.acceptance_state !== 'closed' && (args.add_followup_rooms !== undefined || args.remove_followup_rooms !== undefined)) {
      const next = new Set(Array.isArray(current.allowed_followup_rooms) ? current.allowed_followup_rooms : []);
      for (const roomRef of args.add_followup_rooms || []) {
        const roomId = idOf(roomRef, 'room');
        const room = this.platform.store.get('rooms', roomId);
        if (!room || !this.platform.canReadSpace(context.actor, { kind: 'room', id: roomId }, context)) {
          reject('room_forbidden', 'Cannot open follow-up to an inaccessible Room', 403);
        }
        next.add(roomId);
      }
      for (const roomRef of args.remove_followup_rooms || []) {
        next.delete(idOf(roomRef, 'room'));
      }
      patch.allowed_followup_rooms = [...next];
    }
    const saved = this.store.save(sessionRecords, patch);
    let closedDescendants = [];
    if (args.acceptance_state === 'closed') {
      closedDescendants = this.cascadeCloseDescendants(saved.id);
      this.platform.runtime?.wake();
    }
    this.calls.bind(call.id, { target });
    return { ...this.baseView(target, saved, context), ...(closedDescendants.length ? { closed_descendants: closedDescendants } : {}) };
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

  collectOwnedDescendants(rootTarget, context) {
    const allSessions = this.store.list(sessionRecords);
    const seen = new Set([keyOf(rootTarget.kind, rootTarget.id)]);
    const queue = [rootTarget];
    const selected = [];
    while (queue.length) {
      const parent = queue.shift();
      for (const child of allSessions) {
        if (child.sharing) continue;
        const childTarget = { kind: 'session', id: child.id };
        const k = keyOf(childTarget.kind, childTarget.id);
        if (seen.has(k)) continue;
        const matchesParent = sameRef(child.origin_execution, parent) ||
          (parent.kind === 'session' && child.origin_execution?.kind === 'conversation' && child.origin_execution.id === this.record(parent)?.conversation_id);
        if (matchesParent && this.permission(childTarget, child, context, 'control')) {
          seen.add(k);
          selected.push({ target: childTarget, record: child });
          queue.push(childTarget);
        }
      }
    }
    return selected;
  }

  async stop(args, context, call) {
    const affected = this.store.transaction(() => {
      const record = this.require(args.target, context, 'control');
      const selected = [{ target: args.target, record }];
      if (args.scope === 'target_and_owned_calls') {
        selected.push(...this.collectOwnedDescendants(args.target, context));
      }
      const targets = selected.map(item => item.target);
      for (const { target, record: selectedRecord } of selected) {
        // Interrupt/Cancel keeps the execution active for follow-up input after detaching in-flight work.
        const control = {
          state: 'active',
          control_version: selectedRecord.control.control_version + 1,
          stop_id: call.id,
          requested_by: context.actor,
          scope: args.scope || 'target',
          affected_targets: targets,
          stop_status: 'pending',
          interrupted_at: new Date().toISOString(),
        };
        this.saveControl(target, control);
        for (const input of this.store.list(inputRecords)) {
          if (input.status === 'prepared' && (sameRef(input.target, target) || target.kind === 'conversation' && input.origin?.conversation_id === target.id)) {
            this.store.save(inputRecords, { id: input.id, status: 'cancelled', cancelled_before_dispatch: true });
          }
        }
      }
      this.calls.bind(call.id, { target: args.target, status: 'submitted' });
      this.calls.bind(call.id, { result: { status: 'interrupting', targets: targets.map(target => ({ target, control: this.record(target).control })) } });
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
      } catch { result = { status: 'detached', remote_outcome: 'unknown_may_still_be_running' }; }
      const confirmedStopped = result?.stopped === true || ['stopped', 'completed', 'idle'].includes(result?.status);
      const stopStatus = confirmedStopped ? 'stopped' : 'detached';
      const remoteOutcome = result?.remote_outcome || (confirmedStopped ? 'confirmed_stopped' : 'unknown_may_still_be_running');
      const partialSnapshot = result?.partial_snapshot || null;
      const latest = this.record(target);
      const control = latest.control.stop_id === call.id
        ? this.saveControl(target, { ...latest.control, state: 'active', stop_status: stopStatus, remote_outcome: remoteOutcome }).control
        : latest.control;
      if (target.kind === 'session' && latest.latest_call_id) {
        const latestCall = this.store.get(callRecords, latest.latest_call_id);
        if (latestCall && !terminal.has(latestCall.status)) {
          const message = remoteOutcome === 'confirmed_stopped'
            ? 'Interrupted by user and confirmed stopped.'
            : 'Interrupted by user; detached locally while remote execution outcome is unknown. Check state before retrying side effects.';
          this.saveFacts(latest.id, latest.latest_call_id, {
            status: 'stopped',
            code: 'interrupted_by_user',
            safe_to_disconnect: true,
            last_output_summary: partialSnapshot?.last_progress || message,
          });
          this.calls.recordReceipt(latest.latest_call_id, {
            position: keyOf('interrupted', call.id, latest.latest_call_id),
            status: 'stopped',
            session_status: 'stopped',
            code: 'interrupted_by_user',
            remote_outcome: remoteOutcome,
            partial_snapshot: partialSnapshot,
            safe_to_disconnect: true,
            output: {
              status: 'interrupted_by_user',
              remote_outcome: remoteOutcome,
              ...(partialSnapshot ? { partial_snapshot: partialSnapshot } : {}),
              message,
            },
          }, target);
        }
      }
      results.push({
        target,
        status: stopStatus,
        remote_outcome: remoteOutcome,
        ...(partialSnapshot ? { partial_snapshot: partialSnapshot } : {}),
        control,
      });
    }
    const status = results.every(item => item.status === 'stopped') ? 'stopped' : 'detached';
    this.platform.runtime?.wake();
    return this.calls.finish(call.id, 'completed', { status, targets: results });
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
      if (session && session.acceptance_state === 'open' && session.origin_execution?.kind === 'session') {
        const parent = this.record(session.origin_execution);
        const notSubmittedDead = facts.status === 'not_submitted' && facts.safe_to_disconnect === true &&
          parent && (parent.control?.state === 'paused' || this.sessionOrAncestorClosed(parent));
        const ancestorClosed = terminal.has(facts.status) && facts.status !== 'unknown' && parent && this.sessionOrAncestorClosed(parent);
        if (notSubmittedDead || ancestorClosed) {
          this.store.save(sessionRecords, { id: session.id, acceptance_state: 'closed', pending_delivery: null,
            ...(Array.isArray(session.allowed_followup_rooms) && session.allowed_followup_rooms.length ? { allowed_followup_rooms: [] } : {}) });
        }
      }
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
