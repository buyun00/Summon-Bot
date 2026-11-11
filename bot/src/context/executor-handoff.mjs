import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORK_ATTACHMENTS } from '../runtime/notifications.mjs';

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
  const root = await realpath(workspace), directory = join(root, '.summon-handoffs');
  await mkdir(directory, { recursive: true });
  const part = relative(root, await realpath(directory));
  if (isAbsolute(part) || part === '..' || part.startsWith('..\\') || part.startsWith('../'))
    throw new Error('Executor handoff directory is outside the authorized workspace');
  const handoffId = randomUUID();
  const path = join(directory, `${handoffId}.json`), resultFile = join(directory, `${handoffId}.result.json`);
  const outputDirectory = join(root, `deliverables-${handoffId}`);
  const projectCwd = work.project?.cwd || work.executor?.target?.cwd;
  const executionPolicy = {
    ...(projectCwd ? { projectCwd } : {}),
    scope: 'Work only in the authorized project and supplied sources. Do not search/read Summon source, installation, production data/configuration, other projects, credentials, tokens or private API routes. A missing publication tool does not grant access to infrastructure. Do not enumerate processes, application data or authentication routes to compensate.',
    delivery: 'Use the bound Codex project cwd for the work itself. The output directory is only for staging authorized finished files for this step, and does not change the project cwd. Summon/Pi owns authenticated publication and chat delivery. You do not call publish_file, gateway/internal APIs or send chat messages. End with a concise factual result about production and the checks you actually observed. Summon reports attachment status from actual receipts. If a file cannot be produced, report the actual error and stop that action.',
    verification: 'Do not calculate or compare file/directory/artifact hashes, add integrity scans, extra evidence reports or repeat acceptance. Do not add/run tests unless the authenticated user explicitly requested them for this step. Perform only necessary build/configuration/start operations and handle their actual failures. Preserve applicable user constraints from all complete sources.',
    enforcement: 'Summon capability calls enforce project/source access. Native Codex tools inherit the actual desktop permission profile; this scope instruction and cwd are not an OS read sandbox. Do not claim otherwise.',
  };
  const delivery = { outputDirectory, resultFile, schema: { workId: work.id, operationId: event.id, status: 'ready',
    summary: 'Actual result and remaining limitations; no secrets.', artifacts: [{ path: 'absolute finished file path in outputDirectory', name: 'download filename (optional)' }] },
    instruction: `If this step has authorized file deliverables, create outputDirectory and stage only those finished files there. Keep the project originals. Use the staged absolute paths in artifacts. Put only the JSON manifest at resultFile in .summon-handoffs, never the files themselves. Write it after the files are finished, with up to ${WORK_ATTACHMENTS} deliverables and no digest fields. If there are no files to return, leave both paths unused. Summon reads this exact per-operation manifest, checks identity and scope, and publishes attachments to the original room in parts. Never claim published until Summon returns the real attachment receipt.` };
  const bundle = { type: 'executor_handoff', workId: work.id, operationId: event.id,
    originalRequest: materials.originalRequest || { content: materials.trigger?.content || input },
    handoff: materials.handoff || {}, stage: materials.stage, evidence: materials.evidence || [], evidenceWarnings: materials.evidenceWarnings || [],
    ...(materials.observation ? { deliveredObservation: materials.observation } : {}),
    ...(event.content?.type === 'work_continuation' ? { continuation: event.content.continuation } : {}),
    work: { goal: work.goal, requirements: work.requirements, project: work.project, target: work.executor?.target },
    additionalRequests, currentKnowledge: knowledge, executionPolicy, delivery,
    authorization: { actionId: execution.actionId, requestTaskId: execution.requestTaskId,
      instruction: 'Only this accepted step is authorized. Original authenticated user requirements and their latest explicit corrections outrank coordinating prose. Previous steps and dispatch/wait instructions are history. A documentation-only step does not authorize implementation or resuming paused code.' } };
  await writeFile(path, JSON.stringify(bundle, null, 2), { flag: 'wx', mode: 0o600 });
  const message = { type: bundle.type, workId: work.id, operationId: event.id,
    sourceFile: path,
    instruction: 'Read sourceFile before acting. It contains the complete original request, constraints, selected evidence and current sourced rules for this step. Excerpts below are an index, never permission to discard omitted constraints. Do not recursively resend this package or old tool receipts. Continue the same bound task; report actual received/adopted/completed separately. Use the delivery instructions for any authorized files to return; Summon/Pi performs publication. Never seek private infrastructure or credentials to publish.',
    executionPolicy, delivery,
    originalRequest: excerpt(bundle.originalRequest, 16000, `${path}#originalRequest`),
    handoff: excerpt(bundle.handoff, 16000, `${path}#handoff`),
    stage: bundle.stage, additionalRequests: excerpt(additionalRequests, 2000, `${path}#additionalRequests`),
    work: excerpt(bundle.work, 6000, `${path}#work`),
    currentKnowledge: excerpt(knowledge, 10000, `${path}#currentKnowledge`),
    evidence: bundle.evidence.map((item, index) => ({ reference: item.reference, author: item.author,
      authority: item.authority, completeSource: `${path}#evidence/${index}` })),
    authorization: bundle.authorization };
  let prompt = JSON.stringify(message);
  if (prompt.length > 90000) {
    const { originalRequest, handoff, additionalRequests, work: workExcerpt, currentKnowledge, evidence, ...header } = message;
    prompt = JSON.stringify({ ...header, index: ['originalRequest', 'handoff', 'additionalRequests', 'work', 'currentKnowledge', 'evidence'],
      originalRequest: excerpt(bundle.originalRequest, 16000, `${path}#originalRequest`), evidenceCount: bundle.evidence.length });
  }
  return { prompt, path, resultFile, characters: prompt.length };
}
