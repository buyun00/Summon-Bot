export const runtimeRecords = Object.freeze({
  event: 'inbox-event', delivery: 'inbox-delivery', route: 'inbox-route', conversation: 'conversation',
  run: 'run', wait: 'wait', call: 'call', transcript: 'transcript', checkpoint: 'context-checkpoint', input: 'pi-input',
  fastRead: 'fast-read',
  materialView: 'material-view', batch: 'material-batch', consumption: 'material-consumption', selection: 'material-selection',
});

export const recordKey = (...parts) => JSON.stringify(parts);
export const refKey = ref => ref ? recordKey(ref.kind, ref.id) : '';
export const sameRef = (left, right) => refKey(left) === refKey(right);
export const executionRef = id => ({ kind: 'conversation', id });

export function eventOrder(left, right) {
  if (sameRef(left.space, right.space) && Number.isSafeInteger(left.sequence) && Number.isSafeInteger(right.sequence))
    return left.sequence - right.sequence;
  return (left.time || left.createdAt || '').localeCompare(right.time || right.createdAt || '') || left.id.localeCompare(right.id);
}

export function runtimeFailure(code, message, status = 409, details) {
  return Object.assign(new Error(message), { code, status, details });
}

export const now = () => new Date().toISOString();

export const conversationControl = () => ({ state: 'active', control_version: 0, stop_id: null });
export const terminalCallStates = new Set(['completed', 'failed', 'stopped', 'unsupported', 'unknown', 'cancelled', 'not_submitted']);

export const matchSources = (...sources) => [...new Map(sources.flat().map(source => [recordKey(source.id, source.revision, source.kind), source])).values()];
