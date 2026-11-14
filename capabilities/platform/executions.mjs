import { activeControl, assertResume, canResume, resumeReference } from '../bot-management/service.mjs';
import { assertRevision, identity, keyOf, reject, sameIdentity, sameRef } from './contract.mjs';
import { errorResult } from './calls.mjs';

export const sessionRecords = 'platform-sessions';
export const conversationRecords = 'platform-conversations';
const inputRecords = 'platform-inputs';
const terminal = new Set(['completed', 'failed', 'stopped', 'unknown', 'unsupported', 'idle', 'cancelled', 'not_submitted']);
const inputFields = {
  codex_turn: ['turn_id', 'request_id'], pi_run: ['run_id', 'request_id'], cli_process: ['instance_id', 'launch_call_id', 'request_id'],
  service_call: ['call_id', 'request_id', 'operation_id'], idle_input: ['input_revision'],
};

const settledStop = (status, safe) => status === 'idle' || ['completed', 'failed', 'stopped', 'not_submitted'].includes(status) && safe === true;

function sameInput(a, b) {
  return a?.kind === b?.kind && Boolean(inputFields[a?.kind]?.every(field => a[field] === b[field]));
}

const roomMember = (members, actor) => members.includes(actor.id);
const granted = (values, actor, members, roomId) => values?.some(principal => principal.kind === 'room_members'
  ? principal.id === roomId && roomMember(members, actor) : sameIdentity(principal, actor));

export class Executions {
  constructor({ store, platform, calls, resources }) { Object.assign(this, { store, platform, calls, resources }); }

  record(target) {
    return this.store.get(target.kind === 'session' ? sessionRecords : conversationRecords, target.id);
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
    return this.store.save(conversationRecords, { id: record.id, bot_id: record.bot_id, space: record.space ?? actor,
      owner: record.owner ?? actor, session_id: record.session_id ?? null, workspaceProfileId: this.platform.principalContext(actor).workspaceProfileId,
      control: activeControl(), input_revision: record.input_revision ?? 0 });
  }

  permission(target, record, context, operation = 'read') {
    if (!record) return false;
    const { actor, session } = context;
    const selected = context.workspaceProfileId === undefined ? this.platform.principalContext(actor).workspaceProfileId : context.workspaceProfileId;
    const actual = record.workspaceProfileId ?? this.platform.spaceProfile(record.space, record.owner);
    if (actual !== selected) return false;
    if (session) {
      const current = { kind: 'session', id: session.id };
      const child = target.kind === 'session' && sameRef(record.origin_execution, current);
      if (target.kind === 'session' ? session.id !== target.id && !child : record.session_id !== session.id) return false;
    }
    if (actor.kind === 'user') return true;
    if (target.kind === 'conversation') {
      if (record.bot_id !== actor.id) return false;
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
    return { kind: target.kind, id: record.id, execution_ref: target, bot_id: record.bot_id, space: record.space, engine: record.engine,
      source_space: record.source_space && this.platform.canReadSpace(context.actor, record.source_space, context) ? record.source_space : undefined,
      model: record.model, execution_actor: record.execution_actor, submitted_by: record.submitted_by, latest_call_id: record.latest_call_id,
      status, ...(error ? { last_error: { code: error.code, message: error.message } } : {}),
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
        if (!error.status) throw error;
        base.can_submit = false;
      }
    }
    const inputTargets = observation.input_targets || current.input_targets || [];
    const questions = observation.pending_input || [];
    const output = observation.output ?? (observation.output_page?.text ? observation.output_page.text : undefined);
    return { ...observation, ...base, output, input_revision: observation.input_revision ?? base.input_revision,
      input_targets: base.can_submit && current.control.state === 'active' ? inputTargets.map(option => {
        const question = option.input_target?.request_id && questions.find(item => item.id === option.input_target.request_id);
        return question ? { ...option, question: question.question ?? question.text, choices: question.choices } : option;
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
      const options = { session, call: this.calls.get(call.id), input: args.input, beforeSubmit, signal: context.signal };
      facts = session.engine === 'pi' ? await this.platform.runtime.pi.start(options) : await this.platform.connections.open(options);
      this.applyResponse(session, call.id, facts);
    } catch (error) {
      this.failedSubmission(session, call.id, error);
      throw error;
    }
    const updated = this.record(target);
    return { ...this.baseView(target, updated, context), status: facts.status, target, call_id: call.id, input_targets: facts.input_targets || [] };
  }

  bindSubmission(callId, session, context) {
    this.store.transaction(() => {
      this.calls.reserveExternal(callId, this.resources);
      const resource = session?.engine === 'pi' || !session ? null : this.resources.acquire('external', this.platform.resourceSource(context, session), { id: callId });
      if (resource) this.calls.bind(callId, { lease_id: resource.id });
    });
  }

  async submit(args, context, call) {
    const { target } = args;
    const record = this.require(target, context, args.kind === 'resume' ? 'control' : 'input');
    if (args.kind === 'resume') return this.resume(args, context, call, record);
    if (args.input === undefined || args.input === null || !args.input_target || args.resume_ref) {
      reject('input_target_required', 'Input and a current typed input target are required');
    }
    this.active(record, args.control_version);
    if (target.kind === 'session') this.platform.assertCanSubmit(context, record);
    if (this.platform.draining && args.kind !== 'reply') reject('updating', 'New execution input is temporarily paused', 503);
    const fresh = async () => {
      const current = this.require(target, context, 'input');
      this.active(current, args.control_version);
      if (target.kind === 'session') this.platform.assertCanSubmit(context, current);
      const observation = await this.inspect(target, current);
      const observed = observation.input_targets ?? current.input_targets ?? [];
      this.assertTarget(args, target, observed);
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
      this.store.save(inputRecords, { id: inputKey, target, call_id: call.id, input_target: args.input_target, kind: args.kind,
        submitted_by: context.actor, origin: context.origin, control_version: args.control_version, status: 'prepared', input: args.input });
      this.calls.bind(call.id, { target, input_id: inputKey, execution_actor: record.execution_actor || { kind: 'bot', id: record.bot_id } });
    });
    const beforeSubmit = async () => {
      await fresh();
      this.store.transaction(() => {
        const latest = this.require(target, context, 'input');
        const currentInput = this.store.get(inputRecords, inputKey);
        if (currentInput?.status === 'submitted') return;
        if (currentInput?.status !== 'prepared') reject('input_cancelled', 'The queued input was invalidated', 409);
        this.active(latest, args.control_version);
        if (target.kind === 'session') this.platform.assertCanSubmit(context, latest);
        this.platform.assertRunAllowed(context, { allowUser: true });
        if (target.kind === 'session' && args.kind === 'next') {
          this.resources.assertCapacity('sessions', this.platform.activeSessions(target.id));
          this.store.save(sessionRecords, { id: target.id, status: 'submitted' });
        }
        this.bindSubmission(call.id, target.kind === 'session' ? latest : null, context);
        this.store.save(inputRecords, { id: inputKey, status: 'submitted' });
      });
    };
    try {
      const options = { session: current, conversation: current, call: this.calls.get(call.id), kind: args.kind,
        input_target: args.input_target, input: args.input, beforeSubmit, signal: context.signal };
      const facts = target.kind === 'conversation' ? await this.platform.runtime.submitConversation(options)
        : current.engine === 'pi' ? await this.platform.runtime.pi.submit(options) : await this.platform.connections.input(options);
      this.applyResponse(target.kind === 'session' ? current : null, call.id, facts);
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
    if (args.input !== undefined || args.input_target || !args.resume_ref) reject('invalid_resume', 'Resume requires only the current stop reference');
    const { target } = args;
    const record = this.store.transaction(() => {
      const current = this.require(target, context, 'control');
      assertRevision(current.control.control_version, args.control_version, 'control_version');
      assertResume(context.actor, target, current.control, args.resume_ref, before.owner);
      if (target.kind === 'session') this.platform.assertSessionAuthority(current);
      const saved = this.saveControl(target, { ...current.control, state: 'active', control_version: current.control.control_version + 1 });
      this.calls.bind(call.id, { target });
      return saved;
    });
    this.platform.runtime.wake();
    return this.baseView(target, record, context);
  }

  saveControl(target, control) {
    const record = this.store.save(target.kind === 'session' ? sessionRecords : conversationRecords, { id: target.id, control });
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

  applyResponse(session, callId, facts) {
    if (typeof facts?.status !== 'string') throw new Error('Execution adapter did not return its actual status');
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
        if (call.status === 'prepared') throw new Error('Adapter accepted an execution before saving the submission');
        this.calls.bind(callId, { result: facts, result_ref: { kind: 'call', id: callId } });
      }
    });
  }

