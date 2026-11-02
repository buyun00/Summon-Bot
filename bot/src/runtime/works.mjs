import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const statuses = new Set(['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

/** S3 is state and pointers only. Knowledge正文 lives in Markdown, never here. */
export class WorkService {
  constructor({ store, botId, accept, cancel, clean = value => value }) { Object.assign(this, { store, botId, accept, cancel, clean }); }
  get(id) { return this.store.getRecord('works', id); }
  list({ status, query, limit = 100 } = {}) {
    return this.store.listRecords('works').filter(work => (!status || work.status === status) &&
      (!query || JSON.stringify([work.id, work.goal, work.requirements, work.sources]).toLowerCase().includes(query.toLowerCase())))
      .slice(-Math.max(1, Math.min(500, limit)));
  }
  create(input, task = {}) {
    if (typeof input.goal !== 'string' || !input.goal.trim()) fail('Work requires a goal');
    const id = input.id || randomUUID();
    if (!/^[\w.-]{1,160}$/.test(id)) fail('Invalid work id');
    const previous = this.get(id); if (previous) return previous;
    const record = this.clean({ id, botId: this.botId, conversationId: `work:${id}`, goal: input.goal,
      requirements: input.requirements || '', progress: '', status: 'active', waiting: null, bindings: [], notifications: [],
      sources: input.sources || (task.id ? [{ taskId: task.id, messageId: task.messageId, conversationId: task.conversationId, source: task.source,
        roomId: task.input?.room?.id, replyTo: task.input?.trigger?.id, metadata: task.metadata }] : []),
      responsibility: input.responsibility || null, revision: 1, createdAt: now(), updatedAt: now() });
    this.store.putRecord('works', record);
    this.store.appendEvent('work.created', { work: record }, { workId: id, conversationId: record.conversationId });
    return record;
  }
  update(id, input) {
    return this.store.transaction(() => {
      const previous = this.get(id); if (!previous) fail('Unknown work', 404);
      if (input.expectedRevision !== undefined && input.expectedRevision !== previous.revision) fail('Work changed; read current state', 409);
      if (input.status !== undefined && !statuses.has(input.status)) fail('Invalid work status');
      const patch = Object.fromEntries(Object.entries(input).filter(([key]) => ['goal', 'requirements', 'progress', 'status', 'waiting', 'bindings', 'notifications', 'sources', 'responsibility', 'lastTaskId', 'lastError', 'owner', 'notificationCursor'].includes(key)));
      for (const key of ['bindings', 'notifications', 'sources']) if (patch[key] !== undefined && !Array.isArray(patch[key])) fail(`${key} must be an array`);
      const record = this.clean({ ...previous, ...patch, id, revision: previous.revision + 1, updatedAt: now() });
      if (['completed', 'cancelled'].includes(record.status)) record.waiting = null;
      this.store.putRecord('works', record);
      this.store.appendEvent('work.updated', { work: record }, { workId: id, conversationId: record.conversationId });
      return record;
    });
  }
  async dispatch(id, input, task = {}) {
    const work = this.get(id); if (!work) fail('Unknown work', 404);
    const eventId = input.id || randomUUID(), prior = this.store.getRecord('work-events', `${id}:${eventId}`);
    if (prior?.receipt) return prior.receipt;
    const envelope = { id: `work:${id}:${eventId}`, to: this.botId, kind: input.kind || 'event', workId: id,
      conversationId: work.conversationId, content: input.content, metadata: { authority: 'internal-event', sourceType: 'internal', actor: this.botId, ...input.metadata,
        origin: input.metadata?.origin || { taskId: task.id, messageId: task.messageId, source: task.source }, priority: input.metadata?.priority || 'background' } };
    if (envelope.content === undefined) fail('Work event requires content');
    const result = await this.accept(envelope, task.source || 'controller');
    const receipt = { accepted: true, duplicate: result.duplicate, workId: id, taskId: result.task.id, status: result.task.status };
    this.store.putRecord('work-events', { id: `${id}:${eventId}`, workId: id, receipt, createdAt: now() });
    return receipt;
  }
  wait(id, input) {
    if (!input || (!input.taskId && !input.until && !input.event)) fail('Waiting requires taskId, until, or an event description');
    if (input.until && !Number.isFinite(Date.parse(input.until))) fail('Invalid wait deadline');
    return this.update(id, { status: 'waiting', waiting: { ...input, since: now(), id: randomUUID() } });
  }
  stop(id, status = 'paused') {
    if (!['paused', 'cancelled'].includes(status)) fail('Stop status must be paused or cancelled');
    const work = this.update(id, { status });
    for (const task of this.store.listTasks({ limit: 10000 })) if (task.workId === id && task.status === 'running') this.cancel(task.id);
    return work;
  }
}
