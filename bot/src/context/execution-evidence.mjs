import { factTime } from './fact-time.mjs';

export const HISTORICAL_WORK_DELIVERIES = 'historical-work-deliveries';

export function unsettledNativeBinding(binding) {
  return ['native-tool', 'native-api'].includes(binding.type) && ['queued', 'starting', 'running', 'awaiting-input', 'stopping', 'unknown'].includes(binding.status);
}

export function isAcceptedOperation(work, operationId) {
  return Boolean(operationId && (work.acceptance?.operationId === operationId || work.acceptance?.throughOperationId === operationId));
}
// Work lifecycle, local transport and an observed external turn are separate.
export function waitingLabel(work) {
  if (!work) return '工作已保留';
  if (['paused', 'cancelled'].includes(work.status)) {
    const local = work.status === 'paused' ? '本地工作已暂停' : '本地工作已取消';
    const external = { pending: '执行端停止待确认', interrupted: work.externalStop?.alreadyEnded ? '原执行回合此前已中断' : '原执行回合已中断', completed: '原执行回合已完成',
      failed: '原执行回合已失败结束', cancelled: '原执行回合已取消', 'local-stopped': '本地执行已停止', unknown: '原生执行结果待确认', 'recovery-required': '原会话需要核对' }[work.externalStop?.status];
    return external ? `${local}；${external}` : work.status === 'paused' ? '工作已暂停，等待明确继续' : '工作已取消';
  }
  const wait = work.waiting || {};
  if (wait.kind === 'user-input') return wait.question ? `等待答复：${wait.question}` : '执行端有待处理请求';
  if (['native-input', 'native-execution', 'tool-environment'].includes(wait.kind)) return wait.reason || '等待已登记的工具工作';
  if (wait.kind === 'review') return wait.reason || '本阶段执行已结束，等待结果评审';
  if (wait.kind === 'external') {
    const execution = externalExecution(work);
    if (execution.startedConfirmed && execution.status === 'inProgress') return '原生工具正在执行，等待本阶段结果';
    if (execution.startedConfirmed && execution.status === 'waiting_for_input') return '原生工具有待处理请求';
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
  const native = work.bindings?.findLast(item => ['native-tool', 'native-api', 'native-recovery'].includes(item.type) && (!operationId || item.operationId === operationId));
  if (native) return { workId: work.id, operationId: native.operationId || null, bindingId: native.id, resourceId: native.resourceId,
    threadId: native.nativeSessionId || null, turnId: null, status: native.status, transportStatus: native.status, currentOperation: true,
    currentOperationId: native.operationId, externalReceived: Boolean(native.pid || native.receivedAt), startedConfirmed: Boolean(native.startedAt || native.receivedAt),
    receiptLayer: native.type, observation: native, facts: factTime({ receiptAt: native.startedAt, turnObservedAt: native.observedAt }) };
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
    facts: factTime({ receiptAt: receipt?.recordedAt, attemptedAt: receipt?.attemptedAt, turnObservedAt: observation?.observedAt }),
    instruction: 'Use this exact operation and its recorded time. An older local not-submitted snapshot cannot negate a later external received receipt. Received confirms transport only. A matching active turn confirms that turn is running, never that a new requirement was read, adopted or completed. Cite new executor items/tools for those claims, preserving item IDs and original times. A directory scope is not native registration.' };
}
