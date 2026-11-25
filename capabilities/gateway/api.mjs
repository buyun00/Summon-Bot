import { avatarOf } from '../shared/validation.mjs';
import { botRecords } from '../bot-management/service.mjs';
import { listBotFolderFiles, listBotMemoryItems, previewBundledBot, readBotFolderFile, writeBotFolderFile } from '../bot-management/folders.mjs';
import { roleCatalog } from '../bot-management/roles.mjs';
import { assertRevision, page, protocolVersion, reject, user } from '../platform/contract.mjs';

const routeRef = (kind, id) => ({ kind, id: decodeURIComponent(id) });
const preservedModelSettings = '/api/model-settings';

function idempotency(header, bodyId) {
  if (header !== undefined && bodyId !== undefined && header !== bodyId) reject('client_id_conflict', 'Client request IDs do not match', 409);
  const id = header ?? bodyId;
  if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 160 || /[\p{Cc}]/u.test(id))) {
    reject('invalid_client_id', 'Invalid client request ID');
  }
  return id;
}

function scopeOf(params) {
  if (params.has('room')) return { kind: 'room', id: params.get('room') };
  if (params.has('bot')) return { kind: 'bot', id: params.get('bot') };
  if (params.has('space_kind') && params.has('space_id')) return { kind: params.get('space_kind'), id: params.get('space_id') };
  return undefined;
}

function callResponse(result, callId) {
  return callId ? { ...result, call_id: callId } : result;
}

