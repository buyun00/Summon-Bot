import { estimateTokens } from '../pi/core/compaction/compaction.mjs';
import { repairTranscript } from './recovery.mjs';
import { runtimeFailure } from '../storage/runtime-records.mjs';

export const textMessage = (value, timestamp = Date.now()) => ({ role: 'user', timestamp,
  content: [{ type: 'text', text: JSON.stringify(value) }] });

export const contextTokens = (messages, calibrationRatio = 1) => {
  const ratio = Number.isFinite(calibrationRatio) && calibrationRatio >= 0.6 && calibrationRatio <= 2.5 ? calibrationRatio : 1;
  const raw = messages.reduce((total, message) =>
    total + Math.max(estimateTokens(message), Math.ceil(JSON.stringify(message).length / 3)) +
      (message.role === 'toolResult' && message.toolName === 'read' && message.details?.content_status === 'image' ? 1200 : 0), 0);
  return Math.ceil(raw * ratio);
};

export function isRoomMessageEvent(event, roomId) {
  return event?.type === 'message' && (event.space?.kind === 'room' || Boolean(event.roomId)) &&
    (!roomId || (event.space?.id ?? event.roomId) === roomId);
}

export function normalizeRoomMessage(event) {
  const roomId = event.space?.id ?? event.roomId;
  return {
    id: event.id,
    kind: 'event',
    type: 'message',
    space: { kind: 'room', id: roomId },
    sequence: event.sequence,
    time: event.time ?? event.createdAt,
    author: event.author,
    text: event.text ?? event.content ?? '',
    attachments: event.attachments ?? [],
    references: event.references ?? [],
    mentions: event.mentions ?? [],
    reply_to: event.reply_to ?? event.replyTo ?? null,
  };
}

export function roomMessageInput(event) {
  const normalized = normalizeRoomMessage(event);
  return { type: 'room_message', event: normalized, ref: { kind: 'event', id: normalized.id } };
}

export function eventInput(event, current = true) {
  if (isRoomMessageEvent(event)) return roomMessageInput(event);
  return { type: current ? 'current_event' : 'historical_entry', event,
    ref: event.history_ref || { kind: 'event', id: event.id } };
}

// A whole-entry cursor points past the named entry. A fragment cursor points
// inside its serialized message, so even a single large tool result is pageable.
export function transcriptPage(entries, cursor, limit, following = null) {
  let id = cursor, offset = 0;
  if (typeof cursor === 'string' && cursor.startsWith('fragment:')) {
    try { [id, offset] = JSON.parse(cursor.slice(9)); } catch { offset = -1; }
    if (!Number.isSafeInteger(offset) || offset <= 0) throw runtimeFailure('cursor_expired', 'Invalid transcript offset');
  }
  const position = cursor == null ? -1 : entries.findIndex(entry => entry.id === id);
  if (cursor != null && position === -1) throw runtimeFailure('cursor_expired', 'The transcript cursor is not available');
  let index = offset ? position : position + 1;
  const messages = [];
  let remaining = 12000;
  while (index < entries.length && messages.length < limit) {
    const entry = entries[index];
    const size = JSON.stringify(entry).length + 1;
    if (!offset && size <= remaining) {
      messages.push(entry);
      remaining -= size;
      index++;
      continue;
    }
    if (messages.length) break;
    const source = JSON.stringify(entry.message);
    if (offset >= source.length) throw runtimeFailure('cursor_expired', 'The transcript entry has changed');
    // JSON escaping can expand each UTF-16 code unit to six characters.
    let end = Math.min(source.length, offset + 1900);
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
    messages.push({ id: entry.id, run_id: entry.run_id, message_fragment: source.slice(offset, end),
      encoding: 'json', offset, total_characters: source.length });
    if (end < source.length) return { messages, next_cursor: 'fragment:' + JSON.stringify([entry.id, end]) };
    index++;
    break;
  }
  return { messages, next_cursor: index < entries.length ? messages.at(-1)?.id : following };
}

