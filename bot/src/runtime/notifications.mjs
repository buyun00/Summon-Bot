import { externalExecution } from '../context/execution-evidence.mjs';

// Retain an old observation without replaying it after a newer, confirmed
// result from this same bound thread has actually been published.
export function notificationSupersession(record, work, publications, observation) {
  if (!['pending', 'unknown'].includes(record.status) || record.publication !== 'external' ||
    record.resultKind !== 'execution-ended' || !work || record.workId !== work.id || work.status !== 'completed' ||
    (Array.isArray(record.receipt) ? record.receipt.length : record.receipt)) return null;
  const current = externalExecution(work), outcome = work.executionOutcome;
  if (!current?.startedConfirmed || current.status !== 'completed' || outcome?.kind !== 'execution-ended' ||
    !outcome.finalConfirmed || outcome.operationId !== current.operationId || outcome.turnId !== current.turnId ||
    !work.checkpoint?.finalConfirmed || !(Date.parse(work.checkpoint.recordedAt) >= Date.parse(record.createdAt))) return null;
  const binding = work.bindings?.find(item => item.id === current.bindingId);
  const previous = record.sourceRefs?.find(ref => ref.type === 'codex' && ref.threadId === current.threadId &&
    ref.operationId && ref.operationId !== current.operationId && ref.turnId && ref.turnId !== current.turnId &&
    binding?.operations?.some(item => item.operationId === ref.operationId && item.threadId === ref.threadId && item.status === 'received'));
  if (!previous) return null;
  // A transport receipt can name the turn that was running when the send was
  // accepted. The terminal observation supplies the actual ended turn identity.
  const ended = observation?.content;
  if (observation?.workId !== work.id || observation.late !== false || ended?.source !== 'codex-desktop-connector' ||
    ended.status !== 'completed' || ended.operationId !== previous.operationId || ended.turnId !== previous.turnId ||
    ended.externalThreadId !== current.threadId) return null;
  const published = publications.find(item => item.workId === work.id && item.status === 'delivered' &&
    item.executionEventId === current.operationId && Date.parse(item.deliveredAt) >= Date.parse(record.createdAt) &&
    (Array.isArray(item.receipt) ? item.receipt.length > 0 : Boolean(item.receipt)) &&
    item.sourceRefs?.some(ref => ref.type === 'codex' && ref.threadId === current.threadId &&
      ref.operationId === current.operationId && ref.turnId === current.turnId));
  return published ? { notificationId: published.id, operationId: current.operationId, turnId: current.turnId } : null;
}

export function notificationParts(record) {
  const content = String(record.content || ''), parts = [];
  for (let offset = 0; offset < content.length;) {
    let end = Math.min(content.length, offset + 15000);
    const line = content.lastIndexOf('\n', end);
    if (end < content.length && line > offset + 7500) end = line + 1;
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1])) end--;
    parts.push({ roomId: record.roomId, content: content.slice(offset, end), replyTo: record.replyTo,
      clientId: offset ? `${record.id}:part:${parts.length + 1}` : record.id, workId: record.workId, purpose: 'fyi', eventType: 'work_result',
      sourceRefs: record.sourceRefs || [{ type: 'work', workId: record.workId, taskId: record.taskId }] });
    if (!offset && record.attachments?.length) parts.at(-1).attachments = record.attachments;
    offset = end;
  }
  return parts;
}
