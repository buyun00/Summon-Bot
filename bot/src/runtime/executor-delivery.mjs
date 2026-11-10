import { open, realpath } from 'node:fs/promises';
import { relative, isAbsolute, resolve } from 'node:path';
import { WORK_ATTACHMENTS } from './notifications.mjs';

const within = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('../') && !part.startsWith('..\\'); };
const missingArtifact = 'RESULT_ARTIFACT_MISSING';

async function artifactPath(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('A file named in the result manifest is missing', { cause: error }), { code: missingArtifact });
    throw error;
  }
}

async function resultRoot(workspace, operation) {
  const workspaceRoot = await realpath(workspace);
  if (!operation.resultRoot) return workspaceRoot;
  const root = await realpath(operation.resultRoot);
  if (!within(workspaceRoot, root) || relative(root, operation.resultRoot)) throw new Error('Executor output scope no longer resolves to the accepted directory');
  return root;
}

export function executorManifestOperation(store, work, binding, observation, source) {
  const { operationId, turnId } = observation;
  const current = store.getRecord('work-events', operationId);
  if (current) return current.workId === work.id ? current : null;
  if (!work.project?.id || !source?.roomId || !(source.replyTo || source.formId === work.id) || !turnId || turnId !== binding.turnId) return null;

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
  const root = await resultRoot(workspace, operation), path = await realpath(operation.resultFile);
  if (!within(root, path)) throw new Error('Executor result manifest is outside its workspace');
  const handle = await open(path, 'r');
  let manifest, writtenAt;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 262144) throw new Error('Executor result manifest must be a JSON file of at most 256 KiB');
    manifest = JSON.parse(await handle.readFile('utf8'));
    writtenAt = info.mtimeMs;
  } finally { await handle.close(); }
  if (manifest.workId !== workId || manifest.operationId !== operation.id || manifest.status !== 'ready' ||
    !Array.isArray(manifest.artifacts) || manifest.artifacts.length > WORK_ATTACHMENTS) throw new Error('Executor result manifest does not match this accepted work/operation');
  const artifacts = [];
  for (const artifact of manifest.artifacts) {
    if (typeof artifact.path !== 'string' || !isAbsolute(artifact.path)) throw new Error('Deliverable requires its absolute output path');
    const output = await artifactPath(artifact.path);
    if (!within(root, output) || within(resolve(root, '.summon-handoffs'), output)) throw new Error('Deliverable is outside the product output scope');
    artifacts.push({ path: output, ...(artifact.name ? { name: artifact.name } : {}) });
  }
  return { ...manifest, artifacts, writtenAt };
}

// Native workers never receive publication credentials. This bridge consumes
// only their exact accepted operation's manifest and uses existing scoped tools.
export async function publishExecutorResult({ store, services, task, operation, isCurrent }) {
  if (!operation?.resultFile) return { attachments: [], status: 'not-declared' };
  const key = operation.id, saved = store.getRecord('executor-deliveries', key);
  if (saved) return saved.status === 'publishing' ? { ...saved, status: 'unconfirmed',
    error: 'The earlier publication has no terminal receipt. Keep its original operation identity' } : saved;
  let manifest, root;
  try {
    root = await resultRoot(services.workspace, operation);
    manifest = await readExecutorManifest({ workspace: services.workspace, workId: task.workId, operation });
  } catch (error) {
    if (error.code === 'ENOENT') return { attachments: [], status: 'not-declared' };
    return store.putRecord('executor-deliveries', { id: key, attachments: [], status: 'rejected', error: error.message, errorCode: error.code });
  }
  if (!isCurrent()) return { attachments: [], status: 'superseded' };
  let delivery = store.putRecord('executor-deliveries', { id: key, attachments: [], status: 'publishing', artifactCount: manifest.artifacts.length,
    summary: String(manifest.summary || '').slice(0, 6000) });
  let attempted = false;
  try {
    for (const [index, artifact] of manifest.artifacts.entries()) {
      attempted = false;
      const path = await artifactPath(artifact.path);
      if (!within(root, path) || within(resolve(root, '.summon-handoffs'), path)) throw new Error('Deliverable is outside the product output scope');
      if (!isCurrent()) return store.putRecord('executor-deliveries', { ...delivery, status: 'superseded' });
      attempted = true;
      const published = await services.capability('publish_file', { path, ...(artifact.name ? { name: artifact.name } : {}) }, task,
        { operationId: `${key}:publish:${index}` });
      if (!published?.id) throw new Error('Attachment publication did not return an attachment ID');
      delivery = store.putRecord('executor-deliveries', { ...delivery, attachments: [...delivery.attachments, { id: published.id }] });
    }
    return store.putRecord('executor-deliveries', { ...delivery, status: 'published' });
  } catch (error) {
    // A filesystem rejection proves no upload for this file. A missing or
    // uncertain remote receipt keeps its original operation and prior IDs.
    const rejected = !attempted || !error.outcomeUnknown && ['FILE_PUBLICATION_REJECTED', 'FILE_ACCESS_DENIED'].includes(error.code);
    return store.putRecord('executor-deliveries', { ...delivery, status: rejected ? 'rejected' : 'unconfirmed',
      error: error.message, errorCode: error.code, httpStatus: error.status });
  }
}

export function executorDeliveryText(delivery) {
  if (!delivery) return '';
  const { status, attachments, artifactCount, error, errorCode, httpStatus } = delivery;
  const confirmed = new Set(attachments.map(item => item.id)).size;
  const count = artifactCount > confirmed && status !== 'published' ? `${confirmed}/${artifactCount}` : confirmed;
  const receipt = confirmed ? `本次文件上传已取得 ${count} 份确认回执。可在本次结果回复中查看实际返回的附件。` : '';
  const errorDetail = error ? `\n${error}` : '';
  let detail;
  switch (status) {
    case 'published':
      detail = confirmed ? '' : '本次结果清单未声明附件。';
      break;
    case 'not-declared':
      detail = '未找到本次操作可用的结果清单，当前没有附件回执。';
      break;
    case 'rejected':
      detail = errorCode === missingArtifact ? '结果清单中有文件缺失，未完成附件上传。' :
        `本次附件上传被拒绝。${confirmed ? '余下附件未上传。' : ''}${errorDetail}`;
      if (httpStatus === 413) detail += '\n有本机项目访问权限时可从原项目取现有文件。';
      break;
    case 'superseded':
      detail = '工作状态已变化，附件上传没有继续。';
      break;
    default:
      detail = `本次${confirmed ? '其余' : ''}附件上传回执尚未确认。请按原操作查询。${errorDetail}`;
  }
  return ['**Summon 当前附件回执**', receipt, detail].filter(Boolean).join('\n');
}
