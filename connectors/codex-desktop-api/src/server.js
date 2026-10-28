import { assertAuthorization } from './auth.js';
import { normalizeUsage } from './app-tools.js';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ApiError, publicError } from './errors.js';
import * as v from './validate.js';
import { assertBrowserOrigin, serveConsole } from './console.js';

function json(response, status, data, extra = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  response.end(JSON.stringify(data));
}
async function readBody(request) {
  if (!(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'json_required', 'Use Content-Type: application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new ApiError(413, 'body_too_large', 'JSON body exceeds 1 MiB.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'invalid_json', 'Invalid JSON request body.'); }
}
function query(url, allowed) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key)) v.bad(`Unknown query parameter: ${key}`);
}
function intQuery(url, key, fallback, min, max) { return url.searchParams.has(key) ? v.integer(Number(url.searchParams.get(key)), key, min, max) : fallback; }
function boolQuery(url, key, fallback) {
  if (!url.searchParams.has(key)) return fallback;
  const value = url.searchParams.get(key); if (!['true', 'false'].includes(value)) v.bad(`${key} must be true or false.`);
  return value === 'true';
}

export function createServer({ config, tools, broker, store, openapi }) {
  const inFlight = new Set();
  const pendingOperations = new Set();
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const requestId = randomUUID(); response.setHeader('X-Request-ID', requestId);
    try {
      const url = new URL(request.url, 'http://localhost');
      if (serveConsole(request, response, url, openapi)) return;
      if (request.method === 'GET' && url.pathname === '/healthz') { json(response, 200, { service: 'codex-desktop-api', version: '0.1.0', status: 'ok' }); return; }
      assertAuthorization(request, response, config);
      assertBrowserOrigin(request, config);
      if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
        let available = true, error = null;
        try { await tools.connect(); } catch (failure) { available = false; error = failure.message; }
        json(response, 200, {
          version: '0.1.0', adapter: 'codex-desktop-windows', desktopConnected: available,
          contextConfigured: !!config.callerThreadId, protocol: { type: 'private_desktop_ipc', expectedStreamVersion: 11, observedStreamVersion: broker.protocolVersion, testedDesktopVersion: '26.1021.3705.0' },
          features: { listThreads: available && tools.catalog.some(x => x.name === 'list_threads'), readHistory: available && tools.catalog.some(x => x.name === 'read_thread'), createThread: available && tools.catalog.some(x => x.name === 'create_thread'), sendMessage: available && tools.catalog.some(x => x.name === 'send_message_to_thread'), liveEvents: !!broker.ipc.pipe?.connected && broker.protocolVersion === 11, interrupt: broker.protocolVersion === 11, rename: available, archive: available },
          discovery: { recentLimit: config.discoveryLimit, includesPinned: true, liveSubscriptions: broker.subscriptions.size, maxSubscriptions: config.maxSubscriptions, lastPollAt: broker.lastPollAt ?? null },
          limits: { messageChars: 100000, bodyBytes: 1048576, historyOutputCharsPerItem: 20000, retainedEventCount: config.eventRetention },
          history: { source: 'desktop_read_thread', summarized: true, mayTruncateOutputs: true },
          error: error || broker.lastError,
        }); return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/openapi.json') { json(response, 200, openapi); return; }
      if (request.method === 'GET' && url.pathname === '/v1/account/usage') { query(url, []); json(response, 200, normalizeUsage(await tools.call('get_usage_limits'))); return; }
      if (request.method === 'GET' && url.pathname === '/v1/projects') { query(url, []); json(response, 200, await tools.call('list_projects')); return; }
      if (request.method === 'GET' && url.pathname === '/v1/threads') {
        query(url, ['limit', 'status']);
        const limit = intQuery(url, 'limit', 50, 1, 50);
        const data = await tools.call('list_threads', { limit });
        if (url.searchParams.has('status')) {
          const status = url.searchParams.get('status');
          data.threads = data.threads?.filter(thread => thread.status === status);
          data.pinnedThreads = data.pinnedThreads?.filter(thread => thread.status === status);
        }
        json(response, 200, { ...data, observedAt: new Date().toISOString(), source: 'desktop_tools', coverage: { recentLimit: limit, includesPinned: true, exhaustive: false } }); return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/threads/archived') {
        query(url, ['limit', 'cursor', 'hostId']);
        json(response, 200, await tools.call('list_archived_threads', { limit: intQuery(url, 'limit', 20, 1, 50), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}), ...(url.searchParams.has('hostId') ? { hostId: v.hostId(url.searchParams.get('hostId')) } : {}) })); return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/events') {
        query(url, ['threadId', 'hostId', 'after']);
        const threadId = url.searchParams.has('threadId') ? v.threadId(url.searchParams.get('threadId')) : null;
        const hostId = v.hostId(url.searchParams.get('hostId') || 'local');
        if (!threadId && url.searchParams.has('hostId')) v.bad('hostId requires threadId.');
        let initialState;
        if (threadId) initialState = await broker.state(threadId, hostId);
        const cursor = request.headers['last-event-id'] ?? url.searchParams.get('after');
        const events = cursor != null ? store.replay(v.integer(Number(cursor), 'Last-Event-ID', 0, Number.MAX_SAFE_INTEGER), threadId, hostId) : [];
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        response.write('retry: 2000\n\n');
        const send = event => {
          if (response.destroyed) return;
          if (response.writableLength > 4 * 1024 * 1024) { response.destroy(); return; }
          response.write(`${event.id != null ? `id: ${event.id}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const listener = event => { if (!threadId || (event.threadId === threadId && event.hostId === hostId) || event.type.startsWith('desktop.')) send(event); };
        // No await between journal read, listener registration, and replay.
        broker.on('event', listener);
        for (const event of events) send(event);
        send({ type: 'stream.ready', data: { cursor: store.bounds().last || 0, threadId, hostId, replayed: events.length } });
        if (initialState) send({ type: 'thread.snapshot', threadId, hostId, data: initialState });
        else for (const slot of broker.subscriptions.values()) if (slot.normalized && !slot.stale) send({ type: 'thread.snapshot', threadId: slot.threadId, hostId: slot.hostId, data: slot.normalized });
        const slot = threadId ? broker.subscriptions.get(broker.key(threadId, hostId)) : null;
        if (slot) slot.listeners = (slot.listeners || 0) + 1;
        const heartbeat = setInterval(() => {
          if (response.writableLength > 4 * 1024 * 1024) response.destroy();
          else response.write(': heartbeat\n\n');
        }, 15000); heartbeat.unref();
        response.on('close', () => { clearInterval(heartbeat); broker.off('event', listener); if (slot) { slot.listeners--; slot.usedAt = Date.now(); } });
        return;
      }
      const operationMatch = url.pathname.match(/^\/v1\/operations\/([A-Za-z0-9._:-]+)$/);
      if (operationMatch && request.method === 'GET') { json(response, 200, store.operation(operationMatch[1])); return; }
      const threadMatch = url.pathname.match(/^\/v1\/threads\/([^/]+)(?:\/(messages|state|interrupt|archive|unarchive|read-state))?$/);
      const id = threadMatch ? v.threadId(threadMatch[1]) : null;
      const suffix = threadMatch?.[2];
      if (id && request.method === 'GET' && (!suffix || ['messages', 'state'].includes(suffix))) {
        query(url, suffix === 'state' ? ['hostId'] : ['hostId', 'cursor', 'limit', 'includeOutputs', 'maxOutputCharsPerItem']);
        const hostId = v.hostId(url.searchParams.get('hostId') || 'local');
        if (suffix === 'state') { json(response, 200, await broker.state(id, hostId)); return; }
        const data = await tools.call('read_thread', { threadId: id, hostId, turnLimit: intQuery(url, 'limit', suffix ? 3 : 1, 1, 10), includeOutputs: boolQuery(url, 'includeOutputs', true), maxOutputCharsPerItem: intQuery(url, 'maxOutputCharsPerItem', 4000, 0, 20000), ...(url.searchParams.has('cursor') ? { cursor: url.searchParams.get('cursor') } : {}) });
        // Desktop exposes summary/history items, not private model reasoning.
        if (Array.isArray(data.turns)) data.turns = data.turns.map(turn => ({ ...turn, items: turn.items?.filter(item => item.type !== 'reasoning') }));
        json(response, 200, { ...data, source: 'desktop_tools', observedAt: new Date().toISOString(), historyIsSummary: true }); return;
      }
      let action;
      if (request.method === 'POST' && url.pathname === '/v1/threads') {
        query(url, []); const body = v.createBody(await readBody(request));
        action = { body, run: async () => ({ status: 201, body: await tools.call('create_thread', body) }) };
      } else if (id && request.method === 'POST' && suffix === 'messages') {
        query(url, []); const body = v.object(await readBody(request), ['message', 'hostId', 'model', 'thinking']);
        v.string(body.message, 'message', 100000); const hostId = v.hostId(body.hostId); v.modelOptions(body);
        action = { body, lock: `${hostId}:${id}`, run: async () => ({ status: 202, body: await tools.call('send_message_to_thread', { threadId: id, hostId, prompt: body.message, ...(body.model ? { model: body.model } : {}), ...(body.thinking ? { thinking: body.thinking } : {}) }) }) };
      } else if (id && request.method === 'POST' && suffix === 'interrupt') {
        query(url, []); const body = v.object(await readBody(request), ['hostId', 'expectedTurnId']);
        v.string(body.expectedTurnId, 'expectedTurnId', 128); const hostId = v.hostId(body.hostId);
        action = { body, lock: `${hostId}:${id}`, run: async () => ({ status: 200, body: await broker.interrupt(id, hostId, body.expectedTurnId) }) };
      } else if (id && request.method === 'PATCH' && !suffix) {
        query(url, []); const body = v.object(await readBody(request), ['title']); v.string(body.title, 'title', 200);
        action = { body, lock: `local:${id}`, run: async () => ({ status: 200, body: await tools.call('set_thread_title', { threadId: id, title: body.title }) }) };
      } else if (id && request.method === 'POST' && ['archive', 'unarchive', 'read-state'].includes(suffix)) {
        query(url, []); const body = v.object(await readBody(request), suffix === 'read-state' ? ['hostId', 'read'] : ['hostId']); const hostId = v.hostId(body.hostId);
        if (suffix === 'read-state') v.boolean(body.read, 'read');
        action = { body, lock: `${hostId}:${id}`, run: async () => ({ status: 200, body: await tools.call(suffix === 'read-state' ? 'set_thread_read_state' : 'set_thread_archived', { threadId: id, hostId, ...(suffix === 'read-state' ? { read: body.read } : { archived: suffix === 'archive' }) }) }) };
      }
      if (!action) throw new ApiError(404, 'not_found', 'API route not found.');
      const operation = store.mutate(request.headers['idempotency-key'], { method: request.method, path: url.pathname, body: action.body }, async () => {
        if (action.lock && inFlight.has(action.lock)) throw new ApiError(409, 'thread_busy', 'Another API operation is in flight for this thread.');
        if (action.lock) inFlight.add(action.lock);
        try { return await action.run(); } finally { if (action.lock) inFlight.delete(action.lock); }
      });
      pendingOperations.add(operation);
      let result;
      try { result = await operation; } finally { pendingOperations.delete(operation); }
      json(response, result.status, result.body, { 'Idempotency-Replayed': String(result.replayed) });
    } catch (error) {
      if (!response.headersSent) json(response, error.status || 500, { error: publicError(error), requestId });
      else response.destroy();
      if (!error.status) console.error(JSON.stringify({ level: 'error', requestId, message: error.message }));
    }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.headersTimeout = 10000; server.requestTimeout = 15000;
  server.stop = async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await Promise.allSettled([...pendingOperations]); };
  return server;
}
