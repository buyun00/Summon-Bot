import { randomUUID } from 'node:crypto';
import { modelText, modelArgs, boundedNumber } from './model-input.mjs';
import { directoryProject, knowledgeProjectId } from './project-scope.mjs';
import { externalExecution } from './execution-evidence.mjs';
import { savedWorkEvidence } from './work-context.mjs';

const denied = message => { throw Object.assign(new Error(message), { status: 403, code: 'SOURCE_SCOPE_DENIED' }); };
export const HANDOFF_REFERENCES = 48;

// Expand only the exact saved observation named by this work's checkpoint.
// Derived progress and a transport receipt's older final remain separate.
function checkpointExternalResult(store, work, operationId) {
  const checkpoint = work.checkpoint, pointer = checkpoint?.evidence;
  if (!pointer?.observationId || !pointer.threadId || !pointer.turnId || pointer.operationId !== operationId) return null;
  const observation = store.getRecord('work-observations', pointer.observationId), content = observation?.content, final = content?.final;
  if (observation?.workId !== work.id || observation.taskId !== checkpoint.taskId || observation.late ||
      content?.source !== 'codex-desktop-connector' || content.workId !== work.id || content.operationId !== operationId ||
      content.externalThreadId !== pointer.threadId || content.turnId !== pointer.turnId ||
      !final?.confirmed || final.threadId !== pointer.threadId || final.turnId !== pointer.turnId || typeof final.text !== 'string') return null;
  return { authority: 'external-result', author: 'codex', observationId: observation.id, taskId: observation.taskId,
    workId: work.id, operationId, threadId: pointer.threadId, turnId: pointer.turnId, status: content.status,
    observedAt: observation.observedAt, externalObservedAt: content.state?.observedAt, checkpointRecordedAt: checkpoint.recordedAt,
    final, instruction: 'This is the saved original final for these exact operation/thread/turn IDs. Other receipt finals may belong to earlier turns. Preserve each result and its own IDs and times; do not relabel one turn as another.' };
}

// All authority comes from the accepted envelope, never a tool's source arguments.
export function taskSource(task, store) {
  const accepted = task.messageId && store.getMessage(task.messageId);
  const input = accepted?.content?.current || accepted?.content || task.input?.current || task.input;
  const form = task.workId && accepted?.from === 'controller' && accepted.kind === 'request' &&
    accepted.metadata?.actor === 'user' && accepted.metadata.sourceType === 'work-form' &&
    accepted.sourceMessageId === `work-form:${task.workId}`;
  return { taskId: task.id, messageId: accepted?.id || task.messageId, source: accepted?.from || task.source,
    conversationId: task.conversationId, actor: accepted?.metadata?.actor || task.metadata?.actor || task.source,
    accessActor: accepted?.metadata?.accessActor || task.metadata?.accessActor || accepted?.metadata?.actor || task.metadata?.actor || task.source,
    roomId: input?.room?.id || accepted?.metadata?.roomId || task.metadata?.roomId,
    replyTo: input?.trigger?.id || accepted?.metadata?.originMessageId || task.metadata?.originMessageId,
    receivedAt: accepted?.receivedAt || task.createdAt, input, metadata: accepted?.metadata || task.metadata,
    ...(form ? { formId: task.workId } : {}) };
}

export const sameKnowledgeSource = (left, right) => Boolean(left?.conversationId && left.conversationId === right?.conversationId &&
  (left.roomId || null) === (right.roomId || null) && left.source === right.source);

export function acceptedWorkTask(event, store) {
  const id = event?.receipt?.accepted ? event.receipt.taskId : event?.sourceTaskId;
  const task = id && store.getTask(id), message = task?.messageId && store.getMessage(task.messageId);
  if (!task || task.workId !== event.workId || message?.taskId !== task.id || message.workId !== event.workId || message.kind !== 'request') return null;
  if (event.receipt?.accepted) return task;
  return message.sourceMessageId === `work:${event.id}` && message.metadata?.authority === 'internal-event' &&
    message.metadata?.workEventId === event.id ? task : null;
}

