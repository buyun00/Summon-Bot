import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assertInstallationWritable, readInstallationState } from '../../../scripts/installation/installation-state.mjs';
import { inspectServiceLock } from '../../../scripts/installation/service-lock.mjs';
import { botStateDbPath, readBotInstructions } from '../../../capabilities/bot-management/folders.mjs';
import { botMaintenanceRoomId, groupLeadRole } from '../../../capabilities/bot-management/roles.mjs';
import { tools } from '../../../capabilities/platform/contract.mjs';
import { deliveryRecords } from '../../../capabilities/platform/delivery.mjs';
import { sessionRecords } from '../../../capabilities/platform/executions.mjs';
import { waitRecords } from '../../../capabilities/platform/calls.mjs';
import { workGroup } from '../../../capabilities/platform/session-work.mjs';
import { BotStore } from '../storage/store.mjs';
import { Inbox } from '../storage/inbox.mjs';
import { eventOrder, executionRef, now, recordKey, refKey, runtimeFailure, runtimeRecords as R, sameRef, terminalCallStates } from '../storage/runtime-records.mjs';
import { BotEngine } from '../agent/engine.mjs';
import { bindModel } from '../agent/model.mjs';
import { connectionPath } from '../agent/connections.mjs';
import { UsageLedger } from '../agent/usage.mjs';
import { createRedactor } from './config.mjs';
import { textMessage, transcriptPage } from '../context/projection.mjs';
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
    const grants = [[before[1], after[1]], [before[2], after[2]],
      [before[3][0], after[3][0]], [before[3][1], after[3][1]]];
    const retained = grants.every(([earlier, authorized]) => {
      const allowed = new Set(authorized.map(value => recordKey(value)));
      return earlier.every(value => allowed.has(recordKey(value)));
    });
    return retained && recordKey(...earlierDetails) === recordKey(...currentDetails);
  } catch { return false; }
}
const protectedEvents = new Set(['work.tool']);
const protectedEvent = event => protectedEvents.has(event.type);
const isTerminalReceipt = (event, wait) => event?.type === 'call.receipt' && event.call_id === wait.call_id && terminalCallStates.has(event.status);
const callSettled = status => status !== 'unknown' && terminalCallStates.has(status);
const roomEvent = message => ({
  id: message.id, kind: 'event', type: 'message', space: { kind: 'room', id: message.roomId },
  sequence: message.sequence, time: message.createdAt,
  author: message.author || (message.senderId === 'user' ? { kind: 'user', id: 'user' } :
    message.senderId === 'system' ? { kind: 'platform', id: 'platform' } : botRef(message.senderId)),
  ...(message.senderName ? { sender_name: message.senderName } : {}),
  text: message.content, attachments: message.attachments, references: message.references, mentions: message.mentions, reply_to: message.replyTo,
  ...(message.forSessionId ? { for_session_id: message.forSessionId } : {}),
  ...(message.originMessageId ? { origin_message_id: message.originMessageId } : {}),
  ...(message.prompt ? { prompt: message.prompt } : {}),
  ...(message.promptResponse ? { prompt_response: message.promptResponse } : {}),
  ...(message.promptAnswer ? { prompt_answer: message.promptAnswer } : {}),
});

const liveSessionStatuses = new Set(['opening', 'running', 'submitted', 'waiting', 'queued', 'needs_input', 'awaiting_input']);
const wRoomOf = work => work?.origin_room || (work?.space?.kind === 'room' ? work.space : null);

function compactActivityText(value, maxLen = 44) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().replace(/[。！？!?,，；;…\.]+$/u, '');
  if (!text) return null;
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function ensureDoingText(value, maxLen = 44) {
  const cleaned = compactActivityText(value, maxLen);
  if (!cleaned) return null;
  if (/^(正在|等待|准备|已)/.test(cleaned)) return cleaned;
  const sep = /^[A-Za-z0-9]/.test(cleaned) ? ' ' : '';
  const prefixed = `正在${sep}${cleaned}`;
  return prefixed.length > maxLen ? `${prefixed.slice(0, maxLen - 1)}…` : prefixed;
}

function shortPathLabel(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.trim().replace(/[\\/]+$/, '');
  if (!cleaned) return '';
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return compactActivityText(parts.at(-1) || cleaned, 22) || '';
}

