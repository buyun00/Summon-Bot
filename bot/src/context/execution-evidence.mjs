// Work lifecycle, local transport and an observed external turn are separate.
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