// Follow only saved causal edges. A work's most recent source is never the
// authority for another action, even when both actions share a work/session.
export function workExecution(task = {}, store, visited = new Set()) {
  task = task.id ? store.getTask(task.id) || task : task;
  if (task.id && visited.has(task.id)) return {};
  if (task.id) visited.add(task.id);
  const input = task.input?.current || task.input;
  const eventId = task.metadata?.sourceType === 'external' ? input?.operationId :
    task.metadata?.executionEventId || task.metadata?.resumeEventId || task.metadata?.workEventId;
  let event = eventId && store.getRecord('work-events', eventId);
  if (event?.workId !== task.workId) event = null;
  // A supervisor's direct send has a durable tool ID, rather than a dispatch
  // event. Follow that exact tool's owning task; never use the latest work source.
  const sent = !event && task.metadata?.sourceType === 'external' && eventId && store.getTool?.(eventId);
  if (sent?.name === 'codex_send' && sent.workId === task.workId && sent.effect === 'external' &&
    !sent.executionRejected && !sent.executionReused) {
    const origin = store.getTask(sent.taskId);
    if (origin?.workId === task.workId && origin.id !== task.id) {
      const inherited = workExecution(origin, store, visited);
      if (inherited.authorization?.source) return { ...inherited, executionEventId: eventId,
        executionTaskId: origin.id, operationId: eventId, turnId: input?.turnId };
    }
  }
  const events = new Set();
  while (event && !events.has(event.id)) {
    events.add(event.id);
    const parentId = event.metadata?.executionEventId || event.metadata?.resumeEventId;
    if (!parentId || parentId === event.id) break;
    const parent = store.getRecord('work-events', parentId);
    if (!parent || parent.workId !== task.workId || events.has(parent.id)) return {};
    event = parent;
  }
  const parent = event?.requestTaskId && store.getTask(event.requestTaskId);
  const inherited = !event?.authorization && parent?.workId && parent.id !== task.id ? workExecution(parent, store, visited) : null;
  let authorization = event?.authorization || inherited?.authorization;
  const accepted = task.messageId && store.getMessage(task.messageId);
  const direct = !eventId && accepted?.kind === 'request' && !['internal', 'external'].includes(task.metadata?.sourceType) &&
    task.metadata?.authority !== 'internal-event';
  const sourceTask = parent && !parent.workId ? parent : direct ? task : null;
  if (!authorization && sourceTask) {
    const { input: original, ...source } = taskSource(sourceTask, store);
    authorization = { actionId: event?.id || `task:${sourceTask.id}`, requestTaskId: sourceTask.id, source };
  }
  return { executionEventId: inherited?.executionEventId || event?.id || (task.id ? `task:${task.id}` : undefined),
    executionTaskId: inherited?.executionTaskId || event?.receipt?.taskId || task.id,
    requestTaskId: authorization?.requestTaskId, actionId: authorization?.actionId, authorization,
    operationId: event?.transport ? event.id : undefined, turnId: input?.turnId };
}

export function publicMessage(message) {
  // Other Bots and quoted text keep their real author, never an assistant/user impersonation.
  return { role: 'user', content: [{ type: 'text', text: JSON.stringify({ type: 'published_room_message',
    reference: { type: 'room', roomId: message.roomId, messageId: message.id }, author: message.senderId,
    content: message.content, replyTo: message.replyTo || null, attachments: message.attachments || [],
    kind: message.kind, workId: message.workId || null, replyWorkId: message.replyWorkId || null, sourceRefs: message.sourceRefs || [], authority: 'published-history' }) }],
    source: { roomId: message.roomId, messageId: message.id, actor: message.senderId }, timestamp: Date.parse(message.createdAt) || 0 };
}