  failedSubmission(session, callId, error, inputId) {
    this.store.transaction(() => {
      const call = this.calls.get(callId);
      const known = call.status === 'prepared' || error.beforeSubmit === true;
      const status = known ? 'failed' : 'unknown';
      if (session && call.result_ref?.kind !== 'event') this.saveFacts(session.id, callId, { status, safe_to_disconnect: known });
      if (known) {
        this.calls.bind(callId, { status: 'prepared' });
        this.calls.fail(callId, error);
        if (inputId && this.store.get(inputRecords, inputId)?.status === 'prepared') this.settleInput(inputId, callId, 'not_submitted');
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
    const updated = this.store.save(sessionRecords, { id: sessionId, status, control, submitted_by: call.submitted_by,
      native: facts.native ? { ...session.native, ...facts.native } : session.native, input_targets: facts.input_targets ?? session.input_targets,
      safe_to_disconnect: facts.safe_to_disconnect,
      ...(session.authority_revoked && ended ? { revocation_stop: 'stopped' } : {}),
      input_revision: facts.input_revision ?? session.input_revision, latest_call_id: callId });
    if (control.stop_status !== session.control.stop_status) this.projectStop({ kind: 'session', id: sessionId }, control);
    return updated;
  }

  receipt(sessionId, callId, facts) {
    return this.store.transaction(() => {
      const call = this.calls.get(callId);
      const target = sessionId ? { kind: 'session', id: sessionId } : call.target;
      if (!sameRef(target, call.target)) reject('call_target_conflict', 'Execution result belongs to another call target', 409);
      const eventId = keyOf('call', callId, facts.position ?? facts.id);
      if (!this.store.get('platform-events', eventId) && target?.kind === 'session') this.saveFacts(target.id, callId, facts);
      const event = this.calls.recordReceipt(callId, facts, target);
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
        !(terminal.has(existing.status) && existing.status !== 'unknown' && !terminal.has(status))) this.store.save(inputRecords, { id, status });
  }
}

function resultStatus(status) { return terminal.has(status) ? status : 'submitted'; }
