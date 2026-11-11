import { open, readdir, stat, realpath, mkdir, readFile, rename, link, unlink, mkdtemp, rm } from 'node:fs/promises';
import { constants, existsSync, createWriteStream } from 'node:fs';
import { resolve, isAbsolute, dirname, basename, join, delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWebTools } from './web-tools.mjs';
import { StringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { MAX_ATTACHMENT_BYTES } from '../chatroom/attachments.mjs';
import { cleanEnvironment, terminateTree, windowsProcessJob } from '../../bot/src/runtime/process-tools.mjs';
import { createPathAccess, assertCommandPolicy, fileAccessDenied } from '../../bot/src/capabilities/file-policy.mjs';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_REQUEST_BYTES = 24 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
export const commandTimeout = { minimum: 100, maximum: 240000, default: 90000 };
const READ_PAGE_BYTES = 128 * 1024;
const DEFAULT_LINES = 600;
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.hg', '.svn']);
const WINDOWS = process.platform === 'win32';
const objectSchema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const stringSchema = description => ({ type: 'string', description });
const integerSchema = (description, minimum, maximum) => ({ type: 'integer', description, minimum, maximum });
const publicationRejected = (message, status) => Object.assign(new Error(message), { code: 'FILE_PUBLICATION_REJECTED', status });

function cancelled(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Tool execution cancelled');
  error.name = 'AbortError';
  throw error;
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

function textValue(value, name, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.includes('\0')) throw new Error(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string without NUL`);
  return value;
}

function textPage(text, startLine, startColumn, maxLines) {
  const lines = text.split(/\r?\n/), parts = [];
  let line = startLine, column = startColumn, bytes = 0, endLine = Math.min(lines.length, startLine - 1), byteLimited = false;
  for (; line <= lines.length && parts.length < maxLines; line++, column = 1) {
    const row = lines[line - 1], part = row.slice(column - 1);
    if (column > row.length + 1 || /^[\uDC00-\uDFFF]/.test(part)) throw new Error('Invalid UTF-16 column for this line');
    const size = Buffer.byteLength(part);
    if (bytes + size + (parts.length ? 1 : 0) > READ_PAGE_BYTES) {
      byteLimited = true;
      if (!parts.length) {
        const buffer = Buffer.from(part);
        let end = READ_PAGE_BYTES;
        while ((buffer[end] & 0xc0) === 0x80) end--;
        const fragment = buffer.subarray(0, end).toString('utf8');
        parts.push(fragment); endLine = line; column += fragment.length;
      }
      break;
    }
    bytes += size + (parts.length ? 1 : 0);
    parts.push(part); endLine = line;
  }
  const next = line <= lines.length ? { startLine: line, startColumn: column } : null;
  return { content: parts.join('\n'), startLine, startColumn, endLine, totalLines: lines.length, truncated: Boolean(next), next,
    ...(next ? { truncation: { by: byteLimited ? 'bytes' : 'lines', maxBytes: READ_PAGE_BYTES, maxLines } } : {}) };
}

function defaultRedact(value) {
  return String(value).replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]');
}

async function runCommand(command, cwd, timeoutMs, signal, redact, saveArtifact, onArtifacts, tempRoot, containProcesses) {
  cancelled(signal);
  if (saveArtifact && tempRoot) await mkdir(tempRoot, { recursive: true });
  const outputDirectory = saveArtifact ? await mkdtemp(join(tempRoot || tmpdir(), 'summon-command-output-')) : null;
  try { cancelled(signal); }
  catch (error) { if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true }); throw error; }
  const fullOutput = outputDirectory ? Object.fromEntries(['stdout', 'stderr'].map(name =>
    [name, createWriteStream(join(outputDirectory, `${name}.log`), { mode: 0o600 })])) : null;
  let outputError;
  for (const output of Object.values(fullOutput || {})) output.on('error', error => { outputError ||= error; });
  const powerShellCandidates = WINDOWS ? [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    ...(process.env.PATH || '').split(delimiter).map(path => path.replace(/^"|"$/g, '')).filter(path => isAbsolute(path)).map(path => join(path, 'pwsh.exe')),
  ] : [];
  const shell = WINDOWS ? powerShellCandidates.find(path => existsSync(path)) || join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/sh';
  // Console encoding does not change Windows PowerShell 5's ANSI Get-Content
  // default. Set file cmdlet defaults too, so UTF-8 files from write_file round-trip.
  const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
${containProcesses ? windowsProcessJob : ''}
$PSDefaultParameterValues = @{ 'Get-Content:Encoding' = 'utf8'; 'Set-Content:Encoding' = 'utf8'; 'Add-Content:Encoding' = 'utf8'; 'Out-File:Encoding' = 'utf8'; 'Select-String:Encoding' = 'utf8' }
${command}
$summonCommandSucceeded = $?
$summonNativeExit = $LASTEXITCODE
if ($null -ne $summonNativeExit -and $summonNativeExit -ne 0) { exit $summonNativeExit }
if (-not $summonCommandSucceeded) { exit 1 }
`;
  const args = WINDOWS ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] : ['-c', command];
  const start = Date.now();
  const child = spawn(shell, args, { cwd, env: cleanEnvironment(), windowsHide: true, detached: !WINDOWS, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const name of ['stdout', 'stderr']) fullOutput?.[name].on('error', () => child[name].resume());
  let stdout = '', stderr = '', bytes = 0, truncated = false, timedOut = false, aborted = false, killing;
  const output = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const capture = (name, chunk) => {
    if (fullOutput && !outputError && !fullOutput[name].write(chunk)) {
      const source = name === 'stdout' ? child.stdout : child.stderr;
      source.pause(); fullOutput[name].once('drain', () => source.resume());
    }
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - bytes);
    if (chunk.length > remaining) truncated = true;
    const part = chunk.subarray(0, remaining);
    bytes += part.length;
    const text = output[name].write(part);
    if (name === 'stdout') stdout += text; else stderr += text;
  };
  child.stdout.on('data', chunk => capture('stdout', chunk));
  child.stderr.on('data', chunk => capture('stderr', chunk));
  const stop = () => { killing ||= terminateTree(child); };
  const abort = () => { aborted = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  try {
    const status = await new Promise((resolveDone, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, exitSignal) => resolveDone({ exitCode, exitSignal }));
    });
    if (killing) await killing;
    stdout += output.stdout.end(); stderr += output.stderr.end();
    if (fullOutput) {
      for (const stream of Object.values(fullOutput)) stream.end();
      await Promise.all(Object.values(fullOutput).map(stream => finished(stream)));
      if (outputError) throw outputError;
      for (const name of ['stdout', 'stderr']) {
        const content = redact(await readFile(join(outputDirectory, `${name}.log`), 'utf8'));
        const artifact = await saveArtifact({ name: `command-${name}.log`, content, mimeType: 'text/plain; charset=utf-8' });
        await onArtifacts?.([artifact]);
      }
    }
    return { cwd, shell, ...status, stdout: redact(stdout), stderr: redact(stderr), timedOut, aborted, truncated, durationMs: Date.now() - start };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (containProcesses && !WINDOWS) await terminateTree(child);
    if (fullOutput) {
      for (const stream of Object.values(fullOutput)) stream.destroy();
      await Promise.allSettled(Object.values(fullOutput).map(stream => finished(stream)));
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }
}

/** Filesystem access is constrained here; command cwd is a convenience, not an OS sandbox. */
export function createFileTools({ workspace, projectRoot, protectedRoot, protectedRoots = [], accessPolicy = {}, signal: defaultSignal, withExecution = async fn => fn(), redact = defaultRedact, saveArtifact, onArtifacts, publishFile, tempRoot, containProcesses = false }) {
  const workspaceRoot = resolve(textValue(workspace, 'workspace'));
  const project = resolve(textValue(projectRoot, 'projectRoot'));
  const protectedDirectories = [...new Set([protectedRoot, ...protectedRoots].filter(value => value != null)
    .map(value => resolve(textValue(value, 'protectedRoot'))))];
  const sanitize = value => defaultRedact(redact(String(value)));
  const sanitizeResult = value => {
    if (typeof value === 'string') return sanitize(value);
    if (Array.isArray(value)) return value.map(sanitizeResult);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeResult(item)]));
    return value;
  };
  const checkedPath = createPathAccess({ workspace: workspaceRoot, project, protectedDirectories, accessPolicy });

  async function readText(path, signal) {
    cancelled(signal);
    const handle = await open(path, constants.O_RDONLY);
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error('Path is not a regular file');
      if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} byte limit`);
      const data = await handle.readFile({ signal });
      if (data.length > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} byte limit`);
      if (data.includes(0)) throw new Error('Binary files are not supported');
      return data.toString('utf8');
    } finally { await handle.close(); }
  }

  async function saveVerified(path, bytes, signal, { overwrite = false, expected } = {}) {
    const temporary = join(dirname(path), `.summon-write-${randomUUID()}.tmp`);
    let mode;
    try { mode = (await stat(path)).mode; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const handle = await open(temporary, 'wx', mode);
      try { await handle.writeFile(bytes, { signal }); await handle.sync(); } finally { await handle.close(); }
      if (!(await readFile(temporary, { signal })).equals(bytes)) throw new Error('Temporary write failed read-back verification');
      if (expected !== undefined && await readText(path, signal) !== expected) throw new Error('File changed since it was read; retry with current content');
      cancelled(signal);
      // Publish complete bytes atomically. link preserves the no-overwrite contract;
      // rename replaces an existing file only when explicitly authorized.
      if (overwrite) await rename(temporary, path);
      else await link(temporary, path);
      const saved = await readFile(path);
      if (!saved.equals(bytes)) throw new Error('Write completed but read-back verification failed');
      return { path, bytes: saved.length, verified: true };
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function* walk(base, { recursive, maxDepth = 12, maxVisited = 10000, signal }) {
    const pending = [{ path: base, depth: 0 }];
    const visited = new Set();
    let count = 0;
    while (pending.length) {
      cancelled(signal);
      const current = pending.shift();
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      for (const entry of await readdir(current.path, { withFileTypes: true })) {
        cancelled(signal);
        if (++count > maxVisited) { yield { limitReached: true }; return; }
        const dependencyDirectory = entry.name.toLowerCase() === 'node_modules';
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase()) && !dependencyDirectory) continue;
        const requested = join(current.path, entry.name);
        let path, info;
        try { path = await checkedPath(requested); info = await stat(path); }
        catch (error) { if (error.name === 'AbortError') throw error; continue; }
        if (!info.isFile() && !info.isDirectory()) continue;
        yield { path, type: info.isDirectory() ? 'directory' : 'file', size: info.size,
          ...(dependencyDirectory && info.isDirectory() ? { contentsExcluded: true } : {}) };
        if (recursive && info.isDirectory() && !dependencyDirectory && current.depth < maxDepth) pending.push({ path, depth: current.depth + 1 });
      }
    }
  }

  function tool(name, description, parameters, operation, mutation = false) {
    return { name, label: name.replaceAll('_', ' '), description, parameters,
      async execute(_toolCallId, args, callSignal) {
        const signal = defaultSignal && callSignal ? AbortSignal.any([defaultSignal, callSignal]) : callSignal || defaultSignal;
        cancelled(signal);
        try {
          const perform = async () => { cancelled(signal); return operation(args || {}, signal); };
          const details = sanitizeResult(mutation ? await withExecution(perform, signal) : await perform());
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
        } catch (error) {
          if (['EACCES', 'EPERM'].includes(error.code)) error = fileAccessDenied(resolve(workspaceRoot, args?.path || args?.cwd || '.'), 'os_permission_denied');
          const safe = new Error(sanitize(error.message || String(error)));
          safe.name = error.name || 'Error';
          for (const key of ['code', 'status', 'accessDenial', 'outcomeUnknown']) if (error[key] !== undefined) safe[key] = sanitizeResult(error[key]);
          throw safe;
        }
      },
    };
  }

  return [
    ...createWebTools(),
    tool('publish_file', 'Publish a verified work file as a chat attachment. Supply the returned attachment ID to work_notify. Standalone HTML/text receives an isolated browser preview.', objectSchema({path:stringSchema('Finished file in this authorized workspace/project'),name:stringSchema('Optional download filename'),mimeType:stringSchema('Optional MIME type')},['path']), async (args, signal) => {
      if (!publishFile) throw publicationRejected('File publication requires the installed chat attachment capability', 409);
      const path = await checkedPath(args.path, { alternative: true });
      const handle = await open(path, constants.O_RDONLY);
      let bytes, before;
      try {
        before = await handle.stat();
        if (!before.isFile()) throw publicationRejected('Chat publication requires a regular file', 400);
        if (before.size > MAX_ATTACHMENT_BYTES) throw publicationRejected(
          `File has ${before.size} bytes. Each chat attachment allows at most ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB (${MAX_ATTACHMENT_BYTES} bytes)`, 413);
        bytes = await handle.readFile({ signal });
        const after = await handle.stat();
        if (before.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || await realpath(path) !== path)
          throw publicationRejected('File changed while preparing publication; finish writing it before publishing', 409);
      } finally { await handle.close(); }
      return publishFile({name:basename(args.name || path),mimeType:args.mimeType,data:bytes.toString('base64')},
        {path,size:before.size,mtimeMs:before.mtimeMs,ctimeMs:before.ctimeMs});
    }, true),
    tool('list_files', 'List allowed files and directories. Dependency directories are shown without their contents; protected paths are omitted. An omitted entry is not proof of absence. Relative paths start in your workspace.', objectSchema({ path: stringSchema('Directory; defaults to workspace'), recursive: { type: 'boolean' }, maxEntries: integerSchema('Maximum entries, default 200', 1, 500), maxDepth: integerSchema('Recursion depth, default 4', 0, 12) }), async (args, signal) => {
      const path = await checkedPath(args.path, { directory: true });
      const maxEntries = boundedInteger(args.maxEntries, 200, 1, 500, 'maxEntries');
      const maxDepth = boundedInteger(args.maxDepth, 4, 0, 12, 'maxDepth');
      const entries = [];
      let truncated = false, outputBytes = 0;
      for await (const entry of walk(path, { recursive: Boolean(args.recursive), maxDepth, signal })) {
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (entry.limitReached || entries.length >= maxEntries || outputBytes + size > MAX_OUTPUT_BYTES) { truncated = true; break; }
        outputBytes += size;
        entries.push(entry);
      }
      return { path, entries, truncated, listingPolicy: { protectedPathsOmitted: true, dependencyContentsExcluded: true,
        absenceIsNotConfirmed: true } };
    }),
    tool('read_file', 'Read a page of an allowed UTF-8 text file up to 8 MiB. Use the returned next line and column to continue, including within a single long line. Relative paths start in your workspace.', objectSchema({ path: stringSchema('File path'), startLine: integerSchema('First line, 1 based', 1, 10000000), startColumn: integerSchema('First UTF-16 column, 1 based; use next.startColumn when paging', 1, MAX_FILE_BYTES + 1), maxLines: integerSchema('Maximum lines per page, default 600', 1, 2000) }, ['path']), async (args, signal) => {
      const path = await checkedPath(args.path);
      const startLine = boundedInteger(args.startLine, 1, 1, 10000000, 'startLine');
      const startColumn = boundedInteger(args.startColumn, 1, 1, MAX_FILE_BYTES + 1, 'startColumn');
      const maxLines = boundedInteger(args.maxLines, DEFAULT_LINES, 1, 2000, 'maxLines');
      const text = await readText(path, signal);
      return { path, ...textPage(text, startLine, startColumn, maxLines) };
    }),
    tool('search_files', 'Search plain text in allowed UTF-8 files recursively without external commands; protected files and dependencies are excluded. Large and binary files are skipped.', objectSchema({ query: stringSchema('Literal text to find'), path: stringSchema('File or directory; defaults to workspace'), caseSensitive: { type: 'boolean' }, maxResults: integerSchema('Maximum matches, default 100', 1, 200) }, ['query']), async (args, signal) => {
      const query = textValue(args.query, 'query');
      if (query.length > 2000) throw new Error('query is too long');
      const path = await checkedPath(args.path);
      const maxResults = boundedInteger(args.maxResults, 100, 1, 200, 'maxResults');
      const needle = args.caseSensitive ? query : query.toLowerCase();
      const matches = [];
      let truncated = false, skippedFiles = 0, scannedFiles = 0, outputBytes = 0;
      const info = await stat(path);
      const entries = info.isDirectory() ? walk(path, { recursive: true, signal }) : [{ path, type: 'file', size: info.size }];
      for await (const entry of entries) {
        cancelled(signal);
        if (entry.limitReached) { truncated = true; break; }
        if (entry.type !== 'file') continue;
        let text;
        try { text = await readText(entry.path, signal); } catch (error) { if (error.name === 'AbortError') throw error; skippedFiles++; continue; }
        scannedFiles++;
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (!(args.caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
          const match = { path: entry.path, line: index + 1, text: line.slice(0, 1000), lineTruncated: line.length > 1000 };
          const size = Buffer.byteLength(JSON.stringify(match));
          if (matches.length >= maxResults || outputBytes + size > MAX_OUTPUT_BYTES) { truncated = true; break; }
          outputBytes += size; matches.push(match);
        }
        if (truncated) break;
      }
      return { path, query, matches, scannedFiles, skippedFiles, truncated };
    }),
    tool('write_file', 'Write a UTF-8 file atomically, creating parent directories. Existing files require overwrite:true. Returns the saved path and byte count after read-back.', objectSchema({ path: stringSchema('Destination file path'), content: stringSchema('Complete UTF-8 content, at most 1 MiB'), overwrite: { type: 'boolean', description: 'Explicitly allow replacing an existing file; default false' } }, ['path', 'content']), async (args, signal) => {
      const content = textValue(args.content, 'content', true);
      const bytes = Buffer.from(content);
      if (bytes.length > MAX_FILE_BYTES) throw new Error('Content exceeds 8 MiB');
      let path = await checkedPath(args.path, { operations: ['write'] });
      cancelled(signal);
      await mkdir(dirname(path), { recursive: true });
      path = await checkedPath(args.path, { operations: ['write'] });
      return saveVerified(path, bytes, signal, { overwrite: args.overwrite === true });
    }, true),
    tool('edit_file', 'Replace exactly one occurrence of oldText in a UTF-8 file. Fails on missing or ambiguous matches, then re-reads and verifies the saved bytes.', objectSchema({ path: stringSchema('Existing file'), oldText: stringSchema('Exact text that occurs once'), newText: stringSchema('Replacement text; may be empty') }, ['path', 'oldText', 'newText']), async (args, signal) => {
      const oldText = textValue(args.oldText, 'oldText', true);
      if (!oldText.length) throw new Error('oldText must not be empty');
      const newText = textValue(args.newText, 'newText', true);
      let path = await checkedPath(args.path, { operations: ['read', 'write'] });
      const original = await readText(path, signal);
      const index = original.indexOf(oldText);
      if (index < 0) throw new Error('oldText was not found; read the file before editing');
      if (original.indexOf(oldText, index + 1) >= 0) throw new Error('oldText is ambiguous; provide enough context for a unique match');
      const bytes = Buffer.from(original.slice(0, index) + newText + original.slice(index + oldText.length));
      if (bytes.length > MAX_FILE_BYTES) throw new Error('Edited content exceeds 8 MiB');
      cancelled(signal);
      path = await checkedPath(args.path, { operations: ['read', 'write'] });
      return { ...await saveVerified(path, bytes, signal, { overwrite: true, expected: original }), replacements: 1 };
    }, true),
    tool('run_command', 'Execute a non-interactive shell command (PowerShell on Windows), with a timeout and capped output. File access refusals and explicit user file restrictions apply across tools, including shell/.NET, copies and renames. cwd is not an OS sandbox; commands run with host-user privileges. Do not access credentials or delete unrelated files.', objectSchema({ command: stringSchema('Shell command'), cwd: stringSchema('Allowed working directory; defaults to workspace'), timeoutMs: integerSchema(`Timeout in milliseconds, default ${commandTimeout.default}`, commandTimeout.minimum, commandTimeout.maximum) }, ['command']), async (args, signal) => {
      const command = textValue(args.command, 'command');
      if (command.length > 20000) throw new Error('command is too long');
      const cwd = await checkedPath(args.cwd, { directory: true });
      await assertCommandPolicy(command, cwd, accessPolicy, (path, operations) => checkedPath(path, { operations, alternative: true }));
      const timeoutMs = boundedInteger(args.timeoutMs, commandTimeout.default, commandTimeout.minimum, commandTimeout.maximum, 'timeoutMs');
      return runCommand(command, cwd, timeoutMs, signal, sanitize, saveArtifact, onArtifacts, tempRoot, containProcesses);
    }, true),
  ];
}
