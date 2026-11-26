import { activeControl } from '../bot-management/service.mjs';
import { modelError } from '../../bot/src/agent/connections.mjs';
import { idOf, keyOf, reject, sameIdentity, sameRef } from './contract.mjs';
import { callRecords, errorResult, mayAdvanceReceipt } from './calls.mjs';
import { operationRecords } from '../services/exec-runner.mjs';

export const sessionRecords = 'platform-sessions';
export const conversationRecords = 'platform-conversations';
const terminal = new Set(['completed', 'failed', 'stopped', 'unknown', 'unsupported', 'idle', 'cancelled', 'not_submitted']);
const settledStop = (status, safe) => status === 'idle' || ['completed', 'failed', 'stopped', 'not_submitted'].includes(status) && safe === true;

function compactPendingInput(pending) {
  if (!Array.isArray(pending) || !pending.length) return [];
  return pending.map(item => ({
    id: item.id,
    kind: item.kind || 'question',
    plain_text: item.plain_text,
    question: item.question ?? item.text ?? item.prompt ?? '',
    ...(Array.isArray(item.choices) && item.choices.length
      ? { choices: item.choices.map(c => ({ id: c.id, label: c.label ?? c.id })) }
      : {}),
  }));
}

function extractSessionError(facts, status) {
  const failed = ['failed', 'unknown', 'unsupported'].includes(status);
  const exitCode = Number.isInteger(facts.exit_code) ? facts.exit_code
    : Number.isInteger(facts.native?.exit_code) ? facts.native.exit_code
    : Number.isInteger(facts.output?.exit_code) ? facts.output.exit_code : null;
  const rawMsg = facts.error
    || (typeof facts.output?.error === 'string' ? facts.output.error : null)
    || (failed && typeof facts.output?.stderr === 'string' ? facts.output.stderr : null)
    || (failed && typeof facts.output?.text === 'string' ? facts.output.text : null)
    || (failed && typeof facts.output === 'string' ? facts.output : null);
  const code = facts.code || (typeof facts.output?.code === 'string' ? facts.output.code : null);
  if (!failed && !rawMsg && !code) return null;
  const message = rawMsg ? modelError(rawMsg) : (exitCode != null ? `退出码 ${exitCode}` : code || `执行状态：${status}`);
  return {
    code: code || (exitCode != null ? `exit_${exitCode}` : status === 'unknown' ? 'execution_unknown' : 'execution_failed'),
    message,
    ...(exitCode != null ? { exit_code: exitCode } : {}),
  };
}

function unconfirmedPiSubmission(call) {
  if (call.status === 'submitted') return !call.result_ref;
  if (call.status !== 'unknown') return false;
  return call.result?.code === 'pi_submission_unconfirmed' ||
    call.result_ref?.id === keyOf('call', call.id, keyOf('submission', call.id, 'unknown'));
}

export class Executions {
  constructor({ store, platform, calls, resources }) {
    Object.assign(this, { store, platform, calls, resources });
  }

  record(target) {
    return this.store.get(target.kind === 'session' ? sessionRecords : conversationRecords, target.id);
  }

