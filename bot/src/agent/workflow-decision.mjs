import { taskSource } from '../context/sources.mjs';

const kind = 'business-decisions';
export const flowMarker = '[[SUMMON_FLOW ';
const verdicts = new Set(['confirmed', 'adjusted', 'blocked', 'unconfirmed']);
const choices = new Set(['answer', 'pass', 'ask', 'retain', 'reuse', 'skip', 'refuse', 'continue', 'handoff', 'verify', 'remember', 'route', 'correct']);
const businessReads = new Set(['request_actions', 'work_get', 'work_outputs', 'runtime_status', 'codex_read', 'codex_status',
  'chatroom_team_read', 'evidence_read', 'knowledge_read', 'context_assemble']);
const code = value => typeof value === 'string' && /^[a-z0-9_.:-]{1,100}$/i.test(value) ? value : undefined;
const id = value => typeof value === 'string' && value.length <= 350 && !/[\s\u0000-\u001f]/.test(value) ? value : undefined;
const compact = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
const now = () => new Date().toISOString();

export const workflowPrompt = `Before each business choice ask privately: Is the current workflow right for the current user goal, project rules, evidence, owner and authority? Change your actual choice if it is not. This includes routing, reusing, refusing, skipping, waiting, sending, verifying, saving knowledge and choosing silence. On each action tool include workflowCheck with a verdict, a short verifiable fact, and the decision category. On the final response (even PASS) append a new last line ${flowMarker}{"verdict":"confirmed|adjusted|blocked|unconfirmed","choice":"answer|pass|ask|retain|reuse|skip|refuse|continue|handoff|verify|remember|route|correct","fact":"one short fact tied to the current source"}]]. This line is private; never include analysis, copied source text, instructions, private values or credentials. Keep the normal reply or required JSON above it. No additional tool call or dialogue is needed for this check.`;
export const workflowField = { type: 'object', additionalProperties: false,
  properties: { verdict: { type: 'string', enum: [...verdicts] }, choice: { type: 'string', enum: [...choices] },
    fact: { type: 'string', maxLength: 240 } }, required: ['verdict', 'choice', 'fact'],
  description: 'Private workflow conclusion and one verifiable fact. No reasoning or source excerpts.' };

export function workflowAnswer(text) {
  const at = text.indexOf(flowMarker);
  if (at < 0) return { text };
  const tail = text.slice(at + flowMarker.length).trim();
  let check;
  try { if (tail.endsWith(']]')) check = JSON.parse(tail.slice(0, -2)); } catch {}
  return { text: text.slice(0, at).trimEnd(), check };
}

export function takeWorkflowConclusion(message) {
  let hidden = false, check;
  for (const block of message.content || []) if (block.type === 'text') {
    if (hidden) { block.text = ''; continue; }
    if (!block.text.includes(flowMarker)) continue;
    const parsed = workflowAnswer(block.text);
    block.text = parsed.text;
    check = parsed.check;
    hidden = true;
  }
  return check;
}

function outcome(record) {
  const d = record.output?.details || {};
  return compact({ status: record.status, code: code(record.error?.code || d.code),
    executed: record.executionRejected || record.executionReused ? false : undefined,
    reused: record.executionReused || d.duplicate || undefined, accepted: typeof d.accepted === 'boolean' ? d.accepted : undefined,
    workId: id(d.workId), operationId: id(d.operationId), assessmentId: id(d.assessmentId),
    sourceIntent: code(d.intent), roomMessageId: id(d.roomMessageId || d.messageId), taskId: id(d.taskId),
    acceptances: Array.isArray(d.acceptances) ? d.acceptances.slice(0, 24).map(a => compact({
      workId: id(a.workId), operationId: id(a.operationId), publicationMessageId: id(a.publicationMessageId), reused: a.alreadyRecorded,
    })) : undefined,
    unresolved: Array.isArray(d.unresolvedAcceptances) ? d.unresolvedAcceptances.length : undefined,
    sourceUnits: Array.isArray(d.sourceActions) ? d.sourceActions.slice(0, 24).map(a => compact({ unit: a.unit, kind: code(a.kind), stage: code(a.stage), when: code(a.when) })) : undefined,
    receiptId: id(d.reference?.id || d.planId || d.id), evidenceMessageId: id(d.reference?.messageId),
    revision: Number.isSafeInteger(d.revision) ? d.revision : undefined });
}

