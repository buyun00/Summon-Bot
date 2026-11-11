import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { createPathAccess, pathWithin } from '../capabilities/file-policy.mjs';
import { taskFileAccessPolicy } from '../capabilities/file-access.mjs';
import { acceptedWorkTask } from '../context/sources.mjs';

const absolutePrefix = process.platform === 'win32' ? String.raw`[a-z]:[\\/]` : '/';
const packageSuffix = String.raw`\.(?:zip|7z|tar(?:\.gz)?|tgz|exe|msi|apk|dmg|pkg)(?![\p{L}\p{N}_.\\/-])`;
const quoted = String.raw`[\x60"'(<](${absolutePrefix}[^<>"'\x60()\[\]\r\n，。；]+?${packageSuffix})[\x60"')>]`;
const bare = String.raw`(?<![\w.:/\\])(${absolutePrefix}[^\s<>"'\x60()[\]，。；（）【】]+?${packageSuffix})`;
const packagePath = new RegExp(quoted + '|' + bare, 'giu');
const byteCount = /^\s*[(（,，:]?\s*(?:(?:实测|大小|size)\s*[:：]?\s*)?\*{0,2}(\d{1,3}(?:,\d{3})+|\d+)\s*(?:字节|bytes?\b)/iu;

export const localPathKey = path => process.platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase() : path;
const pathMatches = text => [...String(text || '').matchAll(packagePath)]
  .map(match => ({ path: match[1] || match[2], end: match.index + match[0].length })).filter(item => isAbsolute(item.path));
export const localPackagePaths = text => pathMatches(text).map(item => item.path);
export function namesLocalPackage(text, name) {
  const exact = RegExp.escape(name.normalize('NFKC'));
  return new RegExp('(?<![\\w.-])' + exact + '(?![\\w-]|\\.[\\w])', 'iu').test(text.normalize('NFKC'));
}

// The runtime saved this summary after validating the accepted operation's
// result manifest. The same path must actually have reached the room.
function declaredPackages(summary, delivered) {
  const published = new Set(localPackagePaths(delivered).map(localPathKey));
  const declarations = new Map();
  for (const { path, end } of pathMatches(summary)) {
    const name = basename(path), key = localPathKey(path);
    if (!published.has(key)) continue;
    const count = byteCount.exec(summary.slice(end))?.[1];
    const size = count && Number(count.replaceAll(',', ''));
    if (!Number.isSafeInteger(size) || size < 1) continue;
    const prior = declarations.get(key);
    declarations.set(key, prior === undefined || prior?.size === size ? { path, name, size } : null);
  }
  return [...declarations.values()].filter(Boolean);
}

export async function deliveredLocalFiles({ store, workspace, task, work, notification, receipt, requestText }) {
  const project = work.project;
  if (!workspace || project?.hostId !== 'local' || !project.id || typeof project.cwd !== 'string' || !isAbsolute(project.cwd) ||
    notification.publication !== 'external' || notification.late) return [];
  const id = notification.manifestOperationId || notification.executionEventId;
  const delivery = store.getRecord('executor-deliveries', id);
  if (!delivery?.summary || !['published', 'rejected', 'unconfirmed'].includes(delivery.status)) return [];
  const files = declaredPackages(delivery.summary, receipt.content);
  if (!files.length) return [];

  const operation = store.getRecord('work-events', id), observation = store.getRecord('work-observations', notification.notificationId);
  const source = operation?.authorization?.source, observed = observation?.content, final = observed?.final;
  const target = operation?.executionReceipt?.directoryTarget;
  if (!operation?.resultFile || operation.workId !== work.id || target?.hostId !== 'local' || !target.cwd || relative(project.cwd, target.cwd) ||
    project.nativeProjectId && project.nativeProjectId !== target.projectId || source?.actor !== 'user' ||
    source.roomId !== receipt.roomId || source.replyTo !== receipt.replyTo ||
    observation?.workId !== work.id || observation.taskId !== notification.taskId || observation.late ||
    observed?.source !== 'codex-desktop-connector' || observed.status !== 'completed' || observed.state?.stale ||
    observed.operationId !== notification.executionEventId || !final?.confirmed ||
    final.threadId !== observed.externalThreadId || final.turnId !== observed.turnId ||
    !notification.sourceRefs?.some(ref => ref.type === 'codex' && ref.operationId === observed.operationId &&
      ref.threadId === final.threadId && ref.turnId === final.turnId)) return [];
  const origin = acceptedWorkTask(operation, store);
  const start = Date.parse(operation.submittedAt), finish = Date.parse(notification.createdAt);
  if (!origin || !(start < finish)) return [];

  const finalPaths = new Set(localPackagePaths(final.text).map(localPathKey));
  const root = resolve(project.cwd);
  const candidates = files.filter(({ path }) => finalPaths.has(localPathKey(path)) &&
    pathWithin(root, path) && pathWithin(workspace, path) && !pathWithin(resolve(root, '.summon-handoffs'), path));
  const requested = new Set(candidates.filter(file => namesLocalPackage(requestText, file.name)));
  if (!requested.size) return candidates;
  const checkedPath = createPathAccess({ workspace, accessPolicy: { deniedPaths: [
    ...taskFileAccessPolicy(origin, store, workspace).deniedPaths,
    ...taskFileAccessPolicy(task, store, workspace).deniedPaths,
  ] } });
  return Promise.all(candidates.map(async file => {
    if (!requested.has(file)) return file;
    try {
      const path = await checkedPath(file.path, { alternative: true });
      if (!pathWithin(root, path) || relative(path, file.path) || relative(root, await realpath(root)) ||
        !(await stat(path)).isFile()) return file;
      const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
      try {
        const info = await handle.stat(), { size, mtimeMs, ctimeMs } = info;
        if (info.isFile() && size === file.size && mtimeMs >= start && ctimeMs >= start && mtimeMs <= finish && ctimeMs <= finish &&
          localPathKey(await realpath(file.path)) === localPathKey(path)) return { ...file, path, mtimeMs, ctimeMs };
      } finally { await handle.close(); }
    } catch { /* A missing or inaccessible file can identify the claim but cannot be accepted. */ }
    return file;
  }));
}
