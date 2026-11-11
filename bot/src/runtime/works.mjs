import { randomUUID } from 'node:crypto';
import { acceptedWorkTask, taskSource, workExecution } from '../context/sources.mjs';
import { modelText, boundedNumber, durationSeconds } from '../context/model-input.mjs';
import { isCliExecutor } from '../capabilities/executor-connections.mjs';
import { directoryProject } from '../context/project-scope.mjs';
import { externalExecution } from '../context/execution-evidence.mjs';
import { currentProductionStage, productionStage, requireProductionGrant } from '../capabilities/request-routing.mjs';
import { OWNER_DELIVERY, ROOM_DUTY_PLANS, matchesContributionGrant } from '../context/duty-actions.mjs';

const now = () => new Date().toISOString();
const statuses = new Set(['active', 'waiting', 'paused', 'blocked', 'completed', 'cancelled']);
const stopped = new Set(['paused', 'cancelled']);
const stopOutcomes = new Set(['local-stopped', 'interrupted', 'completed', 'failed', 'cancelled']);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const productionTarget = work => ({ projectId: work.project?.id ?? null, target: JSON.stringify(work.executor?.target || null),
  bindingId: work.bindings?.findLast(item => item.type === 'codex-desktop')?.id });

export function workFormReceipt(store, id, request) {
  const submission = store?.getRecord('work-form-submissions', id);
  if (!submission) return null;
  const work = store.getRecord('works', id), task = store.getTask(submission.taskId);
  const event = store.getRecord('work-events', submission.operationId);
  if (!work || task?.workId !== id || event?.receipt?.taskId !== task.id || !event.receipt.accepted)
    fail('工作表单已保存，但原派发回执当前不可读。请保留原工作标识。', 409);
  const original = store.getMessage(task.messageId)?.content?.originalRequest?.content;
  if (JSON.stringify(original) !== JSON.stringify(request))
    fail('本次表单标识已有受理记录，请打开原工作查看。', 409);
  return { work, dispatch: { ...event.receipt, operationId: event.id, receiptLayer: 'local-dispatch',
    status: task.status, duplicate: true } };
}

