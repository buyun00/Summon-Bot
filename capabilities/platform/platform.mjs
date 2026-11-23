import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { bindModel } from '../../bot/src/agent/model.mjs';
import { catalogMaintainerRole, roleIds, toolOnboardingRole } from '../../roles/index.mjs';
import { BotManager, activeControl, botRecords, directoryEntry } from '../bot-management/service.mjs';
import { ConnectionInitializer } from '../connectors/initialization.mjs';
import { executionEnvironment } from '../connectors/onboarding.mjs';
import { normalizeOnboardingAccess, targetAllows } from '../connectors/onboarding-access.mjs';
import { Files } from '../filesystem/files.mjs';
import { Calls, isWaitOrigin, waitRecords } from './calls.mjs';
import { ConnectionRepairs } from './connection-repairs.mjs';
import { ConnectionUsage } from './connection-usage.mjs';
import { assertRevision, connectionSetupTool, idOf, identity, keyOf, page, readTools, reject, repairRequestType, sameIdentity, sameRef, user, validateTool } from './contract.mjs';
import { Deliveries, wakeupRecords } from './delivery.mjs';
import { Executions, conversationRecords, sessionRecords } from './executions.mjs';
import { HostResources } from './resources.mjs';
import { RoomWork } from './room-work.mjs';
import { workspaceGranted } from './workspace-access.mjs';
import { allowsConnection, enclosesExecutableScope, executableScope } from '../services/executable-scope.mjs';
import { localExecutable } from '../services/native-host.mjs';
import { connectionStartupFailures } from '../services/session-processes.mjs';
import { httpMethods, protocolOf } from '../services/connection-binding.mjs';
import { connectionAllowed } from '../services/connection-records.mjs';

const normalize = (value, kind) => typeof value === 'string' ? { kind, id: value } : value;
const revokedAuthority = new Set(['session_authority_revoked', 'workspace_changed', 'connection_binding_changed', 'model_binding_changed']);
const inactiveSessions = new Set(['completed', 'failed', 'stopped', 'unsupported', 'cancelled', 'not_submitted', 'idle']);
const setupBotTools = new Set(['create_bot', 'configure_bot', 'set_wakeup']);
const setupResponse = (result, call) => ({ ...result, call_id: call.id, ...(call.target ? { target: call.target, execution_ref: call.target } : {}) });
const inside = (root, path) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};

export class SummonPlatform {
  constructor({ store, dataRoot, releaseRoot, models, attachments, workspaces = [], emit = () => {} }) {
    Object.assign(this, { store, dataRoot, releaseRoot, models, attachments, emit });
    this.draining = false;
    this.resources = new HostResources(store);
    this.manager = new BotManager({ store, dataRoot, models,
      canUseModel: (actor, id) => this.canUseModel(actor, id),
      maintenanceConnection: (id, context, revision, reuse) => this.maintenanceConnection(id, context, revision, reuse),
      bindMaintenance: (connection, bot) => this.bindMaintainer(connection, bot.id) });
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
        if (target.kind === 'connection') return this.connections?.get(target.id)?.maintainer_bot_id ?? null;
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
    this.repairs = new ConnectionRepairs(this);
    this.connectionUsage = new ConnectionUsage(this);
    this.roomWork = new RoomWork(this);
    this.workspaces = workspaces;
  }

  attach({ room, runtime, connections }) {
    Object.assign(this, { room, runtime, connections });
    this.connectionInitializer = new ConnectionInitializer(this);
    this.files = new Files({ store: this.store, room, attachments: this.attachments,
      canReadSpace: (actor, space, context) => this.canReadSpace(actor, space, context),
      canWriteSpace: (actor, space, context) => this.canWriteSpace(actor, space, context),
      canReadReference: (ref, context) => this.canReadReference(ref, context),
      assertShareable: (ref, options) => this.assertShareable(ref, options), notify: event => this.deliveries.queueEvent(event) });
  }

  initializeDefaults() {
    const { changed } = this.store.transaction(() => this.manager.ensureDefaults());
    this.room.ensureMaintenanceRoom(this.manager.onboardingBot());
    this.store.transaction(() => this.deliveries.syncObserverMemberships());
    if (changed) this.emit('bot');
  }

  getBot(id) { return this.manager.get(id); }
  listBots() { return this.manager.list().filter(bot => !bot.connection_initializer); }
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

  canUseConnection(actor, id, context = {}) {
    if (id === 'pi') return true;
    const entry = this.store.get('platform-connections', id);
    return connectionAllowed(entry, actor) && allowsConnection(context.executable_scope, entry, id => this.connections.get(id));
  }

  isOnboardingBot(actor) {
    return actor?.kind === 'bot' && this.store.get(botRecords, actor.id)?.built_in_role?.id === toolOnboardingRole;
  }

  isMaintainerOf(entry, actor) {
    return actor?.kind === 'bot' && Boolean(entry?.maintainer_bot_id && entry.maintainer_bot_id === actor.id);
  }

  maintenanceConnection(value, context, revision, reuse = false) {
    const id = idOf(value, 'connection');
    const entry = this.connections.get(id);
    if (!entry || !this.canUseConnection(context.actor, id, context))
      reject('connection_forbidden', 'Choose an execution connection in your grants', 403);
    if (context.actor.kind !== 'user' && !this.isOnboardingBot(context.actor)) {
      const setup = this.requireConnectionSetup(context, { action: 'assign_maintainer', connection: id });
      const allowed = setup.hostSetup && this.connectionInitializer.setupOwns(entry, context, setup);
      if (!allowed) {
        if (!setup.policy?.assign_maintainer || !targetAllows(setup.policy, entry))
          reject('maintainer_assignment_forbidden', 'The host must authorize maintainer assignment for this binding', 403);
        if (!(reuse && this.manager.maintainer(entry))) assertRevision(entry.revision, revision);
      }
    }
    if (revision !== undefined && !(reuse && this.manager.maintainer(entry))) assertRevision(entry.revision, revision);
    return entry;
  }

  grantMaintainerWorkspace(entry, botId) {
    if (!entry?.config?.workspace_root) return;
    const match = this.workspaceRecords().find(item => {
      try { return inside(this.authorizedDirectory(item.path), this.authorizedDirectory(entry.config.workspace_root)); }
      catch { return false; }
    });
    if (!match) return;
    const access = this.store.get('platform-access', botId) || { id: botId, revision: 0, model_ids: [], workspace_ids: [] };
    if (!access.workspace_ids?.includes(match.id)) {
      this.store.save('platform-access', {
        id: botId, revision: (access.revision ?? 0) + 1,
        model_ids: access.model_ids || [],
        workspace_ids: [...new Set([...(access.workspace_ids || []), match.id])],
        ...(access.execution_onboarding ? { execution_onboarding: access.execution_onboarding } : {}),
      });
    }
  }

  bindMaintainer(entry, botId) {
    this.grantMaintainerWorkspace(entry, botId);
    if (entry.maintainer_bot_id === botId && entry.repair_bot_ids === undefined) return entry;
    const next = { ...entry, maintainer_bot_id: botId, revision: entry.revision + 1 };
    delete next.repair_bot_ids;
    return this.store.save('platform-connections', next);
  }

