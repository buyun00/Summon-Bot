import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const text = value => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const excerpt = (value, limit, pointer) => {
  const raw = text(value);
  return raw.length <= limit ? value : { excerpt: raw.slice(0, limit), fullCharacters: raw.length,
    completeSource: pointer, requiredRead: true };
};

/** One canonical handoff, with a bounded transport and a complete, authorized
 * source file. No previous work_input/materials envelope is wrapped again. */
export async function executorHandoff({ workspace, work, task, event, execution, knowledge }) {
  let input = event.content || task.input;
  while (input?.current || input?.type === 'work_continuation' && input.acceptedStep)
    input = input.current || input.acceptedStep;
  const materials = input?.materials || input || {};
  const additionalRequests = [...(event.content?.accumulated || []), ...(task.input?.accumulated || [])].map(item => ({
    taskId: item.taskId, source: item.source, input: item.input }));
  const bundle = { type: 'executor_handoff', workId: work.id, operationId: event.id,
    originalRequest: materials.originalRequest || { content: materials.trigger?.content || input },
    handoff: materials.handoff || {}, stage: materials.stage, evidence: materials.evidence || [], evidenceWarnings: materials.evidenceWarnings || [],
    ...(materials.observation ? { deliveredObservation: materials.observation } : {}),
    work: { goal: work.goal, requirements: work.requirements, project: work.project, target: work.executor?.target },
    additionalRequests, currentKnowledge: knowledge,
    authorization: { actionId: execution.actionId, requestTaskId: execution.requestTaskId,
      instruction: 'Only this accepted step is authorized. Original authenticated user requirements and their latest explicit corrections outrank coordinating prose. Previous steps and dispatch/wait instructions are history. A documentation-only step does not authorize implementation or resuming paused code.' } };
  const root = await realpath(workspace), directory = join(root, '.summon-handoffs');
  await mkdir(directory, { recursive: true });
  const part = relative(root, await realpath(directory));
  if (isAbsolute(part) || part === '..' || part.startsWith('..\\') || part.startsWith('../'))
    throw new Error('Executor handoff directory is outside the authorized workspace');
  const path = join(directory, `${randomUUID()}.json`);
  await writeFile(path, JSON.stringify(bundle, null, 2), { flag: 'wx', mode: 0o600 });
  const message = { type: bundle.type, workId: work.id, operationId: event.id,
    sourceFile: path,
    instruction: 'Read sourceFile before acting. It contains the complete original request, constraints, selected evidence and current sourced rules for this step. Excerpts below are an index, never permission to discard omitted constraints. Do not recursively resend this package or old tool receipts. Continue the same bound task; report actual received/adopted/completed separately. Publish finished files through Summon, not as filesystem paths or source code for the user to save.',
    originalRequest: excerpt(bundle.originalRequest, 16000, `${path}#originalRequest`),
    handoff: excerpt(bundle.handoff, 16000, `${path}#handoff`),
    stage: bundle.stage, additionalRequests: excerpt(additionalRequests, 2000, `${path}#additionalRequests`),
    work: excerpt(bundle.work, 6000, `${path}#work`),
    currentKnowledge: excerpt(knowledge, 10000, `${path}#currentKnowledge`),
    evidence: bundle.evidence.map((item, index) => ({ reference: item.reference, author: item.author,
      authority: item.authority, completeSource: `${path}#evidence/${index}` })),
    authorization: bundle.authorization };
  const prompt = JSON.stringify(message);
  if (prompt.length > 90000) throw new Error('Executor handoff index exceeds its transport budget; complete sources remain saved');
  return { prompt, path, characters: prompt.length };
}