/** S3 is state and pointers only. Knowledge正文 lives in Markdown, never here. */
export class WorkService {
  constructor({ store, botId, accept, schedule, cancel, selectModel, selectExecutor, clean = value => value }) {
    Object.assign(this, { store, botId, accept, schedule, cancel, selectModel, selectExecutor, clean }); this.dispatches = new Map();
  }
  get(id) { return this.store.getRecord('works', id); }
  list({ status, query, limit = 100 } = {}) {
    return this.store.listRecords('works').filter(work => (!status || work.status === status) &&
      (!query || JSON.stringify([work.id, work.goal, work.requirements, work.sources]).toLowerCase().includes(modelText(query).toLowerCase())))
      .slice(-boundedNumber(limit, 100, 1, 500));
  }
  create(input, task = {}) {
    if (typeof input.goal !== 'string' || !input.goal.trim()) fail('Work requires a goal');
    const id = input.id || randomUUID();
    if (!/^[\w.-]{1,160}$/.test(id)) fail('Invalid work id');
    const sourceKey = task.id && !task.workId ? `task:${task.id}:action:${input.operationId || input.id}` : null;
    const handedOff = sourceKey && this.store.getRecord('work-handoffs', sourceKey);
    if (handedOff) return this.get(handedOff.workId);
    const previous = this.get(id);
    if (previous) {
      if (sourceKey) fail('This work ID belongs to a different action', 409);
      return previous;
    }
    const executor = input.executor || this.selectExecutor?.() || { kind: 'pi' };
    if (!['pi', 'codex'].includes(executor.kind) && !isCliExecutor(executor.kind)) fail('Unknown work executor');
    if (executor.kind === 'codex' && !['project', 'projectless', 'directory'].includes(executor.target?.type)) fail('Codex requires an authorized directory or selected project target');
    if (isCliExecutor(executor.kind) && executor.target) fail('这个工作引擎使用 Bot 的本机工作目录。');
    const project = executor.target?.type === 'directory' ? directoryProject(executor.target.cwd) : input.project || null;
    if (sourceKey) requireProductionGrant(task, this.store, input.productionAuthorization, {
      workId: id, actionId: `${id}:${input.operationId || 'initial'}`, relation: 'new', stage: input.productionStage,
      when: 'now', ...productionTarget({ project, executor }),
    });
    const supervisor = this.selectModel?.(executor.kind === 'pi' ? executor.connectionId : undefined);
    const binding = executor.kind === 'pi' ? { kind: 'pi', ...(executor.target ? { target: executor.target } : {}) } : executor;
    const eventId = `${id}:${input.operationId || 'initial'}`;
    const waiting = sourceKey && input.initialHandoff && input.contributionPlanId ? { kind: 'room-duty-contribution', operationId: eventId,
      reason: '等待同一请求的职责负责人交付制作所需部分。' } : null;
    const record = this.clean({ id, botId: this.botId, conversationId: `work:${id}`, goal: input.goal,
      requirements: input.requirements || '', executor: binding, supervisor, project, productionStage: input.productionStage || null, progress: '',
      status: waiting ? 'waiting' : 'active', waiting, bindings: [], notifications: [],
      sources: input.sources || (task.id ? [this.source(task)] : []),
      responsibility: input.responsibility || null, revision: 1, createdAt: now(), updatedAt: now() });
    this.store.transaction(() => {
      this.store.putRecord('works', record);
      if (sourceKey) this.store.putRecord('work-handoffs', { id: sourceKey, workId: id, createdAt: now() });
      if (input.initialHandoff) this.store.putRecord('work-events', { id: eventId, workId: id,
        kind: 'request', content: input.initialHandoff, requestTaskId: task.id, sourceTaskId: task.id,
        authorization: this.authorization(task, eventId, input.productionAuthorization), status: 'pending', createdAt: now(),
        ...(waiting ? { contributionPlanId: input.contributionPlanId } : {}) });
      this.store.appendEvent('work.created', { work: record }, { workId: id, conversationId: record.conversationId });
    });
    return record;
  }
  submitForm({ id, request, executor, project }) {
    const receipt = this.store.transaction(() => {
      const original = this.clean(request), prior = workFormReceipt(this.store, id, original);
      if (prior) return prior;
      if (this.get(id)) fail('此标识已属于已有工作，请查看原工作。', 409);
      const work = this.create({ id, goal: request.goal, requirements: [request.constraints, ...request.inputRefs].filter(Boolean).join('\n'),
        executor, project });
      const accepted = this.accept({ id: `work-form:${id}`, to: this.botId, kind: 'request', workId: id,
        metadata: { actor: 'user', sourceType: 'work-form', roomId: request.roomId || undefined, priority: 'foreground' },
        content: { originalRequest: { author: 'user', reference: { type: 'form', id }, content: original },
          handoff: { instruction: 'Execute only the explicit goal and constraints of this authenticated form. A formal document request authorizes its document and return, and implementation requires its own explicit request.' } } },
      'controller', { deferSchedule: true });
      const execution = this.execution(accepted.task);
      if (accepted.duplicate || !execution.authorization?.source?.formId) fail('工作表单的原始授权未能持久受理。', 409);
      this.store.putRecord('work-form-submissions', { id, taskId: accepted.task.id, operationId: execution.executionEventId });
      const saved = workFormReceipt(this.store, id, original);
      return { ...saved, dispatch: { ...saved.dispatch, duplicate: false } };
    });
    if (!receipt.dispatch.duplicate) this.schedule(this.store.getTask(receipt.dispatch.taskId));
    return receipt;
  }
  source(task) { const { input, ...source } = taskSource(task, this.store); return source; }
  executor(work) { return work.bindings?.some(binding => binding.type === 'codex-desktop') ? { ...work.executor, kind: 'codex' } : work.executor || { kind: 'pi' }; }
  execution(task = {}) { return workExecution(task, this.store); }
  authorization(task, actionId, production) {
    if (task.workId) return this.execution(task).authorization;
    const accepted = task.id && this.store.getTask(task.id);
    return accepted ? { actionId, requestTaskId: accepted.id, source: this.source(accepted), ...(production ? { production } : {}) } : undefined;
  }
  executionInput(task) {
    const execution = this.execution(task);
    const original = execution.executionEventId && this.store.getRecord('work-events', execution.executionEventId)?.content;
    return task.metadata?.automaticContinuation || task.metadata?.resumeEventId ?
      { type: 'work_continuation', acceptedStep: original, continuation: task.input } : task.input;
  }
  update(id, input, { control = false } = {}) {
    return this.store.transaction(() => {
      const previous = this.get(id); if (!previous) fail('Unknown work', 404);
      if (input.expectedRevision !== undefined && input.expectedRevision !== previous.revision) fail('Work changed; read current state', 409);
      if (input.status !== undefined && !statuses.has(input.status)) fail('Invalid work status');
      if (!control && stopped.has(previous.status) && input.status !== undefined && input.status !== previous.status)
        fail('工作已停止，只能由用户明确继续。', 409);
      const patch = Object.fromEntries(Object.entries(input).filter(([key]) => ['goal', 'requirements', 'progress', 'checkpoint', 'status', 'waiting', 'bindings', 'notifications', 'sources', 'responsibility', 'lastTaskId', 'lastError', 'owner', 'notificationCursor', 'executionOutcome', 'executor', 'supervisor'].includes(key)));
      if (control) for (const key of ['controlRevision', 'externalStop']) if (Object.hasOwn(input, key)) patch[key] = input[key];
      for (const key of ['checkpoint', 'project', 'acceptance']) if (Object.hasOwn(input, key)) patch[key] = input[key];
      for (const key of ['bindings', 'notifications', 'sources']) if (patch[key] !== undefined && !Array.isArray(patch[key])) fail(`${key} must be an array`);
      const record = this.clean({ ...previous, ...patch, id, revision: previous.revision + 1, updatedAt: now() });
      if (['completed', 'cancelled'].includes(record.status)) record.waiting = null;
      this.store.putRecord('works', record);
      this.store.appendEvent('work.updated', { work: record }, { workId: id, conversationId: record.conversationId });
      return record;
    });
  }
  async dispatch(id, input, task = {}) {
    const eventId = input.id || randomUUID(), key = `${id}:${eventId}`;
    if (this.dispatches.has(key)) return this.dispatches.get(key);
    const operation = this.dispatchEvent(id, { ...input, id: eventId }, task);
    this.dispatches.set(key, operation);
    try { return await operation; } finally { if (this.dispatches.get(key) === operation) this.dispatches.delete(key); }
  }
  contributionReceipt(event) {
    const work = this.get(event.workId);
    return { accepted: false, registered: true, workId: event.workId, operationId: event.id, planId: event.contributionPlanId,
      receiptLayer: 'room-duty-plan', status: event.status === 'superseded' ? 'superseded' :
        work?.status === 'waiting' ? 'awaiting-duty-contribution' : work?.status || event.status,
      instruction: work?.waiting?.reason || 'The work uses its original registered operation and duty contribution.' };
  }
  registerContinuationContribution(id, input, task) {
    return this.store.transaction(() => {
      const work = this.get(id); if (!work) fail('Unknown work', 404);
      const key = `${id}:${input.id}`, grant = input.productionAuthorization;
      const prior = this.store.getRecord('work-events', key);
      if (prior && prior.contributionPlanId === input.contributionPlanId && prior.requestTaskId === task.id)
        return { ...(prior.receipt || this.contributionReceipt(prior)), duplicate: true };
      if (prior) fail('This operation already has another submission.', 409);
      const plan = input.contributionPlanId && this.store.getRecord(ROOM_DUTY_PLANS, input.contributionPlanId);
      if (!matchesContributionGrant(plan, grant) || plan.coordinatorBotId !== this.botId || !plan.dutyKey)
        fail('The duty plan does not match this authorized continuation.', 409);
      const revision = work.controlRevision || 0, resume = stopped.has(work.status);
      requireProductionGrant(task, this.store, grant, { workId: id, actionId: key, relation: 'continue',
        stage: input.content?.stage?.kind, when: plan.dependency?.condition === OWNER_DELIVERY ? 'after-dependency' : 'now',
        ...productionTarget(work), controlRevision: revision });
      if (grant.kind === 'continue' && (work.status === 'completed' || currentProductionStage(work, this.store) !== grant.stage))
        fail('原步骤已完成或阶段已变化，未登记职责协作。', 409);
      const authorization = this.authorization(task, key, grant);
      if (resume) this.requireResume(work, authorization?.source?.receivedAt || null);
      const binding = work.bindings?.findLast(item => item.type === 'codex-desktop');
      if (this.store.listUnfinishedTasks().some(item => item.workId === id && ['accepted', 'queued', 'running'].includes(item.status)) ||
          !resume && binding?.operationId && !['completed', 'failed', 'cancelled', 'interrupted'].includes(externalExecution(work, binding.operationId)?.status))
        fail('原步骤仍在执行或状态未确定，当前没有替换它的等待状态。', 409);
      const previous = work.waiting?.kind === 'room-duty-contribution' && this.store.getRecord('work-events', work.waiting.operationId);
      if (previous?.status === 'pending') {
        if (previous.requestTaskId === task.id) fail('同一请求的另一项职责协作仍在等待。', 409);
        this.store.putRecord('work-events', { ...previous, status: 'superseded', supersededBy: key });
      }
      const event = this.store.putRecord('work-events', this.clean({ id: key, workId: id, kind: 'request', content: input.content,
        requestTaskId: task.id, sourceTaskId: task.id, authorization, metadata: input.metadata, status: 'pending', createdAt: now(),
        contributionPlanId: plan.id, contributionControlRevision: resume ? revision + 1 : revision }));
      const source = authorization.source;
      this.update(id, { status: 'waiting', waiting: { kind: 'room-duty-contribution', operationId: key,
        reason: '等待同一请求的职责负责人交付本次修订所需部分。' }, lastError: null,
        ...(!work.sources.some(item => item.taskId === source.taskId) ? { sources: [...work.sources, source] } : {}),
        ...(resume ? { controlRevision: revision + 1 } : {}) }, { control: resume });
      return this.contributionReceipt(event);
    });
  }
  async dispatchEvent(id, input, task = {}) {
    const work = this.get(id); if (!work) fail('Unknown work', 404);
    const eventId = input.id || randomUUID(), key = `${id}:${eventId}`, prior = this.store.getRecord('work-events', key);
    if (prior?.receipt) return { ...prior.receipt, duplicate: true };
    if (prior?.contributionPlanId && (prior.status !== 'pending' || !prior.contributionResult || work.status !== 'waiting' ||
        work.waiting?.operationId !== key)) return this.contributionReceipt(prior);
    const wait = input.metadata?.waitId && this.store.getRecord('work-waits', input.metadata.waitId);
    const registered = wait?.targetWorkId === id && eventId === `wait:${wait.id}` && wait.status === 'pending' && !wait.unresolvedTaskId;
    if (!task.id && (prior?.kind === 'request' && prior.sourceTaskId || registered && wait.sourceTaskId))
      fail('The original request task is unavailable. This action was not dispatched.', 409);
    const authorization = prior?.authorization || (registered ? wait.authorization : this.authorization(task, key, input.productionAuthorization));
    if (task.id && !task.workId && (prior?.kind || input.kind) === 'request') {
      const initial = this.store.getRecord('work-handoffs', `task:${task.id}:action:${eventId}`)?.workId === id;
      const continuationContribution = !initial && prior?.contributionPlanId;
      const plan = continuationContribution && this.store.getRecord(ROOM_DUTY_PLANS, continuationContribution);
      const ownerDelivery = plan?.dependency?.condition === OWNER_DELIVERY;
      if (continuationContribution && prior.contributionControlRevision !== (work.controlRevision || 0))
        fail('工作控制状态已变化，未提交原职责协作对应的步骤。', 409);
      if (ownerDelivery && (!matchesContributionGrant(plan, authorization?.production) ||
          JSON.stringify(prior.contributionResult.dependency) !== JSON.stringify(plan.dependency) ||
          prior.contributionResult.author !== plan.ownerBotId))
        fail('职责交付与原授权的先行条件不符，未提交制作步骤。', 409);
      requireProductionGrant(task, this.store, authorization?.production, {
        workId: id, actionId: registered ? wait.id : key, relation: initial ? 'new' : 'continue',
        stage: (prior?.content || input.content)?.stage?.kind, when: registered || ownerDelivery ? 'after-dependency' : 'now',
        ...productionTarget(work), controlRevision: initial ? undefined : continuationContribution ?
          authorization?.production?.controlRevision : work.controlRevision || 0,
      });
      if (authorization.production.kind === 'continue' &&
        (work.status === 'completed' || currentProductionStage(work, this.store) !== authorization.production.stage))
        fail('原步骤已完成或阶段已变化，未继续执行。', 409);
      if (stopped.has(work.status) && !input.metadata?.resume) fail('工作已停止，未派发此步骤。', 409);
    }
    if (input.metadata?.resume && stopped.has(work.status)) this.requireResume(work, authorization?.source?.receivedAt || null);
    if (!work.executor) this.update(id, { executor: this.executor(work).kind === 'codex' ? { kind: 'codex' } : { kind: 'pi', ...this.selectModel?.() } });
    if (task.id && !task.workId && input.kind === 'request') {
      const source = this.source(task);
      if (!work.sources.some(item => item.taskId === source.taskId)) this.update(id, { sources: [...work.sources, source] });
    }
    const inherited = task.workId ? this.execution(task) : null;
    let intent = prior || this.store.putRecord('work-events', this.clean({ id: key, workId: id,
      kind: input.kind || 'event', content: input.content, requestTaskId: authorization?.requestTaskId, sourceTaskId: task.id, authorization,
      metadata: { ...input.metadata, ...(inherited?.executionEventId ? { executionEventId: inherited.executionEventId } : {}) }, status: 'pending', createdAt: now() }));
    if (!intent.authorization && intent.requestTaskId) {
      const sourceTask = this.store.getTask(intent.requestTaskId);
      const saved = sourceTask && this.authorization(sourceTask, intent.id);
      if (saved) intent = this.store.putRecord('work-events', { ...intent, authorization: saved, requestTaskId: saved.requestTaskId });
    }
    if (!intent.authorization?.source) return { accepted: false, workId: id, status: 'pending', unresolved: true,
      warning: '已保留这一步，但尚未确定实际授权来源；不会按工作最新消息猜测来源或执行。' };
    const envelope = { id: `work:${id}:${eventId}`, to: this.botId, kind: intent.kind, workId: id,
      conversationId: work.conversationId, content: intent.content, metadata: { authority: 'internal-event', sourceType: 'internal', actor: this.botId, ...intent.metadata,
        workEventId: intent.id, origin: intent.authorization?.source, priority: intent.metadata?.priority || 'background' } };
    if (envelope.content === undefined) fail('Work event requires content');
    const receipt = this.store.transaction(() => {
      const contribution = work.waiting?.kind === 'room-duty-contribution' && work.waiting.operationId !== key &&
        this.store.getRecord('work-events', work.waiting.operationId);
      if (contribution?.status === 'pending' && authorization?.production?.relation === 'continue' &&
          authorization.requestTaskId !== contribution.requestTaskId) {
        this.store.putRecord('work-events', { ...contribution, status: 'superseded', supersededBy: key });
        this.update(id, { status: 'active', waiting: null, lastError: null });
      }
      const result = this.accept(envelope, task.source || 'controller', { deferSchedule: true });
      const saved = { accepted: true, duplicate: result.duplicate, workId: id, operationId: intent.id, taskId: result.task.id,
        status: result.task.status, localTaskStatus: result.task.status, receiptLayer: 'local-dispatch', executor: this.executor(work).kind,
        execution: externalExecution(this.get(id), intent.id) };
      this.store.putRecord('work-events', { ...this.store.getRecord('work-events', intent.id), receipt: saved, status: 'accepted' });
      return saved;
    });
    this.schedule(this.store.getTask(receipt.taskId));
    return receipt;
  }
  async wait(id, input = {}, task = {}, verifyFollowUp) {
    const work = this.get(id); if (!work) fail('Unknown work', 404);
    const bound = work.bindings?.some(binding => binding.type === 'codex-desktop') || work.waiting?.kind === 'external';
    const events = this.store.listRecords('work-events').filter(event => event.requestTaskId === task.id && event.receipt?.accepted);
    if (!input.unresolvedTaskId && !input.taskId && !input.until && !input.dependencyWorkId) {
      const dependencies = [...new Set(events.filter(event => event.workId !== id).map(event => event.workId))];
      const peers = this.store.listOutbox().filter(item => item.taskId === task.id && item.receipt?.taskId);
      if (dependencies.length === 1) input = { ...input, dependencyWorkId: dependencies[0], event: 'result' };
      else if (peers.length === 1) input = { ...input, taskId: peers[0].receipt.taskId, botId: peers[0].to };
      else if (bound || events.some(event => event.workId === id)) input = { ...input, dependencyWorkId: id, event: 'result' };
      else if (work.waiting?.taskId || work.waiting?.dependencyWorkId || work.waiting?.until) input = { ...work.waiting, ...input };
    }
    if (!input.taskId && !input.dependencyWorkId && input.event && bound) input = { ...input, dependencyWorkId: id };
    if (!input.unresolvedTaskId && !input.taskId && input.dependencyWorkId) {
      const candidates = events.filter(event => event.workId === input.dependencyWorkId);
      if (candidates.length === 1) input = { ...input, taskId: candidates[0].receipt.taskId };
      else if (candidates.length > 1) input = { ...input, unresolvedTaskId: 'multiple-current-executions' };
      else {
        const dependency = this.get(input.dependencyWorkId);
        const operationId = dependency?.waiting?.operationId || dependency?.bindings?.find(binding => binding.type === 'codex-desktop')?.operationId;
        const event = operationId && this.store.getRecord('work-events', operationId);
        if (event?.receipt?.taskId) input = { ...input, taskId: event.receipt.taskId };
        else if (operationId) input = { ...input, dependencyEventId: operationId };
        else if (dependency?.lastTaskId) input = { ...input, taskId: dependency.lastTaskId };
        else input = { ...input, unresolvedTaskId: 'execution-not-yet-identified' };
      }
    }
    if (input.taskId && (!input.botId || input.botId === this.botId)) {
      const dependency = this.store.getTask(input.taskId);
      if (dependency?.workId) input = { ...input, dependencyWorkId: dependency.workId,
        dependencyEventId: this.execution(dependency).executionEventId };
    }
    if (!input.taskId && !input.until && !input.event && !input.dependencyWorkId && !input.unresolvedTaskId) fail('Waiting requires a task, work result, deadline, or event');
    if (input.until && !Number.isFinite(Date.parse(input.until))) {
      const duration = durationSeconds(input.until);
      if (Number.isFinite(duration) && duration >= 0) input = { ...input, until: new Date(Date.parse(task.createdAt || now()) + duration * 1000).toISOString() };
      else if (input.taskId || input.dependencyWorkId || bound) input = { ...input, until: undefined, ...(!input.taskId && !input.dependencyWorkId ? { event: 'result' } : {}) };
      else fail('这一步还没有有效的等待时间或已知外部绑定。请补充该条件；其他工作和材料保留。');
    }
    const waitId = `${id}:${task.id || 'runtime'}:${input.waitId || randomUUID()}`;
    const previous = this.store.getRecord('work-waits', waitId);
    if (previous) return { accepted: true, workId: id, waitId, status: previous.status };
    const targetWorkId = input.targetWorkId || id;
    const target = this.get(targetWorkId);
    if (!target) fail('Unknown follow-up work', 404);
    const handoff = input.handoff?.handoff;
    const instruction = ['instruction', 'content', 'message', 'handoff', 'goal'].map(key => modelText(handoff?.[key]).trim()).filter(Boolean).join('\n');
    const crossWorkStep = input.dependencyWorkId && input.dependencyWorkId !== targetWorkId && instruction;
    // A concrete handoff to another work is an action even when its purpose is
    // to explain partial output. A mode hint cannot discard that accepted step.
    // Merely observing the same execution never creates another send.
    const mode = crossWorkStep || task.workId && input.mode !== 'observe' || instruction && input.mode === 'follow_up' ? 'follow_up' : 'observe';
    const grant = mode === 'follow_up' && verifyFollowUp ? await verifyFollowUp(target, { workId: input.dependencyWorkId,
      taskId: input.taskId, until: input.until, event: input.event }, waitId) : null;
    const current = this.get(target.id);
    if (mode === 'follow_up' && (stopped.has(current.status) || (current.controlRevision || 0) !== (target.controlRevision || 0)))
      fail('工作已停止或控制状态已变化，未登记后续派发。', 409);
    if (mode === 'follow_up' && task.id && !task.workId) requireProductionGrant(task, this.store, grant, {
      workId: target.id, actionId: waitId, relation: 'continue', when: 'after-dependency',
      ...productionTarget(current), controlRevision: current.controlRevision || 0,
    });
    const waiting = this.clean({ ...input, mode, id: waitId, workId: id, targetWorkId, sourceTaskId: task.id,
      ...(grant ? { handoff: { ...input.handoff, stage: productionStage(grant) } } : {}),
      authorization: this.authorization(task, waitId, grant),
      since: task.createdAt || now(), status: 'pending', createdAt: now() });
    this.store.putRecord('work-waits', waiting);
    if (task.id && !task.workId) {
      const work = this.get(id);
      if (!work.sources.some(source => source.taskId === task.id)) this.update(id, { sources: [...work.sources, this.source(task)] });
    }
    // Observing a running action must not replace its external operation state.
    if (mode === 'follow_up') this.update(id, { status: 'waiting', waiting });
    return { accepted: true, workId: id, waitId, status: 'waiting', mode,
      taskId: waiting.taskId, dependencyEventId: waiting.dependencyEventId,
      ...(waiting.unresolvedTaskId ? { unresolved: true, warning: '等待已保留，但尚未确定对应执行回合；请补充确切 taskId。不会消费其他回合的结果。' } : {}) };
  }
  stop(id, status, expectedControlRevision, receivedAt) {
    if (!stopped.has(status)) fail('Stop status must be paused or cancelled');
    const work = this.store.transaction(() => {
      const previous = this.get(id); if (!previous) fail('Unknown work', 404);
      if (previous.status === 'completed') return previous;
      const revision = previous.controlRevision || 0;
      const holding = stopped.has(previous.status) && previous.externalStop;
      if (expectedControlRevision !== undefined && expectedControlRevision !== revision &&
        !(holding && previous.status === status && expectedControlRevision === previous.externalStop.fromRevision))
        fail('工作控制状态已变化，请刷新后重新操作。', 409);
      if (holding && (previous.status === status || previous.status === 'cancelled')) return previous;
      if (!holding && receivedAt && previous.externalStop && receivedAt <= previous.externalStop.requestedAt)
        fail('该停止请求早于上一次停止或恢复，请使用新的用户请求。', 409);
      const binding = previous.bindings?.find(item => item.type === 'codex-desktop');
      const contribution = previous.waiting?.kind === 'room-duty-contribution' && this.store.getRecord('work-events', previous.waiting.operationId);
      const awaitingContribution = contribution?.status === 'pending';
      const externalStop = holding || { id: randomUUID(), fromRevision: revision, requestedAt: now(),
        status: !awaitingContribution && (binding || previous.executor?.kind === 'codex' && previous.waiting?.kind !== 'room-duty-contribution') ? 'pending' : 'local-stopped',
        bindingId: binding?.id, threadId: binding?.externalThreadId, hostId: binding?.hostId };
      const saved = this.update(id, { status, externalStop, controlRevision: revision + 1 }, { control: true });
      if (status === 'cancelled' && awaitingContribution)
        this.store.putRecord('work-events', { ...contribution, status: 'cancelled', stoppedAt: externalStop.requestedAt });
      for (const wait of this.store.listRecords('work-waits')) if (wait.status === 'pending' && (wait.workId === id || wait.targetWorkId === id))
        this.store.putRecord('work-waits', { ...wait, status, stoppedAt: externalStop.requestedAt });
      return saved;
    });
    if (!stopped.has(work.status)) return work;
    for (const task of this.store.listTasks({ limit: 10000 })) if (task.workId === id && task.status === 'running') this.cancel(task.id);
    return work;
  }
  settleStop(id, { stopId, status, bindingId, threadId, turnId, observedAt, alreadyEnded }) {
    const work = this.get(id), stop = work?.externalStop;
    if (!stop || stop.id !== stopId || !stopped.has(work.status) || stop.status !== 'pending') return { applied: false };
    if (!stopOutcomes.has(status)) fail('Invalid external stop outcome');
    if (status !== 'local-stopped' && (!turnId || !threadId || !observedAt ||
      !work.bindings?.some(binding => binding.id === bindingId && binding.externalThreadId === threadId) ||
      stop.bindingId && stop.bindingId !== bindingId || stop.threadId && stop.threadId !== threadId))
      fail('Stop evidence does not match this binding', 409);
    const receipt = { ...stop, status, bindingId: bindingId || stop.bindingId,
      threadId: threadId || stop.threadId, turnId, observedAt, alreadyEnded: Boolean(alreadyEnded) };
    this.store.transaction(() => {
      this.update(id, { externalStop: receipt }, { control: true });
      if (turnId) this.store.putRecord('work-stops', { ...receipt, stopId, id: `${id}:${threadId}:${turnId}`, workId: id });
    });
    return { applied: true };
  }
  requireResume(work, receivedAt) {
    if (work.externalStop?.status === 'pending') fail('本地已停止；请先确认执行端的原回合已结束。', 409);
    if (receivedAt !== undefined && work.externalStop && (!receivedAt || receivedAt <= work.externalStop.requestedAt))
      fail('只能由停止之后的新用户请求继续工作。', 409);
  }
  activate(work) {
    return this.update(work.id, { status: 'active', waiting: null, lastError: null,
      controlRevision: (work.controlRevision || 0) + 1 }, { control: true });
  }
  resume(id, expectedControlRevision) {
    return this.store.transaction(() => {
      const work = this.get(id); if (!work) fail('Unknown work', 404);
      const revision = expectedControlRevision + 1, key = `${id}:card-resume:${revision}`;
      const previous = this.store.getRecord('work-controls', key);
      if (work.controlRevision === revision && previous?.resumeReceipt) return { ...work, resumeReceipt: previous.resumeReceipt };
      if ((work.controlRevision || 0) !== expectedControlRevision || !['paused', 'cancelled', 'blocked'].includes(work.status))
        fail('工作控制状态已变化，请刷新后重新操作。', 409);
      this.requireResume(work);
      const stop = work.externalStop;
      if (stop?.status === 'completed') fail('原执行回合已经完成。请在来源会话核对结果或明确提出追加要求。', 409);
      const contribution = work.waiting?.kind === 'room-duty-contribution' && this.store.getRecord('work-events', work.waiting.operationId);
      if (work.status === 'paused' && contribution?.status === 'pending' && contribution.contributionPlanId) {
        const resumeReceipt = { accepted: true, operationId: contribution.id, status: 'awaiting-duty-contribution' };
        if (contribution.authorization?.production?.relation === 'continue') this.store.putRecord('work-events', {
          ...contribution, contributionControlRevision: revision });
        this.store.putRecord('work-controls', { id: key, workId: id, resumeReceipt, createdAt: now() });
        return { ...this.update(id, { status: 'waiting', controlRevision: revision }, { control: true }), resumeReceipt };
      }
      const tasks = this.store.listUnfinishedTasks().filter(task => task.workId === id && task.metadata?.sourceType !== 'external');
      if (tasks.some(task => task.status === 'running')) fail('原工作步骤仍在收尾，请稍后从当前卡片恢复。', 409);
      const queued = tasks.filter(task => task.status === 'accepted' && !task.cancelRequested);
      if (queued.length > 1) fail('有多项待处理步骤。请在来源会话明确要继续哪一步。', 409);
      const last = work.lastTaskId && this.store.getTask(work.lastTaskId);
      const binding = work.bindings?.findLast(item => item.type === 'codex-desktop');
      let originalId, expectedTurn;
      if (binding?.externalThreadId) {
        const current = binding.operations?.find(item => item.operationId === binding.operationId);
        const operationId = current?.action === 'interrupt' ? binding.executionOperationId : binding.operationId;
        const operation = binding.operations?.find(item => item.operationId === operationId);
        if (!['interrupted', 'cancelled', 'failed'].includes(stop?.status) || stop.bindingId !== binding.id ||
          stop.threadId !== binding.externalThreadId || !stop.turnId || stop.turnId !== binding.turnId ||
          !operationId || operation?.status !== 'received' || operation.threadId !== stop.threadId || operation.verificationOnly ||
          binding.pendingClientThreadId || binding.operations.some(item => !item.appliedAt))
          fail('无法确认当前绑定的原步骤已中断或失败。请在来源会话查看原回合。', 409);
        const sent = this.store.getTool(operationId);
        const owner = sent?.name === 'codex_send' && sent.workId === id && !sent.executionRejected && !sent.executionReused && this.store.getTask(sent.taskId);
        originalId = owner ? this.execution(owner).executionEventId : operationId;
        expectedTurn = { stopId: stop.id, bindingId: binding.id, threadId: stop.threadId,
          hostId: binding.hostId || 'local', turnId: stop.turnId, status: stop.status };
      } else {
        if (this.executor(work).kind === 'codex' && (binding?.pendingClientThreadId || stop?.status !== 'local-stopped' && binding?.operationId))
          fail('原执行操作尚未确认，请先核对它的结果。', 409);
        if (last?.workId === id && ['cancelled', 'interrupted', 'failed'].includes(last.status)) originalId = this.execution(last).executionEventId;
      }
      const ready = queued[0];
      const eventId = ready ? ready.metadata?.workEventId : originalId;
      const event = eventId && this.store.getRecord('work-events', eventId);
      const auth = event?.authorization, source = auth?.requestTaskId && this.store.getTask(auth.requestTaskId);
      const originalTask = acceptedWorkTask(event, this.store);
      const savedSource = source && this.source(source);
      if (event?.workId !== id || event.kind !== 'request' || !originalTask ||
        event.content === undefined || !savedSource || !auth.source || source.cancelRequested ||
        ['taskId', 'messageId', 'actor', 'roomId', 'replyTo'].some(field => auth.source[field] !== savedSource[field]) ||
        ready && (originalTask.id !== ready.id || event.transport) ||
        !ready && !expectedTurn && originalTask.status === 'completed' && last?.id === originalTask.id)
        fail('没有可继续的原始工作步骤，请在来源会话明确提出继续要求。', 409);
      if (auth.production) {
        if (auth.production.bindingId && auth.production.bindingId !== binding?.id) fail('原步骤的执行绑定已变化。', 409);
        requireProductionGrant(source, this.store, auth.production, { ...productionTarget(work), workId: id,
          bindingId: auth.production.bindingId, actionId: auth.actionId });
      }
      const cardResume = { originalEventId: event.id, controlRevision: revision, expectedTurn };
      let task;
      if (ready) {
        this.store.putRecord('work-events', { ...event, cardResume });
        task = ready;
      } else {
        const content = { type: 'work_continuation', acceptedStep: event.content, continuation: {
          instruction: '继续这个已授权的原步骤。核对原回合和已保留的进展，只完成剩余事项。保留原有要求、范围和绑定。查询未知结果，避免重复已完成的操作。' } };
        this.store.putRecord('work-events', { id: key, workId: id, kind: 'request', content, authorization: auth,
          requestTaskId: auth.requestTaskId, cardResume, status: 'pending', createdAt: now() });
        const accepted = this.accept({ id: `work:${key}`, to: this.botId, kind: 'request', workId: id, content,
          metadata: { authority: 'internal-event', sourceType: 'internal', actor: this.botId,
            workEventId: key, origin: auth.source, priority: 'foreground' } }, auth.source.source || 'controller', { deferSchedule: true });
        task = accepted.task;
        if (accepted.duplicate || task?.workId !== id || task.status !== 'accepted') fail('未能登记原工作步骤。', 409);
      }
      const resumeReceipt = { accepted: true, operationId: ready ? event.id : key, taskId: task.id, status: task.status };
      if (!ready) this.store.putRecord('work-events', { ...this.store.getRecord('work-events', key), sourceTaskId: task.id,
        receipt: { ...resumeReceipt, workId: id }, status: 'accepted' });
      this.store.putRecord('work-controls', { id: key, workId: id, resumeReceipt, createdAt: now() });
      return { ...this.activate(work), resumeReceipt };
    });
  }
}