  assignMaintainer(args, context, call) {
    const bot = this.getBot(idOf(args.bot, 'bot'));
    if (bot.connection_initializer || bot.archivedAt)
      reject('bot_not_found', 'Choose an existing Bot', 404);
    const result = this.store.transaction(() => {
      const entry = this.maintenanceConnection(args.connection, context, args.revision);
      assertRevision(entry.revision, args.revision);
      const saved = this.bindMaintainer(entry, bot.id);
      this.calls.bind(call.id, { target: { kind: 'connection', id: saved.id } });
      return this.calls.finish(call.id, 'completed', { ...this.connections.summary(saved), ...this.connectionMaintenance(saved, context) });
    });
    this.emit('connection');
    return result;
  }

  repairableConnection(entry, context) {
    if (!entry || !this.canUseConnection(context.actor, entry.id, context) ||
        !this.connections.authorized(entry, context.actor)) return false;
    if (context.actor.kind === 'user' || this.isOnboardingBot(context.actor) || this.isMaintainerOf(entry, context.actor)) return true;
    if (entry.config.initialized_for !== context.actor.id) return false;
    const submitter = identity(context.submitted_by ?? context.actor);
    return sameIdentity(submitter, context.actor) || this.canUseConnection(submitter, entry.id) &&
      this.connections.authorized(entry, submitter);
  }

  probeRepairAllowed(entry, context) {
    if (this.repairableConnection(entry, context)) return true;
    const policy = this.accessFor(context.actor)?.execution_onboarding;
    const submitter = { actor: identity(context.submitted_by ?? context.actor) };
    return Boolean(entry && policy?.submit && targetAllows(policy, entry) &&
      this.canUseConnection(context.actor, entry.id, context) && this.connections.authorized(entry, context.actor) &&
      this.canUseConnection(submitter.actor, entry.id, submitter) && this.connections.authorized(entry, submitter.actor));
  }

  connectionMaintenance(entry, context) {
    if (!entry) return {};
    const bot = this.manager.maintainer(entry);
    const grants = input => {
      const can_use = this.canUseConnection(input.actor, entry.id, input) && this.connections.authorized(entry, input.actor);
      return { can_use, can_repair: this.probeRepairAllowed(entry, input) };
    };
    const permissions = context ? grants(context) : {};
    if (!bot) return { ...permissions, maintainer: null };
    const actor = { kind: 'bot', id: bot.id };
    const blocker = this.repairBlocker(entry, bot, { actor });
    let workspace_ready = true;
    if (entry.config.workspace_root) {
      try { workspace_ready = Boolean(this.workspace(entry.config.workspace_root, { actor })?.write && entry.config.workspace_write !== false); }
      catch { workspace_ready = false; }
    }
    return { ...permissions, maintainer: { ...actor, name: bot.name, enabled: bot.enabled, ...grants({ actor }), workspace_ready,
      run_status: blocker ? { status: 'blocked', ...blocker } : { status: 'configured' } } };
  }

  noteConnectionFailure(source, call, { status, code, input_status }) {
    if (!source || !['failed', 'not_submitted'].includes(status) || !connectionStartupFailures.includes(code) ||
        input_status !== undefined || !['open_session', 'send_input'].includes(call.tool) || call.connection_failure_event_id) return;
    const session = this.store.get(sessionRecords, source.id);
    if (!session || session.authority_revoked || session.control?.state !== 'active') return;
    const connection = this.connections.get(session.connection_id ?? session.engine);
    if (!connection || !this.connections.authorized(connection, session.execution_actor)) return;
    const binding_version = connection.binding_version ?? 1;
    if (session.connection_binding_version !== binding_version) return;
    const ref = { kind: 'connection', id: connection.id };
    const id = randomUUID();
    this.calls.bind(call.id, { connection_failure_event_id: id });
    const event = { id, kind: 'event', type: 'connection.failure', target: ref, ref, status, code, binding_version,
      protocol: connection.kind, author: { kind: 'platform', id: 'platform' }, time: new Date().toISOString() };
    const matched = this.deliveries.queueEvent(event, [], true, session.execution_actor?.id);
    if (!matched) {
      const recipient = this.probeMaintainer(connection);
      if (recipient?.enabled && !recipient.archivedAt && recipient.id !== session.execution_actor?.id) {
        this.deliveries.enqueue(recipient.id, { ...event, bot_id: recipient.id, space: { kind: 'bot', id: recipient.id } },
          [{ id: keyOf('connection_failure_fallback', connection.id), revision: 1, kind: 'connection_failure_fallback' }], []);
      }
    }
  }

  probeMaintainer(entry) {
    return this.manager.maintainer(entry) ?? this.manager.onboardingBot();
  }

