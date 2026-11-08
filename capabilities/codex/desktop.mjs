import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../shared/validation.mjs';
import { desktopExecutorState, requireDesktopExecutor } from '../../bot/src/capabilities/executor-connections.mjs';
import { modelText } from '../../bot/src/context/model-input.mjs';
import { codexTarget } from '../../bot/src/capabilities/codex-target.mjs';
import { directoryProject } from '../../bot/src/context/project-scope.mjs';

const now = () => new Date().toISOString();
const terminal = new Set(['completed', 'failed', 'interrupted', 'cancelled']);
const active = work => work.backend === 'desktop' && !terminal.has(work.status);
const requireText = (value, name) => { if (typeof value !== 'string' || !value.trim()) fail(`${name} is required`); return value; };
const errorView = error => ({ code: error.code || 'CONNECTOR_UNAVAILABLE', message: error.code ? error.message : 'Codex Desktop connector did not return a confirmed response.' });
const deliveryErrorView = error => ({ code: error.code || 'EVENT_DELIVERY_FAILED', status: error.status || null,
  message: String(error.message || 'Event delivery was not confirmed').slice(0, 700) });
const stateHeader = state => state && ({ threadId: state.threadId, status: state.status, stale: state.stale,
  observedAt: state.observedAt, currentTurn: state.currentTurn && { id: state.currentTurn.id, status: state.currentTurn.status,
    startedAt: state.currentTurn.startedAt, completedAt: state.currentTurn.completedAt, error: state.currentTurn.error },
  pendingRequests: (state.pendingRequests || []).slice(0, 8) });
// Raw snapshots/history stay in the connector store. The event is a bounded
// observation with exact pointers, not another copy of every tool output.
export function deliveryContent(event) {
  const { state, history, final, ...content } = event.content;
  return { ...content, state: stateHeader(state), ...(final ? { final: { ...final, text: String(final.text || '').slice(0, 24000),
    truncated: final.truncated || String(final.text || '').length > 24000 } } : {}),
    evidence: { eventId: event.id, workBindingId: event.workId, observedAt: content.observedAt || state?.observedAt,
      rawStored: true, historyAvailable: Boolean(history && !history.unavailable) } };
}
const rejected = error => error.result?.error?.details?.outcome !== 'unknown' &&
  !['operation_uncertain', 'idempotency_conflict'].includes(error.code) && Boolean(error.code) &&
  (error.status >= 400 && error.status < 500 && error.status !== 408 ||
    ['desktop_defaults_unavailable', 'unsupported_permission_default', 'permission_context_unavailable', 'unsupported_permission_host', 'caller_thread_required', 'unsupported_capability'].includes(error.code));
const turnStatus = state => state?.status === 'waiting_for_input' ? state.status : state?.currentTurn?.status || state?.status || 'unknown';
const progressText = item => ['agentMessage', 'assistantMessage', 'assistant'].includes(item?.type) &&
  ['commentary', 'comment'].includes(item.phase || item.channel) ? modelText(item.text ?? item.content ?? item.message).trim() : '';
function finalReply(state, threadId, turnId, history) {
  if (!turnId || state?.stale || state?.threadId !== threadId || state?.currentTurn?.id !== turnId) return null;
  const turn = history?.turns?.find(turn => (turn.turnId || turn.id) === turnId);
  const items = [...(state.items || []).filter(item => item.turnId === turnId && item.threadId === threadId),
    ...(turn?.items || []).filter(item => !item.turnId || item.turnId === turnId)];
  const replies = items.filter(item => ['agentMessage', 'assistantMessage', 'assistant'].includes(item.type) || item.role === 'assistant');
  const item = replies.findLast(item => ['final', 'final_answer'].includes(item.phase || item.channel)) ||
    (terminal.has(turnStatus(state)) || turnStatus(state) === 'waiting_for_input' ? replies.at(-1) : null);
  if (!item) return null;
  const value = item.text ?? item.message ?? (typeof item.content === 'string' ? item.content : item.content?.filter?.(part => ['text', 'output_text'].includes(part.type)).map(part => part.text).join('\n'));
  const text = modelText(value);
  return text.trim() || item.artifacts?.length ? { confirmed: true, text, threadId, turnId, itemId: item.id,
    truncated: Boolean(value?.truncated || item.truncated), artifacts: item.artifacts || [] } : null;
}

/** Durable transport for the existing Desktop connector. The owning Bot's work
 * remains the responsibility record; this store owns requests and event delivery. */
