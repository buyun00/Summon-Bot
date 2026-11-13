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
import { SummonDecisionJournal } from '../agent/workflow-decision.mjs';
import { CapabilityUpdates } from './capability-updates.mjs';
import { coreTools } from '../capabilities/core-tools.mjs';
import { requestBot, sendMessage } from '../messaging/client.mjs';
import { WorkService } from './works.mjs';
import { ConversationScheduler } from './scheduler.mjs';
import { writeKnowledgeDocument } from '../context/knowledge-api.mjs';
import { isEnvironmentInitializationSource } from '../context/environment.mjs';
import { RuntimeSources, taskSource } from '../context/sources.mjs';
import { notificationParts, notificationSupersession, progressNotificationCurrent } from './notifications.mjs';
import { selectedConnection } from '../agent/model.mjs';
import { modelConnection } from '../agent/connections.mjs';
import { waitingLabel } from '../context/execution-evidence.mjs';
import { OWNER_DELIVERY } from '../context/duty-actions.mjs';
import { applyWorkflowCorrection, workflowReviewerId } from '../context/workflow-review.mjs';
import { verifiedProductionRecovery } from '../capabilities/production-recovery.mjs';
import { nativeWorkExecutor } from './native-work-executor.mjs';

const at = () => new Date().toISOString();
const failure = (status, message, code) => Object.assign(new Error(message), { status, code });
const tokenEquals = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const pendingCutoverRecovery = work => work?.status === 'waiting' && work.waiting?.kind === 'native-recovery' ?
  work.bindings?.find(item => item.type === 'native-recovery' && item.status === 'recovery-required' && item.id === work.waiting.bindingId) : undefined;
