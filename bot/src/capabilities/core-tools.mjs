import { jsonToolResult } from './registry.mjs';
import { taskMode, compactWork, compactTask, assertExternalReviewCurrent } from './task-policy.mjs';
import { randomUUID } from 'node:crypto';
import { factTime } from '../context/fact-time.mjs';
import { HANDOFF_REFERENCES, taskSource, workExecution } from '../context/sources.mjs';
import { modelArgs, modelText, looseSchema, boundedNumber } from '../context/model-input.mjs';
import { resolveCodexTarget } from './codex-target.mjs';
import { acceptanceReply, authorizeProduction, currentProductionStage, currentUserRequest, productionDecision, productionStage, requestIntents, productionStages, sourceUnits } from './request-routing.mjs';
import { acceptanceBindings, acceptanceLinks } from './acceptance-identity.mjs';
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
function localPublications(store, work, operation, roomId, notifications = roomPublications(store, work.id, roomId)) {
  const source = operation?.authorization?.source;
  if (work.executor?.kind !== 'pi' || work.bindings?.some(item => item.type === 'codex-desktop') ||
    operation?.workId !== work.id || !roomId || source?.roomId !== roomId || !source.replyTo) return [];
  return notifications.flatMap(item => {
    if (item.roomId !== roomId || item.status !== 'delivered' ||
      item.executionEventId !== operation.id || item.replyTo !== source.replyTo || item.publication !== 'explicit' ||
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
      return attachments.length ? [{ task, messageId: receipt.id, attachments, replyTo: receipt.replyTo, publishedAt: receipt.createdAt }] : [];
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

const acceptancePublication = ({ messageId, replyTo, publishedAt, attachments, observationId, manifestOperationId }) =>
  ({ messageId, replyTo, publishedAt, observationId, manifestOperationId, attachments: attachments.map(({ id, name }) => ({ id, name })) });
const withPublications = (target, publications) => publications.length ? { ...target,
  publicationMessageIds: [...new Set(publications.map(item => item.messageId))], publications } : null;

function acceptanceTarget(store, work, roomId, notifications = store.listRecords('work-notifications').filter(item => item.workId === work.id)) {
  if (work.executor?.kind === 'pi' && !work.bindings?.some(item => item.type === 'codex-desktop')) {
    const last = work.lastTaskId && store.getTask(work.lastTaskId);
    if (work.status !== 'completed' || last?.workId !== work.id || last.status !== 'completed' ||
      !last.finishedAt || last.result?.partial || last.result?.suspended || last.metadata?.sourceType === 'external') return null;
    const { executionEventId } = workExecution(last, store);
    const operation = executionEventId && store.getRecord('work-events', executionEventId);
    if (operation?.authorization?.source?.actor !== 'user') return null;
    const publications = localPublications(store, work, operation, roomId, notifications)
      .filter(item => item.task.status === 'completed' && item.task.finishedAt && !item.task.result?.partial)
      .map(acceptancePublication);
    return withPublications({ operationId: operation.id }, publications);
  }
  const execution = externalExecution(work), outcome = work.executionOutcome;
  if (!roomId || !['waiting', 'completed'].includes(work.status) ||
    work.status === 'waiting' && !['review', 'user-input'].includes(work.waiting?.kind) ||
    !execution.startedConfirmed || !execution.externalReceived || execution.operationId !== execution.currentOperationId ||
    execution.status !== 'completed' || outcome?.kind !== 'execution-ended' || !outcome.finalConfirmed ||
    outcome.operationId !== execution.operationId || outcome.turnId !== execution.turnId) return null;

  const binding = work.bindings.find(item => item.id === execution.bindingId);
  const receipts = new Map(binding.operations?.filter(item => item.status === 'received' &&
    item.threadId === execution.threadId).map(item => [item.operationId, item]));
  let { operationId, turnId } = execution;
  const visited = new Set();
  while (receipts.get(operationId)?.verificationOnly) {
    const previous = receipts.get(operationId).precedingTurn;
    if (visited.has(operationId) || previous?.status !== 'completed' || !previous.turnId || previous.turnId === turnId || !receipts.has(previous.operationId) ||
      notifications.some(item => item.executionEventId === operationId && (item.attachments?.length ||
        store.getRecord('work-observations', item.notificationId)?.content?.evidence?.fileChangesObserved))) return null;
    visited.add(operationId);
    ({ operationId, turnId } = previous);
  }
  // A read-only verification can preserve a previously published file, but is never itself the result.
  const throughVerification = operationId !== execution.operationId;
  if (work.status === 'waiting' && work.waiting.kind === 'user-input' &&
    (!throughVerification || work.waiting.operationId !== execution.operationId || work.waiting.bindingId !== execution.bindingId ||
      work.waiting.outcome !== 'execution-ended')) return null;

  const publications = notifications.flatMap(item => {
    if (item.roomId !== roomId || item.status !== 'delivered' || item.late || !item.replyTo ||
      item.publication !== 'external' || item.executionEventId !== operationId || item.resultKind !== 'execution-ended' ||
      item.authorization?.source?.actor !== 'user' || item.authorization.source.roomId !== roomId ||
      item.authorization.source.replyTo !== item.replyTo ||
      !item.sourceRefs?.some(ref => ref.type === 'codex' && ref.operationId === operationId &&
        ref.threadId === execution.threadId && ref.turnId === turnId)) return [];
    const observation = store.getRecord('work-observations', item.notificationId);
    const observed = observation?.content;
    if (observation?.workId !== work.id || observation.taskId !== item.taskId || observation.late ||
      observed?.source !== 'codex-desktop-connector' || observed.operationId !== operationId ||
      observed.externalThreadId !== execution.threadId || observed.turnId !== turnId || observed.status !== 'completed' ||
      observed.state?.stale || !observed.final?.confirmed || observed.final.threadId !== execution.threadId || observed.final.turnId !== turnId) return [];
    return (Array.isArray(item.receipt) ? item.receipt : [item.receipt]).flatMap(receipt => {
      if (!receipt?.id || receipt.roomId !== roomId || receipt.workId !== work.id || receipt.senderId !== work.botId ||
        receipt.replyTo !== item.replyTo) return [];
      const attachments = (receipt.attachments || []).filter(attachment => attachment.id &&
        item.attachments?.some(published => published.id === attachment.id));
      if ((throughVerification || item.attachments?.length) && !attachments.length) return [];
      return [acceptancePublication({ messageId: receipt.id, replyTo: item.replyTo, publishedAt: receipt.createdAt, attachments,
        observationId: observation.id, manifestOperationId: item.manifestOperationId })];
    });
  });
  return withPublications({ operationId, turnId, threadId: execution.threadId,
    ...(throughVerification ? { throughOperationId: execution.operationId, verificationOperationIds: [...visited] } : {}) }, publications);
}

const publishedBeforeRequest = (publication, user) => Date.parse(publication.publishedAt) < Date.parse(user.roomMessageAt);
const runnableWorkIds = store => new Set(store.listUnfinishedTasks().filter(item =>
  ['accepted', 'queued', 'running'].includes(item.status)).map(item => item.workId));
const acceptanceIdentity = ['operationId', 'threadId', 'turnId', 'throughOperationId', 'verificationOperationIds'];

function requestAcceptanceBindings(services, task, user, rooms) {
  if (!user?.roomId || !rooms.includes(user.roomId) || !Number.isFinite(Date.parse(user.roomMessageAt))) return [];
  const { store } = services, byWork = new Map();
  for (const item of store.listRecords('work-notifications')) {
    if (!byWork.has(item.workId)) byWork.set(item.workId, []);
    byWork.get(item.workId).push(item);
  }
  const pending = runnableWorkIds(store), entries = new Map();
  for (const [workId, notifications] of byWork) {
    const delivered = notifications.filter(item => item.roomId === user.roomId && item.status === 'delivered' && item.executionEventId &&
      (item.publication === 'external' && item.resultKind === 'execution-ended' ||
        item.publication === 'explicit' && item.resultKind !== 'progress' && item.attachments?.length));
    if (!delivered.length) continue;
    const work = services.works.get(workId);
    if (!services.sources.canReadWorkInRooms(work, task, rooms)) continue;
    const target = !pending.has(workId) && acceptanceTarget(store, work, user.roomId, notifications);
    const current = new Map((target?.publications || []).map(item => [item.messageId, item]));
    const verifications = new Set(work.bindings?.flatMap(binding => (binding.operations || []).filter(item => item.verificationOnly &&
      item.status === 'received' && item.threadId === binding.externalThreadId).map(item => item.operationId)));
    for (const item of delivered) for (const receipt of [item.receipt].flat()) {
      if (!receipt?.id || receipt.roomId !== user.roomId || receipt.workId !== workId || receipt.senderId !== work.botId || receipt.replyTo !== item.replyTo) continue;
      const verified = item.executionEventId === target?.operationId && current.get(receipt.id);
      // Keep historical receipts as identity evidence even when the current
      // work is paused, superseded, still running, or has an unknown result.
      const publication = verified || acceptancePublication({ messageId: receipt.id, replyTo: receipt.replyTo, publishedAt: receipt.createdAt,
        manifestOperationId: item.manifestOperationId, attachments: (receipt.attachments || []).filter(attachment => attachment.id &&
          item.attachments?.some(selected => selected.id === attachment.id)) });
      if (!publishedBeforeRequest(publication, user)) continue;
      const key = JSON.stringify([workId, item.executionEventId, receipt.id]);
      if (entries.has(key) && !verified) continue;
      entries.set(key, { workId, operationId: item.executionEventId, publication, links: acceptanceLinks(receipt.content),
        verification: verifications.has(item.executionEventId) && !publication.attachments.length,
        target: verified ? target : null });
    }
  }
  return acceptanceBindings(sourceUnits(user.text), [...entries.values()], user.replyTo);
}

function acceptanceContextView(bindings, user) {
  const results = new Map();
  const units = bindings.map(({ unit, identityUnit, workId, target, publication, reason, identified }) => {
    if (!publication) return { unit, reason, ...(identified.length ? { identified } : {}) };
    const { messageId } = publication;
    results.set(messageId, { workId, operationId: target.operationId, ...target.publications.find(item => item.messageId === messageId) });
    return { unit, identityUnit, publicationMessageId: messageId, attachmentIds: publication.attachments.map(item => item.id) };
  });
  return { replyTo: user?.replyTo, units, results: [...results.values()] };
}

function acceptanceScopes(items, bindings) {
  const byUnit = new Map(bindings.map(binding => [binding.unit, binding]));
  const anchored = items.map(item => {
    const binding = byUnit.get(item.unit);
    const anchor = JSON.stringify([item.unit, item.clauseStart, binding?.workId, binding?.publication?.messageId,
      ...acceptanceIdentity.map(key => binding?.target?.[key])]);
    return { item, anchor };
  });
  // Different summaries cannot distinguish scopes of the same original approval and delivery.
  const restricted = new Set(anchored.filter(({ item }) => item.recordIn !== 'work').map(({ anchor }) => anchor));
  return anchored.map(({ item, anchor }) => item.recordIn === 'work' && restricted.has(anchor) ? { ...item, recordIn: 'unconfirmed' } : item);
}

function saveRequestAcceptances(services, user, items, before, current) {
  const { store } = services, records = [], roomOnlyAcceptances = [], unresolvedAcceptances = [], grouped = new Map();
  for (const item of items) {
    if (item.recordIn === 'room-only') {
      const { unit, scope, remainingBoundaries, publicationMessageId, recordingLimitUnits, recordingDirective } = item;
      roomOnlyAcceptances.push({ unit, scope, remainingBoundaries, publicationMessageId, recordingLimitUnits, recordingDirective });
      continue;
    }
    if (item.recordIn !== 'work') {
      const { unit, scope, remainingBoundaries } = item;
      unresolvedAcceptances.push({ unit, scope, remainingBoundaries, reason: '当前原文中这项验收的记录渠道未能确认。' });
      continue;
    }
    const prior = before.find(value => value.unit === item.unit);
    const selected = current.find(value => value.unit === item.unit);
    const same = prior?.publication && selected?.publication && selected.workId === prior.workId && selected.identityUnit === prior.identityUnit &&
      item.publicationMessageId === selected.publication.messageId && JSON.stringify(prior.publication) === JSON.stringify(selected.publication) &&
      acceptanceIdentity.every(key => JSON.stringify(prior.target[key]) === JSON.stringify(selected.target[key]));
    if (!same) {
      const { publicationMessageId, ...unresolved } = item;
      unresolvedAcceptances.push({ ...unresolved, publicationMessageId: null, reason: selected?.reason || item.reason ||
        'The exact delivery could not be confirmed at the time of recording. No other result was selected.' });
      continue;
    }
    if (!grouped.has(selected.workId)) grouped.set(selected.workId, []);
    grouped.get(selected.workId).push({ item, identityUnit: selected.identityUnit, publication: selected.publication, target: selected.target });
  }
  for (const [workId, accepted] of grouped) {
    const work = services.works.get(workId), { target } = accepted[0];
    const prior = work.acceptance;
    let saved = work;
    if (prior?.source?.acceptedMessageId !== user.acceptedMessageId || prior.operationId !== target.operationId) {
      const clauses = accepted.map(({ item, identityUnit }) => ({ unit: item.unit, userClause: item.userClause,
        clauseStart: item.clauseStart, identityUnit, scope: item.scope }));
      const scopes = key => [...new Set(accepted.map(({ item }) => item[key]).filter(Boolean))].join('\n');
      const remainingBoundaries = scopes('remainingBoundaries');
      const selected = new Map();
      for (const { publication } of accepted) {
        const attachments = [...(selected.get(publication.messageId)?.attachments || []), ...publication.attachments];
        selected.set(publication.messageId, { ...publication, attachments: [...new Map(attachments.map(item => [item.id, item])).values()] });
      }
      const publications = [...selected.values()];
      const attachmentIds = new Set(publications.flatMap(item => item.attachments.map(attachment => attachment.id)));
      const fullScope = accepted.every(({ item }) => item.fullScope) && !remainingBoundaries &&
        target.publications.every(item => item.attachments.every(attachment => attachmentIds.has(attachment.id)));
      const canCloseReview = work.status === 'waiting' && work.waiting.kind === 'review' && fullScope && !work.waiting.blockingRequirement &&
        !store.listRecords('work-waits').some(wait => wait.status === 'pending' && wait.targetWorkId === work.id);
      saved = services.works.update(work.id, { ...(canCloseReview ? { status: 'completed' } : {}), expectedRevision: work.revision,
        acceptance: { scope: scopes('scope'), remainingBoundaries, fullScope, operationId: target.operationId, turnId: target.turnId, threadId: target.threadId,
          throughOperationId: target.throughOperationId, publicationMessageIds: publications.map(item => item.messageId), publications,
          source: { type: 'room', userId: user.actor, roomId: user.roomId, messageId: user.messageId, acceptedMessageId: user.acceptedMessageId,
            replyTo: user.replyTo, clauses },
          recordedAt: new Date().toISOString() } });
    }
    const { operationId, scope, remainingBoundaries, publicationMessageIds, source, recordedAt } = saved.acceptance;
    records.push({ workId, operationId, workStatus: saved.status, scope, remainingBoundaries, publicationMessageIds,
      scopes: source.clauses?.map(clause => ({ unit: clause.unit, scope: clause.scope })), recordedAt });
  }
  return { records, roomOnlyAcceptances, unresolvedAcceptances };
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
    tool('request_decide', 'Classify the CURRENT authenticated user request before acting. Use feedback for observations or trial reports without explicit approval or a current change request; discuss for planning or a small draft in chat; status for progress; deliver for existing outputs; control for pause/stop/cancel. Use accept for explicit scoped approval of a delivered result, including a room-only acknowledgment or a status question. Use produce/revise for an independently authorized action, including when the same message explicitly accepts earlier work. References to earlier approval supply context for the new action. The tool checks the original and saves only exact, confirmed current approvals whose scope permits writing to the work. When acceptanceReply is present, the runtime includes that receipt in the room reply. Answer additional requests without restating or reinterpreting that receipt. Read the saved intent and source actions before work_create/work_dispatch; the actual production proposal still requires its own check. For existing files use work_outputs and work_deliver.',
      object({ intent: { type: 'string', enum: requestIntents }, productionStage: { type: 'string', enum: productionStages,
        description: 'Classify the requested outcome. A standalone formal Markdown review document, its revision and returning the resulting file are one document-review action. Implementation means making or changing the working product, building, testing or deploying it. Other is an independent action outside both stages.' },
        workRelation: { type: 'string', enum: ['new', 'continue'] }, workId: string,
        sourceUnit: { type: 'integer', minimum: 1, description: 'Omit unless you need to choose among verified source actions. Use the exact reported unit. Retain the saved stage when finishing the same existing step.' },
        reason: string }, ['intent', 'reason']), 'write', async (args, ctx) => {
        if (!frontend || !userRequest) throw new Error('Request decisions belong to the current authenticated frontend user request.');
        if (!requestIntents.includes(args.intent)) throw new Error('Choose a supported request intent.');
        if (['produce', 'revise'].includes(args.intent) && !productionStages.includes(args.productionStage)) throw new Error('Production requires its actual stage.');
        let intent = args.intent, production = ['produce', 'revise'].includes(intent);
        if (production && args.sourceUnit !== undefined && (!Number.isSafeInteger(args.sourceUnit) || args.sourceUnit < 1))
          throw new Error('The original action unit must be a positive integer for production.');
        if (production && !['new', 'continue'].includes(args.workRelation)) throw new Error('Decide whether this is an independent new task or a continuation of an existing deliverable. Use workRelation=new or continue; continue also needs its canonical workId.');
        const work = production && args.workRelation === 'continue' ? await services.sources.requireWork(args.workId, task) : null;
        const previous = store.getRecord('request-routing', task.id);
        const messageId = source.replyTo || source.messageId;
        let confirmedFeedback = previous?.confirmedFeedback === true;
        const user = currentUserRequest(task, store);
        // Room retries create new task and accepted-message IDs for the same original message.
        const acceptanceId = user && `acceptance:${JSON.stringify([user.actor, user.roomId, user.messageId])}`;
        const readAcceptance = () => acceptanceId && store.getRecord('production-sources', acceptanceId);
        let acceptance = readAcceptance();
        let classification, acceptanceContext, bindingSnapshot = [];
        const checkProduction = production && !confirmedFeedback;
        const processAcceptance = checkProduction || intent === 'accept';
        if (checkProduction || intent === 'accept' && !acceptance) {
          const selected = work && selectedWork(work);
          if (!acceptance) {
            try {
              const rooms = user?.roomId ? await services.sources.rooms(task) : [];
              bindingSnapshot = requestAcceptanceBindings(services, task, user, rooms);
              acceptanceContext = acceptanceContextView(bindingSnapshot, user);
            } catch { acceptanceContext = { units: [], results: [], unavailable: true }; }
          }
          classification = await authorizeProduction({ task, store,
            decision: { messageId, roomId: source.roomId, ...(production ? {
              productionStage: args.productionStage, workRelation: args.workRelation, sourceUnit: args.sourceUnit,
            } : {}) }, proposed: { work: selected || undefined },
            verify: ctx.verifyProduction, signal: ctx.signal, isTargetCurrent: selected ? () => sameWork(selected, services.works.get(work.id)) : undefined,
            sourceOnly: true, savedDecision: previous ?? null, acceptanceContext,
            acceptanceMode: acceptance ? undefined : intent === 'accept' ? 'required' : 'candidate' });
        }
        // Freeze positive, negative and unresolved decisions for the original message before refreshing permissions.
        const approval = classification?.approval;
        if (!acceptance && approval) {
          const approvals = acceptanceScopes(approval.acceptances, bindingSnapshot);
          const bindings = bindingSnapshot.filter(binding => binding.publication && approvals.some(item => item.recordIn === 'work' &&
            item.unit === binding.unit && item.publicationMessageId === binding.publication.messageId));
          acceptance = store.transaction(() => readAcceptance() || store.putRecord('production-sources', {
            id: acceptanceId, acceptedMessageId: user.acceptedMessageId, roomId: user.roomId, messageId: user.messageId,
            approvals, bindings, acknowledgmentOnly: approval.acknowledgmentOnly, issue: approval.issue,
            unconfirmed: approval.acceptanceUnconfirmed ||
              approvals.some(item => item.recordIn === 'unconfirmed' || item.recordIn === 'work' && acceptanceContext?.unavailable),
          }));
        }
        const canRecord = processAcceptance && !acceptance?.receipt && acceptance?.bindings.length > 0;
        const rooms = canRecord ? await services.sources.rooms(task).catch(() => []) : [];
        ctx.signal?.throwIfAborted();
        if ((classification || acceptance) && (store.getTask(task.id)?.cancelRequested ||
          JSON.stringify(currentUserRequest(task, store)) !== JSON.stringify(user) ||
          JSON.stringify(store.getRecord('request-routing', task.id)) !== JSON.stringify(previous)))
          throw new Error('The authenticated source changed before its decision could be saved.');
        confirmedFeedback ||= classification?.feedback === true && !acceptance?.approvals.length && !acceptance?.unconfirmed;
        const sourceActions = classification?.actions;
        if (production && (confirmedFeedback || !sourceActions?.length)) {
          production = false;
          intent = acceptance?.approvals.length || acceptance?.unconfirmed || previous?.acceptances?.length ? 'accept' :
            confirmedFeedback ? 'feedback' : classification?.deliveryUnits.length ? 'deliver' : 'discuss';
        }
        // Persist the actual acceptance outcomes with the routing decision, before any separate dispatch.
        const decision = store.transaction(() => {
          let receipt = readAcceptance()?.receipt;
          if (processAcceptance && acceptance && !receipt) {
            let current = [], unavailable = false;
            if (canRecord) try { current = requestAcceptanceBindings(services, task, user, rooms); }
            catch { unavailable = true; }
            const { records, roomOnlyAcceptances, unresolvedAcceptances } =
              saveRequestAcceptances(services, user, acceptance.approvals, acceptance.bindings, current);
            receipt = { taskId: task.id, acceptances: records, roomOnlyAcceptances, unresolvedAcceptances,
              acceptanceUnconfirmed: acceptance.unconfirmed || unavailable };
            store.putRecord('production-sources', { ...acceptance, receipt });
          }
          const acceptances = [...new Map([...(previous?.acceptances || []), ...(receipt?.acceptances || [])]
            .map(item => [item.workId, item])).values()];
          return store.putRecord('request-routing', { id: task.id, messageId, roomId: source.roomId, acceptances,
            acceptanceReceiptTaskId: receipt?.taskId ?? previous?.acceptanceReceiptTaskId,
            acceptanceAcknowledgmentOnly: acceptance?.acknowledgmentOnly ?? previous?.acceptanceAcknowledgmentOnly,
            roomOnlyAcceptances: receipt?.roomOnlyAcceptances ?? previous?.roomOnlyAcceptances ?? [],
            unresolvedAcceptances: receipt?.unresolvedAcceptances ?? previous?.unresolvedAcceptances ?? [],
            acceptanceUnconfirmed: receipt?.acceptanceUnconfirmed ?? previous?.acceptanceUnconfirmed,
            acceptanceIssue: acceptance?.issue ?? previous?.acceptanceIssue,
            intent, productionStage: production ? args.productionStage : null, confirmedFeedback,
            existingDelivery: previous?.existingDelivery === true || intent === 'deliver',
            sourceUnit: production ? classification?.resolvedSourceUnit ?? args.sourceUnit : null,
            ...(production && classification?.resolvedSourceUnit !== undefined ? { sourceUnitInferred: true } : {}),
            workRelation: production ? args.workRelation : null, workId: production && args.workRelation === 'continue' ? args.workId : null,
            reason: intent !== args.intent ? 'The authenticated source contains no independent production action.' : modelText(args.reason), authority: 'model-routing-decision' });
        });
        const reply = acceptanceReply(decision, user?.text);
        const result = reply ? { ...decision, acceptanceReply: reply } : decision;
        if (intent !== args.intent) return { ...result, instruction: 'Follow the saved intent and respond to the original message. Do not call work_create or work_dispatch for this source classification.' };
        return sourceActions?.length ? { ...result, sourceActions,
          instruction: 'For a separately authorized production action, use the matching production decision and submit its exact proposal. Correct an actual routing mismatch once.' } : result;
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
    tool('request_actions', 'Read saved action and acceptance receipts for an original message in this conversation (messageId defaults to the current trigger). Use these receipts to distinguish an actual work write, a room-only scope, and an unconfirmed scope. History is not permission to repeat an action.',
      object({ messageId: string }), 'read', args => {
        const messageId = args.messageId || source.replyTo || source.messageId;
        return store.listTasks({ limit: 10000 }).filter(item => item.conversationId === task.conversationId &&
          [taskSource(item, store).replyTo, item.messageId].includes(messageId)).map(item => {
          const routing = store.getRecord('request-routing', item.id);
          const acceptanceReceipt = routing?.roomId && routing.roomId === source.roomId && routing.messageId === messageId ? {
            messageId: routing.messageId, receiptTaskId: routing.acceptanceReceiptTaskId,
            acceptances: routing.acceptances, roomOnlyAcceptances: routing.roomOnlyAcceptances,
            unresolvedAcceptances: routing.unresolvedAcceptances, acceptanceUnconfirmed: routing.acceptanceUnconfirmed,
            issue: routing.acceptanceIssue } : undefined;
          return { taskId: item.id, messageId, status: item.status, acceptanceReceipt,
            actions: store.listTools(item.id).filter(record => record.effect !== 'read').map(record => {
              const receipt = record.output?.details || {};
              return { actionId: record.id, tool: record.name, status: record.status, id: receipt.id, workId: receipt.workId,
                taskId: receipt.taskId, operationId: receipt.operationId,
                execution: receipt.workId && services.works.get(receipt.workId) ? externalExecution(services.works.get(receipt.workId), receipt.operationId) : receipt.execution,
                savedExecution: receipt.execution, receiptLayer: receipt.receiptLayer,
                waitId: receipt.waitId, accepted: receipt.accepted, savedStatus: receipt.status, recordedAt: record.finishedAt, dueAt: receipt.dueAt,
                ...(receipt.workId && services.works.get(receipt.workId) ? { workStatus: services.works.get(receipt.workId).status } : {}) };
            }) };
        });
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
    tool('work_dispatch', 'Continue an existing work ONLY after request_decide saved produce/revise with workRelation=continue and its canonical workId for THIS request. Status uses reads, acceptance uses request_decide, and returning existing files uses work_deliver. Never fix a refusal by relabeling a delivery request as production. New rendering, screenshots or revisions may be genuine production. Put prose in JSON strings. Detailed content and concise instruction are complementary derived guidance. The program supplies event ID/binding. Stopped work resumes only for a fresh user request.',
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
