import { jsonToolResult } from './registry.mjs';
import { taskMode, compactWork, compactTask, assertExternalReviewCurrent } from './task-policy.mjs';
import { randomUUID } from 'node:crypto';
import { factTime } from '../context/fact-time.mjs';
import { HANDOFF_REFERENCES, taskSource, workExecution } from '../context/sources.mjs';
import { modelArgs, modelText, looseSchema, boundedNumber } from '../context/model-input.mjs';
import { resolveCodexTarget } from './codex-target.mjs';
import { authorizeProduction, currentProductionStage, productionDecision, productionStage, requestIntents, productionStages } from './request-routing.mjs';
import { externalExecution, isAcceptedOperation } from '../context/execution-evidence.mjs';
import { readExecutorManifest } from '../runtime/executor-delivery.mjs';
import { WORK_ATTACHMENTS } from '../runtime/notifications.mjs';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const flexible = name => name.startsWith('work') || ['evidence_read', 'tasks_get', 'tasks_list', 'messages_send'].includes(name);
const tool = (name, description, inputSchema, effect, execute) => ({ name, description, inputSchema: flexible(name) ? looseSchema(inputSchema) : inputSchema, effect,
  execute: async (args, context) => jsonToolResult(await execute(modelArgs(args), context)) });
const pageFields = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } };
const reference = object({ type: { type: 'string', enum: ['room', 'session', 'artifact', 'knowledge', 'work', 'tool'] }, roomId: string, scopeId: string, workId: string, operationId: string,
  messageId: string, sessionId: string, entryId: string, id: string, section: { type: 'string', enum: ['acceptedStep', 'evidenceItem', 'toolContent'] },
  index: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 64000 } }, ['type']);
const evidence = { type: 'array', maxItems: HANDOFF_REFERENCES, items: reference,
  description: 'Selected exact references from source reads, e.g. [{type:"room",roomId:"...",messageId:"..."}]. Pass the array itself; a JSON array string is also readable. Prose is guidance, not a source grant.' };
const handoffFields = { evidence, knowledgeScopes: { type: 'array', items: string }, instruction: string, acceptance: string };
const waitingFields = object({ kind: { type: 'string', enum: ['review', 'user-input', 'external'] }, question: string, reason: string,
  blockingRequirement: { type: 'string', description: 'For user-input after a confirmed final, name the unmet requirement of this same work that needs the answer. Review of a delivered result and permission for separate next work belong to review.' } }, ['kind']);
const preview = value => { const text = typeof value === 'string' ? value : JSON.stringify(value ?? null); return { text: text.slice(0, 1600), truncated: text.length > 1600 }; };
const roomPublications = (store, workId, roomId) => store.listRecords('work-notifications')
  .filter(item => item.workId === workId && item.roomId === roomId && item.status === 'delivered');
function localPublications(store, work, operation, roomId) {
  const source = operation?.authorization?.source;
  if (work.executor?.kind !== 'pi' || work.bindings?.some(item => item.type === 'codex-desktop') ||
    operation?.workId !== work.id || !roomId || source?.roomId !== roomId || !source.replyTo) return [];
  return roomPublications(store, work.id, roomId).flatMap(item => {
    if (item.executionEventId !== operation.id || item.replyTo !== source.replyTo || item.publication !== 'explicit' ||
      item.late || item.resultKind === 'progress') return [];
    const task = store.getTask(item.taskId);
    if (task?.workId !== work.id || workExecution(task, store).executionEventId !== operation.id) return [];
    return (Array.isArray(item.receipt) ? item.receipt : [item.receipt]).flatMap(receipt => {
      if (!receipt?.id || receipt.roomId !== roomId || receipt.workId !== work.id ||
        receipt.senderId !== work.botId || receipt.replyTo !== source.replyTo) return [];
      const attachments = (receipt.attachments || []).filter(attachment =>
        attachment.id && attachment.origin?.type === 'work-output' && attachment.origin.publicationId === attachment.id &&
        attachment.origin.workId === work.id && attachment.origin.roomId === roomId && attachment.origin.botId === work.botId &&
        item.attachments?.some(selected => selected.id === attachment.id));
      return attachments.length ? [{ task, messageId: receipt.id, attachments }] : [];
    });
  });
}

function outputReceipts(store, work, operation, roomId, delivery) {
  if (!roomId || operation.authorization?.source?.roomId !== roomId) return [];
  const nativeIds = new Set(delivery?.attachments?.map(item => item.id));
  const native = roomPublications(store, work.id, roomId).flatMap(item => {
    if ((item.manifestOperationId || item.executionEventId) !== operation.id || item.late || item.resultKind === 'progress') return [];
    return [item.receipt].flat().flatMap(receipt => {
      if (!receipt?.id || receipt.roomId !== roomId || receipt.workId !== work.id || receipt.senderId !== work.botId ||
        receipt.replyTo !== operation.authorization.source.replyTo) return [];
      return (receipt.attachments || []).filter(attachment => nativeIds.has(attachment.id) &&
        item.attachments?.some(selected => selected.id === attachment.id)).map(attachment => ({ id: attachment.id, messageId: receipt.id }));
    });
  });
  const local = localPublications(store, work, operation, roomId).flatMap(item => item.attachments.map(attachment => ({ id: attachment.id, messageId: item.messageId })));
  return [...new Map([...native, ...local].map(item => [item.id, item])).values()];
}

