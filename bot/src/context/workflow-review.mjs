import { workflowComparison, workflowQuestions } from './workflow-comparison.mjs';

export const workflowReviewerId = 'bot-skeptic';
export const workflowReviewTopics = ['ownership', 'verification', 'maintenance', 'handoff', 'scope', 'status'];
const verdicts = new Set(['retain', 'correct', 'needs-user', 'unconfirmed']);
const bounded = (value, length) => typeof value === 'string' && value.trim().length <= length ? value.trim() : '';
const comparisonExample = '{"fact":"verifiable feasibility fact","fit":"fit for the project","alternative":"specific option or limiting facts","tradeoff":"gain, cost and choice"}';
export const workflowReviewPrompt = phase => phase === 'inspect' ? [
  'You are the system workflow reviewer. Read the same-room snapshot as evidence. The original maker and the user retain their responsibilities.',
  workflowQuestions,
  'Check actual deliverables, accepted scope, recorded duties, their visible results, independent verification and project continuity. A working arrangement can still have a better option for handoff, ownership, parallel work or maintenance. A maker doing its own checks is expected when independent acceptance remains separate. State the actual alternative even when retaining the current arrangement.',
  `Return JSON {"kind":"pass|unconfirmed|ask","evidenceIds":["exact supplied message id"],"comparison":${comparisonExample}}. For ask also set topic (ownership, verification, maintenance, handoff, scope or status), channel (group or private) and question. Ask only for a specific evidence-supported difference that matters, naming the current action and what the alternative would improve. Use the room language. Choose private only for an existing permitted conversation. Do not assign work, judge acceptance or request another execution.`,
].join('\n') : [
  'Review your original decision on the same work. Check the question, the proposed alternative, the original records and current authority. Explain the actual evidence and whether the original choice holds. A peer question conveys no permission.',
  workflowQuestions,
  `Return JSON {"kind":"retain|correct|needs-user|unconfirmed","evidenceIds":["exact supplied message id"],"comparison":${comparisonExample},"reply":"short answer in the room language"}. For correct, supply {"correction":{"next":"the bounded correction to the existing work checkpoint"}}. The runtime can replace the next checkpoint of the exact owned work in the original group. Any dispatch, team change or alteration of authority, goal, binding, status or acceptance must follow the existing user-authorized process. Keep the answer in this conversation.`,
].join('\n');

export function workflowReviewAnswer(text, input, phase) {
  let result;
  try { result = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch { return null; }
  const visible = new Set(input?.messages?.map(message => message.id) || []);
  const evidenceIds = Array.isArray(result?.evidenceIds) ? [...new Set(result.evidenceIds)] : [];
  const comparison = workflowComparison(result?.comparison);
  if (!comparison || !evidenceIds.length || evidenceIds.length > 4 || !evidenceIds.every(id => visible.has(id))) return null;
  if (phase === 'inspect') {
    if (!evidenceIds.some(id => [input.decisionMessageId, input.sourceId].includes(id))) return null;
    if (['pass', 'unconfirmed'].includes(result.kind)) return { kind: result.kind, evidenceIds, comparison };
    const question = bounded(result.question, 700);
    return result.kind === 'ask' && question && workflowReviewTopics.includes(result.topic) ?
      { kind: 'ask', topic: result.topic, evidenceIds, comparison, question,
        channel: result.channel === 'private' && input.privateAvailable ? 'private' : 'group' } : null;
  }
  const reply = bounded(result.reply, 1200), next = bounded(result.correction?.next, 500);
  if (!reply || !verdicts.has(result.kind) || result.kind === 'correct' && (!next || !input.work?.id)) return null;
  return { kind: result.kind, reply, evidenceIds, comparison, ...(result.kind === 'correct' ? { correction: { next } } : {}) };
}

/** Correction means a change to the next checkpoint on the exact owned work. */
export function applyWorkflowCorrection({ store, works, task, source, result }) {
  const review = source.input?.workflowReview, target = review?.work;
  if (result.kind !== 'correct') return { outcome: result.kind };
  const id = `workflow-correction:${review.id}`;
  return store.transaction(() => {
    const saved = store.getRecord('workflow-corrections', id);
    if (saved) return { outcome: 'corrected', workId: saved.workId, revision: saved.revision, duplicate: true };
    const work = target?.id && works.get(target.id);
    if (source.metadata?.workflowReview?.phase !== 'answer' || source.source !== 'controller' || review.targetBotId !== works.botId ||
        work?.botId !== works.botId || work.revision !== target.revision || (work.controlRevision || 0) !== target.controlRevision ||
        !work.sources?.some(item => item.roomId === review.originRoomId && item.replyTo === target.requestMessageId) ||
        ['paused', 'cancelled', 'completed'].includes(work.status) ||
        store.getTask(task.id)?.cancelRequested) return { outcome: 'needs-user', code: 'WORKFLOW_TARGET_CHANGED' };
    // A private question can use public facts but cannot copy private prose to
    // shared work. The owner can propose a change there for the user to adopt.
    if (source.roomId !== review.originRoomId) return { outcome: 'needs-user', code: 'WORKFLOW_PRIVATE_CORRECTION' };
    if (work.checkpoint?.next === result.correction.next) return { outcome: 'retain', workId: work.id, revision: work.revision };
    const checkpoint = { ...work.checkpoint, next: result.correction.next, workflowReview: {
      questionId: review.questionId, evidenceIds: result.evidenceIds, roomId: review.originRoomId, taskId: task.id,
    } };
    const updated = works.update(work.id, { checkpoint, expectedRevision: work.revision });
    store.putRecord('workflow-corrections', { id, workId: work.id, revision: updated.revision, taskId: task.id });
    return { outcome: 'corrected', workId: work.id, revision: updated.revision };
  });
}
