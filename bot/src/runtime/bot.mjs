import http from 'node:http';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizeBotConfig, createRedactor } from './config.mjs';
import { acquireIdentityLock, inspectInstanceIdentity } from './identity-lock.mjs';
import { installProcessLog } from './process-log.mjs';
import { BotStore, terminalTaskStates } from '../storage/store.mjs';
import { saveArtifact } from '../storage/artifacts.mjs';
import { BotEngine } from '../agent/engine.mjs';
import { CapabilityUpdates } from './capability-updates.mjs';
import { coreTools } from '../capabilities/core-tools.mjs';
import { desktopExecutorState } from '../capabilities/executor-connections.mjs';
import { requestBot, sendMessage } from '../messaging/client.mjs';
import { WorkService } from './works.mjs';
import { ConversationScheduler } from './scheduler.mjs';
import { writeKnowledgeDocument } from '../context/knowledge-api.mjs';

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
export async function startBot(input, { captureProcessOutput = false } = {}) {
  const config = normalizeBotConfig(input), bootId = randomUUID(), startedAt = at();
  let state = 'loading', url = null, readyAt = null, store, engine, updates, server, closing, processLog;
  const jobs = new Map(), subscribers = new Set();
  await mkdir(config.dataDir, { recursive: true });
  const identity = () => ({ botId: config.botId, instanceId: config.botId, pid: process.pid, bootId, url, state, startedAt, readyAt });
  const lock = await acquireIdentityLock(config.dataDir, identity);
  try {
    if (captureProcessOutput) processLog = installProcessLog(join(config.dataDir, 'logs'), config.logs);
    await mkdir(config.workspace, { recursive: true }); await mkdir(join(config.dataDir, 'run'), { recursive: true });
    const privatePath = join(config.dataDir, 'config.json');
    if (!config.token) {
      try { const prior = JSON.parse(await readFile(privatePath, 'utf8')); if (prior.botId === config.botId) config.token = prior.token; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      config.token ||= randomBytes(32).toString('hex');
    }
    if (config.peers.some(peer => tokenEquals(peer.token, config.token))) throw new Error('Peer token must differ from management token');
    await atomicJson(privatePath, config);
    let redact = createRedactor(config);
    const clean = value => redact(value);
    let configWrites = Promise.resolve();
    const persistConfig = patch => {
      const operation = configWrites.catch(() => {}).then(async () => {
        const current = JSON.parse(await readFile(privatePath, 'utf8'));
        if (typeof patch === 'function') patch = patch(current);
        await atomicJson(privatePath, { ...current, ...patch });
        Object.assign(config, patch); redact = createRedactor(config);
      });
      configWrites = operation; return operation;
    };
    store = new BotStore(join(config.dataDir, 'state.sqlite'));
    store.recover(bootId);
    store.onEvent = event => { for (const listener of subscribers) { try { listener(event); } catch {} } };
    const emit = (type, payload, refs = {}) => store.appendEvent(type, clean(payload), refs);
    const contactFor = async botId => {
      const value = config.contacts.find(contact => contact.botId === botId);
      if (!value) throw failure(404, `Unknown configured contact ${botId}`);
      if (!value.dataDir) return value;
      // The peer owns its OS identity endpoint; resolving it does not involve
      // the gateway or chatroom, and survives a peer's dynamic-port restart.
      const peer = await inspectInstanceIdentity(value.dataDir);
      if (peer?.botId !== botId || peer.state !== 'ready') throw failure(503, 'Contact is not ready');
      const endpoint = new URL(peer.url);
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw failure(503, 'Invalid local contact identity');
      return { ...value, url: peer.url };
    };
    const taskDetails = id => { const value = store.getTask(id); return value && { ...value, tools: store.listTools(id) }; };
    const scheduler = new ConversationScheduler(config.concurrency);
    const frontendScheduler = new ConversationScheduler(1);
    let wakeTimer;
    const services = {
      store,
      executors: () => ({ executors: [desktopExecutorState({ connectionStore: config.model.connectionStore })] }),
      contacts: () => config.contacts.map(({botId,name,dataDir}) => ({botId,name,transport:dataDir?'local-direct':'http-direct'})),
      async send(to, envelope, { signal, taskId } = {}) {
        const id = envelope.id || randomUUID(), key = `${to}:${id}`;
        const previous = store.getOutbox(key);
        const originTask = taskId && store.getTask(taskId);
        const message = { ...envelope, id, to, from: config.botId, kind: envelope.kind || 'request', metadata: {
          ...envelope.metadata, ...(previous?.message?.metadata || (originTask ? { sourceWorkId: originTask.workId,
            sourceConversationId: originTask.conversationId, sourceTaskId: originTask.id, executionMode: originTask.workId ? 'work' : 'chat' } : {})) } };
        if (previous && JSON.stringify(previous.message) !== JSON.stringify(clean(message))) throw failure(409, 'Message ID already belongs to another payload');
        if (previous?.receipt) return previous.receipt;
        store.saveOutbox({ id: key, message: clean(message), taskId, to, status: 'sending', createdAt: previous?.createdAt || at() });
        try {
          const contact = await contactFor(to);
          const receipt = await sendMessage(contact, message, { signal });
          store.saveOutbox({ id: key, status: 'accepted', receipt: clean(receipt) }); return receipt;
        } catch (error) { store.saveOutbox({ id: key, status: 'unknown', error: clean({ message: error.message }) }); throw error; }
      },
      async getTask(id, botId, signal, waitMs = 0) {
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) throw failure(400, 'waitMs must be 0..60000');
        const deadline = Date.now() + waitMs;
        for (;;) {
          const value = botId && botId !== config.botId ? await requestBot(await contactFor(botId), `/tasks/${encodeURIComponent(id)}`, { signal }) : taskDetails(id);
          if (!value || terminalTaskStates.has(value.status) || Date.now() >= deadline) return value;
          await new Promise(resolve => setTimeout(resolve, Math.min(500, deadline - Date.now()))); signal?.throwIfAborted();
        }
      },
      async cancelTask(id, botId, signal) { return botId && botId !== config.botId ? requestBot(await contactFor(botId), `/tasks/${encodeURIComponent(id)}/cancel`, { method:'POST', body:{}, signal }) : cancel(id); },
      coreTools(task) { return coreTools(services, task); },
      toolContext(task) { return { saveArtifact: async input => {
        const artifact = await saveArtifact(join(config.dataDir, 'artifacts'), input, { botId: config.botId, taskId: task.id, runId: task.runId, sessionId: task.sessionId, workId: task.workId, createdAt: at() });
        store.saveArtifact(artifact); emit('artifact.created', { artifact }, { taskId: task.id }); return artifact;
      } }; },
    };
    engine = new BotEngine({ config, store, emit, services, clean });
    updates = new CapabilityUpdates({ config, store, engine, emit, clean, persist: persistConfig });
    const schedule = task => {
      if (jobs.has(task.id) || task.status !== 'accepted') return;
      const work = task.workId && services.works.get(task.workId);
      if (work && ['paused', 'cancelled', 'blocked'].includes(work.status)) return;
      const controller = new AbortController();
      const conversationScheduler = task.workId ? scheduler : frontendScheduler;
      const promise = conversationScheduler.run(task.conversationId || task.sessionId, async () => {
        if (controller.signal.aborted) return;
        task = store.getTask(task.id);
        if (task.status !== 'accepted') return;
        const currentWork = task.workId && services.works.get(task.workId);
        if (currentWork && ['paused', 'cancelled', 'blocked'].includes(currentWork.status)) return;
        if (currentWork?.status === 'waiting') services.works.update(currentWork.id, { status: 'active', waiting: null });
        // All accepted raw messages remain S1; combine a burst before waking the model.
        const batch = task.workId ? store.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.workId === task.workId && item.id !== task.id) : [];
        if (batch.length) {
          task = store.updateTask(task.id, { input: { current: task.input, accumulated: batch.map(item => ({ taskId: item.id, source: item.source, input: item.input, metadata: item.metadata })) } });
          for (const item of batch) store.updateTask(item.id, { status: 'completed', result: { content: '', batchedInto: task.id }, finishedAt: at() });
        }
        if (currentWork) services.works.update(currentWork.id, { lastTaskId: task.id });
        try { const result = await engine.run(task, { signal: controller.signal,
          onStart: () => store.updateTask(task.id, { status: 'running', startedAt: at() }) });
          if (task.metadata?.notificationId) await services.publishFrontendResult(task, result);
          store.updateTask(task.id, { status: 'completed', result, finishedAt: at() });
          for (const pending of store.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id)) {
            if (result.steeredMessageIds?.includes(pending.messageId)) store.updateTask(pending.id, { status: 'completed', result: { content: '', consumedBy: task.id }, finishedAt: at() });
            else store.updateTask(pending.id, { steeredIntoTaskId: null });
          }
          const latest = task.workId && services.works.get(task.workId);
          if (latest?.status === 'active') {
            const prior = store.getRecord('work-continuation', latest.id);
            const observation = JSON.stringify({ progress: latest.progress, content: result.content, bindings: latest.bindings });
            const repeated = prior?.observation === observation ? (prior.repeated || 0) + 1 : 0;
            store.putRecord('work-continuation', { id: latest.id, observation, repeated });
            if (repeated >= 2) services.works.update(latest.id, { status: 'blocked', lastError: { code: 'NO_PROGRESS', message: 'Repeated unchanged work outcome; chain stopped, work retained' } });
            else await services.works.dispatch(latest.id, { id: `continue:${task.id}`, content: 'Continue the existing work from durable S3 and receipts. Advance the next concrete step; when waiting use work_wait, when finished work_update completed. If no actionable step remains, record the actual blocker. Do not repeat uncertain side effects.' });
          }
        }
        catch (error) { store.updateTask(task.id, { status: controller.signal.aborted ? (state === 'stopping' ? 'interrupted' : 'cancelled') : 'failed',
          error: clean({ name: error.name, code: error.code, message: error.message }), finishedAt: at() });
          const corrections = store.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id);
          for (const pending of corrections) store.updateTask(pending.id, { steeredIntoTaskId: null });
          const current = task.workId && services.works.get(task.workId);
          if (current?.status === 'active' && state !== 'stopping') services.works.update(current.id, { status: corrections.length ? 'active' : 'blocked', lastError: clean({ code: error.code, message: error.message }) });
        }
        const settled = task.workId && services.works.get(task.workId), settledTask = store.getTask(task.id);
        if (settled && state !== 'stopping' && ['completed', 'cancelled', 'blocked'].includes(settled.status) && !store.listRecords('work-notifications').some(item => item.taskId === task.id && item.workStatus === settled.status)) {
          const content = settledTask.result?.content || settledTask.error?.message || settled.progress || `工作状态：${settled.status}`;
          for (const [index, source] of settled.sources.entries()) {
            const target = source.roomId ? { roomId: source.roomId, replyTo: source.replyTo } : config.contacts.some(contact => contact.botId === source.source) ? { botId: source.source } : null;
            if (target) await services.notify({ id: settled.id, notificationId: `settled:${task.id}:${index}`, content, ...target }, task, {}).catch(error => emit('work.notification_pending', { workId: settled.id, error: error.message }));
          }
        }
      }, { signal: controller.signal, priority: task.metadata?.priority }).catch(error => {
        if (state !== 'stopping' && store.getTask(task.id)?.status === 'accepted') store.updateTask(task.id, { status: 'cancelled', error: { message: error.message }, finishedAt: at() });
      }).finally(() => jobs.delete(task.id));
      jobs.set(task.id, { controller, promise });
    };
    const cancel = id => {
      const task = store.getTask(id); if (!task) throw failure(404, 'Unknown task');
      if (terminalTaskStates.has(task.status)) return task;
      store.updateTask(id, { cancelRequested: true }); jobs.get(id)?.controller.abort(new Error('Task cancelled'));
      if (task.status === 'accepted') store.updateTask(id, { status: 'cancelled', finishedAt: at() });
      return store.getTask(id);
    };
    const accept = (envelope, source) => {
      if (source !== 'controller' && envelope.kind === 'request' && !envelope.workId && envelope.metadata?.executionMode === 'work') {
        const key = JSON.stringify([source, envelope.id]);
        let binding = store.getRecord('peer-work', key);
        if (!binding) {
          const content = envelope.content, goal = typeof content === 'string' ? content : content?.goal || JSON.stringify(content);
          const work = services.works.create({ goal, requirements: typeof content === 'string' ? content : JSON.stringify(content),
            sources: [{ source, messageId: envelope.id, metadata: envelope.metadata }] });
          binding = store.putRecord('peer-work', { id: key, workId: work.id });
        }
        envelope = { ...envelope, workId: binding.workId };
      }
      const accepted = store.acceptMessage(clean(envelope), source, bootId);
      if (accepted.duplicate) return accepted;
      const task = accepted.task, work = task.workId && services.works.get(task.workId);
      if (envelope.kind === 'event' && (envelope.metadata?.purpose === 'fyi' || work?.status === 'completed')) {
        accepted.task = store.updateTask(task.id, { status: 'completed', result: { content: '', observed: true }, finishedAt: at() });
        return accepted;
      }
      if (work && (['waiting', 'blocked'].includes(work.status) || (work.status === 'completed' && envelope.kind === 'request'))) services.works.update(work.id, { status: 'active', waiting: null, lastError: null });
      if (work && envelope.kind === 'request' && source === 'controller' && engine.steer?.(work.conversationId, task.input, { source: envelope.metadata?.actor || source, messageId: task.messageId })) {
        const active = [...engine.active.values()].find(item => item.conversationId === work.conversationId);
        accepted.task = store.updateTask(task.id, { steeredIntoTaskId: active?.taskId || null });
      } else schedule(task);
      return accepted;
    };
    services.works = new WorkService({ store, botId: config.botId, accept, cancel, clean });
    const deliverNotification = async (record, context = {}) => {
      let receipt;
      if (record.botId) receipt = await services.send(record.botId, { id: record.id, kind: 'event', content: String(record.content).slice(0, 1600), workId: record.targetWorkId,
        replyTo: record.replyTo, metadata: { purpose: record.targetWorkId ? 'result' : 'fyi', sourceWorkId: record.workId, authority: 'peer-observation' } }, context);
      else {
        if (record.frontendTaskId) {
          const frontend = store.getTask(record.frontendTaskId);
          if (frontend && terminalTaskStates.has(frontend.status)) return services.publishFrontendResult(frontend,
            frontend.result || { content: `工作结果：${record.content}\n前台转达发生错误：${frontend.error?.message || frontend.status}` });
          return record;
        }
        const work = services.works.get(record.workId), source = work.sources.find(item => item.roomId === record.roomId);
        const original = source?.taskId && store.getTask(source.taskId);
        const accepted = accept({ id: `work-result:${record.id}`, kind: 'event',
          conversationId: [source?.conversationId, original?.conversationId].find(id => id && !id.startsWith('work:')) || `room:${record.roomId}`,
          metadata: { actor: 'system', sourceType: 'work-result', notificationId: record.id, roomId: record.roomId, priority: 'background' },
          content: { type: 'work_result', workId: record.workId, taskId: record.taskId, status: work.status, summary: String(record.content).slice(0, 1600),
            instruction: 'Briefly explain this actual work result to the user. This is a coordination notification, not a new assignment. Do not resume or repeat the work. Full execution remains in the work context.' } }, 'controller');
        const queued = { ...record, status: 'frontend', frontendTaskId: accepted.task.id, queuedAt: at() };
        store.putRecord('work-notifications', queued); return queued;
      }
      const saved = { ...record, status: 'delivered', receipt: clean(receipt), deliveredAt: at() };
      store.putRecord('work-notifications', saved); return saved;
    };
    services.publishFrontendResult = async (task, result) => {
      const record = store.getRecord('work-notifications', task.metadata.notificationId);
      if (!record || record.status === 'delivered') return record;
      const content = record.frontendContent || String(result.content || record.content).slice(0, 2400);
      store.putRecord('work-notifications', { ...record, frontendContent: content });
      const channel = engine.configured.tools.find(tool => tool.name === 'chatroom_send');
      if (!channel) throw failure(409, 'This Bot has no chatroom_send capability');
      const receipt = await channel.execute({ roomId: record.roomId, content, replyTo: record.replyTo, clientId: record.id,
        workId: record.workId, purpose: 'fyi' }, { botId: config.botId, taskId: task.id });
      if (receipt?.isError) throw new Error('Chatroom rejected frontend result');
      const saved = { ...record, frontendContent: content, status: 'delivered', receipt: clean(receipt), deliveredAt: at() };
      store.putRecord('work-notifications', saved); return saved;
    };
    services.notify = async (input, task, context) => {
      const work = services.works.get(input.id); if (!work) throw failure(404, 'Unknown work');
      if ((!input.botId && !input.roomId) || (input.botId && input.roomId)) throw failure(400, 'Choose one notification target');
      if (!work.sources.some(source => input.roomId ? source.roomId === input.roomId : source.source === input.botId)) throw failure(403, 'Work results only return to an original authorized source');
      const id = `${work.id}:${input.notificationId}`, prior = store.getRecord('work-notifications', id);
      if (prior?.status === 'delivered') return prior;
      const targetWorkId = input.targetWorkId || work.sources.find(source => source.source === input.botId)?.metadata?.sourceWorkId;
      const record = prior || clean({ ...input, content: String(input.content).slice(0, 1600), id, targetWorkId, workId: work.id, workStatus: work.status, taskId: task.id, status: 'pending', createdAt: at() });
      store.putRecord('work-notifications', record);
      try { return await deliverNotification(record, context); }
      catch (error) { store.putRecord('work-notifications', { ...record, status: 'unknown', error: clean(error.message), retryAt: Date.now() + 30000 }); throw error; }
    };
    // Durable waits consume no model or execution slot. Only a changed result wakes work.
    let ticking = false;
    const wake = async () => {
      if (ticking || state !== 'ready' || config.accepting === false) return;
      ticking = true;
      try {
        for (const notification of store.listRecords('work-notifications').filter(item => item.status !== 'delivered' && (!item.retryAt || item.retryAt <= Date.now()))) {
          try { await deliverNotification(notification); }
          catch (error) { store.putRecord('work-notifications', { ...notification, status: 'unknown', error: clean(error.message), retryAt: Date.now() + 60000 }); }
        }
        for (const work of services.works.list({ status: 'waiting', limit: 500 })) {
          const wait = work.waiting; if (!wait) continue;
          if (wait.until && Date.parse(wait.until) <= Date.now()) await services.works.dispatch(work.id, { id: `wait:${wait.id}`, content: { type: 'wait_due', wait } });
          else if (wait.taskId) {
            try { const task = await services.getTask(wait.taskId, wait.botId, undefined, 0);
              if (task && terminalTaskStates.has(task.status)) await services.works.dispatch(work.id, { id: `wait:${wait.id}:${task.status}`, content: { type: 'peer_task_result', task } });
            } catch (error) { store.putRecord('wait-errors', { id: work.id, message: clean(error.message), observedAt: at() }); }
          }
        }
        for (const task of store.listTasks({ status: 'accepted', limit: 10000 })) schedule(task);
      } finally { ticking = false; }
    };
    const health = () => ({ ...identity(), engine: engine.health(), tasks: store.listTasks({ limit: 10000 }).length });
    const close = () => closing ||= (async () => {
      state = 'stopping'; emit('bot.stopping', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity());
      clearInterval(wakeTimer); scheduler.close(); frontendScheduler.close();
      // Graceful shutdown stops only this Bot. Contacts remain independent.
      for (const job of jobs.values()) job.controller.abort(new Error('Bot is stopping'));
      await updates.close(); await engine.close(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); await configWrites.catch(() => {});
      if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      state = 'stopped'; emit('bot.stopped', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity()); store.close();
      try { processLog?.close(); } finally { await lock.close(); }
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
      if (method === 'GET' && parts[0] === 'capabilities') return { botId: config.botId, protocol: 'summon-bot-v2', engine: engine.health(), messages: true, tasks: true, works: true, state: true, knowledge: true };
      if (method === 'POST' && parts[0] === 'messages') {
        if (state !== 'ready') throw failure(503, `Bot is ${state}`);
        if (config.accepting === false) throw failure(409, 'Bot is paused');
        if (!engine.health().configured) throw failure(503, 'Model credential is not configured', 'MODEL_UNCONFIGURED');
        const body = await readBody(request);
        if (typeof body.id !== 'string' || !body.id || body.id.length > 512 || body.to !== config.botId || !['request', 'event'].includes(body.kind || 'request') || body.content === undefined || (body.from && body.from !== auth.source) || (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 512))) throw failure(400, 'Invalid message envelope or authenticated sender');
        if (!auth.admin && body.workId && !services.works.get(body.workId)?.sources.some(item => item.source === auth.source) &&
          !store.listOutbox().some(item => item.to === auth.source && item.message?.metadata?.sourceWorkId === body.workId)) throw failure(403, 'Work is not shared with this peer');
        const accepted = accept({ ...body, kind: body.kind || 'request' }, auth.source);
        response.statusCode = 202;
        return { accepted: true, duplicate: accepted.duplicate, messageId: accepted.message.id, taskId: accepted.task.id, status: accepted.task.status };
      }
      if (parts[0] === 'tasks') {
        if (method === 'GET') return parts[1] ? ownTask(parts[1]) : store.listTasks({ status: parsed.searchParams.get('status'), limit: Number(parsed.searchParams.get('limit')) || 100 }).filter(task => auth.admin || task.source === auth.source);
        if (method === 'POST' && parts[2] === 'cancel') { ownTask(parts[1]); return cancel(parts[1]); }
      }
      if (method === 'GET' && parts[0] === 'messages') return store.listMessages().filter(message => auth.admin || message.from === auth.source);
      needAdmin();
      if (parts[0] === 'works') {
        const id = parts[1];
        if (method === 'GET') return id ? services.works.get(id) : services.works.list({ status: parsed.searchParams.get('status'), query: parsed.searchParams.get('query') });
        if (method === 'POST' && !id) return services.works.create(await readBody(request));
        if (method === 'PATCH' && id) {
          const body = await readBody(request);
          const work = ['paused', 'cancelled'].includes(body.status) ? services.works.stop(id, body.status) : services.works.update(id, body);
          if (work.status === 'active') await wake();
          return work;
        }
        if (method === 'POST' && parts[2] === 'events') return services.works.dispatch(id, await readBody(request));
      }
      if (parts[0] === 'availability' && parts.length === 1 && method === 'PATCH') {
        const body=await readBody(request);if(typeof body.accepting!=='boolean')throw failure(400,'accepting must be boolean');
        await persistConfig({accepting:body.accepting});return {accepting:config.accepting};
      }
      if (parts[0] === 'contacts' && parts.length === 2 && ['PUT','DELETE'].includes(method)) {
        if (state !== 'ready') throw failure(503, `Bot is ${state}`);
        const id = parts[1], body = method === 'PUT' ? await readBody(request) : null;
        if (body && (body.contact?.botId !== id || body.peer?.botId !== id)) throw failure(400, 'Contact and peer identities must match');
        await persistConfig(current => {
          const patch = { contacts:(current.contacts||[]).filter(value => value.botId !== id), peers:(current.peers||[]).filter(value => value.botId !== id) };
          if (body) { patch.contacts.push(body.contact); patch.peers.push(body.peer); }
          normalizeBotConfig({...current,...patch}); return patch;
        });
        emit('bot.contacts.updated', { botId:id, connected:!!body });
        return {botId:id,connected:!!body};
      }
      if (method === 'PATCH' && parts[0] === 'config' && parts.length === 1) {
        if (state !== 'ready') throw failure(503, `Bot is ${state}`);
        const body = await readBody(request);
        if (!body || typeof body.prompt !== 'string' || Object.keys(body).some(key => key !== 'prompt')) throw failure(400, 'Only a prompt string may be patched through this endpoint');
        await persistConfig({ prompt: body.prompt });
        emit('bot.config.updated', { fields: ['prompt'], requiresRestart: false, effectiveAt: 'next-task' });
        return { updated: ['prompt'], requiresRestart: false, effectiveAt: 'next-task' };
      }
      if (parts[0] === 'capability-updates') {
        if (state !== 'ready') throw failure(503, `Bot is ${state}`);
        if (method === 'POST' && parts[1] === 'prepare' && parts.length === 2) { response.statusCode = 202; return updates.prepare(await readBody(request)); }
        if (method === 'GET' && parts.length === 2) return updates.get(parts[1]);
        if (method === 'POST' && parts.length === 3 && parts[2] === 'commit') return updates.commit(parts[1]);
        if (method === 'POST' && parts.length === 3 && parts[2] === 'abort') return updates.abort(parts[1]);
      }
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
      if (parts[0] === 'knowledge') {
        if (method === 'GET') return parts[1] ? engine.maintenance.read(parts[1]) : engine.maintenance.directory();
        if (method === 'POST' && !parts[1]) return writeKnowledgeDocument(engine.maintenance, store, clean(await readBody(request)));
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
    await engine.initialize(); updates.recover(); state = 'ready'; readyAt = at(); emit('bot.ready', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity());
    for (const work of services.works.list({ status: 'active', limit: 500 })) {
      const last = work.lastTaskId && store.getTask(work.lastTaskId);
      if (last?.status === 'interrupted') await services.works.dispatch(work.id, { id: `recover:${last.id}`, content: { type: 'execution_interrupted', taskId: last.id, instruction: 'Resume responsibility. First inspect durable tool receipts and original external bindings; unknown effects must be queried, never replayed.', unknownTools: store.listTools(last.id).filter(tool => tool.status === 'unknown') } });
    }
    wakeTimer = setInterval(() => wake().catch(error => emit('work.scheduler_error', { message: error.message })), 5000); wakeTimer.unref?.(); await wake();
    return { config, store, url, bootId, engine, close, health, emit, subscribe(listener) { subscribers.add(listener); return () => subscribers.delete(listener); } };
  } catch (error) {
    await updates?.close().catch(() => {}); await engine?.close().catch(() => {});
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    store?.close();
    try { if (processLog) console.error(error.stack || error.message); } finally { try { processLog?.close(); } finally { await lock.close(); } }
    throw error;
  }
}
