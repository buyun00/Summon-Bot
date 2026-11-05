import { randomUUID } from 'node:crypto';
import { taskSource } from '../context/sources.mjs';
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
        kind: 'request', content: input.initialHandoff, requestTaskId: task.id, sourceTaskId: task.id, status: 'pending', createdAt: now() });
      this.store.appendEvent('work.created', { work: record }, { workId: id, conversationId: record.conversationId });
    });
    return record;
  }
  source(task) { const { input, ...source } = taskSource(task, this.store); return source; }
  executor(work) { return work.bindings?.some(binding => binding.type === 'codex-desktop') ? { ...work.executor, kind: 'codex' } : work.executor || { kind: 'pi' }; }
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
    if (prior?.receipt) return prior.receipt;
    if (task.id && !task.workId && input.kind === 'request') {
      const source = this.source(task);
      if (!work.sources.some(item => item.taskId === source.taskId)) this.update(id, { sources: [...work.sources, source] });
    }
    const intent = prior || this.store.putRecord('work-events', this.clean({ id: `${id}:${eventId}`, workId: id,
      kind: input.kind || 'event', content: input.content, requestTaskId: task.id, sourceTaskId: task.id, metadata: input.metadata, status: 'pending', createdAt: now() }));
    const envelope = { id: `work:${id}:${eventId}`, to: this.botId, kind: intent.kind, workId: id,
      conversationId: work.conversationId, content: intent.content, metadata: { authority: 'internal-event', sourceType: 'internal', actor: this.botId, ...intent.metadata,
        workEventId: intent.id, origin: intent.metadata?.origin || { taskId: task.id, messageId: task.messageId, source: task.source }, priority: intent.metadata?.priority || 'background' } };
    if (envelope.content === undefined) fail('Work event requires content');
    const result = await this.accept(envelope, task.source || 'controller');
    const receipt = { accepted: true, duplicate: result.duplicate, workId: id, taskId: result.task.id, status: result.task.status, executor: this.executor(work).kind };
    this.store.putRecord('work-events', { ...this.store.getRecord('work-events', intent.id), receipt, status: 'accepted' });
    return receipt;
  }
  wait(id, input = {}, task = {}) {
    const work = this.get(id); if (!work) fail('Unknown work', 404);
    const bound = work.bindings?.some(binding => binding.type === 'codex-desktop') || work.waiting?.kind === 'external';
    if (!input.taskId && !input.until && !input.dependencyWorkId) {
      const dependencies = [...new Set(this.store.listRecords('work-events').filter(event => event.requestTaskId === task.id && event.workId !== id && event.receipt?.accepted).map(event => event.workId))];
      const peers = this.store.listOutbox().filter(item => item.taskId === task.id && item.receipt?.taskId);
      if (dependencies.length === 1) input = { ...input, dependencyWorkId: dependencies[0], event: 'result' };
      else if (peers.length === 1) input = { ...input, taskId: peers[0].receipt.taskId, botId: peers[0].to };
      else if (bound) input = { ...input, event: 'result' };
      else if (work.waiting?.taskId || work.waiting?.dependencyWorkId || work.waiting?.until) input = { ...work.waiting, ...input };
    }
    if (!input || (!input.taskId && !input.until && !input.event && !input.dependencyWorkId)) fail('Waiting requires a task, work result, deadline, or event');
    if (input.until && !Number.isFinite(Date.parse(input.until))) {
      const duration = durationSeconds(input.until);
      if (Number.isFinite(duration) && duration >= 0) input = { ...input, until: new Date(Date.parse(task.createdAt || now()) + duration * 1000).toISOString() };
      else if (input.taskId || input.dependencyWorkId || bound) input = { ...input, until: undefined, ...(!input.taskId && !input.dependencyWorkId ? { event: 'result' } : {}) };
      else fail('这一步还没有有效的等待时间或已知外部绑定。请补充该条件；其他工作和材料保留。');
    }
    const waitId = `${id}:${input.waitId || task.id || randomUUID()}`;
    const previous = this.store.getRecord('work-waits', waitId);
    if (previous) return { accepted: true, workId: id, waitId, status: previous.status };
    const targetWorkId = input.targetWorkId || id;
    if (!this.get(targetWorkId)) fail('Unknown follow-up work', 404);
    const waiting = this.clean({ ...input, id: waitId, workId: id, targetWorkId, sourceTaskId: task.id,
      since: task.createdAt || now(), status: 'pending', createdAt: now() });
    this.store.putRecord('work-waits', waiting);
    if (task.id && !task.workId) {
      const work = this.get(id);
      if (!work.sources.some(source => source.taskId === task.id)) this.update(id, { sources: [...work.sources, this.source(task)] });
    }
    this.update(id, { status: 'waiting', waiting });
    return { accepted: true, workId: id, waitId, status: 'waiting' };
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
