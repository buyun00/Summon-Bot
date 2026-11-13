import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, relative, resolve } from 'node:path';

export const FILE_ACCESS_GUIDANCE = 'Keep a refused file operation in its original scope. For a missing grant, ask about the exact path and operation in the original conversation or work, then recheck through the same capability. Preserve explicit user restrictions, protected paths and unknown outcomes. Report the operation actually attempted.';

export function fileAccessDenied(path, reason, extra = {}) {
  return Object.assign(new Error(`File access refused (${reason}). ${FILE_ACCESS_GUIDANCE}`), {
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

export function sensitivePath(path, workspace) {
  const parts = path.slice(parse(path).root.length).split(/[\\/]+/).map(part => part.toLowerCase());
  for (const [index, part] of parts.entries()) {
    if (part === '.git' || part === '.ssh' || part === '.aws' || part === '.azure' || part === 'gcloud') return true;
    if (part === '.relay' && !pathWithin(workspace, path)) return true;
    if (/^\.env(?:[.-]|$)/.test(part) || /^\.(?:npmrc|pypirc|netrc|git-credentials)$/.test(part)) return true;
    // Explicit review documents can share a prefix with credential containers.
    const credentialDocument = index === parts.length - 1 && /^credentials?[_-](?:[a-z0-9]+[_-])*(?:readme|guide|manual|design|spec|plan|report|brief|review(?:[_-]card)?)\.md$/.test(part);
    if (/^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|ds\.txt|summon\.sqlite(?:[.-].*)?)$/.test(part) && !credentialDocument) return true;
    if (/\.(?:pem|p12|pfx|key)$/.test(part) || part.includes(':')) return true;
  }
  return false;
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

const matchesFileGrant = (grant, requested) => grant.exact || grant.kind === 'file' ?
  samePath(grant.path, requested) : pathWithin(grant.path, requested);
const allowsFile = (grant, requested, operation) => grant.operations.includes(operation) && matchesFileGrant(grant, requested);

export function insideProtectedDirectory(path, workspace, roots) {
  return roots.some(root => pathWithin(root, path) &&
    !(pathWithin(root, workspace) && !samePath(root, workspace) && pathWithin(workspace, path)));
}

export function createPathAccess({ workspace, project = workspace, base = workspace, projectOnly = false, protectedDirectories = [], accessPolicy = {} }) {
  return async function checkedPath(input = '.', { directory = false, file = false, exists = directory || file,
    operations = ['read'], alternative = false } = {}) {
    const requested = resolveFilePath(base, input);
    assertPathPolicy(requested, accessPolicy, { operations, alternative });
    if (sensitivePath(requested, workspace) || insideProtectedDirectory(requested, workspace, protectedDirectories))
      throw fileAccessDenied(requested, 'protected_path', { operations });
    const roots = (projectOnly ? [project] : [workspace, project]).filter(root => pathWithin(root, requested));
    const grants = (accessPolicy.grants || []).filter(grant => matchesFileGrant(grant, requested));
    if ((grants.length || !roots.length) && !operations.every(operation => grants.some(grant => allowsFile(grant, requested, operation))))
      throw fileAccessDenied(requested, grants.length ? 'operation_not_granted' : 'outside_allowed_roots', {
        operations, ...(directory ? { kind: 'directory' } : file ? { kind: 'file' } : {}),
      });
    const [located, actualWorkspace, actualProject, actualProtected] = await Promise.all([
      locatePath(requested), realpath(workspace), realpath(project), Promise.all(protectedDirectories.map(physicalPath)),
    ]);
    const actual = located.path;
    const actualDenied = await Promise.all((accessPolicy.deniedPaths || []).map(async item => ({ ...item, path: await physicalPath(item.path) })));
    assertPathPolicy(actual, { deniedPaths: actualDenied }, { operations, alternative });
    if (sensitivePath(actual, actualWorkspace) || insideProtectedDirectory(actual,
      samePath(workspace, actualWorkspace) ? actualWorkspace : workspace, actualProtected))
      throw fileAccessDenied(requested, 'resolved_protected_path', { operations });
    const inRoot = roots.some(root => samePath(root, workspace) ? pathWithin(actualWorkspace, actual) :
      samePath(project, actualProject) && pathWithin(actualProject, actual));
    if (grants.length || !inRoot) {
      if (!samePath(requested, actual)) throw fileAccessDenied(requested, 'resolved_outside_allowed_roots', { operations });
      const confirmed = await Promise.all(grants.map(async grant => {
        const root = await locatePath(grant.path);
        const ancestorOfProtected = actualProtected.some(path => pathWithin(root.path, path));
        if (ancestorOfProtected || !samePath(grant.path, root.path) ||
          grant.kind === 'existing' && !root.info ||
          root.info && (grant.kind === 'directory' && !root.info.isDirectory() || grant.kind === 'file' && !root.info.isFile() ||
            !root.info.isDirectory() && !root.info.isFile())) return null;
        if (grant.kind === 'existing' && root.info.isFile() && !samePath(grant.path, actual)) return null;
        return grant;
      }));
      if (!operations.every(operation => confirmed.some(grant => grant && allowsFile(grant, actual, operation))))
        throw fileAccessDenied(requested, 'resolved_outside_allowed_roots', { operations });
    }
    if (exists && !located.info) throw Object.assign(new Error('The requested path does not exist'), { code: 'ENOENT', path: requested });
    if (directory && located.info && !located.info.isDirectory()) throw new Error('Path is not a directory');
    if (file && located.info && !located.info.isFile()) throw new Error('Path is not a regular file');
    return actual;
  };
}

export function assertScopedShell(cwd, policy = {}) {
  if (policy.grants?.length || policy.deniedPaths?.some(rule => !rule.alternativesOnly))
    throw fileAccessDenied(cwd, 'scoped_process_required', {
      instruction: 'Use the file capabilities or a catalog native method with explicit read and write path operands. A host shell cannot enforce this work’s file scope.',
    });
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

// A bounded lexer keeps quoted document data out of command recognition. This
// is for explicit PowerShell/.NET file operations, not a new OS sandbox.
function commandTokens(command) {
  const tokens = [];
  for (let i = 0; i < command.length;) {
    const char = command[i];
    if (char === '\r' || /[^\S\n]/.test(char)) { i++; continue; }
    if (char === '#') { while (i < command.length && command[i] !== '\n') i++; continue; }
    if (char === '@' && /['"]/.test(command[i + 1]) && /[\r\n]/.test(command[i + 2])) {
      const quote = command[i + 1], end = new RegExp(`\\r?\\n${quote}@`, 'g'); end.lastIndex = i + 2;
      const match = end.exec(command); tokens.push({ kind: 'string', value: command.slice(i + 2, match?.index ?? command.length) }); i = match ? end.lastIndex : command.length; continue;
    }
    if (char === "'" || char === '"') {
      const quote = char; let value = ''; i++;
      while (i < command.length) {
        if (command[i] === quote) { if (quote === "'" && command[i + 1] === quote) { value += quote; i += 2; continue; } i++; break; }
        if (quote === '"' && command[i] === '`' && i + 1 < command.length) { value += command[i + 1]; i += 2; } else value += command[i++];
      }
      tokens.push({ kind: 'string', value }); continue;
    }
    if ('=(),;|{}\n&+'.includes(char)) { tokens.push({ kind: 'symbol', value: char }); i++; continue; }
    const start = i;
    while (i < command.length && !/[\s'"=(),;|{}&+]/.test(command[i])) i++;
    tokens.push({ kind: 'word', value: command.slice(start, i).replace(/`(?=[A-Za-z_.-])/g, '') });
  }
  return tokens;
}
function argumentsAfter(tokens, index) {
  const groups = [[]]; let depth = 1;
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'symbol' && token.value === '(') depth++;
    if (token.kind === 'symbol' && token.value === ')' && !--depth) break;
    if (token.kind === 'symbol' && token.value === ',' && depth === 1) groups.push([]); else groups.at(-1).push(token);
  }
  return groups;
}
const readCommands = new Set(['get-content', 'gc', 'cat', 'type', 'get-item', 'test-path', 'get-childitem', 'select-string']);
const writeCommands = new Set(['set-content', 'add-content', 'out-file', 'remove-item', 'new-item']);
const readMethods = new Set(['readalltext', 'readalllines', 'readallbytes', 'openread', 'readfilesync', 'readfile', 'exists', 'enumeratefiles', 'getfiles']);
const writeMethods = new Set(['writealltext', 'writealllines', 'writeallbytes', 'appendalltext', 'openwrite', 'writefilesync', 'writefile', 'delete', 'createdirectory']);
function commandFileAccesses(command) {
  const tokens = commandTokens(command), variables = new Map(), accesses = [];
  const value = parts => {
    if (!parts?.length) return null;
    if (parts.length > 1) return parts.every((token, i) => i % 2 ? token.value === '+' : token.kind === 'string') ? parts.filter((_, i) => i % 2 === 0).map(token => token.value).join('') : null;
    const token = parts[0];
    if (token.kind === 'string') return token.value.includes('$') || /[\r\n]/.test(token.value) ? null : token.value;
    if (/^\$[\w]+$/.test(token.value)) return variables.get(token.value.toLowerCase()) ?? null;
    return token.kind === 'word' && !token.value.startsWith('-') ? token.value : null;
  };
  const add = (parts, operations) => accesses.push({ path: value(parts), operations });
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]; if (token.kind !== 'word') continue;
    if (/^\$\w+$/.test(token.value) && tokens[i + 1]?.value === '=') {
      const end = tokens.findIndex((item, j) => j > i + 1 && item.kind === 'symbol' && [';', '\n', '}'].includes(item.value));
      const assigned = value(tokens.slice(i + 2, end < 0 ? undefined : end));
      variables.set(token.value.toLowerCase(), assigned); continue;
    }
    const method = /(?:\]::|\.)([a-z]+)$/i.exec(token.value)?.[1].toLowerCase();
    if (method && tokens[i + 1]?.value === '(') {
      const args = argumentsAfter(tokens, i + 1);
      if (readMethods.has(method)) add(args[0], ['read']);
      else if (writeMethods.has(method)) add(args[0], ['write']);
      else if (['copy', 'move'].includes(method)) { add(args[0], method === 'copy' ? ['read'] : ['write']); add(args[1], ['write']); }
      continue;
    }
    const name = token.value.toLowerCase();
    if (!readCommands.has(name) && !writeCommands.has(name) && !['copy-item', 'move-item', 'rename-item'].includes(name)) continue;
    const end = tokens.findIndex((item, j) => j > i && item.kind === 'symbol' && [';', '\n', '|', '}', '{'].includes(item.value));
    const body = tokens.slice(i + 1, end < 0 ? undefined : end);
    const flag = names => {
      const index = body.findIndex(item => item.kind === 'word' && names.includes(item.value.toLowerCase()));
      if (index < 0) return null;
      const parts = []; let j = index + 1, depth = 0;
      while (j < body.length) {
        const next = body[j];
        if (!depth && parts.length && ![',', '+'].includes(next.value) && ![',', '+'].includes(parts.at(-1).value)) break;
        if (!depth && next.kind === 'word' && next.value.startsWith('-')) break;
        if (next.value === '(') depth++; if (next.value === ')') depth--;
        parts.push(next); j++;
      }
      return parts;
    };
    const positionals = [];
    for (let j = 0; j < body.length; j++) {
      if (body[j].kind === 'word' && body[j].value.startsWith('-')) {
        if (['-encoding', '-erroraction', '-ea', '-filter', '-include', '-exclude', '-value', '-inputobject', '-pattern', '-itemtype'].includes(body[j].value.toLowerCase())) j++;
        continue;
      }
      if (body[j].kind !== 'symbol') positionals.push([body[j]]);
    }
    const source = flag(['-literalpath', '-path', '-filepath']) || positionals[name === 'select-string' && !body.some(item => item.value.toLowerCase() === '-pattern') ? 1 : 0];
    const sources = source?.some(item => item.value === ',') ? source.reduce((groups, item) => { if (item.value === ',') groups.push([]); else groups.at(-1).push(item); return groups; }, [[]]) : [source];
    for (const path of sources) add(path, readCommands.has(name) || name === 'copy-item' ? ['read'] : ['write']);
    if (['copy-item', 'move-item', 'rename-item'].includes(name)) add(flag(['-destination', '-newname']) || positionals[1], ['write']);
  }
  return accesses;
}

export async function assertCommandPolicy(command, cwd, policy, checkOperand) {
  // Normalize simple literal concatenation/backtick spelling before checking a
  // denied target. Opaque payloads cannot establish that a refused operation is
  // unrelated, so use ordinary explicit commands for the remaining work.
  const visible = command.replace(/(['"])\s*\+\s*\1/g, '').replace(/`(?=[A-Za-z_.-])/g, '').replaceAll('\\', '/').toLowerCase();
  const constraints = policy?.deniedPaths || [];
  if (constraints.length && /(?:-(?:encodedcommand|enc)\b|frombase64string\s*\(|\b(?:invoke-expression|iex|eval|exec)\b|\b(?:node|python\d*|ruby|perl)\s+-(?:e|c)\b)/i.test(visible))
    throw fileAccessDenied(constraints[0].path, 'opaque_command_with_access_restriction');
  for (const access of commandFileAccesses(command)) {
    const relevant = constraints.filter(constraint => access.operations.some(operation => (constraint.operations || ['read', 'write']).includes(operation)));
    if (!access.path || /[*?]/.test(access.path)) {
      if (relevant.length) throw fileAccessDenied(relevant[0].path, 'unresolved_command_file_target', { originReason: relevant[0].originReason, operations: access.operations });
      continue;
    }
    const path = resolve(cwd, access.path);
    assertPathPolicy(path, policy, { operations: access.operations, alternative: true });
    await checkOperand(path, access.operations);
  }
}
