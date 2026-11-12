import { currentUserRequest } from './request-routing.mjs';
import { localTime } from '../context/fact-time.mjs';
import { taskSource } from '../context/sources.mjs';

const from = 'production-recovery-requests';
// Screen only the explicit two-branch request. The normal source/proposal
// check still decides whether that request authorizes this exact recovery.
const existing = /(?:若|如果|要是)[^。！？；\r\n]{0,55}(?:已经?|有)[^。！？；\r\n]{0,32}(?:提交|入队|受理|工作|任务)[^。！？；\r\n]{0,45}(?:继续|沿|保留)|\bif\b[^.!?\n]{0,60}\balready\b[^.!?\n]{0,45}\b(?:continue|keep|use)\b/i;
const absent = /(?:若|如果|要是)[^。！？；\r\n]{0,35}(?:还未|尚未|没有|未|没)[^。！？；\r\n]{0,24}(?:入队|提交|受理|建立|创建)[^。！？；\r\n]{0,45}(?:提交|发起|承接|创建|补交)[^。！？；\r\n]{0,20}(?:一次|一项)|\b(?:if not|otherwise|if\b[^.!?\n]{0,45}\bnot\b)[^.!?\n]{0,50}\b(?:submit|queue|start)\b[^.!?\n]{0,55}\b(?:once|one)\b/i;
const originalScope = /原(?:来的?)?(?:授权|范围|消息|要求)|original (?:authorization|scope|request)|as originally authorized/i;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const interruptedBeforeReply = task => !task.cancelRequested &&
  (task.result?.partial === true && /^Connection error\.?$/i.test(task.result.error || '') ||
    task.status === 'failed' && task.error?.code === 'MODEL_ERROR' && /^Connection error\.?$/i.test(task.error.message || ''));
const relevantEvents = (store, original) => store.listRecords('work-events').filter(event => event.kind === 'request' &&
  (event.requestTaskId === original.taskId || event.authorization?.source?.actor === original.actor &&
    event.authorization.source.roomId === original.roomId && event.authorization.source.replyTo === original.messageId));

export function readRecovery(store, user, originalTaskId) {
  const task = originalTaskId && store.getTask(originalTaskId);
  const original = task && currentUserRequest(task, store);
  if (!user?.roomId || !original || original.roomId !== user.roomId || original.actor !== user.actor ||
      original.taskId === user.taskId || !(Date.parse(original.roomMessageAt) < Date.parse(user.roomMessageAt))) return null;
  const route = store.getRecord('request-routing', task.id), originalRoom = taskSource(task, store).input?.room;
  const currentRoom = taskSource(store.getTask(user.taskId), store).input?.room;
  if (route?.intent !== 'produce' || route.workRelation !== 'new' || route.productionStage !== 'implementation' ||
      route.messageId !== original.messageId || route.roomId !== original.roomId || route.sourceActions?.length !== 1 ||
      originalRoom?.id !== user.roomId || currentRoom?.id !== user.roomId || originalRoom.goal !== currentRoom.goal ||
      originalRoom.team?.requirements !== currentRoom.team?.requirements) return null;
  const [action] = route.sourceActions;
  if (action.kind !== 'start' || action.stage !== 'implementation' || action.when !== 'now' ||
      action.basis !== 'direct' || action.separateOwner || action.dependencyUnit) return null;
  const id = { sourceTaskId: task.id, sourceMessageId: original.messageId, sourceUnit: action.unit, stage: action.stage,
    requestTaskId: user.taskId, requestMessageId: user.messageId, roomId: user.roomId };
  const events = relevantEvents(store, original);
  if (events.length) {
    const [event] = events;
    const accepted = events.length === 1 && event.receipt?.accepted && event.receipt.taskId &&
      event.authorization?.production?.sourceUnit === action.unit && event.authorization.production.stage === action.stage &&
      store.getRecord('works', event.workId);
    return { ...id, outcome: accepted ? 'already-accepted' : 'unconfirmed',
      ...(accepted ? { workId: event.workId, operationId: event.id } : {}) };
  }
  const attempts = store.listTools(task.id);
  const handoff = store.listRecords('work-handoffs').some(record => record.id.startsWith(`task:${task.id}:action:`)) ||
    store.listRecords('room-duty-plans').some(plan => plan.requestTaskId === task.id);
  const newer = store.listRecords('request-routing').some(record => {
    if ([task.id, user.taskId].includes(record.id) || record.roomId !== original.roomId || !['produce', 'revise', 'control'].includes(record.intent)) return false;
    const candidate = store.getTask(record.id);
    const source = candidate && currentUserRequest(candidate, store);
    return source && source.actor === user.actor && Date.parse(source.roomMessageAt) > Date.parse(original.roomMessageAt) &&
      record.messageId !== original.messageId && !store.getRecord(from, record.id);
  });
  const authority = store.listRecords('production-sources').find(saved => saved.acceptedMessageId === original.acceptedMessageId &&
    saved.actions?.length === 1 && same(saved.actions[0], action) && !saved.continuationWorkId);
  const routed = attempts.some(tool => tool.name === 'request_decide' && tool.status === 'completed' &&
    tool.output?.details?.intent === 'produce' && tool.output.details.sourceUnit === action.unit);
  const noOtherWrites = attempts.every(tool => tool.effect === 'read' ||
    tool.name === 'request_decide' && tool.status === 'completed');
  const frozenApproval = !route.acceptanceUnconfirmed && !route.unresolvedAcceptances?.length &&
    (!authority?.approvalCandidate || route.acceptanceReceiptTaskId === task.id);
  return { ...id, outcome: interruptedBeforeReply(task) && routed && authority && frozenApproval &&
    noOtherWrites && !handoff && !newer ? 'unsubmitted' : 'unconfirmed' };
}

export function findProductionRecovery(store, user) {
  if (!user?.roomId || !existing.test(user.text) || !absent.test(user.text) || !originalScope.test(user.text)) return null;
  const currentTime = localTime(user.roomMessageAt);
  const matches = store.listRecords('request-routing').flatMap(record => {
    if (record.roomId !== user.roomId || record.id === user.taskId || record.intent !== 'produce' ||
        record.productionStage !== 'implementation' || record.workRelation !== 'new') return [];
    const sourceTask = store.getTask(record.id), original = sourceTask && currentUserRequest(sourceTask, store);
    const at = original && localTime(original.roomMessageAt);
    const time = at && at.slice(11, 16);
    const exact = original && (user.replyTo === original.messageId || user.text.includes(original.messageId) ||
      time && at.slice(0, 10) === currentTime?.slice(0, 10) && new RegExp(`(?<![0-9:])${time}(?::[0-9]{2})?(?![0-9:])`).test(user.text));
    if (!exact) return [];
    const plan = readRecovery(store, user, original.taskId);
    return plan ? [{ plan, original }] : [];
  });
  return matches.length === 1 ? matches[0] : null;
}

export function saveProductionRecovery(store, plan) {
  const old = store.getRecord(from, plan.requestTaskId);
  return old || store.putRecord(from, { ...plan, id: plan.requestTaskId });
}

export function verifiedProductionRecovery(store, plan) {
  const saved = plan && store.getRecord(from, plan.requestTaskId);
  const task = saved && store.getTask(saved.requestTaskId);
  const user = task && currentUserRequest(task, store);
  if (!user || saved.outcome !== 'unsubmitted' || !same(plan, saved)) return null;
  const current = readRecovery(store, user, saved.sourceTaskId);
  return current && current.sourceMessageId === saved.sourceMessageId && current.sourceUnit === saved.sourceUnit ? current : null;
}
