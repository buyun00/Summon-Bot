import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { cleanEnvironment, terminateTree } from '../../bot/src/runtime/process-tools.mjs';
import { fail } from '../shared/validation.mjs';
import { pipeNativeText } from './windows-native-text.mjs';

const windows = process.platform === 'win32';
const windowsExtensions = ['.exe', '.com', '.cmd', '.bat', '.ps1'];
const executableName = path => windows ? basename(path, extname(path)).toLowerCase() : basename(path);
const validArg = value => typeof value === 'string' && value.length <= 32_768 && !value.includes('\0');
export const nativeSpawnFailureCode = error => ['ENOENT', 'ENOTDIR', 'ENOEXEC'].includes(error.code) ? 'native_spawn_failed' : undefined;

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
  if ([file, ...args].some(arg => /["%!\r\n]/.test(arg))) fail('Use a direct executable or pass complex values over stdin');
  const line = '"' + [file, ...args].map(arg => '"' + arg + '"').join(' ') + '"';
  return { file: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/v:off', '/c', line], options: { windowsVerbatimArguments: true } };
}

export async function localExecutable(path) {
  if (!isAbsolute(path)) fail('Use an absolute executable path');
  const file = await realpath(path);
  const info = await stat(file);
  if (!info.isFile() || windows && !windowsExtensions.includes(extname(path).toLowerCase())) fail('The selected path is not an executable file');
  if (!windows) await access(file, constants.X_OK);
  return { file: path, canonicalFile: file, name: executableName(path), size: info.size, modifiedAt: info.mtimeMs };
}

export function codexCredentials({ credential_refs: authorizedEnv = [] }) {
  return { authorizedEnv, env: Object.fromEntries(authorizedEnv.map(name => [name, { env: name }])) };
}

export function nativeEnvironment(references = {}, authorized = [], { codex = false } = {}) {
  if (!references || Array.isArray(references) || typeof references !== 'object') fail('Environment must map variable names to existing credential references');
  const base = /^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|TEMP|TMP|TMPDIR|USER|USERNAME|LANG|LANGUAGE|LC_[A-Z_]+|SHELL|TERM|XDG_(?:CONFIG|DATA|CACHE|STATE|RUNTIME)_HOME)$/i;
  const env = Object.fromEntries(Object.entries(cleanEnvironment()).filter(([key]) => base.test(key)));
  if (codex && process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  const secrets = [];
  for (const [key, ref] of Object.entries(references)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof ref?.env !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.env)) fail('Use {env: NAME} credential references');
    if (!authorized.includes(ref.env)) fail('Credential reference is not bound to this native resource', 403);
    if (/^(?:PATH|PATHEXT|COMSPEC|SYSTEMROOT|HOME|USERPROFILE|CODEX_HOME|NODE_OPTIONS|LD_PRELOAD|DYLD_.+)$/i.test(key))
      fail('Native credential references cannot override process setup variables');
    const value = process.env[ref.env];
    if (value === undefined) fail(`Native credential reference ${ref.env} is not configured`, 409);
    env[key] = value;
    if (value) secrets.push(value);
  }
  return { env, secrets };
}

export function redactNativeCredentials(text, secrets = []) {
  let result = String(text ?? '');
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[redacted]');
  return result;
}

export function redactNative(text, secrets) {
  return redactNativeCredentials(text, secrets)
    .replace(/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+)?PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/\b(?:sk|xai)-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/((?:authorization|password|passwd|(?:access|refresh)[_-]?token|api[_-]?key|client[_-]?secret)["']?\s*[:=]\s*["']?(?:Bearer )?)[^\s"',}]+/gi, '$1[redacted]');
}

export async function inspectNative(file, args, cwd, { signal, timeoutMs = 4000, env: refs, authorizedEnv, codex, encoding, input } = {}) {
  const { env, secrets } = nativeEnvironment(refs, authorizedEnv, { codex });
  const command = nativeCommand(file, nativeArgs(args));
  signal?.throwIfAborted();
  const startedAt = new Date().toISOString();
  const child = spawn(command.file, command.args, { ...command.options, env, cwd,
    windowsHide: true, detached: !windows, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  const decoders = Object.entries(output).map(([name]) => [name, pipeNativeText(child[name], chunk => {
    if (output[name].length < 65_536) output[name] += chunk.slice(0, 65_536 - output[name].length);
  }, codex ? 'utf8' : encoding?.[name])]);
  child.stdin?.on('error', () => { /* The process can close stdin before exiting. */ });
  child.stdin?.end(input);
  let stopped;
  const stop = () => { stopped ||= terminateTree(child); };
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const outcome = await new Promise(done => {
      child.once('error', error => done({ error: redactNative(error.message, secrets), code: nativeSpawnFailureCode(error) ?? error.code }));
      child.once('close', (exitCode, exitSignal) => done({ exitCode, exitSignal }));
    });
    return { file, args: args.map(arg => redactNative(arg, secrets)), startedAt, observedAt: new Date().toISOString(),
      ...outcome, ...(stopped ? { timeout: !signal?.aborted, interrupted: Boolean(signal?.aborted) } : {}),
      encoding: Object.fromEntries(decoders.map(([name, used]) => [name, used()])),
      ...Object.fromEntries(Object.entries(output).map(([key, value]) => [key, redactNative(value, secrets)])) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    await stopped;
  }
}