function acceptanceTarget(store, work, roomId) {
  if (work.executor?.kind === 'pi' && !work.bindings?.some(item => item.type === 'codex-desktop')) {
    const last = work.lastTaskId && store.getTask(work.lastTaskId);
    if (work.status !== 'completed' || last?.workId !== work.id || last.status !== 'completed' ||
      !last.finishedAt || last.result?.partial || last.result?.suspended || last.metadata?.sourceType === 'external') return null;
    const { executionEventId } = workExecution(last, store);
    const operation = executionEventId && store.getRecord('work-events', executionEventId);
    if (operation?.authorization?.source?.actor !== 'user') return null;
    const publications = localPublications(store, work, operation, roomId)
      .filter(item => item.task.status === 'completed' && item.task.finishedAt && !item.task.result?.partial);
    return publications.length ? { operationId: operation.id, publicationMessageIds: [...new Set(publications.map(item => item.messageId))] } : null;
  }
  const execution = externalExecution(work), outcome = work.executionOutcome;
  if (!roomId || !['waiting', 'completed'].includes(work.status) || work.status === 'waiting' && work.waiting?.kind !== 'review' ||
    !execution.startedConfirmed || !execution.externalReceived || execution.operationId !== execution.currentOperationId ||
    execution.status !== 'completed' || outcome?.kind !== 'execution-ended' || !outcome.finalConfirmed ||
    outcome.operationId !== execution.operationId || outcome.turnId !== execution.turnId) return null;

  const binding = work.bindings.find(item => item.id === execution.bindingId);
  const receipts = new Map(binding.operations?.filter(item => item.status === 'received' &&
    item.threadId === execution.threadId).map(item => [item.operationId, item]));
  let { operationId, turnId } = execution;
  const notifications = store.listRecords('work-notifications').filter(item => item.workId === work.id);
  const visited = new Set();
  while (receipts.get(operationId)?.verificationOnly) {
    const previous = receipts.get(operationId).precedingTurn;
    if (visited.has(operationId) || previous?.status !== 'completed' || previous.turnId === turnId || !receipts.has(previous.operationId) ||
      notifications.some(item => item.executionEventId === operationId && item.attachments?.length)) return null;
    visited.add(operationId);
    ({ operationId, turnId } = previous);
  }
  // A read-only verification can preserve a previously published file, but is never itself the result.
  const throughVerification = operationId !== execution.operationId;
  const publicationMessageIds = notifications.flatMap(item => {
    if (item.roomId !== roomId || item.status !== 'delivered' || item.late || !item.replyTo ||
      item.publication !== 'external' || item.executionEventId !== operationId || item.resultKind !== 'execution-ended' ||
      !item.sourceRefs?.some(ref => ref.type === 'codex' && ref.operationId === operationId &&
        ref.threadId === execution.threadId && ref.turnId === turnId)) return [];
    return (Array.isArray(item.receipt) ? item.receipt : [item.receipt]).flatMap(receipt => {
      if (!receipt?.id || receipt.roomId !== roomId || receipt.workId !== work.id || receipt.senderId !== work.botId ||
        receipt.replyTo !== item.replyTo || (throughVerification || item.attachments?.length) &&
        !receipt.attachments?.some(attachment => item.attachments?.some(published => published.id === attachment.id))) return [];
      return [receipt.id];
    });
  });
  return publicationMessageIds.length ? { operationId, turnId, publicationMessageIds: [...new Set(publicationMessageIds)],
    ...(throughVerification ? { throughOperationId: execution.operationId } : {}) } : null;
}

function outputOperationId(store, work, roomId, requestedId) {
  const id = requestedId || acceptanceTarget(store, work, roomId)?.operationId || work.waiting?.operationId ||
    work.bindings?.findLast(item => item.type === 'codex-desktop')?.operationId ||
    (work.executor?.kind === 'pi' && work.lastTaskId && workExecution(store.getTask(work.lastTaskId), store).executionEventId);
  if (!id || store.getRecord('work-events', id)) return id;
  return roomPublications(store, work.id, roomId).find(item => item.executionEventId === id &&
    item.manifestOperationId && item.attachments?.length)?.manifestOperationId || id;
}
function page(items, args, project) {
  const offset = boundedNumber(args.offset, 0), limit = boundedNumber(args.limit, 10, 1, 20);
  const values = [...items].reverse();
  return { total: values.length, offset, items: values.slice(offset, offset + limit).map(project), nextOffset: offset + limit < values.length ? offset + limit : null };
}

