import { jsonToolResult } from './registry.mjs';
import { taskMode, compactWork, compactTask } from './task-policy.mjs';
import { randomUUID } from 'node:crypto';
import { factTime } from '../context/fact-time.mjs';
import { HANDOFF_REFERENCES, taskSource, workExecution } from '../context/sources.mjs';
import { modelArgs, modelText, looseSchema, boundedNumber } from '../context/model-input.mjs';
import { acceptanceActionScope, acceptanceReply, authorizeProduction, currentProductionStage, currentUserRequest, productionDecision, productionRefusal, productionStage, requestIntents, productionStages, selectedSourceAction, sourceUnits } from './request-routing.mjs';
import { EXISTING_PUBLICATION, OWNER_DELIVERY, ROOM_DUTY_PLANS, dependencyDispatches, publishedReviewTarget, roomDutyPlanId, saveRoomDutyPlan, sourceDispatches } from '../context/duty-actions.mjs';
import { acceptanceBindings, acceptanceLinks, naturalAcceptanceMatch, sameRoomResultAcceptance } from './acceptance-identity.mjs';
import { localTime } from '../context/fact-time.mjs';
import { externalExecution, HISTORICAL_WORK_DELIVERIES } from '../context/execution-evidence.mjs';
import { readExecutorManifest } from '../runtime/executor-delivery.mjs';
import { deliveredLocalFiles, localPathKey } from '../runtime/local-delivery.mjs';
import { MESSAGE_ATTACHMENTS, WORK_ATTACHMENTS } from '../runtime/notifications.mjs';
import { verifiedProductionRecovery } from './production-recovery.mjs';
import { earlierFileSources, sourceFileScopes } from './file-access.mjs';
import { pathWithin, resolveFilePath, samePath } from './file-policy.mjs';

const string = { type: 'string' };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const flexible = name => name.startsWith('work') || ['evidence_read', 'tasks_get', 'tasks_list', 'messages_send'].includes(name);
const tool = (name, description, inputSchema, effect, execute) => ({ name, description, inputSchema: flexible(name) ? looseSchema(inputSchema) : inputSchema, effect,
  execute: async (args, context) => jsonToolResult(await execute(modelArgs(args), context)) });
const pageFields = { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } };
const reference = object({ type: { type: 'string', enum: ['room', 'session', 'artifact', 'knowledge', 'work', 'tool'] }, roomId: string, scopeId: string, workId: string, operationId: string,
  messageId: string, attachmentId: { type: 'string', description: 'For a room attachment page, use the exact attachmentId from chatroom_read, not an executor artifact ID.' },
  sessionId: string, entryId: string, id: string, section: { type: 'string', enum: ['acceptedStep', 'evidenceItem', 'toolContent'] },
  index: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 64000 } }, ['type']);
