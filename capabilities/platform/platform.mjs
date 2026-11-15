import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bindModel } from '../../bot/src/agent/model.mjs';
import { BotManager, activeControl, botRecords } from '../bot-management/service.mjs';
import { Files } from '../filesystem/files.mjs';
import { Calls, isWaitOrigin, waitRecords } from './calls.mjs';
import { assertRevision, idOf, identity, keyOf, page, readTools, reject, sameIdentity, sameRef, user, validateTool } from './contract.mjs';
import { Deliveries } from './delivery.mjs';
import { Executions, conversationRecords, sessionRecords } from './executions.mjs';
import { HostResources } from './resources.mjs';

const normalize = (value, kind) => typeof value === 'string' ? { kind, id: value } : value;
export const profileMatches = (record, context) => (record?.workspaceProfileId ?? null) === (context.workspaceProfileId ?? null);
const inside = (root, path) => {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};

export class SummonPlatform {
  constructor({ store, dataRoot, releaseRoot, models, attachments, limits, workspaces = [], emit = () => {} }) {
    Object.assign(this, { store, dataRoot, releaseRoot, models, attachments, emit });
    this.draining = false;
    this.resources = new HostResources(store, limits);
    this.manager = new BotManager({ store, dataRoot, resources: this.resources, models, canUseModel: (actor, id, context) => this.canUseModel(actor, id, context) });
    this.deliveries = new Deliveries({ store, resources: this.resources, manager: this.manager, emit,
      canReadEvent: (botId, event) => this.canReadEvent(event, this.principalContext({ kind: 'bot', id: botId })),
      canReadWait: (wait, event) => this.canReadReturnWait(wait, event.target),
      canReadReference: (ref, context) => this.canReadReference(ref, context) });
    this.calls = new Calls({ store, deliver: (event, waits, matchWakeups) => this.deliveries.queueEvent(event, waits, matchWakeups),
      canReadTarget: (actor, ref, context, call) => this.canReadCallResult(call, ref, { ...context, actor }),
      spaceFor: ref => ['session', 'conversation'].includes(ref?.kind) ? this.executions.record(ref)?.space : ref });
    this.executions = new Executions({ store, platform: this, calls: this.calls, resources: this.resources });
    this.workspaces = workspaces;
  }

  attach({ room, runtime, connections }) {
    Object.assign(this, { room, runtime, connections });
    this.files = new Files({ store: this.store, room, attachments: this.attachments,
      canReadSpace: (actor, space, context) => this.canReadSpace(actor, space, context),
      canWriteSpace: (actor, space, context) => this.canWriteSpace(actor, space, context),
      canReadReference: (ref, context) => this.canReadReference(ref, context),
      assertShareable: (ref, options) => this.assertShareable(ref, options), notify: event => this.deliveries.queueEvent(event) });
  }

  getBot(id) { return this.manager.get(id); }
  listBots() { return this.manager.list(); }
  ensureRoomBase(botId, roomId) { return this.deliveries.ensureBase(botId, roomId); }
  removeRoomBase(botId, roomId) { return this.deliveries.removeBase(botId, roomId); }
  queueMessage(event) { return this.deliveries.queueMessage(event); }
  messageDeliveries(eventId) { return this.deliveries.messageDeliveries(eventId); }
  consumeDelivery(botId, id, receipt) { return this.deliveries.consume(botId, id, receipt); }
  recordReceipt(callId, facts, sessionId) { return this.executions.receipt(sessionId, callId, facts); }
  roomMembers(id) { return this.deliveries.roomMembers(id); }

  accessFor(actor) {
    return actor.kind === 'user' ? null : this.store.get('platform-access', actor.id) || {};
  }

  principalContext(actor, workspaceProfileId) {
    const profile = actor.kind === 'bot' ? this.store.get(botRecords, actor.id)?.workspaceProfileId ?? null : workspaceProfileId ?? null;
    return { actor, workspaceProfileId: profile };
  }


  canUseModel(actor, id, context = this.principalContext(actor)) {
    return this.models.catalog().connections.some(item => item.id === id && profileMatches(item, context)) &&
      (actor.kind === 'user' || Boolean(this.accessFor(actor).model_ids?.includes(id)));
  }

  canUseConnection(actor, id, context = {}) {
    if (context.session && id !== context.session.engine && !context.resource_refs?.some(ref => sameRef(ref, { kind: 'connection', id }))) return false;
    if (id === 'pi') return true;
    const entry = this.store.get('platform-connections', id);
    const profile = context.workspaceProfileId === undefined ? this.principalContext(actor) : context;
    return Boolean(entry && profileMatches(entry, profile) && (actor.kind === 'user' || entry.enabled &&
      (entry.allowed_bot_ids?.includes('*') || entry.allowed_bot_ids?.includes(actor.id))));
  }

