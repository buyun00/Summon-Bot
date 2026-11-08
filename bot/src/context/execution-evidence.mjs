// Work lifecycle, local transport and an observed external turn are separate.
export function waitingLabel(work) {
  if (!work) return '工作已保留';
  if (work.status === 'paused') return '工作已暂停，等待明确继续';
  if (work.status === 'cancelled') return '工作已取消';
  const wait = work.waiting || {};
  if (wait.kind === 'user-input') return wait.question ? `等待答复：${wait.question}` : '执行端有待处理请求';
  if (wait.kind === 'review') return wait.reason || '本阶段执行已结束，等待结果评审';
  if (wait.kind === 'external') {
    const execution = externalExecution(work);
    if (execution.startedConfirmed && execution.status === 'inProgress') return 'Codex 正在执行，等待本阶段结果';
    if (execution.startedConfirmed && execution.status === 'waiting_for_input') return 'Codex 有待处理请求';
    if (wait.outcome === 'interrupted') return '外部执行已中断，工作资料保留';
    if (wait.outcome === 'result-unknown') return '正在确认外部执行结果';
    return execution.externalReceived ? '要求已送达执行端，正在确认执行状态' : '正在等待执行端接收确认';
  }
  if (wait.dependencyWorkId || wait.taskId) return wait.reason || '等待已登记的依赖工作结果';
  if (wait.until) return `等待已登记时间：${wait.until}`;
  return wait.reason || wait.event || '工作已保留，等待已登记条件';
}

export function externalExecution(work, operationId) {
  if (!work) return null;
  const operation = operationId || work.waiting?.operationId || work.bindings?.findLast(item => item.type === 'codex-desktop')?.operationId || null;
  const owning = work.bindings?.findLast(item => item.type === 'codex-desktop');
  const binding = work.bindings?.findLast(item => item.type === 'codex-desktop' &&
    (item.operationId === operation || item.operations?.some(receipt => receipt.operationId === operation)));
  const receipt = binding?.operations?.find(item => item.operationId === operation);
  const currentOperation = binding?.operationId === operation;
  const observation = currentOperation ? binding?.observation : null;
  const matching = Boolean(operation && binding?.operationId === operation && observation?.operationId === operation &&
    observation.submissionConfirmed && !observation.stale && observation.threadId && observation.threadId === binding.externalThreadId &&
    observation.turnId && observation.turnId === binding.turnId && observation.observedAt &&
    ['inProgress', 'completed', 'failed', 'cancelled', 'interrupted', 'waiting_for_input'].includes(observation.status));
  return { workId: work.id, operationId: operation, bindingId: binding?.id || null,
    threadId: receipt?.threadId || binding?.externalThreadId || null, turnId: currentOperation ? binding?.turnId || null : receipt?.turnId || null,
    transportStatus: receipt?.status || (currentOperation ? binding.status : owning ? 'unconfirmed' : 'not-submitted'),
    receiptLayer: receipt ? 'external-operation' : 'local-snapshot', externalReceived: receipt?.status === 'received',
    receiptRecordedAt: receipt?.recordedAt || null, currentOperation, currentOperationId: owning?.operationId || null,
    executorAcknowledged: null, requirementAdopted: null, startedConfirmed: matching,
    status: matching ? observation.status : 'unconfirmed', observation: observation || null,
    instruction: 'Use this exact operation and its recorded time. An older local not-submitted snapshot cannot negate a later external received receipt. Received confirms transport only. A matching active turn confirms that turn is running, never that a new requirement was read, adopted or completed. Cite new executor items/tools for those claims, preserving item IDs and original times. A directory scope is not native registration.' };
}
