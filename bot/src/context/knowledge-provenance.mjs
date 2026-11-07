import { taskSource } from './sources.mjs';
import { modelText } from './model-input.mjs';

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ids = value => [...String(value || '').matchAll(uuid)].map(item => item[0].toLowerCase());
const sourceIds = text => [...new Set(String(text).split('\n').filter(line => /消息|来源|引用|\b(?:message|source|reference)\b/i.test(line)).flatMap(ids))];
const identityKeys = new Set(['id', 'messageId', 'threadId', 'externalThreadId', 'turnId', 'operationId', 'projectId', 'workId', 'taskId', 'entryId']);
function identities(value, target = new Set()) {
  if (!value || typeof value !== 'object') return target;
  for (const [key, item] of Object.entries(value)) {
    if (identityKeys.has(key) && typeof item === 'string') for (const id of ids(item)) target.add(id);
    else if (item && typeof item === 'object') identities(item, target);
  }
  return target;
}
const error = message => Object.assign(new Error(message), { code: 'KNOWLEDGE_SOURCE_UNCONFIRMED', status: 409 });

// Validate generated source pointers against exact primary records. Never repair
// a similar UUID or turn a lossy knowledge/document quotation into an original.
export async function validateSourceText(sources, task, text, references = [], previous = '', sourceTasks = []) {
  const origin = sources.originTask(task), source = origin && taskSource(origin, sources.store);
  const known = identities(references), old = new Set(sourceIds(previous));
  const rooms = new Set([source?.roomId, ...references.filter(item => item.type === 'room').map(item => item.roomId)].filter(Boolean));
  for (const record of [task, ...sourceTasks].flatMap(item => sources.store.listTools(item.id))) if (record.status === 'completed' &&
    !['knowledge_read', 'knowledge_list', 'context_assemble'].includes(record.name)) identities(record.output?.details, known);
  const unverifiedUserClaims = [];
  for (const id of sourceIds(text)) {
    if (known.has(id) || old.has(id)) continue;
    let found = false;
    for (const roomId of rooms) {
      try { await sources.resolve({ type: 'room', roomId, messageId: id }, task); found = true; break; } catch {}
    }
    if (found) continue;
    // Plain user notes retain what the user actually said, as an assertion with
    // that author, rather than inventing proof for their supplied identifier.
    if (source?.actor === 'user' && ids(modelText(source.input?.trigger?.content ?? source.input)).includes(id)) {
      unverifiedUserClaims.push(id); continue;
    }
    throw error(`Internal source ${id} was not found at an authorized exact reference. Use the real source returned by a read, or omit the unsupported attribution.`);
  }
  return { unverifiedUserClaims };
}

export async function knowledgeProvenance(sources, task, args, note, kind) {
  const originTask = sources.originTask(task), origin = originTask && taskSource(originTask, sources.store);
  if (!origin) throw error('The original source is unavailable');
  const supplied = sources.references(args.references ?? args.evidence ?? args.reference, task);
  if (supplied.length > 20) throw error('Select at most 20 exact sources for one knowledge note');
  const selected = [], resolved = [];
  for (const value of supplied) {
    const valueRef = sources.reference(value, task);
    try { const record = await sources.resolve(valueRef, task); selected.push(record.reference); resolved.push(record); }
    catch (cause) { throw error(`Knowledge was not saved: ${cause.message}. Source pointers must exist and be accessible; prose and file labels are not verified references.`); }
  }
  // Owning-work reads are already actual observations. Preserve their operation
  // identity without asking a model to copy it from another tool result.
  for (const record of sources.store.listTools(task.id).filter(item => item.status === 'completed' && item.name === 'work_get').slice(-6)) {
    const workId = record.output?.details?.id;
    if (workId && !selected.some(item => item.type === 'work' && item.workId === workId)) {
      const recordView = await sources.resolve({ type: 'work', workId }, task);
      selected.push(recordView.reference); resolved.push(recordView);
    }
  }
  const originalReference = origin.roomId && origin.replyTo ? { type: 'room', roomId: origin.roomId, messageId: origin.replyTo } :
    { type: 'message', messageId: origin.messageId };
  const validation = await validateSourceText(sources, task, note, [originalReference, ...selected]);
  const owning = resolved.filter(item => item.authority === 'owning-work-state');
  const peer = origin.actor !== 'user';
  if (kind === 'finding' && peer) {
    if (!resolved.some(item => item.author === 'user' || ['owning-work-state', 'tool-observation'].includes(item.authority)))
      throw error('A peer opinion is not a verified finding. Read the relevant original user statement or primary runtime evidence before saving it.');
    if (/codex|线程|执行|\b(?:turn|operation|executor|thread)\b/i.test(note) && !owning.length)
      throw error('Execution attribution requires the owning work and operation. Read work_get/evidence_read for that work; a thread list or document cannot establish which request ran.');
    const listedThreads = new Set();
    for (const record of sources.store.listTools(task.id)) if (record.status === 'completed' && record.name === 'codex_threads') {
      const page = record.output?.details;
      for (const item of Array.isArray(page) ? page : page?.threads || page?.items || []) if (item.id || item.threadId) listedThreads.add(item.threadId || item.id);
    }
    for (const threadId of listedThreads) if (note.includes(threadId) && !owning.some(item =>
      item.content.bindings?.some(binding => binding.externalThreadId === threadId && binding.operationId === item.reference.operationId)))
      throw error(`Thread ${threadId} has no matching owning work/operation in the selected evidence. Keep its relation unconfirmed; do not use its existence to overturn another request's result.`);
  }
  return { references: selected, verification: { basis: peer ? 'primary-source-reads' : 'user-statement-and-source-reads',
    sourceAuthor: origin.actor, checkedAt: new Date().toISOString(), ...validation },
    sourceReads: sources.store.listTools(task.id).filter(item => item.status === 'completed' && item.effect === 'read')
      .slice(-20).map(item => ({ toolRunId: item.id, tool: item.name, observedAt: item.finishedAt })) };
}
