import { spawn } from 'node:child_process';
import { access, readdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { cleanEnvironment, terminateTree } from '../../bot/src/runtime/process-tools.mjs';
import { fail, within } from '../shared/validation.mjs';

const windows = process.platform === 'win32';
const windowsExtensions = ['.exe', '.com', '.cmd', '.bat', '.ps1'];
const executableName = path => windows ? basename(path, extname(path)).toLowerCase() : basename(path);
export const executableKey = path => windows ? path.toLowerCase() : path;
const validArg = value => typeof value === 'string' && value.length <= 32_768 && !value.includes('\0');
export function nativeArgs(value = []) {
  if (!Array.isArray(value) || value.length > 128 || value.some(arg => !validArg(arg))) fail('Expected an array of up to 128 process arguments');
  return value;
}

export function nativeCommand(file, args) {
  const extension = extname(file).toLowerCase();
  if (!windows || !['.cmd', '.bat', '.ps1'].includes(extension)) return { file, args, options: {} };
  if (extension === '.ps1') return { file: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-File', file, ...args], options: {} };
  // cmd scripts have no argv API. Prevent a second evaluation of substitutions
  // or quote boundaries. Pass protocol payloads and multiline text over stdin.
  if ([file, ...args].some(arg => /["%!\r\n]/.test(arg))) fail('This Windows batch launcher needs quoted, expanded or multiline values passed over stdin, or a direct executable');
  const line = '"' + [file, ...args].map(arg => '"' + arg + '"').join(' ') + '"';
  return { file: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', line], options: { windowsVerbatimArguments: true } };
}

function pathRoots() {
  return String(process.env.PATH || '').split(delimiter).map(path => path.trim().replace(/^"|"$/g, '')).filter(isAbsolute);
}

function packageRoots(workspace) {
  return [
    workspace && join(workspace, 'node_modules', '.bin'),
    workspace && join(workspace, '.venv', windows ? 'Scripts' : 'bin'),
    workspace && join(workspace, 'bin'),
    process.env.USERPROFILE && join(process.env.USERPROFILE, '.dotnet', 'tools'),
    process.env.APPDATA && join(process.env.APPDATA, 'npm'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    process.env.USERPROFILE && join(process.env.USERPROFILE, 'scoop', 'shims'),
    process.env.ProgramData && join(process.env.ProgramData, 'chocolatey', 'bin'),
    process.env.CARGO_HOME && join(process.env.CARGO_HOME, 'bin'),
    process.env.HOME && join(process.env.HOME, '.cargo', 'bin'),
    process.env.HOME && join(process.env.HOME, '.local', 'bin'),
  ].filter(Boolean);
}

export async function localExecutable(path) {
  if (!isAbsolute(path)) fail('Use an absolute executable path');
  const file = await realpath(path);
  const info = await stat(file);
  if (!info.isFile() || windows && !windowsExtensions.includes(extname(path).toLowerCase())) fail('The selected path is not an executable file');
  if (!windows) await access(file, constants.X_OK);
  return { file: path, canonicalFile: file, name: executableName(path), size: info.size, modifiedAt: info.mtimeMs };
}

export async function findExecutable(name, cwd) {
  if (isAbsolute(name)) return localExecutable(name);
  if (basename(name) !== name || !name || /[<>|:*?]/.test(name)) fail('Use an executable name or absolute path');
  const names = windows && !windowsExtensions.includes(extname(name).toLowerCase()) ? windowsExtensions.map(ext => name + ext) : [name];
  for (const root of [...pathRoots(), ...packageRoots(cwd)]) {
    for (const candidate of names) {
      const info = await localExecutable(join(root, candidate)).catch(() => null);
      if (info) return info;
    }
  }
  fail('Executable was not found in the current PATH or package locations', 404);
}

export async function discoverExecutables(workspace, extraRoots = []) {
  const system = windows && process.env.SystemRoot;
  const roots = [...new Set([...extraRoots, ...pathRoots(), ...packageRoots(workspace)].map(path => resolve(path)))];
  const entries = new Map();
  for (const root of roots) {
    // The Windows system directory and app execution aliases are not an
    // installed CLI package inventory. An explicit command can still find them.
    if (system && within(system, root) || windows && basename(root).toLowerCase() === 'windowsapps') continue;
    const files = await readdir(root, { withFileTypes: true }).catch(() => []);
    const groups = new Map();
    for (const file of files) {
      if (file.name.startsWith('.') || !file.isFile() && !file.isSymbolicLink()) continue;
      const ext = extname(file.name).toLowerCase();
      if (windows && !windowsExtensions.includes(ext)) continue;
      const path = join(root, file.name), name = executableName(path);
      const prior = groups.get(name);
      if (!prior || windows && windowsExtensions.indexOf(ext) < windowsExtensions.indexOf(extname(prior).toLowerCase())) groups.set(name, path);
    }
    const discovered = await Promise.all([...groups.values()].map(path => localExecutable(path).catch(() => null)));
    for (const item of discovered.filter(Boolean)) {
      const key = executableKey(item.canonicalFile), existing = entries.get(key);
      if (existing) {
        if (!existing.aliases.includes(item.name)) existing.aliases.push(item.name);
      } else entries.set(key, { ...item, aliases: [item.name], source: root });
    }
  }
  return [...entries.values()];
}

export function nativeEnvironment(references = {}, authorized = []) {
  if (!references || Array.isArray(references) || typeof references !== 'object') fail('Environment must map variable names to existing credential references');
  const base = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|TEMP|TMP|TMPDIR|USER|USERNAME|LANG|LANGUAGE|LC_[A-Z_]+|SHELL|TERM|XDG_(?:CONFIG|DATA|CACHE|STATE|RUNTIME)_HOME)$/i;
  const env = Object.fromEntries(Object.entries(cleanEnvironment()).filter(([key]) => base.test(key)));
  const secrets = [];
  for (const [key, ref] of Object.entries(references)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref?.env || '')) fail('Use {env: NAME} credential references');
    if (!authorized.includes(ref.env)) fail('Credential reference is not bound to this native resource', 403);
    if (/^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|HOME|USERPROFILE|NODE_OPTIONS|LD_PRELOAD|DYLD_.+)$/i.test(key)) fail('Native credential references cannot override process setup variables');
    const value = process.env[ref.env];
    if (value === undefined) fail('A referenced native credential is not configured', 409);
    env[key] = value;
    if (value) secrets.push(value);
  }
  return { env, secrets };
}

export function redactNative(text, secrets = []) {
  let result = String(text ?? '');
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]');
  return result
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/((?:authorization|password|passwd|(?:access|refresh)[_-]?token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?(?:Bearer )?)[^\s"',}]+/gi, '$1[redacted]');
}

export async function inspectNative(file, args, cwd, { signal, timeoutMs = 4000, env: refs, authorizedEnv } = {}) {
  const { env, secrets } = nativeEnvironment(refs, authorizedEnv);
  const command = nativeCommand(file, nativeArgs(args));
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const child = spawn(command.file, command.args, { ...command.options, env, cwd,
    windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  for (const name of Object.keys(output)) {
    child[name].setEncoding('utf8');
    child[name].on('data', chunk => { if (output[name].length < 65_536) output[name] += chunk.slice(0, 65_536 - output[name].length); });
  }
  let stopped;
  const stop = () => { stopped ||= terminateTree(child); };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const outcome = await new Promise(done => {
      child.once('error', error => done({ error: redactNative(error.message, secrets) }));
      child.once('close', (exitCode, exitSignal) => done({ exitCode, exitSignal }));
    });
    return { file, args: args.map(arg => redactNative(arg, secrets)), startedAt, observedAt: new Date().toISOString(),
      ...outcome, ...(stopped ? { timeout: !signal?.aborted, interrupted: Boolean(signal?.aborted) } : {}),
      ...Object.fromEntries(Object.entries(output).map(([key, value]) => [key, redactNative(value, secrets)])) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    await stopped;
  }
}
