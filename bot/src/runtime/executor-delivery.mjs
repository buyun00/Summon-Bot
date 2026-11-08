import { open, realpath } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';

const within = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\'); };

// Native workers never receive publication credentials. This bridge consumes
// only their exact accepted operation's manifest and uses existing scoped tools.
export async function publishExecutorResult({ store, services, task, operation }) {
  if (!operation?.resultFile) return { attachments: [], status: 'not-declared' };
  const key = operation.id, saved = store.getRecord('executor-deliveries', key);
  if (saved) return saved;
  const root = await realpath(services.workspace);
  let manifest;
  try {
    const path = await realpath(operation.resultFile);
    if (!within(root, path)) throw new Error('Executor result manifest is outside its workspace');
    const handle = await open(path, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 65536) throw new Error('Executor result manifest must be a JSON file of at most 64 KiB');
      manifest = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
    if (manifest.workId !== task.workId || manifest.operationId !== operation.id || manifest.status !== 'ready' ||
      !Array.isArray(manifest.artifacts) || manifest.artifacts.length > 8) throw new Error('Executor result manifest does not match this accepted work/operation');
  } catch (error) {
    if (error.code === 'ENOENT') return { attachments: [], status: 'not-declared' };
    return store.putRecord('executor-deliveries', { id: key, attachments: [], status: 'rejected', error: error.message });
  }
  let delivery = store.putRecord('executor-deliveries', { id: key, attachments: [], status: 'publishing', summary: String(manifest.summary || '').slice(0, 6000) });
  try {
    for (const [index, artifact] of manifest.artifacts.entries()) {
      if (typeof artifact.path !== 'string' || !isAbsolute(artifact.path)) throw new Error('Deliverable requires its absolute output path');
      const path = await realpath(artifact.path);
      if (!within(root, path) || within(resolve(root, '.summon-handoffs'), path)) throw new Error('Deliverable is outside the product output scope');
      if (['paused', 'cancelled'].includes(services.works.get(task.workId)?.status)) throw new Error('Work stopped before publication');
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