  activeRoomSessions(botId, roomId) {
    return this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-sessions'
      AND json_extract(data,'$.owner.id')=? AND json_extract(data,'$.origin_room.id')=?
      AND json_extract(data,'$.origin_execution.kind')='conversation'`)
      .all(botId, roomId)
      .map(row => JSON.parse(row.data))
      .filter(s => !s.authority_revoked && s.control?.state === 'active' && !terminal.has(s.status));
  }

  directWork(conversationId) {
    return this.store.db.prepare(`SELECT data FROM records WHERE kind='platform-sessions'
      AND json_extract(data,'$.owner_conversation_id')=?`).all(conversationId).map(row => JSON.parse(row.data));
  }

  openChildren(sessionId) {
    const session = this.record({ kind: 'session', id: sessionId });
    if (!session) return [];
    return this.directWork(session.conversation_id || session.id).filter(child =>
      !child.authority_revoked && !terminal.has(child.status) && sameRef(child.origin_execution, { kind: 'session', id: session.id }));
  }

  descendantSessions(sessionId) {
    const byParent = new Map();
    for (const item of this.store.list(sessionRecords)) {
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

  retainRoomResults(roomId) {
    for (const session of this.store.list(sessionRecords)) {
      if (session.origin_room?.id !== roomId || session.origin_execution?.kind !== 'conversation') continue;
      if (this.platform.isActiveSession(session)) continue;
      const call = session.latest_call_id && this.store.get(callRecords, session.latest_call_id);
      if (!call || !terminal.has(call.status) || call.status === 'unknown') continue;
      const receiptEvent = call.result_ref?.kind === 'event' ? this.store.get('platform-events', call.result_ref.id) : null;
      const receipt = receiptEvent && terminal.has(receiptEvent.status) && receiptEvent.status !== 'unknown'
        ? call.result_ref : { kind: 'call', id: call.id };
      this.platform.deliverResultToHost?.({ reason: 'origin_room_deleted', session, callId: call.id, status: call.status, receipt });
    }
  }

  retainUndelivered(event, botId) {
    if (!terminal.has(event.status) || event.status === 'unknown') return;
    const target = event.target ?? this.store.get(callRecords, event.call_id)?.target;
    const session = target?.kind === 'session' && this.record(target);
    if (!session?.origin_room || session.origin_execution?.kind !== 'conversation' || session.owner?.id !== botId) return;
    if (this.platform.canReadSpace(session.owner, session.origin_room)) return;
    this.platform.deliverResultToHost?.({
      reason: 'origin_room_unavailable', session, callId: event.call_id, status: event.status, receipt: { kind: 'event', id: event.id },
    });
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
    return this.store.save(conversationRecords, {
      id: record.id, kind: record.kind, bot_id: record.bot_id, space: record.space ?? actor,
      owner: record.owner ?? actor, session_id: record.session_id ?? null,
      control: activeControl(), input_revision: record.input_revision ?? 0,
    });
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

  require(target, context) {
    const record = this.record(target);
    if (!this.permission(target, record, context)) reject('execution_not_found', 'Execution is unavailable', 404);
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
        sameRef(record.origin_room, scope) || scope.kind === 'bot' && record.bot_id === scope.id) &&
        this.permission({ kind, id: record.id }, record, context)).map(record => this.baseView({ kind, id: record.id }, record, context)));
  }

  baseView(target, record, context, observation) {
    const controlled = this.permission(target, record, context);
    const { control } = record;
    const conversation = target.kind === 'conversation';
    const facts = conversation ? observation ?? this.platform.runtime.conversationSummary(record.id) : observation;
    const status = facts?.status || (conversation ? 'unknown' : record.status ?? 'idle');
    const error = conversation ? facts?.last_error : (facts?.last_error || record.last_error || null);
    const liveProgress = conversation
      ? (this.platform.runtime?.conversationLiveProgress?.(record.id) || null)
      : (record.live_progress || null);
    const canSubmit = controlled && !record.authority_revoked && control.state === 'active';
    const rawPending = !conversation ? (observation?.pending_input ?? record.pending_input ?? []) : [];
    const pendingRequests = !conversation && canSubmit
      ? rawPending.map(req => ({
          request_id: req.id,
          kind: req.kind || 'question',
          question: req.question ?? req.text ?? '',
          choices: req.choices ?? [],
          plain_text: req.plain_text,
        }))
      : [];
    const originRoomReadable = Boolean(!conversation && record.origin_room && this.platform.canReadSpace(context.actor, record.origin_room, context));
    const originRoomName = originRoomReadable ? this.store.get('rooms', record.origin_room.id)?.name || null : null;
    const convRoomName = conversation && record.space?.kind === 'room' && this.platform.canReadSpace(context.actor, record.space, context)
      ? this.store.get('rooms', record.space.id)?.name || null
      : null;
    const sessionMeta = !conversation ? {
      ...(originRoomReadable ? { origin_room: record.origin_room } : {}),
      ...(originRoomName ? { origin_room_name: originRoomName } : {}),
      ...(record.origin_message_id ? { origin_message_id: record.origin_message_id } : {}),
      ...(record.owner_conversation_id ? { owner_conversation_id: record.owner_conversation_id } : {}),
      ...(record.work_summary ? { work_summary: record.work_summary } : {}),
      ...(record.created_at || record.createdAt ? { created_at: record.created_at || record.createdAt } : {}),
      ...(record.updated_at || record.updatedAt ? { updated_at: record.updated_at || record.updatedAt } : {}),
      ...(record.host_fallback_delivered_at ? { host_fallback_delivered_at: record.host_fallback_delivered_at } : {}),
    } : {
      ...(convRoomName ? { room_name: convRoomName } : {}),
    };
    return {
      kind: target.kind, id: record.id, execution_ref: target, bot_id: record.bot_id, space: record.space, engine: record.engine,
      source_space: record.source_space && this.platform.canReadSpace(context.actor, record.source_space, context) ? record.source_space : undefined,
      model: record.model, execution_actor: record.execution_actor, submitted_by: record.submitted_by, latest_call_id: record.latest_call_id,
      status, ...(liveProgress ? { live_progress: liveProgress } : {}),
      ...(error?.message || error?.code ? { last_error: { code: error.code || 'execution_failed', message: error.message || '', ...(error.exit_code != null ? { exit_code: error.exit_code } : {}) } } : {}),
      ...sessionMeta,
      ...(pendingRequests.length ? { pending_requests: pendingRequests } : {}),
      can_steer: canSubmit && Boolean(observation?.can_steer ?? record.can_steer),
      can_continue: canSubmit && Boolean(observation?.can_continue ?? record.can_continue),
      control, control_version: control.control_version, input_revision: record.input_revision,
      can_stop: controlled, can_submit: canSubmit,
    };
  }

  async inspect(target, record, options = {}) {
    if (target.kind === 'conversation') return this.platform.runtime.inspectConversation(record.id, options);
    if (record.engine === 'pi') return this.platform.runtime.pi.inspect(record, options);
    return await this.platform.exec.inspect(record, options) ?? {};
  }

  async read(target, context, args = {}) {
    const record = this.require(target, context);
    const observation = await this.inspect(target, record, { cursor: args.cursor, limit: args.limit, modelPage: context.actor.kind === 'bot' });
    const current = this.require(target, context);
    const safe = observation.safe_to_disconnect;
    if (target.kind === 'session' && current.control.state === 'paused' && current.control.stop_status !== 'stopped' &&
        current.latest_call_id === record.latest_call_id &&
        settledStop(observation.session_status || observation.status, current.engine === 'pi' || safe === true)) {
      current.control = this.saveControl(target, { ...current.control, stop_status: 'stopped' }).control;
    }
    const base = this.baseView(target, current, context, observation);
    if (target.kind === 'session' && base.can_submit) {
      try { this.platform.assertSessionAuthority(current); }
      catch (error) {
        base.can_submit = false;
        base.last_error = { code: error.code || 'session_authority_revoked', message: 'Session authority was revoked' };
      }
    }
    const output = observation.output !== undefined && observation.output !== observation.output_page?.text ? observation.output : undefined;
    const view = { ...observation, ...base, input_revision: observation.input_revision ?? base.input_revision };
    if (output !== undefined) view.output = output;
    else delete view.output;
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
      let execInput = args.input;
      if (session.work_engine) {
        const raw = args.input;
        const payload = typeof raw === 'string'
          ? { text: raw }
          : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { text: String(raw ?? '') });
        execInput = {
          engine: session.work_engine.id,
          payload,
        };
      }
      const options = { session, call: this.calls.get(call.id), input: execInput, beforeSubmit, signal: context.signal };
      const result = session.engine === 'pi' ? await this.platform.runtime.pi.start(options) : await this.platform.exec.open(options);
      facts = this.applyResponse(session, call.id, result);
    } catch (error) {
      this.failedSubmission(session, call.id, error);
      throw error;
    }
    const updated = this.record(target);
    return { ...this.baseView(target, updated, context), status: facts.status, target, call_id: call.id };
  }

  bindSubmission(callId, session, context) {
    if (!session || session.engine === 'pi') {
      this.calls.bind(callId, { status: 'submitted', pi_writer_pid: process.pid });
      return;
    }
    this.store.transaction(() => {
      this.calls.reserveExternal(callId);
      const resource = this.resources.acquire('external', this.platform.resourceSource(context, session), { id: callId });
      this.calls.bind(callId, { lease_id: resource.id });
    });
  }

  pendingPiSubmissions() {
    return this.store.list(callRecords).flatMap(call => {
      if (!call.target || !unconfirmedPiSubmission(call) || !['open_session', 'send_input'].includes(call.tool)) return [];
      const target = this.record(call.target);
      if (!target) return [];
      if (call.target.kind === 'session' && target.engine === 'pi' && target.execution_actor?.id) {
        return [{ call_id: call.id, writer_pid: call.pi_writer_pid, bot_id: target.execution_actor.id, session_id: target.id, conversation_id: target.conversation_id || target.id }];
      }
      if (call.target.kind === 'conversation' && target.bot_id) {
        return [{ call_id: call.id, writer_pid: call.pi_writer_pid, bot_id: target.bot_id, conversation_id: target.id }];
      }
      return [];
    });
  }

  reconcilePiSubmission(submission, outcome, facts) {
    return this.store.transaction(() => {
      const call = this.calls.get(submission.call_id);
      if (!unconfirmedPiSubmission(call)) return true;
      if (outcome === 'unknown') {
        if (!call.result_ref) this.calls.bind(call.id, { status: 'unknown', result: { status: 'unknown', code: 'pi_submission_unconfirmed' }, result_ref: { kind: 'call', id: call.id } });
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
      return true;
    });
  }

  async submit(args, context, call) {
    const { target, kind, input, request_id } = args;
    const current = this.require(target, context);
    if (input === undefined || input === null) reject('invalid_input', 'Input is required');
    this.active(current);
    this.checkSubmitResources(target, current, context);
    if (this.platform.draining && kind !== 'reply') reject('updating', 'New execution input is temporarily paused', 503);
    this.calls.bind(call.id, { target, execution_actor: current.execution_actor || { kind: 'bot', id: current.bot_id } });

    const beforeSubmit = () => {
      this.store.transaction(() => {
        const latest = this.require(target, context);
        this.active(latest);
        this.checkSubmitResources(target, latest, context);
        this.platform.assertRunAllowed(context, { allowUser: true });
        if (target.kind === 'session' && kind === 'next' && !this.platform.isActiveSession(latest)) {
          this.store.save(sessionRecords, { id: target.id, status: 'submitted', latest_call_id: call.id });
        }
        this.bindSubmission(call.id, target.kind === 'session' ? latest : null, context);
      });
    };

    try {
      const options = { session: current, conversation: current, call: this.calls.get(call.id), kind, input, request_id, beforeSubmit, signal: context.signal };
      const result = target.kind === 'conversation'
        ? await this.platform.runtime.submitConversation(options)
        : current.engine === 'pi'
          ? await this.platform.runtime.pi.submit(options)
          : await this.platform.exec.input(options);
      const facts = this.applyResponse(target.kind === 'session' ? current : null, call.id, result);
      return { ...facts, call_id: call.id, target, execution_ref: target };
    } catch (error) {
      this.failedSubmission(target.kind === 'session' ? current : null, call.id, error);
      throw error;
    }
  }

  configure(args, context, call) {
    const target = { kind: 'session', id: idOf(args.target, 'session') };
    const current = this.require(target, context);
    const patch = { id: current.id };
    if (args.work_summary !== undefined) {
      const cleaned = args.work_summary.trim();
      if (!cleaned) reject('invalid_arguments', 'work_summary must be non-empty text');
      patch.work_summary = cleaned;
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
        if (matchesParent && this.permission(childTarget, child, context)) {
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
      const record = this.require(args.target, context);
      const selected = [{ target: args.target, record }];
      if (args.scope === 'target_and_owned_calls') selected.push(...this.collectOwnedDescendants(args.target, context));
      const targets = selected.map(item => item.target);
      for (const { target, record: selectedRecord } of selected) {
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
      }
      this.calls.bind(call.id, { target: args.target, status: 'submitted', result: { status: 'interrupting', targets: targets.map(t => ({ target: t, control: this.record(t).control })) } });
      return selected;
    });

    const results = [];
    for (const { target, record } of affected) {
      let result;
      try {
        if (target.kind === 'conversation') result = await this.platform.runtime.stopConversation(target.id);
        else if (record.engine === 'pi') result = await this.platform.runtime.pi.stop({ session: record, call });
        else result = await this.platform.exec.stop({ session: record, call });
      } catch { result = { status: 'stopped' }; }
      const stopStatus = 'stopped';
      const latest = this.record(target);
      const control = latest.control.stop_id === call.id
        ? this.saveControl(target, { ...latest.control, state: 'active', stop_status: stopStatus }).control
        : latest.control;
      if (target.kind === 'session' && latest.latest_call_id) {
        const latestCall = this.store.get(callRecords, latest.latest_call_id);
        if (latestCall && !terminal.has(latestCall.status)) {
          this.saveFacts(latest.id, latest.latest_call_id, { status: 'stopped', code: 'interrupted_by_user', safe_to_disconnect: true });
          this.calls.recordReceipt(latest.latest_call_id, {
            position: keyOf('interrupted', call.id, latest.latest_call_id),
            status: 'stopped', session_status: 'stopped', code: 'interrupted_by_user',
            safe_to_disconnect: true, output: { status: 'interrupted_by_user', message: 'Interrupted by user.' },
          }, target);
        }
      }
      results.push({ target, status: stopStatus, control });
    }
    this.platform.runtime?.wake();
    return this.calls.finish(call.id, 'completed', { status: 'stopped', targets: results });
  }

  applyResponse(session, callId, result) {
    if (typeof result?.status !== 'string') throw new Error('Execution runner did not return a status');
    const facts = result;
    this.store.transaction(() => {
      const call = this.calls.get(callId);
      if (call.result_ref?.kind === 'event') return;
      if (session) this.saveFacts(session.id, callId, facts);
      if (facts.status === 'unknown' && call.status === 'submitted') {
        this.calls.recordReceipt(callId, { ...facts, position: keyOf('submission', callId, 'unknown') }, call.target);
        if (call.lease_id && facts.safe_to_disconnect === true) this.resources.finish(call.lease_id, { outcome: 'unknown' });
        return;
      }
      if (terminal.has(facts.status)) {
        this.calls.bind(callId, { safe_to_disconnect: facts.safe_to_disconnect });
        this.calls.finish(callId, facts.status, facts);
        if (call.lease_id) this.resources.finish(call.lease_id, { outcome: facts.status });
      } else {
        this.calls.bind(callId, { result: facts, result_ref: { kind: 'call', id: callId } });
      }
    });
    return facts;
  }

  failedSubmission(session, callId, error) {
    this.store.transaction(() => {
      const call = this.calls.get(callId);
      if (call.result_ref?.kind === 'event' && terminal.has(call.status)) return;
      const known = call.status === 'prepared' || error.beforeSubmit === true;
      const status = known ? 'failed' : 'unknown';
      const current = session && call.target && this.record(call.target);
      if (current?.latest_call_id === callId && call.result_ref?.kind !== 'event') {
        this.saveFacts(session.id, callId, { status, safe_to_disconnect: known, code: error?.code, error: error?.message });
      }
      if (known) {
        this.calls.bind(callId, { status: 'prepared', ...(call.result_ref?.kind !== 'event' && { submission_outcome: 'not_submitted' }) });
        this.calls.fail(callId, error);
        if (current?.group_work && current.engine !== 'pi' && !this.store.get(operationRecords, callId)) {
          this.platform.roomWork.publish(current.id, callId, ['status', 'not_submitted'], { phase: 'execution', status: 'not_submitted', code: error.code, text: error.message?.slice(0, 2000) });
        }
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
    const pendingInput = facts.pending_input !== undefined ? compactPendingInput(facts.pending_input) : (ended ? [] : session.pending_input || []);
    const nextError = extractSessionError(facts, status);
    const clearError = ['completed', 'running', 'submitted', 'idle'].includes(status) && !nextError;
    const updated = this.store.save(sessionRecords, {
      id: sessionId, status, control, submitted_by: call.submitted_by,
      native: facts.native ? { ...session.native, ...facts.native } : session.native,
      pending_input: pendingInput,
      can_steer: facts.can_steer ?? (ended ? false : session.can_steer ?? false),
      can_continue: facts.can_continue ?? session.can_continue ?? false,
      ...(ended ? { live_progress: null } : {}),
      ...(nextError ? { last_error: nextError } : clearError ? { last_error: null } : {}),
      safe_to_disconnect: facts.safe_to_disconnect,
      ...(session.authority_revoked && ended ? { revocation_stop: 'stopped' } : {}),
      updated_at: new Date().toISOString(),
      input_revision: facts.input_revision ?? session.input_revision,
      latest_call_id: callId,
    });
    if (control.stop_status !== session.control.stop_status) this.projectStop({ kind: 'session', id: sessionId }, control);
    return updated;
  }

  receipt(sessionId, callId, facts) {
    return this.store.transaction(() => {
      const call = this.calls.get(callId);
      const target = call.target;
      const source = sessionId ? { kind: 'session', id: sessionId } : target;
      if (!this.sameOperationTarget(source, target, Boolean(facts.native?.run_id))) {
        reject('call_target_conflict', 'Execution result belongs to another call target', 409);
      }
      const eventId = keyOf('call', callId, facts.position ?? facts.id);
      const existing = this.store.get('platform-events', eventId);
      if (existing) return existing;
      if (call.status === 'not_submitted' || call.status === 'stopped') {
        return this.calls.saveReceiptEvent(call, facts, target, facts.position ?? facts.id);
      }
      const advances = mayAdvanceReceipt(call, facts.status);
      const session = advances && target?.kind === 'session' ? this.saveFacts(target.id, callId, facts) : null;
      const event = this.calls.recordReceipt(callId, facts, target);
      if (!advances) return event;
      if (session?.origin_room) this.platform.deliveries.noteRoomActivity(session.origin_room.id, 'tool_progress');
      if (session && terminal.has(facts.status) && facts.status !== 'unknown' && session.origin_room && session.owner?.kind === 'bot') {
        const ownerBot = this.platform.store.get('platform-bots', session.owner.id);
        const roomExists = Boolean(this.platform.store.get('rooms', session.origin_room.id));
        const canReachOrigin = roomExists && ownerBot?.enabled && !ownerBot.archivedAt &&
          this.platform.canReadSpace(session.owner, session.origin_room);
        if (!canReachOrigin) {
          this.platform.deliverResultToHost?.({
            reason: !roomExists ? 'origin_room_deleted' : (!ownerBot?.enabled || ownerBot.archivedAt ? 'owner_bot_paused' : 'origin_room_unavailable'),
            session, callId, status: facts.status, receipt: { kind: 'event', id: event.id },
          });
        }
      }
      if (call.lease_id && (terminal.has(facts.status) || ['needs_input', 'awaiting_input'].includes(facts.status))) {
        this.resources.finish(call.lease_id, { outcome: facts.status });
      }
      return event;
    });
  }
}