export function toolObservation(callId, value, isError = false) {
  const raw = JSON.stringify(value ?? null);
  const limit = 24000;
  if (raw.length <= limit) return { content: [{ type: 'text', text: raw }], details: value, isError };

  const { kind, id, execution_ref, control } = value ?? {};
  const execution = (kind === 'session' || kind === 'conversation') && execution_ref?.kind === kind && execution_ref.id === id
    ? {
      kind, id, execution_ref, control: control && { state: control.state, stop_status: control.stop_status },
      acceptance_state: value.acceptance_state,
      control_version: value.control_version, input_revision: value.input_revision, can_submit: value.can_submit, can_stop: value.can_stop,
      input_targets: value.input_targets?.map(({ kinds, input_target, question, choices, request_kind, answer_format, plain_text }) => ({
        kinds, input_target, question, request_kind, answer_format, plain_text, choices: choices?.map(({ id, label }) => ({ id, label })),
      })),
    } : undefined;
  let executionLength = execution ? JSON.stringify(execution).length : 0;
  if (executionLength > limit) {
    const descriptions = (execution.input_targets ?? []).flatMap(target => [
      [target, 'question'], ...(target.choices ?? []).map(choice => [choice, 'label']),
    ]).filter(([entry, field]) => typeof entry[field] === 'string')
      .sort(([a, aField], [b, bField]) => b[bField].length - a[aField].length);
    for (const [entry, field] of descriptions) {
      if (executionLength <= limit) break;
      const before = JSON.stringify(entry).length;
      const length = Math.max(0, entry[field].length - (executionLength - limit));
      entry[field] = entry[field].slice(0, length) || undefined;
      executionLength -= before - JSON.stringify(entry).length;
    }
  }
  if (execution && Array.isArray(value.messages) && (value.transcript_page || value.engine === 'pi' || kind === 'conversation') &&
      value.messages.every(item => typeof item?.run_id === 'string' && typeof item.id === 'string')) {
    const page = value.transcript_page ? { messages: value.messages, next_cursor: value.next_cursor } :
      transcriptPage(value.messages, null, value.messages.length, value.next_cursor);
    const details = { ...execution, status: value.status, ...page, result_ref: { kind: 'call', id: callId }, transcript_page: true };
    return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError };
  }
  const previewLimit = Math.max(0, limit - executionLength);
  const details = { ...execution, preview: raw.slice(0, previewLimit), characters: raw.length, truncated: true,
    ...(callId ? { result_ref: { kind: 'call', id: callId } } : {}), status: value?.status, target: value?.target,
    next_cursor: value?.next_cursor, ref: value?.ref, wait_guidance: value?.wait_guidance };
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError };
}

export function repairRun(messages, records) {
  const calls = new Map(records.map(record => [record.model_call_id, record]));
  const rejectedReads = new Set(messages.filter(message => message.role === 'toolResult' && message.toolName === 'read' &&
    message.details?.code === 'publication_target_required').map(message => message.toolCallId));
  const retained = messages.flatMap(message => {
    if (message.role === 'assistant' && message.transportFailure?.retryable && message.transportFailure.before_output) return [];
    if (message.role === 'system' || message.role === 'toolResult' && rejectedReads.has(message.toolCallId)) return [];
    if (message.role !== 'assistant' || !message.content.some(part => part.type === 'toolCall' && rejectedReads.has(part.id))) return [message];
    const content = message.content.filter(part => part.type !== 'toolCall' || !rejectedReads.has(part.id));
    return content.some(part => part.type !== 'thinking') ? [{ ...message, content }] : [];
  });
  return repairTranscript(retained, (call, assistant) => {
    const record = calls.get(call.id);
    if (!record) return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify({ state: 'not_submitted' }) }], isError: true, timestamp: assistant.timestamp };
    const known = Object.hasOwn(record, 'result');
    const result = known ? record.result : { status: record.state, result_ref: { kind: 'call', id: record.id } };
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      ...toolObservation(record.id, result, !known || record.state === 'failed'), timestamp: assistant.timestamp };
  }).messages;
}
