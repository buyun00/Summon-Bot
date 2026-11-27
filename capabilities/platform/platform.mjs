import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { bindModel } from '../../bot/src/agent/model.mjs';
import { botMaintenanceLeadId, botMaintenanceRoomId, eggbotRole, groupLeadRole, roleIds } from '../bot-management/roles.mjs';
import { listBotMemoryItems, protectedRuntimeDirs, readBotFolderFile, readHostProfile, validateBotRelPath, writeBotFolderFile, writeHostProfile } from '../bot-management/folders.mjs';
import { BotManager, activeControl, botRecords, directoryEntry } from '../bot-management/service.mjs';
import { EngineManager } from '../engines/service.mjs';
import { CapabilityManager } from '../skills/service.mjs';
import { KnowledgeManager } from '../knowledge/service.mjs';
import { Files } from '../filesystem/files.mjs';
import { Calls, isWaitOrigin, waitRecords } from './calls.mjs';
import { assertRevision, idOf, identity, keyOf, page, readTools, reject, sameIdentity, sameRef, user, validateTool } from './contract.mjs';
import { Deliveries, wakeupRecords } from './delivery.mjs';
import { Executions, conversationRecords, sessionRecords } from './executions.mjs';
import { HostResources } from './resources.mjs';
import { GoalManager } from './goals.mjs';
import { RoomWork } from './room-work.mjs';
import { workspaceGranted } from './workspace-access.mjs';
import { SelfUpdateService } from '../services/self-update.mjs';

const normalize = (value, kind) => typeof value === 'string' ? { kind, id: value } : value;
const revokedAuthority = new Set(['session_authority_revoked', 'workspace_changed', 'model_binding_changed']);
const inactiveSessions = new Set(['completed', 'failed', 'stopped', 'unsupported', 'cancelled', 'not_submitted', 'idle']);
const inside = (root, path) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};

export class SummonPlatform {
  constructor({ store, dataRoot, releaseRoot, models, attachments, workspaces = [], emit = () => {} }) {
    Object.assign(this, { store, dataRoot, releaseRoot, models, attachments, emit });
    this.draining = false;
    this.roomActivitySeq = new Map();
    this.roomActivityLog = new Map();
    this.resources = new HostResources(store);
    this.manager = new BotManager({ store, dataRoot, releaseRoot, models, canUseModel: (actor, id) => this.canUseModel(actor, id) });
    this.engines = new EngineManager({ store, dataRoot, releaseRoot });
    this.capabilities = new CapabilityManager({ dataRoot, releaseRoot });
    this.knowledge = new KnowledgeManager({ dataRoot });
    this.deliveries = new Deliveries({ store, resources: this.resources, manager: this.manager, emit, chatroom: () => this.room,
      onEnqueue: () => this.scheduleFlush(),
      canReadEvent: (botId, event) => this.canReadEvent(event, { actor: { kind: 'bot', id: botId } }),
      canReadWait: (wait, event) => this.canReadReturnWait(wait, event.target),
      canReadReference: (ref, context) => this.canReadReference(ref, context) });
    this.calls = new Calls({ store, deliver: (event, waits, matchWakeups) => {
      for (const botId of new Set(waits.map(wait => wait.bot_id))) this.executions.retainUndelivered(event, botId);
      this.deliveries.queueEvent(event, waits, matchWakeups);
    },
      canReadTarget: (actor, ref, context, call) => this.canReadCallResult(call, ref, { ...context, actor }),
      inSharedRoom: (actor, rooms) => rooms.some(id => this.roomMembers(id).includes(actor.id)),
      resolveTargetOwner: target => {
        if (!target) return null;
        if (target.kind === 'session') return this.executions.record(target)?.execution_actor?.id ?? null;
        if (target.kind === 'conversation') return this.executions.record(target)?.bot_id ?? null;
        return null;
      },
      spaceFor: ref => ['session', 'conversation'].includes(ref?.kind) ? this.executions.record(ref)?.space : ref,
      sessionMeta: ref => {
        if (ref?.kind !== 'session') return null;
        const session = this.executions.record(ref);
        if (!session) return null;
        return {
          origin_room: session.origin_room ?? null,
          origin_message_id: session.origin_message_id ?? null,
          owner_conversation_id: session.owner_conversation_id ?? null,
        };
      } });
    this.executions = new Executions({ store, platform: this, calls: this.calls, resources: this.resources });
    this.roomWork = new RoomWork(this);
    this.goals = new GoalManager(this);
    this.selfUpdate = new SelfUpdateService({ dataRoot, releaseRoot, platform: this });
    this.workspaces = workspaces;
  }

  attach({ room, runtime, exec }) {
    Object.assign(this, { room, runtime, exec });
    this.attachments ??= room?.attachments;
    this.files = new Files({ store: this.store, room, attachments: this.attachments,
      canReadSpace: (actor, space, context) => this.canReadSpace(actor, space, context),
      canWriteSpace: (actor, space, context) => this.canWriteSpace(actor, space, context),
      canReadReference: (ref, context) => this.canReadReference(ref, context),
      assertShareable: (ref, options) => this.assertShareable(ref, options), notify: event => this.deliveries.queueEvent(event) });
  }

