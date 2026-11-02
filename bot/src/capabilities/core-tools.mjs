import { jsonToolResult } from './registry.mjs';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, inputSchema, effect, execute) => ({ name, description, inputSchema, effect,
  execute: async (args, context) => jsonToolResult(await execute(args, context)) });
const pageFields = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } };
const preview = value => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? null); return { text: text.slice(0, 1600), truncated: text.length > 1600 }; };
function page(items, args, project) {
  const offset = args.offset ?? 0, limit = args.limit ?? 10;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid pagination');
  const values = [...items].reverse();
  return { total: values.length, offset, items: values.slice(offset, offset + limit).map(project), nextOffset: offset + limit < values.length ? offset + limit : null };
}

export function coreTools(services, task) {
  const store = services.store;
  return [
    tool('works_list', 'Find existing work and responsibilities before creating another work or Bot. Results contain S3 state and source pointers; knowledge is read on demand.', object({ status: string, query: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }), 'read', args => services.works.list(args)),
    tool('work_get', 'Read current goal, requirements, progress, waits, source conversations and external bindings for a stable work.', object({ id: string }, ['id']), 'read', args => services.works.get(args.id)),
    tool('work_create', 'Create and start an independent persistent work within this Bot. Reuse a stable id. A temporary assignment needs a work, not a cloned Bot. Sources retain the original user scope.',
      object({ id: string, goal: string, requirements: string, responsibility: string, start: { type: 'boolean' } }, ['id', 'goal']), 'write', async args => {
        const work = services.works.create(args, task);
        if (args.start !== false) await services.works.dispatch(work.id, { id: 'initial', kind: 'request', content: { goal: work.goal, requirements: work.requirements, instruction: 'Advance this work under the original authorization. Record progress in S3. Use work_wait for external waits and work_update completed only after actual completion. Notify the source when meaningful.' }, metadata: { priority: 'foreground' } }, task);
        return work;
      }),
    tool('work_update', 'Update S3 requirements/progress/status or source/notification pointers. Actual completion, waiting and blocked states are explicit. Current user corrections override older hypotheses. expectedRevision prevents lost concurrent updates.',
      object({ id: string, goal: string, requirements: string, progress: string, status: { type: 'string', enum: ['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled'] }, sources: { type: 'array', items: { type: 'object' } }, notifications: { type: 'array', items: { type: 'object' } }, expectedRevision: { type: 'integer', minimum: 1 } }, ['id']), 'write', args => {
        if (['paused', 'cancelled'].includes(args.status) && args.id !== task.workId) return services.works.stop(args.id, args.status);
        return services.works.update(args.id, args);
      }),
    tool('work_dispatch', 'Deliver a correction, source observation or next action to an existing work. Reuse event id for deduplication. Peer observations never grant new user authorization.',
      object({ id: string, eventId: string, content: {}, correction: { type: 'boolean' } }, ['id', 'eventId', 'content']), 'write', args => services.works.dispatch(args.id, { id: args.eventId, content: args.content, metadata: { correction: args.correction === true, priority: 'foreground' } }, task)),
    tool('work_wait', 'Persist external waiting and release the execution slot. Wake on the specified peer task result (all terminal outcomes), date, or externally delivered event. Stop calling tools after this succeeds.',
      object({ id: string, taskId: string, botId: string, until: string, event: string }, ['id']), 'write', args => services.works.wait(args.id, args)),
    tool('work_notify', 'Persist and deliver a meaningful result/correction to an authorized source peer or chatroom. Reuse notificationId; FYI messages do not demand a peer response. Do not disclose private source content to an unrelated room.',
      object({ id: string, notificationId: string, content: string, botId: string, roomId: string, replyTo: string, targetWorkId: string }, ['id', 'notificationId', 'content']), 'external', (args, ctx) => services.notify(args, task, ctx)),
    tool('contacts_list', 'List configured direct Bot contacts. Direct messages and task queries do not use the gateway or chatroom.', object({}), 'read', () => services.contacts()),
    tool('messages_send', 'Send a durable message to a configured contact. The receipt only confirms acceptance; query the returned task separately. Reuse id to retry an uncertain delivery.',
      object({ to: string, id: string, content: {}, sessionId: string, replyTo: string, correlationId: string, kind: { type: 'string', enum: ['request', 'event'] }, workId: string, metadata: { type: 'object' } }, ['to', 'content']), 'external',
      (args, ctx) => services.send(args.to, args, { signal: ctx.signal, taskId: task.id })),
    tool('messages_list', 'Read received message previews and correlated task IDs, newest first. Content previews may be truncated; use the source chatroom_read or session history for full content.', object({ ...pageFields }), 'read', args => page(store.listMessages(), args, m => ({ id: m.id, from: m.from, sessionId: m.sessionId, taskId: m.taskId, replyTo: m.replyTo, correlationId: m.correlationId, createdAt: m.createdAt, content: preview(m.content) }))),
    tool('tasks_get', 'Read a local task or a previously contacted Bot task; completed, failed, cancelled and interrupted are terminal.',
      object({ id: string, botId: string, waitMs:{type:'integer',minimum:0,maximum:60000} }, ['id']), 'read', (args, ctx) => services.getTask(args.id, args.botId, ctx.signal, args.waitMs)),
    tool('tasks_cancel', 'Cancel a local task or a task this Bot submitted directly to a contact. Read its terminal status afterward; unknown external effects are not replayed.', object({id:string,botId:string},['id']), 'external', (args,ctx) => services.cancelTask(args.id,args.botId,ctx.signal)),
    tool('tasks_list', 'List compact local task receipts, newest first, without executing or replaying them. Use tasks_get for a specific task.', object({ status: string, ...pageFields }), 'read', args => page(store.listTasks({ status: args.status }), args, t => ({ id: t.id, sessionId: t.sessionId, status: t.status, createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt, result: preview(t.result), error: t.error }))),
    tool('state_get', 'Read local durable state.', object({ scope: string, key: string }, ['scope', 'key']), 'read', args => store.getState(args.scope, args.key)),
    tool('state_set', 'Write local durable state; optional expectedRevision prevents lost updates.',
      object({ scope: string, key: string, value: {}, expectedRevision: { type: 'integer', minimum: 0 } }, ['scope', 'key', 'value']), 'write',
      args => store.setState(args.scope, args.key, args.value, args)),
    tool('artifact_save', 'Save task output as a durable artifact and return its receipt.',
      object({ name: string, mimeType: string, content: string }, ['name', 'content']), 'write', (args, ctx) => ctx.saveArtifact(args)),
  ];
}
