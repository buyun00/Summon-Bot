const at = () => new Date().toISOString();
const stopped = new Set(['paused', 'cancelled']);

/** Codex transport runs in the existing work queue, without an intermediary Pi turn. */
export function workExecutor({ store, services, emit }) {
  return {
    async stop(work, task) {
      if (!work.bindings?.some(binding => binding.type === 'codex-desktop')) return { status: 'local-stopped' };
      const invoke = async (suffix, name, args) => {
        const id = `${work.id}:stop:${task.id}:${suffix}`;
        let event = store.getRecord('work-events', id);
        event ||= store.putRecord('work-events', { id, workId: work.id, sourceTaskId: task.id, status: 'submitting', transport: { name, args } });
        const receipt = await services.capability(event.transport.name, event.transport.args, task, { operationId: id });
        store.putRecord('work-events', { ...event, status: 'submitted', executionReceipt: receipt });
        return receipt;
      };
      try {
        const observed = await invoke('read', 'codex_read', { workId: work.id });
        const state = observed.observed;
        if (!state?.currentTurn?.id || state.stale) return { status: 'unknown', reason: 'Current external turn is unconfirmed' };
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(state.currentTurn.status)) return { status: state.currentTurn.status, turnId: state.currentTurn.id };
        const receipt = await invoke('interrupt', 'codex_interrupt', { workId: work.id, operationId: `stop:${task.id}`, expectedTurnId: state.currentTurn.id });
        return { status: receipt.status, turnId: state.currentTurn.id };
      } catch (error) { return { status: 'unknown', error: error.message }; }
    },
    record(task, message) {
      const session = store.getSession(task.sessionId) || { id: task.sessionId, workId: task.workId, conversationId: task.conversationId, kind: 'work', messages: [] };
      const entryId = `runtime:${task.id}:${message.kind}`;
      if (session.messages.some(item => item.runtimeEntryId === entryId)) return;
      store.saveSession({ ...session, lastTaskId: task.id, messages: [...session.messages, { role: 'user', runtimeEntryId: entryId,
        content: [{ type: 'text', text: JSON.stringify(message) }], source: { actor: message.author || 'runtime', taskId: task.id }, timestamp: Date.now() }] });
    },
    async execute(task) {
      const work = services.works.get(task.workId);
      if (task.metadata?.sourceType === 'external') return this.observe(task);
      this.record(task, { kind: 'work_input', author: 'accepted-request', input: task.input });
      const eventId = task.metadata?.resumeEventId || task.metadata?.workEventId || `${work.id}:task:${task.id}`;
      let event = store.getRecord('work-events', eventId);
      if (!event) event = store.putRecord('work-events', { id: eventId, workId: work.id, content: task.input,
        kind: 'request', status: 'accepted', createdAt: task.createdAt });
      const binding = work.bindings?.find(item => item.type === 'codex-desktop');
      if (!event.transport) {
        const prompt = JSON.stringify(event.content);
        const executor = services.works.executor(work);
        const name = binding?.externalThreadId ? 'codex_send' : 'codex_create';
        const args = binding?.externalThreadId ? { workId: work.id, operationId: event.id, message: prompt } :
          { workId: work.id, operationId: event.id, prompt, target: executor.target };
        event = store.putRecord('work-events', { ...event, sourceTaskId: task.id, transport: { name, args }, status: 'submitting' });
      }
      // Retries always use the same Desktop operation; its service queries unknown outcomes.
      const receipt = await services.capability(event.transport.name, event.transport.args, store.getTask(event.sourceTaskId), { operationId: event.id });
      this.record(task, { kind: 'submission_receipt', operationId: event.id, status: receipt.status, bindingId: receipt.id, threadId: receipt.externalThreadId });
      store.putRecord('work-events', { ...store.getRecord('work-events', event.id), status: receipt.status === 'failed' ? 'failed' : receipt.status === 'unknown' ? 'unknown' : 'submitted', executionReceipt: receipt, submittedAt: at() });
      const current = services.works.get(work.id);
      if (!stopped.has(current.status)) services.works.update(work.id, { status: receipt.status === 'failed' ? 'blocked' : 'waiting',
        waiting: { kind: 'external', operationId: event.id, bindingId: receipt.id, since: at() },
        executionOutcome: { kind: receipt.status === 'failed' ? 'failed' : receipt.status === 'unknown' ? 'result-unknown' : 'submission-accepted', operationId: event.id } });
      emit('work.execution_submitted', { workId: work.id, operationId: event.id, status: receipt.status });
      return { content: '', suspended: true, waiting: 'external', executor: 'codex', operationId: event.id };
    },
    async observe(task) {
      const work = services.works.get(task.workId), content = task.input;
      const binding = work.bindings?.find(item => item.id === task.metadata.externalBindingId && item.type === 'codex-desktop');
      if (!binding || content.source !== 'codex-desktop-connector' || (content.externalThreadId && binding.externalThreadId !== content.externalThreadId))
        throw new Error('External result does not match this work binding');
      const eventId = `external:${task.metadata?.observationMessageId || task.messageId}`;
      const operation = content.operationId && store.getRecord('work-events', content.operationId);
      const superseded = Boolean(content.operationId && binding.operationId !== content.operationId);
      const knownOperation = operation?.workId === work.id && operation.transport;
      const late = stopped.has(work.status) || superseded && !knownOperation;
      store.putRecord('work-observations', { id: eventId, workId: work.id, taskId: task.id, late, content, observedAt: at() });
      this.record(task, { kind: 'external_observation', author: 'codex', late, ...content });
      if (late) return { content: '', observed: true, late: true, suspended: true, waiting: work.status, executor: 'codex' };
      const expectedTurn = superseded ? operation?.executionReceipt?.turnId : binding.turnId;
      const final = content.final?.confirmed && content.final.threadId === binding.externalThreadId && content.final.turnId === content.turnId &&
        (!expectedTurn || expectedTurn === content.turnId) ? content.final : null;
      const status = content.status || (content.type === 'operation_failed' ? 'failed' : 'unknown');
      const outcome = status === 'completed' ? 'execution-ended' : status === 'waiting_for_input' ? 'needs-input' :
        ['failed', 'interrupted', 'cancelled'].includes(status) ? status : 'result-unknown';
      if (!superseded) services.works.update(work.id, { status: outcome === 'failed' ? 'blocked' : 'waiting',
        waiting: { kind: outcome === 'execution-ended' ? 'user-input' : 'external', outcome, since: at() },
        executionOutcome: { kind: outcome, turnId: content.turnId, operationId: content.operationId, finalConfirmed: Boolean(final) },
        progress: final?.text ? final.text.slice(0, 1200) : `Codex：${outcome}` });
      const label = ({ 'execution-ended': 'Codex 本次执行已结束', 'needs-input': 'Codex 需要你补充信息或处理请求', failed: 'Codex 本次执行失败',
        interrupted: 'Codex 本次执行已中断', cancelled: 'Codex 本次执行已取消', 'result-unknown': 'Codex 当前结果尚未确认' })[outcome];
      const text = (final?.text || `${label}。${content.error?.message || content.result?.error?.message || content.state?.currentTurn?.error?.message || ''}\n来源：${binding.externalThreadId || '线程尚未确认'}${content.turnId ? ` / ${content.turnId}` : ''}。${outcome === 'execution-ended' ? '未取得可确认归属的最终文本，尚未据此判定整个工作完成。' : ''}`) +
        (final?.truncated ? '\n（以上为已取得的答复片段；完整内容保留在原 Codex 线程。）' : '') +
        (final?.artifacts?.length ? `\n产物引用：\n${JSON.stringify(final.artifacts)}` : '');
      await services.notify({ id: work.id, notificationId: eventId, publication: 'external', content: text, resultKind: outcome,
        sourceRefs: [{ type: 'codex', threadId: binding.externalThreadId, turnId: content.turnId, operationId: content.operationId }], late }, task, {});
      return { content: '', observed: true, suspended: true, waiting: outcome, executor: 'codex' };
    },
  };
}
