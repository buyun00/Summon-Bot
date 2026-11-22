import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertInstallationWritable, readInstallationState } from '../../../scripts/installation/installation-state.mjs';
import { inspectServiceLock } from '../../../scripts/installation/service-lock.mjs';
import { repairRequestType, repairResultType, tools } from '../../../capabilities/platform/contract.mjs';
import { deliveryRecords } from '../../../capabilities/platform/delivery.mjs';
import { waitRecords } from '../../../capabilities/platform/calls.mjs';
import { forwardMaterials, workGroup } from '../../../capabilities/platform/session-work.mjs';
import { barePublicationNumber, currentPublicationGrant, fieldLayout, inspectedPublicationSources, privateRoomRead, publicationContext, publicationSelection, publicationSources, roomPublicationReceipts, roomQuestionLinks, withinPublicationRoom } from '../../../capabilities/platform/room-publication.mjs';
import { BotStore } from '../storage/store.mjs';
import { Inbox } from '../storage/inbox.mjs';
import { eventOrder, executionRef, now, recordKey, refKey, runtimeFailure, runtimeRecords as R, sameRef, terminalCallStates } from '../storage/runtime-records.mjs';
import { BotEngine } from '../agent/engine.mjs';
import { bindModel } from '../agent/model.mjs';
import { connectionPath } from '../agent/connections.mjs';
import { UsageLedger } from '../agent/usage.mjs';
import { createRedactor } from './config.mjs';
import { textMessage, transcriptPage } from '../context/projection.mjs';
import { canReadObservation, observationBoundary } from '../context/room-observation.mjs';
import { MaterialRuntime } from '../context/materials.mjs';
import { FastReadRuntime } from './fast-read.mjs';
import { confirmedRoomSend, resolutionLabel } from './room-delivery.mjs';

const conversationRef = executionRef;
const sessionRef = id => ({ kind: 'session', id });
const botRef = id => ({ kind: 'bot', id });
const activeRunStates = new Set(['pending', 'running', 'waiting', 'interrupted', 'retry']);
const cleanError = error => ({ status: error.status, code: error.code, message: error.message, details: error.details });
const actorFor = call => call.submitted_by || { kind: 'user', id: 'user' };
const sortedIds = values => [...new Set(values || [])].sort();
const scopeGrants = access => [sortedIds(access?.model_ids), sortedIds(access?.workspace_ids)];
function canRetainAuthorizationView(previous, current) {
  if (previous === current) return true;
  // Added rooms or resources keep earlier receipts usable. Removed access still
  // invalidates context produced under the broader authorization.
  try {
    const before = JSON.parse(previous);
    const after = JSON.parse(current);
    if (!Array.isArray(before) || !Array.isArray(after) || !sameRef(before[0], after[0])) return false;
    const earlierDetails = before.slice(4);
    const currentDetails = after.slice(4);
    const earlierDuties = earlierDetails.find(detail => detail.maintained_connection_ids)?.maintained_connection_ids ?? [];
    const currentDuties = currentDetails.find(detail => detail.maintained_connection_ids)?.maintained_connection_ids ?? [];
    const grants = [[before[1], after[1]], [before[2], after[2]],
      [before[3][0], after[3][0]], [before[3][1], after[3][1]], [earlierDuties, currentDuties]];
    const retained = grants.every(([earlier, authorized]) => {
      const allowed = new Set(authorized.map(value => recordKey(value)));
      return earlier.every(value => allowed.has(recordKey(value)));
    });
    const earlierRevocations = earlierDetails.filter(detail => !detail.maintained_connection_ids);
    const currentRevocations = currentDetails.filter(detail => !detail.maintained_connection_ids);
    return retained && recordKey(...earlierRevocations) === recordKey(...currentRevocations);
  } catch { return false; }
}
const targetOption = (kind, value) => ({ kinds: [kind], input_target: value });
const protectedEvents = new Set(['connection.failure', repairRequestType, 'work.tool']);
const protectedEvent = event => protectedEvents.has(event.type) || event.result?.output?.type === repairResultType;
const isTerminalReceipt = (event, wait) => event?.type === 'call.receipt' && event.call_id === wait.call_id && terminalCallStates.has(event.status);
const callSettled = status => status !== 'unknown' && terminalCallStates.has(status);
const roomEvent = message => ({ id: message.id, kind: 'event', type: 'message', space: { kind: 'room', id: message.roomId },
  ...(message.authorized_publication && { authorized_publication: message.authorized_publication }),
  sequence: message.sequence, time: message.createdAt, author: message.author || (message.senderId === 'user' ? { kind: 'user', id: 'user' } :
    message.senderId === 'system' ? { kind: 'platform', id: 'platform' } : botRef(message.senderId)),
  text: message.content, attachments: message.attachments, references: message.references, mentions: message.mentions, reply_to: message.replyTo });

export class BotRuntime {
  constructor({ dataRoot, model = { connectionStore: connectionPath(dataRoot) }, platform, emit = () => {}, releaseRoot }) {
    this.dataRoot = resolve(dataRoot);
    this.releaseRoot = releaseRoot || platform.releaseRoot;
    this.model = model;
    this.platform = platform;
    this.emit = emit;
    this.clean = createRedactor({ model });
    this.inboxes = new Map();
    this.active = new Map();
    this.starting = new Map();
    this.opening = new Map();
    this.recoveringInputs = new Map();
    this.missingRecoveryInboxes = new Set();
    this.draining = false;
    this.closed = false;
    this.pi = { start: options => this.startPi(options), inspect: (session, options) => this.inspectPi(session, options),
      submit: options => this.submitInput(options, true), stop: ({ session }) => this.stopConversation(session.conversation_id || session.id) };
  }

  async initialize() {
    await assertInstallationWritable(this.dataRoot, this.releaseRoot);
    try { this.usage = new UsageLedger(join(this.dataRoot, 'usage.sqlite')); }
    catch { console.error('The local usage report is unavailable'); }
    this.engine = new BotEngine({ model: this.model, platform: this.platform, usage: this.usage,
      toolSpecs: tools, emit: this.emit, clean: this.clean, reportUsageError: () => {
        this.usageIncomplete = true;
        this.emit('engine.usage_unavailable');
      } });
    this.materials = new MaterialRuntime(this);
    this.fastRead = new FastReadRuntime(this);
    const submissions = this.platform.executions.pendingPiSubmissions();
    if (submissions.length) {
      try { this.ownsGateway = (await inspectServiceLock(this.dataRoot, 'gateway'))?.pid === process.pid; }
      catch { this.ownsGateway = false; }
    }
    for (const item of submissions) {
      this.recoveringInputs.set(item.call_id, { ...item, writer_finished: this.inputWriterFinished(item.writer_pid) });
    }
    const recoveringBots = new Set(submissions.map(item => item.bot_id));
    for (const bot of this.platform.manager.list()) {
      try {
        const inbox = await this.inbox(bot.id, { create: false });
        if (!inbox && recoveringBots.has(bot.id)) this.missingRecoveryInboxes.add(bot.id);
      }
      catch (error) {
        if (error.code !== 'bot_inbox_unavailable') throw error;
        this.emit('engine.inbox_unavailable', { bot_id: bot.id });
      }
    }
    this.recoverInputs();
    this.interval = setInterval(() => this.wake(), 1000);
    this.interval.unref();
    this.wake();
    return this;
  }

  async inbox(botId, { create = true } = {}) {
    const existing = this.inboxes.get(botId);
    if (existing) return existing;
    if (this.closed) throw runtimeFailure('runtime_closed', 'The Bot runtime is closed', 503);
    if (this.opening.has(botId)) {
      const pending = await this.opening.get(botId);
      return pending || (create ? this.inbox(botId) : null);
    }
    const opening = this.open(boxId(botId), create);
    this.opening.set(botId, opening);
    try { return await opening; } finally { this.opening.delete(botId); }
  }

