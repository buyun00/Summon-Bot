import { jsonToolResult } from './registry.mjs';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name, description, inputSchema, effect, execute) => ({ name, description, inputSchema, effect,
  execute: async (args, context) => jsonToolResult(await execute(args, context)) });

export function coreTools(services, task) {
  const store = services.store;
  return [
    tool('messages_send', 'Send a durable message to a configured contact. The receipt only confirms acceptance; query the returned task separately. Reuse id to retry an uncertain delivery.',
      object({ to: string, id: string, content: {}, sessionId: string, replyTo: string, correlationId: string }, ['to', 'content']), 'external',
      (args, ctx) => services.send(args.to, args, { signal: ctx.signal, taskId: task.id })),
    tool('messages_list', 'Read received messages and their correlated local task IDs.', object({}), 'read', () => store.listMessages()),
    tool('tasks_get', 'Read a local task or a previously contacted Bot task; completed, failed, cancelled and interrupted are terminal.',
      object({ id: string, botId: string }, ['id']), 'read', (args, ctx) => services.getTask(args.id, args.botId, ctx.signal)),
    tool('tasks_list', 'List local task receipts without executing or replaying them.', object({ status: string }), 'read', args => store.listTasks(args)),
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
