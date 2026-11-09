import { externalExecution } from './execution-evidence.mjs';

const fields = (value, keys) => value && Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
const parse = block => { try { return block?.type === 'text' ? JSON.parse(block.text) : null; } catch { return null; } };

// Read and project the same structured evidence slots. Indices are positions
// in the immutable original entry, not a search by title or a live re-read.
function evidenceGroups(message, value = parse(message.content?.[0])) {
  if (message.role !== 'user' || !value || (value.type !== 'work_input' && value.kind !== 'work_input')) return [];
  const groups = [];
  function visit(input) {
    if (!input || typeof input !== 'object') return;
    if (input.current !== undefined) {
      visit(input.current);
      if (Array.isArray(input.accumulated)) for (const item of input.accumulated) visit(item?.input);
    } else if (input.type === 'work_continuation') {
      visit(input.acceptedStep);
      visit(input.continuation);
    } else {
      const evidence = input.type === 'accepted_work_step' ? input.materials?.evidence : input.evidence;
      if (Array.isArray(evidence)) groups.push(evidence);
    }
  }
  visit(value.input);
  return groups;
}

export function savedWorkEvidence(message, index) {
  if (!Number.isSafeInteger(index) || index < 0) return undefined;
  for (const group of evidenceGroups(message)) {
    if (index < group.length) return group[index];
    index -= group.length;
  }
}

const operationReceipt = operation => fields(operation, ['operationId', 'action', 'status', 'threadId', 'turnId', 'attemptedAt', 'recordedAt', 'error', 'verificationOnly']);

function updateReceipt(work, previous, original) {
  const execution = externalExecution(work);
  const changes = Object.fromEntries(['goal', 'requirements', 'progress', 'checkpoint'].filter(key => work[key] !== undefined &&
    JSON.stringify(work[key]) !== JSON.stringify(previous?.[key])).map(key => [key, work[key]]));
  const bindings = work.bindings?.map(binding => {
    const current = binding.operations?.find(item => item.operationId === binding.operationId), latest = binding.operations?.at(-1);
    return { ...fields(binding, ['id', 'type', 'externalThreadId', 'turnId', 'operationId', 'status', 'observedAt']),
      current: operationReceipt(current), latestAttempt: latest && latest !== current ? operationReceipt(latest) : undefined };
  });
  return { type: 'work_update_receipt', id: work.id, status: work.status, revision: work.revision, updatedAt: work.updatedAt,
    waiting: fields(work.waiting, ['id', 'kind', 'operationId', 'bindingId', 'since', 'until', 'outcome', 'reason', 'question', 'taskId', 'dependencyWorkId', 'targetWorkId']),
    changes, bindings, execution: fields(execution, ['operationId', 'bindingId', 'threadId', 'turnId', 'transportStatus', 'externalReceived',
      'receiptRecordedAt', 'currentOperation', 'startedConfirmed', 'status']), executionOutcome: work.executionOutcome, lastError: work.lastError,
    acceptance: fields(work.acceptance, ['operationId', 'throughOperationId', 'turnId', 'acceptedAt']), warning: work.warning,
    original };
}

function notificationReceipt(notification, original) {
  const attachments = list => Array.isArray(list) ? list.map(item => fields(item, ['id', 'name'])) : undefined;
  const receipts = Array.isArray(notification.receipt) ? notification.receipt : notification.receipt ? [notification.receipt] : [];
  return { type: 'work_notification_receipt',
    ...fields(notification, ['id', 'notificationId', 'workId', 'taskId', 'executionEventId', 'operationId', 'resultKind', 'publication',
      'status', 'duplicate', 'roomId', 'botId', 'replyTo', 'sourceRefs', 'createdAt', 'deliveredAt', 'waiting', 'error', 'supersededBy']),
    attachments: attachments(notification.attachments), receipts: receipts.map(receipt => ({
      ...fields(receipt, ['id', 'messageId', 'roomId', 'createdAt', 'taskId', 'status', 'accepted', 'duplicate']),
      attachments: attachments(receipt.attachments),
    })), original };
}

/** Only the live work transcript is projected. S1, S3, the tool audit and the
 * executor's complete handoff stay intact. Appending a message never rewrites
 * the projection of an earlier message in the same visible window. */
export function projectWorkContext(entries, sessionId) {
  const evidence = new Map(), updates = new Map();
  return entries.map(({ message, entryId }) => {
    if (!entryId || message.isError || !['user', 'toolResult'].includes(message.role)) return message;
    if (message.role === 'toolResult' && !['work_update', 'work_notify'].includes(message.toolName)) return message;
    const block = message.content?.[0];
    if (message.role === 'user' && !block?.text?.startsWith('{"type":"work_input"') && !block?.text?.startsWith('{"kind":"work_input"')) return message;
    const value = parse(block);
    if (!value || typeof value !== 'object') return message;
    const original = { type: 'session', sessionId, entryId };
    let view;
    if (message.role === 'toolResult') {
      if (message.toolName === 'work_update' && value.id && Number.isInteger(value.revision)) {
        view = updateReceipt(value, updates.get(value.id), original);
        updates.set(value.id, value);
      } else if (message.toolName === 'work_notify' && value.workId && value.id) view = notificationReceipt(value, original);
    } else {
      let index = 0, changed = false;
      for (const group of evidenceGroups(message, value)) for (let i = 0; i < group.length; i++, index++) {
        if (!group[i]?.reference) continue;
        const text = JSON.stringify(group[i]);
        const seen = evidence.get(text);
        if (!seen) evidence.set(text, { ...original, section: 'evidenceItem', index });
        else {
          const reference = { sameValueAs: seen };
          if (JSON.stringify(reference).length < text.length) { group[i] = reference; changed = true; }
        }
      }
      if (changed) view = value;
    }
    return view ? { ...message, content: [{ ...block, text: JSON.stringify(view) }, ...message.content.slice(1)] } : message;
  });
}