  async open(botId, create) {
    const state = await readInstallationState(this.dataRoot);
    if (state?.phase === 'prepared' || state?.phase === 'draining') {
      if (state.intake_closed) throw runtimeFailure('updating', 'Installation is no longer accepting events', 503);
    } else await assertInstallationWritable(this.dataRoot, this.releaseRoot);
    const file = join(this.dataRoot, 'bots', botId, 'state.sqlite');
    let inbox, store;
    try {
      if (!create) {
        try { await stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      }
      store = new BotStore(file);
      inbox = new Inbox(store, botId);
      store.transaction(() => {
        for (const run of inbox.list(R.run, 'state', 'running')) inbox.putRun({ id: run.id, state: 'interrupted' });
        for (const conversation of store.listRecords(R.conversation)) this.syncConversationControl(inbox, conversation);
        this.reconcileReturnWaits(inbox);
        for (const route of inbox.list(R.route, 'fast_read_decision', 'forward')) {
          if (route.fast_read_forward_call_id)
            this.fastRead.forwardReceipt(inbox, this.platform.store.get('platform-calls', route.fast_read_forward_call_id));
        }
      });
    } catch (error) {
      try { store?.close(); } catch {}
      throw Object.assign(runtimeFailure('bot_inbox_unavailable', 'The Bot inbox could not be opened', 503), { cause: error });
    }
    this.inboxes.set(botId, inbox);
    try { this.usage?.recoverBot(botId); }
    catch {
      this.usageRecoveryFailed = true;
      this.emit('engine.usage_unavailable', { bot_id: botId });
    }
    return inbox;
  }

  reconcileReturnWaits(inbox) {
    const owners = new Set();
    for (const wait of inbox.list(R.wait, 'status', 'waiting')) {
      const published = this.platform.store.get(waitRecords, wait.id);
      if (!published || published.bot_id !== inbox.botId || published.run_id !== wait.run_id ||
          published.call_id !== wait.call_id || published.conversation_id !== wait.conversation_id ||
          inbox.run(wait.run_id)?.conversation_id !== wait.conversation_id) continue;
      if (published.status === 'inline') {
        inbox.store.putRecord(R.wait, { ...wait, status: 'inline', result_position: published.result_position });
        owners.add(wait.run_id);
      } else if (published.status === 'access_revoked' && published.latest_event_id === wait.latest_event_id) {
        const route = inbox.store.getRecord(R.route, recordKey(published.latest_event_id, wait.id));
        if (route?.state === 'access_revoked') {
          inbox.settleWait(route, route.state);
          owners.add(wait.run_id);
        }
      }
    }
    for (const id of owners) {
      const run = inbox.run(id);
      const conversation = inbox.conversation(run.conversation_id);
      if (run.state !== 'waiting' || !run.result || conversation?.kind !== 'room' || inbox.hasOpenWaits(id) ||
          run.route_ids.some(route => inbox.store.getRecord(R.route, route)?.state === 'pending')) continue;
      inbox.putRun({ id, state: 'completed' });
      this.stageInputs(inbox, conversation, id, 'completed', run.result);
    }
  }

  inputWriterFinished(pid) {
    // The managed service acquires this lock before opening the database and
    // releases it only after the previous Gateway's writes have drained.
    if (this.ownsGateway) return true;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff || pid === process.pid) return false;
    try { process.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }

  recoverInputs() {
    for (const [id, submission] of this.recoveringInputs) {
      let outcome = 'unknown', facts;
      try {
        const inbox = this.inboxes.get(submission.bot_id);
        const eventId = recordKey('pi.input', id);
        const input = inbox?.store.getRecord(R.input, id);
        const event = inbox?.event(eventId);
        const route = inbox?.store.getRecord(R.route, recordKey(eventId, 'observation'));
        if (input && input.event_id === eventId && event?.call_id === id && event.type === 'pi.input' &&
            route?.run_id === input.run_id && input.conversation_id === submission.conversation_id &&
            inbox.run(input.run_id)?.conversation_id === input.conversation_id) {
          outcome = 'submitted';
          facts = { input_revision: input.input_revision, native: { conversation_id: input.conversation_id, run_id: input.run_id },
            input_targets: [], confirmed_input: input.confirmed_input };
        } else if (!input && !event && !route && (inbox ? this.inputWriterFinished(submission.writer_pid)
          : this.missingRecoveryInboxes.has(submission.bot_id) && submission.writer_finished)) outcome = 'not_submitted';
      } catch {
        // An unreadable record is inconclusive and stays eligible for reconciliation.
      }
      try {
        if (this.platform.executions.reconcilePiSubmission(submission, outcome, facts)) this.recoveringInputs.delete(id);
      } catch (error) {
        this.emit('engine.receipt_pending', { call_id: id, ...this.clean.error(cleanError(error)) });
      }
    }
    if (!this.recoveringInputs.size) this.missingRecoveryInboxes.clear();
  }

  async receive(delivery) {
    if (this.closed) return { accepted: false, retryable: true, code: 'runtime_closed' };
    this.platform.getBot(delivery.bot_id);
    const inbox = await this.inbox(delivery.bot_id);
    if (protectedEvents.has(delivery.event.type) &&
        !this.platform.canReadEvent(delivery.event, { actor: botRef(delivery.bot_id) }))
      return { accepted: false, retryable: false, code: 'access_revoked' };
    const receipt = inbox.receive(delivery);
    if (delivery.event.type === 'call.receipt')
      this.fastRead.forwardReceipt(inbox, this.platform.store.get('platform-calls', delivery.event.call_id));
    if (receipt.processed || receipt.waits.length) setImmediate(() => {
      if (!this.closed) this.consumeDeliveries(this.inboxes.get(delivery.bot_id), [receipt.event_id]);
    });
    this.wake();
    return receipt;
  }

  async inboxReceipt(botId, deliveryId) { return (await this.inbox(botId, { create: false }))?.receipt(deliveryId) || null; }

  deliveryRuns(botId, eventId) {
    const inbox = this.inboxes.get(botId);
    if (!inbox) return [];
    const routes = inbox.list(R.route, 'event_id', eventId);
    const ids = new Set(routes.map(route => route.run_id).filter(Boolean));
    for (const route of routes) {
      const handler = route.fast_read_forward_handler;
      const returned = handler?.wait_id && inbox.store.getRecord(R.route, recordKey(handler.event_id, handler.wait_id));
      if (returned?.run_id) ids.add(returned.run_id);
    }
    return [...ids].flatMap(id => {
      const run = inbox.run(id);
      return run ? [{ run_id: id, state: run.state, starts: run.start_count ?? null, first_started_at: run.first_started_at ?? null }] : [];
    });
  }

  roomDeliveryDetails(botId, eventId) {
    const route = this.forwardRoute(botId, eventId);
    const callId = route?.fast_read_forward_call_id;
    const call = callId && this.platform.store.get('platform-calls', callId);
    const updated = call && this.openIntakeReceipt(call);
    const local = updated ?? route?.source_intake_receipt;
    const status = local?.call_status ?? route?.fast_read_forward_status;
    const fallback = route?.fast_read_forward_fallback;
    const recovery = local?.recovery;
    const notice = fallback && (status === 'not_submitted' ? (recovery ? '原生输入未提交，原件补投状态 ' + recovery.call_status :
      route.fast_read_forward_handler?.wait_id ? '原生输入未提交，失败回执已入原工作主持队列' : '原生输入未提交，已转群主对话') : status === 'completed' ? '原调用已完成' :
      fallback === 'call_result_unknown' ? '原生送达待查' : '直转已交主对话处理');
    return { ...(route?.fast_read_diagnostic && { fast_read_diagnostic: route.fast_read_diagnostic }),
      ...(call && { forward_call: { id: call.id, status, input_status: local?.native_input_status,
        result_ref: updated ? call.result_ref : route.fast_read_forward_receipt && { kind: 'event', id: route.fast_read_forward_receipt },
        handler: route.fast_read_forward_handler, recovery_call_id: recovery?.id, recovery_status: recovery?.call_status } }),
      ...(route?.resolution ? { resolution_notice: resolutionLabel(route.resolution) } :
        notice ? { resolution_notice: callId ? notice + ' · 调用 ' + callId : notice } : {}),
      ...(route?.public_reply && { public_reply: route.public_reply }) };
  }

  forwardRoute(botId, eventId) {
    return this.inboxes.get(botId)?.store.getRecord(R.route, recordKey(eventId, 'observation'));
  }

  openIntakeReceipt(call) {
    const room = call.origin?.source_room, work = call.target?.kind === 'session' && this.platform.executions.record(call.target);
    if (!room || !work?.origin_room || work.owner?.id !== call.origin.bot_id || work.authority_revoked ||
        !this.platform.canReadSpace(work.owner, room) || !this.platform.canReadSpace(work.owner, work.origin_room)) return null;
    const status = record => {
      const input = record.input_id && this.platform.store.get('platform-inputs', record.input_id);
      return { call_status: record.status, native_input_status: input?.call_id === record.id ? input.status : record.result?.input_status };
    };
    const latest = this.platform.executions.latestMaterialAttempt(call);
    return { ...status(call), ...(latest.id !== call.id && { recovery: { id: latest.id, ...status(latest) } }) };
  }

  roomIntake(botId, room, requests) {
    const ids = new Set(requests.flatMap(event => [event.id, event.reply_to?.id ?? event.reply_to,
      ...(event.references || []).filter(ref => ref.kind === 'event').map(ref => ref.id)]).filter(Boolean));
    const recent = this.platform.store.db.prepare(`SELECT json_extract(data,'$.intake_source_ids') AS sources FROM records
      WHERE kind='platform-calls' AND json_extract(data,'$.target.id')=? AND json_extract(data,'$.origin.bot_id')=?
      AND json_extract(data,'$.status')='completed' AND json_array_length(data,'$.intake_source_ids')>0 ORDER BY rowid DESC LIMIT 12`).all(room.id, botId);
    for (const row of recent) for (const id of JSON.parse(row.sources)) ids.add(id);
    const receiving = this.platform.executions.followupSessions(botId, room.id).filter(work =>
      work.origin_room?.id !== room.id && !work.authority_revoked && work.control?.state === 'active' &&
      this.platform.executions.record(conversationRef(work.owner_conversation_id))?.control.state === 'active' &&
      this.platform.canReadSpace(botRef(botId), work.origin_room));
    const open = receiving.length > 0;
    const receipts = new Map();
    const calls = this.platform.calls.roomForwards(botId, room.id, [...ids]);
    for (const [source, call] of calls) {
      const route = this.forwardRoute(botId, source);
      const message = this.platform.store.get('messages', source);
      if (message?.roomId !== room.id || !call.origin.intake_message_id && route?.fast_read_forward_call_id !== call.id) continue;
      const receipt = this.openIntakeReceipt(call) ?? route?.source_intake_receipt ?? { call_status: route?.fast_read_forward_status };
      const work = call.target?.kind === 'session' && this.platform.executions.record(call.target);
      const historical = work?.owner?.id === botId && !work.authority_revoked && call.origin?.source_room?.id === room.id &&
        this.platform.canReadSpace(work.owner, work.origin_room);
      receipts.set(recordKey(source, call.target?.id), { source_event: source, author: message.senderId, call_status: receipt.call_status,
        ...(historical && { submitted_to: { kind: 'session', id: work.id } }),
        ...(receiving.some(work => work.id === call.target?.id) && { receiving_session: call.target.id }),
        native_input_status: receipt.native_input_status, ...(receipt.recovery && { recovery: {
          call_status: receipt.recovery.call_status, native_input_status: receipt.recovery.native_input_status } }) });
    }
    if (ids.size) {
      const local = this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='platform-calls'
        AND json_extract(data,'$.target.id')=? AND json_extract(data,'$.origin.bot_id')=? AND json_extract(data,'$.status')='completed'
        AND EXISTS (SELECT 1 FROM json_each(data,'$.intake_source_ids') WHERE value IN (SELECT value FROM json_each(?))) ORDER BY rowid DESC`)
        .all(room.id, botId, JSON.stringify([...ids]));
      for (const row of local) {
        const call = JSON.parse(row.data);
        const work = call.intake_session_id && this.platform.executions.record(sessionRef(call.intake_session_id));
        const originals = call.intake_source_ids.filter(id => ids.has(id));
        const visible = work?.owner?.id === botId && !work.authority_revoked && this.platform.canReadSpace(work.owner, work.origin_room);
        const live = visible ? this.platform.roomWork.priorMaterialReceipts(work, call, originals) : [];
        const inner = visible && call.intake_call_id && this.platform.store.get('platform-calls', call.intake_call_id);
        const native = inner?.retained_input_call_id ? this.platform.store.get('platform-calls', inner.retained_input_call_id) : inner;
        const input = native?.input_id && this.platform.store.get('platform-inputs', native.input_id);
        for (const id of originals) {
          const message = this.platform.store.get('messages', id);
          if (message?.roomId !== room.id) continue;
          const key = recordKey(id, call.intake_session_id);
          const existing = receipts.get(key);
          if (existing?.intake_status) continue;
          const acted = native?.target?.id === call.intake_session_id && !native.material_reference_only &&
            (native.material_action_ids ?? native.origin?.intake_material_ids ?? []).includes(id);
          const current = live.find(item => item.event_id === id) ?? (acted ? { call_status: native.status,
            input_status: input?.call_id === native.id ? input.status : native.result?.input_status ?? 'unconfirmed' } : null);
          const specific = current ?? call.result?.material_receipts?.find(item => item.event_id === id);
          const entry = existing ?? { source_event: id, author: message.senderId,
            ...(receiving.some(item => item.id === call.intake_session_id) && { receiving_session: call.intake_session_id }) };
          if (visible && call.target?.kind === 'room' && call.target.id === room.id && inner?.target?.id === work.id && specific)
            entry.submitted_to = { kind: 'session', id: work.id };
          entry.intake_status = call.status;
          if (current || !entry.call_status) {
            entry.call_status = specific?.call_status ?? call.result?.status;
            entry.native_input_status = specific?.input_status ?? call.result?.input_status;
          }
          receipts.set(key, entry);
        }
      }
    }
    if (!open && !receipts.size) return null;
    return { room: { id: room.id, name: room.name }, owner_id: botId, receives_materials_here: open, receipts: [...receipts.values()],
      receiving_sessions: receiving.map(work => ({ kind: 'session', id: work.id,
        engine: work.engine === 'pi' ? 'pi' : this.platform.connections.get(work.engine)?.kind })),
      instruction: 'Each source_event has its own receipt. submitted_to identifies the historical target. native_input_status is the delivery status at that target; intake_status is the outer filing. A completed target input establishes delivery there, not a separate human signature. An empty receiving_sessions list closes future intake only. For a new filing use the currently open receiving_session.' };
  }

  wake() {
    if (this.closed || this.draining || this.platform.draining || this.pumpTask) return;
    if (!this.scheduled) {
      this.scheduled = setImmediate(() => {
        this.scheduled = null;
        this.pumpTask = this.pump().catch(error => this.emit('engine.runtime_error', this.clean.error(cleanError(error))))
          .finally(() => { this.pumpTask = null; });
      });
    }
  }

  async pump() {
    if (this.pumping || this.closed || this.draining || this.platform.draining) return;
    this.pumping = true;
    try {
      await this.checkInstallation();
      this.recoverInputs();
      const received = this.platform.store.list(deliveryRecords).filter(delivery => delivery.status === 'received');
      for (const inbox of this.inboxes.values()) {
        try {
          this.flushInputs(inbox);
          this.reconcileDeliveries(inbox, received);
          const bot = this.platform.getBot(inbox.botId);
          if (bot.enabled) await this.dispatch(inbox, bot);
        } catch (error) {
          this.emit('engine.runtime_error', { bot_id: inbox.botId, ...this.clean.error(cleanError(error)) });
        }
      }
    } catch (error) {
      if (error.code !== 'updating') throw error;
    } finally { this.pumping = false; }
  }

  registered(conversation) {
    return this.platform.executions.record(conversationRef(conversation.id));
  }

  register(inbox, conversation) {
    const current = this.platform.executions.registerConversation(conversation);
    return inbox.putConversation({ ...conversation, registered: true, control: current.control });
  }

  syncConversationControl(inbox, conversation) {
    if (!conversation) return;
    const control = this.registered(conversation)?.control;
    if (!control || JSON.stringify(control) === JSON.stringify(conversation.control)) return;
    inbox.store.transaction(() => {
      inbox.putConversation({ id: conversation.id, control });
      if (control.state !== 'active') return;
      for (const run of inbox.runs(conversation.id)) {
        if (activeRunStates.has(run.state) && run.control_version !== control.control_version)
          inbox.putRun({ id: run.id, control_version: control.control_version });
      }
    });
  }

  controlChanged(record) {
    const inbox = this.inboxes.get(record.bot_id);
    if (inbox) this.syncConversationControl(inbox, inbox.conversation(record.id));
  }

  async connectionSetupConversation(bot, id, setup) {
    const inbox = await this.inbox(bot.id);
    return this.register(inbox, inbox.putConversation({ id, kind: 'connection_setup', space: botRef(bot.id),
      owner: { kind: 'user', id: 'user' }, connection_setup: setup, embedded_initializer: bot.connection_initializer === true }));
  }

  async dispatch(inbox, bot) {
    const snapshot = inbox.pending();
    const settled = new Set(snapshot.filter(route => this.settledProgress(inbox, route)));
    if (settled.size) this.discard(inbox, [...settled], 'cancelled');
    const pending = snapshot.filter(route => !settled.has(route));
    const unassigned = new Map();
    const fastReadBatches = new Map();
    for (const route of pending) {
      if (route.run_id) continue;
      if (!route.wait_id && route.event.type === 'message' && route.event.space?.kind === 'room') {
        const observation = this.platform.deliveries.roomObservation(bot.id, route.event.space.id);
        if (observation && route.event.sequence <= (observation.through?.sequence ?? 0) &&
            route.match_sources?.some(source => source.kind === 'room_base')) {
          if (route.event.sequence > observation.start_sequence) {
            const checkpoint = observation.checkpoint && inbox.store.getRecord(R.checkpoint, observation.checkpoint.id);
            const covered = checkpoint && route.event.sequence > (checkpoint.from?.sequence ?? 0) && inbox.run(checkpoint.run_id);
            const link = covered ? { ...route, run_id: covered.id, conversation_id: covered.conversation_id } : route;
            this.discard(inbox, [link], 'processed');
            continue;
          }
          if (route.match_sources.every(source => source.kind === 'room_base')) {
            this.discard(inbox, [route], 'cancelled');
            continue;
          }
        }
      }
      if (!route.wait_id && route.event.type === 'call.receipt') {
        const returns = inbox.list(R.route, 'event_id', route.event_id).filter(item => item.wait_id);
        if (returns.some(item => item.state === 'pending')) continue;
        if (returns.length) {
          this.discard(inbox, [route], returns.some(item => item.state === 'processed') ? 'processed' : 'access_revoked');
          continue;
        }
        if (this.targetPaused(route.event.target)) continue;
      }
      if (route.wait_id) {
        if (!this.routeReady(inbox, route)) continue;
        const wait = inbox.wait(route.wait_id);
        if (wait && inbox.canReturnToOwner(wait)) {
          inbox.associate(wait.run_id, [route]);
          continue;
        }
        const targetConversation = route.conversation_id ? inbox.conversation(route.conversation_id) : null;
        if (!targetConversation) continue;
        const space = targetConversation.space || route.event.space || botRef(bot.id);
        const related = { kind: 'conversation', id: targetConversation.id };
        const target = inbox.wait(route.wait_id)?.target;
        const session = target?.kind === 'session' && this.platform.executions.record(target);
        const receiptGroup = session ? workGroup(session) : recordKey(route.event.call_id);
        const key = recordKey(refKey(space), refKey(related), receiptGroup);
        if (!unassigned.has(key)) unassigned.set(key, { space, related, receiptGroup, routes: [] });
        unassigned.get(key).routes.push(route);
        continue;
      }
      if (this.fastRead?.needsFastRead(inbox, bot, route)) {
        const roomId = route.event.space.id;
        if (!fastReadBatches.has(roomId)) fastReadBatches.set(roomId, []);
        fastReadBatches.get(roomId).push(route);
        continue;
      }
      const space = route.event.space || botRef(bot.id);
      const related = route.event.ref?.kind === 'conversation' ? route.event.ref : null;
      const key = recordKey(refKey(space), refKey(related));
      if (!unassigned.has(key)) unassigned.set(key, { space, related, routes: [] });
      unassigned.get(key).routes.push(route);
    }
    for (const [roomId, routes] of fastReadBatches) {
      if (!this.platform.canReadSpace(botRef(bot.id), { kind: 'room', id: roomId }, { actor: botRef(bot.id) })) {
        this.discard(inbox, routes, 'access_revoked');
        continue;
      }
      this.fastRead.enqueue(inbox, bot, roomId, routes);
    }
    for (const { space, routes, related, receiptGroup } of unassigned.values()) {
      if (space.kind === 'room' && !this.platform.canReadSpace(botRef(bot.id), space, { actor: botRef(bot.id) })) {
        this.discard(inbox, routes, 'access_revoked');
        continue;
      }
      const retained = related?.kind === 'conversation' ? inbox.conversation(related.id) : null;
      const conversations = inbox.list(R.conversation, 'space.id', space.id).filter(item => item.kind === 'room' && sameRef(item.space, space));
      const available = conversation => this.conversationActive(conversation);
      let conversation = retained ? (available(retained) ? retained : null) : conversations.reverse().find(available);
      if (!conversation && (retained || conversations.length)) continue;
      if (!conversation) conversation = this.register(inbox, inbox.putConversation({ id: randomUUID(), kind: 'room', space, owner: botRef(bot.id) }));
      let newRoutes = routes.slice(0, 32);
      if (receiptGroup) {
        const acceptance = inbox.runs(conversation.id).find(run => run.receipt_group === receiptGroup && activeRunStates.has(run.state));
        if (acceptance) inbox.associate(acceptance.id, newRoutes);
        else inbox.createRun(conversation, newRoutes, { receipt_group: receiptGroup });
        continue;
      }
      const running = this.active.get(conversation.id);
      if (conversation.kind === 'room' && !retained && !running && !this.starting.has(conversation.id)) {
        const runs = inbox.runs(conversation.id);
        const owners = this.platform.executions.directWork(conversation.id);
        newRoutes = newRoutes.filter(route => {
          if (route.fast_read_decision !== 'main' || route.event.type !== 'message') return true;
          const links = roomQuestionLinks(this.platform, space, [route.event]);
          const matched = new Set(owners.filter(work => links.has(work.origin_message_id)).map(work => work.owner_run_id));
          const receiving = runs.filter(run => matched.has(run.id) && ['pending', 'interrupted', 'retry', 'waiting'].includes(run.state));
          if (receiving.length !== 1) return true;
          inbox.associate(receiving[0].id, [route]);
          if (receiving[0].state === 'waiting') inbox.putRun({ id: receiving[0].id, state: 'pending' });
          return false;
        });
        if (!newRoutes.length) continue;
        if (newRoutes.every(route => route.fast_read_decision === 'main') && runs.some(run => run.state === 'retry')) {
          // Keep unlinked instructions in their own ordered turn without
          // changing an existing reservation or attributing them to old work.
          const reservation = runs.filter(run => run.state === 'retry' && run.error?.code === 'resource_limit' && run.retry_at)
            .sort((left, right) => left.retry_at.localeCompare(right.retry_at))[0];
          inbox.createRun(conversation, newRoutes, reservation ? { retry_at: reservation.retry_at } : {});
          continue;
        }
      }
      const retainedRun = conversation.kind !== 'room' && inbox.runs(conversation.id).find(run => run.state === 'suspended');
      const handlingWork = running && conversation.kind === 'room' && (inbox.run(running.runId).receipt_group ||
        inbox.calls(running.runId).some(call => call.tool === 'open_session') ||
        inbox.run(running.runId).pending_event_ids.some(id => inbox.event(id)?.type === 'call.receipt'));
      if (!handlingWork && running?.accepting && !running.signal.aborted && inbox.run(running.runId).pending_event_ids.length < 64)
        inbox.associate(running.runId, newRoutes);
      else if (!running && !this.starting.has(conversation.id) && !inbox.runs(conversation.id).some(run =>
        ['pending', 'interrupted', 'retry'].includes(run.state))) {
        if (retainedRun) {
          inbox.associate(retainedRun.id, newRoutes);
          inbox.putRun({ id: retainedRun.id, state: 'pending' });
        } else inbox.createRun(conversation, newRoutes);
      }
    }

    const foreground = [];
    const maintenance = [];
    for (const conversation of inbox.store.listRecords(R.conversation)) {
      if (!this.registered(conversation)) this.register(inbox, conversation);
      if (this.active.has(conversation.id) || this.starting.has(conversation.id)) {
        if (conversation.kind !== 'material') foreground.push(conversation);
        continue;
      }
      if (!this.conversationActive(conversation)) continue;
      let runs = inbox.runs(conversation.id).filter(run => activeRunStates.has(run.state));
      if (runs.length && conversation.kind === 'room' && conversation.space?.kind === 'room' &&
          !this.platform.canReadSpace(botRef(bot.id), conversation.space)) {
        for (const run of runs) {
          inbox.putRun({ id: run.id, state: 'access_revoked' });
          this.discard(inbox, inbox.pending().filter(route => route.run_id === run.id), 'access_revoked');
        }
        continue;
      }
      runs = runs.filter(run => !run.retry_at || Date.parse(run.retry_at) <= Date.now());
      const eligible = runs.find(run => run.state === 'waiting' && this.waitReady(inbox, run));
      const run = eligible || runs.find(run => run.state !== 'waiting');
      if (!run) continue;
      if (conversation.kind === 'material') {
        maintenance.push({ conversation, run });
        continue;
      }
      foreground.push(conversation);
      this.launch(inbox, conversation, inbox.run(run.id), bot);
    }
    // Start foreground runs before starting a prepared maintenance batch.
    if (!foreground.length) {
      for (const { conversation, run } of maintenance) this.launch(inbox, conversation, run, bot);
    }
    await this.materials.consider(inbox, bot, foreground);
  }

  waitReady(inbox, run) {
    const pending = run.route_ids.map(id => inbox.store.getRecord(R.route, id)).filter(route => route?.state === 'pending');
    if (pending.some(route => route.wait_id && this.routeReady(inbox, route))) return true;
    const independent = Boolean(inbox.conversation(run.conversation_id)?.session_id);
    return pending.some(route => !route.wait_id && independent && inbox.event(route.event_id)?.type === 'pi.input') ||
      !inbox.hasOpenWaits(run.id) && pending.some(route => !route.wait_id);
  }

  routePaused(inbox, route) {
    const conversation = route.conversation_id && inbox.conversation(route.conversation_id);
    if (conversation && !this.conversationActive(conversation)) return true;
    const wait = route.wait_id && inbox.wait(route.wait_id);
    if (!wait) return false;
    const target = wait.target || this.localCallTarget(inbox, wait.call_id);
    if (!this.targetPaused(target)) return false;
    const event = inbox.event(route.event_id);
    return !conversation || !isTerminalReceipt(event, wait) || Boolean(event.target && !sameRef(target, event.target));
  }

  routeReady(inbox, route) { return !this.routePaused(inbox, route) && !this.supersededProgress(inbox, route); }

  supersededProgress(inbox, route) {
    const wait = route.wait_id && inbox.wait(route.wait_id);
    if (!wait) return false;
    const event = inbox.event(route.event_id);
    if (event?.type !== 'call.receipt' || event.call_id !== wait.call_id || isTerminalReceipt(event, wait)) return false;
    return callSettled(wait.status) || (wait.event_ids || []).some(id => {
      const receipt = inbox.event(id);
      if (!isTerminalReceipt(receipt, wait) || !callSettled(receipt.status)) return false;
      const sibling = inbox.store.getRecord(R.route, recordKey(id, wait.id));
      return sibling?.state === 'processed' || sibling?.state === 'pending' && !this.routePaused(inbox, sibling);
    });
  }

  settledProgress(inbox, route) {
    const wait = route.wait_id && inbox.wait(route.wait_id);
    if (!callSettled(wait?.status)) return false;
    const conversation = inbox.conversation(wait.conversation_id);
    return conversation && this.conversationActive(conversation) && this.supersededProgress(inbox, route);
  }

  conversationActive(conversation) {
    const control = this.registered(conversation)?.control || conversation.control;
    return control.state === 'active' && !this.targetPaused(conversation.session_id && sessionRef(conversation.session_id));
  }

  targetPaused(target) { return Boolean(target && this.platform.executions.record(target)?.control?.state === 'paused'); }
  localCallTarget(inbox, callId) {
    const result = callId && inbox.store.getRecord(R.call, callId)?.result;
    return result?.target || result?.execution_ref;
  }

  roomAnswerTarget(context, target) {
    const inbox = context.actor.kind === 'bot' && this.inboxes.get(context.actor.id);
    if (!inbox || context.conversation?.kind !== 'room' || target.kind !== 'session') return;
    const sources = context.origin.event_ids.filter(id => inbox.event(id)?.type === 'message');
    if (sources.length !== 1) return;
    const hint = inbox.store.getRecord(R.route, recordKey(sources[0], 'observation'))?.native_request;
    return hint?.session_id === target.id ? hint.input_target : undefined;
  }

  discard(inbox, routes, status) {
    const eventIds = [...new Set(routes.map(route => route.event_id))];
    if (status === 'access_revoked') for (const route of routes) {
      const event = route.event ?? inbox.event(route.event_id);
      if (event?.type === 'call.receipt') this.platform.executions.retainUndelivered(event, inbox.botId);
    }
    inbox.store.transaction(() => {
      for (const route of routes) {
        const { event, ...stored } = route;
        inbox.store.putRecord(R.route, { ...stored, state: status, processed_at: now() });
        if (status === 'access_revoked') inbox.settleWait(stored, status);
      }
    });
    this.consumeDeliveries(inbox, eventIds);
  }

  consumeDeliveries(inbox, eventIds) {
    for (const eventId of new Set(eventIds)) {
      for (const delivery of inbox.list(R.delivery, 'event_id', eventId)) this.syncDelivery(inbox, inbox.receipt(delivery.id));
    }
  }

  reconcileDeliveries(inbox, received) {
    const inspected = new Set();
    for (const delivery of received.filter(item => item.bot_id === inbox.botId)) {
      if (delivery.event.type === 'message') this.reconcileRoomReply(inbox, delivery.event);
      if (delivery.event.type === 'call.receipt') this.reconcileHostReview(inbox, delivery.event);
      for (const route of inbox.list(R.route, 'event_id', delivery.event.id)) {
        if (route.state !== 'pending' || !route.run_id || inspected.has(route.run_id)) continue;
        inspected.add(route.run_id);
        this.reconcileAcceptedWork(inbox, route.run_id);
      }
      const receipt = inbox.receipt(delivery.id);
      if (receipt?.revision === (delivery.revision ?? 1)) this.syncDelivery(inbox, receipt);
    }
  }

  pendingOwnerReview(inbox, run, conversation, pending) {
    const room = conversation.space, actor = botRef(inbox.botId);
    const requests = this.outstandingRoomReplies(inbox, room, pending.filter(route => !route.resolution).map(route => route.event_id))
      .map(item => this.platform.store.get('messages', item.message_id)).filter(item => item?.senderId === 'user');
    if (!requests.length) return;
    const direct = this.platform.executions.directWork(conversation.id).filter(seat => sameRef(seat.origin_room, room) &&
      seat.owner.id === actor.id && seat.origin_execution?.kind === 'conversation' && !seat.authority_revoked);
    const failures = inbox.calls(run.id).filter(call => call.tool === 'send' && call.state === 'failed').reverse()
      .sort((a, b) => Number(b.result?.details?.reason === 'dispatch_format_unresolved') - Number(a.result?.details?.reason === 'dispatch_format_unresolved'));
    for (const failed of failures) {
      const record = this.platform.store.get('platform-calls', failed.id);
      if (record?.status !== 'failed' || record.origin?.run_id !== run.id || record.origin.conversation_id !== conversation.id ||
          record.origin.bot_id !== actor.id) continue;
      const to = failed.args.to?.id ?? failed.args.to;
      const authorization = failed.args.publication?.authorization;
      const selected = authorization?.id ?? authorization;
      const address = failed.args.reply_to?.id ?? failed.args.reply_to;
      const external = to !== room.id;
      if (external ? failed.result?.code !== 'publication_review_incomplete' || failed.result?.details?.reason !== 'dispatch_format_unresolved' :
          !['work_result_claim_conflicts', 'work_acceptance_claim_conflicts', 'work_card_change_required', 'local_receipt_claim_conflicts',
            'work_review_unavailable', 'reply_target_required'].includes(failed.result?.code)) continue;
      const source = this.platform.store.get('messages', (external ? selected : address ?? selected) ?? '');
      if (source?.roomId !== room.id || external && (source.senderId !== 'user' ||
          !this.platform.canWriteSpace(actor, { kind: 'room', id: to }, { actor, conversation, origin: record.origin }))) continue;
      const links = roomQuestionLinks(this.platform, room, [source]);
      const relevant = requests.filter(message => {
        const roots = roomQuestionLinks(this.platform, room, [message]);
        return roots.has(source.id) || links.has(message.id) || direct.some(seat => links.has(seat.origin_message_id) && roots.has(seat.origin_message_id));
      });
      if (!relevant.length) continue;
      const seats = direct.filter(seat => links.has(seat.origin_message_id));
      if (!external && !seats.length && failed.result.code !== 'local_receipt_claim_conflicts') continue;
      const sent = external ? roomPublicationReceipts(this.platform, actor, conversation, links, { kind: 'room', id: to }) : [];
      const alreadySent = sent.some(receipt => receipt.text === failed.args.text && receipt.prescribed_text_delivered);
      const trigger = { kind: external && !alreadySent ? 'review_prescribed_dispatch' : 'review_owner_handover', source: source.id,
        requested_replies: relevant.map(item => item.id), ...(external && { destination: to, actual_deliveries: sent.map(item => item.message_id) }) };
      // Vary only with a new request, source, confirmed delivery or work change.
      // Repeated rejections at this position are still the same owner task.
      return { trigger, position: recordKey(trigger, seats.map(seat => [seat.id, seat.latest_call_id, seat.input_revision,
        seat.acceptance_state, seat.acceptance?.message_id, seat.acceptance?.note_corrections?.at(-1)?.call_id])) };
    }
  }

  reconcileAcceptedWork(inbox, runId) {
    const run = inbox.run(runId);
    if (run?.state !== 'suspended' || !['room_delivery_pending', 'model_response_incomplete'].includes(run.error?.code)) return;
    const conversation = inbox.conversation(run.conversation_id), actor = botRef(inbox.botId);
    if (conversation?.kind !== 'room' || !this.conversationActive(conversation) || !this.platform.getBot(inbox.botId).enabled ||
        !this.platform.canReadSpace(actor, conversation.space) || this.active.has(conversation.id) || this.starting.has(conversation.id)) return;
    const pending = run.route_ids.map(id => inbox.store.getRecord(R.route, id)).filter(route => route?.state === 'pending');
    const accepted = this.platform.executions.directWork(conversation.id).filter(work => work.acceptance_state === 'closed' &&
      work.acceptance?.outcome === 'delivered' && work.owner.id === actor.id && sameRef(work.origin_room, conversation.space));
    const covered = new Map(), changed = new Set();
    for (const route of pending) {
      const event = inbox.event(route.event_id);
      if (!event || event.type !== 'call.receipt' && !run.injected_event_ids.includes(route.event_id)) continue;
      const roots = event.type === 'message' ? roomQuestionLinks(this.platform, conversation.space, [event]) : new Set();
      for (const work of accepted) {
        const call = event.type === 'call.receipt' && event.target?.kind === 'session' && event.target.id === work.id &&
          this.platform.store.get('platform-calls', event.call_id);
        const final = call?.status === 'completed' && call.result_ref?.kind === 'event' && this.platform.store.get('platform-events', call.result_ref.id);
        const wait = route.wait_id && inbox.wait(route.wait_id);
        const terminal = final?.status === 'completed' && final.call_id === event.call_id && final.target?.id === work.id &&
          final.time >= event.time && wait?.call_id === event.call_id && wait.run_id === runId && wait.conversation_id === conversation.id &&
          this.platform.canReadEvent(event, { actor, conversation, origin: { bot_id: actor.id, conversation_id: conversation.id, run_id: runId } });
        if (!terminal && !roots.has(work.origin_message_id)) continue;
        const message = this.platform.store.get('messages', work.acceptance.message_id);
        const send = message && confirmedRoomSend(this.platform, { ...message, space: conversation.space });
        if (!send || send.origin.conversation_id !== conversation.id || message.replyTo !== work.origin_message_id ||
            message.createdAt < (terminal ? final.time : event.time)) continue;
        const native = !terminal && this.platform.roomWork.materialStatus(work, [event.id])[0];
        const used = native?.call_status === 'completed' && native.input_status === 'completed';
        if (terminal || used && route.intake_disposition === 'material' && !route.intake_task && !route.public_reply_quote) {
          covered.set(route.id, { event_id: event.id, message_id: message.id, call_id: send.id,
            ...(terminal && { session_id: work.id, original_call: call.id, terminal_receipt: final.id }) });
          if (terminal && message.createdAt > (run.last_delivery_review_at ?? run.first_started_at)) changed.add(message.id);
          break;
        }
        // A newer accepted answer to the same question changes what the
        // suspended owner can use. Only that owner assesses uncovered requests.
        if (message.createdAt > (run.last_delivery_review_at ?? run.first_started_at)) changed.add(message.id);
      }
    }
    const left = pending.filter(route => !covered.has(route.id));
    const acceptedIds = sortedIds(changed);
    const position = JSON.stringify(acceptedIds);
    const reconsider = changed.size && position !== run.delivery_recovery_position;
    let draftPosition, draftQuestion, reviewTrigger;
    const ownerReview = left.length && this.pendingOwnerReview(inbox, run, conversation, left);
    if (ownerReview) {
      draftPosition = ownerReview.position;
      reviewTrigger = ownerReview.trigger;
    }
    if (!ownerReview && left.length && run.error?.code === 'room_delivery_pending') {
      const send = inbox.calls(runId).filter(call => call.tool === 'send' && call.state === 'failed' && call.result?.details?.card_correction)
        .sort((a, b) => a.finished_at.localeCompare(b.finished_at)).at(-1);
      const question = this.platform.store.get('messages', send?.args.reply_to?.id ?? send?.args.reply_to ?? '');
      const correction = send?.result.details.card_correction;
      const currentIds = new Set(correction?.acceptance?.filter(seat => seat.current).map(seat => seat.session));
      const work = question?.roomId === conversation.space.id && this.platform.executions.directWork(conversation.id).filter(seat =>
        currentIds.has(seat.id) && seat.owner.id === actor.id && seat.origin_message_id === question.id && !seat.authority_revoked);
      if (work?.length && work.some(seat => seat.acceptance_state === 'open') && work.every(seat => seat.status === 'completed')) {
        draftQuestion = question.id;
        draftPosition = recordKey(question.id, work.map(seat => [seat.id, seat.latest_call_id, seat.input_revision, seat.acceptance_state]));
      }
    }
    const retryDraft = draftPosition && draftPosition !== run.owner_card_recovery_position;
    if (!covered.size && !reconsider && !retryDraft) return;
    const resumeAt = retryDraft && inbox.runs(conversation.id).filter(item => item.error?.code === 'resource_limit' && item.retry_at > now())
      .map(item => item.retry_at).sort()[0];
    inbox.store.transaction(() => {
      for (const [id, proof] of covered) {
        const route = inbox.store.getRecord(R.route, id);
        inbox.store.putRecord(R.route, { ...route, state: 'processed', processed_at: now(), accepted_work_delivery: proof });
        inbox.settleWait(route, 'processed');
      }
      inbox.putRun({ id: runId, processed_event_ids: [...new Set([...run.processed_event_ids, ...[...covered.values()].map(item => item.event_id)])],
        ...(!left.length ? { state: inbox.hasOpenWaits(runId) ? 'waiting' : 'completed', error: null } : retryDraft ?
          { state: resumeAt ? 'retry' : 'interrupted', retry_at: resumeAt || null, recovering_room_inputs: true, owner_card_recovery_position: draftPosition,
            model_outcome: null, model_outcome_uses_view: null, publication_retry_position: null,
            delivery_review_trigger: { ...(reviewTrigger ?? { kind: 'correct_original_card', original_question: draftQuestion }),
              pending_event_ids: left.map(route => route.event_id) } } : reconsider ?
          { state: 'interrupted', recovering_room_inputs: true, delivery_recovery_position: position, last_delivery_review_at: now(),
            delivery_review_trigger: { kind: 'accepted_work',
              accepted_message_ids: acceptedIds, pending_event_ids: left.map(route => route.event_id) } } : {}) });
    });
    this.consumeDeliveries(inbox, [...covered.values()].map(proof => proof.event_id));
  }

  reconcileHostReview(inbox, event) {
    if (event.target?.kind !== 'session') return;
    const work = this.platform.executions.record(event.target);
    const review = work?.acceptance?.host_review;
    if (work?.acceptance_state !== 'closed' || review?.reviewer?.kind !== 'user' || review.receipt_id !== event.id ||
        work.origin_execution?.kind !== 'session' || !sameRef(review.direct_parent, work.origin_execution)) return;
    inbox.store.transaction(() => {
      for (const route of inbox.list(R.route, 'event_id', event.id)) {
        const wait = route.wait_id && inbox.wait(route.wait_id);
        if (route.state !== 'pending' || wait?.session_id !== work.origin_execution.id || wait.run_id !== work.owner_run_id ||
            wait.conversation_id !== work.owner_conversation_id || wait.call_id !== event.call_id) continue;
        inbox.store.putRecord(R.route, { ...route, state: 'processed', processed_at: now(), host_review_call_id: review.call_id });
        inbox.settleWait(route, 'processed');
      }
    });
  }

  reconcileRoomReply(inbox, event) {
    const route = inbox.store.getRecord(R.route, recordKey(event.id, 'observation'));
    if (!route?.run_id || route.state !== 'pending') return;
    const run = inbox.run(route.run_id);
    if (!run || !['suspended', 'retry', 'interrupted', 'pending'].includes(run.state) || !run.start_count ||
        this.active.get(run.conversation_id)?.runId === run.id) return;
    const conversation = inbox.conversation(run.conversation_id);
    if (conversation?.kind !== 'room' || conversation.space.kind !== 'room' || !sameRef(conversation.space, event.space)) return;
    const reply = this.platform.room.replyBy(conversation.space.id, inbox.botId, event.id);
    const call = confirmedRoomSend(this.platform, reply);
    if (!call) return;
    inbox.store.transaction(() => {
      // The original fork may never have injected this message. Keep its execution history intact.
      inbox.store.putRecord(R.route, { ...route, state: 'processed', processed_at: now(), public_reply: {
        message_id: reply.id, bot_id: inbox.botId, call_id: call.id,
        conversation_id: call.origin.conversation_id, run_id: call.origin.run_id,
      } });
      if (run.state !== 'suspended' && !run.route_ids.some(id => inbox.store.getRecord(R.route, id)?.state === 'pending'))
        inbox.putRun({ id: run.id, state: inbox.hasOpenWaits(run.id) ? 'waiting' : 'completed' });
    });
  }

  recoveredRoomReply(origin, roomId, replyTo, currentWork = false) {
    const inbox = this.inboxes.get(origin?.bot_id);
    const run = inbox?.run(origin.run_id);
    if (!run || inbox.conversation(run.conversation_id)?.space?.id !== roomId) return null;
    const routes = run.route_ids.map(id => inbox.store.getRecord(R.route, id));
    if (routes.some(route => route?.resolution && (!replyTo || route.event_id === replyTo)))
      throw runtimeFailure('delivery_resolved', '原发起人已结清此投递，续办请明确回复仍待处理的原消息');
    if (currentWork || !run.recovering_room_inputs) return null;
    const settled = routes.filter(route => route?.public_reply);
    if (settled.length && !replyTo)
      throw runtimeFailure('reply_target_required', 'Reply to the outstanding original message; this recovery already has confirmed public replies.');
    const route = settled.find(item => item.event_id === replyTo);
    return route ? this.platform.room.replyBy(roomId, inbox.botId, route.event_id) : null;
  }

  requiresRoomDraft(context) {
    const { origin, conversation } = context;
    const room = conversation.space;
    const inbox = this.inboxes.get(context.actor.id);
    if (!inbox?.run(origin.run_id)) return true;
    const observation = this.platform.deliveries.roomObservation(context.actor.id, room.id);
    const previous = observation?.checkpoint && inbox.store.getRecord(R.checkpoint, observation.checkpoint.id);
    if (previous?.access_refs?.some(ref => !withinPublicationRoom(this.platform, ref, room))) return true;
    if (origin.event_ids.some(id => {
      const event = inbox.event(id);
      return event && (event.type === 'pi.input' || event.type === 'message' && !sameRef(event.space, room) ||
        event.type === 'call.receipt' && !withinPublicationRoom(this.platform, { kind: 'call', id: event.call_id }, room));
    })) return true;
    return inbox.calls(origin.run_id).some(call => call.state === 'completed' &&
      (call.tool === 'send' && call.result?.message?.roomId && call.result.message.roomId !== room.id ||
        privateRoomRead(this.platform, call.tool, call.args, call.result || {}, room)));
  }

  outstandingRoomReplies(inbox, room, ids) {
    if (room?.kind !== 'room') return [];
    const pending = [];
    for (const id of ids) {
      const route = this.forwardRoute(inbox.botId, id);
      if (route?.state !== 'pending' || !route.public_reply_quote || route.resolution) continue;
      const message = this.platform.store.get('messages', id);
      if (message?.roomId !== room.id) continue;
      const addressed = message.mentions?.length ? message.mentions : message.replyAuthorId ? [message.replyAuthorId] : [];
      const answered = this.platform.roomMembers(room.id).some(member => {
        if (member !== inbox.botId && (!addressed.includes(member) || addressed.includes(inbox.botId))) return false;
        return confirmedRoomSend(this.platform, this.platform.room.replyBy(room.id, member, id));
      });
      const previous = !answered && this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='platform-calls'
        AND json_extract(data,'$.answered_request')=? AND json_extract(data,'$.origin.bot_id')=?
        AND json_extract(data,'$.target.id')=? AND json_extract(data,'$.status')='completed' ORDER BY rowid DESC LIMIT 1`).get(id, inbox.botId, room.id);
      if (!answered && !previous) pending.push({ message_id: id, request: route.public_reply_quote });
    }
    return pending;
  }