  visibleBot(bot, context) {
    if (!profileMatches(bot, context.workspaceProfileId === undefined ? this.principalContext(context.actor) : context)) return false;
    if (context.session) return sameIdentity(context.actor, { kind: 'bot', id: bot.id });
    if (this.manager.canConfigure(context.actor, bot)) return true;
    return this.store.list('rooms').some(room => room.members.includes(context.actor.id) && room.members.includes(bot.id));
  }

  canReadSpace(actor, space, context = {}) {
    if (!space) return false;
    const profile = context.workspaceProfileId === undefined ? this.principalContext(actor) : context;
    if (context.session && !sameRef(context.session.space, space) && !context.resource_refs?.some(ref => sameRef(ref, space))) return false;
    if (space.kind === 'room') {
      const room = this.store.get('rooms', space.id);
      return Boolean(room && profileMatches(room, profile) && room.members.includes(actor.id));
    }
    if (space.kind === 'user') return sameIdentity(actor, space);
    if (space.kind === 'bot') {
      const bot = this.store.get(botRecords, space.id);
      return Boolean(bot && profileMatches(bot, profile) && (actor.kind === 'user' || sameIdentity(actor, space)));
    }
    return false;
  }

  spaceProfile(space, owner) {
    if (space?.kind === 'room') return this.store.get('rooms', space.id)?.workspaceProfileId ?? null;
    if (space?.kind === 'bot') return this.store.get(botRecords, space.id)?.workspaceProfileId ?? null;
    return owner?.kind === 'bot' ? this.store.get(botRecords, owner.id)?.workspaceProfileId ?? null : null;
  }

  canWriteSpace(actor, space, context = {}) {
    if (context.session && !sameRef(context.session.space, space)) return false;
    return this.canReadSpace(actor, space, context);
  }

  canReadReturnWait(wait, target) {
    const actor = { kind: 'bot', id: wait.bot_id };
    const context = this.principalContext(actor);
    const source = { kind: 'conversation', id: wait.conversation_id };
    const conversation = this.executions.record(source);
    const session = wait.session_id && this.executions.record({ kind: 'session', id: wait.session_id });
    if (!conversation || !profileMatches(wait, context) || (conversation.session_id ?? null) !== (wait.session_id ?? null) ||
        wait.session_id && !session || !this.executions.permission(source, conversation, context)) return false;
    const principal = wait.initiating_principal;
    return this.canReadReference(target, { ...context, session, resource_refs: session?.resource_refs ?? [] }) &&
      (!principal || sameIdentity(principal, actor) || this.canReadReference(target, this.principalContext(principal, context.workspaceProfileId)));
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
    if (event.call_id && event.target) {
      const call = this.store.get('platform-calls', event.call_id);
      const waits = call?.return_refs || [];
      const watching = context.actor.kind === 'user' || sameIdentity(context.actor, call?.submitted_by) || call?.origin_bot === context.actor.id ||
        waits.some(id => {
          const wait = this.store.get(waitRecords, id);
          return wait?.bot_id === context.actor.id && (!wait.input_call_id || (context.origin ? isWaitOrigin(wait, context.origin)
            : this.canReadReturnWait(wait, event.target)));
        }) ||
        this.store.list('platform-wakeups').some(rule => rule.bot_id === context.actor.id && this.deliveries.matches(rule, event));
      return watching && this.canReadCallResult(call, event.target, context);
    }
    if (event.bot_id && event.bot_id !== context.actor.id && context.actor.kind !== 'user') return false;
    const resource = context.resource_refs?.some(ref => sameRef(ref, { kind: 'event', id: event.id }));
    return this.canReadSpace(context.actor, event.space || { kind: 'room', id: event.roomId }, resource ? this.principalContext(context.actor, context.workspaceProfileId) : context);
  }

