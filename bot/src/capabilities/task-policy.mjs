// Conversation authority is derived from durable task ownership, never model arguments.
export const CHAT_WORK_POLICY = 1;
const chatCoordination = new Set(['work_create', 'work_dispatch', 'work_update', 'tasks_cancel',
  'messages_send', 'chatroom_create', 'chatroom_send', 'chatroom_dm', 'chatroom_team_raise', 'chatroom_team_manage', 'routines_create']);
const chatHidden = new Set(['codex_read', 'artifact_save', 'state_get', 'state_set', 'messages_list', 'knowledge_write', 'skill_write']);
const workHidden = new Set(['work_create', 'messages_list', 'chatroom_list', 'chatroom_read', 'chatroom_create',
  'chatroom_send', 'chatroom_dm', 'chatroom_conclude', 'chatroom_team_raise', 'chatroom_team_manage']);
const maintenanceTools = new Set(['catalog_search', 'catalog_get', 'catalog_probe', 'catalog_skill_write', 'catalog_skill_propose']);

export function taskMode(task = {}) {
  return task.metadata?.routeOnly ? 'routing' : task.workId ? 'work' : 'chat';
}
export function permitsTool(task, tool) {
  const mode = taskMode(task);
  if (mode === 'routing') return tool.effect === 'read' && !chatHidden.has(tool.name);
  if (mode === 'work') return !workHidden.has(tool.name);
  if (chatHidden.has(tool.name)) return false;
  if (task.metadata?.notificationId && ['work_create', 'work_dispatch', 'messages_send', 'chatroom_dm', 'routines_create'].includes(tool.name)) return false;
  return tool.effect === 'read' || chatCoordination.has(tool.name) || tool.name === 'catalog_call';
}
export function assertToolPolicy(task, tool, args = {}) {
  const deny = message => { throw Object.assign(new Error(message), { status: 403, code: 'TOOL_POLICY_DENIED' }); };
  if (!permitsTool(task, tool)) deny(`${taskMode(task)} conversation cannot use ${tool.name}`);
  if (taskMode(task) === 'chat' && tool.name === 'work_update' && Object.keys(args).some(key => !['id', 'status', 'expectedRevision'].includes(key))) {
    deny('Chat may pause/cancel work; send requirements to its execution context with work_dispatch');
  }
  if (taskMode(task) === 'chat' && tool.name === 'work_update' && !['paused', 'cancelled'].includes(args.status)) deny('Only the worker records execution progress and completion');
  if (taskMode(task) === 'work' && ['work_get', 'work_update', 'work_dispatch', 'work_wait', 'work_notify'].includes(tool.name) && args.id !== task.workId) {
    deny('A worker only manages its own work');
  }
  if (taskMode(task) === 'work' && tool.name === 'work_update' && (args.sources || args.notifications)) deny('Work cannot change its authorization sources or result recipients');
  if (taskMode(task) === 'work' && tool.name.startsWith('codex_') && args.workId && args.workId !== task.workId) deny('Codex execution belongs to the current work only');
}
export const permitsMaintenanceTool = name => maintenanceTools.has(name);
export function workInput(input) {
  if (!input || typeof input !== 'object') return input;
  if (input.current !== undefined) return { current: workInput(input.current), accumulated: input.accumulated?.map(item => ({
    taskId: item.taskId, source: item.source, input: workInput(item.input) })) };
  if (input.room || input.messages) return { type: 'work_instruction', instruction: input.trigger?.content || input.peerAnswer?.answer || input.goal,
    attachments: input.trigger?.attachments, sourceRefs: { messageId: input.trigger?.id, actor: input.metadata?.actor } };
  return input;
}
export function scopedHistoryMessage(message, work = false) {
  if (message.role === 'system') return null;
  if (!work && message.role === 'toolResult') return null;
  if (!work && message.role === 'assistant') {
    if (message.content?.some?.(item => item.type === 'toolCall')) return null;
    const content = message.content?.filter?.(item => item.type === 'text');
    return content?.length ? { ...message, content } : null;
  }
  if (work && message.role === 'user') {
    const raw = typeof message.content === 'string' ? message.content : message.content?.map(item => item.text || '').join('');
    try {
      const envelope = JSON.parse(raw);
      if (envelope.room || envelope.messages) return { ...message, content: [{ type: 'text', text: JSON.stringify({
        type: 'work_instruction', instruction: envelope.trigger?.content || envelope.peerAnswer?.answer || envelope.goal,
        attachments: envelope.trigger?.attachments, source: message.source }) }] };
    } catch {}
  }
  return message;
}
export function frontendObservation(output) {
  const raw = JSON.stringify(output);
  if (raw.length <= 12000) return output;
  const details = { preview: raw.slice(0, 10000), truncated: true, fullCharacters: raw.length,
    instruction: 'Narrow the query or read a bounded fragment. Production details stay in independent work.' };
  return { content: [{ type: 'text', text: JSON.stringify(details) }], details, ...(output.isError ? { isError: true } : {}) };
}
export const compactWork = work => work && ({ id: work.id, goal: String(work.goal || '').slice(0, 600), status: work.status,
  progress: String(work.progress || '').slice(0, 1200), waiting: work.waiting && { kind: work.waiting.kind, until: work.waiting.until },
  responsibility: work.responsibility, lastTaskId: work.lastTaskId, updatedAt: work.updatedAt, revision: work.revision });
export const compactTask = task => task && ({ id: task.id, workId: task.workId, status: task.status,
  createdAt: task.createdAt, finishedAt: task.finishedAt, handoff: task.result?.handoff,
  summary: String(task.result?.content || task.error?.message || '').slice(0, 1200) });
export function conversationPrompt(task) {
  return taskMode(task) === 'work'
    ? 'You are the isolated execution conversation of this Bot. Perform only the goal and requirements of the current work. You do not participate in user chat, read room conversation feeds, or send chat messages. Record actual progress and results in this work; work_notify returns a concise result to the frontend coordinator. The runtime delivers the result. Do not recreate this work or answer unrelated conversation. Use Codex when appropriate and preserve external operation identities.'
    : 'You are the frontend conversation of this Bot. Only chat with the user, perform focused read-only research (including the web), clarify requirements, and coordinate independent work. Never produce project changes, files, commands, builds, deployments, or other execution here. Hand every production request to work_create with a self-contained goal, requirements, inputs and authorization. Reuse existing work for corrections. After handing off, end this execution immediately; do not perform any part of that work yourself. Read concise work/task status, not execution transcripts. For work_result events, explain the outcome briefly; the event is not a new assignment or permission to start work. Detailed production remains in the worker context.';
}