  unsettledForwardReturns(job, ids) {
    const due = [];
    for (const id of ids) {
      const event = job.inbox.event(id);
      if (event?.type !== 'call.receipt' || event.status !== 'not_submitted' || event.owner_conversation_id !== job.conversation.id) continue;
      const original = this.platform.store.get('platform-calls', event.call_id);
      if (!original?.origin?.fast_read_forward) continue;
      const work = this.platform.executions.record(event.target);
      if (!work?.origin_room || !this.platform.canReadSpace(work.owner, work.origin_room)) continue;
      const latest = this.platform.executions.latestMaterialAttempt(original);
      const retry = latest.id === original.id ? null : latest;
      if (!this.platform.executions.confirmedNonSubmission(latest)) continue;
      if (this.platform.executions.originalReplies(work).some(({ message }) =>
        this.platform.store.get('platform-calls', message.callId)?.source_event_ids?.includes(id))) continue;
      const actions = job.inbox.calls(job.runId);
      if (actions.some(action => action.state === 'completed' && action.tool === 'send' &&
          action.result?.message?.roomId === work.origin_room.id && action.result.message.replyTo === work.origin_message_id)) continue;
      due.push({ original_call: original.id, source_event: original.source_event_ids[0], session: work.id,
        origin_room: work.origin_room, original_question: work.origin_message_id, latest_attempt: retry?.id, latest_status: retry?.status });
    }
    return due;
  }

