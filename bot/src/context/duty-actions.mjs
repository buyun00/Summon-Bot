export const ROOM_DUTY_PLANS = 'room-duty-plans';
export const OWNER_DELIVERY = 'same-source-owner-delivery';
export const EXISTING_PUBLICATION = 'existing-publication';

export function roomDutyPlanId({ roomId, messageId, sourceUnit, kind }) {
  return JSON.stringify([roomId, messageId, sourceUnit, kind]);
}

export function matchesContributionGrant(plan, grant) {
  if (plan?.kind !== 'contribution' || !grant || JSON.stringify(plan.grant) !== JSON.stringify(grant) ||
      plan.workId !== grant.workId || plan.operationId !== grant.actionId || plan.requestTaskId !== grant.taskId ||
      plan.roomId !== grant.roomId || plan.messageId !== grant.messageId ||
      plan.dutyKey !== grant.participant?.dutyKey || plan.goal !== grant.participant?.contribution) return false;
  const after = plan.dependency;
  if (!after) return grant.when === 'now' && !grant.after;
  return grant.when === 'after-dependency' && ['new', 'continue'].includes(grant.relation) && after.condition === OWNER_DELIVERY &&
    JSON.stringify(after) === JSON.stringify(grant.after) && after.planId === plan.id && after.ownerBotId === plan.ownerBotId &&
    after.dutyKey === plan.dutyKey && after.contribution === plan.goal && after.workId === plan.workId &&
    after.operationId === plan.operationId && after.roomId === plan.roomId && after.messageId === plan.messageId &&
    after.requestTaskId === plan.requestTaskId && after.acceptedMessageId === grant.acceptedMessageId &&
    after.projectId === grant.projectId && after.stage === grant.stage && after.actionUnit === grant.sourceUnit;
}

export function publishedReviewTarget(message, roomId, attachmentIds) {
  if (!message || message.roomId !== roomId || message.eventType !== 'work_result' || message.workPublication !== true ||
      !message.senderId || !message.workId || !message.replyTo || !attachmentIds?.length) return null;
  const selected = new Set(attachmentIds);
  const files = (message.attachments || []).filter(attachment => selected.has(attachment.id));
  const operationId = files[0]?.origin?.operationId;
  if (files.length !== selected.size || !operationId || files.some(({ id, origin }) =>
    origin?.type !== 'work-output' || origin.publicationId !== id || origin.roomId !== roomId ||
    origin.botId !== message.senderId || origin.workId !== message.workId || origin.operationId !== operationId ||
    origin.sourceMessageId !== message.replyTo)) return null;
  return { messageId: message.id, sourceMessageId: message.replyTo, publishedAt: message.createdAt, makerBotId: message.senderId,
    workId: message.workId, operationId, attachmentIds: files.map(file => file.id) };
}

export function reviewReferenceAttachments(dependency) {
  if (dependency?.condition !== EXISTING_PUBLICATION) return [];
  return (dependency.reviewReferencePublications || []).map(({ publication, name }) => ({ type: 'room', roomId: dependency.roomId,
    messageId: publication.messageId, attachmentId: publication.attachmentIds[0], publishedAt: publication.publishedAt, name }));
}

export function sourceDispatches(store, { roomId, messageId, sourceUnit, workId, stage, relation = 'new', when = 'now', includeRegistered = false }) {
  if (!store || !roomId || !messageId) return [];
  return store.listRecords('work-events').filter(event => {
    const { source, production } = event.authorization || {};
    const registered = includeRegistered && event.contributionPlanId;
    return event.kind === 'request' && (event.receipt?.accepted && event.receipt.taskId || registered) && event.workId &&
      source?.actor === 'user' && source.roomId === roomId && source.replyTo === messageId &&
      production?.roomId === roomId && production.messageId === messageId && production.when === when && production.relation === relation &&
      (sourceUnit === undefined || production.sourceUnit === sourceUnit) && (!workId || event.workId === workId) &&
      (!stage || stage === production.stage);
  });
}

export function dependencyDispatches(store, dependency, workId = dependency.workId) {
  const criteria = { roomId: dependency.roomId, messageId: dependency.messageId, sourceUnit: dependency.sourceUnit,
    workId, stage: dependency.stage };
  const exact = sourceDispatches(store, criteria);
  return exact.length || !dependency.soleSourceAction ? exact : sourceDispatches(store, { ...criteria, sourceUnit: undefined });
}

export function saveRoomDutyPlan(store, plan) {
  const id = roomDutyPlanId({ ...plan, sourceUnit: plan.grant.sourceUnit });
  return store.transaction(() => {
    const saved = store.getRecord(ROOM_DUTY_PLANS, id);
    if (saved) return { ...saved, duplicate: true };
    return store.putRecord(ROOM_DUTY_PLANS, { ...plan, id, createdAt: new Date().toISOString() });
  });
}
