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
import { isCliExecutor, selectedWorkExecutor, workExecutorChoices } from '../capabilities/executor-connections.mjs';
import { executeCliWork } from './cli-work-engine.mjs';
import { requestBot, sendMessage } from '../messaging/client.mjs';
import { WorkService } from './works.mjs';
import { ConversationScheduler } from './scheduler.mjs';
import { writeKnowledgeDocument } from '../context/knowledge-api.mjs';
import { RuntimeSources, taskSource } from '../context/sources.mjs';
import { externalObservationId, notificationParts, notificationSupersession, progressNotificationCurrent } from './notifications.mjs';
import { workExecutor } from './work-executor.mjs';
import { selectedConnection } from '../agent/model.mjs';
import { modelConnection } from '../agent/connections.mjs';
import { waitingLabel } from '../context/execution-evidence.mjs';

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
      store, workspace: config.workspace,
      async capability(name, args, task, context = {}) {
        const tool = engine.configured.tools.find(tool => tool.name === name);
        if (!tool) throw failure(409, `This Bot has no ${name} capability`);
        const output = await tool.execute({ ...args, ...(context.operationId || context.notificationId ? {
          _context: { operationId: context.operationId, notificationId: context.notificationId } } : {}) },
        { botId: config.botId, taskId: task.id, ...context });
        if (output.isError) throw new Error(output.content?.map(item => item.text || '').join('\n') || `${name} failed`);
        return output.details ?? output.structuredContent ?? output;
      },
      executors: () => workExecutorChoices(config.model),
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
    services.sources = new RuntimeSources({ store, workspace: config.workspace, call: (...args) => services.capability(...args) });
    engine = new BotEngine({ config, store, emit, services, clean });
    services.memory = engine.maintenance;
    services.sources.readKnowledge = (...args) => engine.maintenance.read(...args);
    updates = new CapabilityUpdates({ config, store, engine, emit, clean, persist: persistConfig });
    const schedule = task => {
      if (jobs.has(task.id) || task.status !== 'accepted') return;
      engine.maintenance.activity(task);
      const work = task.workId && services.works.get(task.workId);
      const external = task.metadata?.sourceType === 'external';
      if (!external && work && ['paused', 'cancelled', 'blocked'].includes(work.status)) return;
      const controller = new AbortController();
      const conversationScheduler = task.workId ? scheduler : frontendScheduler;
      const promise = conversationScheduler.run(task.conversationId || task.sessionId, async () => {
        if (controller.signal.aborted) return;
        task = store.getTask(task.id);
        if (task.status !== 'accepted') return;
        const currentWork = task.workId && services.works.get(task.workId);
        if (!external && currentWork && ['paused', 'cancelled', 'blocked'].includes(currentWork.status)) return;
        if (!external && currentWork?.status === 'waiting' && currentWork.waiting?.dependencyWorkId &&
          store.getRecord('work-waits', currentWork.waiting.id)?.status === 'pending') return;
        // A later request can be accepted while its predecessor is still active.
        // The predecessor may finish after acceptance, so refresh at actual
        // queue start as well; its completed state does not describe this task.
        if (!external && currentWork && ['waiting', 'completed'].includes(currentWork.status))
          services.works.update(currentWork.id, { status: 'active', waiting: null, lastError: null, executionOutcome: null });
        // Keep each accepted request and its publication route intact in the work queue.
        if (currentWork) services.works.update(currentWork.id, { lastTaskId: task.id });
        try {
          const start = () => { engine.maintenance.activity(task); return store.updateTask(task.id, { status: 'running', startedAt: at() }); };
          let result;
          const executor = currentWork && services.works.executor(currentWork).kind;
          if (!external && isCliExecutor(executor)) {
            start();
            result = await executeCliWork({ store, services, config, task, signal: controller.signal, clean });
          } else if (currentWork && (external || executor === 'codex')) {
            start(); result = await services.executor.execute(task, { signal: controller.signal });
          }
          else result = await engine.run(task, { signal: controller.signal, onStart: start });
          store.updateTask(task.id, { status: 'completed', result, finishedAt: at(), activity: {
            phase: result.suspended ? 'waiting' : 'completed', label: result.handoff ? '已交给独立工作处理' : result.suspended ? waitingLabel(task.workId && services.works.get(task.workId)) : '已完成本次任务',
            motion: result.handoff ? 'exclaim' : result.suspended ? 'notify' : 'burst', source: 'execution', updatedAt: at() } });
          for (const pending of store.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id)) {
            if (result.steeredMessageIds?.includes(pending.messageId)) store.updateTask(pending.id, { status: 'completed', result: { content: '', consumedBy: task.id }, finishedAt: at() });
            else store.updateTask(pending.id, { steeredIntoTaskId: null });
          }
          const latest = task.workId && services.works.get(task.workId);
          if (!external && latest?.status === 'active' && services.works.executor(latest).kind === 'pi') {
            const execution = services.works.execution(task), continuationId = execution.actionId || execution.executionEventId;
            const prior = store.getRecord('work-continuation', continuationId);
            const observation = JSON.stringify({ progress: latest.progress, content: result.content, bindings: latest.bindings });
            const repeated = prior?.observation === observation ? (prior.repeated || 0) + 1 : 0;
            store.putRecord('work-continuation', { id: continuationId, workId: latest.id, observation, repeated });
            if (repeated >= 2) services.works.update(latest.id, { status: 'blocked', lastError: { code: 'NO_PROGRESS', message: 'Repeated unchanged work outcome; chain stopped, work retained' } });
            else {
              await services.works.dispatch(latest.id, { id: `continue:${task.id}`, metadata: { executionEventId: execution.executionEventId, executionTaskId: execution.executionTaskId,
                automaticContinuation: true },
                content: 'Continue the existing work from durable S3 and receipts. Advance the next concrete step; when waiting use work_wait. '
                  + (latest.id.startsWith('onboarding-') ? 'Complete configuration through workspace_setup so it can verify the result and advance the guide. Do not mark this work completed or cancelled yourself. '
                    : 'When finished use work_update completed. ')
                  + 'A result already published for this execution stays published; status cleanup does not need another notification. If no actionable step remains, record the actual blocker. Do not repeat uncertain side effects.' },
              task);
            }
          }
        }
        catch (error) { store.updateTask(task.id, { status: controller.signal.aborted ? (state === 'stopping' ? 'interrupted' : 'cancelled') : 'failed',
          error: clean({ name: error.name, code: error.code, message: error.message }), finishedAt: at(), activity: {
            phase: controller.signal.aborted ? 'cancelled' : 'failed', label: controller.signal.aborted ? '任务已停止' : '任务遇到问题', motion: controller.signal.aborted ? 'confused' : 'alert', source: 'execution', updatedAt: at() } });
          const corrections = store.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id);
          for (const pending of corrections) store.updateTask(pending.id, { steeredIntoTaskId: null });
          const current = task.workId && services.works.get(task.workId);
          if (current?.status === 'active' && state !== 'stopping') services.works.update(current.id, { status: corrections.length ? 'active' : 'blocked', lastError: clean({ code: error.code, message: error.message }) });
        }
        const settled = task.workId && services.works.get(task.workId), settledTask = store.getTask(task.id);
        const execution = services.works.execution(task);
        const alreadyPublished = settled && store.listRecords('work-notifications').some(item => item.workId === settled.id &&
          (execution.executionEventId ? item.executionEventId === execution.executionEventId : item.taskId === task.id));
        if (!external && settled && settled.executionOutcome?.onboardingCompletedTaskId !== task.id && settledTask.result?.executor !== 'codex' && !settledTask.result?.late && state !== 'stopping' && ['completed', 'cancelled', 'blocked'].includes(settled.status) && !alreadyPublished) {
          const content = settledTask.result?.content || settledTask.error?.message || settled.progress || `工作状态：${settled.status}`;
          await services.notify({ id: settled.id, notificationId: `settled:${execution.executionEventId || task.id}`, publication: 'automatic', content }, task, {})
            .catch(error => emit('work.notification_pending', { workId: settled.id, error: error.message }));
        }
      }, { signal: controller.signal, priority: task.metadata?.priority }).catch(error => {
        if (state !== 'stopping' && store.getTask(task.id)?.status === 'accepted') store.updateTask(task.id, { status: 'cancelled', error: { message: error.message }, finishedAt: at() });
      }).finally(() => { if (!store.closed) engine.maintenance.activity(task); jobs.delete(task.id); });
      jobs.set(task.id, { controller, promise });
    };
    const cancel = id => {
      const task = store.getTask(id); if (!task) throw failure(404, 'Unknown task');
      if (terminalTaskStates.has(task.status)) return task;
      store.updateTask(id, { cancelRequested: true }); jobs.get(id)?.controller.abort(new Error('Task cancelled'));
      if (task.status === 'accepted') store.updateTask(id, { status: 'cancelled', finishedAt: at() });
      return store.getTask(id);
    };
    const accept = (envelope, source, { deferSchedule = false } = {}) => {
      if (envelope.metadata?.groupObservation && (source !== 'controller' || envelope.kind !== 'event' || envelope.workId))
        throw failure(403, 'Group observation requires an authenticated room delivery');
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
      let task = accepted.task;
      const work = task.workId && services.works.get(task.workId);
      // Direct accepted work requests (including peers) need the same durable
      // action root as frontend dispatches before a continuation can inherit it.
      if (work && envelope.kind === 'request' && !task.metadata?.workEventId && !task.metadata?.resumeEventId && !task.metadata?.executionEventId &&
        task.metadata?.sourceType !== 'external') {
        const execution = services.works.execution(task);
        if (execution.authorization) {
          store.putRecord('work-events', { id: execution.executionEventId, workId: work.id, kind: 'request', content: task.input,
            requestTaskId: execution.requestTaskId, sourceTaskId: task.id, authorization: execution.authorization, status: 'accepted',
            receipt: { accepted: true, workId: work.id, taskId: task.id, status: task.status }, createdAt: task.createdAt });
          task = accepted.task = store.updateTask(task.id, { metadata: { ...task.metadata, workEventId: execution.executionEventId } });
          if (!work.sources.some(item => item.taskId === execution.requestTaskId)) services.works.update(work.id,
            { sources: [...work.sources, execution.authorization.source] });
        }
      }
      if (envelope.metadata?.sourceType !== 'external' && envelope.kind === 'event' && (envelope.metadata?.purpose === 'fyi' || work?.status === 'completed')) {
        accepted.task = store.updateTask(task.id, { status: 'completed', result: { content: '', observed: true }, finishedAt: at() });
        return accepted;
      }
      if (envelope.metadata?.sourceType !== 'external' && work) {
        if (['paused', 'cancelled'].includes(work.status)) {
          const event = envelope.metadata?.workEventId && store.getRecord('work-events', envelope.metadata.workEventId);
          if (envelope.kind === 'request' && source === 'controller' && envelope.metadata?.resume === true &&
            event?.workId === work.id && event.authorization?.production?.workId === work.id) {
            services.works.requireResume(work, event.authorization.source.receivedAt || null);
            services.works.activate(work);
          }
        } else if (['waiting', 'blocked'].includes(work.status) || work.status === 'completed' && envelope.kind === 'request') {
          services.works.update(work.id, { status: 'active', waiting: null, lastError: null });
        }
      }
      if (!deferSchedule) schedule(task);
      return accepted;
    };
    services.works = new WorkService({ store, botId: config.botId, accept, schedule, cancel, clean,
      selectExecutor: () => selectedWorkExecutor(config.model), selectModel: id => {
      const selected = id ? modelConnection(config.model, id) : selectedConnection(config);
      return { connectionId: selected.id, modelId: selected.model, thinkingLevel: selected.thinkingLevel };
    } });
    services.executor = workExecutor({ store, services, emit });
    services.reviewExternal = (task, options) => engine.run(task, options);
    services.stopWork = async (target, status, task) => {
      const work = services.works.stop(target.id, status, target.controlRevision || 0, taskSource(task, store).receivedAt);
      if (work.externalStop?.status === 'pending' && ['paused', 'cancelled'].includes(work.status)) await services.executor.stop(work, task);
      return services.works.get(work.id);
    };
    services.resultSource = (work, task) => {
      return task.workId === work.id ? services.works.execution(task).authorization?.source : undefined;
    };
    const deliverNotification = async (record, context = {}) => {
      if (['delivered', 'superseded'].includes(record.status)) return record;
      const task = store.getTask(record.taskId), work = services.works.get(record.workId);
      const supersededBy = notificationSupersession(record, work, store.listRecords('work-notifications'),
        store.getRecord('work-observations', record.notificationId));
      if (supersededBy) return store.putRecord('work-notifications', { ...record, status: 'superseded',
        supersededBy, suppressedAt: at(), waiting: undefined, retryAt: undefined });
      if (record.resultKind === 'progress' && !progressNotificationCurrent(record, work))
        return store.putRecord('work-notifications', { ...record, status: 'superseded', suppressedAt: at(),
          ...(record.status === 'unknown' ? { deliveryUnconfirmed: true } : {}) });
      const source = task && work && services.resultSource(work, task);
      const target = source?.roomId && source.replyTo ? { roomId: source.roomId, replyTo: source.replyTo, botId: undefined } :
        source && config.contacts.some(contact => contact.botId === source.source) ?
          { botId: source.source, roomId: undefined, replyTo: source.messageId, targetWorkId: source.metadata?.sourceWorkId } : null;
      if (!target) return store.putRecord('work-notifications', { ...record, status: 'pending', waiting: 'source', retryAt: Date.now() + 60000,
        error: 'Actual action source is unavailable; result retained without selecting another work source' });
      record = { ...record, ...target, authorization: services.works.execution(task).authorization, waiting: undefined, error: undefined };
      store.putRecord('work-notifications', record);
      let receipt;
      if (record.botId) receipt = await services.send(record.botId, { id: record.id, kind: 'event', content: record.content, workId: record.targetWorkId,
        replyTo: record.replyTo, metadata: { purpose: record.targetWorkId ? 'result' : 'fyi', sourceWorkId: record.workId, authority: 'peer-observation' } }, context);
      else {
        receipt = [];
        for (const part of notificationParts(record)) receipt.push(await services.capability('chatroom_send', part, task,
          { ...context, notificationId: record.id }));
      }
      const saved = { ...record, status: 'delivered', receipt: clean(receipt), deliveredAt: at() };
      store.putRecord('work-notifications', saved); return saved;
    };
    services.notify = async (input, task, context) => {
      if (Array.isArray(input.attachments)) input = { ...input, attachments: [...new Map(input.attachments.map(item => [item?.id, item])).values()] };
      if (task.metadata?.externalReview?.running) input = { ...input, publication: 'progress', resultKind: 'progress' };
      if (task.metadata?.externalReview && !input.sourceRefs) input = { ...input, sourceRefs: [{ type: 'codex',
        threadId: task.metadata.externalReview.threadId, turnId: task.metadata.externalReview.turnId, operationId: task.metadata.externalReview.operationId }] };
      const work = services.works.get(input.id); if (!work) throw failure(404, 'Unknown work');
      const authorizedSource = services.resultSource(work, task);
      if (!input.botId && !input.roomId) {
        const source = authorizedSource;
        if (source) input = { ...input, ...(source.roomId ? { roomId: source.roomId, replyTo: source.replyTo } : { botId: source.source }) };
      }
      if (input.botId && input.roomId) throw failure(400, 'Choose one notification target');
      if (authorizedSource && (input.roomId ? authorizedSource.roomId !== input.roomId || input.replyTo && authorizedSource.replyTo !== input.replyTo :
        input.botId && authorizedSource.source !== input.botId)) throw failure(403, 'Results return to the exact source of this action; another request is not a publication target');
      const execution = services.works.execution(task);
      if (task.metadata?.externalReview?.running && authorizedSource?.roomId) {
        const review = task.metadata.externalReview;
        const observation = store.getRecord('work-observations', externalObservationId(task));
        const observed = observation?.content;
        const itemIds = observed?.progress?.items?.filter(item => item.itemId && item.threadId === review.threadId && item.turnId === review.turnId)
          .map(item => item.itemId);
        if (observation?.taskId !== task.id || observation.workId !== work.id || observation.late ||
          observed.source !== 'codex-desktop-connector' || observed.type !== 'external_progress' || !observed.progress?.confirmed ||
          !review.operationId || observed.operationId !== review.operationId || observed.externalThreadId !== review.threadId || observed.turnId !== review.turnId ||
          !authorizedSource.replyTo || !itemIds?.length) return { status: 'superseded', workId: work.id };
        const scope = { bindingId: review.bindingId, threadId: review.threadId, turnId: review.turnId, operationId: review.operationId,
          controlRevision: observation.controlRevision, itemIds };
        const id = `${work.id}:${observation.id}`, prior = store.getRecord('work-notifications', id);
        if (prior) return prior;
        if (!progressNotificationCurrent({ progressScope: scope }, work)) return { status: 'superseded', workId: work.id };
        const previous = store.listRecords('work-notifications').filter(item => item.workId === work.id && item.resultKind === 'progress' &&
          item.roomId === authorizedSource.roomId && item.replyTo === authorizedSource.replyTo && (item.status !== 'superseded' || item.deliveryUnconfirmed) &&
          item.progressScope?.threadId === scope.threadId && item.progressScope.turnId === scope.turnId);
        const seen = new Set(previous.flatMap(item => item.progressScope.itemIds));
        const normalize = text => String(text || '').trim().replace(/\s+/g, ' ');
        if (itemIds.every(item => seen.has(item)) || previous.some(item => normalize(item.content) === normalize(input.content)))
          return { status: 'duplicate', workId: work.id };
        input = { ...input, notificationId: observation.id, progressScope: scope, sourceRefs: [{ type: 'codex',
          threadId: scope.threadId, turnId: scope.turnId, operationId: scope.operationId, observationId: observation.id, itemIds }] };
      }
      if (input.publication === 'explicit') {
        const published = store.listRecords('work-notifications').findLast(item => item.workId === work.id &&
          item.executionEventId === execution.executionEventId && item.publication === 'explicit');
        const newAction = published && store.listTools().some(record => record.workId === work.id && record.startedAt > published.createdAt &&
          record.status === 'completed' && record.effect !== 'read' && !['work_update', 'work_wait', 'work_notify', 'knowledge_remember'].includes(record.name) &&
          services.works.execution(store.getTask(record.taskId) || {}).executionEventId === execution.executionEventId);
        if (published && !newAction) return { ...published, duplicate: true };
      }
      const id = `${work.id}:${input.notificationId}`, prior = store.getRecord('work-notifications', id);
      if (['delivered', 'superseded'].includes(prior?.status)) return prior;
      const targetWorkId = authorizedSource?.metadata?.sourceWorkId;
      if (typeof input.content !== 'string' || !input.content.trim()) throw failure(400, 'Notification requires publishable text');
      const source = authorizedSource;
      const record = prior || clean({ ...input, ...execution, replyTo: input.replyTo || source?.replyTo, id, targetWorkId, workId: work.id, workStatus: work.status, taskId: task.id, status: 'pending', createdAt: at() });
      store.putRecord('work-notifications', record);
      store.putRecord('work-results', { id: record.id, workId: work.id, taskId: task.id, ...execution, content: record.content,
        kind: input.resultKind || (work.status === 'completed' ? 'completed' : work.status === 'blocked' ? 'failed' : 'result'),
        late: input.late === true, sourceRefs: input.sourceRefs, createdAt: record.createdAt });
      try { return await deliverNotification(record, context); }
      catch (error) { return store.putRecord('work-notifications', { ...record, status: 'unknown', error: clean(error.message), retryAt: Date.now() + 30000 }); }
    };
    // Durable waits consume no model or execution slot. Only a changed result wakes work.
    let ticking = false;
    const wake = async () => {
      if (ticking || state !== 'ready' || config.accepting === false) return;
      ticking = true;
      try {
        for (const notification of store.listRecords('work-notifications').filter(item => ['pending', 'unknown'].includes(item.status) && (!item.retryAt || item.retryAt <= Date.now()))) {
          try { await deliverNotification(notification); }
          catch (error) { store.putRecord('work-notifications', { ...notification, status: 'unknown', error: clean(error.message), retryAt: Date.now() + 60000 }); }
        }
        const waits = new Map(store.listRecords('work-waits').filter(item => item.status === 'pending').map(item => [item.id, item]));
        for (const wait of waits.values()) {
          const target = services.works.get(wait.targetWorkId || wait.workId);
          if (!target || ['paused', 'cancelled'].includes(target.status) || wait.unresolvedTaskId) continue;
          try {
            let observation;
            if (wait.dependencyWorkId) {
              observation = store.listRecords('work-results').find(item => item.workId === wait.dependencyWorkId && !item.late &&
                item.kind !== 'progress' && (wait.dependencyEventId ? item.executionEventId === wait.dependencyEventId || item.operationId === wait.dependencyEventId :
                  wait.taskId ? item.taskId === wait.taskId || item.executionTaskId === wait.taskId : false) && item.kind !== 'result-unknown' &&
                (!wait.event || wait.event === 'result' || item.kind === wait.event || ['failed', 'cancelled', 'interrupted', 'needs-input'].includes(item.kind)));
              if (!observation && wait.taskId) {
                const dependency = store.getTask(wait.taskId);
                // A finished local submission task says nothing about the external turn.
                if (dependency && terminalTaskStates.has(dependency.status) &&
                  (!dependency.result?.suspended || ['failed', 'cancelled', 'interrupted'].includes(dependency.status)))
                  observation = { type: 'task_result', task: dependency };
              }
            }
            else if (wait.until && Date.parse(wait.until) <= Date.now()) observation = { type: 'wait_due', until: wait.until };
            else if (wait.taskId) { const task = await services.getTask(wait.taskId, wait.botId, undefined, 0); if (task && terminalTaskStates.has(task.status) && !task.result?.suspended) observation = { type: 'peer_task_result', task }; }
            else if (wait.event) observation = store.listRecords('work-observations').find(item => item.workId === wait.workId && !item.late && item.observedAt >= wait.since &&
              (item.content?.type === wait.event || item.content?.status === wait.event || wait.event === 'result' && ['completed', 'failed', 'interrupted', 'cancelled', 'waiting_for_input'].includes(item.content?.status)));
            if (!observation) continue;
            if (wait.mode === 'observe') {
              store.putRecord('work-waits', { ...wait, status: 'delivered', observationId: observation.id,
                resultTaskId: observation.executionTaskId || observation.task?.id || observation.taskId, deliveredAt: at() });
              continue;
            }
            const receipt = await services.works.dispatch(target.id, { id: `wait:${wait.id}`, kind: 'request',
              metadata: { waitId: wait.id },
              content: { ...wait.handoff, type: 'dependency_result', observation,
                dependency: { workId: wait.dependencyWorkId, taskId: wait.taskId, executionEventId: wait.dependencyEventId },
                instruction: 'The registered dependency has now produced the attached actual outcome. Read observation as already delivered evidence and perform only the registered next step for this target work. Do not repeat dispatch, register the same wait, rerun the dependency, or claim its stdout must be produced by this worker. Use partial output on failure where authorized; success-only steps remain forbidden unless success is established. Preserve the original request and handoff as separate materials.' } },
            wait.sourceTaskId ? store.getTask(wait.sourceTaskId) || {} : {});
            if (receipt.accepted) store.putRecord('work-waits', { ...wait, status: 'delivered', receipt, deliveredAt: at() });
          } catch (error) { store.putRecord('wait-errors', { id: wait.id, message: clean(error.message), observedAt: at() }); }
        }
        for (const task of store.listTasks({ status: 'accepted', limit: 10000 })) schedule(task);
        for (const event of store.listRecords('work-events').filter(event => event.status === 'pending' && !event.receipt)) {
          const sourceId = event.sourceTaskId || event.requestTaskId;
          const source = sourceId && store.getTask(sourceId);
          try { await services.works.dispatch(event.workId, { id: event.id.slice(event.workId.length + 1), kind: event.kind, content: event.content, metadata: event.metadata }, source || {}); }
          catch (error) { store.putRecord('work-events', { ...store.getRecord('work-events', event.id), lastError: clean(error.message) }); }
        }
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
        if (!auth.admin) body.metadata = { ...body.metadata, actor: auth.source, authority: 'peer-observation', sourceType: 'peer',
          externalBindingId: undefined, notificationId: undefined, observationMessageId: undefined, workEventId: undefined, resumeEventId: undefined,
          executionEventId: undefined, executionTaskId: undefined, automaticContinuation: undefined, waitId: undefined,
          origin: undefined, accessActor: undefined, historyThroughMessageId: undefined, referencedWorkId: undefined, routeOnly: false, resume: false };
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
          const work = ['paused', 'cancelled'].includes(body.status) ? services.works.stop(id, body.status, body.controlRevision) :
            body.status === 'active' && body.controlRevision !== undefined ? await services.works.resume(id, body.controlRevision) : services.works.update(id, body);
          if (body.status === 'active') void wake().catch(() => {});
          return work;
        }
        if (method === 'POST' && parts[2] === 'stop-result' && parts.length === 3) return services.works.settleStop(id, await readBody(request));
        if (method === 'POST' && parts[2] === 'events') return services.works.dispatch(id, await readBody(request));
        if (method === 'POST' && parts[2] === 'review') {
          const work = services.works.get(id);
          if (!work || work.status !== 'waiting' || work.waiting?.kind !== 'review') throw failure(409, 'Only an existing result waiting for review can be reconciled');
          const binding = work.bindings?.findLast(item => item.type === 'codex-desktop');
          const observation = store.listRecords('work-observations').findLast(item => item.workId === id && !item.late &&
            item.content?.operationId === binding?.operationId && item.content?.turnId === binding?.turnId && item.content?.final?.confirmed);
          const original = observation && store.getTask(observation.taskId);
          if (!original || binding.status !== 'completed') throw failure(409, 'No exact confirmed final observation is available');
          const accepted = accept({ id: `reconcile:review:${observation.id}:${work.revision}`, to: config.botId, kind: 'event', workId: id,
            content: observation.content, metadata: { sourceType: 'external', authority: 'external-result', externalBindingId: binding.id,
              observationMessageId: original.metadata?.observationMessageId || original.messageId, reviewRecovery: original.id, finalizationOnly: true } }, 'controller');
          return { accepted: true, workId: id, taskId: accepted.task.id, sourceObservationId: observation.id, finalizationOnly: true };
        }
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
    await engine.initialize(); updates.recover();
    const restoredExecutionStates = services.executor.restoreExecutionStates();
    state = 'ready'; readyAt = at(); emit('bot.ready', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity());
    // External observations only update saved facts and idempotent publications.
    // Resume the same accepted event if shutdown interrupted that processing.
    for (const task of store.listTasks({ status: 'interrupted', limit: 10000 })) if (task.metadata?.sourceType === 'external')
      accept({ id: `recover:external:${task.id}`, to: config.botId, kind: 'event', workId: task.workId, content: task.input,
        metadata: { ...task.metadata, finalizationOnly: true, observationMessageId: task.metadata.observationMessageId || task.messageId } }, 'controller');
    // Retry only a real final observation whose supervisor failed. This lane
    // may reconcile S3/notify; it cannot submit another product execution.
    for (const work of services.works.list({ status: 'waiting', limit: 500 }).filter(work => work.waiting?.kind === 'review')) {
      if (restoredExecutionStates.has(work.id)) continue;
      const failed = store.listRecords('external-reviews').findLast(review => review.workId === work.id && review.status === 'unconfirmed' && !review.resolvedBy);
      const original = failed && store.getTask(failed.id);
      if (!original?.input?.final?.confirmed || original.input.status !== 'completed') continue;
      const binding = work.bindings?.find(item => item.id === original.metadata?.externalBindingId);
      if (binding?.operationId !== original.input.operationId || binding.turnId !== original.input.turnId || binding.status !== 'completed') continue;
      accept({ id: `recover:review:${original.id}`, to: config.botId, kind: 'event', workId: work.id, content: original.input,
        metadata: { ...original.metadata, reviewRecovery: failed.id, finalizationOnly: true,
          observationMessageId: original.metadata.observationMessageId || original.messageId } }, 'controller');
    }
    for (const work of services.works.list({ status: 'active', limit: 500 })) {
      const last = work.lastTaskId && store.getTask(work.lastTaskId);
      if (last?.status === 'interrupted' && last.metadata?.sourceType !== 'external') try {
        await services.works.dispatch(work.id, { id: `recover:${last.id}`, metadata: { resumeEventId: last.metadata?.resumeEventId || last.metadata?.workEventId }, content: { type: 'execution_interrupted', taskId: last.id, instruction: 'Resume only this accepted step. First inspect durable tool receipts and original external bindings; unknown effects must be queried, never replayed.', unknownTools: store.listTools(last.id).filter(tool => tool.status === 'unknown') } }, last);
      } catch (error) { emit('work.recovery_pending', { workId: work.id, message: error.message }); }
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