  replacementInstructions(work, job, explicit) {
    const room = work.origin_room;
    const original = this.platform.store.get('messages', work.origin_message_id);
    const rows = this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_extract(data,'$.senderId')='user' AND created_at>=? ORDER BY rowid`)
      .all(room.id, original?.createdAt ?? '');
    const instructions = rows.map(row => JSON.parse(row.data)).filter(message => message.id === original?.id ||
      roomQuestionLinks(this.platform, room, [message]).has(work.origin_message_id) ||
      (message.id === explicit || job.context().origin.event_ids.includes(message.id)) && message.content.includes(work.id));
    const hostInputs = job.context().origin.event_ids.map(id => job.inbox.event(id)).filter(event =>
      event?.type === 'pi.input' && event.author?.kind === 'user' && sameRef(event.space, room) && typeof event.input === 'string');
    return [...instructions.map(item => ({ id: item.id, text: item.content })),
      ...hostInputs.map(item => ({ id: item.id, text: item.input }))];
  }

  checkReplacementAuthority(session, context) {
    const proof = session.replacement_authorization;
    if (proof.host_call && context.actor.kind === 'user') return;
    const job = this.active.get(context.origin?.conversation_id);
    const work = this.platform.executions.record(sessionRef(session.replaces_session));
    if (!job || job.runId !== context.origin.run_id || !work || work.latest_call_id !== proof.prior_call ||
        work.control?.control_version !== proof.control_version || work.acceptance_state !== proof.acceptance_state ||
        JSON.stringify(this.replacementInstructions(work, job, proof.instruction).map(item => item.id)) !== JSON.stringify(proof.considered))
      throw runtimeFailure('replacement_authority_changed', 'The host instructions or the prior Session changed. Read them before replacing this work.', 409);
  }

  async reviewRoomDelegation(args, context, room, question) {
    if (!room || !question || context.session) return;
    const requested = args.replaces_session?.id ?? args.replaces_session;
    if (context.actor.kind === 'user') return requested ? { host_call: true } : undefined;
    const job = this.active.get(context.origin?.conversation_id);
    if (!job || job.runId !== context.origin.run_id) {
      if (requested) throw runtimeFailure('replacement_owner_required', 'Continue from the original Room owner.', 409);
      return;
    }
    const rejected = new Set(job.inbox.calls(job.runId).filter(call => call.tool === 'send_input' && call.state === 'failed' &&
      ['material_source_required', 'misplaced_material_arguments', 'material_source_mismatch'].includes(call.result?.code))
      .map(call => call.args.target?.id));
    if (!requested && !rejected.size) return;
    const works = this.platform.executions.directWork(job.conversation.id).filter(work => sameRef(work.origin_room, room) &&
      work.origin_message_id === question && (requested ? work.id === requested : rejected.has(work.id)));
    if (!works.length) {
      if (requested) throw runtimeFailure('work_origin_mismatch', 'Select the original question and its directly owned Session.', 409);
      return;
    }
    const explicit = args.replacement_authorization?.id ?? args.replacement_authorization;
    const instructions = this.replacementInstructions(works[0], job, explicit);
    const evidence = { original_question: question, host_instructions: instructions,
      prior: works.map(work => ({ id: work.id, assignment: work.work_summary, status: work.status,
        acceptance: work.acceptance_state, input_targets: work.input_targets })), replaces: requested,
      proposal: args.work_summary, new_input: typeof args.input === 'string' ? args.input : args.input?.text };
    const decision = await this.engine.assessReplacement(job, evidence);
    if (!requested && decision?.action === 'independent') return;
    const work = works.find(item => item.id === decision?.session) ?? works[0];
    const source = instructions.find(item => item.id === decision?.instruction && (!explicit || explicit === item.id));
    const unserviceable = ['failed', 'not_submitted', 'unsupported', 'cancelled'].includes(work.status) &&
      work.control.state === 'active' && !work.input_targets?.length;
    if (requested && (decision?.action === 'replace' || decision?.action === 'manage' && unserviceable) && decision.session === requested && source &&
        typeof decision.quote === 'string' && decision.quote.trim() && source.text.includes(decision.quote)) {
      const proof = { instruction: source.id, quote: decision.quote, considered: instructions.map(item => item.id),
        prior_call: work.latest_call_id, control_version: work.control.control_version, acceptance_state: work.acceptance_state };
      this.checkReplacementAuthority({ replaces_session: requested, replacement_authorization: proof }, context);
      return proof;
    }
    throw runtimeFailure('original_session_required', 'Continue the existing work with send_input. An applicable host instruction must authorize replacing this executor. For a genuinely independent assignment identify its own question and scope.', 409,
      { original_question: question, target: sessionRef(work.id), control_version: work.control.control_version, input_targets: work.input_targets });
  }

  checkRoomPublication(context, audience, args) {
    const job = this.active.get(context.conversation.id);
    if (job?.runId !== context.origin.run_id) throw runtimeFailure('publication_context_unavailable', 'The Room authoring turn is unavailable', 409);
    const address = { to: { kind: 'room', id: audience.destination.id } };
    if (audience.reply_to) address.reply_to = { kind: 'event', id: audience.reply_to };
    if (audience.release) address.publication = { authorization: audience.cross_room ?
      audience.release.dispatch_id ?? audience.release.authorization_id : audience.release.authorization_id };
    if (args.attachments?.length) address.attachments = args.attachments.map(ref => ({ kind: 'file', id: ref.id ?? ref }));
    if (args.references?.length) address.references = args.references.map(({ kind, id }) => ({ kind, id }));
    if (args.mentions?.length) address.mentions = args.mentions.map(ref => ref.id ?? ref)
      .filter(id => this.platform.roomMembers(audience.destination.id).includes(id));
    if (args.work_reply) {
      const work = this.platform.executions.record(sessionRef(args.work_reply.session.id ?? args.work_reply.session));
      if (work?.origin_room?.id === audience.destination.id && work.owner_conversation_id === context.conversation.id)
        address.work_reply = { session: work.id, stage: args.work_reply.stage };
    }
    const previous = job.publication;
    if (previous?.transported && previous.audience.destination.id === audience.destination.id &&
        previous.audience.reply_to === audience.reply_to &&
        publicationSelection(previous.audience.release) === publicationSelection(audience.release) &&
        JSON.stringify(previous.address) === JSON.stringify(address) &&
        previous.selection === this.publicationEvidence(job, audience, false).selection) {
      return true;
    }
    job.publication = { audience, address };
    return false;
  }

  async restoreRoomDraft(job) {
    if (job.conversation.kind !== 'room' || job.inbox.run(job.runId).start_count < 2) return;
    const call = job.inbox.calls(job.runId).findLast(item => item.tool === 'send');
    if (call?.state !== 'failed' || call.result?.code !== 'publication_view_required' || job.hasNewInput(call.source_event_ids ?? [])) return;
    const context = this.platform.context(job.context());
    const to = typeof call.args.to === 'string' ? { kind: 'room', id: call.args.to } : call.args.to;
    if (to?.kind !== 'room' || !this.platform.canWriteSpace(context.actor, to, context)) return;
    const { text, ...address } = call.args;
    const destination = this.platform.room.room(to.id, context.actor.id);
    const grant = await this.publicationGrant(context, call.args, destination);
    try {
      const audience = publicationContext(this.platform, address, context, grant);
      this.checkRoomPublication(context, audience, address);
    } catch (error) {
      if (![403, 404, 409].includes(error.status)) throw error;
      // A withdrawn grant leaves the owner its normal turn and a real unsent call.
    }
  }

  async publicationGrant(context, args, destination) {
    const job = this.active.get(context.conversation.id);
    if (job?.runId !== context.origin.run_id) return null;
    const review = async sources => {
      const position = JSON.stringify([destination.id, sources.local_work, sources.local_request, sources.requested_stage, sources.candidates.map(item => item.id),
        sources.hostMessages.map(item => item.id), [...sources.facts.keys()], sources.versions, sources.requests?.map(item => item.id),
        sources.current?.map(item => item.id), sources.requested, sources.local_work ? undefined : sources.proposal]);
      if (job.publicationReview?.position === position) return job.publicationReview.grant;
      const grant = await this.engine.resolvePublicationGrant(job, destination, sources);
      if (grant && !grant.review_error) job.publicationReview = { position, grant };
      return grant;
    };
    const reviewCurrent = async (sources, refresh) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!sources?.candidates.length) return null;
        const decision = await review(sources);
        const current = refresh();
        if (JSON.stringify(sources.versions) === JSON.stringify(current?.versions))
          return !decision || decision.review_error || currentPublicationGrant(this.platform, current, decision) ? decision : null;
        sources = current;
      }
      return { review_error: 'source_changed' };
    };
    if (context.conversation.space.id === destination.id) {
      const ref = args.publication?.authorization;
      const requested = ref?.id ?? ref;
      const label = args.work_reply;
      const work = label && this.platform.executions.record(sessionRef(label.session.id ?? label.session));
      let root = work?.owner_conversation_id === context.conversation.id && work.origin_room?.id === destination.id ?
        work.origin_message_id : (args.reply_to?.id ?? args.reply_to);
      if (!root && requested) {
        const authority = this.platform.store.get('messages', requested);
        if (authority?.senderId === 'user' && authority.roomId === destination.id) {
          const linked = roomQuestionLinks(this.platform, context.conversation.space, [authority]);
          const owned = this.platform.executions.directWork(context.conversation.id).filter(seat => seat.origin_room?.id === destination.id &&
            seat.origin_execution?.kind === 'conversation' && seat.owner.id === context.actor.id && linked.has(seat.origin_message_id));
          if (new Set(owned.map(seat => seat.origin_message_id)).size === 1) root = owned[0].origin_message_id;
        }
      }
      if (!root) {
        const incoming = context.origin.event_ids.map(id => this.platform.store.get('messages', id)).filter(item => item?.roomId === destination.id);
        const linked = roomQuestionLinks(this.platform, context.conversation.space, incoming);
        if (!incoming.length) for (const id of context.origin.event_ids) {
          const event = this.platform.store.get('platform-events', id);
          if (event?.type === 'call.receipt' && event.owner_conversation_id === context.conversation.id && event.origin_room?.id === destination.id)
            linked.add(event.origin_message_id);
        }
        const questions = new Set(this.platform.executions.directWork(context.conversation.id)
          .filter(item => item.origin_room?.id === destination.id && linked.has(item.origin_message_id)).map(item => item.origin_message_id));
        if (questions.size === 1) [root] = questions;
      }
      if (root) {
        const local = () => publicationSources(this.platform, args, context, destination, root);
        const sources = local();
        if (sources?.candidates.length && (sources.versions.results.length || sources.confirmed_delivery)) {
          const previous = job.publication?.audience;
          if (previous?.destination.id === destination.id && previous.release?.work_evidence?.reply_address === sources.local_request &&
              previous.release.work_evidence.original_question === root && currentPublicationGrant(this.platform, sources, previous.release))
            return previous.release;
          const grant = await reviewCurrent(sources, local);
          if (grant && !grant.review_error) return { ...grant, source_room: destination.id };
          const product = ['complete', 'correction'].includes(args.work_reply?.stage) ||
            !args.work_reply && sources.questions.has(sources.local_request);
          if (product) throw runtimeFailure('original_work_fields_required',
            'The original work results are available but their public fields have not been selected. Read the named Sessions and retry the card using the original Room question as publication.authorization.', 409,
            { reason: grant?.review_error ?? 'original_work_fields_incomplete', original_question: [...sources.questions][0],
              sessions: sources.versions.seats.filter(seat => seat.current && seat.result).map(seat => seat.id) });
          if (grant?.review_error) return grant;
        }
      }
      const inspect = id => inspectedPublicationSources(this.platform, context, destination, job.inbox.calls(job.runId), id);
      const source = inspect(requested);
      if (!source) return null;
      const last = job.publication?.audience;
      const previousId = last?.release?.authorization_id;
      const reusable = last?.destination.id === destination.id && source.candidates.some(item => item.id === previousId) &&
        JSON.stringify(last.release.versions) === JSON.stringify(source.versionsFor(previousId));
      const grant = reusable ? last.release : await review(source);
      if (grant?.review_error) return grant;
      const current = grant && inspect(grant.authorization_id);
      if (current && current.candidates.length && JSON.stringify(grant.versions) === JSON.stringify(current.versionsFor(grant.authorization_id)) &&
          grant.materials.every(part => current.factRooms.get(part.event_id) === current.candidates[0].roomId && current.facts.get(part.event_id)?.includes(part.text)))
        return { ...grant, source_room: current.candidates[0].roomId };
      return null;
    }
    const sources = publicationSources(this.platform, args, context, destination);
    if (!sources.candidates.length) return null;
    const previous = job.publication?.audience;
    if (previous?.destination.id === destination.id && currentPublicationGrant(this.platform, sources, previous.release)) return previous.release;
    let inspect = false;
    for (const message of sources.candidates) {
      const route = this.forwardRoute(context.actor.id, message.id);
      const grant = route?.publications?.find(item => [destination.id, destination.name].includes(item.room));
      const later = sources.hostMessages.some(item => item.createdAt > message.createdAt);
      if (grant?.after_work && !sources.versions.results.length && !sources.confirmed_delivery) continue;
      if (grant && !grant.after_work && !later && !sources.recipient_request && sources.current.some(item => item.id === message.id) && !sources.questions.size) {
        const materials = grant.materials.flatMap(part => {
          const original = this.platform.store.get('messages', part.event);
          return original?.roomId === message.roomId && original.content.includes(part.quote) &&
              !(original.id === message.id && (part.quote === message.content || part.quote.includes(grant.quote))) ?
            [{ event_id: original.id, text: part.quote }] : [];
        });
        const presentation = grant.presentation ?? [];
        const formatted = fieldLayout(materials, presentation, grant.layout);
        if (materials.length && materials.length === grant.materials.length && !materials.some(part => barePublicationNumber(part.text)) &&
            (!grant.fields_only || !presentation.length || formatted !== undefined)) {
          const wording = await this.engine.directedWording(job, destination, message, materials, args.text);
          if (wording?.review_error) return wording;
          return { authorization_id: message.id, dispatch_id: message.id, materials, presentation, formatted: wording?.text ?? formatted,
            wording_source: wording?.source, required_text: wording?.text ?? (presentation.length ? formatted : undefined),
            fields_only: Boolean(wording || formatted !== undefined || grant.fields_only || materials.length === 1 && !presentation.length), versions: sources.versions };
        }
      }
      inspect = true;
    }
    if (!inspect) return null;
    return reviewCurrent(sources, () => publicationSources(this.platform, args, context, destination));
  }

  async workCardReview(context, args, destination) {
    if (context.conversation.space.id !== destination.id) return;
    const active = this.active.get(context.conversation.id);
    const receipts = active?.publication?.local_receipts;
    if (active?.runId === context.origin.run_id && active.publication?.transported &&
        active.publication.audience.destination.id === destination.id && (receipts?.incoming.length || receipts?.intake.length)) {
      await this.engine.reviewReceiptClaims(active, receipts, args.text);
    }
    const label = args.work_reply;
    const selected = label && this.platform.executions.record(sessionRef(label.session.id ?? label.session));
    if (label && (selected?.owner_conversation_id !== context.conversation.id || selected.origin_room?.id !== destination.id)) return;
    const publication = active?.runId === context.origin.run_id && active.publication?.transported &&
      active.publication.audience.destination.id === destination.id && active.publication.audience.release?.work_evidence;
    const address = args.reply_to?.id ?? args.reply_to ?? selected?.origin_message_id ?? publication?.original_question;
    if (!address) return;
    const linked = roomQuestionLinks(this.platform, destination, [{ id: address }]);
    if (selected && !linked.has(selected.origin_message_id)) return;
    const peers = this.platform.executions.directWork(context.conversation.id).filter(work => work.origin_execution?.kind === 'conversation' &&
      work.origin_room?.id === destination.id && linked.has(work.origin_message_id));
    const questions = new Set(peers.map(work => work.origin_message_id));
    const root = selected?.origin_message_id ?? (questions.has(address) ? address : questions.size === 1 ? [...questions][0] : null);
    if (!root) return;
    const job = this.active.get(context.conversation.id);
    if (job?.runId !== context.origin.run_id) return;
    const evidence = () => {
      const sessions = this.platform.executions.directWork(context.conversation.id).filter(work => work.origin_execution?.kind === 'conversation' &&
        work.origin_room?.id === destination.id && work.origin_message_id === root);
      if (!sessions.length) return;
      const sources = publicationSources(this.platform, { ...args, publication: undefined }, context, destination, root);
      if (!sources) return;
      const linkedCards = new Set(sources.original_cards.map(card => card.id));
      const replies = this.platform.executions.originalReplies(sessions[0]);
      const published = replies.filter(({ message }, index) => index >= replies.length - 8 || linkedCards.has(message.id)).map(({ message, stage }) => ({
        id: message.id, time: message.createdAt, text: message.content, stage, covered_sessions: this.platform.store.get('platform-calls', message.callId)?.work_review?.covered_sessions,
        attachments: message.attachments?.map(file => file.id), references: message.references }));
      if (!published.length && !sources.versions.results.length &&
          !sessions.some(work => work.acceptance_state === 'open' && (work.waiting_summary || work.pending_input?.length))) return;
      const request = this.platform.store.get('messages', address);
      return { original: root, reply_request: request?.roomId === destination.id ? { id: address, text: request.content } : undefined,
        host_instructions: sources.localOrders.map(item => ({ id: item.id, time: item.createdAt, replies_to: item.replyTo, text: item.content })),
        authorized_fields: publication?.original_question === root ? publication.fields : [],
        own_deliveries: roomPublicationReceipts(this.platform, context.actor, context.conversation, linked),
        seats: sessions.map(work => {
          const seat = sources.versions.seats.find(seat => seat.id === work.id);
          return { id: work.id, state: work.status, waiting: work.waiting_summary,
          acceptance_state: work.acceptance_state, acceptance: this.platform.executions.acceptanceView(work, context),
          current: seat?.current, replaces: work.replaces_session,
          replacement_authorized: Boolean(work.replacement_authorization), assignment: work.work_summary,
          original_inputs: seat?.input_receipts, receipts: seat?.receipts, dispositions: seat?.dispositions,
          accepts_followup: seat?.accepts_followup, followup_rooms: seat?.followup_rooms,
          received_originals: this.platform.roomWork.receivedOriginals(work, context).map(({ id, input_status }) => ({ id, input_status })),
          result: work.latest_call_id, input_revision: work.input_revision };
        }),
        results: sources.versions.results.map(id => ({ id, session: sources.versions.seats.find(seat => seat.result === id)?.id,
          text: sources.facts.get(id) })), published,
        proposal: { text: args.text, attachments: args.attachments?.map(item => item.id ?? item), references: args.references } };
    };
    const view = evidence();
    if (!view) return;
    const position = JSON.stringify(view);
    if (position === job.workCardReview?.position) return job.workCardReview.result;
    const result = { ...await this.engine.reviewWorkCard(job, view), original_question: root };
    const accepted = view.seats.filter(seat => seat.current && seat.acceptance?.outcome === 'delivered').map(seat => seat.acceptance.message_id);
    const previous = view.published.find(card => card.id === result.effective_card?.id && accepted.includes(card.id)) ??
      view.published.findLast(card => accepted.includes(card.id));
    if (previous && (result.stage === 'complete' || args.work_reply?.stage === 'correction')) {
      const deliveries = view.own_deliveries.map(item => ({ id: item.message_id, kind: 'outgoing_receipt',
        time: item.time, destination: item.destination, status: item.status, text: item.text ?? item.fields.join(' ') }));
      const operations = view.seats.flatMap(seat => seat.dispositions.map(row => ({ id: row.call, kind: 'owner_operation', time: row.time,
        text: JSON.stringify({ session: seat.id, operation: row.operation, status: row.status, effective_card: row.actual_card, requested_card: row.requested_card }) })));
      const change = await this.engine.assessCardChange(job, { previous, proposal: view.proposal, host: view.host_instructions,
        results: [...view.results, ...deliveries, ...operations] });
      if (change?.mode === 'same') Object.assign(result, { retained_id: previous.id, retained_stage: 'complete' });
      else if (change?.identifies_previous && !change.claims_new_link && (change.mode !== 'replacement' || result.effective_card?.use === 'draft')) {
        delete result.retained_id;
        delete result.retained_stage;
        result.change = change;
        if (change.mode === 'addendum') result.effective_card = { use: 'existing', id: previous.id };
      }
      else throw runtimeFailure('work_card_change_required', 'Identify the accepted card and the authorized substantive change. State whether this is a supplement or a proposed replacement. Link accepted sessions after the replacement is delivered.', 409,
        { card_correction: { check: 'correction target', previous_card: previous.id, existing_links: accepted,
          requested_change: change?.mode, draft_already_linked: false } });
    }
    if (position !== JSON.stringify(evidence()))
      throw runtimeFailure('work_review_changed', 'The original work received new evidence while its card was being reviewed. Read the current position.', 409);
    job.workCardReview = { position, result };
    return result;
  }

  pendingCardActions(job) {
    const { conversation, inbox, runId } = job;
    if (conversation.kind !== 'room') return [];
    const work = this.platform.executions.directWork(conversation.id).filter(seat => sameRef(seat.origin_room, conversation.space) &&
      seat.owner.id === inbox.botId && !seat.authority_revoked);
    if (!work.length) return [];
    const actions = new Map();
    for (const call of inbox.calls(runId)) {
      if (call.state !== 'completed') continue;
      if (call.tool === 'configure_session' && call.args.acceptance_state === 'closed' && call.args.delivery_message_id) {
        const requested = call.args.delivery_message_id.id ?? call.args.delivery_message_id;
        const seat = work.find(item => item.id === (call.args.target.id ?? call.args.target));
        if (seat?.acceptance?.outcome !== 'delivered' || seat.acceptance.message_id === requested ||
            call.result?.acceptance?.message_id !== seat.acceptance.message_id) continue;
        const next = this.platform.store.get('messages', requested);
        const review = next && this.platform.calls.get(next.callId)?.work_review;
        if (next?.replyTo === seat.origin_message_id && next.roomId === conversation.space.id &&
            review?.stage === 'complete' && review.covered_sessions?.includes(seat.id))
          actions.set(seat.id, { action: 'review_unapplied_link', session: seat.id, question: seat.origin_message_id,
            accepted_card: seat.acceptance.message_id, requested_card: requested });
      }
      if (call.tool !== 'send' || !call.result?.message?.id) continue;
      const sent = this.platform.store.get('messages', call.result.message.id);
      const delivery = sent && this.platform.calls.get(sent.callId), review = delivery?.work_review;
      if (delivery?.id !== call.id || sent.roomId !== conversation.space.id || review?.stage !== 'complete' ||
          review.change?.mode === 'addendum' || review.effective_card && review.effective_card.use !== 'draft' || sent.replyTo !== review.original_question) continue;
      const newer = work.some(seat => seat.origin_message_id === sent.replyTo && !seat.replaces_session && seat.acceptance_state === 'open' &&
        !work.some(other => other.replaces_session === seat.id && other.replacement_authorization && !other.authority_revoked) &&
        seat.latest_call_id && this.platform.calls.get(seat.latest_call_id)?.updatedAt > sent.createdAt);
      if (newer) continue;
      for (const seat of work.filter(item => item.origin_message_id === sent.replyTo && item.acceptance_state === 'open')) {
        if (seat.status !== 'completed' || !seat.latest_call_id) continue;
        const terminal = this.platform.calls.get(seat.latest_call_id);
        if (!terminal || terminal.updatedAt > sent.createdAt) continue;
        const used = review.covered_sessions?.includes(seat.id);
        if (used || seat.replaces_session && !seat.replacement_authorization && review.covered_sessions?.includes(seat.replaces_session)) {
          const receipts = !used && this.platform.roomWork.seatReceipts(seat, this.platform.context(job.context()));
          actions.set(seat.id, { action: used ? 'review_delivered_result' : 'record_unused_work_disposition',
            session: seat.id, question: sent.replyTo, card: sent.id, terminal_state: seat.status,
            ...(receipts && { initial_result: receipts.initial_result, later_received_inputs: receipts.received_input_count }) });
        }
      }
    }
    return [...actions.values()];
  }

  async reviewDeliveryRebind(context, args) {
    const work = this.platform.executions.require({ kind: 'session', id: args.target.id ?? args.target }, context, 'control');
    const requested = args.delivery_message_id.id ?? args.delivery_message_id;
    const prior = work.acceptance?.outcome === 'delivered' ? work.acceptance : work.previous_delivery;
    if ((!prior && work.acceptance_state !== 'closed') || prior?.message_id === requested) return;
    const parent = context.conversation, job = this.active.get(parent?.id);
    if (context.session || !job || job.runId !== context.origin.run_id || work.owner.id !== context.actor.id ||
        work.origin_execution?.kind !== 'conversation' || work.owner_conversation_id !== parent.id || !sameRef(work.origin_room, parent.space))
      throw runtimeFailure('delivery_rebind_forbidden', 'Only the active direct owner in the original Room can replace this acceptance link.', 403);
    const unchanged = reason => runtimeFailure('delivery_link_unchanged', 'The existing delivery link is still effective. Select a later authorized replacement covering this seat.', 409,
      { session: work.id, accepted_card: prior?.message_id, requested_card: requested, reason });
    const replies = this.platform.executions.originalReplies(work);
    const previous = replies.find(item => item.message.id === prior?.message_id)?.message;
    const next = replies.find(item => item.message.id === requested)?.message;
    const review = next && this.platform.calls.get(next.callId)?.work_review;
    if (args.close_reason || !prior || !previous || !next || next.createdAt <= previous.createdAt) throw unchanged('card_pair');
    if (review?.stage !== 'complete' || review.original_question !== work.origin_message_id || !review.covered_sessions?.includes(work.id) ||
        review.change?.mode === 'addendum' || review.effective_card && review.effective_card.use !== 'draft') throw unchanged('coverage');
    const evidence = () => {
      const sources = publicationSources(this.platform, { reply_to: work.origin_message_id }, context, work.origin_room, work.origin_message_id);
      const seat = this.platform.executions.record(sessionRef(work.id));
      const currentPrior = seat?.acceptance?.outcome === 'delivered' ? seat.acceptance : seat?.previous_delivery;
      if (currentPrior?.message_id !== prior.message_id || seat.authority_revoked || seat.control?.state !== 'active' ||
          !sources?.versions.seats.some(item => item.id === work.id && item.current && item.result)) return;
      const grants = new Set(sources.localOrders.map(item => item.id));
      const host = sources.hostMessages.map(item => ({ id: item.id, time: item.createdAt, text: item.content, may_authorize: grants.has(item.id) }));
      const basis = { owner: context.actor.id, parent: parent.id, room: work.origin_room.id, question: work.origin_message_id,
        previous: previous.id, next: next.id, publish_call: next.callId, covered: [...review.covered_sessions].sort(),
        host: host.map(item => [item.id, item.may_authorize]), results: sources.versions.results,
        seats: sources.versions.seats.map(item => {
          const owner = this.platform.executions.record(sessionRef(item.id));
          return [item.id, item.current, item.result, owner.input_revision, owner.control?.control_version, owner.control?.state,
            owner.revocation_call_id ?? null, Boolean(owner.authority_revoked), owner.allowed_followup_rooms ?? []];
        }) };
      return { basis, original_question: work.origin_message_id, previous: { id: previous.id, text: previous.content },
        proposal: { id: next.id, text: next.content }, disposition_request: { requested, note: args.disposition_note },
        host, results: sources.versions.results.map(id => ({ id, text: sources.facts.get(id) })) };
    };
    const view = evidence();
    if (!view) throw unchanged('owner_or_source_changed');
    const basis = JSON.stringify(view.basis);
    const completed = this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='platform-calls'
      AND json_extract(data,'$.tool')='configure_session' AND json_extract(data,'$.status')='completed'
      AND json_extract(data,'$.origin.conversation_id')=? AND json_extract(data,'$.delivery_rebind.previous')=?
      AND json_extract(data,'$.delivery_rebind.requested')=? AND json_extract(data,'$.result.acceptance.message_id')=? ORDER BY rowid DESC`)
      .all(parent.id, previous.id, requested, requested).map(row => JSON.parse(row.data));
    const sibling = completed.find(call => call.origin.bot_id === context.actor.id && call.result?.id === call.target?.id &&
      call.target?.id === call.delivery_rebind.session && view.basis.covered.includes(call.result.id) &&
      call.result.acceptance.outcome === 'delivered' && call.delivery_rebind.mode === 'replacement' &&
      JSON.stringify(call.delivery_rebind.basis) === basis);
    const certified = sibling?.delivery_rebind;
    const change = certified ? { mode: 'replacement', authorization: certified.authorization, source: certified.source, verified_by_call: sibling.id } :
      await this.engine.assessCardChange(job, view);
    if (change?.mode !== 'replacement' || !view.host.some(item => item.may_authorize && item.id === change.authorization) ||
        !view.results.some(item => item.id === change.source)) throw unchanged('replacement_authority');
    if (JSON.stringify(evidence()?.basis) !== basis) throw unchanged('source_changed_during_review');
    return { ...change, previous: previous.id, requested, session: work.id, basis: view.basis,
      control_version: work.control.control_version, input_revision: work.input_revision };
  }

  async reviewDispositionNote(context, args) {
    const work = this.platform.executions.require(sessionRef(args.target.id ?? args.target), context, 'control');
    const parent = context.conversation, amended = args.amend_disposition_note === true;
    const owned = context.actor.kind === 'bot' && !context.session && parent?.kind === 'room' && work.owner?.id === context.actor.id &&
      work.owner_conversation_id === parent.id && sameRef(work.origin_execution, conversationRef(parent.id)) && sameRef(work.origin_room, parent.space);
    if (!owned && !amended) return;
    if (!owned || amended && (work.acceptance_state !== 'closed' || !['superseded', 'cancelled', 'private'].includes(work.acceptance?.outcome)))
      throw runtimeFailure('disposition_note_forbidden', 'The original Room parent can amend the explanation on its own closed unused work.', 403);
    const note = args.disposition_note?.trim();
    if (!note || amended && Object.keys(args).some(key => !['target', 'amend_disposition_note', 'disposition_note'].includes(key)))
      throw runtimeFailure('invalid_disposition', 'To amend an explanation supply the target, amend_disposition_note and the corrected disposition_note.', 409);
    const job = this.active.get(parent.id);
    if (job?.runId !== context.origin.run_id) throw runtimeFailure('disposition_note_forbidden', 'Use the active original owner conversation.', 403);
    const position = this.platform.executions.dispositionNotePosition(work);
    const seat = { id: work.id, receipts: this.platform.roomWork.seatReceipts(work, context) };
    await this.engine.reviewDispositionRationale(job, seat, note);
    return { position };
  }

  publicFile(job, room, ref) {
    if (ref?.kind !== 'file' || !withinPublicationRoom(this.platform, ref, room)) return false;
    const context = this.platform.context(job.context());
    try {
      const destination = this.platform.room.room(room.id, context.actor.id);
      this.platform.assertShareable(ref, { actor: context.actor, room: destination, context });
      return this.platform.files.getProjection(ref.id, context).projection;
    } catch (error) {
      if ([403, 404, 409].includes(error.status)) return false;
      throw error;
    }
  }

  publicationEvidence(job, audience, includeHistory = true) {
    if (audience.cross_room) {
      const selection = publicationSelection(audience.release);
      return { selection, history: [], requests: [], locations: [], originWork: [], actions: [], files: [], pages: [] };
    }
    const room = { kind: 'room', id: audience.destination.id };
    const calls = job.inbox.calls(job.runId);
    const refIds = new Set();
    for (const call of calls) {
      if (audience.cross_room || call.state !== 'completed') continue;
      if (call.tool === 'read' && call.args.ref.kind === 'session') refIds.add(call.args.ref.id);
      if (['open_session', 'configure_session'].includes(call.tool) && call.result?.id) refIds.add(call.result.id);
      if (call.tool === 'find' && call.args.kind === 'session' && call.args.query?.trim() && call.result?.items?.length === 1)
        refIds.add(call.result.items[0].id);
      if (call.tool === 'read' && call.args.ref.kind === 'room' && call.args.ref.id !== room.id) {
        const candidates = this.platform.executions.followupSessions(job.inbox.botId, call.args.ref.id);
        if (candidates.length === 1) refIds.add(candidates[0].id);
      }
    }
    const locations = [];
    for (const id of refIds) {
      const work = this.platform.executions.record(sessionRef(id));
      if (!work?.origin_room || !this.platform.canReadSpace(work.owner, work.origin_room) ||
          !this.platform.canReadSpace(botRef(job.inbox.botId), work.origin_room)) continue;
      const originRoom = this.platform.store.get('rooms', work.origin_room.id);
      const local = originRoom.id === room.id;
      if (!local && !work.allowed_followup_rooms?.includes(room.id)) continue;
      const open = work.acceptance_state === 'open' && !work.authority_revoked && work.control.state === 'active';
      locations.push({ ...(local && { origin_room: originRoom.name }), intake_rooms: open ?
        this.platform.roomWork.intakes(work, botRef(job.inbox.botId)).filter(item => local || item.id === room.id).map(item => item.name) : [], accepts_followup: open });
    }
    const material = this.materials.publication(job, room);
    const pages = new Map();
    for (const call of calls) {
      if (call.state !== 'completed' || call.tool !== 'read' || call.args.ref?.kind !== 'file') continue;
      const result = call.result;
      const file = this.publicFile(job, room, call.args.ref);
      if (!file || file.id !== result?.id || file.revision !== result.revision) continue;
      const cursor = Number(call.args.cursor ?? 0);
      const content = typeof result.content === 'string' ? result.content.slice(0, 20000) : undefined;
      pages.set(recordKey(file.id, cursor), { file: { kind: 'file', id: file.id }, name: file.name, revision: file.revision,
        cursor, content, next_cursor: content && result.content.length > content.length ? String(cursor + content.length) : result.next_cursor,
        content_status: result.content_status, ...(result.content_status === 'image' && { image_call: call.model_call_id }) });
    }
    const selectedPages = [...pages.values()];
    const inputs = new Set([...audience.current_message_ids, audience.reply_to].filter(Boolean));
    const requests = [...inputs].map(id => this.platform.store.get('messages', id))
      .filter(item => item?.roomId === room.id).map(roomEvent);
    const roots = roomQuestionLinks(this.platform, room, requests);
    for (const id of job.context().origin.event_ids) {
      const event = this.platform.store.get('platform-events', id);
      if (event?.owner_conversation_id === job.conversation.id && sameRef(event.origin_room, room)) roots.add(event.origin_message_id);
    }
    const ownerContext = this.platform.context(job.context());
    const originWork = this.platform.executions.directWork(job.conversation.id)
      .filter(work => sameRef(work.origin_room, room) && (roots.has(work.origin_message_id) || work.owner_run_id === job.runId))
      .map(work => {
        const terminal = this.platform.store.get('platform-calls', work.latest_call_id);
        const result = terminal?.result_ref?.kind === 'event' && this.platform.store.get('platform-events', terminal.result_ref.id);
        const steps = requests.filter(item => item.author?.kind === 'user' && roomQuestionLinks(this.platform, room, [item]).has(work.origin_message_id))
          .map(item => item.id);
        return { original_question: work.origin_message_id, session: work.id, replaces: work.replaces_session,
          replacement_authorized: Boolean(work.replacement_authorization), engine: work.engine === 'pi' ? 'Pi' : this.platform.connections.get(work.engine)?.kind,
          status: work.status, acceptance_state: work.acceptance_state, acceptance: this.platform.executions.acceptanceView(work, ownerContext),
          final_result_received: result?.status === 'completed' && result.target?.id === work.id,
          selected_inputs: this.platform.roomWork.materialStatus(work, steps, true).filter(item => item.call_status), intake_rooms: this.platform.roomWork.intakes(work).map(item => item.name) };
      });
    const intake = audience.cross_room ? null : this.roomIntake(job.inbox.botId, audience.destination, requests);
    const actions = calls.filter(call => ['save_file', 'configure_bot', 'open_session', 'configure_session'].includes(call.tool))
      .map(call => ({ action: call.tool, status: call.state, code: call.result?.code }));
    actions.push(...roomPublicationReceipts(this.platform, ownerContext.actor, job.conversation, roots)
      .map(receipt => ({ action: 'send', ...receipt })));
    for (const call of calls.filter(item => item.tool === 'send_input')) {
      const native = this.platform.store.get('platform-calls', call.id);
      const target = native?.target?.kind === 'session' && this.platform.executions.record(native.target);
      if (target?.origin_room?.id !== room.id || target.owner_conversation_id !== job.conversation.id) continue;
      const input = native.input_id && this.platform.store.get('platform-inputs', native.input_id);
      const sources = (native.material_action_ids ?? native.material_source_ids ?? []).filter(id => inputs.has(id));
      if (sources.length) actions.push({ action: 'send_input', engine: target.engine === 'pi' ? 'Pi' : this.platform.connections.get(target.engine)?.kind,
        sources, status: native.status, input_status: input?.call_id === native.id ? input.status : 'unconfirmed' });
    }
    const incoming = this.platform.store.db.prepare(`SELECT data FROM records WHERE kind='messages'
      AND json_extract(data,'$.roomId')=? AND json_array_length(data,'$.authorized_publication.fields')>0 ORDER BY rowid DESC LIMIT 12`)
      .all(room.id).map(row => JSON.parse(row.data)).flatMap(message => {
        const call = message.callId && this.platform.store.get('platform-calls', message.callId);
        return call?.directed_publication && call.status === 'completed' && call.result?.message?.id === message.id &&
          sameRef(call.target, room) ? [{ action: 'received_publication', room_role: 'recipient', sender: message.author,
            from_another_room: true, same_bot_as_current: message.senderId === job.inbox.botId,
            destination: room, message_id: message.id, time: message.createdAt, fields: message.authorized_publication.fields }] : [];
      });
    actions.push(...incoming);
    const selection = JSON.stringify([locations, originWork, intake?.receives_materials_here, intake?.receipts, actions, material?.content,
      selectedPages.map(page => [page.file.id, page.revision, page.cursor])]);
    if (!includeHistory) return { selection };
    const snapshot = this.platform.room.publicHistory(room.id, job.inbox.botId);
    const fileIds = new Set(selectedPages.map(page => page.file.id));
    for (const message of [...requests, ...snapshot.messages]) {
      for (const ref of [...(message.attachments || []), ...(message.references || []).filter(ref => ref.kind === 'file')])
        if (ref.id) fileIds.add(ref.id);
    }
    const files = [...fileIds].filter(id => this.publicFile(job, room, { kind: 'file', id }));
    return { history: snapshot.messages.map(roomEvent), material, summary: snapshot.summary, end: snapshot.end,
      locations, intake, actions, selection, pages: selectedPages, requests, files, originWork };
  }

  syncDelivery(inbox, receipt) {
    if (!receipt?.accepted || (!receipt.processed && !receipt.waits.length)) return;
    const { delivery_id, revision, processed, waits, result_access } = receipt;
    this.platform.consumeDelivery(inbox.botId, delivery_id, { revision, processed, waits, result_access });
  }

  binding(bot, conversation) {
    if (conversation.binding) return conversation.binding;
    const purpose = conversation.kind === 'fast_read' ? 'fast_read' : 'conversation';
    const resolved = this.platform.models.resolveForBot(bot, purpose);
    const blocker = this.platform.modelAccessBlocker(botRef(bot.id), resolved?.connection_id);
    if (blocker) throw runtimeFailure('connection_forbidden', blocker.message, 403);
    return { name: bot.name, instructions: bot.instructions, public_duty: bot.public_duty || '', revision: bot.revision,
      built_in_role: bot.built_in_role ?? null, model: bindModel(this.model, resolved, purpose), material_index_ref: bot.material_index_ref };
  }

  launch(inbox, conversation, run, bot) {
    this.starting.set(conversation.id, Promise.resolve().then(async () => {
      if (this.draining || this.closed || this.platform.draining) return;
        const binding = run.binding || this.binding(bot, conversation);
      const controller = new AbortController();
      const refs = { conversation_id: conversation.id, bot_id: bot.id, run_id: run.id };
      const job = this.job(inbox, conversation, run, bot, binding, controller);
      let settle;
      job.done = new Promise(resolveDone => { settle = resolveDone; });
      this.active.set(conversation.id, job);
      try {
        job.check();
        inbox.putRun({ id: run.id, state: 'running', binding, retry_at: null, error: null, view_revision: run.view_revision,
          ...(conversation.kind === 'room' && run.start_count && ['retry', 'interrupted'].includes(run.state) ? { recovering_room_inputs: true } : {}),
          first_started_at: run.first_started_at ?? now(), start_count: (run.start_count ?? 0) + 1 });
        this.emit('engine.started', refs);
        await this.recoverCalls(job);
        await this.restoreRoomDraft(job);
        const storedOutcome = inbox.run(run.id).model_outcome;
        const pendingForRun = () => inbox.pending().filter(route => route.run_id === run.id);
        const canProcess = route => this.routeReady(inbox, route);
        const pendingNow = pendingForRun().filter(canProcess);
        const startView = job.view();
        const restored = storedOutcome && !this.pendingCardActions(job).length && pendingNow.every(route => storedOutcome.eventIds.includes(route.event_id)) &&
          !this.outstandingRoomReplies(inbox, conversation.space, storedOutcome.eventIds).length &&
          !this.unsettledForwardReturns(job, storedOutcome.eventIds).length &&
          canRetainAuthorizationView(inbox.run(run.id).model_outcome_uses_view, startView.view_revision) &&
          (!storedOutcome.observation || canReadObservation(storedOutcome.observation.checkpoint, job, startView)) ? storedOutcome : null;
        const result = this.materials.recovered(job) || restored || await this.engine.execute(job);
        job.check();
        this.materials.finish(job);
        const view = job.view();
        const cancelledProgress = [];
        if (result.observation) {
          if (!canReadObservation(result.observation.checkpoint, job, view))
            throw runtimeFailure('access_changed', 'Room observation access changed before completion', 409);
          // Persist the private decision first so a recovered delivery can publish the same position.
          inbox.store.putRecord(R.checkpoint, result.observation.checkpoint);
          if (!this.platform.deliveries.finishObservation(bot.id, conversation.space.id, result.observation)) {
            inbox.putRun({ id: run.id, model_outcome: null, model_outcome_uses_view: null });
            throw runtimeFailure('access_changed', 'The room observation changed before completion', 409);
          }
        }
        const state = inbox.store.transaction(() => {
          inbox.complete(run.id, 'running', result.eventIds, { result: { text: result.text, model: result.model, response_id: result.response_id },
            ...(result.observation && { room_observation: { from: result.observation.from, through: result.observation.through,
              generation: result.observation.generation, checkpoint_id: result.observation.checkpoint.id } }) },
            canProcess, view.canReadEvent);
          const outstanding = inbox.hasOpenWaits(run.id);
          const settledProgress = pendingForRun().filter(route => this.settledProgress(inbox, route));
          for (const { event, ...route } of settledProgress) {
            inbox.store.putRecord(R.route, { ...route, state: 'cancelled' });
            cancelledProgress.push(route.event_id);
          }
          const pending = pendingForRun();
          const next = pending.some(canProcess) ? 'pending' : outstanding || pending.length || result.waiting_for_children ? 'waiting' : 'completed';
          inbox.putRun({ id: run.id, state: next, model_outcome: null, model_outcome_uses_view: null,
            ...(run.transport_retry && { transport_retry: null }) });
          if (next === 'completed' || next === 'waiting') this.stageInputs(inbox, conversation, run.id, next, result);
          return next;
        });
        this.flushInputs(inbox);
        this.consumeDeliveries(inbox, [...result.eventIds, ...cancelledProgress]);
        this.emit('engine.finished', { ...refs, state, model: result.model });
      } catch (error) {
        const code = error.code || 'runtime_error';
        let transportRetry;
        if (code === 'model_transport_interrupted' && !controller.signal.aborted) {
          const latest = inbox.run(run.id);
          const completed = inbox.transcript(run.id).findLast(message => message.role === 'toolResult' ||
            message.role === 'assistant' && ['stop', 'toolUse'].includes(message.stopReason));
          const position = recordKey(latest.input_revision, latest.injected_event_ids.at(-1), completed?.timestamp);
          const attempts = latest.transport_retry?.position === position ? latest.transport_retry.attempts + 1 : 1;
          transportRetry = { position, attempts };
        }
        const retry = code === 'resource_limit' || !controller.signal.aborted &&
          (transportRetry?.attempts <= 2 || ['access_changed', 'connection_unavailable', 'updating', 'call_result_unknown'].includes(code));
        const retryAt = retry ? (error.details?.resource === 'models' ? Date.now() + 1000 : Date.parse(error.details?.resets_at) ||
          Date.now() + (transportRetry?.attempts === 2 ? 30000 : 10000)) : null;
        const roomRevoked = code === 'execution_not_found' && conversation.kind === 'room' &&
          !this.platform.canReadSpace(botRef(bot.id), conversation.space);
        const controlStopped = controller.signal.aborted && ['execution_paused', 'bot_paused'].includes(controller.signal.reason?.code);
        const stopped = controller.signal.aborted || code === 'execution_paused' || code === 'bot_paused';
        const diagnostic = this.clean.error(cleanError(error));
        inbox.putRun({ id: run.id, state: retry ? 'retry' : roomRevoked ? 'access_revoked' : stopped ? 'interrupted' : 'suspended',
          retry_at: retryAt ? new Date(retryAt).toISOString() : null,
          error: diagnostic, ...(transportRetry && { transport_retry: transportRetry }) });
        if (roomRevoked) this.discard(inbox, inbox.pending().filter(route => route.run_id === run.id), 'access_revoked');
        if (!retry && !stopped && conversation.kind === 'room' && conversation.space.kind === 'room')
          this.platform.deliveries.releaseSuspendedObservation(bot.id, conversation.space.id, inbox.run(run.id).pending_event_ids);
        if (!retry) this.materials.defer(job);
        if ((!retry && !stopped) || (controlStopped && (this.targetPaused(conversationRef(conversation.id)) ||
            conversation.session_id && this.targetPaused(sessionRef(conversation.session_id))))) {
          this.stageInputs(inbox, conversation, run.id, controlStopped ? 'stopped' : roomRevoked ? 'failed' : 'unknown');
          this.flushInputs(inbox);
        }
        this.emit('engine.interrupted', { ...refs, ...diagnostic });
      } finally {
        this.active.delete(conversation.id);
        try {
          for (const target of [conversationRef(conversation.id), ...(conversation.session_id ? [sessionRef(conversation.session_id)] : [])]) {
            const latest = this.platform.executions.record(target);
            if (latest?.control?.state === 'paused' && latest.control.stop_status === 'pending')
              this.platform.executions.saveControl(target, { ...latest.control, stop_status: 'stopped' });
          }
        } finally { settle(); }
      }
    }).catch(error => {
      const transient = error.status === 503 || error.code === 'resource_limit';
      if (!transient && conversation.kind === 'room' && conversation.space.kind === 'room')
        this.platform.deliveries.releaseSuspendedObservation(bot.id, conversation.space.id, inbox.run(run.id).pending_event_ids);
      inbox.putRun({ id: run.id, state: transient ? 'retry' : 'suspended', retry_at: transient ? new Date(Date.now() + 30000).toISOString() : null,
        error: this.clean.error(cleanError(error)) });
      this.emit('engine.runtime_error', { bot_id: bot.id, run_id: run.id, ...this.clean.error(cleanError(error)) });
    }).finally(() => { this.starting.delete(conversation.id); }));
  }

  job(inbox, conversation, run, bot, binding, controller) {
    const target = conversationRef(conversation.id);
    const record = () => this.registered(conversation);
    const authority = this.platform.executions.record(conversation.session_id ? sessionRef(conversation.session_id) : target);
    const control = record()?.control || conversation.control;
    const actor = botRef(bot.id);
    const session = conversation.session_id ? sessionRef(conversation.session_id) : null;
    const botVersion = bot.control?.control_version;
    const controls = [{ target: botRef(bot.id), control_version: botVersion }, { target, control_version: control.control_version }];
    if (session) controls.push({ target: session, control_version: authority?.control?.control_version });
    const context = () => {
      const latest = inbox.run(run.id);
      const event_ids = latest.injected_event_ids;
      const source = event_ids.map(id => inbox.event(id)).find(event => event?.author?.kind === 'user');
      const input_refs = session ? event_ids.flatMap(id => {
        const event = inbox.event(id);
        if (event?.type !== 'pi.input') return [];
        const call = this.platform.store.get('platform-calls', event.call_id);
        const recipient = this.platform.executions.record(session);
        if (!sameRef(call?.target, session) || !recipient || !this.canReadPiInput(event, recipient)) return [];
        const ids = call.material_source_ids ?? (call.origin?.fast_read_forward ? call.source_event_ids.slice(0, 1) : []);
        return ids.flatMap(id => {
          const message = this.platform.store.get('messages', id);
          return this.platform.roomWork.canHandOff(message, recipient, actor, true) ? forwardMaterials(message) : [];
        });
      }) : [];
      return { actor, execution_actor: actor, controls, submitted_by: latest.submitted_by || source?.author || actor,
        input_refs, signal: controller.signal, origin: { bot_id: bot.id, conversation_id: conversation.id, run_id: run.id,
          event_ids, control_version: control.control_version, session_id: conversation.session_id || null } };
    };
    const check = () => {
      controller.signal.throwIfAborted();
      if (this.closed) throw runtimeFailure('runtime_closed', 'The Bot runtime is closing', 503);
      if (this.draining) throw runtimeFailure('updating', 'New model or tool calls are paused for the update window', 503);
      const currentBot = this.platform.getBot(bot.id);
      if (!currentBot.enabled || currentBot.control?.control_version !== botVersion)
        throw runtimeFailure('bot_paused', 'The Bot is paused', 409);
      const current = this.registered(conversation)?.control || conversation.control;
      if (current.state !== 'active' || current.control_version !== control.control_version)
        throw runtimeFailure('execution_paused', 'The conversation control version changed', 409);
      if (!this.platform.canUseModel(actor, binding.model.connection_id)) throw runtimeFailure('connection_forbidden', 'The model connection is no longer authorized', 403);
      const currentSession = session && this.platform.executions.record(session);
      if (session && (currentSession?.control?.state !== 'active' || currentSession.control.control_version !== authority?.control?.control_version))
        throw runtimeFailure('execution_paused', 'The Session control version changed', 409);
      this.platform.assertRunAllowed?.(context());
    };
    const job = { inbox, conversation, runId: run.id, binding, controller, signal: controller.signal, context, check, accepting: true,
      canRetainAuthorizationView,
      view: () => {
        const view = this.authorizationView(context(), conversation, inbox, inbox.run(run.id));
        inbox.attachReturnWaits(conversation.id, run.id, view.pending_return_waits);
        return view;
      },
      refresh: window => this.contextBoundary(job, window),
      publicationEvidence: audience => this.publicationEvidence(job, audience),
      pendingCardActions: () => this.pendingCardActions(job),
      publicFile: (room, ref) => this.publicFile(job, room, ref),
      outstandingReplies: ids => this.outstandingRoomReplies(inbox, conversation.space, ids),
      unsettledForwards: ids => this.unsettledForwardReturns(job, ids),
      canReadReference: ref => this.platform.canReadReference(ref, this.platform.context(context())),
      materials: () => this.materials.boundary(job),
      checkInstallation: () => this.checkInstallation(),
      hasNewInput: ids => inbox.pending().some(route => route.run_id === run.id && !ids.includes(route.event_id) && this.routeReady(inbox, route)),
      finishInput() { job.accepting = false; },
    };
    return job;
  }

  authorizationView(context, conversation, inbox, run) {
    const view = this.platform.executionView(context);
    const access = this.platform.accessFor(context.actor);
    const rooms = view.session ? [view.session.space].filter(space => space.kind === 'room') :
      this.platform.room.rooms(context.actor.id).map(room => room.ref).sort((left, right) => left.id.localeCompare(right.id));
    const scope = [conversation.space, rooms, view.resources ?? [], scopeGrants(access)];
    const projectRoom = this.platform.projectRoom(view);
    const projectWorkspace = projectRoom && this.platform.store.get('rooms', projectRoom.id)?.workspace;
    if (projectWorkspace) {
      const grant = this.platform.workspaceRecords().find(item => sameRef(projectWorkspace, { kind: 'workspace', id: item.id }));
      scope.push({ project_room: projectRoom.id, workspace: projectWorkspace.id, path: grant?.path, write: grant?.write });
    }
    const observation = conversation.kind === 'room' && conversation.space.kind === 'room' &&
      this.platform.deliveries.roomObservation(context.actor.id, conversation.space.id);
    if (observation) scope.push({ room_observation: observation.generation });
    if (view.maintained_connection_ids?.length) scope.push({ maintained_connection_ids: view.maintained_connection_ids });
    if (view.revoked_return_waits?.length) scope.push(view.revoked_return_waits);
    const canReadPiInput = event => !view.session || this.canReadPiInput(event, view.session);
    const events = sortedIds([...run.pending_event_ids, ...run.injected_event_ids]).map(id => inbox.event(id)).filter(Boolean);
    const revokedInputs = events.filter(event => event.type === 'pi.input' && !canReadPiInput(event)).map(event => event.id);
    if (revokedInputs.length) scope.push({ revoked_inputs: revokedInputs });
    const revokedEvents = events.filter(event => protectedEvent(event) && !view.canReadEvent(event)).map(event => event.id);
    if (revokedEvents.length) scope.push({ revoked_events: revokedEvents });
    return { ...view, canReadPiInput, view_revision: recordKey(...scope) };
  }

  canReadPiInput(event, session) {
    const ids = event.room_originals?.map(source => source.event.id) || [];
    if (ids.some(id => !this.platform.roomWork.canHandOff(this.platform.store.get('messages', id), session, session.execution_actor, true))) return false;
    const author = { actor: event.author, project_room: session.project_room };
    const target = sessionRef(session.id);
    if (!this.platform.executions.permission(target, session, author, 'input') ||
        !this.platform.canUseResources(author.actor, session.resource_refs, author)) return false;
    if (!event.initiating_principal || sameRef(event.initiating_principal, event.author)) return true;
    const initiating = { actor: event.initiating_principal, project_room: session.project_room };
    return this.platform.canUseResources(initiating.actor, session.resource_refs, initiating);
  }

  async contextBoundary(job, window) {
    const { inbox, conversation, runId } = job;
    const view = await job.view();
    const context = job.context();
    const run = inbox.run(runId);
    const current = [];
    const ordered = run.pending_event_ids.map(id => inbox.event(id)).filter(Boolean).sort(eventOrder);
    for (const event of ordered) {
      const { id } = event;
      if (run.processed_event_ids.includes(id) && !inbox.list(R.route, 'event_id', id).some(route => route.run_id === runId && route.state === 'pending')) continue;
      const routes = inbox.list(R.route, 'event_id', id).filter(route => route.run_id === runId && route.state === 'pending');
      if (!routes.some(route => this.routeReady(inbox, route))) continue;
      const authorized = event.type === 'pi.input' ? view.canReadPiInput(event) : view.canReadEvent(event);
      if (authorized) current.push(event);
      else if (routes.some(route => route.wait_id)) current.push({ id: event.id, type: event.type, call_id: event.call_id, status: event.status,
        result_position: event.result_position, time: event.time, result_access: 'revoked', author: event.author });
      else if (event.type === 'pi.input') {
        inbox.store.transaction(() => {
          for (const route of routes) inbox.store.putRecord(R.route, { ...route, state: 'access_revoked' });
          const input = inbox.store.getRecord(R.input, event.call_id);
          if (input && !terminalCallStates.has(input.status)) this.stageInput(inbox, conversation, input, 'failed',
            { text: 'The submitter no longer has access to the Session resources' });
        });
      } else this.discard(inbox, routes, 'access_revoked');
    }
    let history = [];
    let publicRoom;
    const facts = [];
    if (run.delivery_review_trigger?.kind === 'correct_original_card') facts.push(textMessage({
      type: 'reconsider_original_card', original_question: run.delivery_review_trigger.original_question,
      instruction: 'Read the original source returns and the latest actual inputs. A later public request to forward an earlier original is not a second required seat input. Correct the unsent draft in this Room, then check actual dispositions.' }));
    if (['review_prescribed_dispatch', 'review_owner_handover'].includes(run.delivery_review_trigger?.kind))
      facts.push(textMessage({ type: 'pending_owner_request', ...run.delivery_review_trigger,
        instruction: 'Review the live host requests and genuine receipts under current permissions. For a handover reply_to the specific outstanding host question and reference the effective card. Correct mistaken unused-work notes through their original closed seats. For a prescribed dispatch compare the source grant and the actual destination receipt before sending; an already fulfilled instruction only needs its requested local reply.' }));
    const dispositions = this.pendingCardActions(job);
    if (dispositions.length) facts.push(textMessage({ type: 'outstanding_card_dispositions', actions: dispositions,
      instruction: 'Act from this original parent. Verify the card and each seat. For a credited delivered seat use configure_session and verify the returned message_id. For unused work record its own truthful non-delivery disposition. If a previous request returned a different card, inspect the authorized change and make the actual link or report the reason it stays unchanged.' }));
    const publicReplies = job.outstandingReplies(current.map(event => event.id));
    if (publicReplies.length) facts.push(textMessage({ type: 'public_reply_requested', requests: publicReplies,
      instruction: 'Give the explicitly requested reply using send and reply_to for the actual original message. Private final text does not deliver it.' }));
    const bound = conversation.kind === 'room' && conversation.space.kind === 'room' &&
      this.platform.store.get('rooms', conversation.space.id)?.workspace;
    if (bound) facts.push(textMessage({ type: 'project_workspace', room: conversation.space, workspace: bound }));
    let observation;
    const observing = conversation.kind === 'room' && conversation.space.kind === 'room' &&
      this.platform.deliveries.roomObservation(context.actor.id, conversation.space.id);
    if (observing) {
      observation = observationBoundary(this.platform, job, context, view, observing, window, current);
    }
    if (conversation.kind === 'room' && conversation.space.kind === 'room' && !conversation.session_id &&
        (!observing || observation.bootstrap)) {
      const roomId = conversation.space.id;
      const locked = run.public_prefix_end !== undefined && run.public_prefix_end !== null;
      const currentRoomSeqs = current
        .filter(event => event.type === 'message' && event.space?.id === roomId && Number.isSafeInteger(event.sequence))
        .map(event => event.sequence);
      const latestEnd = observation?.end ?? Math.max(this.platform.room.observationEnd(roomId, context.actor.id), ...currentRoomSeqs);
      let prefixEnd, prefixSummary, tailMessages = [];
      if (!locked) {
        const snapshot = this.platform.room.publicHistory(roomId, context.actor.id, latestEnd);
        history = snapshot.messages.map(roomEvent);
        prefixSummary = snapshot.summary;
        prefixEnd = snapshot.end;
      } else {
        prefixEnd = run.public_prefix_end;
        prefixSummary = run.public_prefix_summary ?? null;
        history = this.platform.room.publicMessagesRange(roomId, context.actor.id, prefixSummary?.sequence ?? 0, prefixEnd)
          .messages.map(roomEvent);
        if (latestEnd > prefixEnd) {
          tailMessages = this.platform.room.publicMessagesRange(roomId, context.actor.id, prefixEnd, latestEnd).messages
            .map(message => ({ event: roomEvent(message), callId: message.callId ?? null }));
        }
      }
      publicRoom = {
        summary: prefixSummary,
        end: prefixEnd,
        latestEnd,
        locked,
        tailMessages,
        save: (previous, through, summary) => this.platform.room.savePublicSummary(roomId, context.actor, previous, through, summary),
      };
      if (run.recovering_room_inputs) {
        const confirmed = run.route_ids.map(id => inbox.store.getRecord(R.route, id)).filter(route => route?.public_reply)
          .map(route => ({ original_message_id: route.event_id, ...route.public_reply }));
        facts.push(textMessage({ type: 'room_input_recovery', room: roomId,
          pending_message_ids: current.filter(event => event.type === 'message' && sameRef(event.space, conversation.space)).map(event => event.id),
          confirmed_public_replies: confirmed }));
      }
      inbox.putRun({ id: runId, history_read_through: tailMessages.at(-1)?.event.id ?? history.at(-1)?.id ?? prefixSummary?.through ?? null });
    }
    if (view.session && view.resources?.length) facts.push(textMessage({ type: 'session_resources', references: view.resources,
      ...(view.session.workspace_ref && { workspace: view.session.workspace_ref, cwd: view.session.workspace.path, project_room: view.session.project_room }) }));
    if (conversation.session_id) {
      history = this.sessionHistory(inbox, conversation, runId, view);
      const sources = this.platform.roomWork.readSources(this.platform.context(context));
      if (sources.length) {
        facts.push(textMessage({ type: 'room_material_sources', sources,
          instruction: 'Read an attachment with its File ref. Workspace paths refer to project files explicitly identified by a source.' }));
        const position = JSON.stringify(context.origin.event_ids);
        if (current.every(event => event.type !== 'pi.input' || context.origin.event_ids.includes(event.id))) {
          const calls = inbox.calls(runId).filter(call => ['find', 'read'].includes(call.tool) && JSON.stringify(call.source_event_ids) === position);
          const available = sources.filter(({ ref }) => !calls.some(call => call.tool === 'read' && sameRef(call.args.ref, ref) &&
            call.state === 'completed' && !call.result?.next_cursor));
          const found = calls.findLastIndex(call => call.state === 'completed' && (call.args.ref?.kind === 'file' ||
            call.args.ref?.kind === 'workspace' && (call.result?.path || call.result?.directory) ||
            call.args.scope?.kind === 'workspace' && call.result?.items?.length || sources.some(item => sameRef(item.ref, call.args.ref))));
          const supplied = context.origin.event_ids.map(id => JSON.stringify(inbox.event(id)?.input ?? ''));
          const misses = calls.slice(found + 1).filter(call => call.args.ref?.kind === 'workspace' && call.args.path &&
            call.result?.status === 404 && !supplied.some(text => text.includes(call.args.path)) &&
            !calls.some(earlier => earlier.state === 'completed' && earlier.finished_at < call.prepared_at &&
              JSON.stringify(earlier.result ?? null).includes(call.args.path)));
          if (misses.length >= 2) {
            facts.push(textMessage({ type: 'room_material_lookup', sources: available, missing_paths: [...new Set(misses.map(call => call.args.path))].slice(-8),
              instruction: 'Use the listed original references or list the authorized project directory using read with directory. Read a real entry by its returned path. When the required original is absent, report the verified partial result and missing material to your parent.' }));
          }
        }
      }
    }
    const otherCalls = conversation.kind === 'room' ? inbox.list(R.conversation, 'space.id', conversation.space.id)
      .filter(other => other.id !== conversation.id && other.kind === 'room' && sameRef(other.space, conversation.space))
      .flatMap(other => this.platform.calls.unfinishedFor(other.id, context.actor)) : [];
    const unfinished = [...view.unfinished_calls, ...otherCalls];
    if (unfinished.length) facts.push(textMessage({ type: 'prior_call_facts', calls: unfinished }));
    const relevantGroups = new Set();
    const requestIds = new Set();
    if (conversation.kind === 'room') {
      const localRequests = current.filter(event => event.type === 'message' && sameRef(event.space, conversation.space));
      if (localRequests.length) {
        const withdrawn = this.platform.executions.withdrawnFollowups(inbox.botId, conversation.space.id);
        if (withdrawn.length) facts.push(textMessage({ type: 'withdrawn_room_intakes', withdrawals: withdrawn }));
        const room = this.platform.room.room(conversation.space.id, inbox.botId);
        const intake = this.roomIntake(inbox.botId, room, localRequests);
        if (intake) facts.push(textMessage({ type: 'room_intake', ...intake }));
      }
      const links = roomQuestionLinks(this.platform, conversation.space, localRequests);
      for (const event of current) if (event.owner_conversation_id === conversation.id && sameRef(event.origin_room, conversation.space))
        links.add(event.origin_message_id);
      const receipts = roomPublicationReceipts(this.platform, context.actor, conversation, links);
      if (receipts.length) facts.push(textMessage({ type: 'own_room_deliveries', receipts }));
    }
    for (const event of current) {
      if (event.type === 'message') {
        requestIds.add(event.id);
        if (event.reply_to) requestIds.add(event.reply_to.id ?? event.reply_to);
        const route = inbox.store.getRecord(R.route, recordKey(event.id, 'observation'));
        if (route?.intake_task) facts.push(textMessage({ type: 'room_intake_request', message_id: event.id, ...route.intake_task }));
        if (route?.native_request) facts.push(textMessage({ type: 'native_reply_due', message_id: event.id, ...route.native_request,
          instruction: 'Read the current input_targets and submit the user’s actual answers as reply to the matching request. If its position changed, inspect the new request.' }));
        if (route?.fast_read_forward_fallback) {
          const callId = route.fast_read_forward_call_id;
          const actual = callId && await this.readFor(job, { kind: 'call', id: callId });
          facts.push(textMessage({ type: 'forward_fallback', message_id: event.id, reason: route.fast_read_forward_fallback,
            session_id: route.fast_read_forward_target, call_id: callId, current_call_status: actual?.status,
            result_ref: actual?.result_ref, input_status: actual?.result?.input_status }));
        }
      }
      if (event.type !== 'call.receipt' || !event.call_id || event.result_access === 'revoked') continue;
      const observation = await this.readFor(job, { kind: 'call', id: event.call_id });
      if (!observation || observation.result_access === 'revoked') continue;
      const target = observation.target;
      const session = target?.kind === 'session' && this.platform.executions.record(target);
      if (session?.owner_conversation_id === conversation.id) relevantGroups.add(workGroup(session));
      // The event names an immutable receipt position. A newer receipt may already exist on the call.
      const result = event.result ?? observation.result;
      const content = JSON.stringify(result ?? null);
      if (observation.origin?.fast_read_forward && ['unknown', 'not_submitted', 'failed', 'stopped', 'cancelled'].includes(event.status)) {
        const id = observation.source_event_ids[0];
        const original = this.platform.store.get('messages', id);
        const message = session && this.platform.roomWork.canHandOff(original, session, context.actor) && original;
        facts.push(textMessage({ type: 'forward_return', call_id: event.call_id, receipt_status: event.status,
          current_call_status: observation.status, input_status: observation.result?.input_status, result_ref: observation.result_ref,
          session_id: target?.id, source: message ? this.platform.roomWork.sourceFacts([id])[0] : undefined,
          recovery_call_id: observation.forward_recovery_call_id,
          instruction: 'For confirmed non-submission, inspect the current owner Session input. Recover this original once with recovery_of if still authorized. Otherwise report the actual unresolved disposition on its original question.' }));
      }
      facts.push(textMessage({ type: 'call_result', call_id: event.call_id, tool: observation.tool, status: event.status, target,
        input_status: result?.input_status, session_status: result?.session_status,
        result_ref: { kind: 'event', id: event.id }, result_position: event.result_position,
        result: content.length <= 12000 ? result : { preview: content.slice(0, 12000), truncated: true } }));
    }
    if (relevantGroups.size || requestIds.size || inbox.calls(runId).some(call => call.tool === 'open_session')) {
      const owned = this.platform.executions.directWork(conversation.id);
      const ownerContext = this.platform.context(context);
      if (conversation.kind === 'room') for (const id of roomQuestionLinks(this.platform, conversation.space, current.filter(event => event.type === 'message')))
        requestIds.add(id);
      if (requestIds.size && conversation.kind === 'room' && !run.receipt_group) {
        const recent = new Map();
        for (const work of owned.slice().reverse()) {
          if (!sameRef(work.origin_room, conversation.space) || !work.origin_message_id || recent.has(work.origin_message_id)) continue;
          const question = this.platform.store.get('messages', work.origin_message_id);
          if (question?.roomId === conversation.space.id)
            recent.set(question.id, { origin_message_id: question.id, original_question: question.content.slice(0, 1200) });
          if (recent.size === 5) break;
        }
        if (recent.size) facts.push(textMessage({ type: 'recent_delegated_questions', questions: [...recent.values()] }));
      }
      for (const work of owned) {
        if (work.owner_run_id === runId || requestIds.has(work.origin_message_id)) relevantGroups.add(workGroup(work));
      }
      const groups = new Map();
      for (const work of owned) {
        const key = workGroup(work);
        if (!relevantGroups.has(key)) continue;
        if (!groups.has(key)) {
          const question = work.origin_room && this.platform.canReadReference({ kind: 'event', id: work.origin_message_id }, context) &&
            this.platform.store.get('messages', work.origin_message_id);
          const replies = question && conversation.kind === 'room' && sameRef(work.origin_room, conversation.space)
            ? this.platform.executions.originalReplies(work).slice(-4).map(({ message, stage }) =>
              ({ id: message.id, stage, text: message.content.slice(0, 2000) })) : [];
          const amendments = question && conversation.kind === 'room' && sameRef(work.origin_room, conversation.space) ?
            this.platform.roomWork.hostAmendments(work).map(item => ({ event_id: item.id, time: item.createdAt, text: item.content.slice(0, 360) })) : [];
          groups.set(key, { type: 'origin_work_status', origin_room: work.origin_room, amendments,
            origin_message_id: work.origin_message_id, ...(question && { original_question: question.content.slice(0, 4000) }),
            ...(replies.length && { original_replies: replies }), sessions: [] });
        }
        const group = groups.get(key);
        group.sessions.push({ session_id: work.id, engine: work.engine, work_summary: work.work_summary,
          amendment_inputs: this.platform.roomWork.materialStatus(work, group.amendments.map(item => item.event_id)),
          status: work.status, waiting_summary: work.waiting_summary, acceptance_state: work.acceptance_state,
          acceptance: this.platform.executions.acceptanceView(work, ownerContext),
          receipts: this.platform.roomWork.seatReceipts(work, ownerContext), dispositions: this.platform.roomWork.dispositionHistory(work, ownerContext),
          ...(work.acceptance?.note && work.owner.id === inbox.botId && sameRef(work.origin_execution, conversationRef(conversation.id)) &&
            { disposition_note: work.acceptance.note, ...(work.acceptance.note_corrections?.length &&
              { note_last_amended_at: work.acceptance.note_corrections.at(-1).time }) }),
          control: work.control, latest_call_id: work.latest_call_id,
          ...(work.retained_delivery && { confirmed_delivery: work.retained_delivery }),
          ...(work.pending_input?.length && { pending_requests: work.pending_input, input_targets: work.input_targets }) });
      }
      for (const group of groups.values()) facts.push(textMessage({ ...group,
        disposition_guidance: 'On a requested handover, compare each unused seat’s disposition_note to its own initial return and later inputs. Correct a factual error on that same closed seat with target, amend_disposition_note:true and disposition_note before reporting it corrected. Preserve the original work and its outcome.' }));
      const localHost = current.filter(event => event.type === 'message' && event.author?.kind === 'user' && sameRef(event.space, conversation.space));
      if (localHost.length) {
        const receipts = roomPublicationReceipts(this.platform, ownerContext.actor, conversation, roomQuestionLinks(this.platform, conversation.space, localHost))
          .filter(receipt => localHost.some(event => event.id === receipt.dispatch));
        if (receipts.length) facts.push(textMessage({ type: 'actual_dispatch_receipts', receipts,
          instruction: 'These are the actual historical sends under the current host order. Compare their exact received text to the instruction. Finish a missing prescribed line through the authorized send, then report the actual recipient receipt.' }));
      }
    }
    return { ...view, current, history, facts, material: job.materials(), observation, publicRoom };
  }

  sessionHistory(inbox, conversation, runId, view) {
    const history_ref = sessionRef(conversation.session_id);
    const history = [];
    for (const past of inbox.runs(conversation.id)) {
      if (past.id === runId || !canRetainAuthorizationView(past.view_revision, view.view_revision) || past.state !== 'completed') continue;
      const inputs = past.processed_event_ids.map(id => inbox.event(id)).filter(event => event?.type === 'pi.input');
      if (inputs.some(event => !view.canReadPiInput(event))) continue;
      history.push(...inputs.map(event => ({ ...event, history_ref })));
      if (past.result?.text) history.push({ id: recordKey(past.id, 'response'), type: 'pi.result', history_ref, run_id: past.id,
        time: past.updated_at, author: botRef(inbox.botId), text: past.result.text });
    }
    return history;
  }

  async readFor(job, ref) {
    try { return await this.platform.invoke('read', { ref }, job.context()); }
    catch (error) { if (error.status === 404 || error.status === 403) return null; throw error; }
  }

  async recoverCalls(job) {
    const { inbox, runId } = job;
    for (const record of inbox.calls(runId).filter(call => ['prepared', 'submitting', 'submitted', 'unknown'].includes(call.state))) {
      const actual = await this.readFor(job, { kind: 'call', id: record.id });
      if (actual) {
        inbox.store.transaction(() => {
          const status = actual.status === 'prepared' ? 'unknown' : actual.status;
          inbox.store.putRecord(R.call, { ...record, state: status, result: actual.result ?? actual, recovered_at: now() });
          for (const wait of actual.wait_refs || []) {
            if (wait.run_id !== runId) continue;
            const prior = inbox.wait(wait.id);
            inbox.store.putRecord(R.wait, { ...wait, ...prior, target: wait.target || prior?.target,
              ...(wait.status === 'inline' && { status: 'inline', result_position: wait.result_position }) });
          }
        });
      } else if (record.state === 'prepared') inbox.store.putRecord(R.call, { ...record, state: 'not_submitted' });
    }
  }

  async firstRun(session) {
    const bot = this.platform.getBot(session.execution_actor.id);
    const inbox = await this.inbox(bot.id);
    const existing = inbox.conversation(session.conversation_id || session.id);
    if (existing) return { inbox, bot, conversation: existing };
    const fixed = session.model_binding || session.model;
    if (!fixed) throw runtimeFailure('connection_unconfigured', 'The Pi Session has no recorded model binding');
    const model = fixed.model_id ? fixed : bindModel(this.model, fixed);
    const instructions = session.instructions ?? '';
    const conversation = this.register(inbox, inbox.putConversation({ id: session.conversation_id || session.id,
      kind: 'pi', owner: session.owner, session_id: session.id, open_call_id: session.open_call_id || session.latest_call_id,
      space: session.space, binding: { model, instructions, name: bot.name, revision: session.bot_revision,
        built_in_role: session.built_in_role ?? null,
        material_index_ref: session.sharing ? null : bot.material_index_ref }, input_revision: session.input_revision || 0 }));
    return { inbox, bot, conversation };
  }

  async startPi({ session, call, input, beforeSubmit, signal }) {
    signal?.throwIfAborted();
    if (this.draining || this.closed) throw runtimeFailure('updating', 'New Pi session submissions are paused', 503);
    const details = await this.firstRun(session);
    const status = () => this.inspectPi(session);
    if (details.inbox.store.getRecord(R.input, call.id)) return status();
    signal?.throwIfAborted();
    await beforeSubmit();
    const { run } = this.acceptInput(details, call, input, 'next', null);
    this.wake();
    return { status: 'submitted', input_revision: run.input_revision, native: { conversation_id: details.conversation.id, run_id: run.id }, input_targets: [] };
  }

  async submitConversation(options) { return this.submitInput(options, false); }

  async submitInput({ session, conversation: current, call, kind, input_target, input, beforeSubmit, signal }, forSession) {
    if (kind === 'reply') throw runtimeFailure('unsupported', 'Pi has no pending protocol request for this input', 409);
    signal?.throwIfAborted();
    const details = forSession ? await this.firstRun(session) : this.locate(current.id);
    if (!details) throw runtimeFailure('execution_not_found', 'Pi conversation is unavailable', 404);
    const { inbox, conversation } = details;
    const prior = inbox.store.getRecord(R.input, call.id);
    const inspect = () => this.inspectLocal(inbox, conversation, { sessionInput: forSession });
    if (prior) return { ...inspect(), confirmed_input: prior.confirmed_input };
    const verify = () => {
      const progress = inspect();
      const expected = progress.input_targets.find(option => option.kinds.includes(kind));
      if (!expected || Object.keys(input_target).some(key => input_target[key] !== expected.input_target[key]))
        throw runtimeFailure('input_target_expired', 'The native Pi input target has changed');
      const active = this.active.get(conversation.id);
      if (kind === 'steer' && !active?.accepting) throw runtimeFailure('input_target_expired', 'The Pi run has ended');
      return active;
    };
    verify();
    const selected = kind === 'next' ? this.inputRun(inbox, conversation) : null;
    signal?.throwIfAborted();
    await beforeSubmit();
    let active;
    try { signal?.throwIfAborted(); active = verify(); }
    catch (error) { error.beforeSubmit = true; throw error; }
    const last = kind === 'next' ? this.inputRun(inbox, conversation) : null;
    if (last?.id !== selected?.id) throw Object.assign(runtimeFailure('input_target_expired', 'The conversation run changed before input submission'), { beforeSubmit: true });
    const resumeSuspended = last?.state === 'suspended' && (forSession || conversation.kind === 'room');
    const continuation = resumeSuspended || forSession && last?.state === 'waiting' ? last : null;
    const steerTarget = forSession && kind === 'steer' ? input_target : null;
    const { run, confirmed_input } = this.acceptInput(details, call, input, kind, active?.runId ?? continuation?.id, steerTarget);
    this.wake();
    return { status: 'submitted', input_revision: run.input_revision, native: { conversation_id: conversation.id, run_id: run.id },
      input_targets: [], ...(confirmed_input && { confirmed_input }) };
  }

  acceptInput({ inbox, conversation }, call, input, kind, runId, steerTarget) {
    return inbox.store.transaction(() => {
      const current = inbox.conversation(conversation.id);
      const id = recordKey('pi.input', call.id);
      const event = { id, kind: 'event', type: 'pi.input', input, space: conversation.space, author: actorFor(call), time: now(),
        call_id: call.id, source_event_ids: call.source_event_ids || [], initiating_principal: call.initiating_principal,
        ...(call.material_source_ids?.length && { room_originals: this.platform.roomWork.sourceFacts(call.material_source_ids, call) }),
        ...(call.prior_material_receipts?.length && { prior_material_receipts: call.prior_material_receipts }),
        ...(call.origin?.fast_read_forward && { material_author: call.origin.source_author, material_room: call.origin.source_room }) };
      const next = inbox.putConversation({ id: current.id, input_revision: current.input_revision + 1 });
      inbox.store.putRecord(R.event, { id, event, received_at: event.time });
      const route = inbox.route(id, { conversation_id: current.id });
      const run = runId ? inbox.associate(runId, [route]) : inbox.createRun(next, [route], { submitted_by: actorFor(call) });
      const start = steerTarget?.kind === 'pi_run' && steerTarget.run_id === run.id && call.origin?.run_id !== run.id &&
        inbox.list(R.input, 'run_id', run.id).find(item => item.kind === 'next' && item.conversation_id === current.id);
      const confirmed_input = start ? { operation_call_id: start.id, input_target: steerTarget } : undefined;
      inbox.store.putRecord(R.input, { id: call.id, run_id: run.id, event_id: id, conversation_id: current.id,
        kind, status: 'submitted', input_revision: next.input_revision, submitted_by: actorFor(call), confirmed_input });
      return { run: inbox.putRun({ id: run.id, input_revision: next.input_revision,
        ...(conversation.kind === 'room' && run.state === 'suspended' ? { recovering_room_inputs: true } : {}),
        ...(run.state === 'suspended' ? { state: 'pending', retry_at: null } : {}) }), confirmed_input };
    });
  }

  stageInputs(inbox, conversation, runId, status, result) {
    const run = inbox.run(runId);
    const controls = [conversationRef(conversation.id), ...(conversation.session_id ? [sessionRef(conversation.session_id)] : [])];
    const resumed = status === 'completed' && run.state === 'completed' && controls.some(target => {
      const control = this.platform.executions.record(target)?.control;
      return control?.state === 'active' && control.stop_id && control.stop_status === 'stopped';
    });
    for (const input of inbox.list(R.input, 'run_id', runId)) {
      if (input.status === status) continue;
      if (status === 'waiting' && !run.processed_event_ids.includes(input.event_id)) continue;
      if (terminalCallStates.has(input.status)) {
        const resolvedUnknown = input.status === 'unknown' && run.state === 'completed' && status === 'completed';
        if (!(resolvedUnknown || resumed && input.status === 'stopped') || !run.injected_event_ids.includes(input.event_id)) continue;
        const route = inbox.store.getRecord(R.route, recordKey(input.event_id, 'observation'));
        if (route?.run_id !== run.id || route.state !== 'processed') continue;
      }
      this.stageInput(inbox, conversation, input, status, result);
    }
  }

  stageInput(inbox, conversation, input, status, result) {
    const revision = inbox.conversation(conversation.id).input_revision;
    const facts = { status, position: recordKey(input.run_id, status), native: { run_id: input.run_id }, output: result?.text,
      input_targets: status === 'completed' || status === 'waiting' && conversation.session_id
        ? [targetOption('next', { kind: 'idle_input', input_revision: revision })] : [], input_revision: revision,
      confirmed_input: input.confirmed_input };
    if (input.receipt_pending === 'pending') {
      inbox.store.putRecord(R.input, { ...input, status, queued_receipts: [...(input.queued_receipts || []), facts] });
      return;
    }
    inbox.store.putRecord(R.input, { ...input, status, receipt: facts, receipt_pending: 'pending' });
  }

  flushInputs(inbox) {
    for (let input of inbox.list(R.input, 'receipt_pending', 'pending')) {
      const conversation = inbox.conversation(input.conversation_id);
      while (input.receipt_pending === 'pending') {
        try {
          this.platform.recordReceipt(input.id, input.receipt, conversation.session_id);
          const [next, ...queued] = input.queued_receipts || [];
          input = inbox.store.putRecord(R.input, { ...input, receipt: next || input.receipt, receipt_pending: next ? 'pending' : 'saved',
            queued_receipts: queued.length ? queued : undefined });
        } catch (error) {
          this.emit('engine.receipt_pending', { run_id: input.run_id, call_id: input.id, ...this.clean.error(cleanError(error)) });
          break;
        }
      }
    }
  }

  locate(id) {
    for (const inbox of this.inboxes.values()) {
      const conversation = inbox.conversation(id);
      if (conversation) return { inbox, conversation };
    }
    return null;
  }

  inspectConversation(id, options) {
    const item = this.locate(id);
    return item ? this.inspectLocal(item.inbox, item.conversation, options) : { status: 'unknown', input_targets: [] };
  }

  conversationSummary(id) {
    const item = this.locate(id);
    return item ? this.runSummary(id, this.inputRun(item.inbox, item.conversation)) : null;
  }

  inputRun(inbox, conversation, runs = inbox.runs(conversation.id)) {
    const latest = this.latestRun(runs, conversation.id);
    if (conversation.kind !== 'room' || !latest || activeRunStates.has(latest.state) || this.active.has(conversation.id)) return latest;
    // A newer, completed fork does not remove a suspended fork's original inbox position.
    const suspended = runs.filter(run => run.state === 'suspended' &&
      (inbox.hasOpenWaits(run.id) || run.route_ids.some(id => inbox.store.getRecord(R.route, id)?.state === 'pending')));
    return this.latestRun(suspended, conversation.id) ||
      (latest.state === 'suspended' ? this.latestRun(runs.filter(run => run.state !== 'suspended'), conversation.id) : latest);
  }

  latestRun(runs, id) {
    const active = this.active.get(id);
    if (active) return runs.find(run => run.id === active.runId);
    return runs.reduce((latest, run) => !latest || (run.updated_at ?? '') >= (latest.updated_at ?? '') ? run : latest, null);
  }

  runSummary(id, run) {
    const active = this.active.get(id);
    const ended = !run || ['completed', 'cancelled', 'stopped', 'archived', 'access_revoked'].includes(run.state);
    const status = active ? 'running' : ended ? 'idle' : run.state;
    const error = !active && run?.error;
    return { status, ...(error?.message ? { last_error: { code: error.code || 'runtime_error', message: error.message } } : {}) };
  }

  async inspectPi(session, options) {
    const id = session.conversation_id || session.id;
    let inbox;
    try { inbox = await this.inbox(session.execution_actor.id, { create: false }); }
    catch (error) {
      if (error.code !== 'bot_inbox_unavailable') throw error;
      return { status: 'unknown', input_targets: [], last_error: { code: error.code, message: error.message } };
    }
    const conversation = inbox?.conversation(id);
    return conversation ? this.inspectLocal(inbox, conversation, { ...options, sessionInput: true }) : { status: session.status || 'unknown', input_targets: [] };
  }

  piAtRest(session) {
    const id = session.conversation_id || session.id;
    const inbox = this.inboxes.get(session.execution_actor.id);
    return inbox?.conversation(id)?.session_id === session.id && !this.active.has(id) && !this.starting.has(id) &&
      inbox.runs(id).every(run => !activeRunStates.has(run.state));
  }

  localInputState(inbox, conversation, sessionInput, last = this.inputRun(inbox, conversation)) {
    const revision = inbox.conversation(conversation.id).input_revision;
    const active = this.active.get(conversation.id);
    const summary = this.runSummary(conversation.id, last);
    const canAdvance = !active && !this.starting.has(conversation.id) &&
      (summary.status === 'idle' || summary.status === 'suspended' || sessionInput && summary.status === 'waiting');
    const target = active?.accepting ? [targetOption('steer', { kind: 'pi_run', run_id: active.runId })] : canAdvance ?
      [targetOption('next', { kind: 'idle_input', input_revision: revision })] : [];
    return { ...summary, input_targets: target, input_revision: revision };
  }

  inspectLocal(inbox, conversation, { cursor, limit = 25, sessionInput = false, modelPage = false } = {}) {
    const runs = inbox.runs(conversation.id);
    const last = this.inputRun(inbox, conversation, runs);
    const state = this.localInputState(inbox, conversation, sessionInput, last);
    const output = runs.flatMap(run => {
      const record = inbox.store.getRecord(R.transcript, run.id);
      const originals = record?.original_messages || [];
      const previous = originals.map((message, index) => ({ id: recordKey(run.id, 'original', index), run_id: run.id, message }));
      const current = (record?.messages || []).map((message, index) => ({ id: recordKey(run.id, index), run_id: run.id, message }));
      return [...previous, ...current];
    });
    if (modelPage || typeof cursor === 'string' && cursor.startsWith('fragment:')) return { ...state, transcript_page: true,
      output: !cursor && typeof last?.result?.text === 'string' ? last.result.text.slice(0, 3000) : undefined,
      ...transcriptPage(output, cursor, limit) };
    const after = cursor == null ? 0 : output.findIndex(entry => entry.id === cursor) + 1;
    if (cursor && !after) throw runtimeFailure('cursor_expired', 'The transcript cursor is not available');
    const slice = output.slice(after, after + limit);
    const rawOutput = last?.result?.text;
    const text = cursor || typeof rawOutput !== 'string' ? undefined : rawOutput.slice(0, 16000);
    return { ...state, messages: slice, output: text,
      next_cursor: after + slice.length < output.length ? slice.at(-1)?.id : null };
  }

  async stopConversation(id) {
    const job = this.active.get(id);
    if (job) job.controller.abort(runtimeFailure('execution_paused', 'Execution was explicitly stopped'));
    const item = this.locate(id);
    if (item) {
      const { inbox, conversation } = item;
      this.syncConversationControl(inbox, conversation);
      inbox.store.transaction(() => {
        for (const run of inbox.runs(id).filter(run => activeRunStates.has(run.state))) {
          const pending = inbox.pending().filter(route => route.run_id === run.id && inbox.event(route.event_id)?.type === 'pi.input' &&
            !run.injected_event_ids.includes(route.event_id));
          for (const { event, ...route } of pending) {
            inbox.store.putRecord(R.route, { ...route, state: 'cancelled' });
            const input = inbox.store.getRecord(R.input, event.call_id);
            if (input && !terminalCallStates.has(input.status)) this.stageInput(inbox, conversation, input, 'stopped');
          }
          if (pending.length && !inbox.pending().some(route => route.run_id === run.id) && !run.injected_event_ids.length) {
            inbox.putRun({ id: run.id, state: 'cancelled' });
            this.stageInputs(inbox, conversation, run.id, 'stopped');
          }
        }
      });
      if (!job) this.flushInputs(inbox);
    }
    return { status: job ? 'stopping' : 'stopped' };
  }

  stopBot(id) {
    const jobs = [...this.active.values()].filter(job => job.inbox.botId === id);
    for (const job of jobs) job.controller.abort(runtimeFailure('bot_paused', 'Bot was explicitly stopped'));
    return Promise.all([...jobs.map(job => job.done), this.fastRead?.stopBot(id)]).then(() => ({ status: 'stopped' }));
  }

  setDraining(value) { this.draining = value; if (!value) this.wake(); }
  beginDrain() {
    this.setDraining(true);
    return {
      running: [...this.active.values()].map(job => job.runId),
      fast_read: this.fastRead ? this.fastRead.drainActive().map(item => item.id) : [],
    };
  }

  drainStatus() {
    const active = [
      ...this.activeRuns().map(job => ({ ...job, id: job.run_id, kind: 'run', status: 'running' })),
      ...(this.fastRead ? this.fastRead.drainActive() : []),
    ];
    if (this.pumping) active.push({ id: 'bot-runtime', kind: 'runtime', status: 'writing' });
    for (const inbox of this.inboxes.values()) {
      this.flushInputs(inbox);
      for (const input of inbox.list(R.input, 'receipt_pending', 'pending')) active.push({ id: input.id, kind: 'call_receipt', status: 'pending' });
    }
    for (const id of this.opening.keys()) active.push({ id, kind: 'bot', status: 'opening' });
    return { active };
  }

  activeRuns() { return [...this.active.values()].map(job => ({ run_id: job.runId, bot_id: job.inbox.botId, conversation_id: job.conversation.id })); }

  async checkInstallation() {
    const state = await readInstallationState(this.dataRoot);
    if (state && ['prepared', 'draining', 'converting', 'data_ready'].includes(state.phase)) this.beginDrain();
    if (this.draining) throw runtimeFailure('updating', 'New model or tool calls are paused for the update window', 503);
  }

  async close() {
    this.draining = true;
    this.closed = true;
    clearInterval(this.interval);
    clearImmediate(this.scheduled);
    for (const job of this.active.values()) job.controller.abort(runtimeFailure('runtime_closed', 'Bot runtime is closing', 503));
    const fastReadClose = this.fastRead?.close();
    this.engine?.stop();
    await Promise.allSettled([this.pumpTask, fastReadClose, ...this.opening.values(), ...this.starting.values()]);
    for (const inbox of this.inboxes.values()) inbox.store.close();
    this.usage?.close();
  }
}

function boxId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) throw runtimeFailure('invalid_identity', 'Invalid Bot identity', 400);
  return id;
}
