import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

export function fileAccessDenied(path, reason, extra = {}) {
  return Object.assign(new Error(`File access refused (${reason})`), {
    status: 403, code: 'FILE_ACCESS_DENIED', accessDenial: { path, reason, ...extra },
  });
}

export const pathWithin = (root, path) => {
  const part = relative(root, path);
  return !part || part !== '..' && !part.startsWith('../') && !part.startsWith('..\\') && !isAbsolute(part);
};
export const samePath = (left, right) => relative(left, right) === '';
export const filePathKey = path => process.platform === 'win32' ? path.toLowerCase() : path;

export function assertPathPolicy(path, policy = {}, { operations = ['read', 'write'], alternative = false } = {}) {
  for (const constraint of policy.deniedPaths || []) if ((!constraint.alternativesOnly || alternative) &&
    operations.some(operation => (constraint.operations || ['read', 'write']).includes(operation)) && pathWithin(resolve(constraint.path), path))
    throw fileAccessDenied(path, constraint.reason || 'prior_access_refusal', {
      sourceMessageId: constraint.sourceMessageId, originalPath: constraint.path, operations,
      blockedOperations: operations.filter(operation => (constraint.operations || ['read', 'write']).includes(operation)),
      originReason: constraint.originReason || constraint.reason,
    });
}

function hostCredentialTargets() {
  const home = homedir();
  return [
    resolve(process.env.CODEX_HOME || join(home, '.codex'), 'auth.json'),
    process.env.GROK_AUTH_PATH || resolve(process.env.GROK_HOME || join(home, '.grok'), 'auth.json'),
    resolve(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json'),
    join(home, '.claude.json'),
    ...['.ssh', '.aws', '.azure', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/gcloud'].map(name => join(home, name)),
  ];
}

// Keep only the hard safety floor: protect Summon's SQLite stores and host
// account credential files/directories. Project files (.git, .env, source,
// docs) remain freely accessible.
export function sensitivePath(path) {
  const rel = path.slice(parse(path).root.length);
  const parts = rel.split(/[\\/]+/).map(part => part.toLowerCase());
  for (const part of parts) {
    if (/^summon\.sqlite(?:[.-].*)?$/i.test(part) || part.includes(':')) return true;
  }
  return hostCredentialTargets().some(target => pathWithin(target, path));
}

export function resolveFilePath(base, input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('path must be a non-empty string without NUL');
  if (process.platform === 'win32' && (/^(?:[A-Za-z]:(?![\\/])|[\\/](?![\\/])|[\\/]{2}[.?][\\/])/.test(input) ||
    input.slice(parse(input).root.length).split(/[\\/]/).some(part =>
      part && part !== '.' && part !== '..' && (/[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)))))
    throw fileAccessDenied(input, 'ambiguous_windows_path');
  return resolve(base, input);
}

// An absent destination may have absent parents. A dangling link is an existing
// object and must not be treated as an uncreated directory.
async function locatePath(path) {
  const missing = [];
  let current = path;
  while (true) {
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
      continue;
    }
    const actual = await realpath(current).catch(error => {
      if (info.isSymbolicLink() && ['ENOENT', 'ELOOP'].includes(error.code)) throw fileAccessDenied(path, 'unresolved_reparse_point');
      throw error;
    });
    if (info.isSymbolicLink()) info = await stat(actual);
    if (missing.length && !info.isDirectory()) throw Object.assign(new Error('An existing path component is not a directory'), { code: 'ENOTDIR' });
    return { path: resolve(actual, ...missing.reverse()), info: missing.length ? null : info };
  }
}
const physicalPath = async path => (await locatePath(path)).path;

export function insideProtectedDirectory(path, workspace, roots) {
  return roots.some(root => pathWithin(root, path) &&
    !(pathWithin(root, workspace) && !samePath(root, workspace) && pathWithin(workspace, path)));
}

export function createPathAccess({ workspace, project = workspace, base = workspace,
  protectedDirectories = [], accessPolicy = {}, protectedPath = sensitivePath }) {
  return async function checkedPath(input = '.', { directory = false, file = false, exists = directory || file,
    operations = ['read'], alternative = false } = {}) {
    const requested = resolveFilePath(base, input);
    assertPathPolicy(requested, accessPolicy, { operations, alternative });
    if (protectedPath(requested, workspace) || insideProtectedDirectory(requested, workspace, protectedDirectories))
      throw fileAccessDenied(requested, 'protected_path', { operations });
    const [located, actualWorkspace, actualProtected] = await Promise.all([
      locatePath(requested), realpath(workspace), Promise.all(protectedDirectories.map(physicalPath)),
    ]);
    const actual = located.path;
    const actualDenied = await Promise.all((accessPolicy.deniedPaths || []).map(async item => ({ ...item, path: await physicalPath(item.path) })));
    assertPathPolicy(actual, { deniedPaths: actualDenied }, { operations, alternative });
    if (protectedPath(actual, actualWorkspace) || insideProtectedDirectory(actual,
      samePath(workspace, actualWorkspace) ? actualWorkspace : workspace, actualProtected))
      throw fileAccessDenied(requested, 'resolved_protected_path', { operations });
    if (exists && !located.info) throw Object.assign(new Error('The requested path does not exist'), { code: 'ENOENT', path: requested });
    if (directory && located.info && !located.info.isDirectory()) throw new Error('Path is not a directory');
    if (file && located.info && !located.info.isFile()) throw new Error('Path is not a regular file');
    return actual;
  };
}

export async function createAuthorizedDirectory(input, checkedPath, { parentOfFile = false, alternative = false } = {}) {
  const options = { operations: ['write'], alternative, directory: !parentOfFile, file: parentOfFile, exists: false };
  const target = await checkedPath(input, options);
  const directory = parentOfFile ? dirname(target) : target;
  const missing = [];
  let current = directory;
  while (true) {
    const existing = await lstat(current).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing) {
      if (!existing.isDirectory() || !samePath(current, await realpath(current)))
        throw fileAccessDenied(target, 'output_parent_changed', { operations: ['write'] });
      break;
    }
    missing.push(current);
    current = dirname(current);
  }
  for (const next of missing.reverse()) {
    if (!samePath(target, await checkedPath(input, options)) || !samePath(dirname(next), await realpath(dirname(next))))
      throw fileAccessDenied(target, 'output_parent_changed', { operations: ['write'] });
    await mkdir(next).catch(error => { if (error.code !== 'EEXIST') throw error; });
    if (!(await lstat(next)).isDirectory() || !samePath(next, await realpath(next)))
      throw fileAccessDenied(target, 'output_parent_changed', { operations: ['write'] });
  }
  return checkedPath(input, options);
}