  ensureDefaultWorkspace() {
    const dir = join(this.dataRoot, 'workspace');
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
    } catch {}
    const existing = this.store.get('platform-workspaces', 'ws-summon-home') ||
      this.workspaceRecords().find(item => {
        try { return relative(this.authorizedDirectory(item.path), realpathSync(dir)) === ''; } catch { return false; }
      });
    if (existing) return existing;
    try {
      return this.configureWorkspace({ id: 'ws-summon-home', name: 'Summon 工作区', path: dir, write: true });
    } catch {
      return null;
    }
  }

  initializeDefaults() {
    const defaultWs = this.ensureDefaultWorkspace();
    this.engines.ensureDefaults();
    this.capabilities.ensureDefaults();
    this.knowledge.ensureRoot();
    const { changed } = this.store.transaction(() => this.manager.ensureDefaults());
    this.room.ensureMaintenanceRoom({ defaultWorkspaceId: defaultWs?.id || null });
    this.store.transaction(() => {
      this.deliveries.syncObserverMemberships();
    });
    if (changed) this.emit('bot');
  }

  checkWorkEngine(engineId, { roomId = null, wake = true } = {}) {
    this.initializeDefaults();
    this.engines.clearRuntimeFault(engineId);
    const engine = this.engines.get(engineId, { fresh: true });
    const targetRoomId = roomId || botMaintenanceRoomId;
    const targetRoom = this.store.get('rooms', targetRoomId);
    const leadId = targetRoom?.lead_bot_id || botMaintenanceLeadId;
    const leadBot = this.store.get(botRecords, leadId);
    let wakeMessageId = null;
    const catalog = this.models.catalog();
    const hasActiveModel = Boolean(catalog.activeId && this.models.isConfigured(
      catalog.connections.find(item => item.id === catalog.activeId),
    ));
    if (wake && targetRoom && !targetRoom.archivedAt && leadBot && hasActiveModel) {
      const sent = this.room.send(targetRoom.id, {
        text: `@${leadBot.name} 请在后台自检工作引擎 ${engine.name}（id: ${engine.id}）：先读取其 guide.md，检查本机 CLI 安装、登录态与桥接脚本（缺凭据用隐私输入窗向我获取，协议有变自行调整 engines/${engine.id}/bridge.mjs 并更新 guide.md）。全部验证正常时只用一两句简洁自然的话告知已就绪，不要提及退出码、脚本路径或内部技术细节；若存在无法自愈的问题再明确报错并说明原因。`,
        mentions: [{ kind: 'bot', id: leadBot.id }],
      }, 'user');
      wakeMessageId = sent?.message?.id || sent?.id || null;
      this.runtime?.wake?.();
    }
    return { engine, room_id: targetRoom?.id || null, bot_id: leadBot?.id || null, bot_name: leadBot?.name || 'Summon', wake_message_id: wakeMessageId };
  }

  onboardingState() {
    const saved = this.store.get('platform-settings', 'onboarding');
    const catalog = this.models.catalog();
    const hasActiveModel = Boolean(catalog.activeId && this.models.isConfigured(
      catalog.connections.find(item => item.id === catalog.activeId),
    ));
    if (!hasActiveModel) {
      return {
        id: 'onboarding',
        status: 'awaiting_model',
        roomId: botMaintenanceRoomId,
        hasActiveModel: false,
      };
    }
    if (saved) {
      return { ...saved, roomId: saved.roomId || botMaintenanceRoomId, hasActiveModel: true };
    }
    return {
      id: 'onboarding',
      status: 'completed',
      roomId: botMaintenanceRoomId,
      hasActiveModel: true,
    };
  }

  startOnboarding({ checkEngine = null, skipEngine = false, chooseEngine = false } = {}) {
    this.initializeDefaults();
    const catalog = this.models.catalog();
    const activeConn = catalog.connections.find(item => item.id === catalog.activeId);
    const hasActiveModel = Boolean(activeConn && this.models.isConfigured(activeConn));
    if (!hasActiveModel) return this.onboardingState();

    const nowIso = new Date().toISOString();
    if (skipEngine) {
      const next = {
        id: 'onboarding',
        status: 'completed',
        roomId: botMaintenanceRoomId,
        startedAt: nowIso,
        completedAt: nowIso,
      };
      this.store.save('platform-settings', next);
      this.emit('onboarding', next);
      return { ...next, hasActiveModel, engine: null };
    }

    if (chooseEngine || !checkEngine) {
      const suggestedEngineId = activeConn?.kind === 'codex'
        ? 'codex'
        : activeConn?.kind === 'grok'
          ? 'grok-build'
          : activeConn?.provider === 'anthropic'
            ? 'claude-code'
            : null;
      const next = {
        id: 'onboarding',
        status: 'choosing_engine',
        roomId: botMaintenanceRoomId,
        suggestedEngineId,
        startedAt: nowIso,
      };
      this.store.save('platform-settings', next);
      this.emit('onboarding', next);
      return { ...next, hasActiveModel, engine: null };
    }

    let checked = null;
    try {
      const targetEngine = this.engines.get(checkEngine, { fresh: true });
      if (targetEngine.enabled_override === false) {
        this.engines.setEnabled(checkEngine, true);
        this.emit('engine');
      }
      checked = this.checkWorkEngine(checkEngine, { roomId: botMaintenanceRoomId, wake: true });
    } catch {}
    const configuringEngine = Boolean(checked?.engine && checked.wake_message_id);
    const next = {
      id: 'onboarding',
      status: configuringEngine ? 'configuring_bot' : 'completed',
      roomId: botMaintenanceRoomId,
      ...(configuringEngine ? {
        engineId: checked.engine.id,
        engineName: checked.engine.name,
        botId: checked.bot_id,
        botName: checked.bot_name,
        wakeMessageId: checked.wake_message_id,
      } : { completedAt: nowIso }),
      startedAt: nowIso,
    };
    this.store.save('platform-settings', next);
    this.emit('onboarding', next);
    return { ...next, hasActiveModel, engine: checked?.engine || null };
  }

  finishOnboarding() {
    const current = this.onboardingState();
    const nowIso = new Date().toISOString();
    const next = {
      ...current,
      id: 'onboarding',
      status: 'completed',
      roomId: current.roomId || botMaintenanceRoomId,
      completedAt: nowIso,
    };
    this.store.save('platform-settings', next);
    this.emit('onboarding', next);
    return next;
  }

  currentRoomActivitySeq(roomId) {
    return this.roomActivitySeq.get(roomId) ?? 0;
  }

  recentRoomActivities(roomId, afterSeq = 0, excludeActorId = null, excludeCallIds = null) {
    const entries = this.roomActivityLog.get(roomId) || [];
    const ownCalls = excludeCallIds instanceof Set ? excludeCallIds : null;
    return entries.filter(entry => {
      if (entry.status === 'failed') return false;
      if (entry.seq <= afterSeq) return false;
      if (excludeActorId && entry.actor_id === excludeActorId) {
        if (!ownCalls || !entry.call_id || ownCalls.has(entry.call_id)) return false;
      }
      return true;
    });
  }

  actorLabel(actorId) {
    if (!actorId || actorId === 'user') return '宿主';
    return this.store.get(botRecords, actorId)?.name || actorId;
  }

  recordRoomActivity(roomId, entry) {
    if (!roomId) return null;
    const seq = (this.roomActivitySeq.get(roomId) ?? 0) + 1;
    this.roomActivitySeq.set(roomId, seq);
    const saved = {
      seq,
      room_id: roomId,
      actor_id: entry.actor_id,
      actor_name: entry.actor_name || this.actorLabel(entry.actor_id),
      tool: entry.tool,
      summary: entry.summary,
      call_id: entry.call_id ?? null,
      status: entry.status ?? 'started',
      ...(entry.target ? { target: entry.target } : {}),
      ...(entry.engine ? { engine: entry.engine } : {}),
      ...(entry.method ? { method: entry.method } : {}),
      time: entry.time || new Date().toISOString(),
    };
    const log = this.roomActivityLog.get(roomId) || [];
    log.push(saved);
    if (log.length > 32) log.splice(0, log.length - 32);
    this.roomActivityLog.set(roomId, log);
    if (saved.tool === 'send') {
      this.runtime?.notifyRoomActivity?.(roomId, saved);
    }
    return saved;
  }

  recordRoomMessageActivity(message) {
    if (!message?.roomId || !message?.id) return null;
    const text = String(message.content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    return this.recordRoomActivity(message.roomId, {
      actor_id: message.senderId,
      actor_name: message.senderName || this.actorLabel(message.senderId),
      tool: 'send',
      call_id: message.callId ?? null,
      status: 'completed',
      target: { kind: 'event', id: message.id },
      summary: text ? `发送群消息：${text}` : '发送群消息',
      time: message.createdAt,
    });
  }

  describeRoomWriteActivity(name, args) {
    if (name === 'open_session') {
      const engineId = args.engine || 'pi';
      const label = engineId === 'exec'
        ? (args.input?.script || 'exec')
        : engineId;
      const summary = args.work_summary ? `（${String(args.work_summary).slice(0, 60)}）` : '';
      return {
        engine: engineId,
        summary: `发起 ${label} 任务${summary}`,
      };
    }
    if (name === 'create_bot') {
      const role = args.role_id ? ` [${args.role_id}]` : '';
      return { summary: `创建 Bot「${args.name || '未命名'}」${role}` };
    }
    if (name === 'create_room') {
      const title = args.title ? `「${String(args.title).slice(0, 40)}」` : '';
      return { summary: `创建群聊${title}` };
    }
    if (name === 'configure_room') {
      const parts = [];
      if (args.title) parts.push(`改名「${args.title}」`);
      if (args.add_members?.length) parts.push(`拉入 ${args.add_members.length} 位成员`);
      if (args.remove_members?.length) parts.push(`移除 ${args.remove_members.length} 位成员`);
      if (args.workspace !== undefined) parts.push('变更工作区');
      return { summary: `更新群配置${parts.length ? `（${parts.join('、')}）` : ''}` };
    }
    return { summary: `执行 ${name}` };
  }

  guardRoomWriteActivity(name, args, context, record) {
    if (context.actor.kind !== 'bot') return null;
    if (context.conversation?.kind !== 'room' || context.conversation?.space?.kind !== 'room') return null;
    const guarded = name === 'open_session' || name === 'create_bot' || name === 'create_room' || name === 'configure_room';
    if (!guarded) return null;
    const roomId = context.conversation.space.id;
    const expectedSeq = context.origin?.seen_room_activity_seq;
    if (Number.isSafeInteger(expectedSeq)) {
      const latestSeq = this.currentRoomActivitySeq(roomId);
      if (latestSeq > expectedSeq) {
        const newer = this.recentRoomActivities(roomId, expectedSeq, context.actor.id, context.origin?.own_run_activity_call_ids);
        if (newer.length) {
          const conflict = {
            executed: false,
            status: 'room_activity_changed',
            expected_activity_seq: expectedSeq,
            latest_activity_seq: latestSeq,
            new_activities: newer.slice(-8).map(item => ({
              seq: item.seq,
              actor_id: item.actor_id,
              actor_name: item.actor_name,
              tool: item.tool,
              summary: item.summary,
              status: item.status,
              ...(item.engine ? { engine: item.engine } : {}),
              ...(item.method ? { method: item.method } : {}),
              ...(item.target ? { target: item.target } : {}),
              time: item.time,
            })),
            guidance: 'Other members in this Room started new actions or posted messages while you were preparing this call. Read new_activities carefully: if a peer already started or completed the same action (such as creating the same Bot, registering the same connection, or triggering the same build/session), do NOT repeat it. If your action is distinct and still needed, you may submit it again now.',
          };
          return { conflict: this.calls.finish(record.id, 'completed', conflict) };
        }
      }
    }
    const details = this.describeRoomWriteActivity(name, args);
    const activity = this.recordRoomActivity(roomId, {
      actor_id: context.actor.id,
      tool: name,
      call_id: record.id,
      status: name === 'open_session' ? 'started' : 'submitting',
      ...details,
    });
    return { activity };
  }

  getBot(id) { return this.manager.get(id); }
  listBots() { return this.manager.list(); }

  workEngines(options = {}) {
    return this.engines.available(options).map(engine => {
      const tiers = this.models.engineTiers?.(engine.id) || null;
      return {
        ...engine,
        ...(tiers && Object.keys(tiers).length ? { tiers } : {}),
      };
    });
  }

  canConfigureEngine(actor) {
    return actor?.kind === 'user' || (actor?.kind === 'bot' && actor.id === botMaintenanceLeadId);
  }

  canConfigureCapability(actor, capabilityId) {
    if (this.canConfigureEngine(actor)) return true;
    if (this.capabilities.isBundled(capabilityId)) return false;
    if (actor?.kind !== 'bot') return false;
    const caller = this.store.get(botRecords, actor.id);
    if (caller?.built_in_role?.id === eggbotRole) return true;
    const existing = this.capabilities.readEntry(capabilityId, { lookupBot: id => this.store.get(botRecords, id) });
    if (!existing) return true;
    return !existing.owner_bot || existing.owner_bot === actor.id || existing.owner_alive === false;
  }

  applyAutoGroupNaming(roomId, botId, { roomTitle } = {}) {
    let updatedRoom = null;
    this.store.transaction(() => {
      const room = this.store.get('rooms', roomId);
      if (!room || room.archivedAt || room.mode !== 'group' || room.id === botMaintenanceRoomId) return;
      const effectiveLeadId = room.lead_bot_id || (room.members || []).find(member =>
        member !== 'user' && this.store.get(botRecords, member)?.built_in_role?.id === groupLeadRole);
      if (botId && effectiveLeadId && botId !== effectiveLeadId) return;

      const cleanRoomTitle = typeof roomTitle === 'string' ? roomTitle.trim().slice(0, 80) : '';
      if (room.auto_title_pending && cleanRoomTitle) {
        const finalRoomName = this.room.uniqueGroupTitle(cleanRoomTitle, room.id);
        updatedRoom = this.store.save('rooms', {
          id: room.id,
          name: finalRoomName,
          auto_title_pending: false,
          revision: (room.revision ?? 0) + 1,
        });
      }
    });
    if (updatedRoom) {
      this.room.emit('room', this.room.projectRoom(updatedRoom));
    }
    return {
      room: updatedRoom ? this.room.projectRoom(updatedRoom) : null,
      bot: null,
    };
  }
  ensureRoomBase(botId, roomId) { return this.deliveries.ensureBase(botId, roomId); }
  removeRoomBase(botId, roomId) { return this.deliveries.removeBase(botId, roomId); }
  queueMessage(event) { return this.deliveries.queueMessage(event); }
  messageDeliveries(eventId) { return this.deliveries.messageDeliveries(eventId); }
  hostMessageDeliveries(eventId) {
    return this.messageDeliveries(eventId).map(item => ({ ...item, ...this.runtime.roomDeliveryDetails(item.bot_id, eventId) }));
  }
  eventDeliveries(eventId) {
    return this.hostMessageDeliveries(eventId).map(delivery => ({
      ...delivery, runs: this.runtime.deliveryRuns(delivery.bot_id, eventId),
    }));
  }
  scheduleFlush() {
    if (this.flushScheduled || !this.runtime) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (this.runtime && !this.runtime.closed) {
        this.deliveries.flush(this.runtime).catch(() => {});
      }
    });
  }

  consumeDelivery(botId, id, receipt) {
    this.deliveries.consume(botId, id, receipt);
    this.checkUnansweredFallbacks();
  }
  recordReceipt(callId, facts, sessionId) { return this.executions.receipt(sessionId, callId, facts); }
  roomMembers(id) { return this.deliveries.roomMembers(id); }

  accessFor(actor) {
    return actor.kind === 'user' ? null : this.store.get('platform-access', actor.id) || {};
  }

  botModelConnectionId(bot, purpose = 'conversation') {
    return this.models.resolveForBot(bot, purpose)?.connection_id ?? null;
  }

  modelAccessBlocker(actor, id) {
    if (!id) return { code: 'model_binding_required', message: 'The Bot needs an assigned model connection' };
    let catalog;
    try { catalog = this.models.catalog(); }
    catch { return { code: 'model_catalog_unavailable', message: 'The model catalog is unavailable' }; }
    if (!catalog.connections.some(item => item.id === id)) return { code: 'model_connection_unavailable',
      message: 'The configured model connection is unavailable. Ask the host to restore the Bot’s model binding' };
    return null;
  }

  canUseModel(actor, id) { return this.modelAccessBlocker(actor, id) === null; }

  visibleBot(bot, context) {
    if (!bot) return false;
    if (context.actor.kind === 'user') return true;
    return !bot.archivedAt;
  }

  canFindTeam(context) {
    return context.actor.kind === 'user' || context.actor.kind === 'bot';
  }

  canReadRoomHistory(actor, space) {
    if (!space || space.kind !== 'room') return false;
    const room = this.store.get('rooms', space.id);
    if (!room) return false;
    if (actor.kind === 'user' || room.members.includes(actor.id)) return true;
    return actor.kind === 'bot' && room.mode === 'group' && !room.archivedAt;
  }

  canReadSpace(actor, space, context = {}) {
    if (!space) return false;
    if (space.kind === 'room') {
      const room = this.store.get('rooms', space.id);
      return Boolean(room && (actor.kind === 'user' || room.members.includes(actor.id)));
    }
    if (space.kind === 'user') return sameIdentity(actor, space);
    if (space.kind === 'bot') {
      const bot = this.store.get(botRecords, space.id);
      return Boolean(bot && (actor.kind === 'user' || sameIdentity(actor, space)));
    }
    return false;
  }

  canWriteSpace(actor, space, context = {}) {
    return this.canReadSpace(actor, space, context);
  }

  canReadReturnWait(wait, target) {
    const actor = { kind: 'bot', id: wait.bot_id };
    const context = { actor };
    const source = { kind: 'conversation', id: wait.conversation_id };
    const conversation = this.executions.record(source);
    const session = wait.session_id && this.executions.record({ kind: 'session', id: wait.session_id });
    if (!conversation || (conversation.session_id ?? null) !== (wait.session_id ?? null) ||
        wait.session_id && !session || !this.executions.permission(source, conversation, { ...context, origin: { conversation_id: wait.conversation_id } })) return false;
    const principal = wait.initiating_principal;
    const sourceContext = { actor, conversation, session, resource_refs: session?.resource_refs ?? [] };
    return this.canReadReference(target, sourceContext) && (!principal || sameIdentity(principal, actor) ||
      this.canReadReference(target, { actor: principal, project_room: this.projectRoom(sourceContext) }));
  }

  canReadCallResult(call, target, context) {
    if (!this.canReadReference(target, context)) return false;
    if (!context.origin) return true;
    const wait = call?.return_refs.map(id => this.store.get(waitRecords, id)).find(item => item?.input_call_id && item.bot_id === context.actor.id &&
      isWaitOrigin(item, context.origin));
    return !wait || this.canReadReturnWait(wait, target);
  }

  canReadEvent(event, context) {
    if (event.result_access === 'revoked') return false;
    if (event.type === 'work.tool') return this.roomWork.readable(event, context);
    if (Array.isArray(event.shared_rooms) && event.shared_rooms.some(rid =>
      this.canReadSpace(context.actor, { kind: 'room', id: rid }, context))) {
      return true;
    }
    if (event.call_id && event.target) {
      const call = this.store.get('platform-calls', event.call_id);
      const waits = call?.return_refs || [];
      const watching = context.actor.kind === 'user' || sameIdentity(context.actor, call?.submitted_by) || call?.origin_bot === context.actor.id ||
        waits.some(id => {
          const wait = this.store.get(waitRecords, id);
          return wait?.bot_id === context.actor.id && (!wait.input_call_id || (context.origin ? isWaitOrigin(wait, context.origin)
            : this.canReadReturnWait(wait, event.target)));
        }) ||
        this.store.list('platform-wakeups').some(rule =>
          rule.bot_id === context.actor.id && this.deliveries.matches(rule, event));
      return watching && this.canReadCallResult(call, event.target, context);
    }
    if (event.bot_id && event.bot_id !== context.actor.id && context.actor.kind !== 'user') return false;
    const resource = context.resource_refs?.some(ref => sameRef(ref, { kind: 'event', id: event.id }));
    const targetSpace = event.space || (event.roomId ? { kind: 'room', id: event.roomId } : null);
    if ((event.type === 'message' || event.kind === 'message') && targetSpace?.kind === 'room') {
      return this.canReadRoomHistory(context.actor, targetSpace);
    }
    return this.canReadSpace(context.actor, targetSpace, resource ? {} : context);
  }

  canReadReference(ref, context) {
    if (!ref) return false;
    const { actor } = context;
    if (ref.kind === 'workspace_file') {
      const p = typeof ref.path === 'string' ? ref.path.trim() : '';
      const safePath = Boolean(p) && !/^(?:[a-zA-Z]:|[/\\])/.test(p) && !p.split(/[/\\]/).some(part => !part || part === '.' || part === '..');
      return safePath && Boolean(ref.workspace_id && this.workspaceAvailable(ref.workspace_id, actor, context));
    }
    if (!ref.id) return false;
    switch (ref.kind) {
      case 'room': return this.canReadRoomHistory(actor, ref);
      case 'user': return this.canReadSpace(actor, ref, context);
      case 'bot': {
        const record = this.store.get(botRecords, ref.id);
        return Boolean(record && (this.visibleBot(record, context) ||
          !record.archivedAt && this.canFindTeam(context)));
      }
      case 'event': {
        const event = this.store.get('platform-events', ref.id) ?? this.store.get('messages', ref.id);
        return Boolean(event && this.canReadEvent(event, context));
      }
      case 'file': return this.files.canRead(ref.id, context);
      case 'session': return this.executions.canRead(ref, this.executions.record(ref), context);
      case 'conversation': return this.executions.permission(ref, this.executions.record(ref), context);
      case 'call': {
        const call = this.store.get('platform-calls', ref.id);
        return Boolean(call && this.calls.canRead(actor, call, context));
      }
      case 'workspace': return this.workspaceAvailable(ref.id, actor, context);
      case 'engine': return this.engines.list().some(item => item.id === ref.id);
      case 'capability': return Boolean(this.capabilities.readEntry(ref.id));
      case 'knowledge': return ref.id === 'shared' || this.knowledge.exists(ref.id);
      case 'wakeup': return this.deliveries.list(context).some(item => item.id === ref.id);
      default: return false;
    }
  }

  assertShareable(ref, { actor, room, context = {} }) {
    const principal = identity(actor);
    const caller = { ...context, actor: principal };
    const file = ref.kind === 'file' ? this.files.get(ref.id) : null;
    if (file && file.space?.kind === 'bot' && principal.kind !== 'user' && file.space.id !== principal.id) {
      reject('share_forbidden', 'Cannot share another Bot’s private memory file', 403);
    }
    if (file && file.space?.kind === 'bot' && room?.id && !file.shared_rooms?.includes(room.id)) {
      this.store.save('platform-files', { id: file.id, shared_rooms: [...(file.shared_rooms || []), room.id] });
    }
    if (ref.kind === 'call' && room?.id) {
      const call = this.store.get('platform-calls', ref.id);
      if (call && !call.shared_rooms?.includes(room.id)) {
        this.store.save('platform-calls', { id: call.id, shared_rooms: [...(call.shared_rooms || []), room.id] });
      }
      return call || ref;
    }
    const msg = ref.kind === 'event' ? this.store.get('messages', ref.id) : null;
    const platformEvent = ref.kind === 'event' && !msg ? this.store.get('platform-events', ref.id) : null;
    const event = msg || platformEvent;
    if (event) {
      if (principal.kind !== 'user' && !this.canReadEvent(event, caller)) {
        reject('share_forbidden', 'Cannot share an inaccessible event', 403);
      }
      const nativeRoomId = event.roomId || (event.space?.kind === 'room' ? event.space.id : null);
      if (room?.id && nativeRoomId !== room.id && !event.shared_rooms?.includes(room.id)) {
        this.store.save(msg ? 'messages' : 'platform-events', {
          id: event.id,
          shared_rooms: [...(event.shared_rooms || []), room.id],
        });
      }
      return event;
    }
    if (file) return this.files.view(file);
    if (!this.canReadReference(ref, caller)) {
      return this.attachments?.find(ref.id) || ref;
    }
    return this.attachments?.find(ref.id) || ref;
  }

  workspaceRecords() { return [...this.workspaces, ...this.store.list('platform-workspaces')]; }

  projectRoom(context) {
    if (context.project_room || context.session) return context.project_room ?? context.session.project_room;
    const space = context.conversation?.space;
    return space?.kind === 'room' && this.store.get('rooms', space.id)?.mode === 'group' ? space : null;
  }

  bindRoomWorkspace(value, actor, mode) {
    const principal = identity(actor);
    const id = value === null ? null : idOf(value, 'workspace');
    if (id && mode !== 'group') reject('workspace_forbidden', 'Project directories are shared in group Rooms', 403);
    if (!id) return null;
    const existingById = this.workspaceRecords().find(item => item.id === id);
    if (existingById) return { kind: 'workspace', id: existingById.id };
    const actual = this.authorizedDirectory(id);
    const existingByPath = this.workspaceRecords().find(item => {
      try { return relative(this.authorizedDirectory(item.path), actual) === ''; } catch { return false; }
    });
    if (existingByPath) return { kind: 'workspace', id: existingByPath.id };
    const saved = this.configureWorkspace({ name: basename(actual) || actual, path: actual, write: true });
    return { kind: 'workspace', id: saved.id };
  }

  protectedRuntimeDirectories() {
    return protectedRuntimeDirs(this.dataRoot, this.releaseRoot);
  }

  authorizedDirectory(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) reject('workspace_forbidden', 'Select an absolute host directory path', 403);
    let actual;
    try { actual = realpathSync(path); } catch { reject('workspace_not_found', 'The execution directory is unavailable', 404); }
    const dataRootReal = (() => { try { return realpathSync(this.dataRoot); } catch { return resolve(this.dataRoot); } })();
    const protectedDirectories = this.protectedRuntimeDirectories();
    const isDataRootItself = relative(dataRootReal, actual) === '';
    if (!statSync(actual).isDirectory() || isDataRootItself || protectedDirectories.some(dir => {
      let root;
      try { root = realpathSync(dir); } catch { root = resolve(dir); }
      return inside(root, actual);
    })) reject('workspace_forbidden', 'This directory is a protected Summon runtime directory', 403);
    return actual;
  }

  workspaceAvailable(id) {
    if (this.workspaceRecords().some(item => item.id === id)) return true;
    if (typeof id === 'string' && isAbsolute(id)) {
      try { this.authorizedDirectory(id); return true; } catch { return false; }
    }
    return false;
  }

  workspace(pathOrRef, context) {
    if (!pathOrRef) return null;
    const registered = this.workspaceRecords();
    const refId = typeof pathOrRef === 'object' ? idOf(pathOrRef, 'workspace') : pathOrRef;
    const selected = registered.find(item => item.id === refId);
    const given = selected?.path ?? (typeof refId === 'string' ? refId : null);
    const actual = this.authorizedDirectory(given);
    const matches = (selected ? [selected] : registered).flatMap(item => {
      try {
        const root = this.authorizedDirectory(item.path);
        return inside(root, actual) ? [{ item, root }] : [];
      } catch { return []; }
    }).sort((left, right) => right.root.length - left.root.length);
    const match = matches[0];
    if (match) return { ref: { kind: 'workspace', id: match.item.id }, path: actual, root: match.root, write: match.item.write !== false };
    return { ref: { kind: 'workspace', id: actual }, path: actual, root: actual, write: true };
  }

  projectFileAccess(ref, context, write = false) {
    this.assertRunAllowed(context);
    const workspace = this.workspace(ref, context);
    const session = context.session;
    workspace.path_policy = session?.path_policy ?? session?.workspace?.path_policy;
    if (session && sameRef(ref, session.workspace_ref)) {
      workspace.root = session.workspace.path;
      workspace.write &&= session.workspace.write;
    }
    if (write && !workspace.write)
      reject('workspace_forbidden', 'The project directory is read-only', 403);
    return workspace;
  }

  projectFileDirectories() {
    return this.protectedRuntimeDirectories();
  }

  configureWorkspace(input) {
    if (Object.keys(input).some(key => !['id', 'revision', 'name', 'path', 'write', 'remove'].includes(key))) reject('invalid_workspace', 'Unsupported execution directory setting');
    if (input.remove === true) {
      if (!input.id) reject('invalid_workspace', 'Provide workspace id to remove');
      if (input.id === 'ws-summon-home') reject('workspace_forbidden', 'Summon’s default workspace cannot be removed', 403);
      return this.store.transaction(() => {
        const previous = this.store.get('platform-workspaces', input.id);
        if (!previous) reject('workspace_not_found', 'Workspace not found', 404);
        if (input.revision !== undefined) assertRevision(previous.revision, input.revision);
        this.store.remove('platform-workspaces', input.id);
        this.emit('workspace', { id: input.id, removed: true });
        return { id: input.id, kind: 'workspace', removed: true };
      });
    }
    return this.store.transaction(() => {
      const id = input.id || randomUUID();
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) reject('invalid_workspace', 'Invalid execution directory ID');
      const previous = this.store.get('platform-workspaces', id);
      if (previous) {
        if (input.revision !== undefined) assertRevision(previous.revision, input.revision);
      } else if (input.revision !== undefined) assertRevision(null, input.revision);
      const rawPath = input.path ?? previous?.path;
      const path = this.authorizedDirectory(rawPath);
      const name = input.name ?? previous?.name ?? (basename(path) || path);
      if (typeof name !== 'string' || !name.trim() || name.length > 120) reject('invalid_workspace', 'An execution directory name is required');
      if (input.write !== undefined && typeof input.write !== 'boolean') reject('invalid_workspace', 'Invalid write authorization');
      const write = input.write ?? previous?.write ?? true;
      const saved = this.store.save('platform-workspaces', { id, kind: 'workspace', name: name.trim(), path, write,
        revision: (previous?.revision ?? 0) + 1 });
      this.emit('workspace', saved);
      return saved;
    });
  }

  async localWebBridge() {
    let deployment;
    try { deployment = JSON.parse(await readFile(join(this.dataRoot, 'config', 'deployment.json'), 'utf8')); }
    catch { reject('hub_unavailable', 'Local deployment configuration is unavailable', 503); }
    const accessToken = deployment?.web?.accessToken;
    if (!accessToken) reject('hub_unavailable', 'Local web access token is unavailable', 503);
    let baseUrl = `http://${deployment?.web?.host || '127.0.0.1'}:${deployment?.web?.port || 8787}`;
    try {
      const run = JSON.parse(await readFile(join(this.dataRoot, 'web', 'run', 'current.json'), 'utf8'));
      if (run?.url) baseUrl = run.url;
    } catch {}
    return { baseUrl, accessToken };
  }

  async manageHub(args) {
    const { baseUrl, accessToken } = await this.localWebBridge();
    const request = async (method, path, body) => {
      const res = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      }).catch(error => {
        reject('hub_unreachable', `无法连接本机 Web 中枢服务：${error.message}`, 502);
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) reject(data.code || 'hub_error', data.error || `中枢操作失败（HTTP ${res.status}）`, res.status);
      return data;
    };
    const action = args.action;
    if (action === 'status') {
      const [me, nodesResp] = await Promise.all([
        request('GET', '/hub/auth/me'),
        request('GET', '/hub/nodes').catch(() => ({ nodes: [] })),
      ]);
      return {
        action: 'status',
        mode: me.mode || 'local',
        hubUrl: me.hubUrl || null,
        authenticated: Boolean(me.authenticated ?? me.user),
        hubConnected: Boolean(me.hubConnected),
        hubError: me.hubError || '',
        localNodeId: me.localNodeId || null,
        localNodeName: me.localNodeName || '',
        user: me.user ? { username: me.user.username, displayName: me.user.displayName, role: me.user.role } : null,
        nodes: (nodesResp.nodes || []).map(n => ({
          id: n.id, name: n.name, hostname: n.hostname, platform: n.platform, online: Boolean(n.online), isLocal: Boolean(n.isLocal),
        })),
      };
    }
    if (action === 'login' || action === 'register') {
      if (!args.username || !args.password) reject('invalid_hub_credentials', '请提供用户名和密码');
      if (action === 'register' && !args.invite_code) reject('invalid_hub_credentials', '邀请码注册需要提供 invite_code');
      const payload = {
        username: args.username,
        password: args.password,
        ...(args.invite_code ? { inviteCode: args.invite_code } : {}),
        ...(args.display_name ? { displayName: args.display_name } : {}),
        ...(args.node_name ? { nodeName: args.node_name } : {}),
        ...(args.hub_url ? { hubUrl: args.hub_url } : {}),
      };
      const res = await request('POST', action === 'register' ? '/hub/auth/register' : '/hub/auth/login', payload);
      return {
        action,
        authenticated: Boolean(res.authenticated ?? res.user),
        hubUrl: res.hubUrl || args.hub_url || null,
        hubConnected: Boolean(res.hubConnected),
        localNodeId: res.localNodeId || null,
        localNodeName: res.localNodeName || args.node_name || '',
        user: res.user ? { username: res.user.username, displayName: res.user.displayName, role: res.user.role } : null,
      };
    }
    if (action === 'disconnect') {
      await request('POST', '/hub/auth/logout', {});
      return { action: 'disconnect', authenticated: false, hubConnected: false };
    }
    if (action === 'rename_node') {
      if (!args.node_name?.trim()) reject('invalid_node_name', '请提供新的电脑名称 node_name');
      let targetId = args.node_id;
      if (!targetId) {
        const me = await request('GET', '/hub/auth/me');
        targetId = me.localNodeId;
      }
      if (!targetId) reject('node_not_found', '找不到目标节点 ID', 404);
      const res = await request('PATCH', `/hub/nodes/${encodeURIComponent(targetId)}`, { name: args.node_name.trim() });
      return { action: 'rename_node', nodeId: targetId, name: args.node_name.trim(), ok: Boolean(res.ok ?? true) };
    }
    if (action === 'delete_node') {
      if (!args.node_id) reject('node_not_found', '请提供要解绑的 node_id');
      await request('DELETE', `/hub/nodes/${encodeURIComponent(args.node_id)}`);
      return { action: 'delete_node', nodeId: args.node_id, removed: true };
    }
    reject('invalid_hub_action', '不支持的中枢操作');
  }

  configureAccess(id, input, context) {
    if (context.actor.kind !== 'user') reject('configuration_forbidden', 'Only the host can grant Bot resources', 403);
    if (Object.keys(input).some(key => !['revision', 'model_ids', 'workspace_ids'].includes(key)))
      reject('invalid_access', 'Unsupported Bot resource setting');
    return this.store.transaction(() => {
      if (!this.visibleBot(this.getBot(id), context)) reject('bot_not_found', 'Bot not found', 404);
      const previous = this.store.get('platform-access', id) || { id, revision: 0, model_ids: [], workspace_ids: [] };
      assertRevision(previous.revision ?? 0, input.revision);
      const validate = (ids, exists) => {
        if (!Array.isArray(ids) || ids.length > 1000 || ids.some(value => typeof value !== 'string' || !exists(value))) {
          reject('invalid_access', 'One or more requested resource identities are unavailable');
        }
        return [...new Set(ids)];
      };
      let models;
      const model_ids = input.model_ids === undefined ? previous.model_ids : validate(input.model_ids, value =>
        previous.model_ids?.includes(value) || (models ??= this.models.catalog().connections)
          .some(model => model.id === value));
      const workspace_ids = input.workspace_ids === undefined ? previous.workspace_ids : validate(input.workspace_ids, value =>
        previous.workspace_ids?.includes(value) || this.workspaceRecords().some(item => item.id === value));
      const saved = this.store.save('platform-access', { id, model_ids, workspace_ids, revision: (previous.revision ?? 0) + 1 });
      this.runtime?.wake();
      return saved;
    });
  }

  canUseResources(actor, refs, context = {}) {
    return (refs || []).every(ref => this.canReadReference(ref, { ...context, actor }));
  }

  assertSessionAuthority(session) {
    if (session.authority_revoked ||
        (session.sharing && !this.store.get('rooms', session.space?.id)) ||
        (!session.sharing && session.execution_actor?.kind === 'bot' && !this.store.get(botRecords, session.execution_actor.id)?.enabled)) {
      reject('session_authority_revoked', 'The Session no longer has its assigned execution authority', 403);
    }
    if (session.engine === 'pi' && session.model && !this.canUseModel(session.execution_actor, session.model.connection_id)) {
      reject('session_authority_revoked', 'The Session no longer has its assigned model resource', 403);
    }
    if (session.engine !== 'pi' && !session.workspace?.path) {
      reject('workspace_forbidden', 'This Session has no execution directory', 403);
    }
  }

  assertCanSubmit(context, session) {
    if (!session || session.control.state !== 'active') reject('execution_paused', 'Execution is paused', 409);
    this.assertSessionAuthority(session, { checkWorkspacePath: true });
    this.assertRunAllowed(context, { allowUser: true, allowDraining: context.allowDraining });
  }

  prepareSession(args, context, call, options) {
    if (this.draining) reject('updating', 'New execution Sessions are temporarily paused', 503);
    const { actor } = context;
    const rawEngine = typeof args.engine === 'string' ? args.engine.trim() : '';
    let engine;
    let work_engine = null;
    if (rawEngine === 'pi' || rawEngine === 'exec') {
      engine = rawEngine;
    } else {
      const available = this.workEngines();
      const matched = available.find(item => item.id === rawEngine);
      if (!matched) {
        reject('work_engine_unavailable', `Work engine "${rawEngine}" is not enabled`, 409, {
          available_engines: available.map(item => item.id),
        });
      }
      engine = matched.id;
      work_engine = { id: matched.id, script: matched.script };
    }
    const space = args.space ?? context.session?.space ?? actor;
    const sharing = options.sharing(actor, space);
    const group_work = this.roomWork.scope(args, context, sharing, space);
    const project_room = this.projectRoom(context) ?? (sharing && space.kind === 'room' && this.store.get('rooms', space.id)?.mode === 'group' ? space : null);
    const roomWorkspace = project_room && this.store.get('rooms', project_room.id)?.workspace;
    const projectContext = { ...context, project_room };
    const selected = [...(args.resource_refs || [])];
    if (selected.some(ref => !['workspace', 'file', 'event'].includes(ref.kind))) {
      reject('invalid_resource', 'Session resources must be directories, Files or Events');
    }
    const inherited = context.session?.workspace?.path;
    const fallbackWorkspace = this.workspaceRecords()[0]?.id;
    const workspaceSelection = args.workspace ?? (inherited || roomWorkspace || fallbackWorkspace);
    if (engine !== 'pi' && !workspaceSelection) reject('workspace_required', `Specify a working directory for ${engine}`, 409);
    const workspace = workspaceSelection ? this.workspace(workspaceSelection, projectContext) : null;
    if (workspace && !selected.some(ref => sameRef(ref, workspace.ref))) selected.push(workspace.ref);
    const resource_refs = [...new Map(selected.map(ref => [keyOf(ref.kind, ref.id), ref])).values()];
    const bot = actor.kind === 'bot' ? this.getBot(actor.id) : null;
    if (engine === 'pi' && !bot) reject('pi_actor_required', 'Open a Pi Session from an authorized Bot conversation', 409);
    const model = engine === 'pi' ? (context.session?.model ?? this.models.resolveForBot(bot, 'pi_session')) : null;
    if (engine === 'pi' && (!model || !this.canUseModel(actor, model.connection_id))) reject('connection_unconfigured', 'The Pi execution model is unavailable', 409);
    const binding = model ? context.session?.model_binding ?? bindModel({ connectionStore: this.models.path }, model, 'pi_session') : null;
    const origin_room = context.session?.origin_room ??
      (context.conversation?.space?.kind === 'room' ? context.conversation.space : null) ?? project_room ?? group_work?.room ?? null;
    const origin_message_id = this.roomWork.origin(args, context, origin_room, group_work);
    if (group_work && sameRef(group_work.room, origin_room) && origin_message_id)
      group_work.source = { kind: 'event', id: origin_message_id };
    const owner_conversation_id = context.origin?.conversation_id ?? null;
    const work_summary = args.work_summary?.trim() || null;
    if (origin_room?.id) this.deliveries.noteRoomActivity(origin_room.id, 'tool_progress');
    const nowIso = new Date().toISOString();
    return this.store.transaction(() => {
      const session = this.store.save(sessionRecords, { id: call.id, engine, space, owner: actor, bot_id: bot?.id ?? null,
        source_space: project_room || context.conversation?.space || null, project_room,
        origin_room, origin_message_id, owner_conversation_id, owner_run_id: context.origin?.run_id ?? null, work_summary,
        pending_input: [],
        created_at: nowIso, updated_at: nowIso,
        ...(roomWorkspace && resource_refs.some(ref => sameRef(ref, roomWorkspace)) ? { room_workspace_id: roomWorkspace.id } : {}),
        execution_actor: actor, submitted_by: actor, model, model_binding: binding,
        instructions: sharing ? '' : context.session?.instructions ?? bot?.instructions ?? '',
        ...(engine === 'pi' ? { built_in_role: sharing ? null : (context.session ? context.session.built_in_role : bot.built_in_role) ?? null } : {}),
        bot_revision: bot?.revision ?? null, sharing, resource_refs, workspace: workspace ? { path: workspace.path, root: workspace.root, write: workspace.write } : null,
        workspace_ref: workspace?.ref ?? null, status: 'opening', native: null, input_revision: 0,
        ...(engine === 'pi' ? { open_call_id: call.id } : {}),
        ...(work_engine ? { work_engine } : {}),
        ...(group_work ? { group_work } : {}),
        control: activeControl(), origin_execution: context.session ? { kind: 'session', id: context.session.id } :
          context.origin?.conversation_id ? { kind: 'conversation', id: context.origin.conversation_id } : null, latest_call_id: call.id });
      this.calls.bind(call.id, { target: { kind: 'session', id: session.id }, session_id: session.id, execution_actor: actor });
      return session;
    });
  }

  activeSessions(exclude) {
    return this.store.list(sessionRecords).filter(item => item.id !== exclude && this.isActiveSession(item)).length;
  }

  isActiveSession(session) {
    return !inactiveSessions.has(session.status) && (session.status !== 'unknown' || session.safe_to_disconnect !== true);
  }

  context(context) {
    const actor = identity(context.actor);
    const origin = context.origin;
    if (actor.kind === 'bot' && origin?.conversation_kind === 'fast_read') {
      if (!origin.run_id || !Array.isArray(origin.event_ids) || origin.space?.kind !== 'room' || typeof origin.space.id !== 'string' || !origin.space.id) {
        reject('runtime_origin_required', 'A Bot fast-read invocation must have a host-provided room and source', 403);
      }
      const conversation = { id: origin.conversation_id || keyOf('fast_read', actor.id, origin.space.id), kind: 'fast_read', bot_id: actor.id, space: origin.space };
      const control = (target, version) => ({ target,
        control_version: context.controls?.find(value => sameRef(value.target, target))?.control_version ?? version });
      const controls = [control(actor, this.getBot(actor.id).control.control_version)];
      return { ...context, actor, origin, conversation, session: null, controls, resource_refs: [] };
    }
    if (actor.kind === 'bot' && (!origin?.conversation_id || !origin.run_id || !Array.isArray(origin.event_ids))) {
      reject('runtime_origin_required', 'A Bot invocation must have a host-provided run and source', 403);
    }
    const conversation = origin?.conversation_id ? this.store.get(conversationRecords, origin.conversation_id) : null;
    const sessionId = conversation?.session_id ?? origin?.session_id;
    const session = sessionId ? this.store.get(sessionRecords, sessionId) : null;
    if (actor.kind === 'bot' && (!conversation || conversation.bot_id !== actor.id ||
      origin.session_id && origin.session_id !== conversation.session_id || sessionId && !sameIdentity(session?.execution_actor, actor))) {
      reject('runtime_origin_conflict', 'The invocation does not belong to this Bot run', 403);
    }
    const control = (target, version) => ({ target,
      control_version: context.controls?.find(value => sameRef(value.target, target))?.control_version ?? version });
    const controls = actor.kind === 'bot' ? [control(actor, this.getBot(actor.id).control.control_version)] : [];
    if (conversation) controls.push(control({ kind: 'conversation', id: conversation.id }, origin.control_version));
    if (session) controls.push(control({ kind: 'session', id: session.id }, session.control.control_version));
    return { ...context, actor, origin, conversation, session, controls, resource_refs: [...(session?.resource_refs || []), ...(session ? context.input_refs || [] : [])] };
  }

  assertRunAllowed(input, options = {}) {
    const context = input.conversation !== undefined ? input : this.context(input);
    if (context.signal?.aborted) reject('cancelled', 'This run was interrupted', 409);
    if (this.draining && !options.allowDraining && !context.allowDraining) reject('updating', 'New autonomous work is paused for the update window', 503);
    if (context.actor.kind === 'user') return context;
    const bot = this.getBot(context.actor.id);
    if (!bot.enabled) reject('bot_paused', 'Bot is paused', 409);
    assertRevision(bot.control.control_version, context.controls.find(item => item.target.kind === 'bot')?.control_version, 'control_version');
    if (context.conversation?.kind === 'fast_read') {
      if (!this.canReadSpace(context.actor, context.conversation.space, context)) reject('room_forbidden', 'Room is not available for fast-read intake', 403);
      return context;
    }
    const target = { kind: 'conversation', id: context.conversation.id };
    const current = this.executions.require(target, context, 'input');
    this.executions.active(current, context.origin.control_version);
    if (context.session) {
      const live = this.executions.record({ kind: 'session', id: context.session.id });
      const version = context.controls.find(item => item.target.kind === 'session')?.control_version;
      this.executions.active(live, version);
      this.assertSessionAuthority(live);
      if (context.submitted_by && !sameIdentity(context.actor, context.submitted_by)) {
        const submitter = { actor: identity(context.submitted_by), project_room: live.project_room };
        if (!this.executions.permission({ kind: 'session', id: live.id }, live, submitter, 'input') ||
            !this.canUseResources(submitter.actor, live.resource_refs, submitter)) {
          reject('execution_resources_forbidden', 'Original submitter no longer has execution resources', 403);
        }
      }
    }
    return context;
  }

  executionView(input) {
    const context = this.assertRunAllowed(input);
    const rooms = this.store.list('rooms').filter(room => room.members.includes(context.actor.id))
      .map(room => room.id).sort();
    const access = this.accessFor(context.actor);
    const permitted = context.session?.resource_refs?.map(ref => [ref.kind, ref.id, this.canReadReference(ref, context)]) ?? [];
    const waits = this.calls.returnWaits(context.origin, context.actor);
    const revoked_return_waits = waits.filter(wait => !this.canReadReturnWait(wait, wait.target)).map(wait => wait.id).sort();
    return {
      actor: context.actor,
      resources: context.session?.resource_refs ?? [],
      session: context.session,
      conversation: context.conversation,
      view_revision: keyOf(rooms, context.session?.id, context.session?.control.control_version, access?.revision, permitted),
      unfinished_calls: this.calls.unfinishedFor(context.conversation.id, context.actor),
      pending_return_waits: waits.filter(wait => ['waiting', 'pending_delivery', 'received'].includes(wait.status)),
      revoked_return_waits,
      canReadEvent: event => this.canReadEvent(event, context),
    };
  }

  async installDrain(state) {
    this.draining = ['prepared', 'draining'].includes(state?.phase);
    this.runtime.setDraining(this.draining);
    if (!this.draining) return { active: [], ready: true };
    const native = await this.exec.drainStatus();
    const active = native.active.filter(item => item.safe_to_disconnect !== true)
      .map(item => ({ kind: item.kind, id: item.id, status: item.status }));
    const jobs = await this.runtime.drainStatus();
    active.push(...jobs.active);
    for (const item of this.resources.recordCurrentUsage().pending) {
      if (item.resource === 'models') active.push({ kind: item.resource, id: item.id, status: 'running' });
    }
    if (this.deliveries.flushing) active.push({ kind: 'delivery', id: 'outbox', status: 'writing' });
    return { active, ready: active.length === 0 };
  }

  resourceSource(context, session) {
    return { submitted_by: context.submitted_by || context.actor, execution_actor: session?.execution_actor || context.actor,
      origin_bot: context.actor.kind === 'bot' ? context.actor.id : null, origin: context.origin,
      space: session?.space ?? context.conversation?.space ?? context.actor };
  }

  acquireModel(input, options = {}) {
    const context = this.assertRunAllowed(input);
    return this.resources.acquire('models', this.resourceSource(context, context.session), options);
  }

  async invoke(name, args, input) {
    const { result, call_id } = await this.executeTool(name, args, input);
    if (!call_id || !result || typeof result !== 'object') return result;
    const record = this.calls.get(call_id);
    const wait_refs = record.return_refs.map(id => this.store.get(waitRecords, id)).filter(wait => wait && wait.bot_id === input.actor.id &&
      wait.conversation_id === input.origin?.conversation_id && wait.run_id === input.origin?.run_id);
    const waiting = record.status === 'submitted' && wait_refs.some(wait => ['waiting', 'pending_delivery', 'received'].includes(wait.status));
    return { ...result, call_id, wait_refs, ...(waiting ? { wait_guidance:
      'Your wait_ref delivers the terminal receipt or an input request to this run automatically. You can end this turn while waiting, continue independent work, or use read for a specific observation or control target.' } : {}) };
  }

  async executeTool(name, args, input) {
    validateTool(name, args);
    const context = this.context(input);
    if (name === 'send_input' && args.kind === 'reply' && context.actor.kind === 'user') context.allowDraining = true;
    if (context.actor.kind === 'bot') {
      if ((context.origin?.conversation_kind === 'fast_read' || context.conversation?.kind === 'fast_read') && !readTools.has(name)) {
        reject('fast_read_readonly', 'Fast-read intake is read-only and cannot execute writable tools', 403);
      }
      if (!readTools.has(name) && !context.call_id) reject('call_id_required', 'A writable invocation requires a host call ID', 400);
      this.assertRunAllowed(context);
    }
    if (readTools.has(name)) return { result: await this[name](args, context), call_id: null };
    if (this.draining && !(context.actor.kind === 'user' && (name === 'send' || context.allowDraining))) {
      reject('updating', 'This operation is temporarily unavailable during the update', 503);
    }
    const { record, existing } = this.calls.begin(name, context);
    if (existing) return { result: this.calls.replay(record, context), call_id: record.id };
    let trackedActivity = null;
    try {
      const guard = this.guardRoomWriteActivity(name, args, context, record);
      if (guard?.conflict) return { result: guard.conflict, call_id: record.id };
      trackedActivity = guard?.activity ?? null;
      if (name === 'manage_hub') {
        const result = await this.manageHub(args);
        this.calls.finish(record.id, 'completed', result);
        if (trackedActivity) trackedActivity.status = 'completed';
        return { result, call_id: record.id };
      }
      if (name === 'manage_update') {
        const result = await this.selfUpdate.execute(args, context);
        this.calls.finish(record.id, 'completed', result);
        if (trackedActivity) trackedActivity.status = 'completed';
        return { result, call_id: record.id };
      }
      if (name === 'open_session' || name === 'send_input' || name === 'stop_session') {
        const result = name === 'open_session' ? await this.executions.open(args, context, record)
          : name === 'send_input' ? await this.executions.submit(args, context, record) : await this.executions.stop(args, context, record);
        if (trackedActivity) {
          trackedActivity.status = result?.status === 'completed' ? 'completed' : 'running';
          if (result?.target) trackedActivity.target = result.target;
        }
        if (name === 'open_session' && result?.target && context.actor.kind === 'bot' && Array.isArray(context.origin?.event_ids)) {
          for (const sourceEventId of context.origin.event_ids) {
            this.deliveries.recordWakeupOutcome(sourceEventId, context.actor.id, {
              outcome: 'opened_session',
              outcome_ref: result.target,
            });
          }
        }
        const execRoomId = result?.origin_room?.id
          || (context.conversation?.space?.kind === 'room' ? context.conversation.space.id : null)
          || (args.work_room ? (typeof args.work_room === 'string' ? args.work_room : args.work_room.id) : null);
        if (execRoomId && (name === 'open_session' || name === 'send_input')) {
          this.goals.onRoomActivity(execRoomId, 'session');
        }
        this.emit('execution', { call_id: record.id });
        return { result, call_id: record.id };
      }
      if (name === 'create_bot') {
        if (context.session) reject('configuration_forbidden', 'This Session cannot create Bot identities', 403);
        const result = this.store.transaction(() => {
          const id = `bot-${record.id}`;
          const bot = this.manager.create(id, args, context, () => this.assertRunAllowed(context));
          this.calls.bind(record.id, { target: { kind: 'bot', id: bot.id } });
          return this.calls.finish(record.id, 'completed', {
            ...this.manager.view(bot, context.actor),
            ...(bot.id !== id && !args.bundled_id ? { reused: true } : {}),
          });
        });
        if (trackedActivity) {
          trackedActivity.status = 'completed';
          if (result?.id) trackedActivity.target = { kind: 'bot', id: result.id };
        }
        this.emit('bot', result);
        return { result, call_id: record.id };
      }
      if (name === 'save_file' && args.space.kind === 'user' && args.space.id === 'user' && String(args.path || '').trim() === 'host-profile.md') {
        if (context.session) {
          reject('configuration_forbidden', 'Work Sessions cannot directly modify host-profile.md; return insights to the Room conversation', 403);
        }
        const content = typeof args.content_or_source === 'string' ? args.content_or_source : args.content_or_source?.text;
        if (typeof content !== 'string') reject('invalid_content', 'Provide text content when updating host-profile.md');
        const written = writeHostProfile(this.dataRoot, content);
        this.emit('host_profile');
        const result = this.store.transaction(() => {
          this.calls.bind(record.id, { target: args.space });
          return this.calls.finish(record.id, 'completed', { kind: 'host_profile', path: 'host-profile.md', ...written });
        });
        return { result, call_id: record.id };
      }
      if (name === 'save_file' && args.space.kind === 'engine') {
        if (!this.canConfigureEngine(context.actor)) {
          reject('configuration_forbidden', 'Only the host or the Summon maintenance lead can modify work engine files', 403);
        }
        const content = typeof args.content_or_source === 'string' ? args.content_or_source : args.content_or_source?.text;
        if (typeof content !== 'string') reject('invalid_content', 'Provide text content when saving into an engine folder');
        const written = this.engines.writeFile(args.space.id, args.path, content);
        this.emit('engine');
        const result = this.store.transaction(() => {
          this.calls.bind(record.id, { target: args.space });
          return this.calls.finish(record.id, 'completed', { kind: 'engine_file', engine_id: args.space.id, ...written });
        });
        return { result, call_id: record.id };
      }
      if (name === 'save_file' && args.space.kind === 'knowledge') {
        const content = typeof args.content_or_source === 'string' ? args.content_or_source : args.content_or_source?.text;
        if (typeof content !== 'string') reject('invalid_content', 'Provide text content when saving into shared knowledge');
        const targetPath = String(args.path || (args.space.id !== 'shared' ? args.space.id : '')).trim();
        const written = this.knowledge.write(targetPath, content);
        this.emit('knowledge');
        const result = this.store.transaction(() => {
          this.calls.bind(record.id, { target: { kind: 'knowledge', id: written.id } });
          return this.calls.finish(record.id, 'completed', written);
        });
        return { result, call_id: record.id };
      }
      if (name === 'save_file' && args.space.kind === 'capability') {
        if (!this.canConfigureCapability(context.actor, args.space.id)) {
          reject('configuration_forbidden', 'Cannot modify this platform capability folder', 403);
        }
        const content = typeof args.content_or_source === 'string' ? args.content_or_source : args.content_or_source?.text;
        if (typeof content !== 'string') reject('invalid_content', 'Provide text content when saving into a capability folder');
        const written = this.capabilities.writeFile(args.space.id, args.path, content);
        this.emit('capability');
        const result = this.store.transaction(() => {
          this.calls.bind(record.id, { target: args.space });
          return this.calls.finish(record.id, 'completed', { kind: 'capability_file', capability_id: args.space.id, ...written });
        });
        return { result, call_id: record.id };
      }
      if (name === 'save_file' && args.space.kind === 'bot') {
        const targetBot = this.getBot(args.space.id);
        const cleanPath = validateBotRelPath(args.path);
        const callerBot = context.actor.kind === 'bot' ? this.store.get(botRecords, context.actor.id) : null;
        const eggHandoffWrite = callerBot?.built_in_role?.id === eggbotRole
          && targetBot.built_in_role?.id !== eggbotRole
          && /^(skills|scripts|\.local\/memory)\//.test(cleanPath);
        if (!this.manager.canConfigure(context.actor, targetBot) && !eggHandoffWrite) {
          reject('configuration_forbidden', 'Cannot write files into another Bot’s folder', 403);
        }
        const content = typeof args.content_or_source === 'string' ? args.content_or_source : args.content_or_source?.text;
        if (typeof content !== 'string') reject('invalid_content', 'Provide text content when saving into a Bot folder');
        const written = writeBotFolderFile(this.dataRoot, targetBot.id, cleanPath, content);
        if (written.path === 'instructions.md') {
          this.store.save(botRecords, { id: targetBot.id, instructions: content, revision: targetBot.revision + 1 });
          this.emit('bot');
        }
        const result = this.store.transaction(() => {
          this.calls.bind(record.id, { target: args.space });
          return this.calls.finish(record.id, 'completed', { kind: 'bot_file', bot_id: targetBot.id, ...written });
        });
        return { result, call_id: record.id };
      }
      if (name === 'save_file' && args.space.kind === 'workspace') {
        const source = args.content_or_source?.source;
        const authorize = () => {
          const selected = this.projectFileAccess(args.space, context, true);
          if (source) {
            if (source.kind !== 'file' || !this.canReadReference(source, context))
              reject('file_source_forbidden', 'Choose an accessible File to copy into the project directory', 403);
            const room = this.projectRoom(context);
            if (room) this.assertShareable(source, { actor: context.actor, room: this.room.room(room.id, context.actor), context });
          }
          return selected;
        };
        const workspace = authorize();
        const content = source ? (await this.files.download(source.id, context)).bytes :
          typeof args.content_or_source === 'string' ? args.content_or_source : args.content_or_source?.text;
        const commit = await this.files.prepareWorkspaceWrite(args, content, workspace, this.projectFileDirectories(), () => {
          if (authorize().root !== workspace.root) reject('workspace_changed', 'The project directory has moved', 409);
        });
        const result = this.store.transaction(() => {
          const value = commit();
          this.calls.bind(record.id, { target: args.space });
          return this.calls.finish(record.id, 'completed', value);
        });
        return { result, call_id: record.id };
      }
      const source = name === 'save_file' ? args.content_or_source?.source : null;
      let workspaceFile;
      if (source?.kind === 'workspace') {
        const workspace = this.projectFileAccess(source, context);
        workspaceFile = await this.files.collectWorkspaceFile(source, args.content_or_source.path, workspace, this.projectFileDirectories());
        if (this.projectFileAccess(source, context).root !== workspace.root) {
          reject('workspace_changed', 'The execution directory grant changed while collecting the file', 409);
        }
      }
      const result = this.store.transaction(() => {
        const value = this.write(name, args, context, record, workspaceFile);
        this.calls.finish(record.id, 'completed', value);
        return value;
      });
      if (name === 'configure_bot' && result.control && Object.keys(args).some(key => !['bot', 'revision', 'role_id'].includes(key))) {
        if (result.control.state === 'paused' && result.control.stop_status === 'pending') {
          await this.settleBot(result.id, result.control);
          const settled = this.manager.view(this.getBot(result.id), context.actor);
          this.calls.bind(record.id, { result: settled });
          return { result: settled, call_id: record.id };
        } else {
          if (args.enabled === true) {
            this.deliveries.purgePausedDeliveries(result.id);
            await this.runtime.alignBotOnEnable(result.id);
          }
          this.runtime.wake();
        }
      }
      if (name === 'configure_session') {
        this.emit('execution', { call_id: record.id });
      }
      if (name === 'configure_room' && args.remove_members?.length) {
        this.stripRemovedFromSharedSessions(result.id, args.remove_members.map(m => identity(m).id));
        await this.revokeSessions({ kind: 'room', id: result.id });
      }
      if (trackedActivity) {
        trackedActivity.status = 'completed';
        if (result?.id && (name === 'configure_room' || name === 'create_room')) trackedActivity.target = { kind: 'room', id: result.id };
      }
      return { result, call_id: record.id };
    } catch (error) {
      if (trackedActivity) trackedActivity.status = 'failed';
      this.calls.fail(record.id, error);
      error.call_id = record.id;
      throw error;
    }
  }

  write(name, args, context, call, workspaceFile) {
    const { actor } = context;
    const members = values => values?.map(value => identity(value).id);
    if (name === 'create_room') {
      if (context.session) reject('room_forbidden', 'A Session cannot create Room membership', 403);
      const room = this.room.createRoom({ ...args, members: members(args.members) }, actor.id,
        { id: call.id });
      this.calls.bind(call.id, { target: { kind: 'room', id: room.id } });
      return room;
    }
    if (name === 'configure_room') {
      const id = idOf(args.room, 'room');
      if (context.session) reject('room_forbidden', 'A Session cannot modify Room membership or configuration', 403);
      this.calls.bind(call.id, { target: { kind: 'room', id } });
      return this.room.configureRoom(id, { ...args, add_members: members(args.add_members), remove_members: members(args.remove_members) }, actor.id);
    }
    if (name === 'send') {
      const id = idOf(args.to, 'room');
      const space = { kind: 'room', id };
      if (actor.kind === 'bot' && (context.session || !context.conversation || context.conversation.kind !== 'room' || context.conversation.session_id)) {
        reject('room_send_forbidden', 'Only the Bot’s main Room conversation can publish messages to a Room', 403);
      }
      if (!this.canWriteSpace(actor, space, context)) reject('room_forbidden', 'Room is not available for sending', 403);
      const attachments = args.attachments?.map(ref => normalize(ref, 'file'));
      if (context.session) for (const ref of [...(attachments || []), ...(args.references || [])]) {
        if (!this.canReadReference(ref, context)) reject('share_forbidden', 'A reference is outside this Session’s resource scope', 403);
      }
      if (actor.kind === 'bot') this.resources.acquire('message', this.resourceSource(context), { id: call.id }).finish();
      this.calls.bind(call.id, { target: space });
      const sameRoomRun = actor.kind === 'bot' && context.conversation?.kind === 'room' && context.conversation.space?.id === id;
      const sendResult = this.room.send(id, {
        ...args,
        attachments,
        reply_to: normalize(args.reply_to, 'event'),
        origin_message_id: args.origin_message_id ? normalize(args.origin_message_id, 'event') : undefined,
        mentions: members(args.mentions),
        clientId: context.clientId,
      }, actor.id, {
        callId: call.id,
        ...(sameRoomRun && Number.isSafeInteger(context.origin?.seen_room_sequence) ? {
          expectedSequence: context.origin.seen_room_sequence,
          ownRunCallIds: context.origin.own_run_send_call_ids,
        } : {}),
      });
      if (sendResult?.message && actor.kind === 'bot' && Array.isArray(context.origin?.event_ids)) {
        for (const sourceEventId of context.origin.event_ids) {
          this.deliveries.recordWakeupOutcome(sourceEventId, actor.id, {
            outcome: 'sent_message',
            outcome_ref: { kind: 'event', id: sendResult.message.id },
          });
        }
      }
      if (sendResult?.message) {
        if (actor.kind === 'user') this.goals.onUserMessage(id);
        else if (args.prompt || args.awaiting_reply === true) {
          const reason = args.prompt?.title || args.prompt?.questions?.[0]?.label || '';
          this.goals.onAwaitingUser(id, reason, { hasPrompt: Boolean(args.prompt) });
        }
        else this.goals.onRoomActivity(id, 'bot_message');
      }
      return sendResult;
    }
    if (name === 'save_file') {
      const file = this.files.save(args, context, call.id, workspaceFile);
      this.calls.bind(call.id, { target: file.ref });
      this.emit('file', file.ref);
      return file;
    }
    if (name === 'configure_bot') {
      if (context.session) reject('configuration_forbidden', 'This Session has no Bot configuration authority', 403);
      const previousRole = args.role_id !== undefined && this.getBot(idOf(args.bot, 'bot')).built_in_role?.id;
      const bot = this.manager.configure(args, context, call.id);
      if (args.role_id !== undefined && previousRole !== args.role_id && (previousRole === 'eggbot' || args.role_id === 'eggbot'))
        this.deliveries.syncObserverMemberships(bot.id);
      const result = this.manager.view(bot, actor);
      this.calls.bind(call.id, { target: { kind: 'bot', id: bot.id } });
      this.emit('bot', result);
      return result;
    }
    if (name === 'set_wakeup') {
      const value = this.deliveries.set(args, context, call.id);
      this.emit('wakeup', { id: value.id });
      return value;
    }
    if (name === 'configure_session') {
      return this.executions.configure(args, context, call);
    }
    if (name === 'update_goal') {
      const value = this.goals.update(args, context);
      const roomId = idOf(args.room, 'room');
      this.calls.bind(call.id, { target: { kind: 'room', id: roomId } });
      return value;
    }
    if (name === 'configure_workspace') {
      const value = this.configureWorkspace(args);
      if (value?.id) this.calls.bind(call.id, { target: { kind: 'workspace', id: value.id } });
      return value;
    }
    reject('tool_not_found', 'Unknown writable tool', 404);
  }

  sessionReceiptPreview(session, context) {
    if (!session?.latest_call_id) return '';
    const call = this.store.get('platform-calls', session.latest_call_id);
    if (!call) return '';
    const texts = [];
    if (call.result_ref?.kind === 'event') {
      const event = this.store.get('platform-events', call.result_ref.id);
      if (event && this.canReadEvent(event, context)) {
        const out = event.result?.output;
        if (typeof out === 'string') texts.push(out);
        else if (out && typeof out === 'object') {
          if (typeof out.text === 'string') texts.push(out.text);
          if (typeof out.stdout === 'string') texts.push(out.stdout);
          if (typeof out.stderr === 'string') texts.push(out.stderr);
        }
        if (typeof event.result?.error === 'string') texts.push(event.result.error);
      }
    }
    const callOut = call.result?.output;
    if (typeof callOut === 'string') texts.push(callOut);
    else if (callOut && typeof callOut === 'object') {
      if (typeof callOut.text === 'string') texts.push(callOut.text);
      if (typeof callOut.stdout === 'string') texts.push(callOut.stdout);
    }
    return texts.join('\n').slice(0, 8000);
  }

  searchableTexts(kind, item, context) {
    switch (kind) {
      case 'event': {
        const out = item.result?.output;
        return [
          item.id, item.roomId, item.room_name, item.senderId, item.senderName,
          item.content, item.text, item.type, item.call_id, item.work_summary,
          ...(Array.isArray(item.attachments) ? item.attachments.map(att => att?.name) : []),
          typeof out === 'string' ? out : null,
          out?.text, out?.stdout, out?.stderr, item.result?.error,
        ];
      }
      case 'session':
        return [
          item.id, item.engine, item.work_summary, item.status,
          item.origin_room?.id, item.origin_room_name, item.last_error?.message,
          this.sessionReceiptPreview(item, context),
        ];
      case 'conversation':
        return [item.id, item.room_name, item.space?.id, item.status];
      case 'room':
        return [item.id, item.name, item.lastMessage?.content];
      case 'call':
        return [item.id, item.tool, item.status, item.target?.id];
      case 'capability':
        return [
          item.id, item.name, item.description, item.owner_bot, item.owner_name, item.room_id,
          ...(Array.isArray(item.env_slots) ? item.env_slots : []),
        ];
      case 'knowledge':
        return [item.id, item.path, item.title, item.summary, item._text];
      default:
        return [item.id, item.name, item.path, item.content, item.text, item.public_duty, item.role_id, item.summary, item.work_summary];
    }
  }

  async find({ kind, scope, query, cursor }, context) {
    const { actor } = context;
    if (scope && !this.canReadReference(scope, context)) reject('scope_unavailable', 'Search scope is unavailable', 404);
    let items;
    switch (kind) {
      case 'engine': {
        items = this.engines.list({ fresh: actor.kind === 'user' });
        break;
      }
      case 'capability': {
        items = this.capabilities.list({ lookupBot: id => this.store.get(botRecords, id) });
        break;
      }
      case 'knowledge': {
        items = this.knowledge.list({ includeSnippet: Boolean(query?.trim()) });
        break;
      }
      case 'bot': {
        const team = this.canFindTeam(context);
        const members = scope?.kind === 'room' ? new Set(this.roomMembers(scope.id)) : null;
        items = this.manager.list().filter(bot => (!scope || members?.has(bot.id)) &&
          (team ? !bot.archivedAt : this.visibleBot(bot, context)))
          .map(bot => team ? directoryEntry(bot) : this.manager.view(bot, actor, { details: !context.session }));
        break;
      }
      case 'room': items = this.room.readableRooms(actor.id, { includeCrossRoomGroups: actor.kind === 'bot' })
        .map(room => ({ ...room, kind: 'room' })); break;
      case 'event': {
        const allowCross = actor.kind === 'bot';
        const accessibleRooms = this.room.readableRooms(actor.id, { includeCrossRoomGroups: allowCross })
          .filter(room => !scope || sameRef(scope, room.ref));
        const messages = accessibleRooms.flatMap(room =>
          this.room.messages(room.id, actor.id, { allowCrossRoomGroup: allowCross }).map(msg => ({
            ...msg,
            room_name: room.name,
            senderName: msg.senderName || this.actorLabel(msg.senderId),
          })),
        );
        const platformEvents = this.store.list('platform-events')
          .filter(event => this.canReadEvent(event, context) && (!scope || sameRef(event.space || event.target, scope)))
          .map(event => {
            const originRoomId = event.origin_room?.id || (event.space?.kind === 'room' ? event.space.id : null);
            const roomName = originRoomId ? this.store.get('rooms', originRoomId)?.name : null;
            const sess = event.target?.kind === 'session' ? this.executions.record(event.target) : null;
            return {
              ...event,
              ...(roomName ? { room_name: roomName } : {}),
              ...(sess?.work_summary ? { work_summary: sess.work_summary } : {}),
            };
          });
        items = [...messages, ...platformEvents].sort((left, right) => {
          const lt = Date.parse(left.createdAt || left.time || 0) || 0;
          const rt = Date.parse(right.createdAt || right.time || 0) || 0;
          if (rt !== lt) return rt - lt;
          return (right.sequence ?? 0) - (left.sequence ?? 0);
        });
        break;
      }
      case 'file':
        if (scope?.kind === 'workspace') return this.workspaceEntries({ ref: scope, query, cursor }, context);
        items = this.files.list(context, scope);
        break;
      case 'session': case 'conversation':
        items = this.executions.list(context, scope).filter(item => item.kind === kind);
        if (kind === 'session') {
          items.sort((left, right) =>
            (Date.parse(right.updated_at || right.created_at || 0) || 0) -
            (Date.parse(left.updated_at || left.created_at || 0) || 0));
        }
        break;
      case 'workspace': {
        const origin = this.projectRoom(context);
        const room = scope?.kind === 'room' && (actor.kind === 'user' || sameRef(origin, scope)) ? this.store.get('rooms', scope.id) : null;
        items = this.workspaceRecords().filter(item => (!scope || room?.workspace?.id === item.id) &&
          this.workspaceAvailable(item.id, actor, room ? { ...context, project_room: scope } : context))
          .map(({ id, name, path, write, revision }) => ({ id, name, path, write, revision, kind: 'workspace' }));
        break;
      }
      case 'wakeup': items = this.deliveries.list(context, scope); break;
      case 'call': items = this.store.list('platform-calls').filter(call => this.calls.canRead(actor, call, context) &&
        (!scope || sameRef(call.target, scope) || scope.kind === 'conversation' && call.origin?.conversation_id === scope.id))
        .map(call => this.calls.view(call, context)); break;
      case 'wait': items = this.store.list(waitRecords).filter(item => (actor.kind === 'user' || actor.id === item.bot_id) &&
        (!context.session || item.session_id === context.session.id) && (!scope || scope.kind === 'call' && item.call_id === scope.id ||
          scope.kind === 'conversation' && item.conversation_id === scope.id)).map(wait => ({ ...wait, kind: 'wait' })); break;
      default: items = [];
    }
    if (items?.items) items = items.items;
    const tokens = (query?.trim().toLowerCase() || '').split(/\s+/).filter(Boolean);
    const filtered = (tokens.length ? items.filter(item => {
      const haystack = this.searchableTexts(kind, item, context)
        .filter(value => typeof value === 'string' && value.length > 0)
        .join('\n')
        .toLowerCase();
      return tokens.every(token => haystack.includes(token));
    }) : items).map(item => {
      if (item && typeof item === 'object' && '_text' in item) {
        const { _text, ...cleanItem } = item;
        return cleanItem;
      }
      return item;
    });
    return page(filtered, cursor);
  }

  workspaceEntries(args, context) {
    const workspace = this.projectFileAccess(args.ref, context);
    return this.files.listWorkspace(args, workspace, this.projectFileDirectories(), () => {
      if (this.projectFileAccess(args.ref, context).root !== workspace.root) reject('workspace_changed', 'The project directory has moved', 409);
    });
  }

  async streamWorkspaceFile(workspaceId, path, context, options = {}) {
    const ref = { kind: 'workspace', id: workspaceId };
    if (!this.workspaceAvailable(workspaceId, context.actor, context)) {
      reject('workspace_forbidden', 'Workspace is unavailable or access was revoked', 403);
    }
    const workspace = this.projectFileAccess(ref, context);
    return this.files.streamWorkspaceFile(path, workspace, this.projectFileDirectories(), options);
  }

  async read(args, context) {
    const { ref } = args;
    if (ref.kind === 'wait') {
      const wait = this.store.get(waitRecords, ref.id);
      if (!wait || context.actor.kind !== 'user' && wait.bot_id !== context.actor.id ||
          context.session && wait.session_id !== context.session.id) {
        reject('wait_not_found', 'Wait is unavailable', 404);
      }
      return { ...wait, kind: 'wait' };
    }
    if (ref.kind === 'user' && ref.id === 'user' && String(args.path || '').trim() === 'host-profile.md') {
      return { ref, kind: 'host_profile', path: 'host-profile.md', ...readHostProfile(this.dataRoot) };
    }
    if (!this.canReadReference(ref, context)) reject('object_not_found', 'Object is unavailable', 404);
    switch (ref.kind) {
      case 'bot': {
        const bot = this.getBot(ref.id);
        const targetPath = args.path ?? args.directory;
        if (targetPath !== undefined) {
          const cleanTarget = validateBotRelPath(targetPath);
          if (!this.manager.canConfigure(context.actor, bot) && (cleanTarget === '.local' || cleanTarget.startsWith('.local/'))) {
            reject('file_forbidden', 'Cannot read another Bot’s private local files', 403);
          }
          return { ref, ...readBotFolderFile(this.dataRoot, bot.id, cleanTarget, { allowDirectory: true }) };
        }
        if (!this.visibleBot(bot, context)) return directoryEntry(bot);
        const view = this.manager.view(bot, context.actor, { details: !context.session });
        const memory_items = !context.session ? listBotMemoryItems(this.dataRoot, bot.id) : undefined;
        return memory_items !== undefined ? { ...view, memory_items } : view;
      }
      case 'engine': {
        if (args.path !== undefined) {
          return { ref, ...this.engines.readFile(ref.id, args.path) };
        }
        return this.engines.get(ref.id, { fresh: context.actor.kind === 'user' });
      }
      case 'capability': {
        if (args.path !== undefined) {
          return { ref, ...this.capabilities.readFile(ref.id, args.path) };
        }
        return this.capabilities.get(ref.id, { lookupBot: id => this.store.get(botRecords, id) });
      }
      case 'knowledge': {
        const targetPath = String(args.path || (ref.id !== 'shared' ? ref.id : '')).trim();
        if (!targetPath) {
          return { ref, kind: 'knowledge', id: 'shared', dir: this.knowledge.dir(), items: this.knowledge.list() };
        }
        return { ref, ...this.knowledge.read(targetPath) };
      }
      case 'room': return this.room.read(args, context.actor.id, { allowCrossRoomGroup: context.actor.kind === 'bot' });
      case 'event': {
        const event = this.store.get('platform-events', ref.id);
        return event ?? this.room.read(args, context.actor.id, { allowCrossRoomGroup: context.actor.kind === 'bot' });
      }
      case 'file': return this.files.readObject(ref.id, context, args.cursor, args.limit, args.revision);
      case 'workspace_file': return this.read({ ...args, ref: { kind: 'workspace', id: ref.workspace_id }, path: ref.path }, context);
      case 'session': case 'conversation': return this.executions.read(ref, context, args);
      case 'call': return this.calls.view(this.calls.get(ref.id), context);
      case 'wakeup': return this.deliveries.list(context).find(item => item.id === ref.id);
      case 'workspace': {
        if (args.directory !== undefined) return this.workspaceEntries(args, context);
        if (args.path === undefined) {
          const record = this.workspaceRecords().find(item => item.id === ref.id);
          if (record) return record;
          const ws = this.workspace(ref, context);
          return { id: ws.path, kind: 'workspace', name: basename(ws.path) || ws.path, path: ws.path, write: ws.write };
        }
        const workspace = this.projectFileAccess(ref, context);
        try {
          return await this.files.readWorkspace(args, workspace, this.projectFileDirectories(), () => {});
        } catch (error) {
          if (error.status !== 404) throw error;
          let listing;
          try { listing = await this.workspaceEntries({ ref, limit: 12 }, context); }
          catch (failure) {
            if (![403, 404].includes(failure.status) && !['ENOENT', 'EACCES', 'EPERM'].includes(failure.code)) throw failure;
          }
          error.details = { ...error.details, missing_path: args.path, workspace_entries: listing, room_originals: this.roomWork.readSources(context) };
          throw error;
        }
      }
      default: reject('object_not_found', 'Object is unavailable', 404);
    }
  }

  async stopBotExternalSessions(botId, actor = user) {
    const owned = this.store.list(sessionRecords).filter(session =>
      !session.sharing && !session.authority_revoked && this.isActiveSession(session) &&
      (session.execution_actor?.id === botId || session.owner?.id === botId));
    const stopped = [];
    for (const session of owned) {
      const target = { kind: 'session', id: session.id };
      const { record } = this.calls.begin('stop_session', { actor });
      try {
        const res = await this.executions.stop({ target, scope: 'target_and_owned_calls' }, { actor }, record);
        stopped.push({ target, ...res });
      } catch (error) {
        this.calls.fail(record.id, error);
      }
    }
    return stopped;
  }

  stripRemovedFromSharedSessions(roomId, removedIds) {
    const removedSet = new Set(removedIds);
    for (const session of this.store.list(sessionRecords)) {
      if (!session.sharing || session.space?.kind !== 'room' || session.space.id !== roomId) continue;
      const filterPrincipals = list => (list || []).filter(p => {
        if (!p || typeof p !== 'object') return false;
        if (p.kind === 'room_members') return true;
        return !removedSet.has(p.id);
      });
      const nextSharing = {
        readers: filterPrincipals(session.sharing.readers),
        submitters: filterPrincipals(session.sharing.submitters),
        controllers: filterPrincipals(session.sharing.controllers),
      };
      this.store.save(sessionRecords, { id: session.id, sharing: nextSharing });
    }
  }

  async archiveBot(id, revision, actor = user) {
    const bot = this.manager.archive(id, revision, actor, randomUUID());
    this.deliveries.purgePausedDeliveries(id);
    for (const room of this.store.list('rooms')) {
      if (!room.members.includes(id)) continue;
      this.store.save('rooms', { id: room.id, members: room.members.filter(m => m !== id), revision: room.revision + 1 });
      this.removeRoomBase(id, room.id);
      this.stripRemovedFromSharedSessions(room.id, [id]);
    }
    await this.runtime.stopBot(id);
    await this.stopBotExternalSessions(id, actor);
    this.manager.settleStop(id, bot.control.stop_id, 'stopped');
    const result = this.manager.view(this.getBot(id), actor);
    this.emit('bot', result);
    this.emit('room');
    return result;
  }

  async restoreBot(id, revision, actor = user) {
    const bot = this.manager.restore(id, revision, actor);
    this.deliveries.purgePausedDeliveries(id);
    await this.runtime.alignBotOnEnable(id);
    const result = this.manager.view(bot, actor);
    this.emit('bot', result);
    this.runtime.wake();
    return result;
  }

  async deleteBot(id, revision, actor = user) {
    const before = this.manager.assertRemovable(id, revision, actor);
    await this.runtime.stopBot(id);
    await this.stopBotExternalSessions(id, actor);
    for (const room of this.store.list('rooms')) {
      if (!room.members.includes(id)) continue;
      this.store.save('rooms', { id: room.id, members: room.members.filter(m => m !== id), revision: room.revision + 1 });
      this.removeRoomBase(id, room.id);
      this.stripRemovedFromSharedSessions(room.id, [id]);
    }
    this.deliveries.removeAllForBot(id);
    const result = this.manager.remove(id, before.revision, actor);
    await this.runtime.disposeBot(id);
    this.emit('bot');
    this.emit('room');
    return result;
  }

  async archiveRoom(roomId, revision, actor = user) {
    const result = this.room.archiveRoom(roomId, revision, actor);
    this.deliveries.purgeArchivedRoomDeliveries(result.id);
    await this.stopRoom(result.id, actor);
    this.emit('room', result);
    return result;
  }

  async restoreRoom(roomId, revision, actor = user) {
    const result = this.room.restoreRoom(roomId, revision, actor);
    this.emit('room', result);
    return result;
  }

  async stopRoom(roomId, actor = user) {
    const room = this.room.room(roomId, actor.id);
    const conversations = this.store.list('platform-conversations').filter(c => c.space?.kind === 'room' && c.space.id === room.id);
    const sessions = this.store.list(sessionRecords).filter(s =>
      !s.authority_revoked && this.isActiveSession(s) &&
      (s.origin_room?.id === room.id || (s.space?.kind === 'room' && s.space.id === room.id)));
    const convResults = [];
    for (const conv of conversations) {
      const target = { kind: 'conversation', id: conv.id };
      const { record } = this.calls.begin('stop_session', { actor });
      try {
        const res = await this.executions.stop({ target, scope: 'target_and_owned_calls' }, { actor }, record);
        convResults.push({ bot_id: conv.bot_id, conversation_id: conv.id, ...res });
      } catch (error) {
        this.calls.fail(record.id, error);
      }
    }
    const covered = new Set(convResults.flatMap(r => (r.targets || []).map(t => keyOf(t.target.kind, t.target.id))));
    const sessionResults = [];
    for (const session of sessions) {
      const target = { kind: 'session', id: session.id };
      if (covered.has(keyOf(target.kind, target.id))) continue;
      const { record } = this.calls.begin('stop_session', { actor });
      try {
        const res = await this.executions.stop({ target, scope: 'target_and_owned_calls' }, { actor }, record);
        sessionResults.push({ session_id: session.id, engine: session.engine, ...res });
      } catch (error) {
        this.calls.fail(record.id, error);
      }
    }
    this.goals.stop(room.id, actor);
    this.emit('execution');
    return {
      room_id: room.id,
      conversations: convResults,
      sessions: sessionResults,
    };
  }

  retryExecution({ target, run_id }, actor = user) {
    const ref = target?.kind ? target : { kind: 'conversation', id: idOf(target, 'conversation') };
    const record = this.executions.require(ref, { actor }, 'control');
    const conversationId = ref.kind === 'conversation' ? record.id : (record.conversation_id || record.id);
    const retried = this.runtime.retrySuspended(conversationId, run_id);
    if (!retried) reject('run_not_suspended', 'No suspended run found to retry', 409);
    this.emit('execution');
    return retried;
  }

  async settleBot(id, control) {
    const task = (async () => {
      let status;
      try {
        status = (await this.runtime.stopBot(id)).status;
        await this.stopBotExternalSessions(id, control.requested_by || user);
        this.deliveries.purgePausedDeliveries(id);
      } catch { status = 'unknown'; }
      this.manager.settleStop(id, control.stop_id, status === 'stopped' ? 'stopped' : 'unknown');
      this.emit('bot');
    })();
    this.botStops ??= new Set();
    this.botStops.add(task);
    try { await task; }
    catch (error) { console.error(`Summon Bot stop state could not be saved (${error.code || error.name})`); }
    finally { this.botStops.delete(task); }
  }

  sessionDependsOn(session, ref) {
    const resources = session.resource_refs ?? [];
    if (ref.kind === 'bot') return sameIdentity(session.execution_actor, ref) &&
      (ref.model_ids.includes(session.model_binding?.connection_id ?? session.model?.connection_id) ||
        ref.workspace_ids.includes(session.workspace_ref?.id) ||
        resources.some(item => item.kind === 'workspace' && ref.workspace_ids.includes(item.id)));
    if (ref.kind === 'model') return session.model_binding?.connection_id === ref.id || session.model?.connection_id === ref.id;
    if (ref.kind === 'workspace') return sameRef(session.workspace_ref, ref) || resources.some(item => sameRef(item, ref));
    if (ref.kind !== 'room') return false;
    if (sameRef(session.space, ref) || sameRef(session.project_room, ref) || (!session.sharing && sameRef(session.origin_room, ref))) return true;
    return resources.some(item => {
      if (item.kind === 'file') {
        const file = this.files.get(item.id);
        return file ? sameRef(file.space, ref) : this.room.attachmentRooms(item.id).some(room => room.id === ref.id);
      }
      if (item.kind !== 'event') return false;
      const event = this.store.get('platform-events', item.id) ?? this.store.get('messages', item.id);
      const target = event?.target;
      return sameRef(event?.space, ref) || event?.roomId === ref.id ||
        ['session', 'conversation'].includes(target?.kind) && sameRef(this.executions.record(target)?.space, ref);
    });
  }

  async revokeSessions(affected) {
    const releases = [];
    for (const session of this.store.list(sessionRecords)) {
      if (session.authority_revoked) continue;
      try {
        if (!this.sessionDependsOn(session, affected)) continue;
        this.assertSessionAuthority(session);
      } catch (error) {
        if (!revokedAuthority.has(error.code)) {
          this.emit('execution.authority_unavailable', { session_id: session.id });
          continue;
        }
        const active = this.isActiveSession(session);
        const call = this.store.transaction(() => {
          const record = active ? this.calls.begin('revoke_session', { actor: user }).record : null;
          this.store.save(sessionRecords, { id: session.id, authority_revoked: true, revocation_call_id: record?.id ?? null,
            revocation_stop: active ? 'pending' : null });
          if (record) this.calls.bind(record.id, { target: { kind: 'session', id: session.id }, status: 'submitted', execution_actor: session.execution_actor });
          return record;
        });
        if (call) {
          releases.push(this.stopRevoked(session, call));
          if (session.owner_conversation_id && session.owner?.kind === 'bot') {
            const ownerBot = this.store.get(botRecords, session.owner.id);
            if (ownerBot?.enabled && !ownerBot.archivedAt) {
              const event = {
                id: keyOf('execution.revoked', session.id, call.id),
                kind: 'event',
                type: 'execution.revoked',
                author: { kind: 'platform', id: 'platform' },
                bot_id: ownerBot.id,
                space: session.origin_room || { kind: 'bot', id: ownerBot.id },
                ref: { kind: 'conversation', id: session.owner_conversation_id },
                target: { kind: 'session', id: session.id },
                session_id: session.id,
                origin_room: session.origin_room || null,
                origin_message_id: session.origin_message_id || null,
                reason: error.code || 'session_authority_revoked',
                affected,
                time: new Date().toISOString(),
              };
              this.deliveries.queueEvent(event, [], false);
              this.deliveries.enqueue(ownerBot.id, event, [{ id: keyOf('revoke_notice', session.id), revision: 1, kind: 'execution_revoked' }], []);
            }
          }
        }
      }
    }
    await Promise.all(releases);
  }

  async stopRevoked(session, call) {
    let outcome;
    try {
      outcome = await (session.engine === 'pi' ? this.runtime.pi.stop({ session, call }) : this.exec.stop({ session, call }));
    } catch { outcome = { status: 'unknown' }; }
    const terminalStatuses = new Set(['completed', 'failed', 'stopped', 'cancelled', 'not_submitted']);
    let latestCallId = null;
    let shouldEmitStoppedReceipt = false;
    this.store.transaction(() => {
      const current = this.store.get(sessionRecords, session.id);
      if (current) {
        const patch = {};
        if (current.revocation_stop !== 'stopped') patch.revocation_stop = outcome.status;
        if (outcome.status === 'stopped' && current.status !== 'stopped') {
          patch.status = 'stopped';
          patch.safe_to_disconnect = true;
          patch.updated_at = new Date().toISOString();
        }
        if (Object.keys(patch).length) this.store.save(sessionRecords, { id: session.id, ...patch });
        latestCallId = current.latest_call_id || null;
        if (outcome.status === 'stopped' && latestCallId) {
          const latestCall = this.store.get('platform-calls', latestCallId);
          if (latestCall && !terminalStatuses.has(latestCall.status)) shouldEmitStoppedReceipt = true;
        }
      }
      this.calls.finish(call.id, 'completed', outcome);
    });
    if (shouldEmitStoppedReceipt && latestCallId) {
      try {
        this.executions.receipt(session.id, latestCallId, {
          status: 'stopped',
          position: keyOf('revoke_stop', call.id),
          safe_to_disconnect: true,
          ...(outcome.partial_snapshot ? { output: { text: outcome.partial_snapshot } } : {}),
        });
      } catch {}
    }
  }

  deliverResultToHost({ reason, session, callId, status, receipt }) {
    const terminalFallbackStates = new Set(['completed', 'failed', 'stopped', 'cancelled', 'not_submitted']);
    if (!session || !terminalFallbackStates.has(status)) return null;
    const latest = this.store.get(sessionRecords, session.id) || session;
    if (latest.host_fallback_delivered_at) return null;
    try {
      const originRoomId = latest.origin_room?.id || null;
      const originRoom = originRoomId ? this.store.get('rooms', originRoomId) : null;
      const ownerBot = latest.owner?.id ? this.store.get(botRecords, latest.owner.id) : null;
      const eggbot = this.listBots().find(bot => bot.built_in_role?.id === 'eggbot' && !bot.archivedAt);
      const senderBot = (ownerBot && !ownerBot.archivedAt) ? ownerBot : (eggbot || this.listBots().find(bot => !bot.archivedAt));
      if (!senderBot) return null;

      let direct = this.store.list('rooms').find(r =>
        r.mode === 'direct' && r.members.length === 2 && r.members.includes('user') && r.members.includes(senderBot.id));
      if (!direct) {
        direct = this.room.createRoom({ mode: 'direct', members: ['user', senderBot.id], title: senderBot.name }, 'user');
      }
      const reasonText = reason === 'origin_room_deleted' ? '原群已删除'
        : reason === 'owner_bot_paused' ? '原执行成员已暂停'
        : reason === 'owner_run_suspended' ? '原群主对话挂起未恢复'
        : '原群当前不可达';
      const summary = status === 'stopped'
        ? (latest.authority_revoked ? `因${reasonText}触发权限中止，任务已停止` : '任务已中止')
        : status === 'failed'
          ? (latest.last_error?.message || '任务执行失败，详见关联调用与事件记录')
          : '任务已结束，详见关联调用与事件记录';
      const lines = [
        `【原群成果转交】${reasonText}，已将后台任务终态结果同步至本私聊：`,
        `- 任务摘要：${latest.work_summary || latest.id}`,
        `- 执行状态：${status}`,
        `- 结果摘要：${summary}`,
        ...(originRoomId ? [`- 来源群：${originRoom?.name || originRoomId}（原消息：${latest.origin_message_id || '无'}）`] : []),
        `- 调用 / 会话：session ${latest.id} / call ${callId}`,
      ];
      const refs = [
        { kind: 'session', id: latest.id },
        ...(callId ? [{ kind: 'call', id: callId }] : []),
        ...(receipt?.kind && receipt?.id ? [receipt] : []),
      ].filter(ref => this.canReadReference(ref, { actor: user }));
      const sent = this.room.send(direct.id, { text: lines.join('\n'), references: refs }, senderBot.id, { callId: keyOf('host_fallback', latest.id, callId) });
      this.store.save(sessionRecords, {
        id: latest.id,
        host_fallback_delivered_at: new Date().toISOString(),
        host_fallback_reason: reason,
        host_fallback_room_id: direct.id,
        host_fallback_message_id: sent?.message?.id || null,
      });
      this.emit('execution');
      return sent;
    } catch {
      return null;
    }
  }

  naturalFallbackBot(room) {
    const members = (room?.members || []).filter(id => id !== 'user');
    const available = members
      .map(id => this.store.get(botRecords, id))
      .filter(bot => bot && bot.enabled && !bot.archivedAt && !bot.connection_initializer &&
        this.canUseModel({ kind: 'bot', id: bot.id }, this.botModelConnectionId(bot)));
    if (!available.length) return null;
    return (room?.lead_bot_id && available.find(bot => bot.id === room.lead_bot_id))
      || available.find(bot => bot.built_in_role?.id === groupLeadRole)
      || available.find(bot => bot.built_in_role?.id === 'eggbot')
      || available[0];
  }

  roomMessageStatus(roomId, message) {
    if (!message || message.senderId !== 'user') return null;
    const room = this.store.get('rooms', roomId);
    if (!room) return null;
    const deliveries = this.deliveries.deliveriesFor(message.id);
    const replies = this.room.repliesTo(roomId, message.id).filter(item => item.senderId !== 'user');
    const relatedSessions = this.store.list(sessionRecords).filter(session =>
      session.origin_room?.id === roomId && session.origin_message_id === message.id);
    const hasActiveSession = relatedSessions.some(session => !session.authority_revoked && this.isActiveSession(session));
    const hostFallback = relatedSessions.find(session => session.host_fallback_delivered_at) || null;
    const runtimeActivity = this.runtime?.messageActivity?.(roomId, message.id) || { inFlight: false, suspended: false };
    const deliveryInFlight = deliveries.some(item => ['pending', 'unknown', 'received'].includes(item.status));
    const inFlight = deliveryInFlight || runtimeActivity.inFlight || hasActiveSession;
    const fallbackRecord = this.store.get('unanswered-fallbacks', message.id);

    let state = 'in_flight';
    let unavailableReason = null;
    if (replies.length && !hasActiveSession) {
      state = 'answered';
    } else if (inFlight) {
      state = 'in_flight';
    } else if (replies.length) {
      state = 'answered';
    } else {
      state = 'unanswered';
      if (message.mentions?.length) {
        const mentionedBots = message.mentions.filter(id => id !== 'user').map(id => this.store.get(botRecords, id));
        const paused = mentionedBots.find(bot => !bot || !bot.enabled || bot.archivedAt);
        if (paused) unavailableReason = `被点名成员 ${paused.name || 'Bot'} 当前已暂停或不可用`;
        else if (runtimeActivity.suspended) unavailableReason = '被点名成员暂时无法回复';
      } else if (!this.naturalFallbackBot(room)) {
        unavailableReason = '当前群内无可用成员（均已暂停或缺少可用模型绑定）';
      } else if (fallbackRecord) {
        unavailableReason = runtimeActivity.suspended ? '兜底成员暂时无法回复，可另行点名' : '已由统筹成员检视但未公开发言，可点击点名指定成员';
      }
    }

    return {
      message_id: message.id,
      state,
      in_flight: inFlight,
      reply_count: replies.length,
      active_sessions: relatedSessions.filter(s => !s.authority_revoked && this.isActiveSession(s)).length,
      fallback_attempted: Boolean(fallbackRecord),
      fallback_bot_id: fallbackRecord?.bot_id || null,
      ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
      ...(hostFallback ? {
        host_fallback_delivered: true,
        host_fallback_room_id: hostFallback.host_fallback_room_id,
        host_fallback_message_id: hostFallback.host_fallback_message_id,
      } : {}),
    };
  }

  checkUnansweredFallbacks() {
    if (this.draining || !this.runtime) return;
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const room of this.store.list('rooms')) {
      if (room.mode !== 'group' || room.archivedAt) continue;
      const recent = this.room.latestMessage.get(room.id);
      if (!recent) continue;
      const latest = JSON.parse(recent.data);
      const createdMs = Date.parse(latest.createdAt || 0);
      if (latest.senderId !== 'user' || createdMs < cutoff || latest.mentions?.length) continue;
      if (this.store.get('unanswered-fallbacks', latest.id)) continue;
      const msg = this.room.projectMessage(recent);
      const status = this.roomMessageStatus(room.id, msg);
      if (!status || status.state !== 'unanswered') continue;
      const fallbackBot = this.naturalFallbackBot(room);
      if (!fallbackBot) continue;
      this.store.save('unanswered-fallbacks', {
        id: latest.id,
        room_id: room.id,
        bot_id: fallbackBot.id,
        created_at: new Date().toISOString(),
      });
      const event = {
        ...this.room.messageEventFor(msg),
        fallback_reason: 'unanswered_by_team',
        fallback_guidance: 'All specialist members stayed quiet for this user message (possible duty gap). Respond directly to the user so the group is not left unanswered, and if the team lacks an appropriate duty/specialist, propose or create/invite one.',
      };
      this.deliveries.enqueue(fallbackBot.id, event, [{ id: keyOf('unanswered_fallback', latest.id), revision: 1, kind: 'unanswered_fallback' }], []);
      this.emit('room');
    }
  }

  async tick({ observations = true, deliveries = true } = {}) {
    this.selfUpdate?.onTick();
    if (!this.draining && observations) {
      this.deliveries.tickTime();
      this.checkUnansweredFallbacks();
      this.goals.tick();
    }
    if (deliveries) await this.deliveries.flush(this.runtime);
  }

  recoverCalls() {
    this.store.transaction(() => {
      for (const call of this.store.list('platform-calls')) {
        if (call.tool === 'stop_session' && call.status === 'submitted') {
          if (call.result?.targets) this.calls.finish(call.id, 'completed', call.result);
          continue;
        }
        if (call.status !== 'prepared' || call.tool === 'upload_attachment') continue;
        const bot = call.tool === 'create_bot' && this.store.get(botRecords, `bot-${call.id}`);
        if (bot) {
          this.calls.bind(call.id, { target: { kind: 'bot', id: bot.id } });
          this.calls.finish(call.id, 'completed', this.manager.view(bot, call.submitted_by));
        } else this.calls.finish(call.id, 'not_submitted', { status: 'not_submitted' });
      }
      for (const session of this.store.list(sessionRecords)) {
        const call = this.store.get('platform-calls', session.latest_call_id);
        if (session.status === 'opening' && call?.status === 'not_submitted') this.store.save(sessionRecords, { id: session.id, status: 'not_submitted' });
        if (session.control?.stop_status === 'pending') {
          this.store.save(sessionRecords, { id: session.id, control: { ...session.control, state: 'active', stop_status: 'stopped' } });
        }
      }
      for (const conv of this.store.list('platform-conversations')) {
        if (conv.control?.stop_status === 'pending' || conv.control?.state === 'paused') {
          this.store.save(conversationRecords, { id: conv.id, control: { ...conv.control, state: 'active', stop_status: 'stopped' } });
        }
      }
      for (const bot of this.store.list(botRecords)) {
        if (bot.built_in_role?.id && !roleIds.includes(bot.built_in_role.id)) {
          this.store.save(botRecords, { id: bot.id, built_in_role: null });
        }
      }
    });
    for (const bot of this.manager.list()) {
      if (bot.control.state === 'paused' && bot.control.stop_status === 'pending') this.manager.settleStop(bot.id, bot.control.stop_id, 'stopped');
    }
    this.exec?.recoverInterrupted?.();
    this.deliveries.purgePausedDeliveries();
  }
}
