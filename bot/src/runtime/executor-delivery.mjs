import { open, realpath } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';
import { WORK_ATTACHMENTS } from './notifications.mjs';

const within = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\'); };

export function executorManifestOperation(store, work, binding, observation, source) {
  const { operationId, turnId } = observation;
  const current = store.getRecord('work-events', operationId);
  if (current) return current.workId === work.id ? current : null;
  if (!work.project?.id || !source?.roomId || !source.replyTo || !turnId || turnId !== binding.turnId) return null;

  // Only a received supervisor send can inherit the immediately preceding
  // accepted step. The native turn opener can predate a later user dispatch.
  const receipts = new Map(binding.operations?.filter(item => item.status === 'received' &&
    item.threadId === binding.externalThreadId).map(item => [item.operationId, item]));
  const visited = new Set();
  let id = operationId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const receipt = receipts.get(id), previous = receipt?.precedingTurn;
    if (receipt?.action !== 'send' || previous?.status !== 'inProgress' || previous.turnId !== turnId ||
      !receipts.has(previous.operationId)) return null;
    const send = store.getTool(id), origin = send && store.getTask(send.taskId);
    if (send?.name !== 'codex_send' || send.workId !== work.id || send.effect !== 'external' ||
      send.executionRejected || send.executionReused || origin?.workId !== work.id ||
      origin.metadata?.sourceType !== 'external' || origin.metadata.externalBindingId !== binding.id ||
      origin.input?.type !== 'external_progress' || origin.input.externalThreadId !== binding.externalThreadId ||
      origin.input.turnId !== turnId || origin.input.operationId !== previous.operationId) return null;
    id = previous.operationId;
    const step = store.getRecord('work-events', id);
    if (step) {
      const accepted = step.authorization?.source;
      return step.workId === work.id && step.kind === 'request' && step.resultFile &&
        accepted?.roomId === source.roomId && accepted.replyTo === source.replyTo && accepted.actor === source.actor ? step : null;
    }
  }
  return null;
}

export async function readExecutorManifest({ workspace, workId, operation }) {
  if (!operation?.resultFile) throw Object.assign(new Error('No existing result manifest'), { code: 'ENOENT' });
  const root = await realpath(workspace), path = await realpath(operation.resultFile);
  if (!within(root, path)) throw new Error('Executor result manifest is outside its workspace');
  const handle = await open(path, 'r');
  let manifest;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 262144) throw new Error('Executor result manifest must be a JSON file of at most 256 KiB');
    manifest = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (manifest.workId !== workId || manifest.operationId !== operation.id || manifest.status !== 'ready' ||
    !Array.isArray(manifest.artifacts) || manifest.artifacts.length > WORK_ATTACHMENTS) throw new Error('Executor result manifest does not match this accepted work/operation');
  const artifacts = [];
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.path !== 'string' || !isAbsolute(artifact.path)) throw new Error('Deliverable requires its absolute output path');
    const output = await realpath(artifact.path);
    if (!within(root, output) || within(resolve(root, '.summon-handoffs'), output)) throw new Error('Deliverable is outside the product output scope');
    artifacts.push({ path: output, ...(artifact.name ? { name: artifact.name } : {}) });
  }
  return { ...manifest, artifacts };
}

// Native workers never receive publication credentials. This bridge consumes
// only their exact accepted operation's manifest and uses existing scoped tools.
export async function publishExecutorResult({ store, services, task, operation, isCurrent }) {
  if (!operation?.resultFile) return { attachments: [], status: 'not-declared' };
  const key = operation.id, saved = store.getRecord('executor-deliveries', key);
  if (saved) return saved;
  const root = await realpath(services.workspace);
  let manifest;
  try {
    manifest = await readExecutorManifest({ workspace: services.workspace, workId: task.workId, operation });
  } catch (error) {
    if (error.code === 'ENOENT') return { attachments: [], status: 'not-declared' };
    return store.putRecord('executor-deliveries', { id: key, attachments: [], status: 'rejected', error: error.message });
  }
  if (!isCurrent()) return { attachments: [], status: 'superseded' };
  let delivery = store.putRecord('executor-deliveries', { id: key, attachments: [], status: 'publishing', summary: String(manifest.summary || '').slice(0, 6000) });
  try {
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (typeof artifact.path !== 'string' || !isAbsolute(artifact.path)) throw new Error('Deliverable requires its absolute output path');
      const path = await realpath(artifact.path);
      if (!within(root, path) || within(resolve(root, '.summon-handoffs'), path)) throw new Error('Deliverable is outside the product output scope');
      if (!isCurrent()) throw new Error('The execution changed or stopped before publication');
      const published = await services.capability('publish_file', { path, ...(artifact.name ? { name: artifact.name } : {}) }, task,
        { operationId: `${key}:publish:${index}` });
      if (!published?.id) throw new Error('Attachment publication did not return an attachment ID');
      delivery = store.putRecord('executor-deliveries', { ...delivery, attachments: [...delivery.attachments, { id: published.id }] });
    }
    return store.putRecord('executor-deliveries', { ...delivery, status: 'published' });
  } catch (error) {
    // Keep obtained receipts. Never replay an uncertain upload on task recovery.
    return store.putRecord('executor-deliveries', { ...delivery, status: 'unconfirmed', error: error.message });
  }
}
