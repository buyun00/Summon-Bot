import { jsonToolResult } from './registry.mjs';
import { taskMode, compactWork, compactTask } from './task-policy.mjs';
import { randomUUID } from 'node:crypto';
import { taskSource } from '../context/sources.mjs';
import { modelArgs, modelText, looseSchema, boundedNumber } from '../context/model-input.mjs';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const flexible = name => name.startsWith('work') || ['evidence_read', 'tasks_get', 'tasks_list', 'messages_send'].includes(name);
const tool = (name, description, inputSchema, effect, execute) => ({ name, description, inputSchema: flexible(name) ? looseSchema(inputSchema) : inputSchema, effect,
  execute: async (args, context) => jsonToolResult(await execute(modelArgs(args), context)) });
const pageFields = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } };
const reference = object({ type: { type: 'string', enum: ['room', 'session', 'artifact'] }, roomId: string,
  messageId: string, sessionId: string, entryId: string, id: string, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 16000 } }, ['type']);
const evidence = { type: 'array', maxItems: 20, items: reference };
const handoffFields = { evidence, instruction: string, acceptance: string };
const preview = value => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? null); return { text: text.slice(0, 1600), truncated: text.length > 1600 }; };
function page(items, args, project) {
  const offset = boundedNumber(args.offset, 0), limit = boundedNumber(args.limit, 10, 1, 20);
  const values = [...items].reverse();
  return { total: values.length, offset, items: values.slice(offset, offset + limit).map(project), nextOffset: offset + limit < values.length ? offset + limit : null };
}

