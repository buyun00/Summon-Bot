import { jsonToolResult } from './registry.mjs';
import { taskMode, compactWork, compactTask, assertExternalReviewCurrent } from './task-policy.mjs';
import { randomUUID } from 'node:crypto';
import { taskSource } from '../context/sources.mjs';
import { modelArgs, modelText, looseSchema, boundedNumber } from '../context/model-input.mjs';
import { resolveCodexTarget } from './codex-target.mjs';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const flexible = name => name.startsWith('work') || ['evidence_read', 'tasks_get', 'tasks_list', 'messages_send'].includes(name);
const tool = (name, description, inputSchema, effect, execute) => ({ name, description, inputSchema: flexible(name) ? looseSchema(inputSchema) : inputSchema, effect,
  execute: async (args, context) => jsonToolResult(await execute(modelArgs(args), context)) });
const pageFields = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } };
const reference = object({ type: { type: 'string', enum: ['room', 'session', 'artifact', 'knowledge', 'work', 'tool'] }, roomId: string, scopeId: string, workId: string, operationId: string,
  messageId: string, sessionId: string, entryId: string, id: string, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 16000 } }, ['type']);
const evidence = { type: 'array', maxItems: 20, items: reference,
  description: 'Selected exact references from source reads, e.g. [{type:"room",roomId:"...",messageId:"..."}]. Pass the array itself; a JSON array string is also readable. Prose is guidance, not a source grant.' };