export function coreTools(services, task) {
  const store = services.store;
  const frontend = taskMode(task) !== 'work';
  const review = task.metadata?.externalReview;
  const workView = (work, observedAt) => frontend ? compactWork(work, observedAt) : work;
  const taskView = value => compactTask(value, value?.workId && services.works.get(value.workId),
    value && services.works.execution(value).executionEventId);
  const source = taskSource(task, store);
  const userRequest = source.actor === 'user' && store.getMessage(task.messageId)?.kind === 'request';
  const availableOutputs = async (work, operation, delivery) => {
    if (!frontend || !source.roomId || operation.authorization?.source?.roomId !== source.roomId) return [];
    const receipts = outputReceipts(store, work, operation, source.roomId, delivery);
    const result = await services.capability('chatroom_read', { roomId: source.roomId, workId: work.id, operationId: operation.id,
      outputReceipts: receipts.slice(0, WORK_ATTACHMENTS) }, task);
    return result.attachments;
  };
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
  const targetIdentity = work => ({ ...work, status: undefined, executionStatus: undefined });
  const sameWork = (expected, current) => Boolean(current && JSON.stringify(targetIdentity(selectedWork(current))) ===
    JSON.stringify(targetIdentity(expected)));
  const authorize = (decision, ctx, proposed, { workId, actionId }) => authorizeProduction({ task, store, decision, proposed,
    workId, actionId, verify: ctx.verifyProduction, signal: ctx.signal,
    isTargetCurrent: proposed.work ? () => sameWork(proposed.work, services.works.get(workId)) : undefined });
  const selectedWork = work => {
    const binding = work.bindings?.findLast(item => item.type === 'codex-desktop');
    const execution = externalExecution(work, binding?.operationId);
    return { id: work.id, goal: work.goal, requirements: work.requirements, status: work.status,
      project: work.project, target: work.executor?.target, controlRevision: work.controlRevision || 0,
      priorStage: currentProductionStage(work, store), operationId: execution?.operationId,
      executionStatus: execution?.status, bindingId: binding?.id };
  };
  const documentBoundary = (work, grant) => {
    if (grant?.stage !== 'document-review') return;
    if (services.works.executor(work).kind !== 'codex')
      throw new Error('正式文档修订需要 Codex 执行器。请选择对应的 Codex 文档工作，或登记独立新文档工作。');
    if ((['active', 'paused', 'cancelled'].includes(work.status) || work.status === 'waiting' && work.waiting?.kind === 'external') &&
      currentProductionStage(work, store) !== 'document-review')
      throw new Error('仅文稿授权不会追加到正在实施的回合或恢复已停止的实施工作。请使用对应的文档工作，或登记独立新文档工作。');
  };
  return [
    tool('request_decide', 'Classify the CURRENT authenticated user request by meaning before acting. Choose feedback for a trial result, failure report, critique or observation for this chat without a current request to make a change. Record or explain it here. Choose discuss for planning, selecting rules or a small in-chat draft. produce/revise requires a positive request to execute a specific action now or register it for an explicit dependency. A formal document request authorizes its own stage. Read the saved intent returned by this tool before calling work_create/work_dispatch. The proposed action and scope are separately verified. status means inspect progress; deliver means return EXISTING output; accept means explicit scoped acceptance; control includes pause/stop/cancel. If the user explicitly accepts the current result within a stated scope, select accept and call work_accept before replying even when they also ask for status, what evidence or saved rules were used, or a closeout correction. Use the canonical workId and operationId from work_get.acceptanceTarget. Preserve all stated limits. A request may accept a document AND explicitly request independent implementation: select produce, its production stage/relation, AND those acceptances; call work_accept for each BEFORE work_create/work_dispatch. Production alone never implies acceptance. For existing files select deliver, then work_outputs and work_deliver with its replyDelivery IDs. A positive request for missing rendering, screenshots or revisions can be production. Decide by the meaning of the authenticated original, including any separately authorized action. This decision grants no extra authority.',
      object({ intent: { type: 'string', enum: requestIntents }, productionStage: { type: 'string', enum: productionStages,
        description: 'Classify the requested outcome. A standalone formal Markdown review document, its revision and returning the resulting file are one document-review action. Implementation means making or changing the working product, building, testing or deploying it. Other is an independent action outside both stages.' },
        workRelation: { type: 'string', enum: ['new', 'continue'] }, workId: string,
        sourceUnit: { type: 'integer', minimum: 1, description: 'Select an original action unit only when the authorization check reports several separate actions. Retain the saved stage when finishing the same existing step.' },
        acceptances: { type: 'array', maxItems: 8, items: object({ workId: string, operationId: string }, ['workId', 'operationId']),
          description: 'Only results explicitly accepted by THIS user request; use exact canonical work and ended operation IDs. Complete these scoped acceptances before the production action.' }, reason: string }, ['intent', 'reason']), 'write', async (args, ctx) => {
        if (!frontend || !userRequest) throw new Error('Request decisions belong to the current authenticated frontend user request.');
        if (!requestIntents.includes(args.intent)) throw new Error('Choose a supported request intent.');
        if (['produce', 'revise'].includes(args.intent) && !productionStages.includes(args.productionStage)) throw new Error('Production requires its actual stage.');
        let intent = args.intent, production = ['produce', 'revise'].includes(intent);
        if (args.sourceUnit !== undefined && (!production || !Number.isSafeInteger(args.sourceUnit) || args.sourceUnit < 1))
          throw new Error('The original action unit must be a positive integer for production.');
        if (production && !['new', 'continue'].includes(args.workRelation)) throw new Error('Decide whether this is an independent new task or a continuation of an existing deliverable. Use workRelation=new or continue; continue also needs its canonical workId.');
        const work = production && args.workRelation === 'continue' ? await services.sources.requireWork(args.workId, task) : null;
        const acceptances = args.acceptances ?? [];
        if (!Array.isArray(acceptances) || acceptances.length > 8 || args.intent === 'accept' && !acceptances.length ||
          acceptances.length && !['accept', 'produce', 'revise'].includes(args.intent))
          throw new Error('Explicit acceptance requires exact work/operation targets; combine it only with accept or an independently authorized production/revision.');
        for (const target of acceptances) {
          const work = await services.sources.requireWork(target.workId, task);
          if (!target.operationId || acceptanceTarget(store, work, source.roomId)?.operationId !== target.operationId)
            throw new Error('Acceptance must select the exact eligible result from work_get.acceptanceTarget. A failed, running, or superseded result cannot be accepted.');
        }
        const previous = store.getRecord('request-routing', task.id);
        const messageId = source.replyTo || source.messageId;
        let confirmedFeedback = previous?.confirmedFeedback === true;
        let sourceActions;
        if (production) {
          const selected = work && selectedWork(work);
          const classification = !confirmedFeedback && await authorizeProduction({ task, store,
            decision: { messageId, roomId: source.roomId }, proposed: { work: selected || undefined },
            verify: ctx.verifyProduction, signal: ctx.signal, isTargetCurrent: selected ? () => sameWork(selected, services.works.get(work.id)) : undefined,
            sourceOnly: true, savedDecision: previous ?? null });
          if (confirmedFeedback || !classification.actions.length) {
            confirmedFeedback ||= classification.feedback === true;
            production = false;
            intent = confirmedFeedback ? 'feedback' : acceptances.length ? 'accept' : classification.deliveryUnits.length ? 'deliver' : 'discuss';
          } else sourceActions = classification.actions;
        }
        const decision = store.putRecord('request-routing', { id: task.id, messageId,
          roomId: source.roomId, acceptances: ['accept', 'produce', 'revise'].includes(intent) ? acceptances.map(({ workId, operationId }) => ({ workId, operationId })) : [],
          intent, productionStage: production ? args.productionStage : null, confirmedFeedback,
          existingDelivery: previous?.existingDelivery === true || intent === 'deliver', sourceUnit: production ? args.sourceUnit : null,
          workRelation: production ? args.workRelation : null, workId: production && args.workRelation === 'continue' ? args.workId : null,
          reason: intent !== args.intent ? 'The authenticated source contains no independent production action.' : modelText(args.reason), authority: 'model-routing-decision' });
        if (intent !== args.intent) return { ...decision, instruction: 'Follow the saved intent and respond to the original message. Do not call work_create or work_dispatch for this source classification.' };
        return sourceActions ? { ...decision, sourceActions,
          instruction: 'These are the saved independent source actions. Submit only an action grounded in the original and consistent with this decision. Correct an actual routing mismatch once. If the saved classification disagrees with the original, report the gap without relabeling the original request or trying alternate targets.' } : decision;
      }),
    tool('evidence_read', 'Read a bounded original fragment by exact reference. Workers may follow only handed-off references, never browse another room/session feed. Current source access is rechecked.',
      object({ reference }, ['reference']), 'read', args => services.sources.resolve(services.sources.reference(args.reference ?? args, task), task)),
    tool('executors_status', 'Read the current default work engine and saved host executor consent. Authorized onboarding Pi work can connect with workspace_setup. Execution runs as independent work.', object({}), 'read', () => services.executors()),
    tool('runtime_status', 'Read the current source room/work snapshot. Local tasks, external turn status, pending connector events and S3 waits are separate. Unknown connector state never counts as zero.', object({}), 'read', async () => {
      const rooms = await services.sources.rooms(task), works = [];
      for (const work of services.works.list({ limit: 500 })) if (await services.sources.canReadWork(work, task, rooms)) works.push(work);
      const ids = new Set(works.map(work => work.id));
      const local = store.listTasks({ limit: 10000 }).filter(item => ids.has(item.workId) || !item.workId && taskSource(item, store).roomId === source.roomId);
      const connectors = [];
      for (const work of works.filter(item => item.bindings?.some(binding => binding.type === 'codex-desktop'))) {
        try { const state = await services.capability('codex_status', { workId: work.id }, task);
          connectors.push({ workId: work.id, status: state.status, turnId: state.turnId, eventDelivery: state.eventDelivery }); }
        catch (error) { connectors.push({ workId: work.id, unavailable: error.message, eventDelivery: null }); }
      }
      return { scope: { roomId: source.roomId, workIds: [...ids], global: false }, facts: factTime(),
        localTasks: Object.fromEntries(['accepted', 'queued', 'running', 'waiting'].map(status => [status, local.filter(item => item.status === status).length])),
        works: works.map(work => ({ id: work.id, status: work.status, waiting: work.waiting, executionOutcome: work.executionOutcome,
          execution: externalExecution(work), updatedAt: work.updatedAt })), connectors };
    }),
    tool('request_actions', 'Read saved action receipts for an original message in this conversation (messageId defaults to the current trigger). Use this when older published user instructions lack a visible reply: history is not permission to repeat them. Returns saved action identity/status without replaying anything.',
      object({ messageId: string }), 'read', args => {
        const messageId = args.messageId || source.replyTo || source.messageId;
        return store.listTasks({ limit: 10000 }).filter(item => item.conversationId === task.conversationId &&
          [taskSource(item, store).replyTo, item.messageId].includes(messageId)).map(item => ({ taskId: item.id, messageId,
          status: item.status, actions: store.listTools(item.id).filter(record => record.effect !== 'read').map(record => {
            const receipt = record.output?.details || {};
            return { actionId: record.id, tool: record.name, status: record.status, id: receipt.id, workId: receipt.workId,
              taskId: receipt.taskId, operationId: receipt.operationId,
              execution: receipt.workId && services.works.get(receipt.workId) ? externalExecution(services.works.get(receipt.workId), receipt.operationId) : receipt.execution,
              savedExecution: receipt.execution, receiptLayer: receipt.receiptLayer,
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
      if (!result.work) return { unresolved: true, lookup: result.lookup };
      let connector;
      if (result.work.bindings?.some(binding => binding.type === 'codex-desktop')) {
        try { const state = await services.capability('codex_status', { workId: result.work.id }, task); connector = {
          status: state.status, turnId: state.turnId, observedAt: state.observedAt, eventDelivery: state.eventDelivery }; }
        catch (error) { connector = { unavailable: error.message, eventDelivery: null }; }
      }
      const view = workView(result.work, result.observedAt), operationId = view.execution?.operationId;
      const operation = operationId && store.getRecord('work-events', operationId);
      const origin = operation?.authorization?.source;
      const deliveryScope = frontend && source.roomId && origin?.roomId === source.roomId && operation.workId === view.id &&
        operation.receipt?.accepted && (origin.replyTo || origin.formId === view.id) ?
        { operationId, roomId: origin.roomId, messageId: origin.replyTo, formId: origin.formId } : undefined;
      return { ...view, lookup: result.lookup, deliveryScope,
        ...(frontend ? { currentStage: currentProductionStage(result.work, store) } : {}),
        ...(frontend ? { acceptanceTarget: acceptanceTarget(store, result.work, source.roomId) } : {}), ...(connector ? { connector } : {}) };
    }),
    tool('work_outputs', 'Read an exact operation manifest and confirmed same-room output receipts. replyDelivery.candidates list names, sizes, original message IDs and selectable attachment IDs. Read another page using offset. For a requested existing path with no prior upload use publish_file with this exact workId and operationId. Preserve unknown uploads and report gaps. This read never authorizes production.',
      object({ id: string, operationId: string, ...pageFields }), 'read', async args => {
        const work = await services.sources.requireWork(workId(args), task);
        const operationId = outputOperationId(store, work, source.roomId, args.operationId);
        const operation = operationId && store.getRecord('work-events', operationId);
        if (!operation || operation.workId !== work.id) throw new Error('No matching output operation; read work_get for its exact identity.');
        const delivery = store.getRecord('executor-deliveries', operation.id);
        const available = await availableOutputs(work, operation, delivery);
        const ready = available.length > 0, offset = boundedNumber(args.offset, 0), limit = boundedNumber(args.limit, 10, 1, 20);
        let manifest, unavailable;
        try { manifest = await readExecutorManifest({ workspace: services.workspace, workId: work.id, operation }); }
        catch (error) { unavailable = error.code === 'ENOENT' ? 'No existing result manifest' : error.message; }
        const artifacts = manifest?.artifacts || [], total = Math.max(available.length, artifacts.length);
        const missing = delivery?.status === 'rejected' && delivery.httpStatus === 413 ?
          'The file exceeded the chat attachment limit and was not uploaded. Use the existing file through authorized local project access, or return another requested, already existing file within the chat limit.' :
          'No currently readable confirmed attachment for this operation in this room. Preserve uncertain uploads and report gaps.';
        return { workId: work.id, operationId: operation.id,
          replyDelivery: { ready, total: available.length, candidates: available.slice(offset, offset + limit),
            next: ready ? 'Use work_deliver with this workId and operationId. Supply candidate IDs for a subset or omit them to return all confirmed attachments.' :
              missing },
          delivery: delivery && { id: delivery.id, status: delivery.status, error: delivery.error, errorCode: delivery.errorCode, httpStatus: delivery.httpStatus }, unavailable,
          artifacts: operation.authorization?.source?.roomId === source.roomId ? artifacts.slice(offset, offset + limit) : [],
          offset, nextOffset: offset + limit < total ? offset + limit : null };
      }),
    tool('work_deliver', 'Select request_decide intent=deliver for this request (produce/revise also allows returning existing files). Read work_outputs and pass its workId, operationId and IDs from replyDelivery.candidates. Omit attachmentIds only to select all confirmed attachments. A failed selection can be corrected using the same operation. This selects existing files for the current reply.',
      object({ id: string, operationId: string, attachmentIds: { type: 'array', minItems: 1, maxItems: WORK_ATTACHMENTS, items: string,
        description: 'Only IDs from work_outputs.replyDelivery.candidates for this exact operation and room. Omit to select all.' } }, ['id', 'operationId']), 'write', async args => {
        if (!frontend || !userRequest || !['deliver', 'produce', 'revise'].includes(store.getRecord('request-routing', task.id)?.intent))
          throw new Error('Select existing-output delivery with request_decide for this authenticated request first.');
        const work = await services.sources.requireWork(workId(args), task);
        if (!args.operationId) throw new Error('Select the exact operationId returned by work_outputs.');
        const operationId = args.operationId;
        const operation = operationId && store.getRecord('work-events', operationId);
        if (!operation || operation.workId !== work.id) throw new Error('Output operation does not belong to this work.');
        const delivery = store.getRecord('executor-deliveries', operation.id);
        const available = await availableOutputs(work, operation, delivery);
        if (!available.length)
          throw new Error('No currently readable publication for this operation in the source room. Read work_outputs again for the same operation and use publish_file only for a requested existing file whose upload has not started.');
        const selected = args.attachmentIds;
        if (selected === undefined && available.length > WORK_ATTACHMENTS) throw new Error('Select a subset of up to 64 confirmed attachments from work_outputs.');
        if (selected !== undefined && (!Array.isArray(selected) || !selected.length || selected.length > WORK_ATTACHMENTS ||
          selected.some(id => !available.some(item => item.id === id))))
          throw Object.assign(new Error(`Selection failed for this exact operation. Call work_outputs again for work ${work.id}, operation ${operationId}, and choose its current candidate IDs. Omit attachmentIds only if the user requested all confirmed outputs.`), { code: 'OUTPUT_SELECTION_INVALID' });
        return { workId: work.id, operationId, status: 'ready-for-current-reply',
          attachments: available.filter(item => !selected || selected.includes(item.id)).map(({ id }) => ({ id })) };
      }),
    tool('work_accept', 'Record THIS user’s explicit scoped acceptance. FIRST select the exact workId/operationId in request_decide.acceptances, with intent=accept or a separately authorized produce/revise combination. THEN accept it before starting that next production. Copy the operationId from work_get.acceptanceTarget and preserve all unverified boundaries. A status question can accompany explicit acceptance. Never accept running/stopped/unknown results or infer acceptance from a development request alone.',
      object({ id: string, operationId: string, scope: string, remainingBoundaries: string }, ['id', 'operationId', 'scope', 'remainingBoundaries']), 'write', async args => {
        const decision = store.getRecord('request-routing', task.id);
        if (!frontend || !userRequest || !['accept', 'produce', 'revise'].includes(decision?.intent) ||
          decision.messageId !== (source.replyTo || source.messageId) || decision.roomId !== source.roomId ||
          !decision.acceptances?.some(item => item.workId === workId(args) && item.operationId === args.operationId))
          throw new Error('Explicit current user acceptance of this exact work/operation must be selected in request_decide.acceptances first; production intent alone cannot accept a result.');
        const work = await services.sources.requireWork(workId(args), task);
        if (!modelText(args.scope).trim() || args.remainingBoundaries === undefined) throw new Error('Record the actual accepted scope and the remaining unverified boundaries.');
        const target = acceptanceTarget(store, work, source.roomId);
        const pending = store.listUnfinishedTasks().some(item => item.workId === work.id && ['accepted', 'queued', 'running'].includes(item.status));
        if (!target || target.operationId !== args.operationId || pending)
          throw new Error('This work has no matching ended result ready for acceptance; read work_get before acting.');
        if (work.acceptance?.operationId === args.operationId && work.acceptance.source?.roomId === source.roomId &&
          work.acceptance.source?.messageId === (source.replyTo || source.messageId)) return work;
        return services.works.update(work.id, { status: 'completed', expectedRevision: work.revision,
          acceptance: { scope: modelText(args.scope), remainingBoundaries: modelText(args.remainingBoundaries), operationId: target.operationId,
            ...(target.turnId ? { turnId: target.turnId } : {}),
            ...(target.publicationMessageIds ? { publicationMessageIds: target.publicationMessageIds } : {}),
            ...(target.throughOperationId ? { throughOperationId: target.throughOperationId } : {}),
            source: { type: 'room', roomId: source.roomId, messageId: source.replyTo || source.messageId }, recordedAt: new Date().toISOString() } });
      }),
    tool('work_create', 'Accept and asynchronously dispatch independent work. The receipt confirms local scheduling only, not Pi/Codex execution, native registration or completion. Omit executor for the default engine. Give goal, evidence, handoff prose and an authorized target; the program supplies operation IDs and refreshes current project rules. Do not repeat or wait on this frontend call to strengthen the acknowledgment.',
      object({ id: string, operationId: string, goal: string, requirements: string, responsibility: string, ...handoffFields,
        executor: object({ kind: { type: 'string', enum: ['pi', 'codex', 'codex-cli', 'grok', 'claude-code'] }, connectionId: string,
          target: { type: 'object', description: 'Use {type:"directory",cwd:"absolute authorized path"} for an existing directory, including one not registered in Desktop. Use project only for the actual selected project; never borrow another project ID.' } }, ['kind']) }), 'write', async (args, ctx) => {
        const decision = productionDecision(task, store);
        if (decision?.workRelation === 'continue') throw new Error(`Continue the existing deliverable with work_dispatch workId=${decision.workId}; this request does not authorize another work.`);
        const id = typeof args.id === 'string' && /^[\w.-]{1,160}$/.test(args.id) ? args.id : randomUUID();
        const operationId = actionId(args, ctx, 'operationId');
        const existing = services.works.get(id);
        if (existing) {
          await services.sources.requireWork(id, task);
          if (store.getRecord('work-handoffs', `task:${task.id}:action:${operationId}`)?.workId !== id)
            throw new Error('This ID already belongs to an existing work. Use its canonical continuation only if the current request authorizes it; otherwise omit the ID for independent work.');
        }
        const suppliedExecutor = typeof args.executor === 'string' ? { kind: args.executor } : modelArgs(args.executor);
        const selectedTarget = suppliedExecutor.target || args.target || (args.cwd ? { type: 'directory', cwd: args.cwd } : args.projectId ? { type: 'project', projectId: args.projectId } : null);
        const documentOnly = decision?.productionStage === 'document-review';
        const kind = documentOnly ? 'codex' : modelText(suppliedExecutor.kind || suppliedExecutor.type || (selectedTarget ? 'codex' : '')).toLowerCase();
        const choices = services.executors();
        const executorKind = kind || choices.executors?.find(item => item.id === choices.defaultId)?.kind;
        const target = (selectedTarget || executorKind === 'codex') ? await resolveCodexTarget(selectedTarget, services, task) : null;
        const executor = kind || target ? { kind: kind || 'codex', ...(suppliedExecutor.connectionId ? { connectionId: suppliedExecutor.connectionId } : {}),
          ...(target ? { target } : {}) } : undefined;
        const content = await services.sources.handoff(task, args);
        let project;
        try { project = target ? await services.sources.authorizeProject(target, task) : await services.sources.contextProject(task); }
        catch (error) { if (target) throw error; content.evidenceWarnings.push({ message: `Project scope is unavailable: ${error.message}` }); }
        if (project && executor?.target?.type === 'project') executor.target = { ...executor.target, projectId: project.id };
        const goal = modelText(args.goal || args.instruction || args.content || content.originalRequest.content);
        const requirements = modelText(args.requirements);
        const grant = await authorize(decision, ctx, { relation: 'new', project, target: executor?.target || target, executor: executorKind,
          goal, requirements, handoff: content.handoff }, { workId: id, actionId: `${id}:${operationId}` });
        if (grant) content.stage = productionStage(grant);
        try {
          content.currentKnowledge = await services.memory.forRequest(task, project);
          content.projectKnowledge = content.currentKnowledge?.projectKnowledge;
        }
        catch (error) { content.evidenceWarnings.push({ message: `Current project rules are unavailable: ${error.message}` }); }
        ctx.signal?.throwIfAborted();
        const work = services.works.create({ id, operationId, goal,
          requirements, responsibility: modelText(args.responsibility), executor, project,
          productionStage: grant?.stage, productionAuthorization: grant, initialHandoff: content }, task);
        const receipt = await services.works.dispatch(work.id, { id: operationId, kind: 'request', content, metadata: { priority: 'background' } }, task);
        return { ...compactWork(work), ...receipt, handedOff: receipt.accepted === true, acceptance: modelText(args.acceptance), evidenceWarnings: content.evidenceWarnings };
      }),
    tool('work_update', frontend ? 'Pause or cancel existing work. Send requirements with work_dispatch; only the worker records progress and completion.' : review ? 'Record progress, checkpoints, next steps and evidence for the current external review. Follow the current external_work_review to determine whether status and waiting can be updated. Preserve the accepted goal and requirements.' : 'Record actual progress and status of the current work. Its identity and revision are supplied by the program.',
      object({ id: string, ...(!frontend ? { goal: string, requirements: string, progress: string, checkpoint: {}, next: string, constraints: string, evidence: {},
        waiting: waitingFields } : {}), status: { type: 'string', enum: frontend ? ['paused', 'cancelled'] : ['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled'] } }), 'write', async args => {
        const work = await services.sources.requireWork(workId(args), task);
        assertExternalReviewCurrent(task, store);
        const review = task.metadata?.externalReview;
        if (review && work.status === 'completed' && isAcceptedOperation(work, review.operationId) &&
          (args.waiting || args.status && args.status !== 'completed')) throw new Error('This exact result was explicitly accepted by the user; retain its accepted scope and unverified boundaries without reopening it from external evidence.');
        if (review && (args.goal !== undefined || args.requirements !== undefined)) throw new Error('External evidence cannot rewrite the accepted work goal or requirements.');
        const outcome = work.executionOutcome;
        const currentOutcome = review && outcome && outcome.operationId === review.operationId && outcome.turnId === review.turnId ? outcome : null;
        const confirmedFinal = review?.confirmedFinal && currentOutcome?.kind === 'execution-ended' && currentOutcome.finalConfirmed;
        if (review && ['completed', 'done'].includes(args.status) && !confirmedFinal)
          throw new Error('Completion requires the confirmed final of this exact ended operation.');
        if (review && (args.status === 'active' || review.running && (args.waiting !== undefined || args.status !== undefined)))
          throw new Error('The external executor is still running; record its evidence and checkpoint without changing its lifecycle.');
        if (currentOutcome?.kind === 'needs-input' && args.waiting && args.waiting.kind !== 'user-input')
          throw new Error('Keep the current native request as a user-input wait while its answer is outstanding.');
        const question = modelText(args.waiting?.question).trim(), blockingRequirement = modelText(args.waiting?.blockingRequirement).trim();
        if (args.waiting?.kind === 'user-input' && !question) throw new Error('Waiting for user input requires the actual unanswered question.');
        if (confirmedFinal && args.waiting?.kind === 'user-input' && !blockingRequirement)
          throw new Error('After a confirmed final, user-input requires a blockingRequirement of this same accepted work. For acceptance of the result or authorization of separate next work, use waiting/review or complete the finished scope.');
        if (['paused', 'cancelled'].includes(args.status) && work.id !== task.workId) {
          if (!userRequest) throw new Error('只能依据当前用户的停止要求控制这项工作。');
          if (source.roomId && (!work.sources?.length || work.sources.some(item => item.roomId !== source.roomId)))
            throw new Error('请在这项工作的来源会话停止，或使用它的工作卡。');
          return compactWork(await services.stopWork(work, args.status, task));
        }
        const patch = Object.fromEntries((frontend ? ['status'] : ['goal', 'requirements', 'progress', 'status']).filter(key => args[key] !== undefined).map(key => [key, modelText(args[key])]));
        if (!frontend && args.waiting && (args.status || work.status) === 'waiting') patch.waiting = { kind: args.waiting.kind,
          question, reason: modelText(args.waiting.reason), since: new Date().toISOString(),
          ...(args.waiting.kind === 'user-input' && blockingRequirement ? { blockingRequirement } : {}),
          ...(currentOutcome ? { operationId: review.operationId, bindingId: review.bindingId, outcome: currentOutcome.kind } : {}) };
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
    tool('work_dispatch', 'Continue an existing work ONLY after request_decide saved produce/revise with workRelation=continue and its canonical workId for THIS request. Status, acceptance and returning existing files use reads/work_accept/work_deliver; never fix a refusal by relabeling a delivery request as production. New rendering, screenshots or revisions may be genuine production. Put prose in JSON strings. Detailed content and concise instruction are complementary derived guidance. The program supplies event ID/binding. Stopped work resumes only for a fresh user request.',
      object({ id: string, content: {}, ...handoffFields, correction: { type: 'boolean' } }), 'write', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        if (['paused', 'cancelled'].includes(work.status) && !userRequest) throw new Error('这项工作已停止；当前事件不包含用户新的继续要求。其他动作可以继续。');
        const decision = productionDecision(task, store);
        if (decision?.workRelation === 'new') throw new Error('This is an independent new task. Use work_create and the applicable saved project rules; do not reuse the old work merely because it shares the project or materials.');
        if (decision?.workId && decision.workId !== work.id) throw new Error('Dispatch must use the canonical continuation work selected for this request.');
        const content = await services.sources.handoff(task, args);
        const eventId = actionId(args, ctx, 'eventId'), selected = selectedWork(work);
        const grant = await authorize(decision, ctx, { relation: 'continue', work: selected, handoff: content.handoff },
          { workId: work.id, actionId: `${work.id}:${eventId}` });
        if (grant) content.stage = productionStage(grant);
        try {
          content.currentKnowledge = await services.memory.forRequest(task, services.sources.project(work));
          content.projectKnowledge = content.currentKnowledge?.projectKnowledge;
        }
        catch (error) { content.evidenceWarnings.push({ message: `Current project rules are unavailable: ${error.message}` }); }
        ctx.signal?.throwIfAborted();
        const current = services.works.get(work.id);
        if (!sameWork(selected, current)) throw new Error('工作目标或控制状态已变化；请重新读取并依据新的用户要求处理。');
        documentBoundary(current, grant);
        const receipt = await services.works.dispatch(work.id, { id: eventId, kind: frontend ? 'request' : 'event', content, productionAuthorization: grant,
          metadata: { correction: args.correction === true, resume: Boolean(grant), priority: 'foreground' } }, task);
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
        const verifyFollowUp = frontend ? async (target, dependency, waitId) => {
          const decision = productionDecision(task, store);
          if (decision?.workRelation !== 'continue' || decision.workId !== target.id)
            throw new Error('A wait that starts more work needs the current request’s continuation decision for its exact target. An observe-only wait does not start another action.');
          const grant = await authorize(decision, ctx, { relation: 'continue', work: selectedWork(target), handoff: handoff.handoff, after: dependency },
            { workId: target.id, actionId: waitId });
          documentBoundary(target, grant);
          return grant;
        } : undefined;
        return { ...await services.works.wait(work.id, { ...waiting, unresolvedTaskId, waitId: actionId(args, ctx, 'waitId'), handoff }, task, verifyFollowUp),
          acceptance: modelText(args.acceptance), evidenceWarnings: handoff.evidenceWarnings };
      }),
    tool('work_notify', 'Save and publish this work’s useful result text directly. The program supplies the original recipient, reply association and notification ID; peer FYI does not demand another reply.',
      object({ id: string, content: string, attachments: { type: 'array', maxItems: WORK_ATTACHMENTS, items: object({ id: string }, ['id']) } }), 'external', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        assertExternalReviewCurrent(task, store);
        const review = task.metadata?.externalReview;
        return services.notify({ id: work.id, notificationId: actionId(args, ctx, 'notificationId'),
          publication: review?.running ? 'progress' : 'explicit', ...(review?.running ? {resultKind:'progress'} : {}), attachments: args.attachments,
          content: modelText(args.content ?? args.message ?? args.text, work.progress) }, task, ctx);
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
  ].map(definition => definition.name === 'work_update' && review ? { ...definition,
    // Keep the declaration stable across review phases. The handler enforces live lifecycle restrictions.
    inputSchema: object({ id: string, progress: string, checkpoint: {}, next: string, constraints: string, evidence: {},
      status: { type: 'string', enum: ['waiting', 'blocked', 'completed'] },
      waiting: waitingFields }) } : definition);
}