export function coreTools(services, task) {
  const store = services.store;
  const frontend = taskMode(task) !== 'work';
  const workView = work => frontend ? compactWork(work) : work;
  const source = taskSource(task, store);
  const userRequest = source.actor === 'user' && store.getMessage(task.messageId)?.kind === 'request';
  const workId = args => {
    if (task.workId) return task.workId;
    const hint = task.workId || source.metadata?.referencedWorkId || source.input?.trigger?.replyWorkId;
    const id = args.id || args.workId;
    if (typeof id === 'string' && services.works.get(id)) return id;
    if (hint && services.works.get(hint)) return hint;
    throw new Error('没有找到这一步要使用的工作。请从 works_list 的已有工作中选择，或说明要新建的工作；已保存的其他动作不受影响。');
  };
  const actionId = (args, ctx, field) => typeof args[field] === 'string' && args[field] ? args[field] : ctx.recordId || `${task.id}:${ctx.toolCallId}`;
  return [
    tool('evidence_read', 'Read a bounded original fragment by exact reference. Workers may follow only handed-off references, never browse another room/session feed. Current source access is rechecked.',
      object({ reference }, ['reference']), 'read', args => services.sources.resolve(services.sources.reference(args.reference ?? args, task), task)),
    tool('executors_status', 'Read current host executor consent and detection without contacting Codex or reading quota. Detection is not consent. Only the user can connect in model settings; chat may query status, execution must use independent work.', object({}), 'read', () => services.executors()),
    tool('works_list', 'Find accessible work before handing off. Use its sessionId to read selected original evidence.', object({ status: string, query: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }), 'read', async args => {
      const rooms = await services.sources.rooms(task), values = [];
      for (const work of services.works.list(args)) if (await services.sources.canReadWork(work, task, rooms)) values.push(workView(work));
      return values;
    }),
    tool('work_get', 'Read accessible work status and its existing executor/session binding. The current/replied-to work is the default. Read selected evidence through read_session_history.', object({ id: string }, ['id']), 'read', async args => workView(await services.sources.requireWork(workId(args), task))),
    tool('work_create', 'Create and start independent work. Give the goal and optional executor/selected target, evidence and handoff prose. The program supplies source and operation IDs. Temporary assignments use work, not a cloned Bot.',
      object({ id: string, operationId: string, goal: string, requirements: string, responsibility: string, ...handoffFields,
        executor: object({ kind: { type: 'string', enum: ['pi', 'codex'] }, connectionId: string, target: { type: 'object' } }, ['kind']) }), 'write', async (args, ctx) => {
        const content = await services.sources.handoff(task, args);
        const id = typeof args.id === 'string' && /^[\w.-]{1,160}$/.test(args.id) ? args.id : randomUUID();
        const existing = services.works.get(id);
        if (existing) {
          await services.sources.requireWork(id, task);
          if (['paused', 'cancelled'].includes(existing.status) && !userRequest) throw new Error('这项工作已停止；当前事件不包含用户新的继续要求。其他动作可以继续。');
        }
        const suppliedExecutor = typeof args.executor === 'string' ? { kind: args.executor } : modelArgs(args.executor);
        const selectedTarget = suppliedExecutor.target || args.target || (args.projectId ? { type: 'project', projectId: args.projectId } : null);
        const kind = modelText(suppliedExecutor.kind || suppliedExecutor.type || (selectedTarget ? 'codex' : 'pi')).toLowerCase();
        const executor = { kind, ...(suppliedExecutor.connectionId ? { connectionId: suppliedExecutor.connectionId } : {}),
          ...(selectedTarget ? { target: typeof selectedTarget === 'string' ? { type: 'project', projectId: selectedTarget } :
            { ...selectedTarget, type: selectedTarget.type || (selectedTarget.projectId ? 'project' : undefined) } } : {}) };
        const operationId = actionId(args, ctx, 'operationId');
        const work = services.works.create({ id, operationId, goal: modelText(args.goal || args.instruction || args.content || content.originalRequest.content),
          requirements: modelText(args.requirements), responsibility: modelText(args.responsibility), executor, initialHandoff: content }, task);
        const receipt = await services.works.dispatch(work.id, { id: operationId, kind: 'request', content, metadata: { priority: 'background', resume: userRequest } }, task);
        return { ...compactWork(work), ...receipt, handedOff: true, acceptance: modelText(args.acceptance), evidenceWarnings: content.evidenceWarnings };
      }),
    tool('work_update', frontend ? 'Pause or cancel existing work. Send requirements with work_dispatch; only the worker records progress and completion.' : 'Record actual progress and status of the current work. Its identity and revision are supplied by the program.',
      object({ id: string, ...(!frontend ? { goal: string, requirements: string, progress: string } : {}), status: { type: 'string', enum: frontend ? ['paused', 'cancelled'] : ['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled'] } }), 'write', async args => {
        const work = await services.sources.requireWork(workId(args), task);
        if (['paused', 'cancelled'].includes(args.status) && work.id !== task.workId) return services.stopWork(work.id, args.status, task);
        const patch = Object.fromEntries((frontend ? ['status'] : ['goal', 'requirements', 'progress', 'status']).filter(key => args[key] !== undefined).map(key => [key, modelText(args[key])]));
        return services.works.update(work.id, { ...patch, expectedRevision: work.revision });
      }),
    tool('work_dispatch', 'Continue an existing work with new instructions and available evidence. The program supplies the event ID and original binding. Stopped work resumes only for a fresh user request; peer observations add no authority.',
      object({ id: string, content: {}, ...handoffFields, correction: { type: 'boolean' } }), 'write', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        if (['paused', 'cancelled'].includes(work.status) && !userRequest) throw new Error('这项工作已停止；当前事件不包含用户新的继续要求。其他动作可以继续。');
        const content = await services.sources.handoff(task, { ...args, instruction: args.instruction || args.content || '' });
        const receipt = await services.works.dispatch(work.id, { id: actionId(args, ctx, 'eventId'), kind: frontend ? 'request' : 'event', content, metadata: { correction: args.correction === true, resume: frontend && userRequest, priority: 'foreground' } }, task);
        return { ...receipt, acceptance: modelText(args.acceptance), evidenceWarnings: content.evidenceWarnings };
      }),
    tool('work_wait', 'Save waiting for a work/peer result, deadline or bound external event. Plain follow-up instructions are retained. Known bindings supply omitted IDs. Finish other independent actions in this turn before releasing the slot.',
      object({ id: string, waitId: string, taskId: string, botId: string, until: string, event: string,
        dependencyWorkId: string, targetWorkId: string, ...handoffFields }), 'write', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        if (args.dependencyWorkId) await services.sources.requireWork(args.dependencyWorkId, task);
        if (args.targetWorkId) await services.sources.requireWork(args.targetWorkId, task);
        if (args.taskId) {
          if (args.botId && args.botId !== services.works.botId) {
            if (!store.listOutbox().some(item => item.to === args.botId && item.receipt?.taskId === args.taskId && store.getTask(item.taskId)?.conversationId === task.conversationId))
              throw new Error('This peer task was not submitted by the current conversation');
          } else {
            const dependency = store.getTask(args.taskId);
            if (!dependency) throw new Error('The waiting task was not found; select a saved task or use the known work binding');
            if (dependency.conversationId !== task.conversationId) await services.sources.requireWork(dependency.workId, task);
          }
        }
        const handoff = await services.sources.handoff(task, args);
        const waiting = Object.fromEntries(['taskId', 'botId', 'until', 'event', 'dependencyWorkId', 'targetWorkId'].filter(key => typeof args[key] === 'string').map(key => [key, args[key]]));
        return { ...services.works.wait(work.id, { ...waiting, waitId: actionId(args, ctx, 'waitId'), handoff }, task), acceptance: modelText(args.acceptance), evidenceWarnings: handoff.evidenceWarnings };
      }),
    tool('work_notify', 'Save and publish this work’s useful result text directly. The program supplies the original recipient, reply association and notification ID; peer FYI does not demand another reply.',
      object({ id: string, content: string }), 'external', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        return services.notify({ id: work.id, notificationId: actionId(args, ctx, 'notificationId'), content: modelText(args.content ?? args.message ?? args.text, work.progress) }, task, ctx);
      }),
    tool('contacts_list', 'List configured direct Bot contacts. Direct messages and task queries do not use the gateway or chatroom.', object({}), 'read', () => services.contacts()),
    tool('messages_send', 'Send a durable message to a configured contact. The receipt only confirms acceptance; query the returned task separately. Reuse id to retry an uncertain delivery.',
      object({ to: string, id: string, content: {}, sessionId: string, replyTo: string, correlationId: string, kind: { type: 'string', enum: ['request', 'event'] }, workId: string, metadata: { type: 'object' } }, ['to', 'content']), 'external',
      (args, ctx) => services.send(args.to || args.botId, { ...args, id: actionId(args, ctx, 'id'), content: args.content ?? args.message ?? args.text }, { signal: ctx.signal, taskId: task.id })),
    tool('messages_list', 'Read received message previews and correlated task IDs, newest first. Content previews may be truncated; use the source chatroom_read or session history for full content.', object({ ...pageFields }), 'read', args => page(store.listMessages(), args, m => ({ id: m.id, from: m.from, sessionId: m.sessionId, taskId: m.taskId, replyTo: m.replyTo, correlationId: m.correlationId, createdAt: m.createdAt, content: preview(m.content) }))),
    tool('tasks_get', 'Read a local task or a previously contacted Bot task; completed, failed, cancelled and interrupted are terminal.',
      object({ id: string, botId: string, waitMs:{type:'integer',minimum:0,maximum:60000} }, ['id']), 'read', async (args, ctx) => {
        args = { ...args, id: args.id || args.taskId };
        if (args.botId && args.botId !== services.works.botId && !store.listOutbox().some(item => item.to === args.botId && item.receipt?.taskId === args.id && item.taskId &&
          store.getTask(item.taskId)?.conversationId === task.conversationId)) throw new Error('Peer task is outside this conversation');
        const value = await services.getTask(args.id || args.taskId, args.botId, ctx.signal, frontend ? 0 : boundedNumber(args.waitMs, 0, 0, 60000));
        if (frontend && value && (!args.botId || args.botId === services.works.botId) && value.conversationId !== task.conversationId)
          await services.sources.requireWork(value.workId, task);
        if (!frontend && (!args.botId || args.botId === services.works.botId) && value && value.workId !== task.workId) throw new Error('Task belongs to another execution context');
        return frontend ? compactTask(value) : value;
      }),
    tool('tasks_cancel', 'Cancel an accessible local task or peer task submitted by this conversation. Unknown external effects are not replayed.', object({id:string,botId:string},['id']), 'external', async (args,ctx) => {
      if (args.botId && args.botId !== services.works.botId) {
        if (!store.listOutbox().some(item => item.to === args.botId && item.receipt?.taskId === args.id && store.getTask(item.taskId)?.conversationId === task.conversationId)) throw new Error('Peer task is outside this conversation');
      } else { const value = store.getTask(args.id); if (value?.conversationId !== task.conversationId) await services.sources.requireWork(value?.workId, task); }
      return services.cancelTask(args.id,args.botId,ctx.signal);
    }),
    tool('tasks_list', 'List concise task status within accessible work and this conversation.', object({ status: string, ...pageFields }), 'read', async args => {
      const rooms = await services.sources.rooms(task), values = [];
      for (const value of store.listTasks({ status: args.status })) if (value.conversationId === task.conversationId || value.workId && await services.sources.canReadWork(services.works.get(value.workId), task, rooms)) values.push(value);
      return page(values, args, compactTask);
    }),
    tool('state_get', 'Read local durable state.', object({ scope: string, key: string }, ['scope', 'key']), 'read', args => store.getState(args.scope, args.key)),
    tool('state_set', 'Write local durable state; optional expectedRevision prevents lost updates.',
      object({ scope: string, key: string, value: {}, expectedRevision: { type: 'integer', minimum: 0 } }, ['scope', 'key', 'value']), 'write',
      args => store.setState(args.scope, args.key, args.value, args)),
    tool('artifact_save', 'Save task output as a durable artifact and return its receipt.',
      object({ name: string, mimeType: string, content: string }, ['name', 'content']), 'write', (args, ctx) => ctx.saveArtifact(args)),
  ];
}