export function createApi({ platform, room, attachments, models, exec, secrets, push, sync, historyEpoch, emit, getUsage }) {
  return async function route(method, path, params, body, clientHeader) {
    const userContext = { actor: user };
    const list = (kind, params) => platform.find({ kind, scope: scopeOf(params), query: params.get('query') || undefined,
      cursor: params.get('cursor') || undefined }, userContext);
    const read = (ref, params) => {
      const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) reject('invalid_page', 'Invalid page size');
      const revision = params.has('revision') ? Number(params.get('revision')) : undefined;
      if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) reject('invalid_revision', 'Invalid revision number');
      return platform.read({ ref, cursor: params.get('cursor') || undefined, limit,
        ...(revision !== undefined && { revision }),
        ...(ref.kind === 'workspace' && params.has('path') && { path: params.get('path') }),
        ...(ref.kind === 'workspace' && params.has('directory') && { directory: params.get('directory') }) }, userContext);
    };
    const mutation = async (name, body, clientId) => {
      const { result, call_id } = await platform.executeTool(name, body, { ...userContext, clientId });
      return callResponse(result, call_id);
    };
    const snapshot = (key, value, params) => params.get('sync') === '1' ? { ...sync.respond(key, value, params.get('since')), historyEpoch } : value;

    function saveAvatar(id, avatar, revision) {
      return platform.store.transaction(() => {
        const current = platform.getBot(id);
        if (!platform.visibleBot(current, userContext)) reject('bot_not_found', 'Bot not found', 404);
        if (revision !== undefined) assertRevision(current.revision, revision);
        const bot = platform.store.save(botRecords, { id, avatar: avatarOf(avatar, current.avatar), revision: current.revision + 1 });
        emit('bot');
        return platform.manager.view(bot, user);
      });
    }

    let match;
    const { clientId: bodyClientId, ...args } = body;
    const clientId = idempotency(clientHeader, bodyClientId);
    if (method === 'GET' && path === '/api/health') return { ok: true, service: 'summon-platform' };
    if (method === 'POST' && (match = path.match(/^\/api\/platform\/([a-z_]+)$/))) {
      if (Object.keys(args).some(key => key !== 'arguments')) reject('invalid_arguments', 'The platform request contains unsupported fields');
      return platform.executeTool(match[1], args.arguments ?? {}, { ...userContext, clientId });
    }
    if (method === 'GET' && path === '/api/state') {
      const visible = platform.listBots().filter(bot => platform.visibleBot(bot, userContext));
      const enrichBot = bot => {
        const view = platform.manager.view(bot, user);
        const memory_items = listBotMemoryItems(platform.dataRoot, bot.id);
        const folder_files = listBotFolderFiles(platform.dataRoot, bot.id);
        const activity = platform.runtime?.botActivityState?.(bot) || (bot.enabled === false ? 'paused' : 'idle');
        return { ...view, activity, memory_items, folder_files };
      };
      const enrichRoom = roomItem => {
        const room_files = platform.files.list(userContext, { kind: 'room', id: roomItem.id });
        return { ...roomItem, room_files };
      };
      const allRooms = room.rooms(user.id).map(enrichRoom);
      const state = {
        bots: visible.filter(bot => !bot.archivedAt).map(enrichBot),
        archivedBots: visible.filter(bot => Boolean(bot.archivedAt)).map(enrichBot),
        bundledBots: platform.manager.bundledCatalog(),
        roles: roleCatalog,
        rooms: allRooms.filter(item => !item.archived_at),
        archivedRooms: allRooms.filter(item => Boolean(item.archived_at)),
        modelSettings: models.summary(),
        onboarding: platform.onboardingState(),
        historyEpoch, protocolVersion,
      };
      return snapshot('state', state, params);
    }
    if (method === 'GET' && path === '/api/usage') return getUsage(params, userContext);
    if (path === '/api/push/status' && method === 'GET') return push.status();
    if (path === '/api/push/devices') {
      if (method === 'POST') return push.register(args);
      if (method === 'DELETE') return push.remove(args);
    }
    if (path === '/api/bots') {
      if (method === 'GET') return list('bot', params);
      if (method === 'POST') {
        const { avatar, ...bot } = args;
        const style = avatar ? avatarOf(avatar) : undefined;
        const result = await mutation('create_bot', bot, clientId);
        if (!style || result.reused) return result;
        const stored = platform.getBot(result.id);
        return stored.revision === result.revision ? { ...saveAvatar(result.id, style, result.revision), call_id: result.call_id } :
          { ...platform.manager.view(stored, user), call_id: result.call_id };
      }
    }
    if (path === '/api/rooms') {
      if (method === 'GET') return list('room', params);
      if (method === 'POST') return mutation('create_room', args, clientId);
    }
    if (path === '/api/bundled-bots' && method === 'GET') {
      return { items: platform.manager.bundledCatalog(), localLogins: await models.localLogins() };
    }
    if ((match = path.match(/^\/api\/bundled-bots\/([^/]+)$/)) && method === 'GET') {
      const id = decodeURIComponent(match[1]);
      const preview = previewBundledBot(platform.releaseRoot, id);
      const active = platform.manager.findByBundledId(id) || (id === 'eggbot' ? platform.manager.eggBot() : null);
      return { ...preview, installed: Boolean(active), bot_id: active?.id || null };
    }
    if (path === '/api/bundled-bots/activate' && method === 'POST') {
      if (typeof args.id !== 'string' || !args.id.trim()) reject('invalid_arguments', 'Specify a bundled Bot id');
      return platform.activateBundledBot(args.id.trim(), { roomId: args.room_id || args.roomId || null, wake: args.wake !== false });
    }
    if ((match = path.match(/^\/api\/bots\/([^/]+)\/files$/)) && method === 'GET') {
      const id = decodeURIComponent(match[1]);
      if (!platform.visibleBot(platform.getBot(id), userContext)) reject('bot_not_found', 'Bot not found', 404);
      return { bot_id: id, items: listBotFolderFiles(platform.dataRoot, id) };
    }
    if ((match = path.match(/^\/api\/bots\/([^/]+)\/file$/))) {
      const id = decodeURIComponent(match[1]);
      const bot = platform.getBot(id);
      if (!platform.visibleBot(bot, userContext)) reject('bot_not_found', 'Bot not found', 404);
      if (method === 'GET') {
        return { bot_id: id, ...readBotFolderFile(platform.dataRoot, id, params.get('path') || '') };
      }
      if (method === 'PUT' || method === 'POST') {
        const written = writeBotFolderFile(platform.dataRoot, id, args.path, args.content);
        if (written.path === 'instructions.md') {
          platform.store.save(botRecords, { id, instructions: args.content, revision: bot.revision + 1 });
        } else if (written.path === 'bot.json') {
          try {
            const parsed = JSON.parse(args.content);
            const patch = { id, revision: bot.revision + 1 };
            if (typeof parsed.name === 'string' && parsed.name.trim()) patch.name = parsed.name.trim().slice(0, 100);
            if (typeof parsed.public_duty === 'string') patch.public_duty = parsed.public_duty.trim().slice(0, 600);
            if (Array.isArray(parsed.env_slots)) patch.env_slots = parsed.env_slots;
            platform.store.save(botRecords, patch);
          } catch {}
        }
        emit('bot');
        return { bot_id: id, ...written };
      }
    }
    if ((match = path.match(/^\/api\/bots\/([^/]+)\/(archive|restore)$/))) {
      const id = decodeURIComponent(match[1]);
      if (method === 'POST') {
        return match[2] === 'archive'
          ? platform.archiveBot(id, args.revision, user)
          : platform.restoreBot(id, args.revision, user);
      }
    }
    if ((match = path.match(/^\/api\/bots\/([^/]+)$/))) {
      const bot = routeRef('bot', match[1]);
      if (method === 'GET') return read(bot, params);
      if (method === 'PATCH') {
        const { avatar, ...changes } = args;
        if (!avatar) return mutation('configure_bot', { ...changes, bot }, clientId);
        if (Object.keys(changes).some(key => key !== 'revision')) reject('invalid_arguments', 'Avatar and Bot execution settings use separate edits');
        return saveAvatar(bot.id, avatar, changes.revision);
      }
      if (method === 'DELETE') {
        return platform.deleteBot(bot.id, args.revision, user);
      }
    }
    if ((match = path.match(/^\/api\/bots\/([^/]+)\/access$/))) {
      const id = decodeURIComponent(match[1]);
      if (!platform.visibleBot(platform.getBot(id), userContext)) reject('bot_not_found', 'Bot not found', 404);
      if (method === 'GET') {
        const current = platform.accessFor({ kind: 'bot', id });
        return { id, revision: current.revision ?? 0, model_ids: current.model_ids || [], workspace_ids: current.workspace_ids || [] };
      }
      if (method === 'PATCH') {
        const prior = platform.accessFor({ kind: 'bot', id });
        const access = platform.configureAccess(id, args, userContext);
        const model_ids = (prior.model_ids || []).filter(model => !access.model_ids?.includes(model));
        const workspace_ids = (prior.workspace_ids || []).filter(workspace => !access.workspace_ids?.includes(workspace));
        const addedModels = (access.model_ids || []).filter(model => !(prior.model_ids || []).includes(model));
        const addedWorkspaces = (access.workspace_ids || []).filter(workspace => !(prior.workspace_ids || []).includes(workspace));
        if (model_ids.length || workspace_ids.length) await platform.revokeSessions({ kind: 'bot', id, model_ids, workspace_ids });
        if (addedModels.length || addedWorkspaces.length) {
          platform.runtime.resumeRecoveredRuns({ kind: 'bot_access', bot_id: id, model_ids: addedModels, workspace_ids: addedWorkspaces });
        }
        emit('bot');
        return access;
      }
    }
    if ((match = path.match(/^\/api\/rooms\/([^/]+)\/(archive|restore)$/))) {
      const id = decodeURIComponent(match[1]);
      if (method === 'POST') {
        return match[2] === 'archive'
          ? platform.archiveRoom(id, args.revision, user)
          : platform.restoreRoom(id, args.revision, user);
      }
    }
    if ((match = path.match(/^\/api\/rooms\/([^/]+)\/stop$/)) && method === 'POST') {
      return platform.stopRoom(decodeURIComponent(match[1]), user);
    }
    if ((match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(messages)(\/receipt)?)?$/))) {
      const ref = routeRef('room', match[1]);
      if (method === 'GET' && match[3]) return room.receipt(ref.id, params.get('clientId'), user.id);
      if (method === 'GET') {
        const result = await read(ref, params);
        const activities = platform.runtime?.roomActivities?.(ref.id) || [];
        const suspendedRuns = platform.runtime.suspendedRunsForRoom(ref.id);
        const value = { ...result, activities, suspendedRuns, historyEpoch };
        return match[2] ? snapshot('room:' + ref.id, value, params) : value;
      }
      if (method === 'POST' && match[2] && !match[3]) return mutation('send', { ...args, to: ref }, clientId);
      if (method === 'PATCH' && !match[2]) return mutation('configure_room', { ...args, room: ref }, clientId);
      if (method === 'DELETE' && !match[2]) {
        const result = room.deleteGroup(ref.id, args.revision, user);
        emit('room');
        await platform.revokeSessions(ref);
        platform.runtime.wake();
        return result;
      }
    }
    if (path === '/api/wakeups') {
      if (method === 'GET') return list('wakeup', params);
      if (method === 'POST') return mutation('set_wakeup', args, clientId);
    }
    if ((match = path.match(/^\/api\/wakeups\/([^/]+)$/)) && method === 'DELETE') {
      return platform.deliveries.remove(decodeURIComponent(match[1]), args.revision, userContext);
    }
    if (path === '/api/executions' && method === 'GET') {
      const scope = scopeOf(params);
      if (scope && !platform.canReadReference(scope, userContext)) reject('scope_unavailable', 'Search scope is unavailable', 404);
      return page(platform.executions.list(userContext, scope), params.get('cursor') || undefined);
    }
    if (path === '/api/events' && method === 'GET') return list('event', params);
    if (method === 'GET' && (match = path.match(/^\/api\/events\/([^/]+)\/deliveries$/))) {
      const ref = routeRef('event', match[1]);
      if (!platform.canReadReference(ref, userContext)) reject('object_not_found', 'Event is unavailable', 404);
      return { event: ref, deliveries: platform.eventDeliveries(ref.id) };
    }
    if (method === 'GET' && (match = path.match(/^\/api\/events\/([^/]+)$/))) return read(routeRef('event', match[1]), params);
    if (method === 'POST') {
      if (path === '/api/executions') return mutation('open_session', args, clientId);
      if (path === '/api/executions/input') return mutation('send_input', args, clientId);
      if (path === '/api/executions/stop') return mutation('stop_session', args, clientId);
      if (path === '/api/executions/retry') return platform.retryExecution(args, user);
    }
    if (method === 'GET' && (match = path.match(/^\/api\/executions\/(session|conversation)\/([^/]+)$/))) return read(routeRef(match[1], match[2]), params);
    if (path === '/api/files') {
      if (method === 'GET') return list('file', params);
      if (method === 'POST') return mutation('save_file', args, clientId);
    }
    if ((match = path.match(/^\/api\/files\/([^/]+)(\/download)?$/))) {
      const ref = routeRef('file', match[1]);
      if (['GET', 'HEAD'].includes(method) && match[2]) {
        const revParam = params.get('revision');
        const rev = revParam != null && revParam !== '' ? Number(revParam) : undefined;
        if (rev !== undefined && (!Number.isSafeInteger(rev) || rev < 1)) {
          reject('invalid_arguments', 'File revision must be a positive integer');
        }
        return platform.files.download(ref.id, userContext, rev);
      }
      if (method === 'GET' && !match[2]) return read(ref, params);
    }
    if (path === '/api/attachments' && method === 'POST') {
      const { record, existing } = platform.calls.begin('upload_attachment', { ...userContext, clientId });
      if (existing && record.status !== 'prepared') return platform.calls.replay(record, userContext);
      try {
        const result = await attachments.upload(args, { ownerId: user.id, id: record.id });
        return platform.calls.finish(record.id, 'completed', result);
      } catch (error) { platform.calls.fail(record.id, error); throw error; }
    }
    if (['GET', 'HEAD'].includes(method) && (match = path.match(/^\/api\/attachments\/([^/]+)(?:\/(preview|view))?$/))) {
      const id = decodeURIComponent(match[1]);
      room.attachment(id, user.id);
      const file = await attachments.read(id, match[2] === 'view' ? 'view' : match[2] === 'preview');
      room.attachment(id, user.id);
      return file;
    }
    if (path === '/api/workspaces') {
      if (method === 'GET') return list('workspace', params);
      if (method === 'POST') return platform.configureWorkspace(args);
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)\/file$/))) {
      const ref = routeRef('workspace', match[1]);
      if (['GET', 'HEAD'].includes(method)) {
        const filePath = params.get('path') || '';
        return platform.streamWorkspaceFile(ref.id, filePath, userContext, { preview: params.get('preview') === '1' });
      }
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)$/))) {
      const ref = routeRef('workspace', match[1]);
      if (method === 'GET') return read(ref, params);
      if (method === 'PATCH') {
        const prior = platform.workspaceRecords().find(workspace => workspace.id === ref.id);
        const result = platform.configureWorkspace({ ...args, id: ref.id }, userContext);
        if (prior && (prior.path !== result.path || prior.write !== false && !result.write)) await platform.revokeSessions(ref);
        if (!prior || prior.path !== result.path || (prior.write === false && result.write !== false)) {
          platform.runtime.resumeRecoveredRuns({ kind: 'workspace', id: ref.id });
        }
        return result;
      }
    }
    if (path === '/api/onboarding' && method === 'GET') return platform.onboardingState();
    if (path === '/api/onboarding/start' && method === 'POST') {
      return platform.startOnboarding({ activateBundled: args.activateBundled || args.activate_bundled || null });
    }
    if (path === '/api/onboarding/finish' && method === 'POST') {
      return platform.finishOnboarding();
    }
    if (path === preservedModelSettings && method === 'GET') return models.snapshot();
    if (path === preservedModelSettings + '/local' && method === 'GET') return models.localLogins();
    if (path === preservedModelSettings + '/local/import' && method === 'POST') {
      const result = await models.importLocal(args.kind, { activate: args.activate === true });
      platform.initializeDefaults();
      platform.runtime.resumeRecoveredRuns({ kind: 'model', id: result?.importedId || null });
      return result;
    }
    if (path === preservedModelSettings + '/connections' && method === 'POST') {
      const result = await models.save(args);
      if (args.activate === true) platform.initializeDefaults();
      platform.runtime.resumeRecoveredRuns({ kind: 'model', id: result?.savedId || args?.id || null });
      return result;
    }
    if (path === preservedModelSettings + '/purposes' && method === 'POST') {
      const result = await models.savePurposes(args);
      platform.runtime.resumeRecoveredRuns({ kind: 'model', id: null });
      return result;
    }
    if (path === preservedModelSettings + '/active' && method === 'POST') {
      const result = await models.select(args.id);
      platform.initializeDefaults();
      platform.runtime.resumeRecoveredRuns({ kind: 'model', id: args.id || null });
      return result;
    }
    if (path === preservedModelSettings + '/usage' && method === 'POST') return models.refreshUsage(args.force === true);
    if (path === preservedModelSettings + '/usage' && method === 'GET') return models.summary();
    if ((match = path.match(/^\/api\/model-settings\/connections\/([^/]+)(?:\/(login|models|test))?$/))) {
      const [, encoded, action] = match;
      const id = decodeURIComponent(encoded);
      models.requireConnection(models.catalog(), id);
      if (method === 'DELETE' && !action) {
        const result = await models.remove(id);
        await platform.revokeSessions({ kind: 'model', id });
        return result;
      }
      if (action === 'models' && method === 'GET') return models.choices(id, params.get('discover') === '1');
      if (action === 'login' && method === 'GET') return models.loginStatus(id);
      if (action === 'login' && method === 'POST') return models.startLogin(id);
      if (action === 'login' && method === 'DELETE') { models.cancelLogin(id); return models.loginStatus(id); }
      if (action === 'test' && method === 'POST') return models.testConnection(id);
    }
    if (path === '/api/secrets/env' && method === 'GET') return secrets.listEnvKeys();
    if ((match = path.match(/^\/api\/secrets\/env\/([^/]+)$/)) && method === 'DELETE') {
      return secrets.deleteEnvSecret(decodeURIComponent(match[1]));
    }
    if (path === '/api/secrets/deliver' && method === 'POST') return secrets.deliver(args, clientId);
    if (method === 'GET' && (match = path.match(/^\/api\/calls\/([^/]+)$/))) return read(routeRef('call', match[1]), params);
    return undefined;

  };
}
