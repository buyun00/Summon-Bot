import { repairTranscript } from './recovery.mjs';
import { runtimeFailure } from '../storage/runtime-records.mjs';

// Derived from earendil-works/pi v1.3.0 (MIT, Copyright (c) 2025 Mario Zechner).
const ESTIMATED_IMAGE_CHARS = 4800;
function estimateTextAndImageContentChars(content) {
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content || []) {
    if (block.type === 'text' && block.text) chars += block.text.length;
    else if (block.type === 'image') chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

export function estimateTokens(message) {
  let chars = 0;
  switch (message?.role) {
    case 'system':
      chars = estimateTextAndImageContentChars(message.content);
      if (message.sections) for (const section of Object.values(message.sections)) if (section) chars += section.length;
      if (message.toolsAdded) chars += JSON.stringify(message.toolsAdded).length;
      return Math.ceil(chars / 4);
    case 'user':
    case 'custom':
    case 'toolResult':
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case 'assistant':
      for (const block of message.content || []) {
        if (block.type === 'text') chars += block.text.length;
        else if (block.type === 'thinking') chars += block.thinking.length;
        else if (block.type === 'toolCall') chars += block.name.length + JSON.stringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    case 'bashExecution':
      return Math.ceil((message.command.length + message.output.length) / 4);
    case 'branchSummary':
    case 'compactionSummary':
      return Math.ceil(message.summary.length / 4);
  }
  return 0;
}

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

const chatTimeFormatter = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatChatTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  if (!Number.isFinite(ms)) return '';
  try { return chatTimeFormatter.format(new Date(ms)); } catch { return ''; }
}

export function normalizeRoomMessage(event) {
  const roomId = event.space?.id ?? event.roomId;
  const senderName = event.sender_name ?? event.senderName ?? null;
  return {
    id: event.id,
    kind: 'event',
    type: 'message',
    space: { kind: 'room', id: roomId },
    sequence: event.sequence,
    time: event.time ?? event.createdAt,
    author: event.author,
    ...(senderName ? { sender_name: senderName } : {}),
    text: event.text ?? event.content ?? '',
    attachments: event.attachments ?? [],
    references: event.references ?? [],
    mentions: event.mentions ?? [],
    reply_to: event.reply_to ?? event.replyTo ?? null,
    ...(event.prompt ? { prompt: event.prompt } : {}),
    ...(event.prompt_response || event.promptResponse ? { prompt_response: event.prompt_response ?? event.promptResponse } : {}),
    ...(event.prompt_answer || event.promptAnswer ? { prompt_answer: event.prompt_answer ?? event.promptAnswer } : {}),
  };
}

export function formatRoomMessage(event) {
  const msg = normalizeRoomMessage(event);
  const timeStr = formatChatTime(msg.time);
  const speaker = msg.author?.kind === 'user'
    ? '宿主'
    : msg.author?.kind === 'platform'
      ? '系统'
      : msg.sender_name
        ? `${msg.sender_name} (${msg.author?.id || 'bot'})`
        : (msg.author?.id || '成员');
  const header = `${timeStr ? `[${timeStr}] ` : ''}${speaker} [msg:${msg.id}]`;
  const meta = [];
  if (msg.reply_to) {
    const replyId = typeof msg.reply_to === 'string' ? msg.reply_to : msg.reply_to?.id;
    if (replyId) meta.push(`回复: msg:${replyId}`);
  }
  if (msg.mentions?.length) {
    const targets = msg.mentions.map(item => (typeof item === 'string' ? item : item?.id)).filter(Boolean);
    if (targets.length) meta.push(`提及: ${targets.join(', ')}`);
  }
  if (msg.attachments?.length) {
    const files = msg.attachments.map(file => (typeof file === 'string' ? `file:${file}` : `${file.name || file.id} (file:${file.id})`));
    meta.push(`附件: ${files.join(', ')}`);
  }
  if (msg.references?.length) {
    const refs = msg.references.map(item => (item?.kind === 'workspace_file'
      ? `${item.workspace_id}:${item.path}`
      : `${item?.kind || 'ref'}:${item?.id || ''}`));
    meta.push(`引用: ${refs.join(', ')}`);
  }
  if (msg.prompt) {
    const pKind = msg.prompt.kind || 'question';
    const pHead = [msg.prompt.title, msg.prompt.description].filter(Boolean).join(' — ');
    const qParts = (msg.prompt.questions || []).map(q => {
      const opts = (q.options || []).map(o => o.label).filter(Boolean);
      return opts.length ? `${q.label} [${opts.join(' / ')}]` : q.label;
    }).filter(Boolean);
    meta.push(`交互卡片(${pKind}): ${[pHead, ...qParts].filter(Boolean).join(' | ')}`);
  }
  if (msg.prompt_response) {
    const pr = msg.prompt_response;
    const summary = pr.skipped
      ? '已跳过'
      : (pr.answers || []).map(ans => {
          const vals = [...(ans.selected_labels || []), ...(ans.custom_text ? [ans.custom_text] : [])];
          return `${ans.label || ans.question_id}=${vals.join(' / ') || (ans.redacted ? '[隐私已安全提交]' : '—')}`;
        }).join('; ');
    meta.push(`卡片作答(针对 msg:${pr.prompt_message_id}): ${summary}`);
  }
  const lines = [header];
  if (meta.length) lines.push(`(${meta.join(' | ')})`);
  if (msg.text) lines.push(msg.text);
  return lines.join('\n');
}

export function roomChatMessage(event) {
  const ts = Date.parse(event.time ?? event.createdAt ?? '') || Date.now();
  return {
    role: 'user',
    timestamp: ts,
    content: [{ type: 'text', text: formatRoomMessage(event) }],
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
  let remaining = 65_536;
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
    let end = Math.min(source.length, offset + 16_000);
    if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1])) end--;
    messages.push({ id: entry.id, run_id: entry.run_id, message_fragment: source.slice(offset, end),
      encoding: 'json', offset, total_characters: source.length });
    if (end < source.length) return { messages, next_cursor: 'fragment:' + JSON.stringify([entry.id, end]) };
    index++;
    break;
  }
  return { messages, next_cursor: index < entries.length ? messages.at(-1)?.id : following };
}

