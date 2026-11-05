import { randomUUID } from 'node:crypto';
import { taskSource, workExecution } from '../context/sources.mjs';
import { modelText, boundedNumber, durationSeconds } from '../context/model-input.mjs';

const now = () => new Date().toISOString();
const statuses = new Set(['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

/** S3 is state and pointers only. Knowledge正文 lives in Markdown, never here. */
export class WorkService {
  constructor({ store, botId, accept, cancel, selectModel, clean = value => value }) { Object.assign(this, { store, botId, accept, cancel, selectModel, clean }); this.dispatches = new Map(); }
  get(id) { return this.store.getRecord('works', id); }
  list({ status, query, limit = 100 } = {}) {
    return this.store.listRecords('works').filter(work => (!status || work.status === status) &&
      (!query || JSON.stringify([work.id, work.goal, work.requirements, work.sources]).toLowerCase().includes(modelText(query).toLowerCase())))
      .slice(-boundedNumber(limit, 100, 1, 500));
  }
  create(input, task = {}) {
    if (typeof input.goal !== 'string' || !input.goal.trim()) fail('Work requires a goal');
    const sourceKey = task.id && !task.workId ? `task:${task.id}:action:${input.operationId || input.id}` : null;
    const handedOff = sourceKey && this.store.getRecord('work-handoffs', sourceKey);
    if (handedOff) return this.get(handedOff.workId);
    const id = input.id || randomUUID();
    if (!/^[\w.-]{1,160}$/.test(id)) fail('Invalid work id');
    const previous = this.get(id); if (previous) return previous;
    const executor = input.executor || { kind: 'pi' };
    if (!['pi', 'codex'].includes(executor.kind)) fail('Executor must be pi or codex');
    if (executor.kind === 'codex' && !['project', 'projectless'].includes(executor.target?.type)) fail('Codex requires the selected authorized project target');
    const binding = executor.kind === 'pi' ? { kind: 'pi', ...this.selectModel?.(executor.connectionId) } : executor;
    const record = this.clean({ id, botId: this.botId, conversationId: `work:${id}`, goal: input.goal,
      requirements: input.requirements || '', executor: binding, progress: '', status: 'active', waiting: null, bindings: [], notifications: [],
      sources: input.sources || (task.id ? [this.source(task)] : []),
      responsibility: input.responsibility || null, revision: 1, createdAt: now(), updatedAt: now() });
    this.store.transaction(() => {
      this.store.putRecord('works', record);
      if (sourceKey) this.store.putRecord('work-handoffs', { id: sourceKey, workId: id, createdAt: now() });
      if (input.initialHandoff) this.store.putRecord('work-events', { id: `${id}:${input.operationId || 'initial'}`, workId: id,
        kind: 'request', content: input.initialHandoff, requestTaskId: task.id, sourceTaskId: task.id,
        authorization: this.authorization(task, `${id}:${input.operationId || 'initial'}`), status: 'pending', createdAt: now() });
      this.store.appendEvent('work.created', { work: record }, { workId: id, conversationId: record.conversationId });
    });
    return record;
  }
  source(task) { const { input, ...source } = taskSource(task, this.store); return source; }
  executor(work) { return work.bindings?.some(binding => binding.type === 'codex-desktop') ? { ...work.executor, kind: 'codex' } : work.executor || { kind: 'pi' }; }
  execution(task = {}) { return workExecution(task, this.store); }
  authorization(task, actionId) {
    if (task.workId) return this.execution(task).authorization;
    const accepted = task.id && this.store.getTask(task.id);
    return accepted ? { actionId, requestTaskId: accepted.id, source: this.source(accepted) } : undefined;
  }
  executionInput(task) {
    const execution = this.execution(task);
    const original = execution.executionEventId && this.store.getRecord('work-events', execution.executionEventId)?.content;
    return task.metadata?.automaticContinuation || task.metadata?.resumeEventId ?
      { type: 'work_continuation', acceptedStep: original, continuation: task.input } : task.input;
  }
  update(id, input) {
    return this.store.transaction(() => {
      const previous = this.get(id); if (!previous) fail('Unknown work', 404);
      if (input.expectedRevision !== undefined && input.expectedRevision !== previous.revision) fail('Work changed; read current state', 409);
      if (input.status !== undefined && !statuses.has(input.status)) fail('Invalid work status');
      const patch = Object.fromEntries(Object.entries(input).filter(([key]) => ['goal', 'requirements', 'progress', 'status', 'waiting', 'bindings', 'notifications', 'sources', 'responsibility', 'lastTaskId', 'lastError', 'owner', 'notificationCursor', 'executionOutcome', 'executor'].includes(key)));
      for (const key of ['bindings', 'notifications', 'sources']) if (patch[key] !== undefined && !Array.isArray(patch[key])) fail(`${key} must be an array`);
      const record = this.clean({ ...previous, ...patch, id, revision: previous.revision + 1, updatedAt: now() });
      if (['completed', 'cancelled'].includes(record.status)) record.waiting = null;
      this.store.putRecord('works', record);
      this.store.appendEvent('work.updated', { work: record }, { workId: id, conversationId: record.conversationId });
      return record;
    });
  }
  async dispatch(id, input, task = {}) {
    const eventId = input.id || randomUUID(), key = `${id}:${eventId}`;
    if (this.dispatches.has(key)) return this.dispatches.get(key);
    const operation = this.dispatchEvent(id, { ...input, id: eventId }, task);
    this.dispatches.set(key, operation);
    try { return await operation; } finally { if (this.dispatches.get(key) === operation) this.dispatches.delete(key); }
  }
  async dispatchEvent(id, input, task = {}) {
    const work = this.get(id); if (!work) fail('Unknown work', 404);
    if (!work.executor) this.update(id, { executor: this.executor(work).kind === 'codex' ? { kind: 'codex' } : { kind: 'pi', ...this.selectModel?.() } });
    const eventId = input.id || randomUUID(), prior = this.store.getRecord('work-events', `${id}:${eventId}`);
    if (prior?.receipt) return { ...prior.receipt, duplicate: true };
    if (task.id && !task.workId && input.kind === 'request') {
      const source = this.source(task);
      if (!work.sources.some(item => item.taskId === source.taskId)) this.update(id, { sources: [...work.sources, source] });
    }
    const inherited = task.workId ? this.execution(task) : null;
    const wait = input.metadata?.waitId && this.store.getRecord('work-waits', input.metadata.waitId);
    const authorization = (wait?.targetWorkId === id && wait.authorization) || this.authorization(task, `${id}:${eventId}`);
    let intent = prior || this.store.putRecord('work-events', this.clean({ id: `${id}:${eventId}`, workId: id,
      kind: input.kind || 'event', content: input.content, requestTaskId: authorization?.requestTaskId, sourceTaskId: task.id, authorization,
      metadata: { ...input.metadata, ...(inherited?.executionEventId ? { executionEventId: inherited.executionEventId } : {}) }, status: 'pending', createdAt: now() }));
    if (!intent.authorization && intent.requestTaskId) {
      const sourceTask = this.store.getTask(intent.requestTaskId);
      const saved = sourceTask && this.authorization(sourceTask, intent.id);
      if (saved) intent = this.store.putRecord('work-events', { ...intent, authorization: saved, requestTaskId: saved.requestTaskId });
    }
    if (!intent.authorization?.source) return { accepted: false, workId: id, status: 'pending', unresolved: true,
      warning: '已保留这一步，但尚未确定实际授权来源；不会按工作最新消息猜测来源或执行。' };
    const envelope = { id: `work:${id}:${eventId}`, to: this.botId, kind: intent.kind, workId: id,
      conversationId: work.conversationId, content: intent.content, metadata: { authority: 'internal-event', sourceType: 'internal', actor: this.botId, ...intent.metadata,
        workEventId: intent.id, origin: intent.authorization?.source, priority: intent.metadata?.priority || 'background' } };
    if (envelope.content === undefined) fail('Work event requires content');
    const result = await this.accept(envelope, task.source || 'controller');
    const receipt = { accepted: true, duplicate: result.duplicate, workId: id, taskId: result.task.id, status: result.task.status, executor: this.executor(work).kind };
    this.store.putRecord('work-events', { ...this.store.getRecord('work-events', intent.id), receipt, status: 'accepted' });
    return receipt;
  }
  wait(id, input = {}, task = {}) {
    const work = this.get(id); if (!work) fail('Unknown work', 404);
    const bound = work.bindings?.some(binding => binding.type === 'codex-desktop') || work.waiting?.kind === 'external';
    const events = this.store.listRecords('work-events').filter(event => event.requestTaskId === task.id && event.receipt?.accepted);
    if (!input.unresolvedTaskId && !input.taskId && !input.until && !input.dependencyWorkId) {
      const dependencies = [...new Set(events.filter(event => event.workId !== id).map(event => event.workId))];
      const peers = this.store.listOutbox().filter(item => item.taskId === task.id && item.receipt?.taskId);
      if (dependencies.length === 1) input = { ...input, dependencyWorkId: dependencies[0], event: 'result' };
      else if (peers.length === 1) input = { ...input, taskId: peers[0].receipt.taskId, botId: peers[0].to };
      else if (bound || events.some(event => event.workId === id)) input = { ...input, dependencyWorkId: id, event: 'result' };
      else if (work.waiting?.taskId || work.waiting?.dependencyWorkId || work.waiting?.until) input = { ...work.waiting, ...input };
    }
    if (!input.taskId && !input.dependencyWorkId && input.event && bound) input = { ...input, dependencyWorkId: id };
    if (!input.unresolvedTaskId && !input.taskId && input.dependencyWorkId) {
      const candidates = events.filter(event => event.workId === input.dependencyWorkId);
      if (candidates.length === 1) input = { ...input, taskId: candidates[0].receipt.taskId };
      else if (candidates.length > 1) input = { ...input, unresolvedTaskId: 'multiple-current-executions' };
      else {
        const dependency = this.get(input.dependencyWorkId);
        const operationId = dependency?.waiting?.operationId || dependency?.bindings?.find(binding => binding.type === 'codex-desktop')?.operationId;
        const event = operationId && this.store.getRecord('work-events', operationId);
        if (event?.receipt?.taskId) input = { ...input, taskId: event.receipt.taskId };
        else if (operationId) input = { ...input, dependencyEventId: operationId };
        else if (dependency?.lastTaskId) input = { ...input, taskId: dependency.lastTaskId };
        else input = { ...input, unresolvedTaskId: 'execution-not-yet-identified' };
      }
    }
    if (input.taskId && (!input.botId || input.botId === this.botId)) {
      const dependency = this.store.getTask(input.taskId);
      if (dependency?.workId) input = { ...input, dependencyWorkId: dependency.workId,
        dependencyEventId: this.execution(dependency).executionEventId };
    }
    if (!input.taskId && !input.until && !input.event && !input.dependencyWorkId && !input.unresolvedTaskId) fail('Waiting requires a task, work result, deadline, or event');
    if (input.until && !Number.isFinite(Date.parse(input.until))) {
      const duration = durationSeconds(input.until);
      if (Number.isFinite(duration) && duration >= 0) input = { ...input, until: new Date(Date.parse(task.createdAt || now()) + duration * 1000).toISOString() };
      else if (input.taskId || input.dependencyWorkId || bound) input = { ...input, until: undefined, ...(!input.taskId && !input.dependencyWorkId ? { event: 'result' } : {}) };
      else fail('这一步还没有有效的等待时间或已知外部绑定。请补充该条件；其他工作和材料保留。');
    }
    const waitId = `${id}:${task.id || 'runtime'}:${input.waitId || randomUUID()}`;
    const previous = this.store.getRecord('work-waits', waitId);
    if (previous) return { accepted: true, workId: id, waitId, status: previous.status };
    const targetWorkId = input.targetWorkId || id;
    if (!this.get(targetWorkId)) fail('Unknown follow-up work', 404);
    const instruction = modelText(input.handoff?.handoff?.instruction).trim();
    const crossWorkStep = input.dependencyWorkId && input.dependencyWorkId !== targetWorkId && instruction;
    // A concrete handoff to another work is an action even when its purpose is
    // to explain partial output. A mode hint cannot discard that accepted step.
    // Merely observing the same execution never creates another send.
    const mode = crossWorkStep || task.workId && input.mode !== 'observe' || instruction && input.mode === 'follow_up' ? 'follow_up' : 'observe';
    const waiting = this.clean({ ...input, mode, id: waitId, workId: id, targetWorkId, sourceTaskId: task.id,
      authorization: this.authorization(task, waitId),
      since: task.createdAt || now(), status: 'pending', createdAt: now() });
    this.store.putRecord('work-waits', waiting);
    if (task.id && !task.workId) {
      const work = this.get(id);
      if (!work.sources.some(source => source.taskId === task.id)) this.update(id, { sources: [...work.sources, this.source(task)] });
    }
    // Observing a running action must not replace its external operation state.
    if (mode === 'follow_up') this.update(id, { status: 'waiting', waiting });
    return { accepted: true, workId: id, waitId, status: 'waiting', mode,
      taskId: waiting.taskId, dependencyEventId: waiting.dependencyEventId,
      ...(waiting.unresolvedTaskId ? { unresolved: true, warning: '等待已保留，但尚未确定对应执行回合；请补充确切 taskId。不会消费其他回合的结果。' } : {}) };
  }
  stop(id, status = 'paused') {
    if (!['paused', 'cancelled'].includes(status)) fail('Stop status must be paused or cancelled');
    const work = this.update(id, { status });
    for (const wait of this.store.listRecords('work-waits')) if (wait.status === 'pending' && (wait.workId === id || wait.targetWorkId === id))
      this.store.putRecord('work-waits', { ...wait, status, stoppedAt: now() });
    for (const task of this.store.listTasks({ limit: 10000 })) if (task.workId === id && task.status === 'running') this.cancel(task.id);
    return work;
  }
}
