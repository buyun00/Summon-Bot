import http from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeBotConfig, createRedactor } from './config.mjs';
import { acquireIdentityLock } from './identity-lock.mjs';
import { BotStore, terminalTaskStates } from '../storage/store.mjs';
import { saveArtifact } from '../storage/artifacts.mjs';
import { BotEngine } from '../agent/engine.mjs';
import { coreTools } from '../capabilities/core-tools.mjs';
import { requestBot, sendMessage } from '../messaging/client.mjs';

const at = () => new Date().toISOString();
const failure = (status, message, code) => Object.assign(new Error(message), { status, code });
const tokenEquals = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function atomicJson(path, data) { const temp = `${path}.${randomUUID()}.tmp`; await writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); await rename(temp, path); }
async function readBody(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) { if ((size += chunk.length) > 8 * 1024 * 1024) throw failure(413, 'Request exceeds 8 MiB'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw failure(400, 'Invalid JSON'); }
}

/** A single mandatory Pi engine behind an authenticated, durable Bot API. */
export async function startBot(input) {
  const config = normalizeBotConfig(input), bootId = randomUUID(), startedAt = at();
  let state = 'loading', url = null, readyAt = null, store, engine, server, closing;
  const jobs = new Map(), subscribers = new Set();
  await mkdir(config.dataDir, { recursive: true });
  const identity = () => ({ botId: config.botId, instanceId: config.botId, pid: process.pid, bootId, url, state, startedAt, readyAt });
  const lock = await acquireIdentityLock(config.dataDir, identity);
  try {
    await mkdir(config.workspace, { recursive: true }); await mkdir(join(config.dataDir, 'run'), { recursive: true });
    const privatePath = join(config.dataDir, 'config.json');
    if (!config.token) {
      try { const prior = JSON.parse(await readFile(privatePath, 'utf8')); if (prior.botId === config.botId) config.token = prior.token; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      config.token ||= randomBytes(32).toString('hex');
    }
    if (config.peers.some(peer => tokenEquals(peer.token, config.token))) throw new Error('Peer token must differ from management token');
    await atomicJson(privatePath, config);
    const clean = createRedactor(config);
    store = new BotStore(join(config.dataDir, 'state.sqlite'));
    store.recover(bootId);
    store.onEvent = event => { for (const listener of subscribers) { try { listener(event); } catch {} } };
    const emit = (type, payload, refs = {}) => store.appendEvent(type, clean(payload), refs);
    const contactFor = botId => { const value = config.contacts.find(contact => contact.botId === botId); if (!value) throw failure(404, `Unknown configured contact ${botId}`); return value; };
    const taskDetails = id => { const value = store.getTask(id); return value && { ...value, tools: store.listTools(id) }; };
    const services = {
      store,
      async send(to, envelope, { signal, taskId } = {}) {
        const contact = contactFor(to), id = envelope.id || randomUUID(), key = `${to}:${id}`;
        const previous = store.getOutbox(key);
        const message = { ...envelope, id, to, from: config.botId, kind: envelope.kind || 'request' };
        if (previous && JSON.stringify(previous.message) !== JSON.stringify(clean(message))) throw failure(409, 'Message ID already belongs to another payload');
        if (previous?.receipt) return previous.receipt;
        store.saveOutbox({ id: key, message: clean(message), taskId, to, status: 'sending', createdAt: previous?.createdAt || at() });
        try {
          const receipt = await sendMessage(contact, message, { signal });
          store.saveOutbox({ id: key, status: 'accepted', receipt: clean(receipt) }); return receipt;
        } catch (error) { store.saveOutbox({ id: key, status: 'unknown', error: clean({ message: error.message }) }); throw error; }
      },
      getTask(id, botId, signal) { return botId && botId !== config.botId ? requestBot(contactFor(botId), `/tasks/${encodeURIComponent(id)}`, { signal }) : taskDetails(id); },
      coreTools(task) { return coreTools(services, task); },
      toolContext(task) { return { saveArtifact: async input => {
        const artifact = await saveArtifact(join(config.dataDir, 'artifacts'), input, { botId: config.botId, taskId: task.id, runId: task.id, sessionId: task.sessionId, createdAt: at() });
        store.saveArtifact(artifact); emit('artifact.created', { artifact }, { taskId: task.id }); return artifact;
      } }; },
    };
    engine = new BotEngine({ config, store, emit, services, clean });
    let dispatch = Promise.resolve();
    const schedule = task => {
      const controller = new AbortController();
      const promise = dispatch.catch(() => {}).then(async () => {
        if (controller.signal.aborted) return;
        store.updateTask(task.id, { status: 'running', startedAt: at() });
        try { const result = await engine.run(task, { signal: controller.signal }); store.updateTask(task.id, { status: 'completed', result, finishedAt: at() }); }
        catch (error) { store.updateTask(task.id, { status: controller.signal.aborted ? (state === 'stopping' ? 'interrupted' : 'cancelled') : 'failed',
          error: clean({ name: error.name, code: error.code, message: error.message }), finishedAt: at() }); }
      }).finally(() => jobs.delete(task.id));
      jobs.set(task.id, { controller, promise }); dispatch = promise;
    };
    const cancel = id => {
      const task = store.getTask(id); if (!task) throw failure(404, 'Unknown task');
      if (terminalTaskStates.has(task.status)) return task;
      store.updateTask(id, { cancelRequested: true }); jobs.get(id)?.controller.abort(new Error('Task cancelled'));
      if (task.status === 'accepted') store.updateTask(id, { status: 'cancelled', finishedAt: at() });
      return store.getTask(id);
    };
    const health = () => ({ ...identity(), engine: engine.health(), tasks: store.listTasks({ limit: 10000 }).length });
    const close = () => closing ||= (async () => {
      state = 'stopping'; emit('bot.stopping', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity());
      // Graceful shutdown stops only this Bot. Contacts remain independent.
      for (const [id, job] of jobs) { job.controller.abort(new Error('Bot is stopping')); const task = store.getTask(id);
        if (task?.status === 'accepted') store.updateTask(id, { status: 'interrupted', error: { code: 'BOT_STOPPED', message: 'Accepted task did not execute; no automatic replay' }, finishedAt: at() }); }
      await engine.close(); await Promise.allSettled([...jobs.values()].map(job => job.promise));
      if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      state = 'stopped'; emit('bot.stopped', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity()); store.close(); await lock.close();
    })();
    const authenticate = request => {
      const token = request.headers.authorization?.replace(/^Bearer /, '');
      if (tokenEquals(token, config.token)) return { admin: true, source: 'controller' };
      const peer = config.peers.find(value => tokenEquals(value.token, token));
      if (peer) return { admin: false, source: peer.botId };
      throw failure(401, 'Authentication required');
    };
    const route = async (request, response) => {
      const auth = authenticate(request), parsed = new URL(request.url, 'http://bot.local');
      const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent), method = request.method;
      const needAdmin = () => { if (!auth.admin) throw failure(403, 'Management access required'); };
      const ownTask = id => { const task = taskDetails(id); if (!task || (!auth.admin && task.source !== auth.source)) throw failure(404, 'Unknown task'); return task; };
      if (method === 'GET' && parts[0] === 'health') return health();
      if (method === 'GET' && parts[0] === 'capabilities') return { botId: config.botId, protocol: 'relay-bot-v1', engine: engine.health(), messages: true, tasks: true, state: true, memories: true };
      if (method === 'POST' && parts[0] === 'messages') {
        if (state !== 'ready') throw failure(503, `Bot is ${state}`);
        if (!engine.health().configured) throw failure(503, 'Model credential is not configured', 'MODEL_UNCONFIGURED');
        const body = await readBody(request);
        if (typeof body.id !== 'string' || !body.id || body.id.length > 512 || body.to !== config.botId || !['request', 'event'].includes(body.kind || 'request') || body.content === undefined || (body.from && body.from !== auth.source) || (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 512))) throw failure(400, 'Invalid message envelope or authenticated sender');
        const accepted = store.acceptMessage(clean({ ...body, kind: body.kind || 'request' }), auth.source, bootId);
        if (!accepted.duplicate) schedule(accepted.task);
        response.statusCode = 202;
        return { accepted: true, duplicate: accepted.duplicate, messageId: accepted.message.id, taskId: accepted.task.id, status: accepted.task.status };
      }
      if (parts[0] === 'tasks') {
        if (method === 'GET') return parts[1] ? ownTask(parts[1]) : store.listTasks({ status: parsed.searchParams.get('status'), limit: Number(parsed.searchParams.get('limit')) || 100 }).filter(task => auth.admin || task.source === auth.source);
        if (method === 'POST' && parts[2] === 'cancel') { ownTask(parts[1]); return cancel(parts[1]); }
      }
      if (method === 'GET' && parts[0] === 'messages') return store.listMessages().filter(message => auth.admin || message.from === auth.source);
      needAdmin();
      if (method === 'POST' && parts[0] === 'shutdown') { setImmediate(() => close().catch(() => {})); return { stopping: true, bootId }; }
      if (method === 'GET' && parts[0] === 'events' && (parsed.searchParams.get('stream') === '1' || request.headers.accept?.includes('text/event-stream'))) {
        let after = Number(parsed.searchParams.get('after') || request.headers['last-event-id']) || 0;
        response.setHeader('content-type', 'text/event-stream; charset=utf-8'); response.setHeader('connection', 'keep-alive'); response.flushHeaders();
        const flush = () => { for (const event of store.listEvents({ after, limit: 1000 })) { response.write(`id: ${event.seq}\ndata: ${JSON.stringify(clean(event))}\n\n`); after = event.seq; } };
        flush(); const timer = setInterval(flush, 100); response.on('close', () => clearInterval(timer));
        return response;
      }
      if (method === 'GET' && parts[0] === 'events') return store.listEvents({ after: Number(parsed.searchParams.get('after')) || 0, limit: Number(parsed.searchParams.get('limit')) || 200, taskId: parsed.searchParams.get('taskId') || undefined });
      if (parts[0] === 'state') {
        if (method === 'GET') return parts[2] ? store.getState(parts[1], parts[2]) : store.listState(parts[1]);
        if (method === 'PUT' && parts[1] && parts[2]) { const body = await readBody(request); return store.setState(parts[1], parts[2], clean(body.value), body); }
      }
      if (parts[0] === 'sessions') {
        if (method === 'GET') return parts[1] ? store.getSession(parts[1]) : store.listSessions();
      }
      if (parts[0] === 'memories') {
        if (method === 'GET') return parts[1] ? store.getMemory(parts[1]) : store.listMemories();
        if (method === 'POST' && !parts[1]) { const body = await readBody(request); if (body.id && store.getMemory(body.id)) throw failure(409, 'Memory already exists'); return store.putMemory(clean(body)); }
        if (method === 'PATCH' && parts[1]) { const body = await readBody(request); if (!Number.isInteger(body.expectedRevision)) throw failure(400, 'expectedRevision required'); if (!store.getMemory(parts[1])) throw failure(404, 'Unknown memory'); return store.putMemory(clean({ ...body, id: parts[1] })); }
        if (method === 'DELETE' && parts[1]) { const body = await readBody(request); return { deleted: store.deleteMemory(parts[1], body.expectedRevision) }; }
      }
      if (method === 'GET' && parts[0] === 'tools') return parts[1] ? store.getTool(parts[1]) : store.listTools(parsed.searchParams.get('taskId') || undefined);
      if (method === 'GET' && parts[0] === 'artifacts') return parts[1] ? store.getArtifact(parts[1]) : store.listArtifacts();
      throw failure(404, 'Unknown endpoint');
    };
    server = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json; charset=utf-8'); response.setHeader('cache-control', 'no-store');
      route(request, response).then(value => { if (value !== response) response.end(JSON.stringify(clean(value))); }).catch(error => {
        if (response.destroyed) return; response.statusCode = error.status || (error instanceof TypeError ? 400 : 500);
        response.end(JSON.stringify(clean({ error: { code: error.code || 'BOT_ERROR', message: error.message } })));
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.listen.port, config.listen.host, () => { server.removeListener('error', reject); resolve(); }); });
    server.on('error', () => {}); server.requestTimeout = 30000;
    url = `http://${config.listen.host === '::1' ? '[::1]' : config.listen.host}:${server.address().port}`;
    emit('bot.loading', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity());
    await engine.initialize(); state = 'ready'; readyAt = at(); emit('bot.ready', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity());
    return { config, store, url, bootId, engine, close, health, emit, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } };
  } catch (error) {
    await engine?.close().catch(() => {});
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    store?.close(); await lock.close(); throw error;
  }
}