const heldBeforeCutover = (work, createdAt) => Boolean(createdAt &&
  (['paused', 'cancelled', 'blocked'].includes(work?.status) || work?.status === 'waiting' && ['review', 'user-input'].includes(work.waiting?.kind)) &&
  work.bindings?.some(item => item.type === 'native-recovery' && item.origin === 'pre-cutover' && createdAt <= item.migratedAt));
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
    const journal = new SummonDecisionJournal({ store, botId: config.botId, clean,
      onError: code => { try { emit('workflow.journal_unavailable', { code }); } catch {} } });
    journal.recover();
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
      journal,
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
      executors: workId => engine.configured.tools.some(tool => tool.name === 'catalog_native_engine_choices')
        ? services.capability('catalog_native_engine_choices', workId ? { workId } : {}, {})
        : { defaultId: 'pi', executors: [{ id: 'pi', kind: 'pi', name: 'Pi' }] },
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
      const work = task.workId && services.works.get(task.workId);
      const hold = (reason, work) => journal.note(task, `hold:${reason}:${work?.revision || 0}`, {
        boundary: 'schedule', decision: 'skip', runtimeCheck: 'blocked', facts: { reason, status: work?.status },
        result: { status: 'not-started' } });
      const settleObsoleteEnvironmentTask = work => {
        if (work?.status !== 'completed' || !work.id.startsWith('onboarding-') ||
          !isEnvironmentInitializationSource(services.works.execution(task).authorization?.source)) return false;
        journal.note(task, 'task', { boundary: 'task', decision: 'observe-without-action', runtimeCheck: 'confirmed',
          facts: { reason: 'environment-initialization-completed' } });
        journal.settled(store.updateTask(task.id, { status: 'completed', result: { content: '', observed: true }, finishedAt: at() }));
        return true;
      };
      if (settleObsoleteEnvironmentTask(work)) return;
      engine.maintenance.activity(task);
      if (work && (['paused', 'cancelled'].includes(work.status) || work.status === 'blocked' && !task.metadata?.nativeEngineReview)) { hold('work-stopped', work); return; }
      if (heldBeforeCutover(work, task.createdAt)) { hold('pre-cutover-wait', work); return; }
      const controller = new AbortController();
      const conversationScheduler = task.workId ? scheduler : frontendScheduler;
      const promise = conversationScheduler.run(task.conversationId || task.sessionId, async () => {
        if (controller.signal.aborted) return;
        task = store.getTask(task.id);
        if (task.status !== 'accepted') return;
        const currentWork = task.workId && services.works.get(task.workId);
        if (settleObsoleteEnvironmentTask(currentWork)) return;
        if (currentWork && (['paused', 'cancelled'].includes(currentWork.status) || currentWork.status === 'blocked' && !task.metadata?.nativeEngineReview)) { hold('work-stopped', currentWork); return; }
        if (heldBeforeCutover(currentWork, task.createdAt)) { hold('pre-cutover-wait', currentWork); return; }
        const cutoverRecovery = task.metadata?.cutoverRecoveryBindingId;
        if (cutoverRecovery && pendingCutoverRecovery(currentWork)?.id !== cutoverRecovery) {
          hold('cutover-recovery-state-changed', currentWork); return;
        }
        if (currentWork?.status === 'waiting' && currentWork.waiting?.dependencyWorkId &&
          store.getRecord('work-waits', currentWork.waiting.id)?.status === 'pending') { hold('dependency-pending', currentWork); return; }
        if (currentWork?.status === 'waiting' && currentWork.waiting?.kind === 'tool-maintenance' &&
            currentWork.executor?.kind === 'native' && !task.metadata?.nativeEngineReview) { hold('engine-maintenance-pending', currentWork); return; }
        // A later request can be accepted while its predecessor is still active.
        // The predecessor may finish after acceptance, so refresh at actual
        // queue start as well; its completed state does not describe this task.
        const native = currentWork && services.works.executor(currentWork).kind === 'native';
        if (currentWork && !cutoverRecovery && ['waiting', 'completed'].includes(currentWork.status) &&
            !(native && (task.metadata?.nativeEngineReview || ['native-input', 'tool-maintenance', 'native-recovery'].includes(currentWork.waiting?.kind))))
          services.works.update(currentWork.id, { status: 'active', waiting: null, lastError: null, executionOutcome: null });
        // Keep each accepted request and its publication route intact in the work queue.
        if (currentWork) services.works.update(currentWork.id, { lastTaskId: task.id });
        try {
          const start = () => {
            journal.start(task, currentWork ? 'advance-accepted-step' : 'handle-accepted-source',
              { currentWorkStatus: currentWork?.status, executor: currentWork && services.works.executor(currentWork).kind,
                routeOnly: Boolean(task.metadata?.routeOnly) });
            engine.maintenance.activity(task); return store.updateTask(task.id, { status: 'running', startedAt: at() });
          };
          const result = native ? await services.nativeEngine.execute(start(), { signal: controller.signal }) :
            await engine.run(task, { signal: controller.signal, onStart: start });
          store.updateTask(task.id, { status: 'completed', result, finishedAt: at(), activity: {
            phase: result.suspended ? 'waiting' : 'completed', label: result.handoff ? '已交给独立工作处理' : result.suspended ? waitingLabel(task.workId && services.works.get(task.workId)) : '已完成本次任务',
            motion: result.handoff ? 'exclaim' : result.suspended ? 'notify' : 'burst', source: 'execution', updatedAt: at() } });
          for (const pending of store.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id)) {
            if (result.steeredMessageIds?.includes(pending.messageId)) {
              journal.note(pending, 'task', { boundary: 'task', decision: 'reuse-active-conversation', runtimeCheck: 'confirmed',
                facts: { activeTaskId: task.id } });
              journal.settled(store.updateTask(pending.id, { status: 'completed', result: { content: '', consumedBy: task.id }, finishedAt: at() }));
            }
            else store.updateTask(pending.id, { steeredIntoTaskId: null });
          }
          let latest = task.workId && services.works.get(task.workId);
          const liveOperation = latest?.bindings?.findLast(binding => binding.type === 'native-tool' && ['queued', 'starting', 'running', 'awaiting-input', 'stopping'].includes(binding.status));
          if (latest?.status === 'active' && liveOperation) latest = services.works.update(latest.id, { status: 'waiting',
            waiting: { kind: 'native-execution', operationId: liveOperation.operationId, reason: '等待 ' + liveOperation.resourceName + ' 的原生操作' } });
          if (latest?.status === 'active' && !cutoverRecovery && services.works.executor(latest).kind === 'pi') {
            const execution = services.works.execution(task), continuationId = execution.actionId || execution.executionEventId;
            const prior = store.getRecord('work-continuation', continuationId);
            const observation = JSON.stringify({ progress: latest.progress, content: result.content, bindings: latest.bindings });
            const repeated = prior?.observation === observation ? (prior.repeated || 0) + 1 : 0;
            store.putRecord('work-continuation', { id: continuationId, workId: latest.id, observation, repeated });
            journal.note(task, 'continuation', { boundary: 'work-continuation',
              decision: repeated >= 2 ? 'stop-unchanged-chain' : 'continue-same-work', runtimeCheck: repeated >= 2 ? 'adjusted' : 'confirmed',
              facts: { repeated, executionEventId: execution.executionEventId, workId: latest.id }, result: { status: 'pending' } });
            if (repeated >= 2) {
              services.works.update(latest.id, { status: 'blocked', lastError: { code: 'NO_PROGRESS', message: 'Repeated unchanged work outcome; chain stopped, work retained' } });
              journal.note(task, 'continuation', { result: { status: 'blocked', code: 'NO_PROGRESS' } });
            }
            else {
              const next = await services.works.dispatch(latest.id, { id: `continue:${task.id}`, metadata: { executionEventId: execution.executionEventId, executionTaskId: execution.executionTaskId,
                automaticContinuation: true },
                content: 'Continue the existing work from durable S3 and receipts. Advance the next concrete step; when waiting use work_wait. '
                  + (latest.id.startsWith('onboarding-') ? 'Complete configuration through workspace_setup so it can verify the result and advance the guide. Do not mark this work completed or cancelled yourself. '
                    : 'When finished use work_update completed. ')
                  + 'A result already published for this execution stays published; status cleanup does not need another notification. If no actionable step remains, record the actual blocker. Do not repeat uncertain side effects.' },
              task);
              journal.note(task, 'continuation', { result: { status: next.status, accepted: next.accepted, operationId: next.operationId, taskId: next.taskId } });
            }
          }
        }
        catch (error) { store.updateTask(task.id, { status: controller.signal.aborted ? (state === 'stopping' ? 'interrupted' : 'cancelled') : 'failed',
          error: clean({ name: error.name, code: error.code, message: error.message }), finishedAt: at(), activity: {
            phase: controller.signal.aborted ? 'cancelled' : 'failed', label: controller.signal.aborted ? '任务已停止' : '任务遇到问题', motion: controller.signal.aborted ? 'confused' : 'alert', source: 'execution', updatedAt: at() } });
          const corrections = store.listTasks({ status: 'accepted', limit: 10000 }).filter(item => item.steeredIntoTaskId === task.id);
          for (const pending of corrections) store.updateTask(pending.id, { steeredIntoTaskId: null });
          const current = task.workId && services.works.get(task.workId);
          if (current && ['active', 'waiting'].includes(current.status) && state !== 'stopping') {
            const unknown = native && error.outcomeUnknown;
            if (current.status === 'active' || native && !['native-input', 'tool-maintenance'].includes(current.waiting?.kind))
              services.works.update(current.id, { status: corrections.length ? 'active' : unknown ? 'waiting' : 'blocked',
                ...(unknown ? { waiting: { kind: 'native-execution', operationId: task.metadata?.workEventId,
                  reason: '原生提交结果待确认' }, executionOutcome: { kind: 'result-unknown', operationId: task.metadata?.workEventId } } : {}),
                lastError: clean({ code: error.code, message: error.message }) });
          }
          const next = store.getRecord('business-decisions', `${task.id}:continuation`);
          if (next?.result?.status === 'pending') journal.note(task, 'continuation', { result: { status: 'unconfirmed' } });
        }
        const settled = task.workId && services.works.get(task.workId), settledTask = store.getTask(task.id);
        journal.settled(settledTask);
        const execution = services.works.execution(task);
        const alreadyPublished = settled && store.listRecords('work-notifications').some(item => item.workId === settled.id &&
          (execution.executionEventId ? item.executionEventId === execution.executionEventId : item.taskId === task.id));
        if (settled && settled.executionOutcome?.onboardingCompletedTaskId !== task.id && !settledTask.result?.late && state !== 'stopping' && ['completed', 'cancelled', 'blocked'].includes(settled.status) && !alreadyPublished) {
          const content = settledTask.result?.content || settledTask.error?.message || settled.progress || `工作状态：${settled.status}`;
          await services.notify({ id: settled.id, notificationId: `settled:${execution.executionEventId || task.id}`, publication: 'automatic', content }, task, {})
            .catch(error => emit('work.notification_pending', { workId: settled.id, error: error.message }));
        }
      }, { signal: controller.signal, priority: task.metadata?.priority }).catch(error => {
        if (state !== 'stopping' && store.getTask(task.id)?.status === 'accepted')
          journal.settled(store.updateTask(task.id, { status: 'cancelled', error: { message: error.message }, finishedAt: at() }));
      }).finally(() => { if (!store.closed) engine.maintenance.activity(task); jobs.delete(task.id); });
      jobs.set(task.id, { controller, promise });
    };
    const cancel = id => {
      const task = store.getTask(id); if (!task) throw failure(404, 'Unknown task');
      if (terminalTaskStates.has(task.status)) return task;
      store.updateTask(id, { cancelRequested: true }); jobs.get(id)?.controller.abort(new Error('Task cancelled'));
      if (task.status === 'accepted') journal.settled(store.updateTask(id, { status: 'cancelled', finishedAt: at() }));
      return store.getTask(id);
    };
    const accept = (envelope, source, { deferSchedule = false } = {}) => {
      const recovery = envelope.metadata?.productionRecovery;
      if (recovery && (source !== 'controller' || envelope.kind !== 'request' || envelope.workId || envelope.metadata.actor !== 'user' ||
          envelope.content?.trigger?.id !== recovery.sourceMessageId || envelope.content?.room?.id !== recovery.roomId ||
          verifiedProductionRecovery(store, recovery)?.outcome !== 'unsubmitted'))
        throw failure(409, 'The exact original implementation is no longer eligible for recovery', 'PRODUCTION_RECOVERY_NOT_CURRENT');
      const review = envelope.metadata?.workflowReview;
      if (review && (source !== 'controller' || envelope.kind !== 'event' || envelope.workId ||
        !['inspect', 'answer'].includes(review.phase) || envelope.metadata.roomId !== envelope.content?.room?.id ||
        envelope.content?.workflowReview?.id !== review.id || (review.phase === 'inspect' ?
          config.botId !== workflowReviewerId || envelope.metadata.actor !== 'system' :
          config.botId !== envelope.content?.workflowReview?.targetBotId || envelope.metadata.actor !== workflowReviewerId)))
        throw failure(403, 'Workflow review requires an authenticated, scoped room delivery');
      if (envelope.metadata?.groupObservation && (source !== 'controller' || envelope.kind !== 'event' || envelope.workId))
        throw failure(403, 'Group observation requires an authenticated room delivery');
      if (envelope.metadata?.teamStaffing && (source !== 'controller' || envelope.kind !== 'event' || envelope.workId ||
        envelope.metadata.actor !== 'system' || envelope.metadata.roomId !== envelope.content?.room?.id))
        throw failure(403, 'Staffing requires an authenticated room event');
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
      if (envelope.metadata?.sourceType !== 'external' && !envelope.metadata?.nativeEngineReview && envelope.kind === 'event' && (envelope.metadata?.purpose === 'fyi' || work?.status === 'completed')) {
        journal.note(task, 'task', { boundary: 'task', decision: 'observe-without-action', runtimeCheck: 'confirmed',
          facts: { reason: envelope.metadata?.purpose === 'fyi' ? 'fyi' : 'work-completed' } });
        accepted.task = store.updateTask(task.id, { status: 'completed', result: { content: '', observed: true }, finishedAt: at() });
        journal.settled(accepted.task);
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
        } else if (!envelope.metadata?.cutoverRecoveryBindingId && !envelope.metadata?.nativeEngineReview &&
          !(work.executor?.kind === 'native' && ['native-input', 'tool-maintenance', 'native-recovery'].includes(work.waiting?.kind)) &&
          (['waiting', 'blocked'].includes(work.status) || work.status === 'completed' && envelope.kind === 'request')) {
          services.works.update(work.id, { status: 'active', waiting: null, lastError: null });
        }
      }
      if (!deferSchedule) schedule(task);
      return accepted;
    };
    services.works = new WorkService({ store, botId: config.botId, accept, schedule, cancel, clean,
      selectModel: id => {
      const selected = id ? modelConnection(config.model, id) : selectedConnection(config);
      return { connectionId: selected.id, modelId: selected.model, thinkingLevel: selected.thinkingLevel };
    } });
    services.nativeEngine = nativeWorkExecutor({ store, services, emit, clean });
    services.reviewNative = (task, options) => engine.run(task, options);
    services.bindRecoveredEngine = async (work, inspect = false) => {
      if (work.executor?.kind !== 'pi' || !work.bindings?.some(binding => binding.type === 'native-recovery' &&
          (binding.status === 'resumable' || inspect && binding.status === 'recovery-required'))) return work;
      const { recovery } = await services.executors(work.id);
      if (!recovery) return work;
      const current = services.works.get(work.id);
      if (current.revision !== work.revision) throw failure(409, '原工作已变化，请从当前记录继续。');
      return services.works.update(work.id, { expectedRevision: work.revision,
        executor: { kind: 'native', resourceId: recovery.id, name: recovery.name, ...(work.executor.target ? { target: work.executor.target } : {}) } });
    };
    services.stopWork = async (target, status, task) => services.works.stop(target.id, status, target.controlRevision || 0, taskSource(task, store).receivedAt);
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
      if (source?.formId === work?.id && source?.formId && !source.roomId)
        return store.putRecord('work-notifications', { ...record, status: 'local-only', waiting: undefined });
      const target = source?.roomId && (source.replyTo || source.formId === work.id) ? { roomId: source.roomId, replyTo: source.replyTo, botId: undefined } :
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
      const contribution = execution.executionEventId && store.getRecord('work-events', execution.executionEventId)?.contributionResult;
      if (contribution?.reference?.roomId === authorizedSource?.roomId && contribution?.reference?.messageId && input.resultKind !== 'progress')
        input = { ...input, sourceRefs: [...(input.sourceRefs || [{ type: 'work', workId: work.id, taskId: task.id }]),
          { ...contribution.reference, purpose: 'production-input' }] };
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
    const resolveDutyContribution = async (event, source) => {
      const work = services.works.get(event.workId);
      if (!work || work.waiting?.operationId !== event.id || !['waiting', 'blocked'].includes(work.status)) return false;
      const original = event.authorization?.source;
      const setState = (status, reason) => {
        const current = services.works.get(event.workId);
        if (current?.waiting?.operationId === event.id && ['waiting', 'blocked'].includes(current.status) &&
            (current.status !== status || current.waiting.reason !== reason))
          services.works.update(work.id, { status, waiting: { ...current.waiting, reason } });
      };
      if (!source || source.cancelRequested || source.status === 'cancelled') {
        setState('blocked', '原请求的协调回合已停止，未开始制作。可在原工作明确继续。');
        return false;
      }
      if (!terminalTaskStates.has(source.status)) return false;
      const result = await services.capability('chatroom_read', { roomId: original.roomId,
        dutyContribution: { planId: event.contributionPlanId, workId: event.workId, operationId: event.id } }, source, { operationId: event.id });
      if (result.status === 'blocked') {
        setState('blocked', result.error || '职责执行未取得可用交付。可在原工作明确继续。');
        return false;
      }
      if (result.status !== 'completed') {
        const reason = { 'registered-room-plan': '等待原项目群接收已登记的职责协作。',
          'responsible-member': '正在等候原请求范围内的职责负责人。',
          'ambiguous-responsible-member': '有多个匹配职责，尚未确认唯一负责人。',
          'responsible-member-unavailable': '已登记职责的负责人暂不可用。' }[result.waitingFor];
        setState('waiting', reason || '等待同一请求的职责负责人交付制作所需部分。');
        return false;
      }
      const evidence = result.evidence;
      const production = event.authorization?.production, dutyKey = production?.participant?.dutyKey;
      const ownerDelivery = production?.after?.condition === OWNER_DELIVERY;
      if (result.planId !== event.contributionPlanId || result.operationId !== event.id || result.workId !== event.workId ||
          result.sourceMessageId !== original.replyTo || !result.dutyKey || dutyKey && result.dutyKey !== dutyKey || !result.deliveryId || !result.taskId ||
          evidence?.reference?.type !== 'room' || evidence.reference.roomId !== original.roomId ||
          evidence.reference.messageId !== `reply:${result.deliveryId}` || !evidence.author || !evidence.content ||
          ownerDelivery && (evidence.author !== production.after.ownerBotId ||
            JSON.stringify(result.dependency) !== JSON.stringify(production.after))) {
        setState('blocked', '职责交付的来源与当前制作操作不符，未开始制作。');
        return false;
      }
      return store.transaction(() => {
        const current = services.works.get(work.id), saved = store.getRecord('work-events', event.id);
        if (!['waiting', 'blocked'].includes(current?.status) || current.waiting?.operationId !== event.id ||
            saved?.status !== 'pending' || saved.receipt || store.getTask(source.id)?.cancelRequested ||
            ownerDelivery && saved.contributionControlRevision !== (current.controlRevision || 0)) return false;
        setState('waiting', '已收到同源职责交付，正在提交原制作步骤。');
        const { evidence, status, ...identity } = result;
        const contributionResult = { ...identity, reference: evidence.reference, author: evidence.author };
        if (saved.contributionResult) {
          if (JSON.stringify(saved.contributionResult) === JSON.stringify(contributionResult)) return true;
          setState('blocked', '职责交付的标识发生变化，未开始制作。');
          return false;
        }
        const guidance = 'The same-source owner contribution has already been delivered in evidence; do not request it again. Apply its concrete relevant decisions to the actual deliverables within the original user scope. Resolve conflicts against the exact earlier materials and original requirements. If you depart from a material recommendation, explain the specific reason in the delivery. Attribute only what you actually used and keep the owner publication reference.';
        store.putRecord('work-events', clean({ ...saved, contributionResult,
          content: { ...saved.content, evidence: [...(saved.content.evidence || []), evidence],
            handoff: { ...saved.content.handoff, instruction: [saved.content.handoff?.instruction, guidance].filter(Boolean).join('\n') },
            instruction: [saved.content.instruction, guidance].filter(Boolean).join('\n') } }));
        return true;
      });
    };
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
          if (!target || ['paused', 'cancelled'].includes(target.status) || wait.unresolvedTaskId ||
            wait.mode === 'follow_up' && heldBeforeCutover(target, wait.createdAt)) continue;
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
          const work = services.works.get(event.workId);
          if (heldBeforeCutover(work, event.createdAt) || event.metadata?.cutoverRecoveryBindingId &&
            pendingCutoverRecovery(work)?.id !== event.metadata.cutoverRecoveryBindingId) continue;
          const sourceId = event.sourceTaskId || event.requestTaskId;
          const source = sourceId && store.getTask(sourceId);
          try {
            if (event.contributionPlanId && !await resolveDutyContribution(event, source)) continue;
            await services.works.dispatch(event.workId, { id: event.id.slice(event.workId.length + 1), kind: event.kind, content: event.content, metadata: event.metadata }, source || {});
          }
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
        if (method === 'POST' && parts[2] === 'workflow-correction' && parts.length === 3) {
          needAdmin();
          const task = ownTask(parts[1]), source = taskSource(task, store), body = await readBody(request);
          if (config.accepting === false || task.status !== 'completed' || task.metadata?.workflowReview?.phase !== 'answer' ||
              task.metadata.workflowReview.id !== body.reviewId || task.result?.workflowReview?.kind !== 'correct')
            throw failure(409, 'There is no current owned correction for this review');
          journal.note(task, 'workflow-correction', { boundary: 'review', decision: 'correct-original-work',
            facts: { reviewId: body.reviewId, workId: source.input?.workflowReview?.work?.id },
            runtimeCheck: 'checking', result: { status: 'pending' } });
          const result = applyWorkflowCorrection({ store, works: services.works, task, source, result: task.result.workflowReview });
          journal.note(task, 'workflow-correction', { runtimeCheck: result.outcome === 'corrected' ? 'adjusted' : 'confirmed',
            result: { status: result.outcome, ...result } });
          return result;
        }
      }
      if (method === 'GET' && parts[0] === 'messages') return store.listMessages().filter(message => auth.admin || message.from === auth.source);
      needAdmin();
      if (parts[0] === 'works') {
        const id = parts[1];
        if (method === 'GET') return id ? services.works.get(id) : services.works.list({ status: parsed.searchParams.get('status'), query: parsed.searchParams.get('query') });
        if (method === 'POST' && id === 'form' && parts.length === 2) {
          if (state !== 'ready' || config.accepting === false) throw failure(503, '当前成员无法接收工作。');
          const body = await readBody(request);
          if (!engine.health().configured)
            throw failure(503, 'Model credential is not configured', 'MODEL_UNCONFIGURED');
          response.statusCode = 202;
          return services.works.submitForm(body);
        }
        if (method === 'POST' && !id) return services.works.create(await readBody(request));
        if (method === 'PATCH' && id) {
          const body = await readBody(request);
          if (body.status === 'active' && body.controlRevision !== undefined) {
            const work = services.works.get(id);
            if (work && (work.controlRevision || 0) === body.controlRevision) await services.bindRecoveredEngine(work);
          }
          const work = ['paused', 'cancelled'].includes(body.status) ? services.works.stop(id, body.status, body.controlRevision) :
            body.status === 'active' && body.controlRevision !== undefined ? await services.works.resume(id, body.controlRevision) : services.works.update(id, body);
          if (body.status === 'active') void wake().catch(() => {});
          return work;
        }
        if (method === 'POST' && parts[2] === 'events') return services.works.dispatch(id, await readBody(request));
        if (method === 'POST' && parts[2] === 'user-input') {
          const work = services.works.get(id), body = await readBody(request);
          if (!work) throw failure(404, 'Unknown work');
          if (!/^[\w:.-]{1,256}$/.test(body.id || '') || typeof body.content !== 'string' || !body.content.trim()) throw failure(400, 'Invalid work input');
          if (body.fileAccessRequestId || work.waiting?.fileAccess)
            return services.works.answerFileAccess(id, { ...body, fileAccessRequestId: body.fileAccessRequestId || work.waiting.fileAccess.requestId });
          const original = work.sources.find(item => item.roomId);
          const accepted = accept({ id: 'work-input:' + id + ':' + body.id, to: config.botId, workId: id, kind: 'request',
            content: { type: 'user-work-input', instruction: body.content, deliveredToNativeOperation: body.delivered || null },
            metadata: { actor: 'user', roomId: original?.roomId, originMessageId: original?.replyTo, priority: 'foreground', correction: true } }, 'controller');
          return { accepted: true, taskId: accepted.task.id, status: accepted.task.status, delivered: body.delivered || null };
        }
        if (method === 'POST' && parts[2] === 'native-wait') {
          const body = await readBody(request), work = services.works.get(id), task = store.getTask(body.taskId);
          if (!work || task?.workId !== id) throw failure(409, 'Maintenance source work does not match');
          if (work.status === 'active') return services.works.update(id, { status: 'waiting', waiting: {
            kind: 'tool-maintenance', maintenanceId: body.maintenanceId, resourceId: body.resourceId, reason: '等待 ' + body.resourceName + ' 的维护 Bot',
          } });
          return work;
        }
        if (method === 'POST' && parts[2] === 'native-remote') {
          const body = await readBody(request), work = services.works.get(id), task = store.getTask(body.taskId);
          if (!work || task?.workId !== id) throw failure(409, 'Remote operation source does not match');
          const binding = clean({ ...body, id: 'native-api:' + body.resourceId + ':' + body.operationId, type: 'native-api' });
          if (!work.bindings.some(item => item.id === binding.id && item.status === binding.status))
            services.works.update(id, { bindings: [...work.bindings.filter(item => item.id !== binding.id), binding] });
          return { observed: true };
        }
        if (method === 'POST' && parts[2] === 'native-event') {
          const body = await readBody(request), work = services.works.get(id);
          if (!work) throw failure(404, 'Unknown work');
          const task = body.taskId && store.getTask(body.taskId);
          const environment = task?.workId === id && isEnvironmentInitializationSource(services.works.execution(task).authorization?.source);
          store.transaction(() => {
            if (environment && store.getRecord('work-observations', body.id)) return;
            const observation = store.putRecord('work-observations', { id: body.id, workId: id, taskId: task?.id,
              content: clean(body.content), metadata: clean(body.metadata), observedAt: at() });
            if (environment) emit('work.maintenance_observed', observation, { workId: id, taskId: task.id });
          });
          if (environment || task?.workId !== id || ['paused', 'cancelled', 'completed'].includes(work.status)) return { observed: true, wakeup: false };
          const resumesEngine = work.executor?.kind === 'native' && work.waiting?.kind === 'tool-maintenance' &&
            work.waiting.maintenanceId === body.metadata?.maintenanceId;
          if (work.waiting?.kind === 'tool-maintenance' && work.waiting.maintenanceId === body.metadata?.maintenanceId)
            services.works.update(id, { status: 'active', waiting: null });
          if (resumesEngine) return services.works.dispatch(id, { id: body.id, kind: 'request',
            content: task.input, metadata: { ...body.metadata, nativeEngineResume: true, priority: 'background' } }, task);
          return services.works.dispatch(id, { id: body.id, kind: 'event', content: body.content,
            metadata: { ...body.metadata, sourceType: 'native-tool', priority: 'background' } }, task);
        }
        if (method === 'POST' && parts[2] === 'native-recovery') {
          const body = await readBody(request), work = services.works.get(id);
          const binding = work?.bindings.find(item => item.id === body.bindingId && item.type === 'native-recovery');
          if (!binding || !['resumable', 'unavailable'].includes(body.status) || !body.observationId || !body.evidence) throw failure(409, 'Original recovery binding is unavailable');
          const settled = { ...binding, status: body.status, resourceId: body.resourceId,
            observationId: body.observationId, evidence: body.evidence, observedAt: body.observedAt };
          services.works.update(id, { expectedRevision: body.expectedRevision, bindings: work.bindings.map(item => item === binding ? settled : item) });
          emit('native.recovery', settled, { workId: id });
          return settled;
        }
        if (method === 'POST' && parts[2] === 'native-state') {
          const { operation, events = [], fromOffset, toOffset, more } = await readBody(request);
          const task = operation?.taskId && store.getTask(operation.taskId);
          const work = services.works.get(id);
          if (!work || task?.workId !== id || operation.workId !== id) throw failure(409, 'Native operation source does not match');
          const bindingId = 'native:' + operation.operationId;
          const prior = store.getRecord('native-work-state', bindingId + ':' + id);
          const signature = JSON.stringify([operation.status, operation.pid, operation.nativeSessionId, operation.nativeTurnId,
            operation.pending, operation.error, operation.reconciliation, toOffset]);
          if (prior?.signature !== signature) store.transaction(() => {
            const binding = clean({ ...operation, id: bindingId, type: 'native-tool' });
            const bindings = [...work.bindings.filter(item => item.id !== bindingId), binding];
            const stop = work.externalStop;
            const running = bindings.some(item => item.type === 'native-tool' && ['queued', 'starting', 'running', 'awaiting-input', 'stopping'].includes(item.status));
            const pending = operation.pending?.[0];
            const progressEvent = events.findLast(event => ['progress', 'result'].includes(event.type));
            const progress = progressEvent && !['paused', 'cancelled', 'completed'].includes(work.status) ? progressEvent.text : null;
            const waiting = pending && ['active', 'waiting'].includes(work.status)
              ? { status: 'waiting', waiting: { kind: 'native-input', reason: pending.text, operationId: operation.operationId } }
              : work.status === 'waiting' && ['native-input', 'native-execution'].includes(work.waiting?.kind) && work.waiting.operationId === operation.operationId && (work.waiting.kind === 'native-input' || ['completed', 'failed', 'stopped', 'unknown', 'superseded'].includes(operation.status))
                ? { status: 'active', waiting: null } : {};
            services.works.update(id, { bindings, ...(progress ? { progress, ...(operation.engine ? { checkpoint: { ...work.checkpoint,
              evidence: { kind: 'executor-commentary', operationId: operation.operationId, threadId: operation.nativeSessionId,
                turnId: progressEvent.turnId, itemId: progressEvent.itemId, observedAt: progressEvent.at } } } : {}) } : {}), ...waiting,
              ...(stop?.status === 'pending' && !running && stop.bindingId === bindingId ? { externalStop: { ...stop,
                status: operation.status === 'unknown' ? 'unknown' : operation.status === 'completed' ? 'completed' :
                  operation.status === 'stopped' && operation.nativeTurnId ? 'interrupted' : operation.status === 'failed' ? 'failed' : 'local-stopped',
                threadId: operation.nativeSessionId, turnId: operation.nativeTurnId, observedAt: at() } } : {})
            }, { control: true });
            for (const event of events) emit('native.' + event.type, { operationId: operation.operationId, resourceName: operation.resourceName, ...event }, { workId: id, taskId: task.id });
            const terminal = ['completed', 'failed', 'stopped', 'unknown', 'superseded'].includes(operation.status);
            if (terminal) {
              const result = { id: bindingId + ':' + operation.status, workId: id, taskId: task.id, operationId: operation.operationId,
                executionEventId: services.works.execution(task).executionEventId, content: { type: 'native-execution', ...binding }, observedAt: at() };
              store.putRecord('work-observations', result);
              store.putRecord('work-results', { ...result, id: 'native-result:' + result.id, kind: operation.status === 'stopped' ? 'interrupted' :
                operation.status === 'unknown' ? 'result-unknown' : operation.status, source: 'native-execution' });
            }
            store.putRecord('native-work-state', { id: bindingId + ':' + id, signature, offset: toOffset, fromOffset });
          });
          const registeredWait = operation.status !== 'unknown' && store.listRecords('work-waits').some(wait => wait.workId === id && wait.status === 'pending' &&
            (wait.dependencyEventId === operation.operationId || wait.taskId === task.id));
          if (registeredWait) void wake().catch(() => {});
          if (operation.engine && !more && !['paused', 'cancelled', 'completed'].includes(work.status) &&
              ['completed', 'failed', 'stopped', 'unknown', 'superseded'].includes(operation.status)) {
            await services.works.dispatch(id, { id: bindingId + ':engine-review:' + operation.status, kind: 'event',
              content: { type: 'native-engine-result', operationId: operation.operationId },
              metadata: { actor: 'system', sourceType: 'native-tool', nativeEngineReview: operation.operationId, priority: 'foreground' } }, task);
          } else if (!operation.engine && !registeredWait && !task.metadata?.cutoverRecoveryBindingId && !['paused', 'cancelled', 'completed'].includes(work.status) &&
            ['completed', 'failed', 'stopped', 'unknown', 'superseded'].includes(operation.status)) {
            await services.works.dispatch(id, { id: bindingId + ':' + operation.status, kind: 'event',
              content: { type: 'native-execution', operation, instruction: 'Inspect the original receipt and output in catalog_native_status. Use actual results to continue the accepted step. Preserve operation identity and reconcile unknown effects before another write.' },
              metadata: { actor: 'system', sourceType: 'native-tool', priority: 'background' } }, task);
          }
          return { observed: true, status: operation.status };
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
        if (method === 'POST' && parts[1] === 'environment') {
          const body = clean(await readBody(request)), work = services.works.get(body.workId);
          if (!work?.sources.some(isEnvironmentInitializationSource)) throw failure(409, 'The original environment initialization work is unavailable');
          return writeKnowledgeDocument(engine.maintenance, store, body, { environment: true });
        }
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
    state = 'ready'; readyAt = at(); emit('bot.ready', identity()); await atomicJson(join(config.dataDir, 'run', 'current.json'), identity());
    for (const work of store.listRecords('works')) {
      const migrated = pendingCutoverRecovery(work);
      const original = migrated?.taskId && store.getTask(migrated.taskId);
      if (original?.workId === work.id && services.works.execution(original).authorization?.source) {
        const bound = await services.bindRecoveredEngine(work, true).catch(error => {
          emit('work.recovery_pending', { workId: work.id, message: error.message }); return work;
        });
        await services.works.dispatch(work.id, { id: 'recover-native:' + migrated.id, kind: 'event',
          metadata: { sourceType: 'native-tool', priority: 'background', cutoverRecoveryBindingId: migrated.id },
          content: { type: 'native-cutover-recovery', binding: migrated, engine: bound.executor?.kind === 'native' ? bound.executor.name : undefined,
            instruction: 'Use the catalog and the assigned maintainer to inspect the original tool session, progress and artifacts. Limit this startup step to read-only observations and recording the reconciliation. Preserve uncertain results, and use the normal work flow to continue once the original effects and next authorized step are clear.' } }, original).catch(error =>
          emit('work.recovery_pending', { workId: work.id, message: error.message }));
      }
    }
    for (const work of services.works.list({ limit: 500 }).filter(work => work.status === 'active' ||
        work.executor?.kind === 'native' && work.status === 'waiting' && !['user-input', 'native-input', 'tool-maintenance'].includes(work.waiting?.kind))) {
      const last = work.lastTaskId && store.getTask(work.lastTaskId);
      const liveNative = work.bindings?.some(item => item.type === 'native-tool' && ['queued', 'starting', 'running', 'awaiting-input', 'stopping'].includes(item.status));
      const unresolvedOriginal = work.bindings?.some(item => item.type === 'native-recovery' && item.status === 'recovery-required' && last?.createdAt <= item.migratedAt);
      if (last?.status === 'interrupted' && last.metadata?.sourceType !== 'external' && !last.metadata?.cutoverRecoveryBindingId && !liveNative && !unresolvedOriginal) try {
        if (last.metadata?.nativeEngineReview) {
          await services.works.dispatch(work.id, { id: 'recover-native-review:' + last.id, kind: 'event',
            metadata: { nativeEngineReview: last.metadata.nativeEngineReview, priority: 'foreground' }, content: last.input }, last);
          continue;
        }
        if (work.executor?.kind === 'native' && last.metadata?.workEventId) {
          await services.works.dispatch(work.id, { id: 'recover-native-action:' + last.id, kind: 'request',
            metadata: { nativeEngineRetryId: last.metadata.nativeEngineRetryId || last.metadata.workEventId, priority: 'foreground' }, content: last.input }, last);
          continue;
        }
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
