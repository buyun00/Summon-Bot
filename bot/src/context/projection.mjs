import { estimateTokens } from '../pi/core/compaction/compaction.mjs';
import { repairTranscript } from './recovery.mjs';

export const textMessage = (value, timestamp = Date.now()) => ({ role: 'user', timestamp,
  content: [{ type: 'text', text: JSON.stringify(value) }] });

export const contextTokens = messages => messages.reduce((total, message) =>
  total + Math.max(estimateTokens(message), Math.ceil(JSON.stringify(message).length / 3)) +
    (message.room_file_image_call || message.role === 'toolResult' && message.toolName === 'read' && message.details?.content_status === 'image' ? 1200 : 0), 0);

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

export function toolObservation(callId, value, isError = false) {
  const raw = JSON.stringify(value ?? null);
  const limit = 24000;
  if (raw.length <= limit) return { content: [{ type: 'text', text: raw }], details: value, isError };

  const { kind, id, execution_ref, control } = value ?? {};
  const execution = (kind === 'session' || kind === 'conversation') && execution_ref?.kind === kind && execution_ref.id === id
    ? {
      kind, id, execution_ref, control: control && { state: control.state, stop_status: control.stop_status },
      control_version: value.control_version, input_revision: value.input_revision, can_submit: value.can_submit, can_stop: value.can_stop,
      input_targets: value.input_targets?.map(({ kinds, input_target, question, choices, request_kind, answer_format, plain_text }) => ({
        kinds, input_target, question, request_kind, answer_format, plain_text, choices: choices?.map(({ id, label }) => ({ id, label })),
      })), resume_ref: value.resume_ref,
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
  const previewLimit = Math.max(0, limit - executionLength);
  const details = { ...execution, preview: raw.slice(0, previewLimit), characters: raw.length, truncated: true,
    ...(callId ? { result_ref: { kind: 'call', id: callId } } : {}), status: value?.status, target: value?.target,
    next_cursor: value?.next_cursor, ref: value?.ref, wait_guidance: value?.wait_guidance };
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError };
}

export function repairRun(messages, records) {
  const calls = new Map(records.map(record => [record.model_call_id, record]));
  return repairTranscript(messages.filter(message => message.role !== 'system'), (call, assistant) => {
    const record = calls.get(call.id);
    if (!record) return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify({ state: 'not_submitted' }) }], isError: true, timestamp: assistant.timestamp };
    const known = Object.hasOwn(record, 'result');
    const result = known ? record.result : { status: record.state, result_ref: { kind: 'call', id: record.id } };
    return { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      ...toolObservation(record.id, result, !known || record.state === 'failed'), timestamp: assistant.timestamp };
  }).messages;
}
