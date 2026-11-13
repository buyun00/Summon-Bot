import { executorHandoff } from '../context/executor-handoff.mjs';
import { executorDeliveryText, publishExecutorResult } from './executor-delivery.mjs';
import { externalExecution } from '../context/execution-evidence.mjs';

const at = () => new Date().toISOString();
const stopped = new Set(['paused', 'cancelled']);
const terminal = new Set(['completed', 'failed', 'stopped', 'unknown', 'superseded']);
const tool = 'catalog_native_engine_execute';
const suspended = (work, fields = {}) => ({ content: '', suspended: true, executor: work.executor.name || work.executor.resourceId, ...fields });

export function nativeWorkExecutor({ store, services, emit, clean }) {
  function recordInput(task) {
    const session = store.getSession(task.sessionId) || { id: task.sessionId, workId: task.workId,
      conversationId: task.conversationId, kind: 'work', messages: [] };
    const id = 'native-work-input:' + task.id;
    if (!session.messages.some(message => message.runtimeEntryId === id)) store.saveSession({ ...session, lastTaskId: task.id,
      messages: [...session.messages, { role: 'user', runtimeEntryId: id,
        content: [{ type: 'text', text: JSON.stringify(task.input) }], timestamp: Date.now() }] });
  }

  async function execute(task, { signal }) {
    const work = services.works.get(task.workId);
    if (task.metadata?.nativeEngineReview) return review(task, work, signal);
    const execution = services.works.execution(task), id = task.metadata?.nativeEngineRetryId || task.metadata?.workEventId || execution.executionEventId;
    const event = id && store.getRecord('work-events', id);
    if (event?.workId !== work.id || !execution.authorization?.source)
      throw new Error('The original accepted engine action is unavailable');
    const recovery = task.metadata?.cutoverRecoveryBindingId;
    const input = event.content?.current || event.content;
    if (store.getMessage(task.messageId)?.kind === 'event' && !recovery && input?.type !== 'dependency_result' && !task.metadata?.nativeEngineResume)
      return suspended(work, { observed: true });
    if (event.cardResume && !task.metadata?.nativeEngineRetryId && event.cardResume.controlRevision !== (work.controlRevision || 0))
      return suspended(work, { waiting: 'work-control-changed' });
    recordInput(task);
    let submitted = store.getRecord('work-events', id);
    if (submitted.engine?.controlRevision !== (work.controlRevision || 0) || recovery && !submitted.engine?.recoveryBindingId) {
      let handoff;
      if (!recovery) {
        let knowledge;
        try { knowledge = await services.memory.forRequest(task, services.sources.project(work)); }
        catch (error) { knowledge = { unavailable: error.message }; }
        handoff = await executorHandoff({ workspace: services.workspace, work, task, event, execution, knowledge });
      }
      const args = { workId: work.id, operationId: id };
      const steer = input?.type === 'user-work-input' ? input.instruction : handoff?.steer;
      submitted = store.putRecord('work-events', clean({ ...submitted, sourceTaskId: task.id,
        handoffFile: handoff?.path, resultFile: handoff?.resultFile, outputDirectory: handoff?.outputDirectory,
        transport: { name: tool, args }, engine: { prompt: handoff?.prompt, steer, controlRevision: work.controlRevision || 0,
          recoveryBindingId: recovery || undefined }, status: 'submitting' }));
    } else if (submitted.sourceTaskId !== task.id) {
      submitted = store.putRecord('work-events', { ...submitted, sourceTaskId: task.id });
    }
    signal?.throwIfAborted();
    const current = services.works.get(work.id);
    if (stopped.has(current.status) || (current.controlRevision || 0) !== submitted.engine.controlRevision)
      return suspended(work, { waiting: current.status });

    const priorInput = input?.deliveredToNativeOperation;
    if (priorInput?.operationId && priorInput.id) {
      const previous = await services.capability('catalog_native_status', { workId: work.id, operationId: priorInput.operationId }, task, { signal });
      const receipt = previous.inputs?.find(item => item.id === priorInput.id);
      if (receipt?.status !== 'rejected') {
        return settleSubmission(task, submitted, { status: 'steered', operationId: priorInput.operationId, receipt });
      }
    }
    const receipt = await services.capability(tool, submitted.transport.args, task, { operationId: id, signal });
    return settleSubmission(task, submitted, receipt);
  }

  function settleSubmission(task, event, receipt) {
    const work = services.works.get(task.workId);
    const pending = receipt.status === 'queue-behind-turn' || receipt.status === 'steered';
    const engine = pending ? { ...event.engine, precedingOperationId: receipt.operationId,
      inputId: receipt.receipt?.id || null } : event.engine;
    store.putRecord('work-events', { ...store.getRecord('work-events', event.id), engine, executionReceipt: receipt,
      status: receipt.status === 'maintenance' ? 'engine-maintenance' : pending ? 'engine-queued' : 'submitted', submittedAt: at() });
    if (!stopped.has(work.status) && ['active', 'waiting'].includes(work.status) && receipt.status !== 'maintenance' && !work.waiting?.dependencyWorkId &&
        !['native-input', 'review', 'user-input'].includes(work.waiting?.kind)) {
      services.works.update(work.id, { status: 'waiting', waiting: { kind: 'native-execution',
        operationId: receipt.operationId || event.id, reason: '等待 ' + (work.executor.name || '原生工作引擎') + ' 的执行结果' },
        executionOutcome: { kind: receipt.status === 'unknown' ? 'result-unknown' : 'submission-accepted', operationId: receipt.operationId || event.id } });
    }
    emit('work.execution_submitted', { workId: work.id, operationId: event.id, status: receipt.status, resourceId: work.executor.resourceId }, { workId: work.id, taskId: task.id });
    return suspended(work, { waiting: receipt.status, operationId: event.id });
  }

  async function settleInputs(work, operation, task, signal) {
    const linked = store.listRecords('work-events').filter(event => event.workId === work.id &&
      event.engine?.precedingOperationId === operation.operationId);
    const waiting = linked.filter(event => event.status === 'engine-queued');
    const accepted = linked.filter(event => event.nativeInputReceipt?.status === 'accepted').map(event => event.id);
    const unknown = linked.filter(event => event.status === 'engine-input-unknown');
    if (!waiting.length) return { ready: [], unknown, accepted };
    const state = await services.capability('catalog_native_status', { workId: work.id, operationId: operation.operationId }, task, { signal });
    const ready = [];
    for (const event of waiting) {
      const receipt = state.inputs?.find(item => item.id === event.engine.inputId);
      if (receipt?.status === 'accepted' && receipt.turnId === operation.nativeTurnId) {
        store.putRecord('work-events', { ...event, status: 'submitted', nativeInputReceipt: receipt });
        accepted.push(event.id);
      } else if (!event.engine.inputId || receipt?.status === 'rejected') ready.push(event);
      else {
        store.putRecord('work-events', { ...event, status: 'engine-input-unknown', nativeInputReceipt: receipt || null });
        unknown.push(event);
      }
    }
    return { ready, unknown, accepted };
  }

  async function review(task, work, signal) {
    const operation = work.bindings.find(item => item.type === 'native-tool' && item.operationId === task.metadata.nativeEngineReview);
    const event = operation && store.getRecord('work-events', operation.operationId);
    if (!operation || !event?.engine || !terminal.has(operation.status) ||
        (work.controlRevision || 0) !== operation.controlRevision || stopped.has(work.status))
      return suspended(work, { late: true });
    if (operation.engine.recovery) {
      const binding = work.bindings.find(item => item.id === event.engine.recoveryBindingId);
      if (binding?.status !== 'recovery-required') return suspended(work, { observed: true });
      const same = operation.status === 'completed' && operation.nativeSessionId === binding.nativeSessionId;
      if (same) services.works.update(work.id, { status: 'waiting',
        bindings: work.bindings.map(item => item === binding ? { ...item, resourceId: operation.resourceId, status: 'resumable',
          observationId: 'native:' + operation.operationId + ':' + operation.status, observedAt: operation.observedAt } : item),
        waiting: { kind: 'review', operationId: binding.operationId, reason: '本机 CLI 已找到原会话，等待核对原结果或继续要求。' } });
      else services.works.update(work.id, { status: 'waiting', waiting: work.waiting, lastError: {
        code: 'NATIVE_SESSION_RECOVERY_REQUIRED', message: operation.error || '本机 CLI 未确认原会话；保留原结果待核对。' } });
      return suspended(work, { observed: true });
    }
    const { ready, unknown, accepted } = await settleInputs(work, operation, task, signal);
    const latest = services.works.get(work.id);
    if (stopped.has(latest.status) || (latest.controlRevision || 0) !== operation.controlRevision ||
        latest.bindings.some(item => item.engine && !item.engine.recovery && item.operationId !== operation.operationId &&
          item.controlRevision === operation.controlRevision && Date.parse(item.launchedAt || item.observedAt) > Date.parse(operation.launchedAt || operation.observedAt)))
      return suspended(work, { late: true });
    const confirmed = operation.status === 'completed' && operation.final?.confirmed &&
      Boolean(operation.nativeSessionId && operation.nativeTurnId && operation.final.turnId === operation.nativeTurnId);
    const outcome = { kind: confirmed ? 'execution-ended' : operation.status === 'unknown' ? 'result-unknown' : operation.status,
      operationId: operation.operationId, threadId: operation.nativeSessionId, turnId: operation.nativeTurnId, finalConfirmed: confirmed };
    services.works.update(work.id, { executionOutcome: outcome });
    const current = () => {
      const saved = services.works.get(work.id), state = externalExecution(saved, operation.operationId);
      return !stopped.has(saved.status) && (saved.controlRevision || 0) === operation.controlRevision &&
        state?.threadId === operation.nativeSessionId && state?.turnId === operation.nativeTurnId;
    };
    if (!confirmed) {
      const content = [operation.error, operation.final?.text, operation.status === 'unknown' ? '原生回合结果待确认。' :
        operation.status === 'completed' ? '执行进程已结束，未取得确认的最终结果。' : '原生执行未完成。'].filter(Boolean).join('\n');
      const unresolved = operation.status === 'unknown' || unknown.length;
      services.works.update(work.id, { status: unresolved ? 'waiting' : 'blocked',
        waiting: unresolved ? { kind: 'native-execution', operationId: operation.operationId,
          reason: '正在确认原生执行结果' } : null, lastError: { code: 'NATIVE_WORK_' + operation.status.toUpperCase(), message: content } });
      await services.notify({ id: work.id, notificationId: 'native:' + operation.operationId + ':' + operation.status,
        publication: 'external', resultKind: operation.status === 'unknown' ? 'result-unknown' : 'failed', content }, task, {});
    } else {
      const delivery = await publishExecutorResult({ store, services, task, operation: event, isCurrent: current });
      if (!current()) return suspended(work, { late: true });
      const content = [operation.final.text, delivery.status !== 'not-declared' && executorDeliveryText(delivery),
        unknown.length && '有追加要求的原生接收结果待确认，工作保留待核对。'].filter(Boolean).join('\n\n');
      const refs = [{ type: 'native-tool', operationId: operation.operationId, threadId: operation.nativeSessionId, turnId: operation.nativeTurnId }];
      await services.notify({ id: work.id, notificationId: 'native:' + operation.operationId + ':result', publication: 'external',
        resultKind: 'execution-ended', manifestOperationId: event.id, sourceRefs: refs, content, attachments: delivery.attachments }, task, {});
      if (!current()) return suspended(work, { late: true });
      const published = services.works.get(work.id);
      services.works.update(work.id, { status: 'waiting', waiting: { kind: 'review', operationId: operation.operationId,
        reason: '原生执行已结束，正在核对本次结果' }, checkpoint: { ...published.checkpoint, finalConfirmed: true, taskId: task.id,
        recordedAt: at(), evidence: { kind: 'native-result', operationId: operation.operationId,
          threadId: operation.nativeSessionId, turnId: operation.nativeTurnId, observationId: 'native:' + operation.operationId + ':' + operation.status } } });
      const reviewTask = { ...task, input: { type: 'native_work_review', originalOperation: event.id, executor: work.executor.name,
        acceptedUpdates: accepted,
        nativeResult: operation.final.text, delivery, currentWork: { goal: work.goal, requirements: work.requirements, project: work.project },
        instruction: 'Review this ended native turn against the exact accepted step and applicable requirements. Read exact command or file events through catalog_native_status when needed. The runtime returns the actual result and attachment receipts to the original conversation. Use work_update to record completion only if the scoped goal is satisfied, a review wait when user acceptance is due, or user-input when a concrete unanswered question blocks it.' } };
      try { if (!unknown.length && !ready.length) await services.reviewNative(reviewTask, { signal }); }
      catch (error) { emit('work.review_unconfirmed', { workId: work.id, operationId: operation.operationId, message: clean(error.message) }, { workId: work.id }); }
    }
    if (operation.status !== 'unknown') store.putRecord('native-engine-reviews', { id: operation.operationId, workId: work.id,
      taskId: task.id, status: operation.status, observedAt: at() });
    if (operation.status !== 'unknown' && !unknown.length) for (const queued of ready) {
      if (!current()) break;
      const savedTask = store.getTask(queued.receipt?.taskId || queued.sourceTaskId);
      if (!savedTask || savedTask.workId !== work.id) continue;
      await services.works.dispatch(work.id, { id: 'native-input-continuation:' + queued.id, kind: 'request',
        metadata: { priority: 'foreground' }, content: { type: 'work_continuation', acceptedStep: queued.content,
          continuation: { instruction: 'Continue in the same native session with this accepted update, which did not enter the preceding turn. Preserve the preceding results.' } } }, savedTask);
      store.putRecord('work-events', { ...queued, status: 'engine-continued' });
    }
    return { content: '', observed: true, executor: work.executor.name || work.executor.resourceId,
      operationId: operation.operationId, ...(ready.length ? { suspended: true } : {}) };
  }

  return { execute };
}