const evidence = { type: 'array', maxItems: HANDOFF_REFERENCES, items: reference,
  description: 'Select exact references from source reads. For published text, pass the room page reference returned by chatroom_read, including roomId, original messageId, attachmentId, offset and length for each selected page. Pass the array itself; a JSON array string is also readable. Prose is guidance, not a source grant.' };
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
  const history = store.getRecord(HISTORICAL_WORK_DELIVERIES, work.id), execution = history?.final, outcome = work.executionOutcome;
  const originalDelivery = execution && history.botId === work.botId && work.bindings?.some(item => item.id === history.bindingId && item.type === 'native-recovery') &&
    outcome?.kind === 'execution-ended' && outcome.finalConfirmed && outcome.operationId === execution.operationId && outcome.turnId === execution.turnId &&
    (!work.waiting?.operationId || work.waiting.operationId === execution.operationId);
  if (!originalDelivery) {
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
  if (!roomId || !['waiting', 'completed'].includes(work.status) ||
    work.status === 'waiting' && !['review', 'user-input'].includes(work.waiting?.kind)) return null;

  const receipts = new Map(history.receipts.map(item => [item.operationId, item]));
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
    (!throughVerification || work.waiting.operationId !== execution.operationId || work.waiting.bindingId !== history.bindingId ||
      work.waiting.outcome !== 'execution-ended')) return null;

  const publications = notifications.flatMap(item => {
    if (item.roomId !== roomId || item.status !== 'delivered' || item.late || !item.replyTo ||
      item.publication !== 'external' || item.executionEventId !== operationId || item.resultKind !== 'execution-ended' ||
      item.authorization?.source?.actor !== 'user' || item.authorization.source.roomId !== roomId ||
      item.authorization.source.replyTo !== item.replyTo ||
      !item.sourceRefs?.some(ref => ref.type === history.source.referenceType && ref.operationId === operationId &&
        ref.threadId === execution.threadId && ref.turnId === turnId)) return [];
    const observation = store.getRecord('work-observations', item.notificationId);
    const observed = observation?.content;
    if (observation?.workId !== work.id || observation.taskId !== item.taskId || observation.late ||
      observed?.source !== history.source.observationSource || observed.operationId !== operationId ||
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
const normalizeQuestion = value => String(value || '').trim().replace(/\s+/g, ' ');


const runnableWorkIds = store => new Set(store.listUnfinishedTasks().filter(item =>
  ['accepted', 'queued', 'running'].includes(item.status)).map(item => item.workId));
const acceptanceIdentity = ['operationId', 'threadId', 'turnId', 'throughOperationId', 'verificationOperationIds',
  'roomResultId', 'ownerBotId', 'dutyKey', 'deliveryId', 'taskId', 'sourceMessageId', 'version'];

function packageReplyReads(store, user, replies = []) {
  return replies.flatMap(reply => {
    const task = store.getTask(reply.taskId), request = task && currentUserRequest(task, store);
    const accepted = request && store.getMessage(request.acceptedMessageId);
    if (task?.status !== 'completed' || task.cancelRequested || task.result?.partial || task.result?.suspended ||
        request?.actor !== user.actor || request.roomId !== user.roomId || request.messageId !== reply.requestMessageId ||
        request.roomMessageAt !== reply.requestedAt || accepted?.sourceMessageId !== reply.jobId ||
        accepted.content?.metadata?.deliveryId !== reply.jobId) return [];
    const reads = store.listTools(task.id).filter(tool => tool.status === 'completed' && tool.effect === 'read');
    const outputs = reads.filter(tool => tool.name === 'work_outputs').map(tool => tool.output?.details).filter(Boolean);
    if (!outputs.length) return [];
    const files = reads.filter(tool => tool.name === 'list_files').flatMap(tool => tool.output?.details?.entries || []);
    const packages = reply.packages.filter(file => files.some(item => item.type === 'file' && typeof item.path === 'string' &&
      localPathKey(item.path) === localPathKey(file.path) && item.size === file.size));
    return packages.length ? [{ ...reply, packages, outputs, requestReplyTo: request.replyTo }] : [];
  });
}

async function requestAcceptanceBindings(services, task, user, rooms, page, { excluded = [], sharedScopeUnits = [] } = {}) {
  if (!user?.roomId || !rooms.includes(user.roomId) || !Number.isFinite(Date.parse(user.roomMessageAt))) return { bindings: [], entries: [] };
  const { store } = services, byWork = new Map();
  const packageReplies = packageReplyReads(store, user, page.roomPackageReplies);
  for (const item of store.listRecords('work-notifications')) {
    if (!byWork.has(item.workId)) byWork.set(item.workId, []);
    byWork.get(item.workId).push(item);
  }
  const pending = runnableWorkIds(store), entries = new Map(), localReads = [];
  for (const [workId, notifications] of byWork) {
    const delivered = notifications.filter(item => item.roomId === user.roomId && item.status === 'delivered' && item.executionEventId &&
      (item.publication === 'external' && item.resultKind === 'execution-ended' ||
        item.publication === 'explicit' && item.resultKind !== 'progress' && item.attachments?.length));
    if (!delivered.length) continue;
    const work = services.works.get(workId);
    if (!services.sources.canReadWorkInRooms(work, task, rooms)) continue;
    const target = !pending.has(workId) && acceptanceTarget(store, work, user.roomId, notifications);
    if (target) target.workRevision = work.revision;
    const current = new Map((target?.publications || []).map(item => [item.messageId, item]));
    const history = store.getRecord(HISTORICAL_WORK_DELIVERIES, workId);
    const verifications = new Set(history?.receipts.filter(item => item.verificationOnly).map(item => item.operationId));
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
      if (item.publication === 'external') localReads.push(deliveredLocalFiles({ store, workspace: services.workspace, task, work,
        notification: item, receipt, requestText: user.text, packageReplies }).then(files => {
        if (files.length) publication.localFiles = files;
      }));
      entries.set(key, { workId, senderId: work.botId, operationId: item.executionEventId, publication, links: acceptanceLinks(receipt.content),
        identityText: [localTime(publication.publishedAt), work.goal, receipt.content, ...publication.attachments.map(item => item.name)].filter(Boolean).join('\n').slice(0, 3800),
        previouslyAccepted: work.acceptance?.source?.roomId === user.roomId && work.acceptance.operationId === item.executionEventId &&
          work.acceptance.publicationMessageIds?.includes(publication.messageId) ? { sourceMessageId: work.acceptance.source.messageId,
            scope: work.acceptance.scope, remainingBoundaries: work.acceptance.remainingBoundaries } : undefined,
        verification: verifications.has(item.executionEventId) && !publication.attachments.length,
        target: verified ? target : null });
    }
  }
  for (const result of page.roomResults || []) {
    if (result.roomId !== user.roomId || !result.id || result.version !== result.id || !result.dutyKey || !result.taskId ||
        !result.ownerBotId || !result.sourceMessageId || !result.deliveryId) continue;
    const publication = { messageId: result.id, replyTo: result.sourceMessageId, publishedAt: result.publishedAt, attachments: [] };
    if (!publishedBeforeRequest(publication, user)) continue;
    const target = { operationId: result.version, roomResultId: result.id, ownerBotId: result.ownerBotId, dutyKey: result.dutyKey,
      taskId: result.taskId, sourceMessageId: result.sourceMessageId, deliveryId: result.deliveryId, version: result.version, publications: [publication] };
    entries.set(result.id, { operationId: result.version, publication, links: acceptanceLinks(result.content), target,
      identityText: [localTime(result.publishedAt), result.content].filter(Boolean).join('\n'),
      ...(result.legacyCandidate ? { legacyCandidate: true, originalRequest: result.originalRequest } : {}) });
  }
  await Promise.all(localReads);
  const currentPending = runnableWorkIds(store);
  for (const entry of entries.values()) if (entry.workId && entry.target &&
    (currentPending.has(entry.workId) || entry.target.workRevision !== services.works.get(entry.workId)?.revision)) entry.target = null;
  const values = [...entries.values()];
  const roomResultsAvailable = page.unavailable !== true;
  const { attachmentPublications, roomWorkPublications } = page;
  return { bindings: acceptanceBindings(sourceUnits(user.text), values, user.replyTo, {
    excluded, sharedScopeUnits, attachmentPublications, roomWorkPublications, roomResultsAvailable }),
    entries: values, excluded, sharedScopeUnits, attachmentPublications, roomWorkPublications,
    roomResultsAvailable, roomResultsComplete: page.roomResultsComplete === true };
}

const acceptanceCandidate = entry => ({ ...entry.publication, workId: entry.workId, operationId: entry.target?.operationId,
  identityText: entry.identityText, previouslyAccepted: entry.previouslyAccepted,
  ...(entry.publication.localFiles?.length ? { localFiles: entry.publication.localFiles.map(({ path, name, size }) => ({ path, name, size })) } : {}),
  ...(entry.target?.roomResultId ? { ownerBotId: entry.target.ownerBotId, dutyKey: entry.target.dutyKey } : {}),
  ...(entry.legacyCandidate ? { legacyCandidate: true, originalRequest: entry.originalRequest } : {}) });

function acceptanceContextView({ bindings, entries, roomResultsComplete }, user) {
  const results = new Map();
  const candidates = entries.filter(entry => entry.target && !entry.verification);
  const units = bindings.map(({ unit, identityUnits, sharedIdentityUnits, target, publication, reason, identified, allowNatural, clockTimes, contentLabels }) => {
    if (!publication) return { unit, reason, allowNatural: allowNatural && (roomResultsComplete || Boolean(clockTimes?.length)), clockTimes, contentLabels,
      ...(identified?.length ? { identified } : {}) };
    const { messageId } = publication;
    const selected = candidates.find(entry => entry.publication.messageId === messageId && entry.target.operationId === target.operationId);
    if (selected) results.set(messageId, acceptanceCandidate(selected));
    return { unit, identityUnits, ...(sharedIdentityUnits?.length ? { sharedIdentityUnits } : {}),
      publicationMessageId: messageId, attachmentIds: publication.attachments.map(item => item.id),
      ...(publication.localFiles?.length ? { localFiles: publication.localFiles.map(({ path, name, size }) => ({ path, name, size })) } : {}) };
  });
  const naturalCandidates = units.some(unit => unit.allowNatural) ? candidates.filter(entry => !entry.publication.localFiles?.length).sort((a, b) =>
    String(a.publication.publishedAt).localeCompare(String(b.publication.publishedAt))).slice(-18).map(acceptanceCandidate) : [];
  return { replyTo: user?.replyTo, units, results: [...results.values()], naturalCandidates };
}

function selectedAcceptanceBindings(snapshot, approvals, user) {
  const units = sourceUnits(user.text);
  const approvalUnits = approvals.map(item => item.unit);
  return approvals.map(approval => {
    const { unit, publicationMessageId, naturalIdentity } = approval;
    const initial = snapshot.bindings.find(binding => binding.unit === unit && binding.publication?.messageId === publicationMessageId);
    const [binding] = acceptanceBindings(units, snapshot.entries, user.replyTo, { excluded: snapshot.excluded,
      sharedScopeUnits: snapshot.sharedScopeUnits, attachmentPublications: snapshot.attachmentPublications,
      roomWorkPublications: snapshot.roomWorkPublications, approvalUnits,
      approval: initial ? { ...approval, identityUnits: initial.identityUnits } : approval,
      roomResultsAvailable: snapshot.roomResultsAvailable });
    if (!binding || !publicationMessageId || !naturalIdentity || !binding.allowNatural ||
        !snapshot.roomResultsComplete && !binding.clockTimes?.length) return binding || { unit };
    const matched = naturalAcceptanceMatch({ units, identityUnits: naturalIdentity.units, anchors: naturalIdentity.anchors,
      candidates: snapshot.entries.filter(entry => !entry.verification).map(acceptanceCandidate), clockTimes: binding.clockTimes,
      contentLabels: binding.contentLabels });
    if (matched?.messageId !== publicationMessageId) return binding;
    const entry = snapshot.entries.find(item => item.target && item.target.operationId === matched.operationId && item.publication.messageId === matched.messageId);
    return entry ? { unit, identityUnit: naturalIdentity.units[0], identityUnits: naturalIdentity.units, workId: entry.workId,
      target: entry.target, publication: entry.publication } : binding;
  });
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

function priorRoomAcceptanceUser(store, record, actor) {
  if (record.userId) return record.userId;
  const id = `acceptance:${JSON.stringify([actor, record.roomId, record.userMessageId])}`;
  for (const key of [id, id + ':delivered-result-identity', id + ':standalone-delivery-version']) {
    const source = store.getRecord('production-sources', key), taskId = source?.receipt?.taskId;
    if (!source?.receipt?.roomResultAcceptances?.some(item => item.id === record.id && !item.alreadyRecorded)) continue;
    const task = taskId && store.getTask(taskId), original = task && currentUserRequest(task, store);
    if (original && original.acceptedMessageId === source.acceptedMessageId && original.roomId === record.roomId &&
        original.messageId === record.userMessageId) return original.actor;
  }
}

function saveRequestAcceptances(services, user, items, before, current) {
  const { store } = services, records = [], roomResultAcceptances = [], roomOnlyAcceptances = [], unresolvedAcceptances = [],
    grouped = new Map(), groupedRoomResults = new Map();
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
    const same = prior?.publication && selected?.publication && selected.workId === prior.workId &&
      JSON.stringify(prior.identityUnits) === JSON.stringify(selected.identityUnits) &&
      item.publicationMessageId === selected.publication.messageId && JSON.stringify(prior.publication) === JSON.stringify(selected.publication) &&
      (!selected.workId || selected.target.workRevision === services.works.get(selected.workId)?.revision) &&
      acceptanceIdentity.every(key => JSON.stringify(prior.target[key]) === JSON.stringify(selected.target[key]));
    if (!same) {
      const { publicationMessageId, ...unresolved } = item;
      unresolvedAcceptances.push({ ...unresolved, publicationMessageId: null, reason: selected?.reason || item.reason ||
        'The exact delivery could not be confirmed at the time of recording. No other result was selected.' });
      continue;
    }
    if (selected.target.roomResultId) {
      if (item.recordingKind === 'work') {
        unresolvedAcceptances.push({ ...item, reason: '这条群内文字是独立的职责交付，没有可写入的工作卡。' });
        continue;
      }
      const group = groupedRoomResults.get(selected.target.roomResultId) || { target: selected.target, approvals: [] };
      group.approvals.push(item);
      groupedRoomResults.set(selected.target.roomResultId, group);
      continue;
    }
    if (!grouped.has(selected.workId)) grouped.set(selected.workId, []);
    grouped.get(selected.workId).push({ item, identityUnit: selected.identityUnit, publication: selected.publication, target: selected.target });
  }
  for (const [workId, accepted] of grouped) {
    const work = services.works.get(workId), { target } = accepted[0];
    const prior = work.acceptance;
    let saved = work;
    let alreadyRecorded = prior?.source?.acceptedMessageId === user.acceptedMessageId && prior.operationId === target.operationId;
    if (!alreadyRecorded) {
      const clauses = accepted.map(({ item, identityUnit }) => ({ unit: item.unit, userClause: item.userClause,
        clauseStart: item.clauseStart, identityUnit, scope: item.scope }));
      const scopes = key => [...new Set(accepted.map(({ item }) => item[key]).filter(Boolean))].join('\n');
      const remainingBoundaries = scopes('remainingBoundaries');
      const selected = new Map();
      for (const { publication } of accepted) {
        const earlier = selected.get(publication.messageId);
        const attachments = [...(earlier?.attachments || []), ...publication.attachments];
        const localFiles = [...(earlier?.localFiles || []), ...(publication.localFiles || [])];
        selected.set(publication.messageId, { ...publication, attachments: [...new Map(attachments.map(item => [item.id, item])).values()],
          ...(localFiles.length ? { localFiles: [...new Map(localFiles.map(file => [file.path, file])).values()] } : {}) });
      }
      const publications = [...selected.values()];
      const attachmentIds = new Set(publications.flatMap(item => item.attachments.map(attachment => attachment.id)));
      const fullScope = accepted.every(({ item }) => item.fullScope) && !remainingBoundaries &&
        target.publications.every(item => item.attachments.every(attachment => attachmentIds.has(attachment.id)) &&
          (item.localFiles || []).every(file => selected.get(item.messageId)?.localFiles?.some(acceptedFile => acceptedFile.path === file.path)));
      const scope = scopes('scope');
      const publicationMessageIds = publications.map(item => item.messageId);
      alreadyRecorded = prior?.source?.roomId === user.roomId && prior.operationId === target.operationId && prior.scope === scope &&
        prior.remainingBoundaries === remainingBoundaries && prior.fullScope === fullScope &&
        JSON.stringify(prior.publications) === JSON.stringify(publications);
      const canCloseReview = work.status === 'waiting' && work.waiting.kind === 'review' && fullScope && !work.waiting.blockingRequirement &&
        !store.listRecords('work-waits').some(wait => wait.status === 'pending' && wait.targetWorkId === work.id);
      if (!alreadyRecorded) saved = services.works.update(work.id, { ...(canCloseReview ? { status: 'completed' } : {}), expectedRevision: work.revision,
        acceptance: { scope, remainingBoundaries, fullScope, operationId: target.operationId, turnId: target.turnId, threadId: target.threadId,
          throughOperationId: target.throughOperationId, publicationMessageIds, publications,
          source: { type: 'room', userId: user.actor, roomId: user.roomId, messageId: user.messageId, acceptedMessageId: user.acceptedMessageId,
            replyTo: user.replyTo, clauses },
          recordedAt: new Date().toISOString() } });
    }
    const { operationId, scope, remainingBoundaries, publicationMessageIds, source, recordedAt } = saved.acceptance;
    records.push({ workId, operationId, workStatus: saved.status, scope, remainingBoundaries, publicationMessageIds, alreadyRecorded,
      scopes: source.clauses?.map(clause => ({ unit: clause.unit, scope: clause.scope })), recordedAt });
  }
  for (const { target, approvals } of groupedRoomResults.values()) {
    const id = JSON.stringify([user.roomId, user.messageId, target.version]);
    const joined = field => [...new Set(approvals.map(item => item[field]).filter(Boolean))].join('\n');
    const remainingBoundaries = joined('remainingBoundaries');
    const approval = {
      id, roomId: user.roomId, userMessageId: user.messageId, userId: user.actor, acceptedMessageId: user.acceptedMessageId,
      approvalTaskId: user.taskId, publicationMessageId: target.roomResultId,
      ownerBotId: target.ownerBotId, dutyKey: target.dutyKey, sourceMessageId: target.sourceMessageId, taskId: target.taskId,
      deliveryId: target.deliveryId, version: target.version, scope: joined('scope'), remainingBoundaries,
      fullScope: approvals.every(item => item.fullScope) && !remainingBoundaries,
      legacyRoomDelivery: approvals.some(item => item.legacyRoomDelivery),
      clauses: approvals.map(({ unit, userClause, clauseStart }) => ({ unit, userClause, clauseStart })), recordedAt: new Date().toISOString(),
    };
    const existing = store.getRecord('room-result-acceptances', id);
    if (existing) { roomResultAcceptances.push(existing); continue; }
    const prior = store.listRecords('room-result-acceptances').find(record => record.roomId === user.roomId && record.version === target.version &&
      sameRoomResultAcceptance({ ...record, userId: priorRoomAcceptanceUser(store, record, user.actor) }, approval));
    roomResultAcceptances.push(prior ? { ...approval, recordedAt: prior.recordedAt, alreadyRecorded: true, recordedAcceptanceId: prior.id } :
      store.putRecord('room-result-acceptances', approval));
  }
  return { records, roomResultAcceptances, roomOnlyAcceptances, unresolvedAcceptances };
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
  const authorize = (decision, ctx, proposed, { workId, actionId, scopeEvidence }) => {
    const fileScopeSources = proposed.relation === 'new' && !proposed.after ?
      earlierFileSources(task, store, scopeEvidence || []) : [];
    return authorizeProduction({ task, store, decision,
      proposed: { ...proposed, ...(fileScopeSources.length ? { fileScopeSources } : {}) },
      workId, actionId, verify: (input, signal) => ctx.verifyProduction({ ...input, scopeEvidence }, signal), signal: ctx.signal,
      isTargetCurrent: proposed.work ? () => sameWork(proposed.work, services.works.get(workId)) : undefined });
  };
  const roomMaterials = content => {
    const readAttachments = store.listTools(task.id).flatMap(tool => tool.status === 'completed' &&
      ['chatroom_read', 'evidence_read'].includes(tool.name) && tool.output?.details?.reference?.attachmentId ? [tool.output.details] : []);
    return [...new Map([...readAttachments, ...content.evidence]
      .filter(item => item.reference?.type === 'room' && item.reference.roomId === source.roomId)
      .map(item => [JSON.stringify([item.reference.messageId, item.reference.attachmentId]), item])).values()];
  };
  const readSelectedPublications = async content => {
    const alreadyRead = roomMaterials(content).filter(item => item.reference.attachmentId && !item.offset);
    const selected = content.evidence.filter(item => item.reference?.type === 'room' && item.reference.roomId === source.roomId &&
      !item.reference.attachmentId && item.reference.messageId !== source.replyTo);
    const candidates = selected.flatMap(item => (item.attachments || []).flatMap(attachment =>
      /\.(?:md|txt|csv|tsv|json|html?|docx)$/i.test(attachment.name) && attachment.origin?.type === 'work-output' &&
      attachment.origin.roomId === source.roomId && attachment.origin.botId === item.author ?
        [{ type: 'room', roomId: source.roomId, messageId: item.reference.messageId, attachmentId: attachment.id }] : []));
    for (const ref of candidates.slice(0, Math.min(6, HANDOFF_REFERENCES - content.evidence.length))) {
      const existing = alreadyRead.find(item => item.reference.messageId === ref.messageId && item.reference.attachmentId === ref.attachmentId);
      if (content.evidence.some(item => item.reference?.messageId === ref.messageId && item.reference.attachmentId === ref.attachmentId)) continue;
      try { content.evidence.push(existing || await services.sources.resolve(ref, task)); }
      catch (error) { content.evidenceWarnings.push({ reference: ref, message: error.message }); }
    }
  };
  const proposalMaterials = content => roomMaterials(content).slice(0, 6).map(item => ({ reference: item.reference, author: item.author,
    content: typeof item.content === 'string' ? item.content.slice(0, 2400) : undefined }));
  const proposalHandoff = handoff => Object.fromEntries(['instruction', 'content', 'message', 'handoff'].filter(key => handoff[key])
    .map(key => [key, handoff[key]]));
  const planReceipt = plan => ({ planId: plan.id, status: plan.kind !== 'independent-review' ? 'awaiting-owner-delivery' :
    plan.dependency?.condition === EXISTING_PUBLICATION ? 'waiting-for-independent-owner' : 'waiting-for-publication',
    registered: true, receiptLayer: 'room-duty-plan', sourceUnit: plan.grant.sourceUnit,
    ...(plan.workId ? { workId: plan.workId, operationId: plan.operationId } : {}),
    ...(plan.dependency?.operationId ? { dependencyOperationId: plan.dependency.operationId } : {}),
    ...(plan.duplicate ? { duplicate: true } : {}),
    instruction: 'The original action and prerequisites are saved. A responsibility record or this receipt does not mean that a Bot has run or published the result.' });
  const dutyContext = async content => {
    const room = source.input?.room;
    if (!userRequest || room?.kind !== 'group' || !room.team || !source.roomId) throw new Error('A room duty action requires a current authenticated project group request.');
    return roomMaterials(content).slice(0, 16).map(item => ({ ...item.reference }));
  };
  const dutyProposal = (dutyKey, independent, room = source.input?.room, allowSelf = false) => {
    if (!dutyKey) return undefined;
    const duty = room?.team?.duties?.find(item => item.dutyKey === dutyKey && item.state === 'active' &&
      room.members.includes(item.botId) && (allowSelf || item.botId !== services.works.botId) && item.botId !== room.team.eggBotId &&
      Boolean(item.dutyProfile?.independentReview) === independent);
    if (!duty) throw new Error('Choose the currently assigned duty for this part, or omit dutyKey so the project can resolve its owner.');
    return { botId: duty.botId, responsibility: duty.responsibility, boundary: duty.dutyProfile?.boundary, assignedAt: duty.assignedAt };
  };
  const currentDutyRoom = async () => {
    const originalRoom = source.input?.room;
    const rooms = await services.sources.callForSource('chatroom_list', { roomId: source.roomId }, task);
    const room = rooms.find(item => item.id === source.roomId);
    if (room?.kind !== 'group' || room.status !== 'active' || room.projectMode === 'chat' ||
        !['idle', 'active'].includes(room.team?.state) || room.goal !== originalRoom?.goal ||
        room.team.requirements !== originalRoom?.team?.requirements)
      throw new Error('The original project group is unavailable or its scope has changed.');
    return room;
  };
  const ownerPrerequisite = async ({ decision, action, participant, duty, workId, operationId, projectId, work }) => {
    const user = currentUserRequest(task, store), originalRoom = source.input?.room;
    const dependency = user && sourceUnits(user.text)[action.dependencyUnit - 1];
    if (!participant?.dutyKey || !duty || !dependency || dependency.unit === action.unit || originalRoom?.id !== user.roomId ||
        work && !work.sources.some(item => item.actor === user.actor && item.roomId === user.roomId))
      throw new Error('A conditional production action needs the exact original prerequisite and a currently assigned participant in its source project group.');
    const current = dutyProposal(participant.dutyKey, false, await currentDutyRoom(), !work);
    if (current.botId !== duty.botId || current.assignedAt !== duty.assignedAt)
      throw new Error('The assigned owner changed before the conditional production action was registered.');
    const planId = roomDutyPlanId({ roomId: user.roomId, messageId: user.messageId, sourceUnit: action.unit, kind: 'contribution' });
    return { condition: OWNER_DELIVERY, roomId: user.roomId, messageId: user.messageId, requestTaskId: user.taskId,
      acceptedMessageId: user.acceptedMessageId, sourceUnit: dependency.unit, originalClause: dependency.text,
      actionUnit: action.unit, stage: decision.productionStage, projectId, workId, operationId, planId,
      ownerBotId: duty.botId, ...(work ? {} : { ownerAssignedAt: duty.assignedAt }), ...participant };
  };
  const reviewPublication = async (args, content) => {
    const user = currentUserRequest(task, store);
    const selected = services.sources.references(args.evidence, task).slice(0, HANDOFF_REFERENCES)
      .map(item => services.sources.reference(item, task))
      .filter(ref => ref?.type === 'room' && ref.roomId === user.roomId && ref.attachmentId);
    const references = selected.length ? selected : roomMaterials(content).map(item => item.reference).filter(ref => ref.attachmentId);
    const explicit = modelText(args.reviewPublicationMessageId).trim();
    const groups = Map.groupBy(references, ref => ref.messageId);
    const messageId = explicit || (groups.has(user.replyTo) ? user.replyTo : groups.size === 1 ? [...groups.keys()][0] : null);
    const attachmentIds = (groups.get(messageId) || []).map(ref => ref.attachmentId);
    if (!messageId || !attachmentIds.length || selected.some(ref => ref.messageId !== messageId))
      throw new Error('Select one exact same-room publication and the specific published attachments the independent review needs.');
    const readMessage = async id => (await services.sources.callForSource('chatroom_read', { roomId: user.roomId, messageId: id }, task)).messages?.[0];
    const message = await readMessage(messageId);
    const quoted = user.replyTo && user.replyTo !== messageId && await readMessage(user.replyTo);
    const publication = publishedReviewTarget(message, user.roomId, attachmentIds);
    if (!publication || !(Date.parse(publication.publishedAt) < Date.parse(user.roomMessageAt)) || quoted?.workPublication)
      throw new Error('The selected attachments do not match the exact publication already present in this source room.');
    const original = await readMessage(publication.sourceMessageId);
    if (original?.roomId !== user.roomId || original.senderId !== user.actor)
      throw new Error('The publication’s original request is unavailable in this room.');
    return { publication, original: { reference: original.reference, author: original.senderId, content: original.content },
      publicationEvidence: { publishedAt: localTime(message.createdAt), content: message.content.slice(0, 2400),
        attachments: message.attachments.filter(file => publication.attachmentIds.includes(file.id)).map(({ id, name }) => ({ id, name })) } };
  };
  const reviewReferencePublications = async (references, publication, roomId) => {
    const selected = new Map(references.map(ref => [JSON.stringify([ref.messageId, ref.attachmentId]), ref]));
    return Promise.all([...selected.values()].map(async ({ messageId, attachmentId }) => {
      if (messageId === publication.messageId || publication.attachmentIds.includes(attachmentId))
        throw new Error('Choose an earlier reference attachment distinct from the primary publication.');
      const receipt = await services.sources.callForSource('chatroom_read', { roomId, messageId, attachmentId, length: 1 }, task);
      const target = receipt.publication;
      if (receipt.reference?.roomId !== roomId || receipt.reference.messageId !== messageId || receipt.reference.attachmentId !== attachmentId ||
          target?.messageId !== messageId || target.attachmentIds.length !== 1 ||
          target.attachmentIds[0] !== attachmentId || !receipt.name || !(Date.parse(target.publishedAt) < Date.parse(publication.publishedAt)))
        throw new Error('The historical reference is not an available exact attachment on an earlier publication in this room.');
      return { publication: target, name: receipt.name, publishedAtLocal: localTime(target.publishedAt) };
    }));
  };
  const saveContribution = (participant, references, grant, id, operationId) => saveRoomDutyPlan(store, {
    kind: 'contribution', roomId: source.roomId, messageId: source.replyTo,
    grant, coordinatorBotId: services.works.botId, requestTaskId: task.id, dutyKey: participant.dutyKey,
    goal: participant.contribution, references, workId: id, operationId,
    ...(grant.after?.condition === OWNER_DELIVERY ? { dependency: grant.after, ownerBotId: grant.after.ownerBotId } : {}),
    originalRoomGoal: source.input.room.goal, originalTeamRequirements: source.input.room.team.requirements,
  });
  const selectedWork = work => {
    const binding = work.bindings?.findLast(item => item.type === 'native-recovery');
    const execution = externalExecution(work, binding?.operationId);
    return { id: work.id, goal: work.goal, requirements: work.requirements, status: work.status,
      project: work.project, target: work.executor?.target, controlRevision: work.controlRevision || 0,
      priorStage: currentProductionStage(work, store), operationId: execution?.operationId,
      executionStatus: execution?.status, bindingId: binding?.id,
      ...(work.waiting?.kind === 'room-duty-contribution' ? { pendingContribution: work.waiting.operationId } : {}) };
  };
  const documentBoundary = (work, grant) => {
    if (grant?.stage !== 'document-review') return;
    if ((['active', 'paused', 'cancelled'].includes(work.status) || work.status === 'waiting' && work.waiting?.kind === 'external') &&
      currentProductionStage(work, store) !== 'document-review')
      throw new Error('仅文稿授权不会追加到正在实施的回合或恢复已停止的实施工作。请使用对应的文档工作，或登记独立新文档工作。');
  };
  return [
    tool('request_decide', 'Classify the CURRENT authenticated user request before acting. Use room-deliver for a requested final text handoff, note or wording to post only in this room; answer here, without executor tools. Use discuss for questions, planning or small drafts; feedback for observations; status for progress; deliver for existing outputs; control for pause/stop/cancel. Use accept for explicit scoped approval. Use produce/revise for a separately authorized production action, including an independent review after publication. The original source check can find multiple actions. Omit sourceUnit to start the sole immediate step; select the reported action unit for a later separate step. When acceptanceReply is present, the runtime includes that receipt in the room reply.',
      object({ intent: { type: 'string', enum: requestIntents }, productionStage: { type: 'string', enum: productionStages,
        description: 'Classify the requested outcome. A standalone formal Markdown review document, its revision and returning the resulting file are one document-review action. Implementation means making or changing the working product, building, testing or deploying it. Other is an independent action outside both stages.' },
        workRelation: { type: 'string', enum: ['new', 'continue'] }, workId: string,
        sourceUnit: { type: 'integer', minimum: 1, description: 'Omit unless you need to choose among verified source actions. Use the exact reported unit. Retain the saved stage when finishing the same existing step.' },
        reason: string }, ['intent', 'reason']), 'write', async (args, ctx) => {
        const user = currentUserRequest(task, store);
        if (taskMode(task) !== 'chat' || !userRequest || !user) throw new Error('Request decisions belong to the current authenticated frontend user request.');
        const recovery = task.metadata?.productionRecovery;
        if (recovery) {
          const current = verifiedProductionRecovery(store, recovery);
          if (current?.outcome !== 'unsubmitted') throw new Error('The original implementation is no longer proven unsubmitted.');
          args = { ...args, intent: 'produce', productionStage: recovery.stage, workRelation: 'new', sourceUnit: recovery.sourceUnit };
        }
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
        // Room retries create new task and accepted-message IDs for the same original message.
        const originalAcceptanceId = user && `acceptance:${JSON.stringify([user.actor, user.roomId, user.messageId])}`;
        const oldAcceptance = originalAcceptanceId && (store.getRecord('production-sources', originalAcceptanceId + ':delivered-result-identity') ||
          store.getRecord('production-sources', originalAcceptanceId));
        const mayResolveLegacy = oldAcceptance?.identityVersion !== 3 && oldAcceptance?.receipt?.unresolvedAcceptances?.length &&
          !oldAcceptance.receipt.acceptances?.length && !oldAcceptance.receipt.roomOnlyAcceptances?.length && !oldAcceptance.receipt.roomResultAcceptances?.length;
        const acceptanceId = mayResolveLegacy ? originalAcceptanceId + ':standalone-delivery-version' : oldAcceptance?.id || originalAcceptanceId;
        const readAcceptance = () => acceptanceId && store.getRecord('production-sources', acceptanceId);
        let acceptance = readAcceptance();
        let classification, acceptanceContext, bindingSnapshot = { bindings: [], entries: [] };
        const readBindings = async actionScope => {
          if (!user?.roomId) return { bindings: [], entries: [] };
          const [rooms, page] = await Promise.all([
            services.sources.rooms(task),
            services.sources.callForSource('chatroom_read', { roomId: user.roomId, acceptanceResults: true }, task)
              .catch(() => ({ roomResults: [], unavailable: true })),
          ]);
          return requestAcceptanceBindings(services, task, user, rooms, page, actionScope);
        };
        const checkProduction = production && !confirmedFeedback;
        const checkRoomDelivery = intent === 'room-deliver';
        const processAcceptance = !recovery && (checkProduction || intent === 'accept' || checkRoomDelivery);
        if (checkProduction || checkRoomDelivery || intent === 'accept' && !acceptance) {
          const selected = work && selectedWork(work);
          const room = source.input?.room;
          const roomDuties = room?.kind === 'group' && room.team?.leadBotId === services.works.botId &&
            room.team.duties?.some(duty => duty.state === 'active' && duty.botId === services.works.botId) ?
            room.team.duties.filter(duty => duty.state === 'active' && room.members.includes(duty.botId))
              .map(({ dutyKey, responsibility, dutyProfile }) => ({ dutyKey, responsibility, boundary: dutyProfile?.boundary })) : undefined;
          const loadAcceptanceContext = async savedSource => {
            try {
              bindingSnapshot = await readBindings(acceptanceActionScope(savedSource));
              acceptanceContext = acceptanceContextView(bindingSnapshot, user);
            } catch { acceptanceContext = { units: [], results: [], unavailable: true }; }
            return acceptanceContext;
          };
          classification = await authorizeProduction({ task, store,
            decision: { messageId, roomId: source.roomId, ...(production ? {
              productionStage: args.productionStage, workRelation: args.workRelation, sourceUnit: args.sourceUnit,
            } : {}) }, proposed: { work: selected || undefined },
            verify: ctx.verifyProduction, signal: ctx.signal, isTargetCurrent: selected ? () => sameWork(selected, services.works.get(work.id)) : undefined,
            sourceOnly: true, savedDecision: previous ?? null, acceptanceContext: loadAcceptanceContext, roomDuties,
            acceptanceMode: recovery || acceptance ? undefined : intent === 'accept' ? 'required' : 'candidate' });
        }
        // Freeze positive, negative and unresolved decisions for the original message before refreshing permissions.
        const approval = classification?.approval;
        if (!acceptance && approval) {
          const selected = selectedAcceptanceBindings(bindingSnapshot, approval.acceptances, user);
          const approvals = acceptanceScopes(approval.acceptances, selected);
          const bindings = selected.filter(binding => binding.publication && approvals.some(item => item.recordIn === 'work' &&
            item.unit === binding.unit && item.publicationMessageId === binding.publication.messageId));
          acceptance = store.transaction(() => readAcceptance() || store.putRecord('production-sources', {
            id: acceptanceId, acceptedMessageId: user.acceptedMessageId, roomId: user.roomId, messageId: user.messageId,
            identityVersion: 3,
            approvals, bindings, excluded: bindingSnapshot.excluded, sharedScopeUnits: bindingSnapshot.sharedScopeUnits,
            acknowledgmentOnly: approval.acknowledgmentOnly, issue: approval.issue,
            unconfirmed: approval.acceptanceUnconfirmed ||
              approvals.some(item => item.recordIn === 'unconfirmed' || item.recordIn === 'work' && acceptanceContext?.unavailable),
          }));
        }
        const canRecord = processAcceptance && !acceptance?.receipt && acceptance?.bindings.length > 0;
        const currentBindings = canRecord ? await readBindings({ excluded: acceptance.excluded,
          sharedScopeUnits: acceptance.sharedScopeUnits }).catch(() => null) : null;
        ctx.signal?.throwIfAborted();
        if ((classification || acceptance) && (store.getTask(task.id)?.cancelRequested ||
          JSON.stringify(currentUserRequest(task, store)) !== JSON.stringify(user) ||
          JSON.stringify(store.getRecord('request-routing', task.id)) !== JSON.stringify(previous)))
          throw new Error('The authenticated source changed before its decision could be saved.');
        confirmedFeedback ||= classification?.feedback === true && !acceptance?.approvals.length && !acceptance?.unconfirmed;
        const sourceActions = classification?.actions;
        const roomDeliveryUnits = classification?.roomDeliveryUnits || [];
        const directReview = checkRoomDelivery && !roomDeliveryUnits.length && sourceActions?.length === 1 &&
          sourceActions[0].kind === 'start' && sourceActions[0].stage === 'other' && sourceActions[0].when === 'now' &&
          sourceActions[0].separateOwner === true ? sourceActions[0] : null;
        if (directReview) { production = true; intent = 'produce'; }
        if (production && (confirmedFeedback || !sourceActions?.length)) {
          production = false;
          intent = acceptance?.approvals.length || acceptance?.unconfirmed || previous?.acceptances?.length ? 'accept' :
            roomDeliveryUnits.length ? 'room-deliver' : confirmedFeedback ? 'feedback' : classification?.deliveryUnits.length ? 'deliver' : 'discuss';
        }
        if (checkRoomDelivery && !roomDeliveryUnits.length && !directReview) intent = acceptance?.approvals.length ? 'accept' : 'discuss';
        // Persist the actual acceptance outcomes with the routing decision, before any separate dispatch.
        const decision = store.transaction(() => {
          let receipt = readAcceptance()?.receipt;
          if (processAcceptance && acceptance && !receipt) {
            const current = currentBindings ? selectedAcceptanceBindings(currentBindings, acceptance.approvals, user) : [];
            const { records, roomResultAcceptances, roomOnlyAcceptances, unresolvedAcceptances } =
              saveRequestAcceptances(services, user, acceptance.approvals, acceptance.bindings, current);
            receipt = { taskId: task.id, acceptances: records, roomResultAcceptances, roomOnlyAcceptances, unresolvedAcceptances,
              acceptanceUnconfirmed: acceptance.unconfirmed || canRecord && !currentBindings };
            store.putRecord('production-sources', { ...acceptance, receipt });
          }
          const acceptances = [...new Map([...(previous?.acceptances || []), ...(receipt?.acceptances || [])]
            .map(item => [item.workId, item])).values()];
          return store.putRecord('request-routing', { id: task.id, messageId, roomId: source.roomId, acceptances,
            acceptanceReceiptTaskId: receipt?.taskId ?? previous?.acceptanceReceiptTaskId,
            acceptanceAcknowledgmentOnly: acceptance?.acknowledgmentOnly ?? previous?.acceptanceAcknowledgmentOnly,
            roomResultAcceptances: receipt?.roomResultAcceptances ?? previous?.roomResultAcceptances ?? [],
            roomOnlyAcceptances: receipt?.roomOnlyAcceptances ?? previous?.roomOnlyAcceptances ?? [],
            unresolvedAcceptances: receipt?.unresolvedAcceptances ?? previous?.unresolvedAcceptances ?? [],
            acceptanceUnconfirmed: receipt?.acceptanceUnconfirmed ?? previous?.acceptanceUnconfirmed,
            acceptanceIssue: acceptance?.issue ?? previous?.acceptanceIssue,
            intent, productionStage: directReview?.stage || (production ? args.productionStage : null), confirmedFeedback,
            existingDelivery: previous?.existingDelivery === true || intent === 'deliver',
            sourceUnit: production ? directReview?.unit ?? classification?.resolvedSourceUnit ?? args.sourceUnit : null,
            sourceUnitInferred: production && classification?.resolvedSourceUnit !== undefined,
            sourceActions: production ? sourceActions || [] : [],
            roomDeliveryUnits: intent === 'room-deliver' ? roomDeliveryUnits : [],
            roomDeliveryDutyKey: intent === 'room-deliver' ? classification?.roomDeliveryDutyKey : undefined,
            workRelation: directReview ? 'new' : production ? args.workRelation : null,
            workId: production && args.workRelation === 'continue' ? args.workId : null,
            reason: directReview ? 'The authenticated source requests a separate independent review of an existing publication.' :
              intent !== args.intent ? 'The authenticated source contains no independent production action.' : modelText(args.reason), authority: 'model-routing-decision' });
        });
        const reply = recovery ? '' : acceptanceReply(decision, user?.text);
        const result = reply ? { ...decision, acceptanceReply: reply } : decision;
        if (!production && (intent !== args.intent || intent === 'room-deliver')) return { ...result, instruction: 'Follow the saved intent and respond to the original message. Do not call an executor or dispatch independent work for this source classification.' };
        return sourceActions?.length ? { ...result, sourceActions,
          instruction: 'Submit only the selected source action and its explicit limits. For production after an assigned room owner contributes, select the production unit and pass participant with its dutyKey and exact prerequisite to work_create for new work or work_dispatch for an existing work. For separateOwner, use work_create without an executor. Provide the exact earlier publication and selected attachments when the review is immediate. If the original request authorizes new production followed by independent review, submit the immediate production first, then register the review unit.' } : result;
      }),
    tool('evidence_read', 'Read a bounded original fragment by exact reference. Workers may follow only handed-off references, never browse another room/session feed. Current source access is rechecked.',
      object({ reference }, ['reference']), 'read', args => services.sources.resolve(services.sources.reference(args.reference ?? args, task), task)),
    tool('executors_status', 'Read the work owner. Pi runs independent work; discover tools and applicable methods with catalog_search.', object({}), 'read', () => services.executors()),
    tool('runtime_status', 'Read current source room/work state with local tasks, native operation bindings and S3 waits.', object({}), 'read', async () => {
      const rooms = await services.sources.rooms(task), works = [];
      for (const work of services.works.list({ limit: 500 })) if (await services.sources.canReadWork(work, task, rooms)) works.push(work);
      const ids = new Set(works.map(work => work.id));
      const local = store.listTasks({ limit: 10000 }).filter(item => ids.has(item.workId) || !item.workId && taskSource(item, store).roomId === source.roomId);
      return { scope: { roomId: source.roomId, workIds: [...ids], global: false }, facts: factTime(),
        localTasks: Object.fromEntries(['accepted', 'queued', 'running', 'waiting'].map(status => [status, local.filter(item => item.status === status).length])),
        works: works.map(work => ({ id: work.id, status: work.status, waiting: work.waiting, executionOutcome: work.executionOutcome,
          execution: externalExecution(work), bindings: work.bindings, updatedAt: work.updatedAt })) };
    }),
    tool('request_actions', 'Read saved action and acceptance receipts for an original message in this conversation (messageId defaults to the current trigger). Use these receipts to distinguish an actual work write, a room-only scope, and an unconfirmed scope. History is not permission to repeat an action.',
      object({ messageId: string }), 'read', args => {
        const messageId = args.messageId || source.replyTo || source.messageId;
        return store.listTasks({ limit: 10000 }).filter(item => item.conversationId === task.conversationId &&
          [taskSource(item, store).replyTo, item.messageId].includes(messageId)).map(item => {
          const routing = store.getRecord('request-routing', item.id);
          const acceptanceReceipt = routing?.roomId && routing.roomId === source.roomId && routing.messageId === messageId ? {
            messageId: routing.messageId, receiptTaskId: routing.acceptanceReceiptTaskId,
            acceptances: routing.acceptances, roomResultAcceptances: routing.roomResultAcceptances, roomOnlyAcceptances: routing.roomOnlyAcceptances,
            unresolvedAcceptances: routing.unresolvedAcceptances, acceptanceUnconfirmed: routing.acceptanceUnconfirmed,
            issue: routing.acceptanceIssue } : undefined;
          return { taskId: item.id, messageId, status: item.status, acceptanceReceipt,
            dutyPlans: store.listRecords(ROOM_DUTY_PLANS).filter(plan => plan.requestTaskId === item.id).map(planReceipt),
            actions: store.listTools(item.id).filter(record => record.effect !== 'read').map(record => {
              const receipt = record.output?.details || {};
              const refused = productionRefusal(record);
              return { actionId: record.id, tool: record.name, status: record.status, id: receipt.id, workId: receipt.workId,
                taskId: receipt.taskId, operationId: receipt.operationId,
                execution: receipt.workId && services.works.get(receipt.workId) ? externalExecution(services.works.get(receipt.workId), receipt.operationId) : receipt.execution,
                savedExecution: receipt.execution, receiptLayer: receipt.receiptLayer, registered: receipt.registered, planId: receipt.planId,
                waitId: receipt.waitId, accepted: receipt.accepted, savedStatus: receipt.status, recordedAt: record.finishedAt, dueAt: receipt.dueAt,
                ...(refused ? { error: refused } : {}),
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
      const view = workView(result.work, result.observedAt), operationId = view.execution?.operationId;
      const operation = operationId && store.getRecord('work-events', operationId);
      const origin = operation?.authorization?.source;
      const deliveryScope = frontend && source.roomId && origin?.roomId === source.roomId && operation.workId === view.id &&
        operation.receipt?.accepted && (origin.replyTo || origin.formId === view.id) ?
        { operationId, roomId: origin.roomId, messageId: origin.replyTo, formId: origin.formId } : undefined;
      return { ...view, lookup: result.lookup, deliveryScope,
        ...(frontend ? { currentStage: currentProductionStage(result.work, store) } : {}),
        ...(frontend ? { acceptanceTarget: acceptanceTarget(store, result.work, source.roomId) } : {}), bindings: result.work.bindings };
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
          attachments: available.filter(item => !selected || selected.includes(item.id)).map(({ id, messageId }) => ({ id, messageId })) };
      }),
    tool('work_create', 'Submit one selected source action. An immediate production action schedules actual work. Omit the executor target unless the user picked a working project or directory. Input materials and output destinations are separate from cwd; an output directory can be absent. When the user directs production following a discussion, include the exact same-room original user message that supplied its inputs or executable. For new production after an assigned room owner contributes, select the production unit and pass participant with the active dutyKey and exact prerequisite contribution. This can be your own assigned duty; the runtime delivers that portion separately before starting the new work. For a separateOwner review, omit executor and target. For an already published result, include its exact same-room attachment references and original material in evidence. Give separately authorized earlier comparison files in reviewReferenceAttachments. For a review after new production, register the selected after-dependency review unit. A registered wait does not prove execution.',
      object({ id: string, operationId: string, goal: string, requirements: string, responsibility: string, ...handoffFields,
        participant: object({ dutyKey: string, contribution: string }),
        reviewPublicationMessageId: string,
        reviewReferenceAttachments: { type: 'array', maxItems: MESSAGE_ATTACHMENTS, items: object({ messageId: string, attachmentId: string }, ['messageId', 'attachmentId']),
          description: 'Exact same-room pairs for earlier files the current user authorizes comparing with the primary publication. Keep these pairs out of evidence. Use the primary publication and its attachments for reviewPublicationMessageId and evidence.' },
        afterDependency: object({ workId: string, minimumAttachments: { type: 'integer', minimum: 1, maximum: WORK_ATTACHMENTS } }),
        executor: object({ kind: { type: 'string', enum: ['pi'] }, connectionId: string,
          target: { type: 'object', description: 'Use {type:"directory",cwd:"absolute authorized path"} for the explicitly selected directory or choose an already authorized project.' } }, ['kind']) }), 'write', async (args, ctx) => {
        const decision = productionDecision(task, store);
        if (decision?.workRelation === 'continue') throw new Error(`Continue the existing deliverable with work_dispatch workId=${decision.workId}; this request does not authorize another work.`);
        const selected = selectedSourceAction(decision);
        if (!selected) throw new Error('Choose the matching original action from request_decide.sourceActions before submitting a proposal.');
        const recovery = task.metadata?.productionRecovery;
        const checkRecovery = () => {
          if (!recovery) return;
          const current = verifiedProductionRecovery(store, recovery);
          if (current?.outcome !== 'unsubmitted' || source.replyTo !== recovery.sourceMessageId || selected.unit !== recovery.sourceUnit ||
              selected.stage !== recovery.stage || selected.kind !== 'start' || selected.when !== 'now' ||
              args.participant || args.afterDependency || args.reviewPublicationMessageId)
            throw Object.assign(new Error('The original one-time implementation is no longer eligible for this submission.'), { code: 'PRODUCTION_RECOVERY_NOT_CURRENT' });
        };
        checkRecovery();
        const reviewReferences = args.reviewReferenceAttachments ?? [];
        if (!Array.isArray(reviewReferences) || reviewReferences.length > MESSAGE_ATTACHMENTS || reviewReferences.some(ref =>
          typeof ref?.messageId !== 'string' || !ref.messageId.trim() || typeof ref.attachmentId !== 'string' || !ref.attachmentId.trim() ||
          ref.roomId !== undefined && ref.roomId !== source.roomId))
          throw new Error('Use exact messageId and attachmentId pairs from this room in reviewReferenceAttachments.');
        if (reviewReferences.length && (!selected.separateOwner || selected.when !== 'now'))
          throw new Error('Historical reference attachments apply to an immediate independent review of an existing publication.');
        const content = await services.sources.handoff(task, args);
        await readSelectedPublications(content);
        const goal = modelText(args.goal || args.instruction || args.content || content.originalRequest.content);
        const requirements = modelText(args.requirements);
        const conditional = selected.when === 'after-dependency';
        const nowActions = decision.sourceActions.filter(action => action.when === 'now' && action.kind === 'start');
        const ownerFirst = conditional && !selected.separateOwner && selected.dependencyUnit &&
          !nowActions.some(action => action.unit === selected.dependencyUnit);
        if (selected.separateOwner || conditional && !ownerFirst) {
          if (decision.productionStage !== 'other' || args.executor || args.target || args.cwd || args.projectId)
            throw new Error('An independent room review uses a distinct assigned room owner. Omit the executor and production target.');
          let references = await dutyContext(content);
          const base = { roomId: source.roomId, messageId: source.replyTo, kind: 'independent-review' };
          const planId = roomDutyPlanId({ ...base, sourceUnit: selected.unit });
          const prior = store.getRecord(ROOM_DUTY_PLANS, planId);
          if (prior) return planReceipt({ ...prior, duplicate: true });
          const dutyKey = modelText(args.participant?.dutyKey).trim() || undefined;
          if (!conditional) {
            if (args.afterDependency) throw new Error('This review needs the existing exact publication, with attachment references.');
            const { publication, original, publicationEvidence } = await reviewPublication(args, content);
            const duty = dutyProposal(dutyKey, true, await currentDutyRoom(), true);
            if (duty?.botId === publication.makerBotId)
              throw new Error('Select an independent owner who did not make this publication, or let the project assign one.');
            references = [original.reference, ...publication.attachmentIds.map(attachmentId =>
              ({ type: 'room', roomId: base.roomId, messageId: publication.messageId, attachmentId }))];
            const historical = await reviewReferencePublications(reviewReferences, publication, base.roomId);
            const after = { condition: EXISTING_PUBLICATION, roomId: base.roomId, messageId: base.messageId, publication,
              ...(historical.length ? { reviewReferencePublications: historical } : {}) };
            const grant = await authorize(decision, ctx, { relation: 'new', goal, requirements,
              handoff: proposalHandoff(content.handoff), sourceMaterials: [original, ...proposalMaterials(content).filter(item =>
                item.reference.messageId === publication.messageId && publication.attachmentIds.includes(item.reference.attachmentId))],
              executor: 'room-duty-owner', participant: { independent: true, ...(dutyKey ? { dutyKey, duty } : {}) },
              after, publicationEvidence,
            }, { workId: null, actionId: planId });
            ctx.signal?.throwIfAborted();
            return planReceipt(saveRoomDutyPlan(store, { ...base, grant, dependency: after, coordinatorBotId: services.works.botId,
              requestTaskId: task.id, dutyKey, ownerBotId: duty?.botId, goal, requirements, instruction: content.handoff.instruction, references,
              originalRoomGoal: source.input.room.goal, originalTeamRequirements: source.input.room.team.requirements }));
          }
          const dependencyUnit = selected.dependencyUnit || (nowActions.length === 1 ? nowActions[0].unit : undefined);
          const candidates = nowActions.filter(action => action.unit === dependencyUnit);
          if (candidates.length !== 1)
            throw new Error('The source does not uniquely identify which immediate action must publish first. No dependent action was scheduled.');
          const dependencyAction = candidates[0];
          const binding = { roomId: base.roomId, messageId: base.messageId, sourceUnit: dependencyUnit, stage: dependencyAction.stage,
            soleSourceAction: nowActions.filter(action => action.stage === dependencyAction.stage).length === 1 };
          const dispatches = dependencyDispatches(store, binding, args.afterDependency?.workId);
          const registered = !dispatches.length && args.afterDependency?.workId && sourceDispatches(store, { ...binding,
            workId: args.afterDependency.workId, includeRegistered: true }).length === 1;
          if (dispatches.length > 1 || args.afterDependency?.workId && !dispatches.length && !registered)
            throw new Error('The selected dependency does not resolve to one accepted operation from this original request.');
          const dependency = dispatches[0];
          const minimumAttachments = Math.max(1, dependencyAction.requiredAttachments || 0,
            Number.isSafeInteger(args.afterDependency?.minimumAttachments) ? Math.min(WORK_ATTACHMENTS, args.afterDependency.minimumAttachments) : 0);
          const after = { ...binding, condition: 'successful-publication',
            minimumAttachments, ...(dependency ? { workId: dependency.workId, operationId: dependency.id, taskId: dependency.receipt.taskId } :
              registered ? { workId: args.afterDependency.workId } : {}) };
          const grant = await authorize(decision, ctx, { relation: 'new', goal, requirements,
            handoff: proposalHandoff(content.handoff), sourceMaterials: proposalMaterials(content),
            executor: 'room-duty-owner', participant: { independent: true, ...(dutyKey ? { dutyKey, duty: dutyProposal(dutyKey, true) } : {}) }, after,
          }, { workId: null, actionId: planId });
          ctx.signal?.throwIfAborted();
          return planReceipt(saveRoomDutyPlan(store, { ...base, grant, dependency: after, coordinatorBotId: services.works.botId,
            requestTaskId: task.id, dutyKey, goal, requirements, instruction: content.handoff.instruction, references }));
        }
        if (args.afterDependency) throw new Error('afterDependency applies to a separate independent review after new production.');
        const nowSteps = nowActions.filter(action => action.stage === selected.stage);
        const already = () => sourceDispatches(store, { roomId: source.roomId, messageId: source.replyTo, stage: selected.stage, includeRegistered: true,
          when: selected.when, ...(selected.when === 'now' && nowSteps.length === 1 ? {} : { sourceUnit: selected.unit }) });
        const dispatchReceipt = event => event.receipt ? { ...event.receipt, duplicate: true } : {
          ...services.works.contributionReceipt(event), duplicate: true };
        const replay = already();
        if (replay.length === 1) return dispatchReceipt(replay[0]);
        if (replay.length > 1) throw new Error('More than one previously submitted work has this source action. No additional work was submitted.');
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
        const namedScopes = sourceFileScopes(task, store);
        const declaredDirectories = namedScopes.filter(item => item.purpose === 'cwd')
          .map(item => resolveFilePath(services.sources.workspace, item.path));
        let target = selectedTarget;
        if (selectedTarget?.type === 'directory') {
          const cwd = resolveFilePath(services.sources.workspace, selectedTarget.cwd);
          if (declaredDirectories.some(path => samePath(cwd, path))) target = { type: 'directory', cwd };
          else if (declaredDirectories.length) throw new Error('Use the exact working directory selected in the original request.');
          else {
            const inputs = earlierFileSources(task, store, content.evidence).flatMap(item => item.scopes);
            const resourceTarget = [...namedScopes, ...inputs].some(({ path, purpose }) => purpose !== 'cwd' &&
              pathWithin(resolveFilePath(services.sources.workspace, path), cwd));
            target = resourceTarget ? null : { type: 'directory', cwd };
          }
        } else if (!selectedTarget && declaredDirectories.length === 1) {
          target = { type: 'directory', cwd: declaredDirectories[0] };
        }
        const executor = { kind: 'pi', ...(suppliedExecutor.connectionId ? { connectionId: suppliedExecutor.connectionId } : {}), ...(target ? { target } : {}) };
        let project;
        try { project = target ? await services.sources.authorizeProject(target, task) : await services.sources.contextProject(task); }
        catch (error) { if (target) throw error; content.evidenceWarnings.push({ message: `Project scope is unavailable: ${error.message}` }); }
        if (project?.cwd && target?.type === 'directory') executor.target = { type: 'directory', cwd: project.cwd };
        if (project && executor?.target?.type === 'project') executor.target = { ...executor.target, projectId: project.id };
        const participant = modelText(args.participant?.contribution).trim() ? {
          contribution: modelText(args.participant.contribution).trim().slice(0, 4000),
          dutyKey: modelText(args.participant.dutyKey).trim() || undefined } : null;
        if (ownerFirst && !participant?.dutyKey)
          throw new Error('Select the active room duty and its specific first contribution with participant. Production has not been dispatched.');
        const participantRefs = participant && await dutyContext(content);
        const duty = participant && dutyProposal(participant.dutyKey, false, source.input?.room, ownerFirst);
        const after = ownerFirst && await ownerPrerequisite({ decision, action: selected, participant, duty, workId: id,
          operationId: `${id}:${operationId}`, projectId: project?.id ?? null });
        const grant = await authorize(decision, ctx, { relation: 'new', project, target: executor?.target || target, executor: executor.kind,
          goal, requirements, handoff: proposalHandoff(content.handoff), sourceMaterials: proposalMaterials(content),
          ...(participant ? { participant: { ...participant, duty } } : {}), ...(after ? { after } : {}) },
        { workId: id, actionId: `${id}:${operationId}`, scopeEvidence: content.evidence });
        if (grant) content.stage = productionStage(grant);
        try {
          content.currentKnowledge = await services.memory.forRequest(task, project);
          content.projectKnowledge = content.currentKnowledge?.projectKnowledge;
        }
        catch (error) { content.evidenceWarnings.push({ message: `Current project rules are unavailable: ${error.message}` }); }
        ctx.signal?.throwIfAborted();
        const concurrent = already();
        if (concurrent.length === 1) return dispatchReceipt(concurrent[0]);
        if (concurrent.length > 1) throw new Error('More than one previously submitted work has this source action. No additional work was submitted.');
        let participantPlan;
        const work = store.transaction(() => {
          checkRecovery();
          if (participant) participantPlan = saveContribution(participant, participantRefs, grant, id, `${id}:${operationId}`);
          return services.works.create({ id, operationId, goal, requirements, responsibility: modelText(args.responsibility), executor, project,
            productionStage: grant?.stage, productionAuthorization: grant, initialHandoff: content,
            contributionPlanId: participantPlan?.id }, task);
        });
        const receipt = await services.works.dispatch(work.id, { id: operationId, kind: 'request', content, metadata: { priority: 'background' } }, task);
        return { ...compactWork(work), ...receipt, handedOff: receipt.accepted === true, acceptance: modelText(args.acceptance),
          ...(participantPlan ? { participantPlan: planReceipt(participantPlan) } : {}), evidenceWarnings: content.evidenceWarnings };
      }),
    tool('work_update', frontend ? 'Pause or cancel existing work. Send requirements with work_dispatch; only the worker records progress and completion.' : 'Record actual progress and status of the current work. Its identity and revision are supplied by the program.',
      object({ id: string, ...(!frontend ? { goal: string, requirements: string, progress: string, checkpoint: {}, next: string, constraints: string, evidence: {},
        waiting: waitingFields } : {}), status: { type: 'string', enum: frontend ? ['paused', 'cancelled'] : ['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled'] } }), 'write', async args => {
        const work = await services.sources.requireWork(workId(args), task);
        const question = modelText(args.waiting?.question).trim(), blockingRequirement = modelText(args.waiting?.blockingRequirement).trim();
        if (args.waiting?.kind === 'user-input' && !question) throw new Error('Waiting for user input requires the actual unanswered question.');
        if (['paused', 'cancelled'].includes(args.status) && work.id !== task.workId) {
          if (!userRequest) throw new Error('只能依据当前用户的停止要求控制这项工作。');
          if (source.roomId && (!work.sources?.length || work.sources.some(item => item.roomId !== source.roomId)))
            throw new Error('请在这项工作的来源会话停止，或使用它的工作卡。');
          return compactWork(await services.stopWork(work, args.status, task));
        }
        const patch = Object.fromEntries((frontend ? ['status'] : ['goal', 'requirements', 'progress', 'status']).filter(key => args[key] !== undefined).map(key => [key, modelText(args[key])]));
        if (!frontend && args.waiting && (args.status || work.status) === 'waiting') patch.waiting = { kind: args.waiting.kind,
          question, reason: modelText(args.waiting.reason), since: new Date().toISOString(),
          ...(args.waiting.kind === 'user-input' && blockingRequirement ? { blockingRequirement } : {}) };
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
    tool('work_dispatch', 'Continue an existing work after request_decide saved produce/revise with workRelation=continue and its canonical workId for this request. If the user explicitly asks for an assigned owner’s contribution first, select the reported after-dependency unit for the continuation and pass participant with its exact dutyKey and contribution. Include exact same-room evidence with attachmentIds. The runtime registers the original continuation and waits for the assigned owner’s concrete same-source room delivery. A registered receipt means waiting. Use participant for concrete needed contributions, and omit it for ordinary continuations. Use work_deliver for returning existing files. The program supplies the operation and binding. Stopped work resumes only for a fresh user request.',
      object({ id: string, content: {}, ...handoffFields, correction: { type: 'boolean' },
        participant: object({ dutyKey: string, contribution: string }, ['dutyKey', 'contribution']) }), 'write', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        if (['paused', 'cancelled'].includes(work.status) && !userRequest) throw new Error('这项工作已停止；当前事件不包含用户新的继续要求。其他动作可以继续。');
        const decision = productionDecision(task, store);
        if (decision?.workRelation === 'new') throw new Error('This is an independent new task. Use work_create and the applicable saved project rules; do not reuse the old work merely because it shares the project or materials.');
        if (decision?.workId && decision.workId !== work.id) throw new Error('Dispatch must use the canonical continuation work selected for this request.');
        const selected = selectedWork(work), sourceAction = decision && selectedSourceAction(decision, { work: selected });
        const nowSteps = (decision?.sourceActions || []).filter(action => action.when === 'now' && action.kind !== 'start' &&
          (action.kind === 'continue' ? selected.priorStage : action.stage) === decision.productionStage);
        const previousDispatch = () => {
          if (!sourceAction) return null;
          const matches = sourceDispatches(store, { roomId: source.roomId, messageId: source.replyTo, workId: work.id,
            stage: decision.productionStage, relation: 'continue', when: sourceAction.when, includeRegistered: true,
            ...(sourceAction.when === 'now' && nowSteps.length === 1 ? {} : { sourceUnit: sourceAction.unit }) });
          if (matches.length > 1) throw new Error('More than one continuation has this source action. No additional operation was submitted.');
          const saved = matches[0];
          return saved ? { ...(saved.receipt || services.works.contributionReceipt(saved)), duplicate: true } : null;
        };
        const replay = previousDispatch();
        if (replay) return replay;
        const eventId = actionId(args, ctx, 'eventId'), operationId = `${work.id}:${eventId}`;
        const content = await services.sources.handoff(task, args);
        await readSelectedPublications(content);
        let participant, participantRefs, duty;
        if (args.participant !== undefined) {
          const input = modelArgs(args.participant), dutyKey = modelText(input.dutyKey).trim();
          const contribution = modelText(input.contribution).trim().slice(0, 4000);
          if (!decision || !dutyKey || !contribution) throw new Error('A continuation contribution needs this user’s action, an assigned dutyKey and a specific contribution.');
          participant = { dutyKey, contribution };
          participantRefs = await dutyContext(content);
          duty = dutyProposal(dutyKey, false);
        }
        const after = sourceAction?.when === 'after-dependency' ? await ownerPrerequisite({ decision, action: sourceAction,
          participant, duty, workId: work.id, operationId, projectId: selected.project?.id ?? null, work }) : undefined;
        const grant = await authorize(decision, ctx, { relation: 'continue', work: selected, handoff: content.handoff,
          sourceMaterials: proposalMaterials(content), ...(participant ? { participant: { ...participant, duty } } : {}),
          ...(after ? { after } : {}) }, { workId: work.id, actionId: operationId, scopeEvidence: content.evidence });
        if (grant) content.stage = productionStage(grant);
        try {
          content.currentKnowledge = await services.memory.forRequest(task, services.sources.project(work));
          content.projectKnowledge = content.currentKnowledge?.projectKnowledge;
        }
        catch (error) { content.evidenceWarnings.push({ message: `Current project rules are unavailable: ${error.message}` }); }
        ctx.signal?.throwIfAborted();
        const concurrent = previousDispatch();
        if (concurrent) return concurrent;
        const current = services.works.get(work.id);
        if (!sameWork(selected, current)) throw new Error('工作目标或控制状态已变化；请重新读取并依据新的用户要求处理。');
        documentBoundary(current, grant);
        const input = { id: eventId, kind: frontend ? 'request' : 'event', content, productionAuthorization: grant,
          metadata: { correction: args.correction === true, resume: Boolean(grant), priority: 'foreground' } };
        let participantPlan;
        const receipt = participant ? store.transaction(() => {
          participantPlan = saveContribution(participant, participantRefs, grant, work.id, operationId);
          return services.works.registerContinuationContribution(work.id, { ...input, contributionPlanId: participantPlan.id }, task);
        }) : await services.works.dispatch(work.id, input, task);
        return { ...receipt, ...(participantPlan ? { participantPlan: planReceipt(participantPlan) } : {}),
          acceptance: modelText(args.acceptance), evidenceWarnings: content.evidenceWarnings };
      }),
    tool('work_wait', 'Save a wait for a precise execution result or deadline. Use work_dispatch with participant for an existing work after an assigned room owner’s contribution. For “wait for B, then let A use B’s output”, set targetWorkId=A, dependencyWorkId=B, taskId=B’s accepted task and instruction=the step A should perform. This includes A explaining partial output after B fails; keep success-only prerequisites in the instruction. The runtime derives follow_up for this cross-work step even if an optional mode conflicts. Waiting only to receive the same action’s already published result is observe and never sends another prompt. Supply no new step unless the user authorized one. Missing IDs can be recovered from unique accepted actions; explicit invalid work IDs are rejected. Finish other independent actions and reminders in this turn.',
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
    ...(!frontend ? [tool('work_file_access', 'Ask for a genuine unresolved file permission on this accepted work. Give the exact path from its original source after a file or native capability reported a missing grant. The program derives the operation, preserves the same action and sends the exact question to the original conversation.',
      object({ path: string }, ['path']), 'external', async (args, ctx) => {
        const work = await services.sources.requireWork(task.workId, task);
        const request = services.works.requestFileAccess(task, work.project?.cwd || services.sources.workspace, args.path);
        const result = await services.notify({ id: work.id, notificationId: request.id, publication: 'file-access',
          resultKind: 'file-access', content: request.question,
          sourceRefs: [{ type: 'work-file-access', workId: work.id, requestId: request.id, operationId: request.actionId }] }, task, ctx);
        return { requestId: request.id, operationId: request.actionId, status: request.status, notification: result.status, question: request.question };
      })] : []),
    tool('work_notify', 'Save and publish this work’s useful result text directly. The program supplies the original recipient, reply association and notification ID; peer FYI does not demand another reply.',
      object({ id: string, content: string, attachments: { type: 'array', maxItems: WORK_ATTACHMENTS, items: object({ id: string }, ['id']) } }), 'external', async (args, ctx) => {
        const work = await services.sources.requireWork(workId(args), task);
        return services.notify({ id: work.id, notificationId: actionId(args, ctx, 'notificationId'),
          publication: 'explicit', attachments: args.attachments,
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
  ];
}
