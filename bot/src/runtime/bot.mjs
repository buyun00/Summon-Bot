import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertInstallationWritable, readInstallationState } from '../../../scripts/installation/installation-state.mjs';
import { inspectServiceLock } from '../../../scripts/installation/service-lock.mjs';
import { repairRequestType, repairResultType, tools } from '../../../capabilities/platform/contract.mjs';
import { deliveryRecords } from '../../../capabilities/platform/delivery.mjs';
import { waitRecords } from '../../../capabilities/platform/calls.mjs';
import { forwardMaterials, workGroup } from '../../../capabilities/platform/session-work.mjs';
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
    const ids = new Set(inbox.list(R.route, 'event_id', eventId).map(route => route.run_id).filter(Boolean));
    return [...ids].flatMap(id => {
      const run = inbox.run(id);
      return run ? [{ run_id: id, state: run.state, starts: run.start_count ?? null, first_started_at: run.first_started_at ?? null }] : [];
    });
  }

  roomDeliveryDetails(botId, eventId) {
    const route = this.inboxes.get(botId)?.store.getRecord(R.route, recordKey(eventId, 'observation'));
    return route?.fast_read_diagnostic ? { fast_read_diagnostic: route.fast_read_diagnostic } : {};
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
    const settled = new Set(snapshot.filter(route => this.settledProgress(inbox, route) || this.deadWaitRoute(inbox, route)));
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
      const newRoutes = routes.slice(0, 32);
      if (receiptGroup) {
        const acceptance = inbox.runs(conversation.id).find(run => run.receipt_group === receiptGroup && activeRunStates.has(run.state));
        if (acceptance) inbox.associate(acceptance.id, newRoutes);
        else inbox.createRun(conversation, newRoutes, { receipt_group: receiptGroup });
        continue;
      }
      const running = this.active.get(conversation.id);
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
      this.resumeAuthorizedRuns(inbox, conversation, bot);
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

  deadWaitRoute(inbox, route) {
    const wait = route.wait_id && inbox.wait(route.wait_id);
    if (!wait) return false;
    const conversation = inbox.conversation(wait.conversation_id);
    if (!conversation?.session_id || this.conversationActive(conversation)) return false;
    const parentSession = this.platform.executions.record(sessionRef(conversation.session_id));
    const call = this.platform.store.get('platform-calls', wait.call_id);
    const events = (wait.event_ids || []).map(id => inbox.event(id)).filter(Boolean);
    if (call?.status === 'not_submitted' || events.some(event => event.status === 'not_submitted')) return true;
    const parentDead = parentSession?.acceptance_state === 'closed' || parentSession?.authority_revoked === true;
    return Boolean(parentDead && (callSettled(call?.status) || events.some(event => callSettled(event.status))));
  }

  resumeAuthorizedRuns(inbox, conversation, bot) {
    const suspended = inbox.runs(conversation.id).filter(run =>
      run.state === 'suspended' && run.error?.code === 'connection_forbidden' &&
      (inbox.hasOpenWaits(run.id) || run.route_ids.some(id => inbox.store.getRecord(R.route, id)?.state === 'pending')));
    if (!suspended.length) return;
    const actor = botRef(bot.id);
    const fixedConnection = conversation.binding?.model?.connection_id || null;
    const purpose = conversation.kind === 'fast_read' ? 'fast_read' : 'conversation';
    const resolved = fixedConnection ? null : this.platform.models.resolveForBot(bot, purpose);
    const resolvedAuthorized = Boolean(resolved && this.platform.canUseModel(actor, resolved.connection_id));
    for (const run of suspended) {
      const runConnection = fixedConnection || run.binding?.model?.connection_id || null;
      const keepBinding = Boolean(runConnection && this.platform.canUseModel(actor, runConnection));
      if (!keepBinding && (fixedConnection || !resolvedAuthorized)) continue;
      inbox.putRun({ id: run.id, state: 'pending', retry_at: null, error: null,
        ...(!keepBinding && run.binding ? { binding: null } : {}) });
    }
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
        else if (status === 'cancelled' && stored.wait_id) {
          const wait = inbox.wait(stored.wait_id);
          const resolvedEvent = wait && (event ?? inbox.event(stored.event_id));
          if (resolvedEvent && isTerminalReceipt(resolvedEvent, wait)) inbox.settleWait(stored, status);
        }
      }
    });
    this.consumeDeliveries(inbox, eventIds);
  }

  consumeDeliveries(inbox, eventIds) {
    for (const eventId of new Set(eventIds)) {
      for (const delivery of inbox.list(R.delivery, 'event_id', eventId)) this.syncDelivery(inbox, inbox.receipt(delivery.id));
    }
  }

  reconcileRoomReply(inbox, event) {
    if (event?.type !== 'message' || event.space?.kind !== 'room') return;
    const route = inbox.store.getRecord(R.route, recordKey(event.id, 'observation'));
    if (!route || route.state !== 'pending' || !route.run_id) return;
    const run = inbox.run(route.run_id);
    if (!run || run.state !== 'suspended' || this.active.get(run.conversation_id)?.runId === run.id) return;
    const reply = this.platform.room.replyBy(event.space.id, inbox.botId, event.id);
    const call = reply?.callId && this.platform.store.get('platform-calls', reply.callId);
    if (!reply || call?.tool !== 'send' || call.status !== 'completed' || call.origin?.bot_id !== inbox.botId ||
        call.result?.message?.id !== reply.id) return;
    inbox.store.putRecord(R.route, { ...route, state: 'processed', processed_at: now(),
      public_reply: { message_id: reply.id, call_id: call.id } });
  }

  reconcileDeliveries(inbox, received) {
    for (const delivery of received.filter(item => item.bot_id === inbox.botId)) {
      this.reconcileRoomReply(inbox, delivery.event);
      const receipt = inbox.receipt(delivery.id);
      if (receipt?.revision === (delivery.revision ?? 1)) this.syncDelivery(inbox, receipt);
    }
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
          first_started_at: run.first_started_at ?? now(), start_count: (run.start_count ?? 0) + 1 });
        this.emit('engine.started', refs);
        await this.recoverCalls(job);
        const storedOutcome = inbox.run(run.id).model_outcome;
        const pendingForRun = () => inbox.pending().filter(route => route.run_id === run.id);
        const canProcess = route => this.routeReady(inbox, route);
        const pendingNow = pendingForRun().filter(canProcess);
        const startView = job.view();
        const restored = storedOutcome && pendingNow.every(route => storedOutcome.eventIds.includes(route.event_id)) &&
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
          const next = pending.some(canProcess) ? 'pending' : outstanding || pending.length ? 'waiting' : 'completed';
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
        if (!call?.origin?.fast_read_forward || !sameRef(call.target, session) || !this.canReadPiInput(event, authority)) return [];
        const message = this.platform.store.get('messages', call.source_event_ids[0]);
        return message && this.platform.canReadSpace(actor, { kind: 'room', id: message.roomId }) ? forwardMaterials(message) : [];
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
      inbox.putRun({ id: runId, history_read_through: tailMessages.at(-1)?.event.id ?? history.at(-1)?.id ?? prefixSummary?.through ?? null });
    }
    if (view.session && view.resources?.length) facts.push(textMessage({ type: 'session_resources', references: view.resources,
      ...(view.session.workspace_ref && { workspace: view.session.workspace_ref, cwd: view.session.workspace.path, project_room: view.session.project_room }) }));
    if (conversation.session_id) {
      history = this.sessionHistory(inbox, conversation, runId, view);
      const sources = this.platform.roomWork.readSources(this.platform.context(context));
      if (sources.length) facts.push(textMessage({ type: 'room_material_sources', sources }));
      const openChildren = this.platform.executions.openChildren(conversation.session_id);
      if (openChildren.length) {
        facts.push(textMessage({ type: 'open_children', sessions: openChildren.map(child => ({
          session_id: child.id, engine: child.engine, status: child.status, work_summary: child.work_summary,
          waiting_summary: child.waiting_summary, latest_call_id: child.latest_call_id })) }));
      }
    }
    const otherCalls = conversation.kind === 'room' ? inbox.list(R.conversation, 'space.id', conversation.space.id)
      .filter(other => other.id !== conversation.id && other.kind === 'room' && sameRef(other.space, conversation.space))
      .flatMap(other => this.platform.calls.unfinishedFor(other.id, context.actor)) : [];
    const unfinished = [...view.unfinished_calls, ...otherCalls];
    if (unfinished.length) facts.push(textMessage({ type: 'prior_call_facts', calls: unfinished }));
    const relevantGroups = new Set();
    const requestIds = new Set();
    for (const event of current) {
      if (event.type === 'message') {
        requestIds.add(event.id);
        if (event.reply_to) requestIds.add(event.reply_to.id ?? event.reply_to);
        const route = inbox.store.getRecord(R.route, recordKey(event.id, 'observation'));
        if (route?.fast_read_forward_fallback) {
          const callId = route.fast_read_forward_call_id;
          const actual = callId && await this.readFor(job, { kind: 'call', id: callId });
          facts.push(textMessage({ type: 'forward_fallback', message_id: event.id,
            reason: route.fast_read_forward_fallback, session_id: route.fast_read_forward_target, call_id: callId,
            current_call_status: actual?.status, result_ref: actual?.result_ref, input_status: actual?.result?.input_status }));
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
        const sourceId = observation.source_event_ids?.[0];
        const original = sourceId && this.platform.canReadReference({ kind: 'event', id: sourceId }, context) &&
          this.platform.store.get('messages', sourceId);
        facts.push(textMessage({ type: 'forward_return', call_id: event.call_id, receipt_status: event.status,
          current_call_status: observation.status, input_status: observation.result?.input_status, result_ref: observation.result_ref,
          session_id: target?.id, ...(original && { source_event_id: original.id, source_room: { kind: 'room', id: original.roomId },
            source_author: original.author, source_text: original.content.slice(0, 2000) }) }));
      }
      facts.push(textMessage({ type: 'call_result', call_id: event.call_id, tool: observation.tool, status: event.status, target,
        input_status: result?.input_status, session_status: result?.session_status,
        result_ref: { kind: 'event', id: event.id }, result_position: event.result_position,
        result: content.length <= 12000 ? result : { preview: content.slice(0, 12000), truncated: true } }));
    }
    if (relevantGroups.size || requestIds.size || inbox.calls(runId).some(call => call.tool === 'open_session')) {
      const owned = this.platform.executions.directWork(conversation.id);
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
          const question = work.origin_room && work.origin_message_id &&
            this.platform.canReadReference({ kind: 'event', id: work.origin_message_id }, context) &&
            this.platform.store.get('messages', work.origin_message_id);
          groups.set(key, { type: 'origin_work_status', origin_room: work.origin_room,
            origin_message_id: work.origin_message_id, ...(question && { original_question: question.content.slice(0, 2000) }),
            sessions: [] });
        }
        const openChildren = this.platform.executions.openChildren(work.id);
        groups.get(key).sessions.push({ session_id: work.id, engine: work.engine, work_summary: work.work_summary,
          status: work.status, waiting_summary: work.waiting_summary, acceptance_state: work.acceptance_state,
          control: work.control, latest_call_id: work.latest_call_id,
          ...(openChildren.length ? { open_children: openChildren.map(child => ({ session_id: child.id, status: child.status, acceptance_state: child.acceptance_state })) } : {}),
          ...(work.pending_input?.length ? { pending_requests: work.pending_input, input_targets: work.input_targets } : {}) });
      }
      for (const group of groups.values()) facts.push(textMessage(group));
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
        call_id: call.id, source_event_ids: call.source_event_ids || [], initiating_principal: call.initiating_principal };
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