/** Private durable index of decisions. This is never an input to dispatch or memory. */
export class SummonDecisionJournal {
  constructor({ store, botId, clean, onError }) { Object.assign(this, { store, botId, clean, onError }); }
  check(value) {
    if (!verdicts.has(value?.verdict) || !choices.has(value?.choice) || typeof value.fact !== 'string') return undefined;
    const fact = this.clean(value.fact.slice(0, 240)).replace(/[\r\n\t]+/g, ' ').trim();
    return fact ? { verdict: value.verdict, choice: value.choice, fact } : undefined;
  }
  scope(task) {
    const source = taskSource(task, this.store);
    const work = task.workId && this.store.getRecord('works', task.workId);
    return compact({ taskId: id(task.id), roomId: id(source.roomId), messageId: id(source.replyTo || source.messageId),
      actor: id(source.actor), sessionId: id(task.sessionId), workId: id(work?.id || task.workId),
      workRevision: work?.revision, operationId: id(task.metadata?.externalReview?.operationId || task.metadata?.workEventId),
      deliveryId: id(source.input?.metadata?.deliveryId), authority: code(task.metadata?.authority || task.metadata?.sourceType || source.source) });
  }
  save(key, fields) {
    // A failed audit write must neither retry an applied action nor change a
    // user's authorization. The original task and tool ledgers remain primary.
    try {
      const prior = this.store.getRecord(kind, key);
      return this.store.putRecord(kind, { ...prior, ...fields, id: key, botId: this.botId,
        decidedAt: prior?.decidedAt || now(), updatedAt: now() });
    } catch (error) { this.onError?.(code(error.code) || 'DECISION_WRITE_FAILED'); }
  }
  note(task, key, fields) { return this.save(`${task.id}:${key}`, { ...this.scope(task), ...fields }); }
  start(task, decision, facts) {
    this.note(task, 'task', { boundary: 'task', decision, runtimeCheck: 'confirmed', facts, result: { status: 'running' } });
  }
  final(task, check, decision) {
    const modelCheck = this.check(check);
    this.note(task, 'answer', { boundary: 'answer', decision, modelCheck,
      runtimeCheck: modelCheck?.verdict || 'unconfirmed', facts: { modelConclusionAvailable: Boolean(modelCheck) } });
  }
  settled(task) {
    if (!task) return;
    const value = task.result || {};
    const prior = this.store.getRecord(kind, `${task.id}:task`);
    const answer = this.store.getRecord(kind, `${task.id}:answer`);
    this.note(task, 'task', { boundary: 'task', decision: prior?.decision || 'no-execution',
      runtimeCheck: prior?.runtimeCheck || 'unconfirmed',
      result: compact({ status: value.partial ? 'partial' : task.status, code: code(task.error?.code),
        formedAnswer: Boolean(answer), workId: id(value.workId), operationId: id(value.operationId),
        workIds: Array.isArray(value.workIds) ? value.workIds.slice(0, 16).map(id).filter(Boolean) : undefined,
        consumedBy: id(value.consumedBy), waiting: code(value.waiting), review: code(value.workflowReview?.outcome),
        returned: typeof value.content === 'string' ? Boolean(value.content.trim() && !/^PASS(?:\s|$)/i.test(value.content)) : undefined,
        completedAt: task.finishedAt }) });
    if (answer) this.save(answer.id, { result: { status: value.partial ? 'partial' : task.status, taskId: task.id } });
  }
  tool(task, record) {
    const running = record.status === 'running', key = `tool:${record.id}`;
    if (record.effect === 'read' && !businessReads.has(record.name) && (running || record.status === 'completed')) return;
    const prior = this.store.getRecord(kind, `${task.id}:${key}`);
    this.note(task, key, { boundary: 'tool', decision: record.executionReused ? 'reuse' : record.executionRejected ? 'refuse' : record.name,
      toolRunId: record.id, effect: record.effect, modelCheck: prior?.modelCheck || this.check(record.workflowCheck),
      runtimeCheck: running ? 'checking' : record.status === 'unknown' ? 'unconfirmed' :
        record.status === 'completed' ? 'confirmed' : prior?.runtimeCheck === 'confirmed' ? 'confirmed' : 'blocked',
      facts: { tool: record.name, ...(prior?.facts || {}), ...(record.originalToolRunId ? { originalToolRunId: record.originalToolRunId } : {}) },
      result: outcome(record) });
  }
  allowed(task, tool, context) {
    if (tool.effect === 'read') return;
    this.note(task, `tool:${context.recordId}`, { runtimeCheck: 'confirmed', facts: {
      tool: tool.name, taskPolicy: 'allowed', externalBinding: task.metadata?.externalReview ? 'current' : undefined,
      authorization: 'tool-specific checks still apply',
    } });
  }
  recover() {
    const rows = this.store.db.prepare(`SELECT data FROM records WHERE kind=? AND
      json_extract(data,'$.result.status') IN ('running', 'pending')`).all(kind);
    for (const { data } of rows) {
      const entry = JSON.parse(data), task = this.store.getTask(entry.taskId);
      if (task && !['completed', 'failed', 'interrupted', 'cancelled'].includes(task.status)) continue;
      if (entry.boundary === 'task') this.settled(task);
      else if (entry.boundary === 'tool') {
        const receipt = this.store.getTool(entry.toolRunId);
        this.save(entry.id, { runtimeCheck: receipt?.status === 'completed' ? 'confirmed' : 'unconfirmed',
          result: receipt && receipt.status !== 'running' ? outcome(receipt) : { status: 'unknown', code: 'RECEIPT_UNAVAILABLE' } });
      } else this.save(entry.id, { runtimeCheck: 'unconfirmed', result: { status: 'interrupted' } });
    }
  }
}