  repairBlocker(entry, recipient, context = { actor: { kind: 'bot', id: recipient.id } }) {
    if (!recipient.enabled) return { code: 'bot_paused', message: 'The assigned repair Bot is paused' };
    if (!this.repairs.canUse(entry, context))
      return { code: 'connection_use_required', message: 'The assigned repair Bot needs use access to the connection and its dependencies' };
    if (!this.probeRepairAllowed(entry, context))
      return { code: 'connection_repair_required', message: 'The assigned repair Bot needs repair authority for this connection' };
    if (entry.config.workspace_root) {
      try {
        if (!this.workspace(entry.config.workspace_root, context)?.write || entry.config.workspace_write === false)
          return { code: 'workspace_forbidden', message: 'The assigned repair Bot needs writable process access to the bound working directory' };
      } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
        return { code: error.code, message: error.message };
      }
    }
    return this.modelAccessBlocker(context.actor, this.botModelConnectionId(recipient));
  }

  resolveProbeFailure(connectionId) {
    const event = this.deliveries.openProbeFailure(connectionId);
    if (!event) return;
    this.store.save('platform-events', { id: event.id, resolved_at: new Date().toISOString() });
    if (this.repairs.hasReports(event.id)) return;
    for (const delivery of this.deliveries.deliveriesFor(event.id)) {
      if (delivery.status === 'pending')
        this.deliveries.updateDelivery(delivery.id, delivery.revision ?? 1, { status: 'cancelled', code: 'probe_resolved' });
    }
  }

  noteProbeFailure(entry, context, observed) {
    const self = this.getBot(context.actor.id);
    const recipient = this.probeMaintainer(entry);
    if ((self.built_in_role?.id === toolOnboardingRole || recipient?.id === self.id) && this.probeRepairAllowed(entry, context))
      return { status: 'self', bot: context.actor };
    const blocked = (code, reason, bot) => ({ status: 'blocked', code, reason, ...(bot ? { bot } : {}) });
    if (!recipient) return blocked('probe_maintainer_required', 'Select a repair Bot');
    const bot = { kind: 'bot', id: recipient.id };
    const blocker = this.repairBlocker(entry, recipient, sameIdentity(bot, context.actor) ? context : { actor: bot });
    if (blocker) return blocked(blocker.code, blocker.message, bot);

    const binding_version = entry.binding_version ?? 1;
    const open = this.deliveries.openProbeFailure(entry.id);
    if (open?.bot_id === bot.id && open.binding_version === binding_version)
      return { status: 'already_requested', bot, event: { kind: 'event', id: open.id } };
    if (open) this.resolveProbeFailure(entry.id);
    const ref = { kind: 'connection', id: entry.id };
    const id = randomUUID();
    const event = { id, kind: 'event', type: 'connection.failure', code: 'probe_rule_mismatch', bot_id: bot.id,
      target: ref, ref, space: bot, binding_version, connection_revision: entry.revision,
      author: { kind: 'platform', id: 'platform' }, time: new Date().toISOString(),
      probe: this.connections.clean({ source: observed.probe_source, cwd: observed.cwd, issues: observed.issues,
        observations: observed.observations.filter(item => ['version', 'help'].includes(item.purpose)) }) };
    this.deliveries.queueEvent(event, [], false);
    this.deliveries.enqueue(bot.id, event, [{ id, revision: 1, kind: 'probe_rule_mismatch' }], []);
    return { status: 'requested', bot, event: { kind: 'event', id } };
  }

  visibleBot(bot, context) {
    if (!bot || bot.connection_initializer) return false;
    if (context.actor.kind === 'user') return true;
    return !bot.archivedAt;
  }

  canFindTeam(context) {
    return context.actor.kind === 'user' || context.actor.kind === 'bot';
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
    if (call?.repair_request_id && !this.repairs.canReadResult(call, context)) return false;
    if (!context.origin) return true;
    const wait = call?.return_refs.map(id => this.store.get(waitRecords, id)).find(item => item?.input_call_id && item.bot_id === context.actor.id &&
      isWaitOrigin(item, context.origin));
    return !wait || this.canReadReturnWait(wait, target);
  }

  canReadEvent(event, context) {
    if (event.result_access === 'revoked') return false;
    if (event.type === 'work.tool') return this.roomWork.readable(event, context);
    if (event.type === repairRequestType) return this.repairs.canRead(event, context);
    if (event.type === 'connection.failure') {
      if (this.repairs.hasReports(event.id)) return this.repairs.canRead(event, context);
      const connection = event.ref?.kind === 'connection' && this.connections.get(event.ref.id);
      const readable = connection && event.binding_version === (connection.binding_version ?? 1) &&
        this.canReadReference(event.ref, context);
      if (!readable) return false;
      if (event.code !== 'probe_rule_mismatch' || context.actor.kind === 'user') return true;
      const recipient = this.probeMaintainer(connection);
      return recipient?.enabled && event.bot_id === context.actor.id && recipient.id === event.bot_id &&
        this.probeRepairAllowed(connection, context);
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
        !call?.repair_request_id && this.store.list('platform-wakeups').some(rule =>
          rule.bot_id === context.actor.id && this.deliveries.matches(rule, event));
      return watching && this.canReadCallResult(call, event.target, context);
    }
    if (event.bot_id && event.bot_id !== context.actor.id && context.actor.kind !== 'user') return false;
    const resource = context.resource_refs?.some(ref => sameRef(ref, { kind: 'event', id: event.id }));
    return this.canReadSpace(context.actor, event.space || { kind: 'room', id: event.roomId }, resource ? {} : context);
  }

  canReadReference(ref, context) {
    if (!ref?.id) return false;
    const { actor } = context;
    switch (ref.kind) {
      case 'room': case 'user': return this.canReadSpace(actor, ref, context);
      case 'bot': {
        const record = this.store.get(botRecords, ref.id);
        return Boolean(record && (this.visibleBot(record, context) ||
          !record.archivedAt && !record.connection_initializer && this.canFindTeam(context)));
      }
      case 'event': {
        const event = this.store.get('platform-events', ref.id) ?? this.store.get('messages', ref.id);
        return Boolean(event && this.canReadEvent(event, context));
      }
      case 'file': return this.files.canRead(ref.id, context);
      case 'session': case 'conversation': return this.executions.permission(ref, this.executions.record(ref), context);
      case 'call': {
        const call = this.store.get('platform-calls', ref.id);
        return Boolean(call && this.calls.canRead(actor, call, context));
      }
      case 'connection': return this.canUseConnection(actor, ref.id, context);
      case 'workspace': return this.workspaceAvailable(ref.id, actor, context);
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
    const event = ref.kind === 'event' ? this.store.get('messages', ref.id) ?? this.store.get('platform-events', ref.id) : null;
    if (event) return event;
    if (file) return this.files.view(file);
    if (!this.canReadReference(ref, caller)) {
      return this.attachments.find(ref.id) || ref;
    }
    return this.attachments.find(ref.id) || ref;
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
    if (principal.kind !== 'user') reject('workspace_forbidden', 'The host manages project directory sharing', 403);
    if (!id) return null;
    const workspace = this.workspace({ kind: 'workspace', id }, { actor: principal });
    if (!workspace.write) reject('workspace_forbidden', 'Choose a writable project directory', 403);
    return workspace.ref;
  }

  authorizedDirectory(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) reject('workspace_forbidden', 'Select an authorized project workspace', 403);
    let actual;
    try { actual = realpathSync(path); } catch { reject('workspace_not_found', 'The execution directory is unavailable', 404); }
    const installRoot = basename(dirname(this.releaseRoot)) === 'releases' ? dirname(dirname(this.releaseRoot)) : this.releaseRoot;
    const protectedDirectories = [this.dataRoot, installRoot];
    if (!statSync(actual).isDirectory() || actual === parse(actual).root || protectedDirectories.some(path => {
      let root;
      try { root = realpathSync(path); } catch { root = resolve(path); }
      return inside(root, actual) || inside(actual, root);
    })) reject('workspace_forbidden', 'This directory is outside the allowed execution directories', 403);
    return actual;
  }

  workspaceAvailable(id) {
    return this.workspaceRecords().some(item => item.id === id);
  }

  workspace(pathOrRef, context) {
    if (!pathOrRef) return null;
    const granted = this.workspaceRecords().filter(item => this.workspaceAvailable(item.id, context.actor, context));
    const selected = typeof pathOrRef === 'object' ? granted.find(item => item.id === idOf(pathOrRef, 'workspace')) :
      granted.find(item => item.id === pathOrRef);
    const given = selected?.path ?? (typeof pathOrRef === 'string' ? pathOrRef : null);
    const actual = this.authorizedDirectory(given);
    const matches = (selected ? [selected] : granted).flatMap(item => {
      try {
        const root = this.authorizedDirectory(item.path);
        return inside(root, actual) ? [{ item, root }] : [];
      } catch { return []; }
    }).sort((left, right) => right.root.length - left.root.length);
    const match = matches[0];
    if (!match) reject('workspace_forbidden', 'This directory is outside the caller’s grants', 403);
    return { ref: { kind: 'workspace', id: match.item.id }, path: actual, root: match.root, write: match.item.write !== false };
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
    const submitter = context.submitted_by;
    if (write && !workspace.write || submitter && !sameIdentity(submitter, context.actor) &&
        !this.workspaceAvailable(ref.id, identity(submitter), { project_room: this.projectRoom(context) }))
      reject('workspace_forbidden', 'The project directory is unavailable for this operation', 403);
    return workspace;
  }

  projectFileDirectories() {
    return [this.dataRoot, basename(dirname(this.releaseRoot)) === 'releases' ? dirname(dirname(this.releaseRoot)) : this.releaseRoot];
  }

  configureWorkspace(input) {
    if (Object.keys(input).some(key => !['id', 'revision', 'name', 'path', 'write'].includes(key))) reject('invalid_workspace', 'Unsupported execution directory setting');
    return this.store.transaction(() => {
      const id = input.id || randomUUID();
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) reject('invalid_workspace', 'Invalid execution directory ID');
      const previous = this.store.get('platform-workspaces', id);
      if (previous) assertRevision(previous.revision, input.revision);
      else if (input.revision !== undefined) assertRevision(null, input.revision);
      const name = input.name ?? previous?.name;
      if (typeof name !== 'string' || !name.trim() || name.length > 120) reject('invalid_workspace', 'An execution directory name is required');
      if (input.write !== undefined && typeof input.write !== 'boolean') reject('invalid_workspace', 'Invalid write authorization');
      const path = this.authorizedDirectory(input.path ?? previous?.path);
      const write = input.write ?? previous?.write ?? false;
      return this.store.save('platform-workspaces', { id, kind: 'workspace', name: name.trim(), path, write,
        revision: (previous?.revision ?? 0) + 1 });
    });
  }

  configureAccess(id, input, context) {
    if (context.actor.kind !== 'user') reject('configuration_forbidden', 'Only the host can grant Bot resources', 403);
    if (Object.keys(input).some(key => !['revision', 'model_ids', 'workspace_ids', 'execution_onboarding'].includes(key)))
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
      const execution_onboarding = input.execution_onboarding === undefined ? previous.execution_onboarding
        : normalizeOnboardingAccess(input.execution_onboarding);
      const saved = this.store.save('platform-access', { id, model_ids, workspace_ids, execution_onboarding, revision: (previous.revision ?? 0) + 1 });
      this.runtime?.wake();
      return saved;
    });
  }

  canUseResources(actor, refs, context = {}) {
    return (refs || []).every(ref => this.canReadReference(ref, { ...context, actor }));
  }

  assertSessionAuthority(session, { checkWorkspacePath = false } = {}) {
    if (session.authority_revoked ||
        (session.sharing && !this.store.get('rooms', session.space?.id)) ||
        (!session.sharing && session.origin_room?.kind === 'room' && session.execution_actor?.kind === 'bot' &&
          !this.roomMembers(session.origin_room.id).includes(session.execution_actor.id))) {
      reject('session_authority_revoked', 'The Session no longer has its assigned execution authority', 403);
    }
    const connection = session.engine !== 'pi' ? this.store.get('platform-connections', session.engine) : null;
    const authority = { actor: session.execution_actor, project_room: session.project_room };
    if (session.room_workspace_id && this.store.get('rooms', session.project_room?.id)?.workspace?.id !== session.room_workspace_id)
      reject('session_authority_revoked', 'The Room no longer shares the original project directory', 403);
    if (session.engine !== 'pi' && (!this.connections.authorized(connection, authority.actor) ||
        !allowsConnection(session.executable_scope, connection, id => this.connections.get(id))) ||
        session.engine === 'pi' && session.model && !this.canUseModel(session.execution_actor, session.model.connection_id) ||
        !this.canUseResources(session.execution_actor, session.resource_refs, authority)) {
      reject('session_authority_revoked', 'The Session no longer has its assigned execution resources', 403);
    }
    const oldWorkspace = session.workspace;
    if (['cli', 'codex'].includes(connection?.kind) && !oldWorkspace?.path) {
      reject('workspace_forbidden', 'This native Session has no current execution directory grant', 403);
    }
    if (oldWorkspace?.path) {
      const ref = session.workspace_ref;
      const grant = this.workspaceRecords().find(item => ref?.kind === 'workspace' && item.id === ref.id);
      if (!grant || !this.workspaceAvailable(ref.id, authority.actor, authority) || oldWorkspace.write && grant.write === false ||
          grant.revision !== undefined && relative(oldWorkspace.root, grant.path) !== '') {
        reject('workspace_changed', 'The fixed native execution directory grant has changed', 409);
      }
      if (checkWorkspacePath) {
        const workspace = this.workspace(ref, authority);
        const canonicalPath = this.authorizedDirectory(oldWorkspace.path);
        if (canonicalPath !== oldWorkspace.path || !inside(workspace.root, canonicalPath) || workspace.root !== oldWorkspace.root ||
            oldWorkspace.write && !workspace.write) reject('workspace_changed', 'The fixed native execution directory grant has changed', 409);
      }
    }
    if (session.connection_binding_version !== undefined && this.store.get('platform-connections', session.engine)?.binding_version !== session.connection_binding_version) {
      reject('connection_binding_changed', 'The fixed native connection settings have changed', 409);
    }
    const model = session.model_binding;
    if (model) {
      const current = this.models.catalog().connections.find(item => item.id === model.connection_id);
      if (!current || current.kind !== model.kind || (current.provider ?? null) !== model.provider ||
          current.baseUrl && current.baseUrl !== model.base_url) {
        reject('model_binding_changed', 'The fixed model routing settings have changed', 409);
      }
    }
  }

  assertCanSubmit(context, session) {
    if (!session || session.control.state !== 'active') reject('execution_paused', 'Execution is paused', 409);
    this.assertSessionAuthority(session, { checkWorkspacePath: true });
    this.assertRunAllowed(context, { allowUser: true, allowDraining: context.allowDraining });
    if (!this.canUseConnection(context.actor, session.engine, context)) {
      reject('execution_resources_forbidden', 'Input requires an enabled execution connection', 403);
    }
  }

  prepareSession(args, context, call, options) {
    if (this.draining) reject('updating', 'New execution Sessions are temporarily paused', 503);
    const { actor } = context;
    const engine = idOf(args.engine, 'connection');
    const space = args.space ?? context.session?.space ?? actor;
    const sharing = options.sharing(actor, space);
    const group_work = this.roomWork.scope(args, context, sharing, space);
    const project_room = this.projectRoom(context) ?? (sharing && space.kind === 'room' && this.store.get('rooms', space.id)?.mode === 'group' ? space : null);
    const roomWorkspace = project_room && this.store.get('rooms', project_room.id)?.workspace;
    const projectContext = { ...context, project_room };
    const selected = [...(args.resource_refs || [])];
    if (selected.some(ref => !['connection', 'workspace', 'file', 'event'].includes(ref.kind))) {
      reject('invalid_resource', 'Session resources must be connections, directories, Files or Events');
    }
    const connection = this.store.get('platform-connections', engine);
    const requiresWorkspace = ['cli', 'codex'].includes(connection?.kind);
    const setupWorkspace = context.conversation?.connection_setup?.workspace;
    const usesDirectory = requiresWorkspace || engine === 'pi' || connection?.kind === 'mcp' && connection.config.transport === 'stdio' &&
      !connection.config.canonical_command;
    const inherited = context.session?.workspace?.path;
    const fallbackWorkspace = connection?.config.workspace_root || this.workspaceRecords()[0]?.id;
    const workspaceSelection = args.workspace ?? (usesDirectory ? inherited || roomWorkspace || setupWorkspace || fallbackWorkspace : undefined);
    if (requiresWorkspace && !workspaceSelection) reject('workspace_required', 'Register an execution directory for this connection', 409);
    const workspace = workspaceSelection ? this.workspace(workspaceSelection, projectContext) : null;
    if (workspace && connection?.config.workspace_root) {
      const entryRoot = this.authorizedDirectory(connection.config.workspace_root);
      if (!inside(entryRoot, workspace.path)) reject('workspace_forbidden', 'The project directory is outside the connection scope', 403);
    }
    if (workspace && !selected.some(ref => sameRef(ref, workspace.ref))) selected.push(workspace.ref);
    if (sharing && engine !== 'pi') selected.push({ kind: 'connection', id: engine });
    const resource_refs = [...new Map(selected.map(ref => [keyOf(ref.kind, ref.id), ref])).values()];
    if (!this.canUseConnection(actor, engine, context)) {
      reject('execution_resources_forbidden', 'The requested execution connection is unavailable', 403);
    }
    if (engine !== 'pi' && !connection?.enabled) reject('connection_unavailable', 'Execution connection is unavailable', 409, { connection_id: engine });
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
        origin_room, origin_message_id, owner_conversation_id, owner_run_id: context.origin?.run_id ?? null, work_summary, waiting_summary: null,
        pending_input: [],
        created_at: nowIso, updated_at: nowIso,
        ...(roomWorkspace && resource_refs.some(ref => sameRef(ref, roomWorkspace)) ? { room_workspace_id: roomWorkspace.id } : {}),
        execution_actor: actor, submitted_by: actor, model, model_binding: binding,
        instructions: sharing ? '' : context.session?.instructions ?? bot?.instructions ?? '',
        ...(engine === 'pi' ? { built_in_role: sharing ? null : (context.session ? context.session.built_in_role : bot.built_in_role) ?? null } : {}),
        bot_revision: bot?.revision ?? null, sharing, resource_refs, workspace: workspace ? { path: workspace.path, root: workspace.root, write: workspace.write } : null,
        workspace_ref: workspace?.ref ?? null, status: 'opening', native: null, input_targets: [], input_revision: 0,
        ...(context.executable_scope !== undefined ? { executable_scope: context.executable_scope } : {}),
        ...(connection ? { connection_binding_version: connection.binding_version ?? 1 } : {}), ...(engine === 'pi' ? { open_call_id: call.id } : {}),
        execution_environment: executionEnvironment(connection), ...(group_work ? { group_work } : {}),
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
      return { ...context, actor, origin, conversation, session: null, controls, resource_refs: [], executable_scope: null };
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
    return { ...context, actor, origin, conversation, session, controls, resource_refs: [...(session?.resource_refs || []), ...(session ? context.input_refs || [] : [])],
      executable_scope: executableScope({ session, conversation }) };
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
    const sharedConnections = this.store.list('platform-connections').filter(item => this.canUseConnection(context.actor, item.id, context))
      .map(({ id, revision }) => [id, revision]);
    const maintained_connection_ids = sharedConnections.map(([id]) => id)
      .filter(id => this.connections.get(id).maintainer_bot_id === context.actor.id);
    const permitted = context.session?.resource_refs?.map(ref => [ref.kind, ref.id, this.canReadReference(ref, context)]) ?? [];
    const waits = this.calls.returnWaits(context.origin, context.actor);
    const revoked_return_waits = waits.filter(wait => !this.canReadReturnWait(wait, wait.target)).map(wait => wait.id).sort();
    return { actor: context.actor, resources: context.session?.resource_refs ?? [], session: context.session, conversation: context.conversation,
      connection_ids: sharedConnections.map(([id]) => id),
      maintained_connection_ids,
      view_revision: keyOf(rooms, context.session?.id, context.session?.control.control_version, access?.revision, sharedConnections, permitted),
      unfinished_calls: this.calls.unfinishedFor(context.conversation.id, context.actor),
      pending_return_waits: waits.filter(wait => ['waiting', 'pending_delivery', 'received'].includes(wait.status)),
      revoked_return_waits,
      canReadEvent: event => this.canReadEvent(event, context) };
  }

  async installDrain(state) {
    this.draining = ['prepared', 'draining'].includes(state?.phase);
    this.runtime.setDraining(this.draining);
    if (!this.draining) return { active: [], ready: true };
    const native = await this.connections.drainStatus();
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

  async configureExecutionConnection(value, context, onSave) {
    if (context.actor.kind !== 'user') reject('connection_forbidden', 'Connection settings require the host user', 403);
    const current = value.id && this.connections.get(value.id);
    if (current && !this.canUseConnection(user, value.id, context))
      reject('connection_not_found', 'Connection is unavailable', 404);
    if (value.maintainer_bot_id !== undefined && value.maintainer_bot_id !== null) {
      const bot = this.store.get(botRecords, value.maintainer_bot_id);
      if (!bot || bot.archivedAt || bot.connection_initializer)
        reject('invalid_connection', 'Choose an available maintenance Bot');
    }
    if (value.kind === 'ssh' && !value.config?.ssh && !value.config_patch?.ssh && !current?.config.ssh)
      reject('invalid_ssh_binding', 'Specify the fixed SSH target and operations');
    const submitted = value.kind === 'ssh' ? { ...value, kind: 'cli' } : value;
    const result = await this.connections.configure({ ...submitted, id: value.id ?? randomUUID() }, context,
      saved => onSave?.({ ...saved, ...this.connectionMaintenance(this.connections.get(saved.id)) }));
    const savedEntry = this.connections.get(result.id);
    if (savedEntry?.maintainer_bot_id) this.grantMaintainerWorkspace(savedEntry, savedEntry.maintainer_bot_id);
    if (current) {
      const updated = savedEntry;
      if (!updated || current.enabled && !updated.enabled || (current.binding_version ?? 1) !== (updated.binding_version ?? 1))
        await this.revokeSessions({ kind: 'connection', id: result.id });
    }
    const recoveredConnection = Boolean(savedEntry?.enabled && (
      !current ||
      !current.enabled ||
      (current.binding_version ?? 1) !== (savedEntry.binding_version ?? 1) ||
      !isDeepStrictEqual(current.config, savedEntry.config) ||
      !isDeepStrictEqual(current.grants, savedEntry.grants)
    ));
    if (recoveredConnection) this.runtime?.resumeRecoveredRuns?.({ kind: 'connection', id: result.id });
    this.emit('connection');
    return { ...result, ...this.connectionMaintenance(this.connections.get(result.id)) };
  }

  async startConnectionSetup(args, input, clientId) {
    const context = this.context({ ...input, clientId });
    if (context.actor.kind !== 'user') reject('connection_forbidden', 'Connection initialization requires the host user', 403);
    this.assertRunAllowed(context);
    const replay = clientId && this.calls.clientCall(context.actor, clientId);
    if (replay) {
      if (replay.tool !== 'initialize_connections') reject('call_conflict', 'This request identity belongs to another invocation', 409);
      return setupResponse(this.calls.replay(replay, context), replay);
    }
    if (Object.keys(args).some(key => !['bot', 'input', 'workspace', 'executables'].includes(key)))
      reject('invalid_arguments', 'Unsupported connection initialization setting');
    const text = args.input ?? 'Initialize the local execution connections available to this Pi. Use the built-in guide and the installed CLI interfaces.';
    if (typeof text !== 'string' || !text.trim() || text.length > 100_000 || text.includes('\0')) reject('invalid_input', 'Supply a text instruction for Pi');
    const executables = args.executables;
    if (executables !== undefined && (!Array.isArray(executables) || executables.length > 24 || executables.some(path =>
        typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || path.includes('\0'))))
      reject('invalid_executable', 'Supply absolute paths to the executables in scope');
    const requestedWorkspace = this.workspace(args.workspace, context);
    const bot = args.bot === undefined ? this.manager.onboardingBot() : this.getBot(idOf(args.bot, 'bot'));
    if (!bot || !this.visibleBot(bot, context)) reject('bot_not_found', 'Select an existing Pi Bot or ensure the tool-onboarding Bot is active', 404);
    const actor = { kind: 'bot', id: bot.id };
    if (!bot.enabled) reject('bot_paused', 'The selected Pi Bot is paused', 409);
    const blocker = this.modelAccessBlocker(actor, this.botModelConnectionId(bot));
    if (blocker) reject('connection_unconfigured', blocker.message, 409, { reason: blocker.code });
    const workspace = requestedWorkspace && this.workspace(requestedWorkspace.path, { ...context, actor });
    const { record, existing } = this.calls.begin('initialize_connections', context);
    if (existing) return setupResponse(this.calls.replay(record, context), record);
    try {
      const bindings = executables && await Promise.all([...new Set(executables)].map(async file => {
        const found = await localExecutable(file).catch(() => null);
        return { file, canonical_file: found?.canonicalFile ?? null };
      }));
      const conversation = await this.runtime.connectionSetupConversation(bot, record.id, { workspace: workspace?.path, executables: bindings });
      const target = { kind: 'conversation', id: conversation.id };
      const result = await this.executions.submit({ target, kind: 'next', control_version: conversation.control.control_version,
        input_target: { kind: 'idle_input', input_revision: conversation.input_revision }, input: text }, context, record);
      this.emit('execution', { call_id: record.id });
      return result;
    } catch (error) {
      this.calls.fail(record.id, error);
      error.call_id = record.id;
      throw error;
    }
  }

  canInitializeExecution(input) {
    const context = this.context(input);
    const role = this.getBot(context.actor.id).built_in_role?.id;
    return [toolOnboardingRole, catalogMaintainerRole].includes(role) || this.connectionInitializer.managed(context).length > 0;
  }

  requireConnectionSetup(input, args) {
    const context = this.assertRunAllowed(input);
    const conversation = this.executions.record({ kind: 'conversation', id: context.origin?.conversation_id });
    const setup = conversation?.connection_setup;
    const call = setup && this.store.get('platform-calls', conversation.id);
    if (context.actor.kind !== 'bot') reject('initialization_forbidden', 'Connection initialization requires a Pi run', 403);
    const target = args.action === 'inspect' && args.target?.kind === 'connection' ? args.target : null;
    const targetId = target && idOf(target, 'connection');
    const connectionId = args.connection === undefined ? targetId : idOf(args.connection, 'connection');
    if (targetId && targetId !== connectionId)
      reject('connection_binding_conflict', 'Use the same connection ID in target and connection, or supply just one of them', 409);
    const selected = connectionId && this.connections.get(connectionId);
    if (target && (!this.canReadReference(target, context) || !this.connections.authorized(selected, context.actor)))
      reject('environment_forbidden', 'The Bot needs use access to the target connection and its dependencies in this workspace and run scope', 403);

    const role = this.getBot(context.actor.id).built_in_role?.id;
    const policy = this.accessFor(context.actor).execution_onboarding;
    if (!context.session && sameIdentity(context.submitted_by, user) && sameRef(conversation?.space, context.actor) && call?.tool === 'initialize_connections' &&
        sameIdentity(call.submitted_by, user) && sameIdentity(call.execution_actor, context.actor) &&
        sameRef(call.target, { kind: 'conversation', id: conversation.id })) {
      const connection = selected;
      if (connection && !this.connectionInitializer.setupOwns(connection, context, setup) && !this.repairableConnection(connection, context) &&
          !(policy && this.canUseConnection(context.actor, connection.id, context)))
        reject('initialization_forbidden', 'The connection is outside this active setup and the Bot’s grants', 403);
      return { ...setup, hostSetup: true, policy, connection };
    }

    const authorized = this.connectionInitializer.managed(context);
    const repair = this.repairableConnection(selected, context);
    const connection = selected && this.canUseConnection(context.actor, selected.id, context) ? selected : null;
    const onboarding = role === toolOnboardingRole || Boolean(policy);
    if (['guide', 'discover', 'documentation', 'source'].includes(args.action) && (onboarding || role === catalogMaintainerRole || authorized.length))
      return { onboarding, policy, connections: authorized, connection };
    if (args.action === 'inspect') {
      if (onboarding || repair || role === catalogMaintainerRole) return { onboarding, policy, connection };
      reject('initialization_forbidden', 'Inspect needs an existing connection repair grant or a host executable grant', 403);
    }
    if ((onboarding || repair) && (['upsert_method', 'assign_maintainer', 'grant_access'].includes(args.action) ||
        args.action === 'register' && args.protocol))
      return { onboarding, policy, connection };
    if (!connection || !repair ||
        args.action === 'register' && (args.protocol || !['cli', 'codex'].includes(protocolOf(connection))))
      reject('initialization_forbidden', 'The requested submission requires an onboarding or existing repair grant', 403);
    const runnerId = connection.config.adapter?.runner?.id;
    const runner = runnerId && this.connections.get(runnerId);
    const boundPaths = [connection, runner].filter(Boolean).map(({ config }) => ({ file: config.file, canonical_file: config.canonical_file }));
    return { repair: true, connection, connections: [connection], executables: boundPaths, workspace: connection.config.workspace_root };
  }

  assertSetupBotTool(name, args, context) {
    const setup = this.requireConnectionSetup(context, { action: 'discover' });
    if (!setup.hostSetup) reject('initialization_forbidden', 'Bot provisioning requires the active host setup', 403);
    const target = name === 'create_bot' ? null : this.getBot(idOf(args.bot, 'bot'));
    if (target && !this.manager.canConfigure(context.actor, target))
      reject('configuration_forbidden', 'This Bot is outside the initialization scope', 403);
    const rule = name === 'set_wakeup' ? args.event_or_time ?? this.store.get(wakeupRecords, args.id)?.rule : null;
    const owned = target && this.store.list('platform-connections').filter(entry => entry.maintainer_bot_id === target.id &&
      this.connectionInitializer.setupOwns(entry, context, setup));
    const connectionId = args.role_connection_id ?? rule?.ref?.id ?? owned?.[0]?.id;
    if (!this.connectionInitializer.setupOwns(this.connections.get(connectionId), context, setup) ||
        name === 'create_bot' && args.role_id !== catalogMaintainerRole ||
        name === 'configure_bot' && args.role_id !== undefined && args.role_id !== catalogMaintainerRole)
      reject('initialization_forbidden', 'Use the CLI maintenance duty for a connection in this setup', 403);
    if (name === 'set_wakeup') {
      if (rule?.kind !== 'event' || rule.type !== 'connection.failure' || rule.room ||
          !sameRef(rule.ref, { kind: 'connection', id: connectionId }) || !owned.some(entry => entry.id === connectionId))
        reject('initialization_forbidden', 'The embedded initializer can subscribe this Bot to its CLI failure events', 403);
    }
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
      if (this.getBot(context.actor.id).connection_initializer) {
        if (name !== connectionSetupTool.name && !connectionSetupTool.executionTools.includes(name))
          reject('initialization_forbidden', 'This embedded Pi invocation is outside the execution setup scope', 403);
        if (setupBotTools.has(name)) this.assertSetupBotTool(name, args, context);
      }
    }
    if (readTools.has(name)) return { result: await this[name](args, context), call_id: null };
    const setup = name === connectionSetupTool.name ? this.requireConnectionSetup(context, args) : null;
    if (this.draining && !(context.actor.kind === 'user' && (name === 'send' || context.allowDraining))) {
      reject('updating', 'This operation is temporarily unavailable during the update', 503);
    }
    const { record, existing } = this.calls.begin(name, context);
    if (existing) return { result: this.calls.replay(record, context), call_id: record.id };
    try {
      if (setup) {
        const result = await this.connectionInitializer.run(args, context, setup, record);
        const current = this.calls.get(record.id);
        return { result: current.status === 'completed' ? current.result : this.calls.finish(record.id, 'completed', result), call_id: record.id };
      }
      if (name === 'open_session' || name === 'send_input' || name === 'stop_session') {
        const result = name === 'open_session' ? await this.executions.open(args, context, record)
          : name === 'send_input' ? await this.executions.submit(args, context, record) : await this.executions.stop(args, context, record);
        if (name === 'open_session' && result?.target && context.actor.kind === 'bot' && Array.isArray(context.origin?.event_ids)) {
          for (const sourceEventId of context.origin.event_ids) {
            this.deliveries.recordWakeupOutcome(sourceEventId, context.actor.id, {
              outcome: 'opened_session',
              outcome_ref: result.target,
            });
          }
        }
        this.emit('execution', { call_id: record.id });
        return { result, call_id: record.id };
      }
      if (name === 'send' && args.to?.kind === 'connection') {
        const result = this.store.transaction(() => this.repairs.send(args, context, record));
        return { result, call_id: record.id };
      }
      if (name === 'create_bot') {
        if (context.session) reject('configuration_forbidden', 'This Session cannot create Bot identities', 403);
        const result = this.store.transaction(() => {
          const id = `bot-${record.id}`;
          const bot = this.manager.create(id, args, context, () => this.assertRunAllowed(context));
          this.calls.bind(record.id, { target: { kind: 'bot', id: bot.id } });
          const maintenance = args.role_connection_id
            ? this.connectionMaintenance(this.connections.get(args.role_connection_id), context)
            : undefined;
          return this.calls.finish(record.id, 'completed', {
            ...this.manager.view(bot, context.actor),
            ...(bot.id !== id ? { reused: true } : {}),
            ...(maintenance ? { maintenance } : {}),
          });
        });
        this.emit('bot', result);
        if (args.role_connection_id) this.emit('connection');
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
      if (name === 'configure_bot' && result.control && Object.keys(args).some(key => !['bot', 'revision', 'role_id', 'role_connection_id', 'connection_revision'].includes(key))) {
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
      if (name === 'configure_room' && (args.remove_members?.length || args.workspace !== undefined)) {
        if (args.remove_members?.length) this.stripRemovedFromSharedSessions(result.id, args.remove_members.map(m => identity(m).id));
        await this.revokeSessions({ kind: 'room', id: result.id });
      }
      return { result, call_id: record.id };
    } catch (error) {
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
      if (args.repair_key !== undefined || args.repair_outcome !== undefined)
        reject('invalid_repair_message', 'Repair fields require a connection destination');
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
      const bot = this.manager.configure(args, context, call.id, (ref, id) => {
        if (ref.kind !== 'file' || !this.files.canRead(ref.id, context) || !this.files.canRead(ref.id, { actor: { kind: 'bot', id } })) {
          reject('material_index_forbidden', 'The Bot cannot read this material index', 403);
        }
      });
      if (args.role_id !== undefined && previousRole !== args.role_id && (previousRole === 'eggbot' || args.role_id === 'eggbot'))
        this.deliveries.syncObserverMemberships(bot.id);
      if (args.role_connection_id) this.emit('connection');
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
    reject('tool_not_found', 'Unknown writable tool', 404);
  }

  async find({ kind, scope, query, cursor, period }, context) {
    const { actor } = context;
    if (scope && !this.canReadReference(scope, context)) reject('scope_unavailable', 'Search scope is unavailable', 404);
    let items;
    switch (kind) {
      case 'connection_usage': return this.connectionUsage.query({ scope, period, query, cursor }, context);
      case 'bot': {
        const team = this.canFindTeam(context);
        const members = scope?.kind === 'room' ? new Set(this.roomMembers(scope.id)) : null;
        items = this.manager.list().filter(bot => (!scope || members?.has(bot.id)) &&
          (team ? !bot.archivedAt && !bot.connection_initializer : this.visibleBot(bot, context)))
          .map(bot => team ? directoryEntry(bot) : this.manager.view(bot, actor, { details: !context.session }));
        break;
      }
      case 'room': items = this.room.rooms(actor.id).filter(room => this.canReadSpace(actor, { kind: 'room', id: room.id }, context))
        .map(room => ({ ...room, kind: 'room' })); break;
      case 'event': {
        const messages = this.room.rooms(actor.id).filter(room => (!scope || sameRef(scope, room.ref)) && this.canReadSpace(actor, room.ref, context))
          .flatMap(room => this.room.messages(room.id, actor.id));
        items = [...messages, ...this.store.list('platform-events').filter(event => this.canReadEvent(event, context) &&
          (!scope || sameRef(event.space || event.target, scope))).map(event => this.repairs.eventView(event, context))]; break;
      }
      case 'file':
        if (scope?.kind === 'workspace') return this.workspaceEntries({ ref: scope, query, cursor }, context);
        items = this.files.list(context, scope);
        break;
      case 'session': case 'conversation': items = this.executions.list(context, scope).filter(item => item.kind === kind); break;
      case 'connection': {
        const needle = query?.trim().toLowerCase();
        const pi = { kind: 'connection', id: 'pi', name: 'Pi', protocol: 'pi', enabled: true, available: true };
        const visible = (await this.connections.find(this.connectionContext(context), query)).filter(item => this.canUseConnection(actor, item.id, context));
        items = visible.map(item => ({ ...item, ...this.connectionMaintenance(this.connections.get(item.id), context) }));
        if (!needle || needle === 'pi') items = [pi, ...items];
        break;
      }
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
    const needle = query?.trim().toLowerCase();
    const filtered = needle && kind !== 'connection' ? items.filter(item => [item.id, item.name, item.path, item.content, item.text, item.public_duty, item.role_id]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(needle))) : items;
    return page(filtered, cursor);
  }

  connectionContext(context) {
    return { ...context, allow: id => this.canUseConnection(context.actor, id, context) };
  }

  workspaceEntries(args, context) {
    const workspace = this.projectFileAccess(args.ref, context);
    return this.files.listWorkspace(args, workspace, this.projectFileDirectories(), () => {
      if (this.projectFileAccess(args.ref, context).root !== workspace.root) reject('workspace_changed', 'The project directory has moved', 409);
    });
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
    if (!this.canReadReference(ref, context)) reject('object_not_found', 'Object is unavailable', 404);
    switch (ref.kind) {
      case 'bot': {
        const bot = this.getBot(ref.id);
        if (!this.visibleBot(bot, context)) return directoryEntry(bot);
        const view = this.manager.view(bot, context.actor, { details: !context.session });
        const memory_items = !context.session ? (this.runtime?.materials?.inspectBot(bot, context) || []) : undefined;
        return memory_items !== undefined ? { ...view, memory_items } : view;
      }
      case 'room': return this.room.read(args, context.actor.id);
      case 'event': {
        const event = this.store.get('platform-events', ref.id);
        return event ? this.repairs.eventView(event, context) : this.room.read(args, context.actor.id);
      }
      case 'file': return this.files.readObject(ref.id, context, args.cursor, args.limit, args.revision);
      case 'session': case 'conversation': return this.executions.read(ref, context, args);
      case 'connection': {
        if (ref.id === 'pi') return { kind: 'connection', id: 'pi', name: 'Pi', protocol: 'pi',
          input: 'text or structured input for a new Pi conversation', operations: ['steer', 'next', 'stop'] };
        const observed = await this.connections.read(ref.id, this.connectionContext(context));
        const entry = this.connections.get(ref.id);
        if (!this.canUseConnection(context.actor, ref.id, context)) reject('connection_forbidden', 'The connection is unavailable', 403);
        const maintenance = this.connectionMaintenance(entry, context);
        const codexHints = entry.kind === 'codex'
          ? { recommendation_mode: 'soft', recommended_combinations: this.models.codexRecommendations() }
          : {};
        const http = entry.kind === 'http' && maintenance.can_repair ?
          { service_url: entry.config.service_url, method_bindings: httpMethods(entry.config) } : {};
        return { ...observed, ...codexHints, ...this.connections.clean(http), ...maintenance };
      }
      case 'call': return this.calls.view(this.calls.get(ref.id), context);
      case 'wakeup': return this.deliveries.list(context).find(item => item.id === ref.id);
      case 'workspace': {
        if (args.directory !== undefined) return this.workspaceEntries(args, context);
        if (args.path === undefined) return this.workspaceRecords().find(item => item.id === ref.id);
        const workspace = this.projectFileAccess(ref, context);
        try {
          return await this.files.readWorkspace(args, workspace, this.projectFileDirectories(), () => {
            if (this.projectFileAccess(ref, context).root !== workspace.root) reject('workspace_changed', 'The project directory has moved', 409);
          });
        } catch (error) {
          if (error.status !== 404) throw error;
          let listing;
          try { listing = await this.workspaceEntries({ ref, limit: 12 }, context); }
          catch (failure) {
            if (![403, 404].includes(failure.status) && !['ENOENT', 'EACCES', 'EPERM'].includes(failure.code)) throw failure;
          }
          this.projectFileAccess(ref, context);
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
    for (const conn of this.store.list('platform-connections')) {
      if (conn.maintainer_bot_id === id) {
        this.store.save('platform-connections', { id: conn.id, maintainer_bot_id: null, revision: conn.revision + 1 });
      }
    }
    this.deliveries.removeAllForBot(id);
    const result = this.manager.remove(id, before.revision, actor);
    this.emit('bot');
    this.emit('room');
    this.emit('connection');
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
    this.emit('execution');
    return {
      room_id: room.id,
      conversations: convResults,
      sessions: sessionResults,
      detached: this.connections.listDetached().filter(item => item.room_id === room.id),
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
    if (ref.kind === 'connection') {
      const visited = new Set();
      const dependsOn = id => {
        if (id === ref.id) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        return this.connections.get(id)?.dependencies?.some(dependsOn) === true;
      };
      return dependsOn(session.engine) || resources.some(item => item.kind === 'connection' && dependsOn(item.id));
    }
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
      outcome = await (session.engine === 'pi' ? this.runtime.pi.stop({ session, call }) : this.connections.stop({ session, call }));
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
      const rawSummary = latest.last_output_summary || latest.waiting_summary || null;
      const summary = (rawSummary && rawSummary !== latest.work_summary)
        ? rawSummary
        : status === 'stopped'
          ? (latest.authority_revoked ? `因${reasonText}触发权限中止，任务已停止` : '任务已中止，未产生最终文本输出')
          : status === 'failed'
            ? '任务执行失败，详见关联调用与事件记录'
            : '任务已结束（无额外文本摘要，详见关联调用与事件记录）';
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
    return available.find(bot => bot.built_in_role?.id === 'eggbot') || available[0];
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
        else if (runtimeActivity.suspended) unavailableReason = '被点名成员处理中断（suspended），可点击重试';
      } else if (!this.naturalFallbackBot(room)) {
        unavailableReason = '当前群内无可用成员（均已暂停或缺少可用模型绑定）';
      } else if (fallbackRecord) {
        unavailableReason = runtimeActivity.suspended ? '兜底成员处理中断，可点击重试或另行点名' : '已由统筹成员检视但未公开发言，可点击点名指定成员';
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

  roomMessageStates(roomId, messages = []) {
    const result = {};
    for (const msg of messages) {
      if (msg.senderId === 'user') {
        const status = this.roomMessageStatus(roomId, msg);
        if (status) result[msg.id] = status;
      }
    }
    return result;
  }

  checkUnansweredFallbacks() {
    if (this.draining || !this.runtime) return;
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const room of this.store.list('rooms')) {
      if (room.mode !== 'group') continue;
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

  triggerManualFallback(roomId, messageId, botId) {
    const room = this.room.room(roomId, user.id);
    const bot = botId ? this.getBot(botId) : this.naturalFallbackBot(room);
    if (!bot || !bot.enabled || bot.archivedAt || !room.members.includes(bot.id)) {
      reject('bot_unavailable', 'Selected Bot is unavailable in this Room', 409);
    }
    const row = this.room.messageRow.get(messageId);
    if (!row) reject('message_not_found', 'Message not found', 404);
    const msg = this.room.projectMessage(row);
    if (msg.roomId !== room.id) reject('message_not_found', 'Message does not belong to this Room', 404);
    const event = {
      ...this.room.messageEventFor(msg),
      fallback_reason: 'host_manual_fallback',
      fallback_guidance: 'The host explicitly asked you to respond to this message.',
    };
    const delivery = this.deliveries.enqueue(bot.id, event, [{ id: keyOf('manual_fallback', messageId, Date.now()), revision: 1, kind: 'unanswered_fallback' }], []);
    this.store.save('unanswered-fallbacks', {
      id: messageId,
      room_id: room.id,
      bot_id: bot.id,
      manual: true,
      created_at: new Date().toISOString(),
    });
    this.emit('room');
    return { ok: true, bot_id: bot.id, delivery_id: delivery.id };
  }

  async tick({ observations = true, deliveries = true } = {}) {
    if (!this.draining && observations) {
      this.repairs.reconcile();
      this.deliveries.tickTime();
      this.checkUnansweredFallbacks();
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
          this.store.save('platform-conversations', { id: conv.id, control: { ...conv.control, state: 'active', stop_status: 'stopped' } });
        }
      }
      for (const conn of this.store.list('platform-connections')) {
        if (Object.hasOwn(conn, 'repair_bot_ids')) {
          const cleaned = { ...conn };
          delete cleaned.repair_bot_ids;
          this.store.save('platform-connections', cleaned);
        }
      }
      for (const bot of this.store.list(botRecords)) {
        if (bot.connection_initializer) {
          this.store.remove(botRecords, bot.id);
          this.store.remove('platform-access', bot.id);
          continue;
        }
        if (bot.built_in_role?.id && !roleIds.includes(bot.built_in_role.id)) {
          this.store.save(botRecords, { id: bot.id, built_in_role: null });
        }
      }
    });
    for (const bot of this.manager.list()) {
      if (bot.control.state === 'paused' && bot.control.stop_status === 'pending') this.manager.settleStop(bot.id, bot.control.stop_id, 'stopped');
    }
    this.deliveries.purgePausedDeliveries();
  }
}
