export const ROOM_DUTY_PLANS = 'room-duty-plans';

export function roomDutyPlanId({ roomId, messageId, sourceUnit, kind }) {
  return JSON.stringify([roomId, messageId, sourceUnit, kind]);
}

export function sourceDispatches(store, { roomId, messageId, sourceUnit, workId, stage, includeRegistered = false }) {
  if (!store || !roomId || !messageId) return [];
  return store.listRecords('work-events').filter(event => {
    const { source, production } = event.authorization || {};
    const registered = includeRegistered && event.contributionPlanId;
    return event.kind === 'request' && (event.receipt?.accepted && event.receipt.taskId || registered) && event.workId &&
      source?.actor === 'user' && source.roomId === roomId && source.replyTo === messageId &&
      production?.roomId === roomId && production.messageId === messageId && production.when === 'now' && production.relation === 'new' &&
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
