import { avatarOf } from '../shared/validation.mjs';
import { botRecords } from '../bot-management/service.mjs';
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

export function createApi({ platform, room, attachments, models, connections, push, sync, historyEpoch, emit, getUsage }) {
  return async function route(method, path, params, body, clientHeader) {
    const userContext = { actor: user };
    const list = (kind, params) => platform.find({ kind, scope: scopeOf(params), query: params.get('query') || undefined,
      cursor: params.get('cursor') || undefined }, userContext);
    const read = (ref, params) => {
      const limit = params.has('limit') ? Number(params.get('limit')) : undefined;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) reject('invalid_page', 'Invalid page size');
      return platform.read({ ref, cursor: params.get('cursor') || undefined, limit,
        ...(ref.kind === 'workspace' && params.has('path') && { path: params.get('path') }) }, userContext);
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
      const state = { bots: platform.listBots().filter(bot => platform.visibleBot(bot, userContext)).map(bot => platform.manager.view(bot, user)),
        rooms: room.rooms(user.id),
        modelSettings: models.summary(), historyEpoch, limits: platform.resources.limits, protocolVersion };
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
    if ((match = path.match(/^\/api\/bots\/([^/]+)$/))) {
      const bot = routeRef('bot', match[1]);
      if (method === 'GET') return read(bot, params);
      if (method === 'PATCH') {
        const { avatar, ...changes } = args;
        if (!avatar) return mutation('configure_bot', { ...changes, bot }, clientId);
        if (Object.keys(changes).some(key => key !== 'revision')) reject('invalid_arguments', 'Avatar and Bot execution settings use separate edits');
        return saveAvatar(bot.id, avatar, changes.revision);
      }
    }
    if ((match = path.match(/^\/api\/bots\/([^/]+)\/access$/))) {
      const id = decodeURIComponent(match[1]);
      if (!platform.visibleBot(platform.getBot(id), userContext)) reject('bot_not_found', 'Bot not found', 404);
      if (method === 'GET') {
        const current = platform.accessFor({ kind: 'bot', id });
        return { id, revision: current.revision ?? 0, model_ids: current.model_ids || [], workspace_ids: current.workspace_ids || [],
          execution_onboarding: current.execution_onboarding ?? null };
      }
      if (method === 'PATCH') {
        const prior = platform.accessFor({ kind: 'bot', id });
        const access = platform.configureAccess(id, args, userContext);
        const model_ids = (prior.model_ids || []).filter(model => !access.model_ids?.includes(model));
        const workspace_ids = (prior.workspace_ids || []).filter(workspace => !access.workspace_ids?.includes(workspace));
        if (model_ids.length || workspace_ids.length) await platform.revokeSessions({ kind: 'bot', id, model_ids, workspace_ids });
        emit('bot');
        return access;
      }
    }
    if ((match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(messages)(\/receipt)?)?$/))) {
      const ref = routeRef('room', match[1]);
      if (method === 'GET' && match[3]) return room.receipt(ref.id, params.get('clientId'), user.id);
      if (method === 'GET') {
        const result = await read(ref, params);
        const deliveries = Object.fromEntries(result.messages.map(item => [item.id, platform.hostMessageDeliveries(item.id)]));
        const summaries = room.messageSummaries(ref.id, result.messages.map(item => item.id));
        const value = { ...result, deliveries, summaries, historyEpoch };
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
    }
    if (method === 'GET' && (match = path.match(/^\/api\/executions\/(session|conversation)\/([^/]+)$/))) return read(routeRef(match[1], match[2]), params);
    if (path === '/api/files') {
      if (method === 'GET') return list('file', params);
      if (method === 'POST') return mutation('save_file', args, clientId);
    }
    if ((match = path.match(/^\/api\/files\/([^/]+)(\/download)?$/))) {
      const ref = routeRef('file', match[1]);
      if (['GET', 'HEAD'].includes(method) && match[2]) return platform.files.download(ref.id, userContext);
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
    if (path === '/api/connections') {
      if (method === 'GET') {
        const usage = platform.resources.snapshot();
        const items = connections.settings(userContext);
        const result = { ...await list('connection', params), limits: usage.limits, limits_revision: platform.resources.readLimits().revision, usage };
        return { ...result, items: result.items.map(item => ({ ...item, ...items.find(connection => connection.id === item.id) })) };
      }
      if (method === 'POST') return platform.configureExecutionConnection(args, userContext);
    }
    if (path === '/api/connections/initialize' && method === 'POST') return platform.startConnectionSetup(args, userContext, clientId);
    if (path === '/api/connections/usage' && method === 'GET') {
      const period = params.has('from') || params.has('to') ? { from: params.get('from'), to: params.get('to') } :
        params.get('period') ?? undefined;
      return platform.find({ kind: 'connection_usage', scope: scopeOf(params), period, query: params.get('query') || undefined,
        cursor: params.get('cursor') || undefined }, userContext);
    }
    if (path === '/api/connections/limits') {
      if (method === 'GET') return platform.resources.readLimits();
      if (method === 'PATCH') {
        if (Object.keys(args).some(key => key !== 'revision' && key !== 'limits')) reject('invalid_resource_limit', 'Unsupported host resource setting');
        const result = platform.resources.configure(args);
        platform.runtime?.releaseResourceLimitRetries?.();
        emit('connection');
        return result;
      }
    }
    if ((match = path.match(/^\/api\/connections\/([^/]+)$/))) {
      const ref = routeRef('connection', match[1]);
      if (method === 'GET') return read(ref, params);
      if (method === 'PATCH') return platform.configureExecutionConnection({ ...args, id: ref.id }, userContext);
    }
    if (path === '/api/workspaces') {
      if (method === 'GET') return list('workspace', params);
      if (method === 'POST') return platform.configureWorkspace(args);
    }
    if ((match = path.match(/^\/api\/workspaces\/([^/]+)$/))) {
      const ref = routeRef('workspace', match[1]);
      if (method === 'GET') return read(ref, params);
      if (method === 'PATCH') {
        const prior = platform.workspaceRecords().find(workspace => workspace.id === ref.id);
        const result = platform.configureWorkspace({ ...args, id: ref.id }, userContext);
        if (prior && (prior.path !== result.path || prior.write !== false && !result.write)) await platform.revokeSessions(ref);
        return result;
      }
    }
    if (path === preservedModelSettings && method === 'GET') return models.snapshot();
    if (path === preservedModelSettings + '/local' && method === 'GET') return models.localLogins();
    if (path === preservedModelSettings + '/local/import' && method === 'POST') return models.importLocal(args.kind);
    if (path === preservedModelSettings + '/connections' && method === 'POST') return models.save(args);
    if (path === preservedModelSettings + '/purposes' && method === 'POST') return models.savePurposes(args);
    if (path === preservedModelSettings + '/active' && method === 'POST') {
      const result = await models.select(args.id);
      platform.initializeDefaults();
      return result;
    }
    if (path === preservedModelSettings + '/usage' && method === 'POST') return models.refreshUsage(args.force === true);
    if (path === preservedModelSettings + '/usage' && method === 'GET') return models.summary();
    if ((match = path.match(/^\/api\/model-settings\/connections\/([^/]+)(?:\/(login|models))?$/))) {
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
    }
    if (method === 'GET' && (match = path.match(/^\/api\/calls\/([^/]+)$/))) return read(routeRef('call', match[1]), params);
    return undefined;

  };
}
