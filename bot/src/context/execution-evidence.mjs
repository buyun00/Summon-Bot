// Work lifecycle, local transport and an observed external turn are separate.
export function externalExecution(work, operationId) {
  if (!work) return null;
  const operation = operationId || work.waiting?.operationId || work.bindings?.findLast(item => item.type === 'codex-desktop')?.operationId || null;
  const binding = work.bindings?.findLast(item => item.type === 'codex-desktop' && item.operationId === operation);
  const observation = binding?.observation;
  const matching = Boolean(operation && binding?.operationId === operation && observation?.operationId === operation &&
    observation.submissionConfirmed && !observation.stale && observation.threadId && observation.threadId === binding.externalThreadId &&
    observation.turnId && observation.turnId === binding.turnId && observation.observedAt &&
    ['inProgress', 'completed', 'failed', 'cancelled', 'interrupted', 'waiting_for_input'].includes(observation.status));
  return { workId: work.id, operationId: operation, bindingId: binding?.id || null,
    threadId: binding?.externalThreadId || null, turnId: binding?.turnId || null,
    transportStatus: binding?.status || 'not-submitted', startedConfirmed: matching,
    status: matching ? observation.status : 'unconfirmed', observation: observation || null,
    instruction: 'Only a matching non-stale external turn observation confirms execution. Local accepted/running/completed and work active do not. A directory scope is not native registration.' };
}