function describeToolActivity(name, args = {}, platform = null) {
  switch (name) {
    case 'configure_room': {
      if (args.workspace !== undefined) {
        if (args.workspace === null) return '正在解绑工作区';
        const rawWs = typeof args.workspace === 'string' ? args.workspace : args.workspace?.id;
        const wsRecord = rawWs && platform?.store?.get('platform-workspaces', rawWs);
        const label = compactActivityText(wsRecord?.name || shortPathLabel(wsRecord?.path || rawWs || ''), 20);
        return label ? `正在绑定工作区 ${label}` : '正在绑定工作区';
      }
      if (args.add_members?.length || args.remove_members?.length) return '正在调整群成员';
      if (args.title) return '正在更新群名称';
      if (args.pin_add?.length || args.pin_remove?.length) return '正在更新群置顶';
      return '正在更新群配置';
    }
    case 'open_session': {
      if (args.work_summary) return ensureDoingText(args.work_summary, 44);
      const engine = typeof args.engine === 'string' ? args.engine.trim() : '';
      if (engine === 'exec') {
        const label = args.input?.script || 'exec';
        return `正在执行 ${compactActivityText(label, 22)}`;
      }
      if (engine && engine !== 'pi') {
        return `正在通过 ${compactActivityText(engine, 18)} 执行任务`;
      }
      return '正在启动执行任务';
    }
    case 'configure_session':
      return args.work_summary ? ensureDoingText(args.work_summary, 44) : '正在更新任务状态';
    case 'update_goal':
      return args.title ? `正在更新计划：${compactActivityText(args.title, 26)}` : '正在更新目标与执行步骤';
    case 'send_input':
      return args.kind === 'reply' ? '正在回应执行请求' : '正在向执行会话发送指令';
    case 'stop_session':
      return '正在停止执行任务';
    case 'find': {
      const kind = args.kind;
      if (kind === 'workspace') return '正在查找工作区';
      if (kind === 'file') return args.query ? `正在搜索资料 ${compactActivityText(args.query, 18)}` : '正在查找资料';
      if (kind === 'bot') return '正在查看成员列表';
      if (kind === 'engine') return '正在查看工作引擎';
      if (kind === 'capability') return '正在查看平台能力';
      if (kind === 'knowledge') return args.query ? `正在检索共享笔记 ${compactActivityText(args.query, 18)}` : '正在查看共享知识库';
      if (kind === 'execution') return '正在查看执行状态';
      if (kind === 'event') return '正在检索群记录';
      if (kind === 'wakeup') return '正在查看提醒规则';
      return '正在检索信息';
    }
    case 'read': {
      const refKind = args.ref?.kind;
      if (refKind === 'workspace') {
        if (args.path) return `正在读取 ${shortPathLabel(args.path)}`;
        if (args.directory) return `正在查看目录 ${shortPathLabel(args.directory)}`;
        return '正在查看工作区目录';
      }
      if (refKind === 'file') return '正在读取资料';
      if (refKind === 'session' || refKind === 'conversation') return '正在查看执行输出';
      if (refKind === 'event') return '正在查看消息详情';
      if (refKind === 'bot') return args.path ? `正在读取 ${shortPathLabel(args.path)}` : '正在查看成员配置';
      if (refKind === 'engine') return args.path ? `正在读取工作引擎 ${shortPathLabel(args.path)}` : '正在查看工作引擎';
      if (refKind === 'capability') return args.path ? `正在读取能力文件 ${shortPathLabel(args.path)}` : '正在读取能力说明';
      if (refKind === 'knowledge') return `正在读取共享笔记 ${shortPathLabel(args.path || args.ref?.id || '')}`;
      if (refKind === 'room') return '正在读取群信息';
      return '正在读取内容';
    }
    case 'save_file': {
      const target = shortPathLabel(args.path || args.name || '');
      return target ? `正在写入 ${target}` : '正在保存资料';
    }
    case 'create_bot':
      return args.name ? `正在创建成员 ${compactActivityText(args.name, 16)}` : '正在创建成员';
    case 'configure_bot':
      return args.name ? `正在更新成员名称为 ${compactActivityText(args.name, 16)}` : '正在更新成员配置';
    case 'create_room':
      return '正在创建会话';
    case 'set_wakeup':
      return '正在设置提醒与订阅';
    case 'configure_workspace':
      return args.remove ? '正在移除工作目录' : args.name ? `正在登记工作目录 ${compactActivityText(args.name, 16)}` : '正在登记工作目录';
    case 'manage_hub': {
      if (args.action === 'status') return '正在检查云端中枢状态';
      if (args.action === 'login' || args.action === 'register') return '正在连接云端中枢';
      if (args.action === 'disconnect') return '正在断开云端中枢';
      if (args.action === 'rename_node') return '正在修改本机名称';
      return '正在管理云端中枢';
    }
    case 'send':
      return args.prompt ? '正在发送确认卡片' : '正在整理并回复';
    default:
      return '正在处理任务';
  }
}

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
    this.liveActivities = new Map();
    this.conversationActivities = new Map();
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
    const file = botStateDbPath(this.dataRoot, botId);
    let inbox, store;
    try {
      if (!create) {
        try { await stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      } else {
        await mkdir(dirname(file), { recursive: true });
      }
      store = new BotStore(file);
      inbox = new Inbox(store, botId);
      store.transaction(() => {
        for (const run of inbox.list(R.run, 'state', 'running')) inbox.putRun({ id: run.id, state: 'interrupted' });
        for (const conversation of store.listRecords(R.conversation)) this.syncConversationControl(inbox, conversation);
        this.reconcileReturnWaits(inbox);
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
          facts = { input_revision: input.input_revision, native: { conversation_id: input.conversation_id, run_id: input.run_id } };
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

  async dispatch(inbox, bot) {
    const snapshot = inbox.pending();
    const settled = new Set(snapshot.filter(route =>
      this.settledProgress(inbox, route) || this.deadWaitRoute(inbox, route) || this.deadPiInputRoute(inbox, route)));
    if (settled.size) this.discard(inbox, [...settled], 'cancelled');
    const pending = snapshot.filter(route => !settled.has(route));
    const unassigned = new Map();
    const fastReadBatches = new Map();
    for (const route of pending) {
      if (route.run_id) continue;
      if (!route.wait_id && route.event.type === 'message' && route.event.space?.kind === 'room' &&
          route.event.fallback_reason !== 'host_manual_fallback' &&
          !route.match_sources?.some(source => source.kind === 'unanswered_fallback')) {
        const observation = this.platform.deliveries.roomObservation(bot.id, route.event.space.id);
        if (observation && route.event.sequence <= (observation.through?.sequence ?? 0) &&
            route.match_sources?.some(source => source.kind === 'room_base')) {
          if (route.event.sequence > observation.start_sequence) {
            this.discard(inbox, [route], 'processed');
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
      if (!route.wait_id && route.event.type === 'message' && route.event.space?.kind === 'room' &&
          route.event.fallback_reason !== 'host_manual_fallback') {
        const existingReply = this.findCompletedRoomReply(bot.id, route.event.space.id, route.event_id);
        if (existingReply) {
          const { event: _event, ...stored } = route;
          inbox.store.putRecord(R.route, { ...stored, state: 'processed', processed_at: now(), public_reply: existingReply });
          this.consumeDeliveries(inbox, [route.event_id]);
          continue;
        }
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
        } else {
          const carried = [];
          const supersededRuns = [];
          if (conversation.kind === 'room') {
            for (const prior of inbox.runs(conversation.id)) {
              if (prior.state !== 'suspended' || prior.error?.code !== 'model_response_incomplete' || inbox.hasOpenWaits(prior.id)) continue;
              const priorPending = prior.route_ids
                .map(id => inbox.store.getRecord(R.route, id))
                .filter(route => route?.state === 'pending' && !route.wait_id && inbox.event(route.event_id)?.type === 'message');
              if (priorPending.length) {
                carried.push(...priorPending);
                supersededRuns.push(prior);
              }
            }
          }
          const combined = [...carried, ...newRoutes].filter((route, index, all) =>
            all.findIndex(other => other.id === route.id) === index);
          inbox.createRun(conversation, combined);
          for (const prior of supersededRuns) inbox.putRun({ id: prior.id, state: 'cancelled' });
        }
      }
    }

    for (const conversation of inbox.store.listRecords(R.conversation)) {
      if (conversation.kind === 'material') continue;
      if (!this.registered(conversation)) this.register(inbox, conversation);
      if (this.active.has(conversation.id) || this.starting.has(conversation.id)) continue;
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
      this.launch(inbox, conversation, inbox.run(run.id), bot);
    }
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
    if (!conversation?.session_id) return false;
    const parentSession = this.platform.executions.record(sessionRef(conversation.session_id));
    const parentDead = Boolean(parentSession && this.platform.executions.sessionOrAncestorClosed(parentSession));
    if (!parentDead && this.conversationActive(conversation)) return false;
    const call = this.platform.store.get('platform-calls', wait.call_id);
    const events = (wait.event_ids || []).map(id => inbox.event(id)).filter(Boolean);
    if (!this.conversationActive(conversation) && (call?.status === 'not_submitted' || events.some(event => event.status === 'not_submitted'))) return true;
    return Boolean(parentDead && (callSettled(call?.status) || events.some(event => callSettled(event.status))));
  }

  deadPiInputRoute(inbox, route) {
    if (route.wait_id || route.event?.type !== 'pi.input') return false;
    const conversation = route.conversation_id && inbox.conversation(route.conversation_id);
    const session = conversation?.session_id && this.platform.executions.record(sessionRef(conversation.session_id));
    if (!session || !this.platform.executions.sessionOrAncestorClosed(session)) return false;
    const input = route.event.call_id && inbox.store.getRecord(R.input, route.event.call_id);
    return Boolean(input && terminalCallStates.has(input.status) && input.receipt_pending === 'saved');
  }

  runMatchesRecoveryScope(inbox, conversation, run, bot, scope) {
    if (!scope?.kind) return false;
    const actor = botRef(bot.id);
    const details = run.error?.details;
    const convSession = conversation.session_id ? this.platform.executions.record(sessionRef(conversation.session_id)) : null;
    if (scope.kind === 'model') {
      if (scope.id && !this.platform.canUseModel(actor, scope.id)) return false;
      const purpose = conversation.kind === 'fast_read' ? 'fast_read' : 'conversation';
      const runModelId = conversation.binding?.model?.connection_id || run.binding?.model?.connection_id ||
        this.platform.models.resolveForBot(bot, purpose)?.connection_id || null;
      return !scope.id || details?.connection_id === scope.id || runModelId === scope.id;
    }
    if (scope.kind === 'bot_access') {
      if (bot.id !== scope.bot_id) return false;
      const room = conversation.space?.kind === 'room' ? this.platform.store.get('rooms', conversation.space.id) : null;
      return Boolean(scope.model_ids?.length && (run.error?.code === 'connection_forbidden' || scope.model_ids.includes(details?.connection_id))) ||
        Boolean(scope.workspace_ids?.length && (scope.workspace_ids.includes(details?.workspace_id) ||
          scope.workspace_ids.includes(convSession?.workspace_ref?.id) || scope.workspace_ids.includes(room?.workspace?.id)));
    }
    if (scope.kind === 'workspace') {
      if (!scope.id || !this.platform.workspaceAvailable(scope.id, actor)) return false;
      const room = conversation.space?.kind === 'room' ? this.platform.store.get('rooms', conversation.space.id) : null;
      return details?.workspace_id === scope.id || convSession?.workspace_ref?.id === scope.id || room?.workspace?.id === scope.id;
    }
    return false;
  }

  resumeAuthorizedRuns(inbox, conversation, bot, recoveryScope = null) {
    const recoverableCodes = new Set(['connection_forbidden', 'connection_unavailable', 'access_changed', 'updating', 'auth_expired', 'quota_exhausted']);
    const candidates = inbox.runs(conversation.id).filter(run =>
      (run.state === 'suspended' || run.state === 'retry') && recoverableCodes.has(run.error?.code) &&
      (inbox.hasOpenWaits(run.id) || run.route_ids.some(id => inbox.store.getRecord(R.route, id)?.state === 'pending')));
    if (!candidates.length) return;
    const actor = botRef(bot.id);
    const fixedConnection = conversation.binding?.model?.connection_id || null;
    const purpose = conversation.kind === 'fast_read' ? 'fast_read' : 'conversation';
    const resolved = fixedConnection ? null : this.platform.models.resolveForBot(bot, purpose);
    const resolvedAuthorized = Boolean(resolved && this.platform.canUseModel(actor, resolved.connection_id));
    for (const run of candidates) {
      const runConnection = fixedConnection || run.binding?.model?.connection_id || null;
      const keepBinding = Boolean(runConnection && this.platform.canUseModel(actor, runConnection));
      if (!recoveryScope) {
        // Normal scheduling scan must never clear backoff timers/counts on retry runs
        // or wake non-authorization suspended runs without an explicit recovery event.
        if (run.state !== 'suspended' || run.error?.code !== 'connection_forbidden') continue;
        if (!keepBinding && (fixedConnection || !resolvedAuthorized)) continue;
      } else {
        if (run.error?.code === 'connection_forbidden' && !keepBinding && (fixedConnection || !resolvedAuthorized)) continue;
        if (!this.runMatchesRecoveryScope(inbox, conversation, run, bot, recoveryScope)) continue;
      }
      inbox.putRun({ id: run.id, state: 'pending', retry_at: null, error: null, transient_retry: null,
        ...(!keepBinding && run.binding ? { binding: null } : {}) });
    }
  }

  resumeRecoveredRuns(scope = null) {
    if (!scope || !scope.kind) return;
    for (const [botId, inbox] of this.inboxes) {
      if (scope.kind === 'bot_access' && scope.bot_id && botId !== scope.bot_id) continue;
      const bot = this.platform.store.get('platform-bots', botId);
      if (!bot?.enabled || bot.archivedAt) continue;
      for (const conversation of inbox.store.listRecords(R.conversation)) {
        if (!this.conversationActive(conversation)) continue;
        this.resumeAuthorizedRuns(inbox, conversation, bot, scope);
      }
    }
    this.wake();
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
          const call = wait && this.platform.store.get('platform-calls', wait.call_id);
          if (resolvedEvent && (isTerminalReceipt(resolvedEvent, wait) || callSettled(call?.status))) inbox.settleWait(stored, status);
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

  findCompletedRoomReply(botId, roomId, eventId) {
    const reply = this.platform.room.replyBy(roomId, botId, eventId);
    const call = reply?.callId && this.platform.store.get('platform-calls', reply.callId);
    if (!reply || call?.tool !== 'send' || call.status !== 'completed' || call.origin?.bot_id !== botId ||
        call.result?.message?.id !== reply.id) return null;
    return { message_id: reply.id, call_id: call.id };
  }

  reconcileRoomReply(inbox, event) {
    if (event?.type !== 'message' || event.space?.kind !== 'room') return;
    const route = inbox.store.getRecord(R.route, recordKey(event.id, 'observation'));
    if (!route || route.state !== 'pending' || !route.run_id) return;
    const run = inbox.run(route.run_id);
    if (!run || run.state !== 'suspended' || this.active.get(run.conversation_id)?.runId === run.id) return;
    const replied = this.findCompletedRoomReply(inbox.botId, event.space.id, event.id);
    if (replied) {
      inbox.store.putRecord(R.route, { ...route, state: 'processed', processed_at: now(), public_reply: replied });
      return;
    }
    if (run.error?.code === 'model_response_incomplete' && !inbox.hasOpenWaits(run.id)) {
      const seq = event.sequence ?? this.platform.room.messageRow?.get(event.id)?.sequence;
      if (!Number.isSafeInteger(seq)) return;
      const suspendedAt = Date.parse(run.updated_at || 0);
      const covering = inbox.runs(run.conversation_id).find(other =>
        other.id !== run.id && other.state === 'completed' &&
        Number.isSafeInteger(other.public_prefix_end) && other.public_prefix_end >= seq &&
        Date.parse(other.updated_at || 0) >= suspendedAt);
      if (covering) {
        inbox.store.putRecord(R.route, { ...route, state: 'processed', processed_at: now(), superseded_by_run_id: covering.id });
      }
    }
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
    return { name: bot.name, instructions: readBotInstructions(this.dataRoot, bot), public_duty: bot.public_duty || '', revision: bot.revision,
      built_in_role: bot.built_in_role ?? null, model: bindModel(this.model, resolved, purpose) };
  }

  notifyRoomActivity(roomId, activity) {
    if (!roomId || !activity || this.closed || this.draining) return;
    // Only actual room messages (send) preempt peer bots' in-flight thinking streams.
    // Background sessions (open_session) and room/bot config calls stay visible via
    // room_peer_activities and guardRoomWriteActivity without aborting peers mid-thought.
    if (activity.tool !== 'send') return;
    const MAX_PREEMPTS_PER_RUN = 3;
    for (const job of this.active.values()) {
      if (job.conversation?.kind !== 'room' || job.conversation?.space?.id !== roomId || job.conversation?.session_id) continue;
      if (job.botId === activity.actor_id) continue;
      if (!job.activeStream || job.inToolCall || job.signal?.aborted) continue;
      if (activity.seq <= (job.lastPreemptedSeq ?? 0) || (job.preemptCount ?? 0) >= MAX_PREEMPTS_PER_RUN) continue;
      job.lastPreemptedSeq = activity.seq;
      job.preemptCount = (job.preemptCount ?? 0) + 1;
      job.preemptedForActivity = true;
      job.activeStream.controller.abort(runtimeFailure('room_activity_preempted', 'Peer message arrived in the room', 409));
    }
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
          canRetainAuthorizationView(inbox.run(run.id).model_outcome_uses_view, startView.view_revision) ? storedOutcome : null;
        const result = restored || await this.engine.execute(job);
        job.check();
        const view = job.view();
        const cancelledProgress = [];
        if (conversation.kind === 'room' && conversation.space?.kind === 'room' && !conversation.session_id) {
          const roomId = conversation.space.id;
          if (this.platform.deliveries.roomObservation(bot.id, roomId)) {
            const latestMsg = this.platform.room.lastSavedMessage?.get(roomId);
            const maxSeq = job.seenRoomSequence ?? latestMsg?.sequence ?? 0;
            const throughId = inbox.run(run.id).history_read_through ?? latestMsg?.id ?? null;
            const throughPos = maxSeq > 0 && throughId
              ? { id: throughId, sequence: maxSeq }
              : (latestMsg ? { id: latestMsg.id, sequence: latestMsg.sequence } : null);
            this.platform.deliveries.advanceObservationQuiet(bot.id, roomId, throughPos, result.eventIds);
            const base = this.platform.store.get('platform-wakeups', JSON.stringify(['room_base', bot.id, roomId]));
            if (base?.observation && base.enabled && base.member_active !== false && !base.observation.pending) {
              this.platform.deliveries.queueDueObservation(base);
            }
          }
        }
        const state = inbox.store.transaction(() => {
          inbox.complete(run.id, 'running', result.eventIds, { result: { text: result.text, model: result.model, response_id: result.response_id } },
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
            ...(run.transport_retry && { transport_retry: null }),
            ...(run.transient_retry && { transient_retry: null }) });
          if (next === 'completed' || next === 'waiting') this.stageInputs(inbox, conversation, run.id, next, result);
          return next;
        });
        this.flushInputs(inbox);
        this.consumeDeliveries(inbox, [...result.eventIds, ...cancelledProgress]);
        this.emit('engine.finished', { ...refs, state, model: result.model });
      } catch (error) {
        const code = error.code || 'runtime_error';
        const latestRun = inbox.run(run.id);
        let transportRetry;
        if (code === 'model_transport_interrupted' && !controller.signal.aborted) {
          const completed = inbox.transcript(run.id).findLast(message => message.role === 'toolResult' ||
            message.role === 'assistant' && ['stop', 'toolUse'].includes(message.stopReason));
          const position = recordKey(latestRun.input_revision, latestRun.injected_event_ids.at(-1), completed?.timestamp);
          const attempts = latestRun.transport_retry?.position === position ? latestRun.transport_retry.attempts + 1 : 1;
          transportRetry = { position, attempts };
        }
        const transientCodes = ['access_changed', 'connection_unavailable', 'updating', 'call_result_unknown'];
        let transientRetry;
        if (transientCodes.includes(code) && !controller.signal.aborted) {
          const attempts = latestRun.transient_retry?.code === code ? latestRun.transient_retry.attempts + 1 : 1;
          transientRetry = { code, attempts };
        }
        const maxTransientAttempts = 5;
        const retry = !controller.signal.aborted &&
          (transportRetry?.attempts <= 2 || (transientRetry && transientRetry.attempts <= maxTransientAttempts));
        const retryDelayMs = transportRetry
          ? (transportRetry.attempts === 2 ? 30000 : 10000)
          : transientRetry
            ? Math.min(160000, 10000 * (2 ** (transientRetry.attempts - 1)))
            : 10000;
        const retryAt = retry ? Date.now() + retryDelayMs : null;
        const roomRevoked = code === 'execution_not_found' && conversation.kind === 'room' &&
          !this.platform.canReadSpace(botRef(bot.id), conversation.space);
        const explicitInterrupt = controller.signal.aborted && controller.signal.reason?.code === 'execution_interrupted';
        const controlStopped = controller.signal.aborted && ['execution_paused', 'bot_paused', 'execution_interrupted'].includes(controller.signal.reason?.code);
        const stopped = controller.signal.aborted || code === 'execution_paused' || code === 'bot_paused' || code === 'execution_interrupted';
        const diagnostic = this.clean.error(cleanError(error));
        const finalState = retry ? 'retry' : roomRevoked ? 'access_revoked' : explicitInterrupt ? 'stopped' : stopped ? 'interrupted' : 'suspended';
        inbox.putRun({ id: run.id, state: finalState,
          retry_at: retryAt ? new Date(retryAt).toISOString() : null,
          error: diagnostic,
          ...(transportRetry && { transport_retry: transportRetry }),
          ...(transientRetry && { transient_retry: transientRetry }) });
        if (finalState === 'suspended') {
          const sourceIds = [...new Set([...(latestRun.injected_event_ids || []), ...(latestRun.pending_event_ids || [])])];
          for (const eventId of sourceIds) {
            this.platform.deliveries.recordWakeupOutcome(eventId, bot.id, { outcome: 'failed', error: code });
            const ev = inbox.event(eventId);
            if (ev?.type === 'call.receipt' && ev.target?.kind === 'session') {
              const sess = this.platform.executions.record(ev.target);
              if (sess && sess.origin_room) {
                this.platform.deliverResultToHost?.({
                  reason: 'owner_run_suspended',
                  session: sess,
                  callId: ev.call_id,
                  status: ev.status,
                  receipt: { kind: 'event', id: ev.id },
                });
              }
            }
          }
        }
        if (roomRevoked) this.discard(inbox, inbox.pending().filter(route => route.run_id === run.id), 'access_revoked');
        if (!retry && !stopped && conversation.kind === 'room' && conversation.space.kind === 'room')
          this.platform.deliveries.releaseSuspendedObservation(bot.id, conversation.space.id, inbox.run(run.id).pending_event_ids);
        if ((!retry && !stopped) || explicitInterrupt || (controlStopped && (this.targetPaused(conversationRef(conversation.id)) ||
            conversation.session_id && this.targetPaused(sessionRef(conversation.session_id))))) {
          this.stageInputs(inbox, conversation, run.id, controlStopped ? 'stopped' : roomRevoked ? 'failed' : 'unknown');
          this.flushInputs(inbox);
        }
        this.emit('engine.interrupted', { ...refs, ...diagnostic });
      } finally {
        this.active.delete(conversation.id);
        const roomId = this.roomIdForConversation(conversation);
        this.clearLiveActivity(bot.id, roomId, ['thinking', 'tool', 'planned'], conversation.id);
        try {
          for (const target of [conversationRef(conversation.id), ...(conversation.session_id ? [sessionRef(conversation.session_id)] : [])]) {
            const latest = this.platform.executions.record(target);
            if (latest?.control?.state === 'paused' && latest.control.stop_status === 'pending')
              this.platform.executions.saveControl(target, { ...latest.control, stop_status: 'stopped' });
          }
        } finally { settle(); }
      }
    }).catch(error => {
      const transient = error.status === 503;
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
      return { actor, execution_actor: actor, controls, submitted_by: latest.submitted_by || source?.author || actor,
        input_refs: [], signal: controller.signal, origin: { bot_id: bot.id, conversation_id: conversation.id, run_id: run.id,
          event_ids, control_version: control.control_version, session_id: conversation.session_id || null,
          ...(Number.isSafeInteger(job.seenRoomSequence) ? { seen_room_sequence: job.seenRoomSequence } : {}),
          ...(Number.isSafeInteger(job.seenRoomActivitySeq) ? { seen_room_activity_seq: job.seenRoomActivitySeq } : {}),
          own_run_send_call_ids: job.ownRunSendCallIds,
          own_run_activity_call_ids: job.ownRunActivityCallIds } };
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
    const roomId = this.roomIdForConversation(conversation);
    const executionRef = conversation.session_id ? sessionRef(conversation.session_id) : target;
    const isRoomConv = conversation.kind === 'room' && conversation.space?.kind === 'room' && !conversation.session_id;
    if (isRoomConv && roomId && Array.isArray(run.injected_event_ids)) {
      for (const eventId of run.injected_event_ids) {
        this.platform.room?.ackMentionedMessage?.(roomId, eventId, bot.id, '收到');
      }
    }
    const initialActivitySeq = isRoomConv && this.platform.currentRoomActivitySeq
      ? this.platform.currentRoomActivitySeq(conversation.space.id) : null;
    const job = { inbox, conversation, botId: bot.id, runId: run.id, binding, controller, signal: controller.signal, context, check, accepting: true,
      startedAt: run.first_started_at || now(),
      seenRoomSequence: null,
      roomActivityStartSeq: initialActivitySeq,
      seenRoomActivitySeq: initialActivitySeq,
      ownRunSendCallIds: new Set(),
      ownRunActivityCallIds: new Set(),
      activeStream: null,
      inToolCall: false,
      lastPreemptedSeq: initialActivitySeq ?? 0,
      preemptCount: 0,
      preemptedForActivity: false,
      toolCallCount: 0,
      lastToolName: null,
      canRetainAuthorizationView,
      onModelStep: ({ toolCount, lastTool, hasReceipt }) => {
        let text;
        if (toolCount === 0) {
          if (hasReceipt) {
            text = '正在核验执行结果';
          } else {
            const existing = roomId && this.liveActivities.get(recordKey(roomId, bot.id));
            text = existing?.phase === 'planned' && existing.text ? existing.text : '正在分析需求';
          }
        } else if (lastTool === 'open_session') {
          const existing = roomId && this.liveActivities.get(recordKey(roomId, bot.id));
          text = existing?.text || '正在推进执行任务';
        } else if (lastTool === 'send') {
          text = '正在收尾';
        } else {
          text = '正在分析结果，整理结论';
        }
        this.setLiveActivity(bot.id, roomId, {
          phase: 'thinking',
          text,
          execution_ref: executionRef,
          conversation_id: conversation.id,
        });
      },
      onToolActivity: (name, args) => {
        const text = describeToolActivity(name, args, this.platform);
        this.setLiveActivity(bot.id, roomId, {
          phase: 'tool',
          text,
          execution_ref: executionRef,
          conversation_id: conversation.id,
        });
      },
      view: () => {
        const view = this.authorizationView(context(), conversation, inbox, inbox.run(run.id));
        inbox.attachReturnWaits(conversation.id, run.id, view.pending_return_waits);
        return view;
      },
      refresh: window => this.contextBoundary(job, window),
      canReadReference: ref => this.platform.canReadReference(ref, this.platform.context(context())),
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

  async contextBoundary(job) {
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
    const roomRecord = conversation.kind === 'room' && conversation.space.kind === 'room'
      ? this.platform.store.get('rooms', conversation.space.id)
      : null;
    if (roomRecord?.workspace) {
      facts.push(textMessage({ type: 'project_workspace', room: conversation.space, workspace: roomRecord.workspace }));
    }
    if (roomRecord?.origin_room?.id) {
      const originRoomRecord = this.platform.store.get('rooms', roomRecord.origin_room.id);
      facts.push(textMessage({
        type: 'room_origin',
        room: conversation.space,
        origin_room: {
          kind: 'room',
          id: roomRecord.origin_room.id,
          ...(originRoomRecord?.name ? { name: originRoomRecord.name } : {}),
          readable: this.platform.canReadRoomHistory(context.actor, roomRecord.origin_room),
        },
      }));
    }
    const activeRoomId = conversation.kind === 'room' && conversation.space?.kind === 'room'
      ? conversation.space.id
      : (view.session?.origin_room?.id || null);
    const originRoomId = roomRecord?.origin_room?.id
      || (activeRoomId ? this.platform.store.get('rooms', activeRoomId)?.origin_room?.id : null)
      || null;
    const selfClones = this.collectSelfClones(inbox, conversation, activeRoomId, originRoomId);
    if (selfClones.length) {
      facts.push(textMessage({
        type: 'self_clones',
        note: '你（同一 Bot 本体）在其他群的分身状态与近期结论；同体内部数据可直接 read({ref:{kind:"conversation",id}}) 查看完整对话、思考与回执，或用 send_input 内部联动，切勿在群聊里 @自己。',
        clones: selfClones,
      }));
    }
    if (Array.isArray(roomRecord?.pins) && roomRecord.pins.length) {
      const readablePins = roomRecord.pins
        .filter(ref => job.canReadReference(ref))
        .sort((a, b) => refKey(a).localeCompare(refKey(b)));
      if (readablePins.length) {
        facts.push(textMessage({ type: 'room_pins', room: conversation.space, pins: readablePins }));
      }
    }
    const goalRoomId = conversation.kind === 'room' && conversation.space?.kind === 'room'
      ? conversation.space.id
      : (view.session?.origin_room?.id || null);
    const activeRoomGoal = goalRoomId ? this.platform.goals?.view(goalRoomId) : null;
    if (activeRoomGoal) {
      facts.push(textMessage({
        type: 'room_goal',
        room: { kind: 'room', id: goalRoomId },
        goal: {
          title: activeRoomGoal.title,
          intent: activeRoomGoal.intent || 'inquiry',
          done_criteria: activeRoomGoal.done_criteria || '',
          status: activeRoomGoal.status,
          owner_bot_id: activeRoomGoal.owner_bot_id,
          stalled: Boolean(activeRoomGoal.stalled),
          revision: activeRoomGoal.revision,
          progress: activeRoomGoal.progress,
          steps: activeRoomGoal.steps,
          ...(activeRoomGoal.user_replied_at ? { user_replied_at: activeRoomGoal.user_replied_at } : {}),
        },
        ...(activeRoomGoal.status === 'awaiting_user' ? {
          note: activeRoomGoal.user_replied_at
            ? '宿主已在此旧目标 awaiting_user 后发出新消息。若本轮需要继续推进或改换计划，请调用 update_goal 更新；若旧目标已结束或换题且不再需要跟踪，可直接调 update_goal(clear:true) 清除（未更新时本轮结束后平台也会自动清理）。'
            : '当前群目标处于 awaiting_user。若本轮宿主消息已回应确认、切到了新问题或旧任务已结束，务必调用 update_goal 更新步骤、标记 completed 或 clear:true，避免旧目标长期滞留；若仍需宿主确认，务必在对应步骤 note 中写清具体需要确认什么。',
        } : {}),
      }));
    }
    const workEngines = this.platform.workEngines?.() || [];
    if (workEngines.length) {
      facts.push(textMessage({
        type: 'work_engines',
        engines: workEngines.map(({ id, name, tiers }) => ({
          id,
          name,
          ...(tiers && Object.keys(tiers).length ? { tiers } : {}),
        })),
      }));
    }
    if (!conversation.session_id && roomRecord && roomRecord.mode === 'group' && roomRecord.id !== botMaintenanceRoomId) {
      const leadBot = this.platform.store.get('platform-bots', context.actor.id);
      const isRoomLead = roomRecord.lead_bot_id === context.actor.id || leadBot?.built_in_role?.id === groupLeadRole;
      const needsRoomTitle = isRoomLead && roomRecord.auto_title_pending === true;
      if (needsRoomTitle) {
        const existingGroupNames = this.platform.store.list('rooms')
          .filter(item => item.mode === 'group' && item.id !== roomRecord.id && item.name)
          .map(item => item.name)
          .slice(0, 40);
        facts.push(textMessage({
          type: 'room_naming_required',
          room: { id: roomRecord.id, name: roomRecord.name, revision: roomRecord.revision },
          needs_room_title: true,
          ...(existingGroupNames.length ? { existing_group_names: existingGroupNames } : {}),
          instruction: [
            `当前新建群聊尚未完成 AI 总结命名。请在调用 send 回复宿主前，结合宿主消息的核心目标与主题（严禁机械截取用户原话前几个字），调用 configure_room({ room: "${roomRecord.id}", revision: ${roomRecord.revision}, title: "<2-12字简洁总结群名>" }) 更新群名（避开已有群名）；`,
            '仅当宿主首条消息是完全没有主题的纯寒暄且未绑定明确目录时，可先问清目标待下轮再命名。',
          ].join(' '),
        }));
      }
    }
    let observation;
    const observing = conversation.kind === 'room' && conversation.space.kind === 'room' &&
      this.platform.deliveries.roomObservation(context.actor.id, conversation.space.id);
    if (observing) {
      observation = { from: observing.through, generation: observing.generation };
    }
    if (conversation.kind === 'room' && conversation.space.kind === 'room' && !conversation.session_id) {
      const roomId = conversation.space.id;
      const locked = run.public_prefix_end !== undefined && run.public_prefix_end !== null;
      const currentRoomSeqs = current
        .filter(event => event.type === 'message' && event.space?.id === roomId && Number.isSafeInteger(event.sequence))
        .map(event => event.sequence);
      const latestEnd = Math.max(this.platform.room.observationEnd(roomId, context.actor.id), ...currentRoomSeqs);
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
      job.seenRoomSequence = Math.max(job.seenRoomSequence ?? 0, latestEnd);
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
          latest_call_id: child.latest_call_id })) }));
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
        if (event.origin_message_id) requestIds.add(event.origin_message_id);
      }
      if (event.type !== 'call.receipt' || !event.call_id || event.result_access === 'revoked') continue;
      const observation = await this.readFor(job, { kind: 'call', id: event.call_id });
      if (!observation || observation.result_access === 'revoked') continue;
      const target = observation.target;
      const session = target?.kind === 'session' && this.platform.executions.record(target);
      if (session && (session.owner_conversation_id === conversation.id || session.owner?.id === context.actor.id || session.execution_actor?.id === context.actor.id)) {
        relevantGroups.add(workGroup(session));
      }
      // The event names an immutable receipt position. A newer receipt may already exist on the call.
      const result = event.result ?? observation.result;
      const content = JSON.stringify(result ?? null);
      const isRoomMainReceipt = !conversation.session_id && conversation.kind === 'room' && event.status === 'completed';
      facts.push(textMessage({ type: 'call_result', call_id: event.call_id, tool: observation.tool, status: event.status, target,
        ...(session ? {
          ...(session.work_summary ? { work_summary: session.work_summary } : {}),
          ...(Array.isArray(session.recent_progress) && session.recent_progress.length ? { steps_taken: session.recent_progress } : {}),
          can_steer: Boolean(session.can_steer),
          can_continue: Boolean(session.can_continue),
        } : {}),
        ...(isRoomMainReceipt ? {
          desk_review_gate: '工位审卷（群里不可见）：先对照宿主真实诉求、host_profile 与已知家底核查 steps_taken 及未查盲区——若交回的只是源码/文档纸面推演、漏查本机或远端真实运行态与网络连通、或方案撞宿主红线，群里保持静默（勿调 send），直接用 send_input/open_session 打回补查；准备调 send 前必对照群内刚发过的消息严格去重，同伴刚说过的结论绝不复读，只发新增硬事实、反驳点、跨岗位 @交接或关键追问。',
        } : {}),
        input_status: result?.input_status, session_status: result?.session_status,
        result_ref: { kind: 'event', id: event.id }, result_position: event.result_position,
        result: content.length <= 256_000 ? result : { preview: content.slice(0, 256_000), characters: content.length, truncated: true } }));
    }
    const allBotOwned = this.platform.executions.botWork ? this.platform.executions.botWork(context.actor.id) : this.platform.executions.directWork(conversation.id);
    if (relevantGroups.size || requestIds.size || inbox.calls(runId).some(call => call.tool === 'open_session')) {
      const owned = allBotOwned;
      if (requestIds.size && conversation.kind === 'room' && !run.receipt_group) {
        const hasActiveOwned = owned.some(w => sameRef(w.origin_room, conversation.space) && !['completed', 'failed', 'stopped'].includes(w.status));
        if (hasActiveOwned || publicRoom?.summary) {
          const recent = new Map();
          for (const work of owned.slice().reverse()) {
            if (!sameRef(wRoomOf(work), conversation.space) || !work.origin_message_id || recent.has(work.origin_message_id)) continue;
            const question = this.platform.store.get('messages', work.origin_message_id);
            if (question?.roomId === conversation.space.id)
              recent.set(question.id, { origin_message_id: question.id, original_question: question.content.slice(0, 160) });
            if (recent.size === 3) break;
          }
          if (recent.size) facts.push(textMessage({ type: 'recent_delegated_questions', questions: [...recent.values()] }));
        }
      }
      for (const work of owned) {
        if (work.owner_run_id === runId || requestIds.has(work.origin_message_id) ||
            (sameRef(wRoomOf(work), conversation.space) && liveSessionStatuses.has(work.status))) {
          relevantGroups.add(workGroup(work));
        }
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
            origin_message_id: work.origin_message_id, ...(question && { original_question: question.content.slice(0, 200) }),
            sessions: [] });
        }
        const descendants = this.platform.executions.descendantSessions(work.id);
        groups.get(key).sessions.push({ session_id: work.id, engine: work.engine, work_summary: work.work_summary,
          status: work.status,
          ...(work.live_progress ? { live_progress: work.live_progress } : {}),
          ...(Array.isArray(work.recent_progress) && work.recent_progress.length ? { recent_progress: work.recent_progress } : {}),
          can_steer: Boolean(work.can_steer),
          can_continue: Boolean(work.can_continue),
          control: work.control, latest_call_id: work.latest_call_id,
          ...(descendants.length ? { descendants: descendants.map(child => ({
            session_id: child.id, engine: child.engine, parent_session_id: child.origin_execution?.id ?? null,
            status: child.status,
          })) } : {}),
          ...(work.pending_input?.length ? { pending_requests: work.pending_input } : {}) });
      }
      for (const group of groups.values()) facts.push(textMessage(group));
    }
    const storedConv = inbox.conversation(conversation.id);
    const lastInputTokens = storedConv?.last_input_tokens ?? 0;
    const contextWindow = job.binding?.model?.context_window ?? 0;
    if (lastInputTokens > 0 && contextWindow > 0 && lastInputTokens / contextWindow >= 0.5) {
      facts.push(textMessage({
        type: 'context_status',
        used_tokens: lastInputTokens,
        context_window: contextWindow,
        usage_ratio: Number((lastInputTokens / contextWindow).toFixed(3)),
      }));
    }
    return { ...view, current, history, facts, observation, publicRoom };
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
      space: session.space, ...(session.origin_room ? { origin_room: session.origin_room } : {}),
      binding: { model, instructions, name: bot.name, revision: session.bot_revision,
        built_in_role: session.built_in_role ?? null }, input_revision: session.input_revision || 0 }));
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
    return { status: 'submitted', input_revision: run.input_revision, native: { conversation_id: details.conversation.id, run_id: run.id }, can_steer: true, can_continue: false };
  }

  async submitConversation(options) { return this.submitInput(options, false); }

  async submitInput({ session, conversation: current, call, kind, input, beforeSubmit, signal }, forSession) {
    if (kind === 'reply') throw runtimeFailure('unsupported', 'Pi has no pending protocol request for this input', 409);
    signal?.throwIfAborted();
    const details = forSession ? await this.firstRun(session) : this.locate(current.id);
    if (!details) throw runtimeFailure('execution_not_found', 'Pi conversation is unavailable', 404);
    const { inbox, conversation } = details;
    const prior = inbox.store.getRecord(R.input, call.id);
    const inspect = () => this.inspectLocal(inbox, conversation, { sessionInput: forSession });
    if (prior) return inspect();
    const checkState = () => {
      const active = this.active.get(conversation.id);
      if (kind === 'steer') {
        if (!active?.accepting) throw runtimeFailure('input_closed', 'The Pi run is no longer accepting live steer input', 409);
        return active;
      }
      if (active || this.starting.has(conversation.id)) {
        throw runtimeFailure('execution_busy', 'Wait for the current Pi turn to finish or use kind:"steer"', 409);
      }
      return null;
    };
    checkState();
    signal?.throwIfAborted();
    await beforeSubmit();
    let active;
    try { signal?.throwIfAborted(); active = checkState(); }
    catch (error) { error.beforeSubmit = true; throw error; }
    const last = kind === 'next' ? this.inputRun(inbox, conversation) : null;
    const resumeSuspended = last?.state === 'suspended' && (forSession || conversation.kind === 'room');
    const continuation = resumeSuspended || forSession && last?.state === 'waiting' ? last : null;
    const { run } = this.acceptInput(details, call, input, kind, active?.runId ?? continuation?.id);
    this.wake();
    return { status: 'submitted', input_revision: run.input_revision, native: { conversation_id: conversation.id, run_id: run.id }, can_steer: true, can_continue: false };
  }

  acceptInput({ inbox, conversation }, call, input, kind, runId) {
    return inbox.store.transaction(() => {
      const current = inbox.conversation(conversation.id);
      const id = recordKey('pi.input', call.id);
      const event = { id, kind: 'event', type: 'pi.input', input, space: conversation.space, author: actorFor(call), time: now(),
        call_id: call.id, source_event_ids: call.source_event_ids || [], initiating_principal: call.initiating_principal };
      const next = inbox.putConversation({ id: current.id, input_revision: current.input_revision + 1 });
      inbox.store.putRecord(R.event, { id, event, received_at: event.time });
      const route = inbox.route(id, { conversation_id: current.id });
      const run = runId ? inbox.associate(runId, [route]) : inbox.createRun(next, [route], { submitted_by: actorFor(call) });
      inbox.store.putRecord(R.input, { id: call.id, run_id: run.id, event_id: id, conversation_id: current.id,
        kind, status: 'submitted', input_revision: next.input_revision, submitted_by: actorFor(call) });
      return { run: inbox.putRun({ id: run.id, input_revision: next.input_revision,
        ...(run.state === 'suspended' ? { state: 'pending', retry_at: null } : {}) }) };
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
    const canContinue = status === 'completed' || (status === 'waiting' && Boolean(conversation.session_id));
    const facts = { status, position: recordKey(input.run_id, status), native: { run_id: input.run_id }, output: result?.text,
      can_steer: false, can_continue: canContinue, input_revision: revision };
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
    return item ? this.inspectLocal(item.inbox, item.conversation, options) : { status: 'unknown', can_steer: false, can_continue: false };
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
      return { status: 'unknown', can_steer: false, can_continue: false, last_error: { code: error.code, message: error.message } };
    }
    const conversation = inbox?.conversation(id);
    return conversation ? this.inspectLocal(inbox, conversation, { ...options, sessionInput: true }) : { status: session.status || 'unknown', can_steer: false, can_continue: false };
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
    const canContinue = !active && !this.starting.has(conversation.id) &&
      (summary.status === 'idle' || summary.status === 'suspended' || sessionInput && summary.status === 'waiting');
    return { ...summary, can_steer: Boolean(active?.accepting), can_continue: canContinue, input_revision: revision };
  }

  collectSelfClones(inbox, currentConversation, activeRoomId = null, originRoomId = null) {
    const botId = inbox.botId;
    const allWork = this.platform.executions.botWork ? this.platform.executions.botWork(botId) : [];
    const candidates = inbox.store.listRecords(R.conversation).filter(c =>
      c.kind === 'room' && !c.session_id && c.id !== currentConversation.id &&
      c.space?.kind === 'room' && c.space.id !== activeRoomId);
    const items = [];
    for (const clone of candidates) {
      const rid = clone.space.id;
      const roomRec = this.platform.store.get('rooms', rid);
      if (!roomRec) continue;
      const runs = inbox.runs(clone.id);
      const lastRun = this.inputRun(inbox, clone, runs);
      const summaryState = this.runSummary(clone.id, lastRun);
      const cloneActiveSessions = allWork
        .filter(s => (s.owner_conversation_id === clone.id || s.origin_room?.id === rid) && liveSessionStatuses.has(s.status))
        .slice(-3)
        .map(s => ({
          session_id: s.id,
          engine: s.engine,
          status: s.status,
          ...(s.work_summary ? { work_summary: s.work_summary } : {}),
          ...(Array.isArray(s.recent_progress) && s.recent_progress.length ? { recent_progress: s.recent_progress.slice(-2) } : {}),
        }));
      let lastHostInput = null;
      let lastSelfConclusion = null;
      for (let i = runs.length - 1; i >= 0 && (!lastHostInput || !lastSelfConclusion); i--) {
        const r = runs[i];
        if (!lastSelfConclusion) {
          const sendCalls = inbox.calls(r.id).filter(call => call.tool === 'send' && typeof call.args?.text === 'string' && call.args.text.trim());
          if (sendCalls.length) {
            lastSelfConclusion = sendCalls.at(-1).args.text.replace(/\s+/g, ' ').trim().slice(0, 200);
          } else if (typeof r.result?.text === 'string' && r.result.text.trim()) {
            lastSelfConclusion = r.result.text.replace(/\s+/g, ' ').trim().slice(0, 180);
          }
        }
        if (!lastHostInput && Array.isArray(r.injected_event_ids)) {
          for (let j = r.injected_event_ids.length - 1; j >= 0; j--) {
            const ev = inbox.event(r.injected_event_ids[j]);
            if (ev?.author?.kind === 'user' && typeof ev.text === 'string' && ev.text.trim()) {
              lastHostInput = ev.text.replace(/\s+/g, ' ').trim().slice(0, 140);
              break;
            }
          }
        }
      }
      const persistedSummary = this.platform.store.get('room-public-history', rid)?.summary;
      const isOrigin = Boolean(originRoomId && rid === originRoomId);
      if (!runs.length && !cloneActiveSessions.length && !persistedSummary && !isOrigin) continue;
      const updatedMs = Date.parse(lastRun?.updated_at || clone.updated_at || roomRec.updatedAt || 0) || 0;
      items.push({
        _sortOrigin: isOrigin ? 1 : 0,
        _sortActive: (summaryState.status === 'running' || cloneActiveSessions.length > 0) ? 1 : 0,
        _updatedMs: updatedMs,
        conversation_id: clone.id,
        room_id: rid,
        room_name: roomRec.name || rid,
        ...(isOrigin ? { is_origin_room: true } : {}),
        ...(roomRec.archivedAt ? { archived: true } : {}),
        status: summaryState.status,
        ...(lastHostInput ? { last_host_input: lastHostInput } : {}),
        ...(lastSelfConclusion ? { last_self_conclusion: lastSelfConclusion } : {}),
        ...(persistedSummary ? { room_consensus_summary: String(persistedSummary).replace(/\s+/g, ' ').trim().slice(0, 220) } : {}),
        ...(cloneActiveSessions.length ? { active_sessions: cloneActiveSessions } : {}),
      });
    }
    return items
      .sort((a, b) => (b._sortOrigin - a._sortOrigin) || (b._sortActive - a._sortActive) || (b._updatedMs - a._updatedMs))
      .slice(0, 6)
      .map(({ _sortOrigin, _sortActive, _updatedMs, ...clean }) => clean);
  }

  inspectCloneInternal(inbox, conversation, { cursor, limit } = {}) {
    if (conversation.session_id || cursor || limit !== undefined) {
      return this.inspectLocal(inbox, conversation, {
        cursor,
        limit,
        sessionInput: Boolean(conversation.session_id),
        modelPage: true,
      });
    }
    const runs = inbox.runs(conversation.id);
    const last = this.inputRun(inbox, conversation, runs);
    const state = this.localInputState(inbox, conversation, false, last);
    const rid = conversation.space?.kind === 'room' ? conversation.space.id : null;
    const roomRec = rid ? this.platform.store.get('rooms', rid) : null;
    const publicSummary = rid ? this.platform.store.get('room-public-history', rid)?.summary || null : null;
    let recentRoomMessages = [];
    if (rid && roomRec) {
      try {
        const allMsgs = this.platform.room.roomMessages.all(rid).map(r => JSON.parse(r.data));
        recentRoomMessages = allMsgs.slice(-16).map(m => ({
          id: m.id,
          sender: m.senderId === 'user' ? '宿主' : (m.senderName || this.platform.actorLabel(m.senderId)),
          text: String(m.content || '').slice(0, 600),
          ...(m.promptResponse ? { prompt_response: m.promptResponse } : {}),
          time: m.createdAt,
        }));
      } catch {}
    }
    const recentInternalRuns = runs.slice(-5).map(r => {
      const calls = inbox.calls(r.id).map(c => ({
        id: c.id,
        tool: c.tool,
        state: c.state,
        ...(c.args?.work_summary ? { work_summary: c.args.work_summary } : {}),
        ...(c.result?.target ? { target: c.result.target } : {}),
      }));
      return {
        run_id: r.id,
        state: r.state,
        updated_at: r.updated_at,
        ...(calls.length ? { calls } : {}),
        ...(typeof r.result?.text === 'string' && r.result.text.trim() ? { internal_thought: r.result.text.slice(0, 600) } : {}),
      };
    });
    return {
      kind: 'conversation',
      id: conversation.id,
      self_clone: true,
      ...(rid ? { room: { id: rid, name: roomRec?.name || rid } } : {}),
      ...state,
      ...(publicSummary ? { room_consensus_summary: publicSummary } : {}),
      recent_room_messages: recentRoomMessages,
      recent_internal_runs: recentInternalRuns,
      next_cursor: 'start',
      note: '以上为你（同一 Bot 本体）在该分身的纯净群对话记录与内部执行脉络；如需逐条翻阅原始 transcript 可传 cursor:"start"。',
    };
  }

  inspectLocal(inbox, conversation, { cursor, limit, sessionInput = false, modelPage = false } = {}) {
    const explicitLimit = Number.isSafeInteger(limit) && limit > 0;
    const effectiveLimit = explicitLimit ? limit : 25;
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
    // When a parent Bot reads a Pi work Session without a pagination cursor,
    // return the concise final output (or last few entries while running)
    // instead of flooding the clean chat context with 64KB of raw tool JSON.
    if (modelPage && sessionInput && !cursor && !explicitLimit) {
      const finalText = typeof last?.result?.text === 'string' && last.result.text.trim()
        ? last.result.text.slice(0, 64_000)
        : undefined;
      if (finalText) {
        return {
          ...state,
          output: finalText,
          transcript_entries: output.length,
          next_cursor: output.length ? 'start' : null,
          note: '已返回该子会话的最终总结输出；仅在确需核查中间工具日志时再传 cursor:"start" 分页读取。',
        };
      }
      const recentEntries = output.slice(-3);
      return {
        ...state,
        transcript_page: true,
        transcript_entries: output.length,
        ...transcriptPage(recentEntries, null, 3, output.length > 3 ? 'start' : null),
      };
    }
    const normalizedCursor = cursor === 'start' ? null : cursor;
    if (modelPage || typeof cursor === 'string' && cursor.startsWith('fragment:')) return { ...state, transcript_page: true,
      output: !cursor && typeof last?.result?.text === 'string' ? last.result.text.slice(0, 128_000) : undefined,
      ...transcriptPage(output, normalizedCursor, effectiveLimit) };
    const after = normalizedCursor == null ? 0 : output.findIndex(entry => entry.id === normalizedCursor) + 1;
    if (normalizedCursor && !after) throw runtimeFailure('cursor_expired', 'The transcript cursor is not available');
    const slice = output.slice(after, after + effectiveLimit);
    const rawOutput = last?.result?.text;
    const text = cursor || typeof rawOutput !== 'string' ? undefined : rawOutput.slice(0, 256_000);
    return { ...state, messages: slice, output: text,
      next_cursor: after + slice.length < output.length ? slice.at(-1)?.id : null };
  }

  async stopConversation(id) {
    const job = this.active.get(id);
    if (job) job.controller.abort(runtimeFailure('execution_interrupted', 'Execution was explicitly interrupted'));
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
          if (!job && (run.state === 'waiting' || run.state === 'pending' || run.state === 'retry')) {
            inbox.putRun({ id: run.id, state: 'stopped', error: { code: 'execution_interrupted', message: 'Execution was explicitly interrupted' } });
            this.stageInputs(inbox, conversation, run.id, 'stopped');
          } else if (pending.length && !inbox.pending().some(route => route.run_id === run.id) && !run.injected_event_ids.length) {
            inbox.putRun({ id: run.id, state: 'cancelled' });
            this.stageInputs(inbox, conversation, run.id, 'stopped');
          }
        }
      });
      if (!job) this.flushInputs(inbox);
    }
    if (job) await Promise.race([job.done, new Promise(done => setTimeout(done, 1500))]).catch(() => {});
    return { status: 'stopped' };
  }

  stopBot(id) {
    const jobs = [...this.active.values()].filter(job => job.inbox.botId === id);
    for (const job of jobs) job.controller.abort(runtimeFailure('bot_paused', 'Bot was explicitly stopped'));
    return Promise.all([...jobs.map(job => job.done), this.fastRead?.stopBot(id)]).then(() => ({ status: 'stopped' }));
  }

  async disposeBot(id) {
    await this.stopBot(id);
    if (this.pumpTask) await this.pumpTask.catch(() => {});
    const pendingOpen = this.opening.get(id);
    if (pendingOpen) await pendingOpen.catch(() => {});
    const inbox = this.inboxes.get(id);
    if (inbox) {
      this.inboxes.delete(id);
      try { inbox.store.close(); } catch {}
    }
    try {
      await rm(join(this.dataRoot, 'bots', boxId(id)), { recursive: true, force: true });
    } catch {}
  }

  async alignBotOnEnable(botId) {
    const inbox = await this.inbox(botId, { create: false }).catch(() => null);
    if (!inbox) return;
    const now = new Date().toISOString();
    const cancelledEventIds = [];
    inbox.store.transaction(() => {
      for (const item of inbox.pending()) {
        if (item.wait_id || item.event?.type === 'call.receipt') continue;
        const { event, ...route } = item;
        inbox.store.putRecord(R.route, { ...route, state: 'cancelled' });
        cancelledEventIds.push(route.event_id);
      }
      for (const room of this.platform.room.rooms(botId)) {
        const latest = this.platform.room.lastSavedMessage.get(room.id);
        if (!latest) continue;
        const prior = inbox.store.getRecord(R.fastRead, room.id);
        if ((prior?.read_through_sequence ?? 0) >= latest.sequence) continue;
        inbox.store.putRecord(R.fastRead, {
          ...prior,
          id: room.id,
          bot_id: botId,
          room_id: room.id,
          read_through_id: latest.id,
          read_through_sequence: latest.sequence,
          updated_at: now,
        });
      }
    });
    if (cancelledEventIds.length) this.consumeDeliveries(inbox, cancelledEventIds);
  }

  retrySuspended(conversationId, runId) {
    const item = this.locate(conversationId);
    if (!item) return null;
    const { inbox, conversation } = item;
    const runs = inbox.runs(conversation.id);
    const target = runId ? runs.find(run => run.id === runId) : runs.findLast(run => run.state === 'suspended');
    if (!target || target.state !== 'suspended') return null;
    inbox.putRun({
      id: target.id,
      state: 'pending',
      error: null,
      retry_at: null,
      transport_retry: null,
    });
    this.wake();
    return { conversation_id: conversation.id, run_id: target.id, bot_id: inbox.botId, state: 'pending' };
  }

  messageActivity(roomId, messageId) {
    const room = this.platform.store.get('rooms', roomId);
    if (!room) return { inFlight: false, suspended: false };
    let inFlight = false;
    let suspended = false;
    for (const member of room.members) {
      if (member === 'user') continue;
      if (this.fastRead?.isActive?.(member, roomId)) inFlight = true;
      const inbox = this.inboxes.get(member);
      if (!inbox) continue;
      const routes = inbox.list(R.route, 'event_id', messageId);
      for (const route of routes) {
        if (route.state === 'pending') {
          if (route.run_id) {
            const run = inbox.run(route.run_id);
            if (run?.state === 'suspended') suspended = true;
            else if (run && activeRunStates.has(run.state)) inFlight = true;
          } else {
            inFlight = true;
          }
        }
      }
    }
    return { inFlight, suspended };
  }

  roomIdForConversation(conversation) {
    if (!conversation) return null;
    if (conversation.space?.kind === 'room') return conversation.space.id;
    if (conversation.session_id) {
      const session = this.platform.executions.record(sessionRef(conversation.session_id));
      if (session?.origin_room?.id) return session.origin_room.id;
      if (session?.source_space?.kind === 'room') return session.source_space.id;
      if (session?.space?.kind === 'room') return session.space.id;
    }
    return null;
  }

  setLiveActivity(botId, roomId, { phase = 'thinking', text, execution_ref = null, conversation_id = null } = {}) {
    const cleaned = ensureDoingText(text, 44);
    if (!cleaned) return;
    const timestamp = now();
    let changed = false;
    if (conversation_id) {
      const prevConv = this.conversationActivities.get(conversation_id);
      if (!prevConv || prevConv.text !== cleaned || prevConv.phase !== phase) {
        this.conversationActivities.set(conversation_id, { text: cleaned, phase, updated_at: timestamp });
        changed = true;
      }
    }
    if (roomId && botId) {
      const key = recordKey(roomId, botId);
      const prev = this.liveActivities.get(key);
      if (!prev || prev.text !== cleaned || prev.phase !== phase || prev.execution_ref?.id !== execution_ref?.id) {
        this.liveActivities.set(key, {
          bot_id: botId,
          room_id: roomId,
          phase,
          text: cleaned,
          execution_ref: execution_ref || prev?.execution_ref || null,
          started_at: prev?.started_at || timestamp,
          updated_at: timestamp,
        });
        changed = true;
      }
    }
    if (changed) this.emit('execution');
  }

  clearLiveActivity(botId, roomId, phases = null, conversation_id = null) {
    let changed = false;
    if (conversation_id && this.conversationActivities.has(conversation_id)) {
      const entry = this.conversationActivities.get(conversation_id);
      if (!phases || phases.includes(entry.phase)) {
        this.conversationActivities.delete(conversation_id);
        changed = true;
      }
    }
    if (roomId && botId) {
      const key = recordKey(roomId, botId);
      const entry = this.liveActivities.get(key);
      if (entry && (!phases || phases.includes(entry.phase))) {
        this.liveActivities.delete(key);
        changed = true;
      }
    }
    if (changed) this.emit('execution');
  }

  conversationLiveProgress(conversationId) {
    return this.conversationActivities.get(conversationId)?.text || null;
  }

  roomActivities(roomId) {
    if (!roomId) return [];
    const byBot = new Map();
    const nowMs = Date.now();

    const activeJobsByBot = new Map();
    for (const job of this.active.values()) {
      const jobRoomId = this.roomIdForConversation(job.conversation);
      if (jobRoomId !== roomId) continue;
      const botId = job.inbox?.botId || job.conversation?.bot_id;
      if (!botId) continue;
      activeJobsByBot.set(botId, job);
    }

    // 1. Live active sessions in this room (Codex, CLI, MCP, Pi)
    for (const session of this.platform.store.list(sessionRecords)) {
      if (session.authority_revoked || session.control?.state !== 'active') continue;
      if (!liveSessionStatuses.has(session.status)) continue;
      const matchRoom = session.origin_room?.id === roomId
        || (session.source_space?.kind === 'room' && session.source_space.id === roomId)
        || (session.space?.kind === 'room' && session.space.id === roomId);
      if (!matchRoom) continue;
      const botId = session.execution_actor?.id || session.bot_id || session.owner?.id;
      if (!botId) continue;
      const needsInput = ['needs_input', 'awaiting_input'].includes(session.status);
      const piLive = session.engine === 'pi' ? this.conversationLiveProgress(session.conversation_id || session.id) : null;
      const text = needsInput
        ? (session.pending_input?.[0]?.question ? `等待输入：${compactActivityText(session.pending_input[0].question, 30)}` : '等待你的输入')
        : (piLive || ensureDoingText(session.live_progress || session.work_summary, 44) || '正在执行任务');
      const existing = byBot.get(botId);
      const updatedAt = session.updated_at || session.created_at || now();
      if (!existing || (needsInput && existing.phase !== 'waiting_input') || updatedAt > existing.updated_at) {
        byBot.set(botId, {
          bot_id: botId,
          phase: needsInput ? 'waiting_input' : 'session',
          text,
          work_summary: session.work_summary || null,
          execution_ref: sessionRef(session.id),
          started_at: session.created_at || updatedAt,
          updated_at: updatedAt,
        });
      }
    }

    // 2. Active conversation runs & fast-read / planned handoffs
    for (const [botId, job] of activeJobsByBot.entries()) {
      const live = this.liveActivities.get(recordKey(roomId, botId));
      const convLive = this.conversationActivities.get(job.conversation.id);
      const executionRef = job.conversation.session_id ? sessionRef(job.conversation.session_id) : conversationRef(job.conversation.id);
      const existing = byBot.get(botId);
      if (existing?.phase === 'waiting_input') continue;
      byBot.set(botId, {
        bot_id: botId,
        phase: live?.phase || convLive?.phase || 'thinking',
        text: live?.text || convLive?.text || '正在处理中',
        work_summary: existing?.work_summary || null,
        execution_ref: live?.execution_ref || executionRef,
        started_at: live?.started_at || existing?.started_at || job.startedAt,
        updated_at: live?.updated_at || convLive?.updated_at || job.startedAt,
      });
    }

    for (const [key, entry] of this.liveActivities.entries()) {
      if (entry.room_id !== roomId) continue;
      if (entry.phase === 'planned') {
        const ageMs = nowMs - Date.parse(entry.updated_at || 0);
        if (ageMs > 30000 && !activeJobsByBot.has(entry.bot_id)) {
          this.liveActivities.delete(key);
          continue;
        }
      }
      if (byBot.has(entry.bot_id)) continue;
      byBot.set(entry.bot_id, {
        bot_id: entry.bot_id,
        phase: entry.phase,
        text: entry.text,
        work_summary: null,
        execution_ref: entry.execution_ref || null,
        started_at: entry.started_at || entry.updated_at,
        updated_at: entry.updated_at,
      });
    }

    return [...byBot.values()].sort((a, b) =>
      String(a.started_at || '').localeCompare(String(b.started_at || '')) || a.bot_id.localeCompare(b.bot_id)
    );
  }

  roomHasActiveWork(roomId) {
    if (!roomId) return false;
    if (this.fastRead?.isActiveRoom?.(roomId)) return true;
    for (const job of this.active.values()) {
      if (this.roomIdForConversation(job.conversation) === roomId) return true;
    }
    for (const inbox of this.inboxes.values()) {
      for (const conv of inbox.store.listRecords(R.conversation)) {
        if (this.roomIdForConversation(conv) !== roomId) continue;
        if (this.starting.has(conv.id)) return true;
        for (const run of inbox.runs(conv.id)) {
          if (['pending', 'running', 'waiting', 'interrupted', 'retry'].includes(run.state)) return true;
        }
      }
    }
    return false;
  }

  botActivityState(bot) {
    if (!bot || bot.enabled === false) return 'paused';
    const botId = bot.id;
    for (const job of this.active.values()) {
      if (job.inbox?.botId === botId) return 'working';
    }
    if (this.fastRead?.isActiveBot?.(botId)) return 'working';
    const sessions = this.platform.store.list(sessionRecords);
    for (const session of sessions) {
      if (session.authority_revoked || session.control?.state !== 'active') continue;
      if ((session.bot_id === botId || session.execution_actor?.id === botId || session.owner?.id === botId) &&
          this.platform.isActiveSession(session)) {
        return 'working';
      }
    }
    const inbox = this.inboxes.get(botId);
    if (inbox) {
      let hasSuspended = false;
      for (const conv of inbox.store.listRecords(R.conversation)) {
        for (const run of inbox.runs(conv.id)) {
          if (['running', 'waiting', 'retry'].includes(run.state)) return 'working';
          if (run.state === 'suspended') hasSuspended = true;
        }
      }
      if (hasSuspended) return 'error';
    }
    return 'idle';
  }

  suspendedRunsForRoom(roomId) {
    const room = this.platform.store.get('rooms', roomId);
    if (!room) return [];
    const results = [];
    for (const member of room.members) {
      if (member === 'user') continue;
      const inbox = this.inboxes.get(member);
      if (!inbox) continue;
      const conversations = inbox.store.listRecords(R.conversation).filter(c => c.kind === 'room' && c.space?.id === roomId && !c.session_id);
      for (const conversation of conversations) {
        for (const run of inbox.runs(conversation.id)) {
          if (run.state !== 'suspended') continue;
          const eventIds = [...new Set([...(run.injected_event_ids || []), ...(run.pending_event_ids || [])])];
          results.push({
            run_id: run.id,
            conversation_id: conversation.id,
            bot_id: member,
            event_ids: eventIds,
            error: run.error || { code: 'runtime_error', message: '运行已挂起' },
            updated_at: run.updated_at || null,
          });
        }
      }
    }
    return results;
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