  canReadReference(ref, context) {
    if (!ref?.id) return false;
    const { actor } = context;
    if (context.workspaceProfileId === undefined) context = { ...context, ...this.principalContext(actor) };
    switch (ref.kind) {
      case 'room': case 'user': return this.canReadSpace(actor, ref, context);
      case 'bot': {
        const record = this.store.get(botRecords, ref.id);
        return Boolean(record && this.visibleBot(record, context));
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

  assertShareable(ref, { actor, room, members = room.members, context = {} }) {
    const principal = identity(actor);
    const caller = { workspaceProfileId: room.workspaceProfileId ?? null, ...context, actor: principal };
    if (!this.canReadReference(ref, caller)) reject('share_forbidden', 'This reference is unavailable to the sender', 403);
    const file = ref.kind === 'file' ? this.files.get(ref.id) : null;
    if (file && sameRef(file.space, { kind: 'room', id: room.id })) return this.files.view(file);
    const event = ref.kind === 'event' ? this.store.get('messages', ref.id) : null;
    if (event?.roomId === room.id) return event;
    if (!members.every(member => this.canReadReference(ref, this.principalContext(identity(member), room.workspaceProfileId)))) {
      reject('share_forbidden', 'The receiving audience cannot read this reference', 403);
    }
    return file ? this.files.view(file) : this.attachments.find(ref.id) || ref;
  }

  workspaceRecords() { return [...this.workspaces, ...this.store.list('platform-workspaces')]; }

  authorizedDirectory(path) {
    if (typeof path !== 'string' || !isAbsolute(path)) reject('workspace_forbidden', 'Select an authorized project workspace', 403);
    let actual;
    try { actual = realpathSync(path); } catch { reject('workspace_not_found', 'Workspace directory is unavailable', 404); }
    const installRoot = basename(dirname(this.releaseRoot)) === 'releases' ? dirname(dirname(this.releaseRoot)) : this.releaseRoot;
    const protectedDirectories = [this.dataRoot, installRoot];
    if (!statSync(actual).isDirectory() || actual === parse(actual).root || protectedDirectories.some(path => {
      let root;
      try { root = realpathSync(path); } catch { root = resolve(path); }
      return inside(root, actual) || inside(actual, root);
    })) reject('workspace_forbidden', 'This directory is outside the usable workspace scope', 403);
    return actual;
  }

  workspaceAvailable(id, actor, context = {}) {
    if (context.session && !context.resource_refs?.some(ref => sameRef(ref, { kind: 'workspace', id }))) return false;
    const profile = context.workspaceProfileId === undefined ? this.principalContext(actor) : context;
    return this.workspaceRecords().some(item => item.id === id && profileMatches(item, profile)) &&
      (actor.kind === 'user' || Boolean(this.accessFor(actor).workspace_ids?.includes(id)));
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
    if (!match) reject('workspace_forbidden', 'This directory has no workspace grant', 403);
    return { ref: { kind: 'workspace', id: match.item.id }, path: actual, root: match.root, write: match.item.write !== false };
  }

  configureWorkspace(input, context) {
    if (Object.keys(input).some(key => !['id', 'revision', 'name', 'path', 'write'].includes(key))) reject('invalid_workspace', 'Unsupported workspace setting');
    return this.store.transaction(() => {
      const id = input.id || randomUUID();
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) reject('invalid_workspace', 'Invalid workspace ID');
      const previous = this.store.get('platform-workspaces', id);
      if (previous && !profileMatches(previous, context)) reject('workspace_not_found', 'The selected workspace is unavailable', 404);
      if (previous) assertRevision(previous.revision, input.revision);
      else if (input.revision !== undefined) assertRevision(null, input.revision);
      const name = input.name ?? previous?.name;
      if (typeof name !== 'string' || !name.trim() || name.length > 120) reject('invalid_workspace', 'A workspace name is required');
      if (input.write !== undefined && typeof input.write !== 'boolean') reject('invalid_workspace', 'Invalid write authorization');
      const path = this.authorizedDirectory(input.path ?? previous?.path);
      const write = input.write ?? previous?.write ?? false;
      return this.store.save('platform-workspaces', { id, kind: 'workspace', name: name.trim(), path, write,
        workspaceProfileId: context.workspaceProfileId, revision: (previous?.revision ?? 0) + 1 });
    });
  }

  configureAccess(id, input, context) {
    if (Object.keys(input).some(key => !['revision', 'model_ids', 'workspace_ids'].includes(key))) reject('invalid_access', 'Unsupported Bot resource setting');
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
      const models = this.models.catalog().connections.filter(item => profileMatches(item, context));
      const workspaces = this.workspaceRecords().filter(item => profileMatches(item, context));
      const model_ids = input.model_ids === undefined ? previous.model_ids : validate(input.model_ids, value => models.some(model => model.id === value));
      const workspace_ids = input.workspace_ids === undefined ? previous.workspace_ids : validate(input.workspace_ids, value => workspaces.some(item => item.id === value));
      return this.store.save('platform-access', { id, model_ids, workspace_ids, revision: (previous.revision ?? 0) + 1 });
    });
  }

  canUseResources(actor, refs, context = {}) {
    return (refs || []).every(ref => this.canReadReference(ref, { ...this.principalContext(actor), ...context, actor }));
  }

