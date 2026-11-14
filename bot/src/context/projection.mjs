import { estimateTokens } from '../pi/core/compaction/compaction.mjs';
import { repairTranscript } from './recovery.mjs';

export const textMessage = (value, timestamp = Date.now()) => ({ role: 'user', timestamp,
  content: [{ type: 'text', text: JSON.stringify(value) }] });

export const contextTokens = messages => messages.reduce((total, message) =>
  total + Math.max(estimateTokens(message), Math.ceil(JSON.stringify(message).length / 3)), 0);

export function eventInput(event, current = true) {
  return { type: current ? 'current_event' : 'historical_entry', event,
    ref: event.history_ref || { kind: 'event', id: event.id } };
}

export function toolObservation(callId, value, isError = false) {
  const raw = JSON.stringify(value ?? null);
  const limit = 24000;
  const details = raw.length <= limit ? value : { preview: raw.slice(0, limit), characters: raw.length, truncated: true,
    ...(callId ? { result_ref: { kind: 'call', id: callId } } : {}), status: value?.status, target: value?.target,
    next_cursor: value?.next_cursor, ref: value?.ref };
  return { content: [{ type: 'text', text: JSON.stringify(details ?? null) }], details, isError };
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
