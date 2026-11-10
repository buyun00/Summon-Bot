import { assertExternalReviewCurrent } from '../capabilities/task-policy.mjs';
import { executorHandoff } from '../context/executor-handoff.mjs';
import { isAcceptedOperation } from '../context/execution-evidence.mjs';
import { executorManifestOperation, publishExecutorResult } from './executor-delivery.mjs';

const at = () => new Date().toISOString();
const stopped = new Set(['paused', 'cancelled']);

/** Codex transport runs in the existing work queue, without an intermediary Pi turn. */
export function workExecutor({ store, services, emit }) {
  return {
    async stop(work, task) {
      const stopId = work.externalStop.id, id = `${work.id}:stop:${stopId}:${task.id}`;
      const name = 'codex_interrupt', args = { workId: work.id, operationId: stopId };
      const event = store.putRecord('work-events', { id, workId: work.id, sourceTaskId: task.id, stopId,
        status: 'submitting', transport: { name, args } });
      try {
        const receipt = await services.capability(name, args, task, { operationId: id });
        store.putRecord('work-events', { ...event, status: 'submitted', executionReceipt: receipt });
      } catch { store.putRecord('work-events', { ...event, status: 'unknown', executionReceipt: { status: 'pending' } }); }
    },
    record(task, message) {
      const session = store.getSession(task.sessionId) || { id: task.sessionId, workId: task.workId, conversationId: task.conversationId, kind: 'work', messages: [] };
      const entryId = `runtime:${task.id}:${message.kind}`;
      if (session.messages.some(item => item.runtimeEntryId === entryId)) return;
      store.saveSession({ ...session, lastTaskId: task.id, messages: [...session.messages, { role: 'user', runtimeEntryId: entryId,
        content: [{ type: 'text', text: JSON.stringify(message) }], source: { actor: message.author || 'runtime', taskId: task.id }, timestamp: Date.now() }] });
    },
    async execute(task, options = {}) {
      const work = services.works.get(task.workId);
      if (task.metadata?.sourceType === 'external') return this.observe(task, options);
      this.record(task, { kind: 'work_input', author: 'accepted-request', input: task.input });
      const eventId = task.metadata?.resumeEventId || task.metadata?.workEventId || `${work.id}:task:${task.id}`;
      let event = store.getRecord('work-events', eventId);
      if (!event) event = store.putRecord('work-events', { id: eventId, workId: work.id, content: task.input,
        kind: 'request', status: 'accepted', createdAt: task.createdAt });
      const binding = work.bindings?.find(item => item.type === 'codex-desktop');
      if (!event.transport) {
        const execution = services.works.execution(task);
        let currentKnowledge;
        try { currentKnowledge = await services.memory.forRequest(task, services.sources.project(work)); }
        catch (error) { currentKnowledge = { unavailable: error.message, instruction: 'Do not treat stale handoff prose as the latest saved rule.' }; }
        const { prompt, path, resultFile, characters } = await executorHandoff({ workspace: services.workspace, work, task, event, execution, knowledge: currentKnowledge });
        const executor = services.works.executor(work);
        const name = binding?.externalThreadId ? 'codex_send' : 'codex_create';
        const args = binding?.externalThreadId ? { workId: work.id, operationId: event.id, message: prompt } :
          { workId: work.id, operationId: event.id, prompt, target: executor.target };
        event = store.putRecord('work-events', { ...event, sourceTaskId: task.id, handoffFile: path, resultFile, transportCharacters: characters, transport: { name, args }, status: 'submitting' });
      }
      // Retries always use the same Desktop operation; its service queries unknown outcomes.
      options.signal?.throwIfAborted();
      const beforeSubmit = services.works.get(work.id);
      if (stopped.has(beforeSubmit.status) || (beforeSubmit.controlRevision || 0) !== (work.controlRevision || 0))
        return { content: '', suspended: true, waiting: beforeSubmit.status, executor: 'codex' };
      const receipt = await services.capability(event.transport.name, event.transport.args, store.getTask(event.sourceTaskId), {
        operationId: event.id, ...(event.transport.name === 'codex_create' ? { signal: options.signal } : {}),
      });
      const operationReceipt = receipt.operations?.find(item => item.operationId === event.id);
      const appendFailed = event.transport.name === 'codex_send' && operationReceipt?.status === 'failed';
      const submissionFailed = appendFailed || receipt.status === 'failed';
      this.record(task, { kind: 'submission_receipt', operationId: event.id, status: receipt.status, bindingId: receipt.id, threadId: receipt.externalThreadId });
      store.putRecord('work-events', { ...store.getRecord('work-events', event.id), status: submissionFailed ? 'failed' : receipt.status === 'unknown' ? 'unknown' : 'submitted', executionReceipt: receipt, submittedAt: at() });
      const current = services.works.get(work.id);
      if (appendFailed && receipt.operationId !== event.id) {
        if (!stopped.has(current.status)) services.works.update(work.id, { status: 'waiting',
          waiting: { kind: 'external', operationId: receipt.operationId, bindingId: receipt.id, since: at() },
          lastError: { kind: 'append-rejected', operationId: event.id, error: operationReceipt.error, recordedAt: at() } });
      } else if (!stopped.has(current.status)) services.works.update(work.id, { status: submissionFailed ? 'blocked' : 'waiting',
        waiting: { kind: 'external', operationId: event.id, bindingId: receipt.id, since: at() },
        executionOutcome: { kind: submissionFailed ? 'failed' : receipt.status === 'unknown' ? 'result-unknown' : 'submission-accepted', operationId: event.id } });
      emit('work.execution_submitted', { workId: work.id, operationId: event.id, status: receipt.status });
      return { content: '', suspended: true, waiting: 'external', executor: 'codex', operationId: event.id };
    },
    async review(task, binding, content, running, options) {
      const work = services.works.get(task.workId), operation = store.getRecord('work-events', content.operationId);
      const currentStep = store.getRecord('work-events', binding.operationId);
      const grant = services.works.execution(task).authorization?.production;
      const reviewTask = { ...task, metadata: { ...task.metadata, externalReview: {
        bindingId: binding.id, threadId: binding.externalThreadId, operationId: content.operationId, supervisionOperationId: binding.operationId,
        turnId: content.turnId, running, confirmedFinal: Boolean(content.final?.confirmed) } },
        input: { ...content, delivery: store.getRecord('executor-deliveries', content.operationId) || content.delivery,
          publications: store.listRecords('work-notifications').filter(item => item.workId === work.id && item.executionEventId === content.operationId)
            .map(item => ({ notificationId: item.id, status: item.status, deliveredAt: item.deliveredAt, attachments: item.attachments,
              receipts: (Array.isArray(item.receipt) ? item.receipt : [item.receipt]).filter(Boolean).map(receipt => ({ id: receipt.id,
                roomId: receipt.roomId, createdAt: receipt.createdAt, attachments: receipt.attachments?.map(({ id, name }) => ({ id, name })) })) })),
          type: 'external_work_review',
          authorizedProduction: grant && { stage: grant.stage, scope: grant.scope, roomId: grant.roomId, messageId: grant.messageId },
          acceptedStep: operation ? { reference: { type: 'work', workId: work.id, operationId: operation.id, section: 'acceptedStep' } } : null,
          latestAcceptedStep: currentStep?.id === operation?.id ? { sameAs: 'acceptedStep' } : currentStep ?
            { reference: { type: 'work', workId: work.id, operationId: currentStep.id, section: 'acceptedStep' } } : null,
          workState: { goal: work.goal, requirements: work.requirements, project: work.project, target: work.executor?.target,
            revision: work.revision, status: work.status, waiting: work.waiting, progress: work.progress, checkpoint: work.checkpoint, acceptance: work.acceptance },
          instruction: 'Review this real external observation in the original work. Accepted steps are retained once in this work session and by exact work/operation references; use evidence_read section=acceptedStep with offsets for any missing original. Compare against those originals and the latest workState. If goalAndRequirementsSameAs is present, only that text is unchanged; use the referenced saved review or read it with evidence_read. Use the current review for authority and status. The executor is already bound; do not start it again.' +
            (running ? ' This is a running review. Omit status and waiting in work_update. Use codex_send for a concrete correction to the bound thread.' :
              ' Record completed only when this observation confirms the final result and the scoped goal is satisfied. Preserve any concrete remaining requirement or verified user-input wait.') +
            (task.metadata?.finalizationOnly ? ' This is recovery of an already ended execution. Reconcile actual state and remaining boundaries only; do not reopen production, correct files, publish another message or resubmit executor work. The current saved publication receipts override old unknown-delivery statements in the final text or session. An actual attached message already returns the complete file; do not demand duplicate text parts for that same file. Preserve user acceptance and unverified business boundaries separately.' : '') } };
      reviewTask.metadata.externalReview.finalizationOnly = task.metadata?.finalizationOnly === true;
      try {
        assertExternalReviewCurrent(reviewTask, store);
        const result = await services.reviewExternal(reviewTask, options);
        // The supervisor's prose is an internal assessment. Only an explicit
        // work_notify decision publishes user-facing progress, including when
        // the assessment says PASS with an explanation or says not to publish.
        store.putRecord('external-reviews', { id: task.id, workId: work.id, observationId: content.operationId,
          status: 'reviewed', assessment: result.content?.trim() || '', recordedAt: at() });
        if (task.metadata?.reviewRecovery) {
          const original = store.getRecord('external-reviews', task.metadata.reviewRecovery);
          if (original) store.putRecord('external-reviews', { ...original, resolvedBy: task.id, resolvedAt: at() });
        }
        return { reviewed: true, reviewTaskId: task.id };
      } catch (error) {
        store.putRecord('external-reviews', { id: task.id, workId: work.id, observationId: content.operationId, status: 'unconfirmed', error: error.message, recordedAt: at() });
        emit('work.review_unconfirmed', { workId: work.id, taskId: task.id, error: error.message });
        return { reviewed: false, reviewError: error.message };
      }
    },
    async observe(task, options = {}) {
      const work = services.works.get(task.workId), content = task.input;
      const binding = work.bindings?.find(item => item.id === task.metadata.externalBindingId && item.type === 'codex-desktop');
      if (!binding || content.source !== 'codex-desktop-connector' || (content.externalThreadId && binding.externalThreadId !== content.externalThreadId))
        throw new Error('External result does not match this work binding');
      const eventId = `external:${task.metadata?.observationMessageId || task.messageId}`;
      if (task.metadata?.reviewRecovery) return { content: '', observed: true,
        ...await this.review(task, binding, content, false, options), suspended: true, waiting: 'review' };
      const operation = content.operationId && store.getRecord('work-events', content.operationId);
      const superseded = Boolean(content.operationId && binding.operationId !== content.operationId);
      const knownOperation = operation?.workId === work.id && operation.transport;
      const progress = content.type === 'external_progress';
      const stoppedTurn = content.turnId && store.getRecord('work-stops', `${work.id}:${binding.externalThreadId}:${content.turnId}`);
      const late = stopped.has(work.status) || Boolean(stoppedTurn) ||
        work.status === 'completed' && isAcceptedOperation(work, content.operationId) ||
        progress && work.status === 'completed' || superseded && !knownOperation ||
        progress && (content.turnId !== binding.turnId || content.progress?.threadId !== binding.externalThreadId || content.progress?.turnId !== content.turnId);
      store.putRecord('work-observations', { id: eventId, workId: work.id, taskId: task.id, late, content, observedAt: at() });
      this.record(task, { kind: 'external_observation', author: 'codex', late, ...content });
      if (late) return { content: '', observed: true, late: true, suspended: true, waiting: work.status, executor: 'codex' };
      if (content.type === 'operation_failed' && content.affectsExecution === false) {
        services.works.update(work.id, { lastError: { kind: 'append-rejected', operationId: content.operationId,
          error: content.error, recordedAt: at() } });
        await services.notify({ id: work.id, notificationId: eventId, publication: 'external', resultKind: 'append-failed',
          content: `本次追加要求未被外部执行器接收：${content.error?.message || '提交失败'}。原执行回合的状态保留，不能据此判它失败；这条追加仍待处理。`,
          sourceRefs: [{ type: 'codex', threadId: binding.externalThreadId, operationId: content.operationId }] }, task, {});
        return { content: '', observed: true, suspended: true, waiting: 'external', executor: 'codex' };
      }
      if (progress) {
        if (!content.progress?.confirmed || !Array.isArray(content.progress.items) || !content.progress.items.length)
          return { content: '', observed: true, suspended: true, waiting: 'external', executor: 'codex' };
        const text = content.progress.items.map(item => item.text).filter(Boolean).join('\n\n');
        services.works.update(work.id, { progress: text.slice(-1200), checkpoint: { ...work.checkpoint,
          progress: text.slice(-6000), taskId: task.id, sessionId: task.sessionId, outcome: 'in-progress',
          evidence: { kind: 'executor-commentary', completionConfirmed: false,
            observationId: eventId, threadId: binding.externalThreadId, turnId: content.turnId, operationId: content.operationId,
            itemIds: content.progress.items.map(item => item.itemId) }, recordedAt: at() } });
        const review = await this.review(task, binding, content, true, options);
        return { content: '', observed: true, ...review, suspended: true, waiting: 'external', executor: 'codex' };
      }
      const expectedTurn = superseded ? operation?.executionReceipt?.turnId : binding.turnId;
      const final = content.final?.confirmed && content.final.threadId === binding.externalThreadId && content.final.turnId === content.turnId &&
        (!expectedTurn || expectedTurn === content.turnId) ? content.final : null;
      const status = content.status || (content.type === 'operation_failed' ? 'failed' : 'unknown');
      const outcome = status === 'completed' ? 'execution-ended' : status === 'waiting_for_input' ? 'needs-input' :
        ['failed', 'interrupted', 'cancelled'].includes(status) ? status : 'result-unknown';
      if (!superseded) services.works.update(work.id, { status: outcome === 'failed' ? 'blocked' : 'waiting',
        waiting: { kind: outcome === 'execution-ended' ? 'review' : outcome === 'needs-input' ? 'user-input' : 'external', outcome,
          ...(outcome === 'needs-input' ? { question: final?.text || `Codex 待处理请求：${JSON.stringify(content.state?.pendingRequests || [])}` } : {}), since: at() },
        executionOutcome: { kind: outcome, turnId: content.turnId, operationId: content.operationId, finalConfirmed: Boolean(final) },
        checkpoint: { taskId: task.id, sessionId: task.sessionId, outcome, progress: final?.text?.slice(0, 4000) || `Codex：${outcome}`,
          evidence: { observationId: eventId, threadId: binding.externalThreadId, turnId: content.turnId, operationId: content.operationId },
          finalConfirmed: Boolean(final), recordedAt: at() },
        progress: final?.text ? final.text.slice(0, 1200) : `Codex：${outcome}` });
      const label = ({ 'execution-ended': 'Codex 本次执行已结束', 'needs-input': 'Codex 需要你补充信息或处理请求', failed: 'Codex 本次执行失败',
        interrupted: 'Codex 本次执行已中断', cancelled: 'Codex 本次执行已取消', 'result-unknown': 'Codex 当前结果尚未确认' })[outcome];
      let delivery;
      if (outcome === 'execution-ended' && final && !superseded) {
        const manifestOperation = executorManifestOperation(store, work, binding, content, services.resultSource(work, task));
        const isCurrent = () => {
          const current = services.works.get(work.id), currentBinding = current?.bindings?.find(item => item.id === binding.id);
          return current && !stopped.has(current.status) && !isAcceptedOperation(current, content.operationId) &&
            current.project?.id === work.project?.id && currentBinding?.operationId === content.operationId &&
            currentBinding?.externalThreadId === binding.externalThreadId && (!currentBinding?.turnId || currentBinding.turnId === content.turnId);
        };
        delivery = await publishExecutorResult({ store, services, task, operation: manifestOperation, isCurrent });
      }
      const text = (final?.text || `${label}。${content.error?.message || content.result?.error?.message || content.state?.currentTurn?.error?.message || ''}\n来源：${binding.externalThreadId || '线程尚未确认'}${content.turnId ? ` / ${content.turnId}` : ''}。${outcome === 'execution-ended' ? '未取得可确认归属的最终文本，尚未据此判定整个工作完成。' : ''}`) +
        (delivery?.attachments?.length ? '\n已将本次完成的文件附在此消息，供打开、下载和评审。' : '') +
        (delivery?.error ? `\n文件发布尚未完成：${delivery.error}。现有产物保留，不能据此宣称已交付。` : '') +
        (final?.truncated ? '\n（以上为已取得的答复片段；完整内容保留在原 Codex 线程。）' : '') +
        (final?.artifacts?.length ? `\n产物引用：\n${JSON.stringify(final.artifacts)}` : '');
      await services.notify({ id: work.id, notificationId: eventId, publication: 'external', content: text, attachments: delivery?.attachments,
        ...(delivery?.id && delivery.id !== content.operationId ? { manifestOperationId: delivery.id } : {}), resultKind: outcome,
        sourceRefs: [{ type: 'codex', threadId: binding.externalThreadId, turnId: content.turnId, operationId: content.operationId }], late }, task, {});
      const review = !superseded && (final || outcome === 'needs-input') ? await this.review(task, binding, { ...content, delivery }, false, options) : {};
      return { content: '', observed: true, ...review, suspended: true, waiting: outcome, executor: 'codex' };
    },
  };
}
