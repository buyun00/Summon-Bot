// A frontend semantic decision is a coordination record, never user authority.
// Document words alone must not start production or resume a stopped work.
export const requestIntents = ['discuss', 'status', 'deliver', 'produce', 'revise', 'control'];
export const productionStages = ['document-review', 'implementation', 'other'];

export function productionDecision(task, store) {
  if (task.workId) return null;
  const decision = store.getRecord('request-routing', task.id);
  if (!decision || !['produce', 'revise'].includes(decision.intent))
    throw new Error('Before dispatching production, use request_decide for this current request. Status, existing-output delivery, discussion and stop/control requests do not authorize another production dispatch.');
  return decision;
}