  assertSessionAuthority(session, { checkWorkspacePath = false } = {}) {
    if (session.authority_revoked || session.sharing && !this.roomMembers(session.space.id).includes(session.owner.id)) {
      reject('session_authority_revoked', 'The Session no longer has its assigned execution authority', 403);
    }
    const connection = session.engine !== 'pi' ? this.store.get('platform-connections', session.engine) : null;
    const authority = this.principalContext(session.execution_actor, session.workspaceProfileId);
    if (session.engine !== 'pi' && (!profileMatches(connection, authority) || !this.connections.authorized(connection, authority.actor)) ||
        session.engine === 'pi' && session.model && !this.canUseModel(session.execution_actor, session.model.connection_id, authority) ||
        !this.canUseResources(session.execution_actor, session.resource_refs, authority)) {
      reject('session_authority_revoked', 'The Session no longer has its assigned execution resources', 403);
    }
    const oldWorkspace = session.workspace;
    if (['cli', 'codex'].includes(connection?.kind) && !oldWorkspace?.path) {
      reject('workspace_forbidden', 'This native Session has no current workspace grant', 403);
    }
    if (oldWorkspace?.path) {
      const ref = session.workspace_ref;
      const grant = this.workspaceRecords().find(item => ref?.kind === 'workspace' && item.id === ref.id && profileMatches(item, authority));
      if (!grant || !this.workspaceAvailable(ref.id, authority.actor, authority) || oldWorkspace.write && grant.write === false ||
          grant.revision !== undefined && relative(oldWorkspace.root, grant.path) !== '') {
        reject('workspace_changed', 'The fixed native workspace authority has changed', 409);
      }
      if (checkWorkspacePath) {
        const workspace = this.workspace(ref, authority);
        const canonicalPath = this.authorizedDirectory(oldWorkspace.path);
        if (canonicalPath !== oldWorkspace.path || !inside(workspace.root, canonicalPath) || workspace.root !== oldWorkspace.root ||
            oldWorkspace.write && !workspace.write) reject('workspace_changed', 'The fixed native workspace authority has changed', 409);
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
    const initiating = context.submitted_by && !sameIdentity(context.submitted_by, context.actor) ?
      this.principalContext(identity(context.submitted_by), context.workspaceProfileId) : null;
    if (!this.canUseConnection(context.actor, session.engine, context) || !this.canUseResources(context.actor, session.resource_refs, context) ||
        initiating && (!this.canUseConnection(initiating.actor, session.engine, initiating) ||
          !this.canUseResources(initiating.actor, session.resource_refs, initiating))) {
      reject('execution_resources_forbidden', 'Input requires authorization for the Session’s execution resources', 403);
    }
  }

  prepareSession(args, context, call, options) {
    if (this.draining) reject('updating', 'New execution Sessions are temporarily paused', 503);
    const { actor } = context;
    const engine = idOf(args.engine, 'connection');
    const space = args.space ?? context.session?.space ?? actor;
    if (context.session && (!this.canReadSpace(actor, space, context) || !sameRef(space, context.session.space))) {
      reject('session_scope_forbidden', 'A child Session must stay within the parent’s execution authority', 403);
    }
    const sharing = options.sharing(actor, space);
    const selected = [...(args.resource_refs || [])];
    if (selected.some(ref => !['connection', 'workspace', 'file', 'event'].includes(ref.kind))) {
      reject('invalid_resource', 'Session resources must be connections, directories, Files or Events');
    }
    const connection = this.store.get('platform-connections', engine);
    const requiresWorkspace = ['cli', 'codex'].includes(connection?.kind);
    if (requiresWorkspace && !args.workspace) reject('workspace_required', 'Choose an authorized workspace for this connection', 409);
    const workspace = this.workspace(args.workspace, context);
    if (workspace && connection?.config.workspace_root) {
      const entryRoot = this.authorizedDirectory(connection.config.workspace_root);
      if (!inside(entryRoot, workspace.path)) reject('workspace_forbidden', 'The project directory is outside the connection scope', 403);
    }
    if (workspace && sharing && !selected.some(ref => sameRef(ref, workspace.ref))) {
      reject('workspace_forbidden', 'The shared workspace must be explicitly selected as a resource', 403);
    }
    if (workspace && !selected.some(ref => sameRef(ref, workspace.ref))) selected.push(workspace.ref);
    if (sharing && engine !== 'pi') selected.push({ kind: 'connection', id: engine });
    const resource_refs = [...new Map(selected.map(ref => [keyOf(ref.kind, ref.id), ref])).values()];
    if (!this.canUseConnection(actor, engine, context) || !this.canUseResources(actor, resource_refs, context)) {
      reject('execution_resources_forbidden', 'The requested execution resources are unavailable', 403);
    }
    if (engine !== 'pi' && !connection?.enabled) reject('connection_unavailable', 'Execution connection is unavailable', 409);
    if (sharing && !this.roomMembers(space.id).every(member => resource_refs.filter(ref => ref.kind === 'file' || ref.kind === 'event')
      .every(ref => this.canReadReference(ref, this.principalContext(identity(member), context.workspaceProfileId))))) {
      reject('share_forbidden', 'The shared execution materials must be available to the Room audience', 403);
    }
    const bot = actor.kind === 'bot' ? this.getBot(actor.id) : null;
    if (sharing && connection?.kind === 'cli') reject('unsupported_sharing', 'This CLI connection cannot enforce separate shared workspace permissions', 409);
    if (engine === 'pi' && !bot) reject('pi_actor_required', 'Open a Pi Session from an authorized Bot conversation', 409);
    const model = engine === 'pi' ? (context.session?.model ?? bot.model) : null;
    if (engine === 'pi' && (!model || !this.canUseModel(actor, model.connection_id))) reject('connection_unconfigured', 'The Pi execution model is unavailable', 409);
    const binding = model ? context.session?.model_binding ?? bindModel({ connectionStore: this.models.path }, model) : null;
    return this.store.transaction(() => {
      this.resources.assertCapacity('sessions', this.activeSessions());
      const session = this.store.save(sessionRecords, { id: call.id, engine, space, owner: actor, bot_id: bot?.id ?? null,
        workspaceProfileId: context.workspaceProfileId,
        source_space: context.conversation?.space || null,
        execution_actor: actor, submitted_by: actor, model, model_binding: binding,
        instructions: sharing ? '' : context.session?.instructions ?? bot?.instructions ?? '',
        bot_revision: bot?.revision ?? null, sharing, resource_refs, workspace: workspace ? { path: workspace.path, root: workspace.root, write: workspace.write } : null,
        workspace_ref: workspace?.ref ?? null, status: 'opening', native: null, input_targets: [], input_revision: 0,
        ...(connection ? { connection_binding_version: connection.binding_version ?? 1 } : {}), ...(engine === 'pi' ? { open_call_id: call.id } : {}),
        control: activeControl(), origin_execution: context.session ? { kind: 'session', id: context.session.id } :
          context.origin?.conversation_id ? { kind: 'conversation', id: context.origin.conversation_id } : null, latest_call_id: call.id });
      this.calls.bind(call.id, { target: { kind: 'session', id: session.id }, session_id: session.id, execution_actor: actor });
      return session;
    });
  }

  activeSessions(exclude) {
    return this.store.list(sessionRecords).filter(item => item.id !== exclude &&
      !['completed', 'failed', 'stopped', 'unsupported', 'cancelled', 'not_submitted', 'idle'].includes(item.status) &&
      (item.status !== 'unknown' || item.safe_to_disconnect !== true)).length;
  }

  context(context) {
    const actor = identity(context.actor);
    const { workspaceProfileId } = this.principalContext(actor, context.workspaceProfileId);
    const origin = context.origin;
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
    return { ...context, actor, workspaceProfileId, origin, conversation, session, controls, resource_refs: session?.resource_refs ?? [] };
  }

  assertRunAllowed(input, options = {}) {
    const context = input.conversation !== undefined ? input : this.context(input);
    if (context.signal?.aborted) reject('cancelled', 'This run was interrupted', 409);
    if (this.draining && !options.allowDraining && !context.allowDraining) reject('updating', 'New autonomous work is paused for the update window', 503);
    if (context.actor.kind === 'user') return context;
    const bot = this.getBot(context.actor.id);
    if (!bot.enabled) reject('bot_paused', 'Bot is paused', 409);
    assertRevision(bot.control.control_version, context.controls.find(item => item.target.kind === 'bot')?.control_version, 'control_version');
    const target = { kind: 'conversation', id: context.conversation.id };
    const current = this.executions.require(target, context, 'input');
    this.executions.active(current, context.origin.control_version);
    if (context.session) {
      const live = this.executions.record({ kind: 'session', id: context.session.id });
      const version = context.controls.find(item => item.target.kind === 'session')?.control_version;
      this.executions.active(live, version);
      this.assertSessionAuthority(live);
      if (context.submitted_by && !sameIdentity(context.actor, context.submitted_by)) {
        const submitter = this.principalContext(identity(context.submitted_by), context.workspaceProfileId);
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
    const rooms = this.store.list('rooms').filter(room => profileMatches(room, context) && room.members.includes(context.actor.id))
      .map(room => room.id).sort();
    const access = this.accessFor(context.actor);
    const sharedConnections = this.store.list('platform-connections').filter(item => this.canUseConnection(context.actor, item.id, context))
      .map(({ id, revision }) => [id, revision]);
    const permitted = context.session?.resource_refs?.map(ref => [ref.kind, ref.id, this.canReadReference(ref, context)]) ?? [];
    const waits = this.calls.returnWaits(context.origin, context.actor);
    const revoked_return_waits = waits.filter(wait => !this.canReadReturnWait(wait, wait.target)).map(wait => wait.id).sort();
    return { actor: context.actor, resources: context.resource_refs, session: context.session, conversation: context.conversation,
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
    return { ...result, call_id, wait_refs };
  }

  async executeTool(name, args, input) {
    validateTool(name, args);
    const context = this.context(input);
    if (name === 'send_input' && args.kind === 'reply' && context.actor.kind === 'user') context.allowDraining = true;
    if (context.actor.kind === 'bot') {
      if (!readTools.has(name) && !context.call_id) reject('call_id_required', 'A writable invocation requires a host call ID', 400);
      this.assertRunAllowed(context);
    }
    if (readTools.has(name)) return { result: await this[name](args, context), call_id: null };
    if (this.draining && !(context.actor.kind === 'user' && (name === 'send' || context.allowDraining))) {
      reject('updating', 'This operation is temporarily unavailable during the update', 503);
    }
    const { record, existing } = this.calls.begin(name, context);
    if (existing) return { result: this.calls.replay(record, context), call_id: record.id };
    try {
      if (name === 'open_session' || name === 'send_input' && args.kind !== 'resume' || name === 'stop_session') {
        const result = name === 'open_session' ? await this.executions.open(args, context, record)
          : name === 'send_input' ? await this.executions.submit(args, context, record) : await this.executions.stop(args, context, record);
        this.emit('execution', { call_id: record.id });
        return { result, call_id: record.id };
      }
      if (name === 'create_bot') {
        if (context.session) reject('configuration_forbidden', 'This Session cannot create Bot identities', 403);
        const bot = await this.manager.create(`bot-${record.id}`, args, context, () => this.assertRunAllowed(context));
        this.calls.bind(record.id, { target: { kind: 'bot', id: bot.id } });
        const result = this.calls.finish(record.id, 'completed', this.manager.view(bot, context.actor));
        this.emit('bot', result);
        return { result, call_id: record.id };
      }
      const source = name === 'save_file' ? args.content_or_source?.source : null;
      let workspaceFile;
      if (source?.kind === 'workspace') {
        const workspace = this.workspace(source, context);
        const installRoot = basename(dirname(this.releaseRoot)) === 'releases' ? dirname(dirname(this.releaseRoot)) : this.releaseRoot;
        if (context.session?.workspace && context.session.workspace_ref?.id === workspace.ref.id) {
          workspace.root = context.session.workspace.path;
        }
        const delegated = context.submitted_by && !sameIdentity(context.actor, context.submitted_by) ?
          this.principalContext(identity(context.submitted_by), context.workspaceProfileId) : null;
        if (delegated && !this.workspaceAvailable(workspace.ref.id, delegated.actor, delegated)) {
          reject('workspace_forbidden', 'The original submitter does not have this workspace grant', 403);
        }
        workspaceFile = await this.files.collectWorkspaceFile(source, args.content_or_source.path, workspace, [this.dataRoot, installRoot]);
        this.assertRunAllowed(context);
        const current = this.workspace(source, context);
        if (!inside(current.root, workspaceFile.root) || delegated && !this.workspaceAvailable(workspace.ref.id, delegated.actor, delegated)) {
          reject('workspace_changed', 'Workspace authority changed while collecting the file', 409);
        }
      }
      const result = this.store.transaction(() => {
        const value = this.write(name, args, context, record, workspaceFile);
        return this.calls.finish(record.id, 'completed', value);
      });
      if (name === 'configure_bot') {
        if (result.control.state === 'paused' && result.control.stop_status === 'pending') {
          this.settleBotInBackground(result.id, result.control);
        } else this.runtime.wake();
      }
      if (name === 'configure_room') await this.revokeSessions();
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
        { id: call.id, workspaceProfileId: context.workspaceProfileId });
      this.calls.bind(call.id, { target: { kind: 'room', id: room.id } });
      return room;
    }
    if (name === 'configure_room') {
      const id = idOf(args.room, 'room');
      if (context.session) reject('room_forbidden', 'A Session cannot modify Room membership or configuration', 403);
      this.calls.bind(call.id, { target: { kind: 'room', id } });
      return this.room.configureRoom(id, { ...args, add_members: members(args.add_members), remove_members: members(args.remove_members) }, actor.id, context);
    }
    if (name === 'send') {
      const id = idOf(args.to, 'room');
      const space = { kind: 'room', id };
      if (!this.canWriteSpace(actor, space, context)) reject('room_forbidden', 'Room is not available for sending', 403);
      const attachments = args.attachments?.map(ref => normalize(ref, 'file'));
      if (context.session) for (const ref of [...(attachments || []), ...(args.references || [])]) {
        if (!this.canReadReference(ref, context)) reject('share_forbidden', 'A reference is outside this Session’s resource scope', 403);
      }
      if (actor.kind === 'bot') this.resources.acquire('message', this.resourceSource(context), { id: call.id }).finish();
      this.calls.bind(call.id, { target: space });
      const result = this.room.send(id, { ...args, attachments, reply_to: normalize(args.reply_to, 'event'), mentions: members(args.mentions),
        clientId: context.clientId }, actor.id, { callId: call.id, workspaceProfileId: context.workspaceProfileId });
      return result;
    }
    if (name === 'save_file') {
      const file = this.files.save(args, context, call.id, workspaceFile);
      this.calls.bind(call.id, { target: file.ref });
      this.emit('file', file.ref);
      return file;
    }
    if (name === 'configure_bot') {
      if (context.session) reject('configuration_forbidden', 'This Session has no Bot configuration authority', 403);
      const bot = this.manager.configure(args, context, call.id, (ref, id) => {
        if (ref.kind !== 'file' || !this.files.canRead(ref.id, context) || !this.files.canRead(ref.id, this.principalContext({ kind: 'bot', id }))) {
          reject('material_index_forbidden', 'The Bot cannot read this material index', 403);
        }
      });
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
    if (name === 'send_input' && args.kind === 'resume') {
      return this.executions.resume(args, context, call, this.executions.require(args.target, context, 'control'));
    }
    reject('tool_not_found', 'Unknown writable tool', 404);
  }

  async find({ kind, scope, query, cursor }, context) {
    const { actor } = context;
    if (scope && !this.canReadReference(scope, context)) reject('scope_unavailable', 'Search scope is unavailable', 404);
    let items;
    switch (kind) {
      case 'bot': items = this.manager.list().filter(bot => this.visibleBot(bot, context) && (!scope || scope.kind === 'room' && this.roomMembers(scope.id).includes(bot.id)))
        .map(bot => this.manager.view(bot, actor, { details: !context.session })); break;
      case 'room': items = this.room.rooms(actor.id, context).filter(room => this.canReadSpace(actor, { kind: 'room', id: room.id }, context))
        .map(room => ({ ...room, kind: 'room' })); break;
      case 'event': {
        const messages = this.room.rooms(actor.id, context).filter(room => (!scope || sameRef(scope, room.ref)) && this.canReadSpace(actor, room.ref, context))
          .flatMap(room => this.room.messages(room.id, actor.id, context));
        items = [...messages, ...this.store.list('platform-events').filter(event => this.canReadEvent(event, context) &&
          (!scope || sameRef(event.space || event.target, scope)))]; break;
      }
      case 'file': items = this.files.list(context, scope); break;
      case 'session': case 'conversation': items = this.executions.list(context, scope).filter(item => item.kind === kind); break;
      case 'connection': {
        const needle = query?.trim().toLowerCase();
        const pi = { kind: 'connection', id: 'pi', name: 'Pi', protocol: 'pi', enabled: true, available: true };
        items = (await this.connections.find(this.connectionContext(context), query)).filter(item => this.canUseConnection(actor, item.id, context));
        if (!needle || needle === 'pi') items = [pi, ...items];
        break;
      }
      case 'workspace': items = this.workspaceRecords().filter(item => this.workspaceAvailable(item.id, actor, context))
        .map(({ id, name, path, write, revision }) => ({ id, name, path, write, revision, kind: 'workspace' })); break;
      case 'wakeup': items = this.deliveries.list(context, scope); break;
      case 'call': items = this.store.list('platform-calls').filter(call => this.calls.canRead(actor, call, context) &&
        (!scope || sameRef(call.target, scope) || scope.kind === 'conversation' && call.origin?.conversation_id === scope.id))
        .map(call => this.calls.view(call, context)); break;
      case 'wait': items = this.store.list(waitRecords).filter(item => (actor.kind === 'user' || actor.id === item.bot_id) &&
        (item.workspaceProfileId ?? this.store.get(botRecords, item.bot_id)?.workspaceProfileId ?? null) === (context.workspaceProfileId ?? null) &&
        (!context.session || item.session_id === context.session.id) && (!scope || scope.kind === 'call' && item.call_id === scope.id ||
          scope.kind === 'conversation' && item.conversation_id === scope.id)).map(wait => ({ ...wait, kind: 'wait' })); break;
      case 'material_consumption': items = await this.runtime.materials.view(scope, context); break;
      default: items = [];
    }
    if (items?.items) items = items.items;
    const needle = query?.trim().toLowerCase();
    const filtered = needle && kind !== 'connection' ? items.filter(item => [item.id, item.name, item.path, item.content, item.text]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(needle))) : items;
    return page(filtered, cursor);
  }

  connectionContext(context) {
    return { ...context, allow: id => this.canUseConnection(context.actor, id, context),
      connection_ids: this.accessFor(context.actor)?.connection_ids ?? [] };
  }

  async read(args, context) {
    const { ref } = args;
    if (ref.kind === 'material_consumption') {
      const [item] = await this.runtime.materials.view(null, context, ref.id);
      if (!item) reject('object_not_found', 'Object is unavailable', 404);
      return item;
    }
    if (ref.kind === 'wait') {
      const wait = this.store.get(waitRecords, ref.id);
      const profile = wait?.workspaceProfileId ?? (wait ? this.store.get(botRecords, wait.bot_id)?.workspaceProfileId : null) ?? null;
      if (!wait || profile !== (context.workspaceProfileId ?? null) || context.actor.kind !== 'user' && wait.bot_id !== context.actor.id ||
          context.session && wait.session_id !== context.session.id) {
        reject('wait_not_found', 'Wait is unavailable', 404);
      }
      return { ...wait, kind: 'wait' };
    }
    if (!this.canReadReference(ref, context)) reject('object_not_found', 'Object is unavailable', 404);
    switch (ref.kind) {
      case 'bot': return this.manager.view(this.getBot(ref.id), context.actor, { details: !context.session });
      case 'room': return this.room.read(args, context.actor.id, context);
      case 'event': return this.store.get('platform-events', ref.id) ?? this.room.read(args, context.actor.id, context);
      case 'file': return this.files.readObject(ref.id, context, args.cursor, args.limit);
      case 'session': case 'conversation': return this.executions.read(ref, context, args);
      case 'connection': return ref.id === 'pi' ? { kind: 'connection', id: 'pi', name: 'Pi', protocol: 'pi',
        input: 'text or structured input for a new Pi conversation', operations: ['steer', 'next', 'stop'] } : this.connections.read(ref.id, this.connectionContext(context));
      case 'call': return this.calls.view(this.calls.get(ref.id), context);
      case 'wakeup': return this.deliveries.list(context).find(item => item.id === ref.id);
      case 'workspace': return this.workspaceRecords().find(item => item.id === ref.id);
      default: reject('object_not_found', 'Object is unavailable', 404);
    }
  }

  settleBotInBackground(id, control) {
    const task = (async () => {
      let status;
      try { status = (await this.runtime.stopBot(id)).status; } catch { status = 'unknown'; }
      this.manager.settleStop(id, control.stop_id, status === 'stopped' ? 'stopped' : 'unknown');
      this.emit('bot');
    })();
    this.botStops ??= new Set();
    this.botStops.add(task);
    void task.catch(error => console.error(`Summon Bot stop state could not be saved (${error.code || error.name})`))
      .finally(() => this.botStops.delete(task));
  }

  async revokeSessions() {
    const releases = [];
    for (const session of this.store.list(sessionRecords)) {
      if (session.authority_revoked) continue;
      try { this.assertSessionAuthority(session); }
      catch {
        const active = ['opening', 'submitted', 'running', 'needs_input', 'awaiting_input', 'unknown'].includes(session.status);
        const call = this.store.transaction(() => {
          const record = active ? this.calls.begin('revoke_session', { actor: user }).record : null;
          this.store.save(sessionRecords, { id: session.id, authority_revoked: true, revocation_call_id: record?.id ?? null,
            revocation_stop: active ? 'pending' : null });
          if (record) this.calls.bind(record.id, { target: { kind: 'session', id: session.id }, status: 'submitted', execution_actor: session.execution_actor });
          return record;
        });
        if (call) releases.push(this.stopRevoked(session, call));
      }
    }
    await Promise.all(releases);
  }

  async stopRevoked(session, call) {
    let outcome;
    try {
      outcome = await (session.engine === 'pi' ? this.runtime.pi.stop({ session, call }) : this.connections.stop({ session, call }));
    } catch { outcome = { status: 'unknown' }; }
    this.store.transaction(() => {
      const current = this.store.get(sessionRecords, session.id);
      if (current?.revocation_stop !== 'stopped') this.store.save(sessionRecords, { id: session.id, revocation_stop: outcome.status });
      this.calls.finish(call.id, 'completed', outcome);
    });
  }

  async tick({ observations = true, deliveries = true } = {}) {
    if (!this.draining && observations) this.deliveries.tickTime();
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
      }
    });
    for (const bot of this.manager.list()) {
      if (bot.control.state === 'paused' && bot.control.stop_status === 'pending') this.manager.settleStop(bot.id, bot.control.stop_id, 'stopped');
    }
  }
}