export class DesktopCodex {
  constructor({ store, dataRoot, manager, emit = () => {}, version }) {
    Object.assign(this, { store, dataRoot, manager, emit, version });
    this.streams = new Map(); this.serial = new Map(); this.closed = true;
  }
  list() { return this.store.list('works'); }
  bindingId(botId, workId) { const id = `${botId}:${workId}`; return this.store.get('works', id) ? id : workId; }
  require(id) { const work = this.store.get('works', id); if (!work) fail('External work binding not found', 404); return work; }
  get(id) {
    const work = this.require(id), operations = this.store.list('desktopOperations').filter(item => item.workId === id);
    const events = this.store.list('workEvents').filter(item => item.workId === id);
    const { snapshot, result, ...record } = work;
    return { ...record, snapshot: stateHeader(snapshot), result: result && { state: stateHeader(result.state), final: result.final },
      operationCount: operations.length, operations: operations.slice(-20).map(({ body, previousExecution, ...operation }) => operation),
      eventDelivery: { observedAt: now(), pending: events.filter(item => item.status === 'pending').length,
        preparing: events.filter(item => item.status === 'preparing').length, delivered: events.filter(item => item.status === 'delivered').length,
        lastError: events.findLast(item => item.status !== 'delivered' && item.deliveryError)?.deliveryError || null },
      events: events.slice(-10).map(event => ({ ...event, content: deliveryContent(event) })) };
  }
  assertScope(actor, workId, scope) {
    if (actor !== 'controller' && (scope?.botId !== actor || !scope.workIds?.includes(workId)))
      fail('Codex work is outside this Bot and authenticated room/work authorization', 403);
  }
  save(value) {
    const previous = this.store.get('works', value.id), work = this.store.save('works', value);
    if (!previous || ['status', 'externalThreadId', 'turnId', 'error', 'finishedAt'].some(key => Object.hasOwn(value, key) && JSON.stringify(previous[key]) !== JSON.stringify(work[key]))) {
      this.emit('work.updated', { work: { id: work.id, workId: work.workId, botId: work.botId, status: work.status, externalThreadId: work.externalThreadId, turnId: work.turnId, observedAt: work.observedAt } });
    }
    return work;
  }
  exclusive(id, action) {
    const pending = (this.serial.get(id) || Promise.resolve()).catch(() => {}).then(action);
    this.serial.set(id, pending); return pending.finally(() => { if (this.serial.get(id) === pending) this.serial.delete(id); });
  }
  async connection() {
    requireDesktopExecutor(this.dataRoot);
    return this.connector();
  }
  async connector() {
    const config = JSON.parse(await readFile(join(this.dataRoot, 'connectors', 'codex-desktop-api', 'config.json'), 'utf8'));
    const host = config.host || '127.0.0.1';
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) fail('The installed Desktop connector must use its configured local endpoint');
    return { url: `http://${host === '::1' ? '[::1]' : host}:${config.port || 47831}`, headers: { 'Content-Type': 'application/json', ...(config.auth?.bearerToken ? { Authorization: `Bearer ${config.auth.bearerToken}` } : {}) } };
  }
  async request(path, { method = 'GET', body, operationKey, signal } = {}) {
    const connection = await this.connection();
    return this.connectorRequest(connection, path, { method, body, operationKey, signal });
  }
  async connectorRequest(connection, path, { method = 'GET', body, operationKey, signal } = {}) {
    const response = await fetch(`${connection.url}${path}`, { method, headers: { ...connection.headers, ...(operationKey ? { 'Idempotency-Key': operationKey } : {}) }, redirect: 'error', signal: signal || AbortSignal.timeout(65000), ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Desktop API request failed'), { status: response.status, code: data.error?.code, result: data });
    return data;
  }
  // Called only by the user's manual connect action; it does not read usage.
  async connect({ managed = false } = {}) {
    const result = await this.connectorRequest(await this.connector(), '/v1/capabilities?connect=true', { signal: AbortSignal.timeout(18000) });
    if (!result.desktopConnected || !result.features?.createThread || managed && !result.permissionVerified) {
      const message = !result.desktopConnected ? 'Codex 桌面端暂不可连接。请打开 Codex 并检查本机端点。'
        : managed && !result.permissionVerified ? 'Codex 权限握手未完成。请打开使用默认权限的本机会话，再手动接入。'
        : 'Codex 桌面端没有提供所需的工作执行工具。';
      throw Object.assign(new Error(message), { expose: true, status: 409 });
    }
  }
  async projects(signal, scope, actor = 'controller') {
    if (actor === 'controller') return this.request('/v1/projects', { signal });
    if (scope?.botId !== actor) fail('Authenticated Codex scope is required', 403);
    const page = await this.request('/v1/projects', { signal });
    const items = Array.isArray(page) ? page : page.projects || page.items || [];
    const key = path => typeof path === 'string' ? resolve(path).toLowerCase() : null;
    const paths = new Set(scope.directories.map(key));
    const projects = items.filter(item => scope.projectIds.includes(item.projectId || item.id) ||
      [item.cwd, item.path, item.rootPath, ...(Array.isArray(item.roots) ? item.roots : []).map(root => typeof root === 'string' ? root : root.path)].some(path => path && paths.has(key(path))));
    return { projects: projects.map(item => ({projectId:item.projectId||item.id,label:item.label||item.name,
      path:item.path||item.cwd,hostId:item.hostId||'local',projectKind:item.projectKind})), scope: 'authorized-bot-source', exhaustive: false };
  }
  threads(signal, scope, actor = 'controller') {
    if (actor === 'controller') return this.request('/v1/threads?limit=50', { signal });
    if (scope?.botId !== actor) fail('Authenticated Codex scope is required', 403);
    // Do not even query the global Desktop directory for a Bot. Its own
    // bindings are the discovery source, including names and summaries.
    return { threads: this.list().filter(work => work.botId === actor && scope.workIds.includes(work.workId) && work.externalThreadId)
      .map(work => ({ threadId: work.externalThreadId, hostId: work.hostId, workId: work.workId,
        status: work.status, turnId: work.turnId, observedAt: work.observedAt })), scope: 'authorized-bot-source', exhaustive: false };
  }
  path(work, suffix = 'state') { return `/v1/threads/${encodeURIComponent(work.externalThreadId)}/${suffix}?hostId=${encodeURIComponent(work.hostId || 'local')}`; }
  async read(id, { history = false, signal } = {}) {
    requireDesktopExecutor(this.dataRoot);
    const work = this.require(id);
    if (work.backend !== 'desktop') return { ...this.get(id), historical: true, actionable: false };
    if (!work.externalThreadId) return this.get(id);
    const result = await this.request(this.path(work, history ? 'messages' : 'state') + (history ? '&limit=3&includeOutputs=true&maxOutputCharsPerItem=6000' : ''), { signal });
    if (!history) await this.exclusive(id, () => this.observe(id, result));
    return { work: this.get(id), observed: result };
  }
  async ownerWork(botId, workId) {
    return this.manager.request(botId, `/works/${encodeURIComponent(workId)}`);
  }
  async syncOwner(work) {
    const current = await this.ownerWork(work.botId, work.workId);
    const binding = { id: work.id, type: 'codex-desktop', operationId: work.operationId, operationKey: work.operationKey,
      executionOperationId: work.executionOperationId || null, externalThreadId: work.externalThreadId || null, pendingClientThreadId: work.pendingClientThreadId || null, hostId: work.hostId || 'local', turnId: work.turnId || null, previousTurnId: work.previousTurnId || null, status: work.status, observedAt: work.observedAt || null,
      observation: work.executionObservation || null,
      operations: this.store.list('desktopOperations').filter(item => item.workId === work.id).slice(-30).map(item => ({
        operationId: item.operationId, operationKey: item.operationKey, action: item.action, status: item.status,
        attemptedAt: item.attemptedAt, appliedAt: item.appliedAt || item.resultAppliedAt,
        threadId: item.result?.threadId || item.result?.thread?.id || work.externalThreadId,
        turnId: item.result?.turnId || null, error: item.error || item.result?.error,
        recordedAt: item.checkedAt || item.resultAppliedAt || item.attemptedAt })),
      ...(work.directoryTarget ? { target: work.directoryTarget } : {}) };
    await this.manager.request(work.botId, `/works/${encodeURIComponent(work.workId)}`, { method: 'PATCH', body: JSON.stringify({ expectedRevision: current.revision,
      ...(work.directoryTarget ? { project: { ...directoryProject(work.directoryTarget.cwd), nativeProjectId: work.directoryTarget.projectId,
        nativeRegistration: 'confirmed' } } : {}),
      bindings: [...(current.bindings || []).filter(item => item.id !== work.id), binding] }) });
    this.save({ id: work.id, ownerSyncPending: false, syncError: null });
  }
  async create(input) {
    requireDesktopExecutor(this.dataRoot);
    const workId = requireText(input.workId, 'workId'), botId = requireText(input.botId, 'botId');
    const id = `${botId}:${workId}`;
    return this.exclusive(id, async () => {
      const owner = await this.ownerWork(botId, workId);
      if (['cancelled', 'paused', 'archived'].includes(owner.status)) fail('The owning work is stopped', 409);
      const before = this.store.get('works', id);
      if (before && before.botId !== botId) fail('External work belongs to another Bot', 403);
      if (before && before.backend !== 'desktop') fail('Historical executor records cannot be submitted again', 409);
      const prompt = requireText(input.prompt, 'prompt');
      if (!input.target || !['project', 'projectless', 'directory'].includes(input.target.type)) fail('Use an authorized directory or explicit Desktop project target');
      if (!before) this.save({ id, workId, botId, conversationId: owner.conversationId, goal: owner.goal, backend: 'desktop', hostId: 'local', status: 'submitting', serviceVersion: this.version, roomId: input.roomId || null });
      if (before?.externalThreadId && before.operationId !== input.operationId) fail('This work is already bound; use codex_send to continue its thread', 409);
      return this.mutate(id, 'create', input.operationId, '/v1/threads', { prompt, target: codexTarget(input.target),
        model: owner.executor?.model || 'gpt-6.1-sol', thinking: owner.executor?.thinking || 'max' });
    });
  }
  async attach(input) {
    requireDesktopExecutor(this.dataRoot);
    const id = `${requireText(input.botId, 'botId')}:${requireText(input.workId, 'workId')}`;
    return this.exclusive(id, async () => {
      const owner = await this.ownerWork(input.botId, input.workId), prior = this.store.get('works', id);
      if (prior && (prior.botId !== input.botId || prior.externalThreadId !== input.threadId)) fail('This work already has a different external binding', 409);
      const threadId = requireText(input.threadId, 'threadId'), hostId = input.hostId || 'local';
      const state = await this.request(`/v1/threads/${encodeURIComponent(threadId)}/state?hostId=${encodeURIComponent(hostId)}`);
      const work = this.save({ id, workId: input.workId, botId: input.botId, conversationId: owner.conversationId, goal: owner.goal, backend: 'desktop', externalThreadId: threadId, hostId, status: 'watching', serviceVersion: this.version, turnId: state.currentTurn?.id || null, attachedAt: now() });
      await this.syncOwner(work); await this.observe(work.id, state); this.follow(work.id); return this.get(work.id);
    });
  }
  async send(id, input) {
    requireDesktopExecutor(this.dataRoot);
    return this.exclusive(id, async () => {
      const work = this.require(id); this.assertDesktop(work);
      const owner = await this.ownerWork(work.botId, work.workId);
      if (['cancelled', 'paused', 'archived'].includes(owner.status)) fail('The owning work is stopped', 409);
      const operationId = requireText(input.operationId, 'operationId'), message = requireText(input.message, 'message'), previous = this.operation(work, operationId);
      if (previous) {
        if (previous.action !== 'send' || previous.body.message !== input.message) fail('operationId already belongs to another request', 409);
        return this.reconcile(previous);
      }
      if (this.store.list('desktopOperations').some(item => item.workId === id && !item.appliedAt)) fail('An earlier write is still unconfirmed; inspect its original operation before another write', 409);
      if (['submitting', 'unknown'].includes(work.status)) fail('Resolve the existing unknown operation before sending another message', 409);
      const state = await this.request(this.path(work));
      if (state.stale || !state.currentTurn?.id) fail('Current turn is not confirmed; query before sending', 409);
      await this.observe(id, state);
      const oldItems = [...(state.items || []), ...(work.snapshot?.items || [])];
      const inFlight = state.currentTurn.status === 'inProgress';
      return this.mutate(id, 'send', operationId, `/v1/threads/${encodeURIComponent(work.externalThreadId)}/messages`, { message, hostId: work.hostId },
        { previousTurnId: state.currentTurn.id, allowPreviousTurn: inFlight, turnId: inFlight ? state.currentTurn.id : null,
          executionOperationId: inFlight ? work.executionOperationId || work.operationId : null,
          result: null, finishedAt: null, pendingProgress: inFlight ? this.require(id).pendingProgress : null,
          progressFloor: { turnId: state.currentTurn.id, itemIds: [...new Set(oldItems.map(item => item.id).filter(Boolean))],
            eventCursor: work.eventCursor || null, acceptedAfter: now() } });
    });
  }
  async interrupt(id, input) {
    requireDesktopExecutor(this.dataRoot);
    return this.exclusive(id, async () => {
      const work = this.require(id); this.assertDesktop(work);
      const operationId = requireText(input.operationId, 'operationId'), previous = this.operation(work, operationId);
      if (previous) {
        if (previous.action !== 'interrupt' || previous.body.expectedTurnId !== input.expectedTurnId) fail('operationId already belongs to another request', 409);
        return this.reconcile(previous);
      }
      const state = await this.request(this.path(work));
      if (!state.currentTurn?.id || state.stale) fail('Current turn must be known before interrupting', 409);
      if (input.expectedTurnId !== state.currentTurn.id) fail('expectedTurnId does not match the current Desktop turn', 409);
      return this.mutate(id, 'interrupt', operationId, `/v1/threads/${encodeURIComponent(work.externalThreadId)}/interrupt`, { expectedTurnId: input.expectedTurnId, hostId: work.hostId });
    });
  }
  assertDesktop(work) { if (work.backend !== 'desktop' || !work.externalThreadId) fail('This binding has no confirmed Desktop thread; inspect its original operation', 409); }
  operation(work, operationId) { return this.store.get('desktopOperations', `${work.botId}:${work.id}:${operationId}`); }
  async mutate(id, action, operationId, path, body, patch = {}) {
    const work = this.require(id); requireText(operationId, 'operationId');
    const previous = this.operation(work, operationId);
    if (previous) {
      if (JSON.stringify([previous.action, previous.path, previous.body]) !== JSON.stringify([action, path, body])) fail('operationId already belongs to another request', 409);
      return this.reconcile(previous);
    }
    if (this.store.list('desktopOperations').some(item => item.workId === id && !item.appliedAt)) fail('An earlier write is still unconfirmed; inspect its original operation before another write', 409);
    if (action === 'create' && this.store.list('desktopOperations').some(item => item.workId === id && item.action === 'create' && item.status !== 'failed')) fail('This work already has a create attempt; inspect or explicitly attach its actual thread instead of creating again', 409);
    const operation = this.store.transaction(() => {
      const operation = this.store.save('desktopOperations', { id: `${work.botId}:${id}:${operationId}`, workId: id, action, operationId, operationKey: randomUUID(), path, body, status: 'unknown', attemptedAt: null,
        previousExecution: action === 'send' ? Object.fromEntries(['operationId','operationKey','executionOperationId','turnId','previousTurnId','allowPreviousTurn','status','executionObservation','observationSignature','result','finishedAt','progressFloor','pendingProgress'].map(key => [key,work[key]??null])) : null });
      this.save({ id, ...patch, operationId, operationKey: operation.operationKey, executionObservation: null,
        status: action === 'interrupt' ? 'interrupt_requested' : 'submitting' });
      return operation;
    });
    return this.perform(operation);
  }
  async perform(operation) {
    const id = operation.workId;
    const work = this.require(id), owner = await this.ownerWork(work.botId, work.workId);
    if (operation.action !== 'interrupt' && ['cancelled', 'paused', 'archived'].includes(owner.status)) return this.get(id);
    // A pending intent with no attemptedAt has never crossed the transport boundary.
    // Persist both transport intent and the Bot binding before the first write.
    await this.syncOwner(work);
    this.store.save('desktopOperations', { id: operation.id, attemptedAt: now() });
    let result;
    try {
      result = await this.request(operation.path, { method: 'POST', body: operation.body, operationKey: operation.operationKey });
    } catch (error) {
      if (rejected(error)) return this.applyOperation(this.store.save('desktopOperations', {
        id: operation.id, status: 'failed', httpStatus: error.status, error: errorView(error),
        result: { error: error.result?.error || errorView(error), rejected: true } }));
      this.store.save('desktopOperations', { id: operation.id, status: 'unknown', error: errorView(error) });
      this.save({ id, status: 'unknown', error: errorView(error) });
      await this.queue(id, `operation:${operation.operationKey}:unknown`, { type: 'operation_unknown', operationKey: operation.operationKey, error: errorView(error) });
      return this.get(id);
    }
    return this.applyOperation(this.store.save('desktopOperations', { id: operation.id, status: 'received', result }));
  }
  async reconcile(operation) {
    if (['received', 'failed'].includes(operation.status)) return this.applyOperation(operation);
    if (!operation.attemptedAt) return this.perform(operation);
    // Even a missing remote key is not evidence that an earlier write is safe to replay.
    try {
      const result = await this.request(`/v1/operations/${encodeURIComponent(operation.operationKey)}`);
      if (['completed', 'failed'].includes(result.state)) return this.applyOperation(this.store.save('desktopOperations', { id: operation.id, status: result.state === 'completed' ? 'received' : 'failed', result: result.result, httpStatus: result.status }));
      this.store.save('desktopOperations', { id: operation.id, remoteState: result.state, checkedAt: now() });
    } catch (error) { this.store.save('desktopOperations', { id: operation.id, reconcileError: errorView(error), checkedAt: now() }); }
    return this.get(operation.workId);
  }
  async applyOperation(operation) {
    const work = this.require(operation.workId);
    if (operation.appliedAt) return this.get(work.id);
    if (!operation.resultAppliedAt) this.store.transaction(() => {
      if (operation.status === 'failed' || operation.result?.error) {
        const preserved = operation.action === 'send' && operation.previousExecution?.turnId;
        this.save({ id: work.id, ...(preserved ? operation.previousExecution : { status: 'failed', finishedAt: now() }),
          error: preserved ? null : operation.result?.error || { message: 'Desktop operation failed' },
          lastSubmissionError: { operationId: operation.operationId, error: operation.result?.error, recordedAt: now() } });
        this.queue(work.id, `operation:${operation.operationKey}:failed`, { type: 'operation_failed', operationId: operation.operationId,
          operationKey: operation.operationKey, status: 'failed', affectsExecution: !preserved,
          preservedOperationId: preserved ? operation.previousExecution.operationId : null,
          turnId: preserved ? operation.previousExecution.turnId : null, error: operation.result?.error, result: operation.result });
      } else {
        const result = operation.result || {}, threadId = result.threadId || result.thread?.id || work.externalThreadId;
        this.save({ id: work.id, externalThreadId: threadId || null, pendingClientThreadId: result.clientThreadId || null,
          ...(result.directoryTarget ? { directoryTarget: result.directoryTarget } : {}),
          ...(result.turnId ? { turnId: result.turnId } : {}), status: threadId ? (operation.action === 'interrupt' ? 'interrupt_requested' : 'watching') : 'unknown', receipt: result, error: null });
        if (!threadId) this.queue(work.id, `operation:${operation.operationKey}:binding`, { type: 'binding_unconfirmed', operationKey: operation.operationKey, receipt: result });
      }
      this.store.save('desktopOperations', { id: operation.id, resultAppliedAt: now() });
    });
    await this.syncOwner(this.require(work.id));
    this.store.save('desktopOperations', { id: operation.id, appliedAt: now() });
    this.follow(work.id); return this.get(work.id);
  }
  queue(id, key, content) {
    const work = this.require(id), eventId = `desktop:${id}:${key}`;
    if (!this.store.get('workEvents', eventId)) this.store.save('workEvents', { id: eventId, workId: id, botId: work.botId, content: { ...content, operationId: content.operationId || work.operationId,
      operationKey: content.operationKey || work.operationKey, workId: work.workId, externalThreadId: work.externalThreadId, hostId: work.hostId, source: 'codex-desktop-connector', authority: 'external-result' }, status: 'pending' });
    return this.store.get('workEvents', eventId);
  }
  collectProgress(id, turnId, items, provenance = {}) {
    const work = this.require(id);
    if (!turnId || work.snapshot?.stale || work.snapshot?.currentTurn?.id !== turnId || turnStatus(work.snapshot) !== 'inProgress') return;
    const prior = work.pendingProgress?.operationId === work.operationId && work.pendingProgress.turnId === turnId ? work.pendingProgress : null;
    const messages = new Map((prior?.items || []).map(item => [item.itemId, item]));
    let changed = false;
    for (const item of items) {
      const raw = progressText(item), text = raw.slice(-6000);
      // An append in the same active turn cannot adopt commentary which
      // already existed when that append was submitted, even after a replay.
      if (item.turnId !== turnId || item.threadId !== work.externalThreadId) continue;
      // Snapshots may restore a known item, but never make it new evidence for
      // an append. Source time/turn and first observation survive unchanged.
      if (provenance.snapshot && work.progressFloor?.itemIds.includes(item.id)) continue;
      if (!item.id || text.length < 32 || work.deliveredProgress?.[`${turnId}:${item.id}`] === text || messages.get(item.id)?.text === text) continue;
      messages.set(item.id, { itemId: item.id, threadId: item.threadId, turnId: item.turnId, text, ...provenance,
        evidenceKind: 'executor-commentary', completionConfirmed: false,
        occurredAt: item.occurredAt || null, observedAt: provenance.occurredAt || now(), firstObservedAt: item.firstObservedAt || null,
        requirementAdoptionConfirmed: false, truncated: Boolean(item.text?.truncated || raw.length > 6000) }); changed = true;
    }
    if (changed) this.save({ id, pendingProgress: { operationId: work.operationId, turnId, items: [...messages.values()].slice(-4), changedAt: now() } });
  }
  async flushProgress(id) {
    const work = this.require(id), pending = work.pendingProgress;
    if (!pending || Date.now() - Date.parse(pending.changedAt) < 4000 ||
      work.lastProgressAt && Date.now() - Date.parse(work.lastProgressAt) < 30000) return;
    if (turnStatus(work.snapshot) !== 'inProgress' || pending.turnId !== work.snapshot.currentTurn?.id) {
      this.save({ id, pendingProgress: null }); return;
    }
    const owner = await this.ownerWork(work.botId, work.workId);
    if (['paused', 'cancelled', 'completed'].includes(owner.status)) { this.save({ id, pendingProgress: null }); return; }
    const items = pending.items.filter(item => work.deliveredProgress?.[`${pending.turnId}:${item.itemId}`] !== item.text);
    if (!items.length) { this.save({ id, pendingProgress: null }); return; }
    // A stable native commentary item is evidence. Coalesce streaming deltas
    // and closely spaced milestones, with no timer-only model wake-ups.
    const revision = work.snapshot?.revision || work.eventCursor || now();
    const queued = this.store.list('workEvents').findLast(event => event.workId === id && event.status === 'pending' &&
      event.content?.type === 'external_progress' && event.content.operationId === work.operationId && event.content.turnId === pending.turnId);
    if (queued) this.store.save('workEvents', { id: queued.id, content: { ...queued.content, observedAt: work.observedAt,
      progress: { ...queued.content.progress, items: [...new Map([...queued.content.progress.items, ...items].map(item => [item.itemId, item])).values()].slice(-4) } } });
    else this.queue(id, `${work.operationKey}:progress:${pending.turnId}:${revision}`, { type: 'external_progress', status: 'inProgress', turnId: pending.turnId,
      progress: { confirmed: true, threadId: work.externalThreadId, turnId: pending.turnId, items }, observedAt: work.observedAt });
    const delivered = { ...work.deliveredProgress, ...Object.fromEntries(items.map(item => [`${pending.turnId}:${item.itemId}`, item.text])) };
    this.save({ id, pendingProgress: null, lastProgressAt: now(), deliveredProgress: Object.fromEntries(Object.entries(delivered).slice(-40)) });
    await this.syncOwner(this.require(id));
  }
  async observe(id, state) {
    const work = this.require(id), turnId = state.currentTurn?.id || null, status = turnStatus(state);
    const operation = work.operationId && this.operation(work, work.operationId);
    if (state.threadId && state.threadId !== work.externalThreadId) fail('Observation belongs to another Desktop thread', 409);
    if (!state.stale && state.observedAt && work.snapshot?.observedAt && Date.parse(state.observedAt) < Date.parse(work.snapshot.observedAt)) return;
    const stale = Boolean(state.stale || status === 'unknown');
    const relevantTurn = turnId && (work.turnId ? turnId === work.turnId :
      (!work.previousTurnId || turnId !== work.previousTurnId || work.allowPreviousTurn || work.status === 'interrupt_requested'));
    const effective = stale ? 'unknown' : relevantTurn ? status : 'watching';
    const signature = JSON.stringify([work.operationId, effective, relevantTurn ? turnId : null, state.pendingRequests || []]);
    const changed = signature !== work.observationSignature;
    const shouldNotify = changed && (terminal.has(effective) || effective === 'waiting_for_input' || state.pendingRequests?.length || effective === 'unknown');
    let event;
    this.store.transaction(() => {
      const saved = this.save({ id, snapshot: state, observedAt: now(), observationSignature: signature,
        executionOperationId: relevantTurn ? (work.turnId === turnId ? work.executionOperationId || work.operationId : work.operationId) : work.executionOperationId,
        executionObservation: { operationId: work.operationId, threadId: state.threadId || null, turnId,
          status, stale: stale || !relevantTurn, observedAt: state.observedAt || now(),
          submissionConfirmed: Boolean(operation?.appliedAt && operation.status === 'received' && !operation.result?.error) },
        ownerSyncPending: changed || work.ownerSyncPending, status: terminal.has(effective) || effective === 'waiting_for_input' ? effective : work.status === 'interrupt_requested' ? 'interrupt_requested' : effective === 'unknown' ? 'unknown' : 'running', ...(relevantTurn ? { turnId } : {}) });
      if (shouldNotify) {
        event = this.queue(id, `${work.operationKey || 'attach'}:${turnId || 'unknown'}:${effective}`, { type: 'external_status', status: effective, turnId: relevantTurn ? turnId : null, state,
          final: relevantTurn ? finalReply(state, work.externalThreadId, turnId) : null, history: null });
        if (!stale && relevantTurn) this.store.save('workEvents', { id: event.id, status: 'preparing' });
      }
    });
    if (terminal.has(effective)) this.save({ id, result: { state, history: null }, finishedAt: now() });
    if (relevantTurn && effective === 'inProgress') this.collectProgress(id, turnId, state.items || [], {snapshot:true});
    if (changed) await this.syncOwner(this.require(id));
  }
  follow(id) {
    const work = this.require(id);
    if (this.closed || !desktopExecutorState({ dataRoot: this.dataRoot }).enabled || this.streams.has(id) || !active(work) || !work.externalThreadId) return;
    const controller = new AbortController();
    const promise = this.consume(id, controller.signal).catch(async error => {
      if (!this.closed && !controller.signal.aborted) {
        this.save({ id, streamError: errorView(error), streamRetryAt: new Date(Date.now() + 15000).toISOString() });
      }
    }).finally(() => this.streams.delete(id));
    this.streams.set(id, { controller, promise });
  }
  async consume(id, signal) {
    const work = this.require(id), connection = await this.connection();
    const query = new URLSearchParams({ threadId: work.externalThreadId, hostId: work.hostId || 'local', ...(work.eventCursor ? { after: String(work.eventCursor) } : {}) });
    const response = await fetch(`${connection.url}/v1/events?${query}`, { headers: connection.headers, redirect: 'error', signal });
    if (response.status === 409) {
      this.save({ id, eventCursor: null, historyGap: { at: now(), reason: 'connector_event_retention' } });
      const snapshot = await this.request(this.path(work), { signal });
      await this.exclusive(id, () => this.observe(id, snapshot)); return;
    }
    if (!response.ok) throw new Error('Desktop event stream unavailable');
    let buffer = ''; const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      if (!desktopExecutorState({ dataRoot: this.dataRoot }).enabled) return;
      buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const line = frame.split('\n').find(value => value.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        await this.exclusive(id, async () => {
          const current = this.require(id);
          if (event.id && event.id <= (current.eventCursor || 0)) return;
          if (event.id) this.store.save('desktopEvents', { id: `${id}:${event.id}`, workId: id, event });
          if (event.type === 'thread.snapshot') await this.observe(id, event.data);
          else if (event.type === 'item.updated' && event.data?.turnId === current.snapshot?.currentTurn?.id && event.data.item) {
            const item = event.data.item;
            if (item.turnId !== event.data.turnId || item.threadId !== current.externalThreadId) return;
            const items = [...(current.snapshot.items || []).filter(value => value.id !== item.id), item].slice(-50);
            this.save({ id, snapshot: { ...current.snapshot, items, revision: event.data.revision || current.snapshot.revision }, observedAt: now() });
            this.collectProgress(id, event.data.turnId, [item], { eventId: event.id, occurredAt: event.at || event.createdAt || event.timestamp || null });
          }
          else if (['thread.status', 'thread.gap'].includes(event.type)) {
            // A turn change must obtain that turn's own items. Merging a new
            // currentTurn onto the previous turn's item array relabels history.
            const snapshot = event.type === 'thread.status' && event.data?.currentTurn?.id === current.snapshot?.currentTurn?.id
              ? { ...current.snapshot, ...event.data } : await this.request(this.path(current), { signal });
            await this.observe(id, snapshot);
          } else if (event.type?.startsWith('desktop.') && event.type !== 'desktop.connected') {
            await this.observe(id, { ...current.snapshot, stale: true, status: 'unknown' });
          }
          // Raw events and pending milestones persist before the cursor.
          if (event.id) this.save({ id, eventCursor: event.id });
          else if (event.type === 'stream.ready' && event.data?.cursor && !current.eventCursor) this.save({ id, eventCursor: event.data.cursor });
        });
        if (!active(this.require(id))) return;
      }
    }
  }
  async tick() {
    if (this.closed || this.ticking) return;
    if (!desktopExecutorState({ dataRoot: this.dataRoot }).enabled) {
      for (const stream of this.streams.values()) stream.controller.abort();
      return;
    }
    this.ticking = true;
    try {
      for (const operation of this.store.list('desktopOperations')) if (!operation.appliedAt) {
        try { await this.exclusive(operation.workId, () => this.reconcile(operation)); }
        catch (error) { this.store.save('desktopOperations', { id: operation.id, error: errorView(error), checkedAt: now() }); }
      }
      for (const work of this.list().filter(active)) {
        if (!work.externalThreadId) continue;
        if (!this.streams.has(work.id) && (!work.streamRetryAt || Date.parse(work.streamRetryAt) <= Date.now())) this.follow(work.id);
        if (!work.observedAt || Date.now() - Date.parse(work.observedAt) >= 60000) {
          try { const state = await this.request(this.path(work)); await this.exclusive(work.id, () => this.observe(work.id, state)); }
          catch (error) {
            try { await this.exclusive(work.id, () => this.observe(work.id, { ...work.snapshot, stale: true, status: 'unknown' })); }
            catch (failure) { this.save({ id: work.id, syncError: errorView(failure) }); }
          }
        }
      }
      for (const event of this.store.list('workEvents').filter(value => value.status === 'preparing')) {
        const work = this.require(event.workId); let history;
        try { history = await this.request(this.path(work, 'messages') + '&limit=3&includeOutputs=true&maxOutputCharsPerItem=6000'); }
        catch (error) { history = { unavailable: true, error: errorView(error) }; }
        this.store.transaction(() => {
          const final = event.content.final || finalReply(event.content.state, event.content.externalThreadId, event.content.turnId, history);
          this.store.save('workEvents', { id: event.id, content: { ...event.content, history, final }, status: 'pending' });
          if (terminal.has(event.content.status)) this.save({ id: work.id, result: { state: event.content.state, history, final } });
        });
      }
      for (const work of this.list().filter(value => value.backend === 'desktop' && value.pendingProgress)) {
        try { await this.exclusive(work.id, () => this.flushProgress(work.id)); }
        catch (error) { this.save({ id: work.id, syncError: errorView(error) }); }
      }
      for (const work of this.list().filter(value => value.backend === 'desktop' && value.ownerSyncPending)) {
        try { await this.exclusive(work.id, () => this.syncOwner(this.require(work.id))); }
        catch (error) { this.save({ id: work.id, syncError: errorView(error) }); }
      }
      for (const event of this.store.list('workEvents').filter(value => value.status === 'pending' && value.content?.source === 'codex-desktop-connector')) {
        try {
          const work = this.require(event.workId);
          const owner = this.manager.get(work.botId);
          if (owner.status !== 'active' || owner.runIntent === 'stopped') continue;
          const receipt = await this.manager.send(work.botId, { id: event.id, kind: 'event', workId: work.workId, conversationId: work.conversationId, sessionId: work.conversationId,
            metadata: { sourceType: 'external', externalBindingId: work.id, authority: 'external-result',
              finalizationOnly: terminal.has(event.content.status) && Date.parse(event.createdAt) < Date.parse(this.startedAt) }, content: deliveryContent(event) });
          this.store.save('workEvents', { id: event.id, status: 'delivered', receipt, deliveredAt: now() });
        } catch (error) { this.store.save('workEvents', { id: event.id, deliveryError: deliveryErrorView(error) }); }
      }
    } finally { this.ticking = false; }
  }
  async start() {
    if (!this.closed) return; this.closed = false; this.startedAt = now();
    const tick = () => { if (!this.ticking && !this.closed) this.tickPromise = this.tick().catch(error => this.emit('codex.connector.error', errorView(error))); };
    this.timer = setInterval(tick, 15000); this.timer.unref(); tick();
  }
  async stop() {
    this.closed = true; clearInterval(this.timer);
    const streams = [...this.streams.values()]; for (const stream of streams) stream.controller.abort();
    await Promise.allSettled([...streams.map(value => value.promise), this.tickPromise, ...this.serial.values()]);
  }
  get active() { return this.ticking || this.serial.size > 0; }
}
