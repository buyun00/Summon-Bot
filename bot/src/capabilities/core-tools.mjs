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
    tool('contacts_list', 'List configured direct Bot contacts. Direct messages and task queries do not use the gateway or chatroom.', object({}), 'read', () => services.contacts()),
    tool('messages_send', 'Send a durable message to a configured contact. The receipt only confirms acceptance; query the returned task separately. Reuse id to retry an uncertain delivery.',
      object({ to: string, id: string, content: {}, sessionId: string, replyTo: string, correlationId: string }, ['to', 'content']), 'external',
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
    tool('memory_list', 'Read durable Bot memories.', object({}), 'read', () => store.listMemories()),
    tool('memory_write', 'Create or update durable memory. Use expectedRevision when changing an existing memory.',
      object({ id: string, text: string, title: string, tags: { type: 'array', items: string }, source: {}, expectedRevision: { type: 'integer', minimum: 0 } }, ['text']), 'write',
      args => store.putMemory(args)),
    tool('artifact_save', 'Save task output as a durable artifact and return its receipt.',
      object({ name: string, mimeType: string, content: string }, ['name', 'content']), 'write', (args, ctx) => ctx.saveArtifact(args)),
  ];
}