export const DEFAULT_TOOL_OBSERVATION_LIMIT = 256_000;

export function toolObservationLimitFor(contextWindow) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return DEFAULT_TOOL_OBSERVATION_LIMIT;
  return Math.max(DEFAULT_TOOL_OBSERVATION_LIMIT, Math.min(512_000, Math.floor(contextWindow * 0.6)));
}

export function toolObservation(callId, value, isError = false, limit = DEFAULT_TOOL_OBSERVATION_LIMIT) {
  const raw = JSON.stringify(value ?? null);
  if (raw.length <= limit) return { content: [{ type: 'text', text: raw }], details: value, isError };

  const { kind, id, execution_ref, control } = value ?? {};
  const execution = (kind === 'session' || kind === 'conversation') && execution_ref?.kind === kind && execution_ref.id === id
    ? {
      kind, id, execution_ref, control: control && { state: control.state, stop_status: control.stop_status },
      control_version: value.control_version, input_revision: value.input_revision,
      can_submit: value.can_submit, can_stop: value.can_stop,
      can_steer: value.can_steer, can_continue: value.can_continue,
      ...(value.pending_requests?.length ? { pending_requests: value.pending_requests } : {}),
    } : undefined;
  const executionLength = execution ? JSON.stringify(execution).length : 0;
  if (execution && Array.isArray(value.messages) && (value.transcript_page || value.engine === 'pi' || kind === 'conversation') &&
      value.messages.every(item => typeof item?.run_id === 'string' && typeof item.id === 'string')) {
    const page = value.transcript_page ? { messages: value.messages, next_cursor: value.next_cursor } :
      transcriptPage(value.messages, null, value.messages.length, value.next_cursor);
    const details = { ...execution, status: value.status, ...page, result_ref: { kind: 'call', id: callId }, transcript_page: true };
    return { content: [{ type: 'text', text: JSON.stringify(details) }], details, isError };
  }
  const previewLimit = Math.max(0, limit - executionLength);
  const fallbackCursor = value?.next_cursor ?? (kind === 'session' && value?.output !== undefined ? 'output:0' : null);
  const details = { ...execution, preview: raw.slice(0, previewLimit), characters: raw.length, truncated: true,
    ...(callId ? { result_ref: { kind: 'call', id: callId } } : {}), status: value?.status, target: value?.target,
    next_cursor: fallbackCursor, ref: value?.ref, wait_guidance: value?.wait_guidance };
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