const handoffFields = { evidence, knowledgeScopes: { type: 'array', items: string }, instruction: string, acceptance: string };
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
  const taskView = value => compactTask(value, value?.workId && services.works.get(value.workId),
    value && services.works.execution(value).executionEventId);
  const source = taskSource(task, store);
  const userRequest = source.actor === 'user' && store.getMessage(task.messageId)?.kind === 'request';
  const workId = args => {
    const id = args.id ?? args.workId;
    if (id !== undefined && id !== null && id !== '') {
      if (typeof id === 'string' && services.works.get(id)) return id;
      throw Object.assign(new Error('明确指定的工作标识未解析。请先用 work_get / works_list 取得可读取的完整 canonical ID；缩写查询失败不证明实际工作不存在，也不能反证已有绑定。不会改投回复关联的其他工作。'), { code: 'WORK_ID_UNRESOLVED' });
    }
    const hint = task.workId || source.metadata?.referencedWorkId || source.input?.trigger?.replyWorkId;
    if (hint && services.works.get(hint)) return hint;
    throw new Error('没有找到这一步要使用的工作。请从 works_list 的已有工作中选择，或说明要新建的工作；已保存的其他动作不受影响。');
  };
  // A model hint is never the identity of a durable action. A recovered call
  // keeps its saved tool record; another accepted source gets another record.
  const actionId = (args, ctx, field) => ctx.recordId || `${task.id}:${ctx.toolCallId}`;
  return [
    tool('evidence_read', 'Read a bounded original fragment by exact reference. Workers may follow only handed-off references, never browse another room/session feed. Current source access is rechecked.',
      object({ reference }, ['reference']), 'read', args => services.sources.resolve(services.sources.reference(args.reference ?? args, task), task)),
    tool('executors_status', 'Read the current default work engine and saved host executor consent. Authorized onboarding Pi work can connect with workspace_setup. Execution runs as independent work.', object({}), 'read', () => services.executors()),
    tool('request_actions', 'Read saved action receipts for an original message in this conversation (messageId defaults to the current trigger). Use this when older published user instructions lack a visible reply: history is not permission to repeat them. Returns saved action identity/status without replaying anything.',
      object({ messageId: string }), 'read', args => {
        const messageId = args.messageId || source.replyTo || source.messageId;
        return store.listTasks({ limit: 10000 }).filter(item => item.conversationId === task.conversationId &&
          [taskSource(item, store).replyTo, item.messageId].includes(messageId)).map(item => ({ taskId: item.id, messageId,
          status: item.status, actions: store.listTools(item.id).filter(record => record.effect !== 'read').map(record => {
            const receipt = record.output?.details || {};
            return { actionId: record.id, tool: record.name, status: record.status, id: receipt.id, workId: receipt.workId,
              taskId: receipt.taskId, operationId: receipt.operationId, execution: receipt.execution, receiptLayer: receipt.receiptLayer,
              waitId: receipt.waitId, accepted: receipt.accepted, savedStatus: receipt.status, recordedAt: record.finishedAt, dueAt: receipt.dueAt,
              ...(receipt.workId && services.works.get(receipt.workId) ? { workStatus: services.works.get(receipt.workId).status } : {}) };
          }) }));
      }),
    tool('works_list', 'Find accessible work before handing off. Use its sessionId to read selected original evidence.', object({ status: string, query: string, limit: { type: 'integer', minimum: 1, maximum: 100 } }), 'read', async args => {
      const rooms = await services.sources.rooms(task), values = [];
      for (const work of services.works.list(args)) if (await services.sources.canReadWork(work, task, rooms)) values.push(workView(work));
      return values;
    }),
    tool('work_get', 'Read owning work, operation and actual binding by full ID. A UUID prefix resolves only when exactly one actually accessible work matches; use the returned canonicalId in later actions. An unresolved/ambiguous/not-accessible lookup is not evidence that an established work or binding disappeared. Use works_list or a known full reference. Local active/submitting is not external start; only a matching non-stale execution.startedConfirmed proves the turn ran.', object({ id: string }, ['id']), 'read', async args => {
      const id = args.id ?? args.workId ?? task.workId ?? source.metadata?.referencedWorkId ?? source.input?.trigger?.replyWorkId;
      const result = await services.sources.lookupWork(id, task);
      return result.work ? { ...workView(result.work), lookup: result.lookup } : { unresolved: true, lookup: result.lookup };
    }),
    tool('work_create', 'Accept and asynchronously dispatch independent work. The receipt confirms local scheduling only, not Pi/Codex execution, native registration or completion. Omit executor for the default engine. Give goal, evidence, handoff prose and an authorized target; the program supplies operation IDs and refreshes current project rules. Do not repeat or wait on this frontend call to strengthen the acknowledgment.',
      object({ id: string, operationId: string, goal: string, requirements: string, responsibility: string, ...handoffFields,
        executor: object({ kind: { type: 'string', enum: ['pi', 'codex', 'codex-cli', 'grok', 'claude-code'] }, connectionId: string,
          target: { type: 'object', description: 'Use {type:"directory",cwd:"absolute authorized path"} for an existing directory, including one not registered in Desktop. Use project only for the actual selected project; never borrow another project ID.' } }, ['kind']) }), 'write', async (args, ctx) => {
        const content = await services.sources.handoff(task, args);
        const id = typeof args.id === 'string' && /^[\w.-]{1,160}$/.test(args.id) ? args.id : randomUUID();
        const existing = services.works.get(id);
        if (existing) {
          await services.sources.requireWork(id, task);
          if (['paused', 'cancelled'].includes(existing.status) && !userRequest) throw new Error('这项工作已停止；当前事件不包含用户新的继续要求。其他动作可以继续。');
        }
        const suppliedExecutor = typeof args.executor === 'string' ? { kind: args.executor } : modelArgs(args.executor);
        const selectedTarget = suppliedExecutor.target || args.target || (args.cwd ? { type: 'directory', cwd: args.cwd } : args.projectId ? { type: 'project', projectId: args.projectId } : null);
        const kind = modelText(suppliedExecutor.kind || suppliedExecutor.type || (selectedTarget ? 'codex' : '')).toLowerCase();
        const choices = services.executors();
        const executorKind = kind || choices.executors?.find(item => item.id === choices.defaultId)?.kind;
        const target = (selectedTarget || executorKind === 'codex') ? await resolveCodexTarget(selectedTarget, services, task) : null;
        const executor = kind || target ? { kind: kind || 'codex', ...(suppliedExecutor.connectionId ? { connectionId: suppliedExecutor.connectionId } : {}),
          ...(target ? { target } : {}) } : undefined;
        let project;
        try { project = target ? await services.sources.authorizeProject(target, task) : await services.sources.contextProject(task); }
        catch (error) { if (target) throw error; content.evidenceWarnings.push({ message: `Project scope is unavailable: ${error.message}` }); }
        if (project) {
          if (executor?.target?.type === 'project') executor.target = { ...executor.target, projectId: project.id };
          try { content.projectKnowledge = await services.memory.forProject(task, project); }
          catch (error) { content.evidenceWarnings.push({ message: `Project knowledge is unavailable: ${error.message}` }); }
        }
        try { content.currentKnowledge = await services.memory.forRequest(task, project); }
        catch (error) { content.evidenceWarnings.push({ message: `Current project rules are unavailable: ${error.message}` }); }
        const operationId = actionId(args, ctx, 'operationId');
        const work = services.works.create({ id, operationId, goal: modelText(args.goal || args.instruction || args.content || content.originalRequest.content),
          requirements: modelText(args.requirements), responsibility: modelText(args.responsibility), executor, project, initialHandoff: content }, task);
        const receipt = await services.works.dispatch(work.id, { id: operationId, kind: 'request', content, metadata: { priority: 'background', resume: userRequest } }, task);
        return { ...compactWork(work), ...receipt, handedOff: true, acceptance: modelText(args.acceptance), evidenceWarnings: content.evidenceWarnings };
      }),
    tool('work_update', frontend ? 'Pause or cancel existing work. Send requirements with work_dispatch; only the worker records progress and completion.' : 'Record actual progress and status of the current work. Its identity and revision are supplied by the program.',
      object({ id: string, ...(!frontend ? { goal: string, requirements: string, progress: string, checkpoint: {}, next: string, constraints: string, evidence: {},
        waiting: object({ kind: { type: 'string', enum: ['review', 'user-input', 'external'] }, question: string, reason: string }, ['kind']) } : {}), status: { type: 'string', enum: frontend ? ['paused', 'cancelled'] : ['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled'] } }), 'write', async args => {
        const work = await services.sources.requireWork(workId(args), task);
        assertExternalReviewCurrent(task, store);
        const review = task.metadata?.externalReview;
        if (review && (args.goal !== undefined || args.requirements !== undefined)) throw new Error('External evidence cannot rewrite the accepted work goal or requirements.');
        if (review && args.status === 'completed' && !review.confirmedFinal) throw new Error('The external result is not a confirmed final answer; it cannot establish completion.');
        if (review && (args.status === 'active' || review.running && (args.waiting || args.status && args.status !== work.status)))
          throw new Error('The external executor is still running; record its evidence and checkpoint without changing its lifecycle.');
        if (args.waiting?.kind === 'user-input' && !modelText(args.waiting.question).trim()) throw new Error('Waiting for user input requires the actual unanswered question.');
        if (['paused', 'cancelled'].includes(args.status) && work.id !== task.workId) return services.stopWork(work.id, args.status, task);
        const patch = Object.fromEntries((frontend ? ['status'] : ['goal', 'requirements', 'progress', 'status']).filter(key => args[key] !== undefined).map(key => [key, modelText(args[key])]));
        if (!frontend && args.waiting && args.status === 'waiting') patch.waiting = { kind: args.waiting.kind,
          question: modelText(args.waiting.question), reason: modelText(args.waiting.reason), since: new Date().toISOString() };
        if (!frontend) patch.checkpoint = { ...work.checkpoint, ...(args.checkpoint ? { note: modelText(args.checkpoint) } : {}),
          ...(args.progress !== undefined ? { progress: modelText(args.progress) } : {}), ...(args.next !== undefined ? { next: modelText(args.next) } : {}),
          ...(args.constraints !== undefined ? { constraints: modelText(args.constraints) } : {}), ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
          taskId: task.id, sessionId: task.sessionId, recordedAt: new Date().toISOString() };
        const statuses = new Set(['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled']);
        if (!frontend && patch.status === 'done') patch.status = 'completed';
        const ignoredStatus = patch.status !== undefined && !statuses.has(patch.status) ? patch.status : undefined;
        if (ignoredStatus !== undefined) delete patch.status;
        if (ignoredStatus !== undefined) return { ...services.works.update(work.id, { ...patch, expectedRevision: work.revision }),
          warning: `未识别可选状态 ${ignoredStatus}；有效进展已保留，工作状态未改动。` };
        return services.works.update(work.id, { ...patch, expectedRevision: work.revision });
      }),
    tool('work_dispatch', 'Continue an existing work with new instructions and available evidence. Detailed content and concise instruction are complementary derived guidance; both are retained. The program supplies the event ID and original binding. Stopped work resumes only for a fresh user request; peer observations add no authority.',
      object({ id: string, content: {}, ...handoffFields, correction: { type: 'boolean' } }), 'write', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        if (['paused', 'cancelled'].includes(work.status) && !userRequest) throw new Error('这项工作已停止；当前事件不包含用户新的继续要求。其他动作可以继续。');
        const content = await services.sources.handoff(task, args);
        try { content.projectKnowledge = await services.memory.forProject(task, services.sources.project(work)); }
        catch (error) { content.evidenceWarnings.push({ message: `Project knowledge is unavailable: ${error.message}` }); }
        try { content.currentKnowledge = await services.memory.forRequest(task, services.sources.project(work)); }
        catch (error) { content.evidenceWarnings.push({ message: `Current project rules are unavailable: ${error.message}` }); }
        const receipt = await services.works.dispatch(work.id, { id: actionId(args, ctx, 'eventId'), kind: frontend ? 'request' : 'event', content, metadata: { correction: args.correction === true, resume: frontend && userRequest, priority: 'foreground' } }, task);
        return { ...receipt, acceptance: modelText(args.acceptance), evidenceWarnings: content.evidenceWarnings };
      }),
    tool('work_wait', 'Save a wait for a precise execution result or deadline. For “wait for B, then let A use B’s output”, set targetWorkId=A, dependencyWorkId=B, taskId=B’s accepted task and instruction=the step A should perform. This includes A explaining partial output after B fails; keep success-only prerequisites in the instruction. The runtime derives follow_up for this cross-work step even if an optional mode conflicts. Waiting only to receive the same action’s already published result is observe and never sends another prompt. Supply no new step unless the user authorized one. Missing IDs can be recovered from unique accepted actions; explicit invalid work IDs are rejected. Finish other independent actions and reminders in this turn.',
      object({ id: string, waitId: string, taskId: string, botId: string, until: string, event: string,
        mode: { type: 'string', enum: ['observe', 'follow_up'] }, dependencyWorkId: string, targetWorkId: string, ...handoffFields }), 'write', async (args, ctx) => {
        let targetArgs = args;
        if (!(args.id ?? args.workId)) {
          const hint = args.targetWorkId || task.workId || source.metadata?.referencedWorkId || source.input?.trigger?.replyWorkId;
          const dependency = args.taskId && (!args.botId || args.botId === services.works.botId) && store.getTask(args.taskId);
          const accepted = store.listRecords('work-events').filter(event => event.requestTaskId === task.id && event.receipt?.accepted);
          const uniqueWorks = [...new Set(accepted.map(event => event.workId))];
          targetArgs = { ...args, id: hint || dependency?.workId || args.dependencyWorkId || (uniqueWorks.length === 1 ? uniqueWorks[0] : undefined) };
        }
        const work = await services.sources.requireWork(workId(targetArgs), task);
        if (args.dependencyWorkId) await services.sources.requireWork(args.dependencyWorkId, task);
        if (args.targetWorkId) await services.sources.requireWork(args.targetWorkId, task);
        let unresolvedTaskId;
        if (args.taskId) {
          if (args.botId && args.botId !== services.works.botId) {
            if (!store.listOutbox().some(item => item.to === args.botId && item.receipt?.taskId === args.taskId && store.getTask(item.taskId)?.conversationId === task.conversationId))
              throw new Error('This peer task was not submitted by the current conversation');
          } else {
            const dependency = store.getTask(args.taskId);
            if (!dependency || args.dependencyWorkId && dependency.workId !== args.dependencyWorkId) {
              const candidates = store.listRecords('work-events').filter(event => event.requestTaskId === task.id &&
                (!args.dependencyWorkId || event.workId === args.dependencyWorkId) && event.receipt?.accepted);
              if (candidates.length === 1) args = { ...args, taskId: candidates[0].receipt.taskId };
              else { unresolvedTaskId = args.taskId; args = { ...args, taskId: undefined }; }
            } else if (dependency.conversationId !== task.conversationId) await services.sources.requireWork(dependency.workId, task);
          }
        }
        const handoff = await services.sources.handoff(task, args);
        const waiting = Object.fromEntries(['taskId', 'botId', 'until', 'event', 'mode', 'dependencyWorkId', 'targetWorkId'].filter(key => typeof args[key] === 'string').map(key => [key, args[key]]));
        return { ...services.works.wait(work.id, { ...waiting, unresolvedTaskId, waitId: actionId(args, ctx, 'waitId'), handoff }, task), acceptance: modelText(args.acceptance), evidenceWarnings: handoff.evidenceWarnings };
      }),
    tool('work_notify', 'Save and publish this work’s useful result text directly. The program supplies the original recipient, reply association and notification ID; peer FYI does not demand another reply.',
      object({ id: string, content: string }), 'external', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        assertExternalReviewCurrent(task, store);
        return services.notify({ id: work.id, notificationId: actionId(args, ctx, 'notificationId'), publication: 'explicit', content: modelText(args.content ?? args.message ?? args.text, work.progress) }, task, ctx);
      }),
    tool('contacts_list', 'List configured direct Bot contacts. Direct messages and task queries do not use the gateway or chatroom.', object({}), 'read', () => services.contacts()),
    tool('messages_send', 'Send a durable message to a configured contact. The receipt only confirms acceptance; query the returned task separately. Reuse id to retry an uncertain delivery.',
      object({ to: string, id: string, content: {}, sessionId: string, replyTo: string, correlationId: string, kind: { type: 'string', enum: ['request', 'event'] }, workId: string, metadata: { type: 'object' } }, ['to', 'content']), 'external',
      (args, ctx) => services.send(args.to || args.botId, { ...args, id: typeof args.id === 'string' && args.id || actionId(args, ctx, 'id'), content: args.content ?? args.message ?? args.text }, { signal: ctx.signal, taskId: task.id })),
    tool('messages_list', 'Read received message previews and correlated task IDs, newest first. Content previews may be truncated; use the source chatroom_read or session history for full content.', object({ ...pageFields }), 'read', args => page(store.listMessages(), args, m => ({ id: m.id, from: m.from, sessionId: m.sessionId, taskId: m.taskId, replyTo: m.replyTo, correlationId: m.correlationId, createdAt: m.createdAt, content: preview(m.content) }))),
    tool('tasks_get', 'Read local task processing or a previously contacted Bot task. For external work this task is transport only: running is not an external turn, completed may only mean submission ended. Use the exact work/operation execution observation. Frontend reads are non-blocking.',
      object({ id: string, botId: string, waitMs:{type:'integer',minimum:0,maximum:60000} }, ['id']), 'read', async (args, ctx) => {
        args = { ...args, id: args.id || args.taskId };
        if (args.botId && args.botId !== services.works.botId && !store.listOutbox().some(item => item.to === args.botId && item.receipt?.taskId === args.id && item.taskId &&
          store.getTask(item.taskId)?.conversationId === task.conversationId)) throw new Error('Peer task is outside this conversation');
        const value = await services.getTask(args.id || args.taskId, args.botId, ctx.signal, frontend ? 0 : boundedNumber(args.waitMs, 0, 0, 60000));
        if (frontend && value && (!args.botId || args.botId === services.works.botId) && value.conversationId !== task.conversationId)
          await services.sources.requireWork(value.workId, task);
        if (!frontend && (!args.botId || args.botId === services.works.botId) && value && value.workId !== task.workId) throw new Error('Task belongs to another execution context');
        return frontend ? args.botId && args.botId !== services.works.botId ? compactTask(value) : taskView(value) : value;
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
      return page(values, args, taskView);
    }),
    tool('state_get', 'Read local durable state.', object({ scope: string, key: string }, ['scope', 'key']), 'read', args => store.getState(args.scope, args.key)),
    tool('state_set', 'Write local durable state; optional expectedRevision prevents lost updates.',
      object({ scope: string, key: string, value: {}, expectedRevision: { type: 'integer', minimum: 0 } }, ['scope', 'key', 'value']), 'write',
      args => store.setState(args.scope, args.key, args.value, args)),
    tool('artifact_save', 'Save task output as a durable artifact and return its receipt.',
      object({ name: string, mimeType: string, content: string }, ['name', 'content']), 'write', (args, ctx) => ctx.saveArtifact(args)),
  ];
}
