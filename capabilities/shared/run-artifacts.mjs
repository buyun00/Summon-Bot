import { open, realpath, mkdtemp, unlink, rmdir, mkdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, join } from 'node:path';

export const MAX_RUN_ARTIFACT_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const artifactIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validLookupId = id => typeof id === 'string' && id.length > 0 && id.length <= 1024 &&
  id !== '.' && id !== '..' && !/[\x00-\x1f\x7f]/.test(id) && id.isWellFormed();
const within = (root, path) => { const part = relative(root, path); return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const fail = (message = '找不到可下载的执行产物', status = 404) => { throw Object.assign(new Error(message), { status }); };
const removeSnapshot = async directory => {
  await unlink(join(directory, 'download')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await rmdir(directory);
};

export const runArtifactUrl = (taskId, toolId, artifactId) =>
  `/api/agent-runs/${encodeURIComponent(taskId)}/tools/${encodeURIComponent(toolId)}/artifacts/${encodeURIComponent(artifactId)}`;

export function projectRunArtifacts(run) {
  return { ...run, tools: (run.tools || []).map(tool => ({ ...tool, artifacts: (tool.artifacts || []).map(artifact =>
    validLookupId(run.id) && validLookupId(tool.id) && artifactIdPattern.test(artifact?.id)
      ? { ...artifact, url: runArtifactUrl(run.id, tool.id, artifact.id) } : artifact) })) };
}

/** Read only immutable, recorded receipts. The browser supplies three IDs,
 * never a filesystem path or a source URL. Root ownership comes from the UI
 * application, not from model-visible tool arguments or artifact metadata.
 */
export class RunArtifactDownloads {
  constructor({ getRun, resolveRoot, tempRoot }) { Object.assign(this, { getRun, resolveRoot, tempRoot }); }

  async read(taskId, toolId, artifactId) {
    if (![taskId, toolId].every(validLookupId) ||
        !artifactIdPattern.test(artifactId)) fail();
    // /agent-runs is the public task projection. Its runId is the independent
    // engine execution identity; neither ID is an alias for the other.
    const run = await this.getRun(taskId);
    if (!run || run.id !== taskId || run.taskId !== taskId || !validLookupId(run.runId)) fail();
    const tools = (run.tools || []).filter(tool => tool.id === toolId && tool.taskId === taskId && tool.runId === run.runId);
    if (tools.length !== 1) fail();
    const artifacts = (tools[0].artifacts || []).filter(artifact => artifact?.id === artifactId);
    if (artifacts.length !== 1) fail();
    const artifact = artifacts[0];
    if (typeof artifact.path !== 'string' || !isAbsolute(artifact.path) ||
        !Number.isSafeInteger(artifact.size) || artifact.size < 0) fail();
    if (artifact.size > MAX_RUN_ARTIFACT_DOWNLOAD_BYTES) fail('执行产物超过单次下载 256 MiB 上限，请从本机产物目录读取', 413);
    let handle, snapshot, snapshotDirectory;
    try {
      const roots = await this.resolveRoot(run);
      if (!roots?.artifactRoot || !roots?.dataRoot) fail();
      const declaredRoot = resolve(roots.artifactRoot), candidate = resolve(artifact.path);
      if (!within(declaredRoot, candidate) || candidate === declaredRoot) fail();
      const [dataRoot, artifactRoot, filePath] = await Promise.all([
        realpath(roots.dataRoot), realpath(declaredRoot), realpath(candidate),
      ]);
      // Check both the artifact directory and the file: a redirected directory
      // junction is as unsafe as a leaf symlink.
      const expectedArtifactRoot = resolve(dataRoot, relative(resolve(roots.dataRoot), declaredRoot));
      if (!within(dataRoot, artifactRoot) || relative(expectedArtifactRoot, artifactRoot) !== '' ||
          !within(artifactRoot, filePath) || filePath === artifactRoot) fail();
      handle = await open(filePath, 'r');
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size !== artifact.size) fail();
      const temporaryRoot = this.tempRoot || join(roots.dataRoot, 'capabilities', 'gateway', 'tmp', 'downloads');
      await mkdir(temporaryRoot, { recursive: true });
      if (!within(dataRoot, await realpath(temporaryRoot))) fail();
      snapshotDirectory = await mkdtemp(join(temporaryRoot, 'download-'));
      snapshot = await open(join(snapshotDirectory, 'download'), 'wx+', 0o600);
      if (before.size) {
        for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, end: before.size - 1 })) {
          await snapshot.writeFile(chunk);
        }
      }
      const after = await handle.stat();
      if (after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs || await realpath(candidate) !== filePath) {
        fail('执行产物在准备下载时发生变化，请重新获取', 409);
      }
      await handle.close(); handle = null;
      const name = typeof artifact.name === 'string' ? artifact.name : 'artifact';
      // Stream the captured snapshot so a later edit of the live original does
      // not change the bytes sent during this response. No digest is computed.
      let closing;
      return { handle: snapshot, size: before.size,
        close: () => closing ||= (async () => { await snapshot.close(); await removeSnapshot(snapshotDirectory); })(),
        headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(before.size),
        'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer',
      } };
    } catch (error) {
      await handle?.close();
      await snapshot?.close();
      if (snapshotDirectory) await removeSnapshot(snapshotDirectory);
      if (error.status) throw error;
      fail();
    }
  }
}