export class RuntimeSources {
  constructor({ store, call, workspace }) { Object.assign(this, { store, call, workspace }); }
  originTask(task) {
    const id = task.workId ? workExecution(task, this.store).requestTaskId : task.id;
    return id ? this.store.getTask(id) || (!task.workId ? task : null) : null;
  }
  project(work) {
    // A model's scopeRefs/name never establishes a project association. New
    // works use the resolved project; older bindings already accepted by the
    // Desktop connector retain their real selected target.
    return work?.project || (work?.bindings?.some(item => item.type === 'codex-desktop' && item.externalThreadId) &&
      work.executor?.target?.type === 'project' ? { id: work.executor.target.projectId } : null);
  }
  async contextProject(task) {
    const work = task.workId && this.store.getRecord('works', task.workId);
    const selected = this.project(work);
    if (selected) return selected;
    return this.workspace ? this.authorizeProject({ type: 'directory', cwd: this.workspace }, task) : null;
  }
  async registeredProject(item, task) {
    const project = { id: item.projectId || item.id, name: item.label || item.name, hostId: item.hostId || 'local' };
    if (item.hostId === 'local' && item.projectKind === 'local' && item.path) try {
      directoryProject(item.path);
      const directory = await this.callForSource('list_files', { path: item.path, maxEntries: 1, maxDepth: 0 }, task);
      if (directory.path) project.cwd = directoryProject(directory.path).cwd;
    } catch { /* The registered target alone does not establish directory equivalence. */ }
    return project;
  }
  async projectForHandoff(task, project) {
    if (!project?.id || project.cwd || project.id.startsWith('directory:') || project.hostId && project.hostId !== 'local') return project;
    // Older accepted work may only carry the native ID. Resolve its exact
    // scoped registration on a real handoff, without changing the work card.
    const page = await this.call('codex_projects', {}, task);
    const items = Array.isArray(page) ? page : page.projects || page.items || [];
    const matches = items.filter(item => (item.projectId || item.id) === project.id);
    return matches.length === 1 ? this.registeredProject(matches[0], task) : project;
  }
  async authorizeProject(target, task) {
    if (target?.type === 'directory') {
      directoryProject(target.cwd);
      const current = task.workId && this.project(this.store.getRecord('works', task.workId));
      if (current && knowledgeProjectId(current) !== directoryProject(target.cwd).id) denied('Directory is outside this work binding');
      const directory = await this.callForSource('list_files', { path: target.cwd, maxEntries: 1, maxDepth: 0 }, task);
      if (!directory.path) denied('The authorized directory could not be resolved');
      const project = directoryProject(directory.path);
      if (current && knowledgeProjectId(current) !== project.id) denied('Resolved directory is outside this work binding');
      return project;
    }
    if (target?.type !== 'project') return null;
    const current = task.workId && this.project(this.store.getRecord('works', task.workId));
    if (task.workId) {
      if (current?.id !== target.projectId) denied('Project is outside this work binding');
      return current;
    }
    const page = await this.call('codex_projects', {}, task);
    const items = Array.isArray(page) ? page : page.projects || page.items || [];
    const matches = items.filter(item => (item.projectId || item.id) === target.projectId || (item.label || item.name) === target.projectId);
    if (matches.length !== 1) denied('Choose one existing accessible project; the supplied name is not an authorization');
    return this.registeredProject(matches[0], task);
  }
  async memoryAccess(task) {
    const origin = this.originTask(task);
    if (!origin) return { rooms: [], works: [], projects: [], source: {} };
    const source = taskSource(origin, this.store);
    const rooms = source.roomId ? (task.workId ? await this.scopedCall('chatroom_list', {}, task, origin) :
      await this.callForSource('chatroom_list', {}, origin)).map(room => room.id) : [];
    const works = [];
    for (const work of this.store.listRecords('works')) {
      if (task.workId && work.id !== task.workId) continue;
      if (await this.canReadWork(work, origin, rooms)) works.push(work);
    }
    let currentProject, projectError;
    try { currentProject = await this.contextProject(task); } catch (error) { projectError = error.message; }
    return { rooms, works, projects: [...works.map(work => this.project(work)).filter(Boolean), ...(currentProject ? [currentProject] : [])],
      currentProject, projectError, source };
  }
  async memoryTarget(task, input = {}) {
    const args = modelArgs(input), access = await this.memoryAccess(task);
    const supplied = args.scopeId || (typeof args.scope === 'string' && /^(?:work|conversation|project):/.test(args.scope) ? args.scope : null);
    if (supplied) {
      const scope = this.store.getRecord('knowledge_scope', supplied);
      if (!scope || !(await this.knowledge(task, [scope], access)).length) denied('Knowledge belongs to another source scope');
      return scope;
    }
    const hint = args.workId || task.workId || taskSource(task, this.store).metadata?.referencedWorkId;
    const work = access.works.find(item => item.id === hint);
    if (args.workId && !work) denied('Work is outside this request');
    let project = args.projectId ? access.projects.find(item => item.id === args.projectId || item.name === args.projectId) : this.project(work) || access.currentProject;
    if (args.projectId && !project) project = await this.authorizeProject(args.projectId.startsWith('directory:') ?
      { type: 'directory', cwd: args.projectId.slice(10) } : { type: 'project', projectId: args.projectId }, task);
    const projectId = knowledgeProjectId(project);
    if (projectId && args.scope !== 'work' && args.scope !== 'room' && args.scope !== 'conversation')
      return { id: `project:${projectId}`, projectId, title: project.name || projectId,
        authorizations: [access.source], originConversationId: access.source.conversationId };
    if (args.scope === 'project') throw new Error(access.projectError || 'No authorized project directory is associated with this request.');
    if (work && (task.workId || args.workId || args.scope === 'work')) return { workId: work.id, conversationId: work.conversationId };
    const source = access.source;
    if (source.roomId && !access.rooms.includes(source.roomId)) denied('The original room is no longer accessible');
    if (!source.conversationId) denied('No authenticated conversation scope is available');
    return { conversationId: source.conversationId, roomId: source.roomId };
  }
  async callForSource(name, args, task) {
    return this.store.getTask(task.id)?.status === 'running' ? this.call(name, args, task) : this.scopedCall(name, args, task, task);
  }
  async rooms(task) {
    if (task.workId) return [];
    const source = taskSource(task, this.store);
    if (!source.roomId) return [];
    const rooms = await this.callForSource('chatroom_list', {}, task);
    return rooms.map(room => room.id);
  }
  async canReadWork(work, task, rooms) {
    if (!work) return false;
    if (task.workId) return task.workId === work.id;
    const source = taskSource(task, this.store);
    if (!rooms) rooms = await this.rooms(task);
    const permitted = item => item.roomId ? rooms.includes(item.roomId) : item.source === source.source && item.conversationId === source.conversationId;
    return Boolean(work.sources?.length && work.sources.every(permitted));
  }
  async requireWork(id, task) {
    const work = this.store.getRecord('works', id);
    if (!await this.canReadWork(work, task)) denied('Work is not accessible from this request');
    return work;
  }
  async lookupWork(id, task) {
    const suppliedId = typeof id === 'string' ? id.trim() : '';
    const exact = suppliedId && this.store.getRecord('works', suppliedId);
    if (exact && await this.canReadWork(exact, task)) return { work: exact,
      lookup: { suppliedId, canonicalId: exact.id, match: 'exact', found: true } };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefix = !uuid.test(suppliedId) && /^[0-9a-f]{8}(?:[0-9a-f-]{0,27})$/i.test(suppliedId);
    if (prefix) {
      const rooms = await this.rooms(task), candidates = [];
      for (const work of this.store.listRecords('works')) if (uuid.test(work.id) && work.id.toLowerCase().startsWith(suppliedId.toLowerCase()) && await this.canReadWork(work, task, rooms)) candidates.push(work);
      if (candidates.length === 1) return { work: candidates[0], lookup: {
        suppliedId, canonicalId: candidates[0].id, match: 'unique-accessible-prefix', found: true,
        instruction: 'This canonical ID came from an actual readable work, not a guessed UUID. Copy the full ID into subsequent references and actions.',
      } };
      return { lookup: { suppliedId, found: false, existence: 'unconfirmed', match: candidates.length ? 'ambiguous-prefix' : 'unresolved-prefix',
        candidates: candidates.map(work => ({ id: work.id, goal: work.goal })),
        instruction: 'This incomplete ID did not resolve to one accessible work. Read works_list or a known full source reference. Do not guess a UUID, select another work, infer nonexistence, or discard already established evidence.',
      } };
    }
    return { lookup: { suppliedId, found: false, existence: 'unconfirmed', match: exact ? 'not-accessible-from-this-source' : 'not-found-in-this-bot',
      instruction: 'This lookup did not obtain a readable work in this Bot/source. It is not proof that the work does not exist elsewhere, nor a contradiction of a previously read binding. Check the exact owning Bot and full source reference; other work is not a substitute.',
    } };
  }
  async sessions(task) {
    const rooms = await this.rooms(task), allowed = new Set([task.sessionId]);
    for (const session of this.store.listSessions()) {
      if (session.kind === 'maintenance' || session.kind === 'routing') continue;
      if (session.workId && await this.canReadWork(this.store.getRecord('works', session.workId), task, rooms)) allowed.add(session.id);
      if (!task.workId && rooms.includes(session.id.replace(/^room:/, ''))) allowed.add(session.id);
    }
    return [...allowed];
  }
  async knowledge(task, directory, access) {
    access ||= await this.memoryAccess(task);
    const permittedSource = source => source?.roomId ? access.rooms.includes(source.roomId) :
      source?.source === access.source.source && source?.conversationId === access.source.conversationId;
    return directory.filter(item => item.projectId ? access.projects.some(project => project.id === item.projectId ||
      knowledgeProjectId(project) === item.projectId && item.authorizations?.some(origin => sameKnowledgeSource(origin, access.source))) ||
      !task.workId && item.authorizations?.some(permittedSource) : item.workId ? access.works.some(work => work.id === item.workId) :
      item.conversationId === access.source.conversationId || !task.workId && access.rooms.includes(item.roomId || item.conversationId?.replace(/^room:/, '')));
  }
  grant(task, reference) {
    if (!task.workId) return null;
    const same = candidate => candidate?.type === reference.type && (reference.type === 'room' ?
      candidate.roomId === reference.roomId && candidate.messageId === reference.messageId : reference.type === 'session' ?
        candidate.sessionId === reference.sessionId && candidate.entryId === reference.entryId : reference.type === 'knowledge' ?
          candidate.scopeId === reference.scopeId : reference.type === 'work' ? candidate.workId === reference.workId &&
            candidate.operationId === reference.operationId : candidate.id === reference.id);
    return this.store.listRecords('work-events').findLast(event => event.workId === task.workId && event.requestTaskId &&
      [event.content?.originalRequest?.reference, ...(event.content?.evidence || []).map(item => item.reference)].some(same));
  }
  async scopedCall(name, args, task, sourceTask) {
    const id = `${task.workId}:source-read:${randomUUID()}`;
    const event = this.store.putRecord('work-events', { id, workId: task.workId, sourceTaskId: task.id,
      requestTaskId: sourceTask.id, status: 'reading', transport: { name, args }, createdAt: new Date().toISOString() });
    const value = await this.call(name, args, task, { operationId: id });
    this.store.putRecord('work-events', { ...event, status: 'read' });
    return value;
  }
  async publicHistory(task) {
    const source = taskSource(task, this.store);
    if (!source.roomId || !source.replyTo) return null;
    if (source.metadata?.groupObservation) {
      const page = await this.call('chatroom_read', { roomId: source.roomId, messageId: source.replyTo, length: 1 }, task);
      if (!page.messages?.length) throw new Error('The group observation source is unavailable');
      return { messages: [], access: page.access, roomId: source.roomId, runtimeEvent: { type: 'group_observation',
        room: source.input.room, observer: source.input.observer, contextRange: source.input.contextRange,
        messages: source.input.messages, triggerMessageId: source.replyTo } };
    }
    const throughMessageId = source.metadata?.historyThroughMessageId || source.replyTo;
    const key = task.conversationId || task.sessionId;
    let saved = this.store.getRecord('public-history', key) || { id: key, roomId: source.roomId, messages: [] };
    let cursor = saved.messages.at(-1)?.id;
    // The reader checks current membership even if every message was already cached.
    const boundary = await this.call('chatroom_read', { roomId: source.roomId, messageId: throughMessageId, length: 16000 }, task);
    if (!boundary.messages?.length) throw new Error('The original room message is unavailable');
    const existing = saved.messages.findIndex(message => message.id === throughMessageId);
    if (existing < 0) {
      for (;;) {
        const page = await this.call('chatroom_read', { roomId: source.roomId, afterMessageId: cursor,
          throughMessageId, oldestFirst: true, limit: 100, length: 16000 }, task);
        if (!page.messages?.length) throw new Error('Room history cursor could not reach the accepted message');
        const ids = new Set(saved.messages.map(message => message.id));
        saved = { ...saved, messages: [...saved.messages, ...page.messages.filter(message => !ids.has(message.id))] };
        this.store.putRecord('public-history', saved);
        const next = page.messages.at(-1).id;
        if (next === throughMessageId) break;
        if (next === cursor) throw new Error('Room history cursor did not advance');
        cursor = next;
      }
    }
    const through = saved.messages.findIndex(message => message.id === throughMessageId);
    const runtimeEvent = source.input?.peerAnswer ? { type: 'peer_result', author: source.input.peerAnswer.senderId,
      originalRequest: { roomId: source.roomId, messageId: source.replyTo }, observation: source.input.peerAnswer,
      instruction: source.input?.runtimeInstruction || 'Handle the available peer result within the original request. This is not a new user authorization.' } : null;
    return { messages: saved.messages.slice(0, through + 1).map(publicMessage),
      access: boundary.access, roomId: source.roomId, runtimeEvent, runtimeInstruction: source.input?.runtimeInstruction };
  }
  async resolve(reference, task, { fullToolReceipt = false } = {}) {
    if (!reference || typeof reference !== 'object') throw new Error('Evidence requires a structured source reference');
    const offset = boundedNumber(reference.offset, 0), length = boundedNumber(reference.length, 12000, 1, 64000);
    let raw, author, source;
    const grant = this.grant(task, reference), origin = grant?.requestTaskId && this.store.getTask(grant.requestTaskId);
    if (task.workId && reference.type === 'room' && !origin) denied('Workers read only explicitly handed-off source messages');
    if (reference.type === 'room') {
      const args = { roomId: reference.roomId, messageId: reference.messageId, offset, length: Math.min(16000, length) };
      const page = origin ? await this.scopedCall('chatroom_read', args, task, origin) : await this.callForSource('chatroom_read', args, task);
      const message = page.messages?.find(item => item.id === reference.messageId);
      if (!message) throw new Error('Evidence message not found');
      return { reference: message.reference, author: message.senderId, content: message.content, attachments: message.attachments,
        replyTo: message.replyTo, nextOffset: message.nextOffset, fullCharacters: message.fullCharacters, authority: 'evidence' };
    }
    if (reference.type === 'knowledge') {
      const scope = this.store.getRecord('knowledge_scope', reference.scopeId);
      if (!scope || !(await this.knowledge(origin || task, [scope])).length) denied('Knowledge belongs to another source scope');
      return { reference, ...(await this.readKnowledge(scope.id, { offset, length })), authority: 'sourced-memory' };
    }
    if (reference.type === 'work') {
      const work = await this.requireWork(reference.workId, origin || task);
      const events = this.store.listRecords('work-events').filter(item => item.workId === work.id && item.kind === 'request');
      const operationId = reference.operationId || work.waiting?.operationId || work.bindings?.find(item => item.type === 'codex-desktop')?.operationId || events.at(-1)?.id;
      const operation = operationId && this.store.getRecord('work-events', operationId);
      if (operationId && operation?.workId !== work.id) denied('Operation belongs to another work');
      if (reference.section === 'acceptedStep') {
        if (!operation?.content) throw new Error('Accepted operation source is unavailable');
        const text = JSON.stringify(operation.content);
        return { reference: { type: 'work', workId: work.id, operationId, section: 'acceptedStep', offset, length },
          author: operation.authorization?.source?.actor || 'runtime', authority: 'accepted-step-material',
          content: text.slice(offset, offset + length), fullCharacters: text.length,
          truncated: offset > 0 || offset + length < text.length, nextOffset: offset + length < text.length ? offset + length : null };
      }
      return { reference: { type: 'work', workId: work.id, ...(operationId ? { operationId } : {}) }, author: 'runtime', authority: 'owning-work-state',
        content: { workId: work.id, goal: work.goal, requirements: work.requirements, status: work.status, waiting: work.waiting, project: work.project,
          progress: work.progress, checkpoint: work.checkpoint, revision: work.revision, updatedAt: work.updatedAt, executionOutcome: work.executionOutcome,
          executor: work.executor, execution: externalExecution(work, operationId),
          operation: operation && { id: operation.id, createdAt: operation.createdAt, status: operation.status,
            requestTaskId: operation.requestTaskId, receipt: operation.receipt, executionReceipt: operation.executionReceipt },
          bindings: work.bindings, externalResult: checkpointExternalResult(this.store, work, operationId), observedAt: new Date().toISOString(),
          instruction: 'Status/revision/updatedAt describe the current owning work. updatedAt is a local state mutation time, not an external turn time. Progress/checkpoint are derived state with their own recordedAt and evidence pointer. An operation executionReceipt is a saved transport receipt whose final may describe an earlier turn than the current binding. Use the matching externalResult original when available, retaining all earlier turn results under their own IDs; otherwise preserve the gap without promoting progress to original text.' } };
    }
    if (reference.type === 'tool') {
      const record = this.store.getTool(reference.id);
      const owner = record && this.store.getTask(record.taskId);
      if (!owner || record.status !== 'completed') throw new Error('Completed source tool receipt not found');
      if (owner.workId) await this.requireWork(owner.workId, origin || task);
      else if (!(await this.sessions(origin || task)).includes(owner.sessionId)) denied('Tool receipt is outside this request');
      const content = { tool: record.name, args: record.args, output: record.output?.details, observedAt: record.finishedAt };
      if (fullToolReceipt && reference.offset === undefined && reference.length === undefined)
        return { reference: { type: 'tool', id: record.id }, author: 'runtime', authority: 'tool-observation', content };
      const text = JSON.stringify(content), end = offset + length;
      return { reference: { type: 'tool', id: record.id, offset, length }, author: 'runtime', authority: 'tool-observation',
        content: offset || text.length > length ? text.slice(offset, end) : content, fullCharacters: text.length,
        nextOffset: end < text.length ? end : null };
    }
    const permittedSession = async id => {
      if (!origin) return (await this.sessions(task)).includes(id);
      const session = this.store.getSession(id); if (!session || ['maintenance', 'routing'].includes(session.kind)) return false;
      const rooms = taskSource(origin, this.store).roomId ? (await this.scopedCall('chatroom_list', {}, task, origin)).map(room => room.id) : [];
      return session.workId ? this.canReadWork(this.store.getRecord('works', session.workId), origin, rooms) :
        session.id === origin.sessionId || rooms.includes(session.id.replace(/^room:/, ''));
    };
    if (reference.type === 'session') {
      if (!await permittedSession(reference.sessionId)) denied('Session is outside the current source scope');
      const index = Number(String(reference.entryId).replace(/^m:/, ''));
      const session = this.store.getSession(reference.sessionId);
      if (!Number.isInteger(index) || index < 0 || !session?.messages[index] || session.messages[index].role === 'system') throw new Error('Evidence entry not found');
      const message = session.messages[index];
      if (reference.section === 'evidenceItem') {
        const item = savedWorkEvidence(message, reference.index);
        if (!item?.reference) throw new Error('Saved work evidence item not found');
        raw = JSON.stringify(item); author = item.author; source = item.reference;
      } else if (reference.section === 'toolContent') {
        const block = message.content?.[0];
        if (message.role !== 'toolResult' || message.toolName !== 'codex_read' || message.isError || block?.type !== 'text')
          throw new Error('Saved Desktop history tool content not found');
        raw = block.text; author = 'runtime'; source = { tool: message.toolName, toolCallId: message.toolCallId };
      } else {
        raw = JSON.stringify(message); author = message.source?.actor || message.role; source = message.source;
      }
    } else if (reference.type === 'artifact') {
      const artifact = this.store.getArtifact(reference.id);
      if (!artifact || !artifact.workId || !await permittedSession(`work:${artifact.workId}`)) denied('Artifact is outside the current source scope');
      raw = JSON.stringify(artifact); author = artifact.botId;
    } else throw new Error('Unknown evidence reference type');
    return { reference: { ...reference, offset, length }, author, source, content: raw.slice(offset, offset + length),
      fullCharacters: raw.length, nextOffset: offset + length < raw.length ? offset + length : null, authority: 'evidence' };
  }
  reference(value, task) {
    if (value?.reference) return this.reference(value.reference, task);
    if (typeof value === 'string') {
      try { return this.reference(JSON.parse(value), task); } catch {}
      const room = /^room:(.+):([\w.-]+)$/.exec(value);
      if (room) return { type: 'room', roomId: room[1], messageId: room[2] };
      for (const tool of this.store.listTools(task.id).reverse()) {
        const messages = Array.isArray(tool.output?.details?.messages) ? tool.output.details.messages : [];
        const match = messages.find(item => item.id === value || item.reference?.messageId === value || `${item.reference?.sessionId}#${item.index}` === value);
        if (match?.reference) return match.reference;
      }
      const entry = /^(.+)#(\d+)$/.exec(value);
      if (entry) return { type: 'session', sessionId: this.store.getRecord('works', entry[1])?.conversationId || entry[1], entryId: `m:${entry[2]}` };
      return value;
    }
    if (!value || typeof value !== 'object') return value;
    const roomId = value.roomId || (value.messageId ? taskSource(task, this.store).roomId : undefined);
    const sessionId = value.sessionId || (value.workId ? this.store.getRecord('works', value.workId)?.conversationId :
      value.entryId !== undefined || value.index !== undefined ? task.sessionId : undefined);
    return { ...value, ...(roomId ? { roomId } : {}), ...(sessionId ? { sessionId } : {}),
      type: value.type || (value.scopeId ? 'knowledge' : roomId ? 'room' : sessionId ? 'session' : value.id ? 'artifact' : undefined),
      ...(value.entryId === undefined && value.index !== undefined ? { entryId: `m:${value.index}` } : {}) };
  }
  references(value, task) {
    if (Array.isArray(value)) return value.flatMap(item => this.references(item, task));
    if (typeof value !== 'string') return value ? [value] : [];
    try { const parsed = JSON.parse(value); if (parsed !== value) return this.references(parsed, task); } catch {}
    // Prose may name exact references just returned in this turn. Recover only
    // those known pointers, then recheck each source's current authorization.
    const found = new Map();
    for (const tool of this.store.listTools(task.id)) {
      if (tool.status !== 'completed') continue;
      for (const item of tool.output?.details?.messages || []) {
        const ref = item.reference;
        const names = [item.id, ref?.messageId, ref?.sessionId && `${ref.sessionId}#${item.index}`,
          ref?.sessionId?.startsWith('work:') && `${ref.sessionId.slice(5)}#${item.index}`].filter(Boolean);
        if (ref && names.some(name => value.includes(name))) found.set(JSON.stringify(ref), ref);
      }
    }
    return found.size ? [...found.values()] : [value];
  }
  async handoff(task, input = {}) {
    const args = modelArgs(input), supplied = args.evidence ?? args.references ?? args.sourceRefs ?? [];
    const evidence = [...this.references(supplied, task), ...this.references(args.knowledgeScopes, task).map(scopeId =>
      typeof scopeId === 'string' ? { type: 'knowledge', scopeId } : scopeId)];
    const warnings = [];
    const source = taskSource(task, this.store);
    let original = { reference: source.roomId && source.replyTo ? { type: 'room', roomId: source.roomId, messageId: source.replyTo } : { type: 'message', messageId: source.messageId },
      author: source.actor, content: source.input?.trigger?.content ?? source.input, attachments: source.input?.trigger?.attachments || [], receivedAt: source.receivedAt };
    const event = task.metadata?.workEventId && this.store.getRecord('work-events', task.metadata.workEventId);
    const execution = task.workId && workExecution(task, this.store);
    const root = execution?.executionEventId && this.store.getRecord('work-events', execution.executionEventId);
    const inherited = event?.workId === task.workId ? event.content?.originalRequest || root?.content?.originalRequest : null;
    if (task.workId && inherited) original = inherited;
    if (source.roomId && source.replyTo) {
      try {
        const page = await this.call('chatroom_read', { roomId: source.roomId, messageId: source.replyTo, length: 16000 }, task);
        const message = page.messages?.[0];
        if (message) original = { ...original, reference: message.reference, author: message.senderId, content: message.content, attachments: source.input?.trigger?.attachments || message.attachments };
        else warnings.push({ source: original.reference, message: 'Using the accepted original request; room record is unavailable.' });
      } catch (error) { warnings.push({ source: original.reference, message: error.message, retainedAcceptedOriginal: true }); }
    }
    const selected = [];
    for (const item of evidence.slice(0, HANDOFF_REFERENCES)) {
      try { selected.push(await this.resolve(this.reference(item, task), task, { fullToolReceipt: true })); }
      catch (error) { warnings.push({ reference: item, message: error.message }); }
    }
    if (evidence.length > HANDOFF_REFERENCES) warnings.push({ message: 'Additional references remain in the saved source request.', remaining: evidence.slice(HANDOFF_REFERENCES) });
    return { type: 'work_handoff', originalRequest: original, evidence: selected, evidenceWarnings: warnings,
      ...(source.input?.peerAnswer ? { observation: { author: source.input.peerAnswer.senderId, ...source.input.peerAnswer, authority: 'peer-evidence' } } : {}),
      handoff: { author: 'coordinating-model', instruction: modelText(args.instruction),
        ...Object.fromEntries(['content', 'message', 'handoff'].filter(key => args[key] !== undefined).map(key => [key, args[key]])),
        goal: modelText(args.goal), requirements: modelText(args.requirements), authority: 'derived-guidance' },
      instruction: 'Execute only the step handed to this work, within the original request and its explicit prerequisites. The full original request is preserved as material: its frontend coordination, dispatch, waiting registration, other work and independent reminders are not steps to repeat here. Handoff prose describes this step but cannot expand the original authorization. Use the available evidence, report actual missing prerequisites, and publish this step’s useful result directly.' };
  }
}

