import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFileTools } from '../filesystem/tools.mjs';
import { ExecutionLock } from '../shared/execution-lock.mjs';

const WINDOWS = process.platform === 'win32';
const pause = ms => new Promise(resolveDone => setTimeout(resolveDone, ms));
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-agent-tools-'));
  const projectRoot = join(root, 'project');
  const workspace = join(projectRoot, '.relay', 'workspaces', 'bot-a');
  await mkdir(workspace, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const tools = new Map(createFileTools({ workspace, projectRoot, ...options }).map(tool => [tool.name, tool]));
  const execute = async (name, args, signal) => {
    const result = await tools.get(name).execute('test-tool-call', args, signal);
    assert.deepEqual(JSON.parse(result.content[0].text), result.details);
    return result.details;
  };
  return { root, projectRoot, workspace, tools, execute };
}

test('Bot performs a real write, read, search, exact edit and verified read-back', async t => {
  const calls = [];
  const { workspace, projectRoot, execute } = await fixture(t, { withExecution: async fn => { calls.push('locked'); return fn(); } });
  const saved = await execute('write_file', { path: 'reports/清单.md', content: '# 组件清单\nAlpha component\nBeta component\n' });
  assert.equal(saved.path, join(workspace, 'reports', '清单.md'));
  assert.equal(saved.verified, true);
  assert.match(saved.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(saved.path, 'utf8'), '# 组件清单\nAlpha component\nBeta component\n');
  const read = await execute('read_file', { path: saved.path, startLine: 2, maxLines: 1 });
  assert.equal(read.content, 'Alpha component');
  assert.equal(read.truncated, true);
  const search = await execute('search_files', { query: 'COMPONENT' });
  assert.equal(search.matches.length, 2);
  assert.equal(search.matches[0].line, 2);
  await assert.rejects(execute('edit_file', { path: saved.path, oldText: 'component', newText: '模块' }), /ambiguous/);
  await assert.rejects(execute('edit_file', { path: saved.path, oldText: 'absent', newText: '模块' }), /not found/);
  const edited = await execute('edit_file', { path: saved.path, oldText: 'Alpha component', newText: 'Alpha 模块' });
  assert.equal(edited.verified, true);
  assert.equal(edited.replacements, 1);
  assert.notEqual(edited.sha256, saved.sha256);
  assert.equal((await execute('read_file', { path: saved.path })).content, '# 组件清单\nAlpha 模块\nBeta component\n');
  await assert.rejects(execute('write_file', { path: saved.path, content: 'replacement' }), /EEXIST/);
  await execute('write_file', { path: saved.path, content: 'replacement', overwrite: true });
  assert.equal(await readFile(saved.path, 'utf8'), 'replacement');
  await writeFile(join(projectRoot, 'source.mjs'), 'export const component = 1;');
  assert.equal((await execute('search_files', { path: projectRoot, query: 'component' })).matches[0].path, join(projectRoot, 'source.mjs'));
  const listed = await execute('list_files', { recursive: true });
  assert.equal(listed.entries.find(entry => entry.path === saved.path).type, 'file');
  assert.equal(calls.length, 6);
});

test('filesystem tools reject traversal, credentials, runtime state and other Bot workspaces', async t => {
  const { root, projectRoot, execute } = await fixture(t);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'outside');
  const protectedPaths = [outside, join(projectRoot, '.env'), join(projectRoot, '.env.local'), join(projectRoot, '.git', 'config'), join(projectRoot, '.relay', 'relay.sqlite'), join(projectRoot, '.relay', 'workspaces', 'bot-b', 'report.md'), join(projectRoot, 'credentials.json')];
  for (const path of protectedPaths) {
    await assert.rejects(execute('read_file', { path }), /protected|outside/);
    await assert.rejects(execute('write_file', { path, content: 'forbidden', overwrite: true }), /protected|outside/);
  }
  await assert.rejects(execute('write_file', { path: '../../../../outside.txt', content: 'forbidden' }), /protected|outside/);
  await assert.rejects(execute('run_command', { command: 'echo outside', cwd: root }), /protected|outside/);
  assert.equal(await readFile(outside, 'utf8'), 'outside');
});

test('realpath validation rejects junction escapes, including missing children', async t => {
  const { root, workspace, execute } = await fixture(t);
  const outside = join(root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'hidden.txt'), 'hidden');
  await symlink(outside, join(workspace, 'escape'), WINDOWS ? 'junction' : 'dir');
  await assert.rejects(execute('read_file', { path: 'escape/hidden.txt' }), /protected|outside/);
  await assert.rejects(execute('write_file', { path: 'escape/new/nested.txt', content: 'forbidden' }), /protected|outside/);
  assert.equal((await execute('list_files', { recursive: true })).entries.length, 0);
  await assert.rejects(stat(join(outside, 'new')), /ENOENT/);
});

test('a custom runtime directory protects other Bots and state through direct and aliased paths', async t => {
  const { projectRoot } = await fixture(t);
  const protectedRoot = join(projectRoot, 'custom-state');
  const workspace = join(protectedRoot, 'bots', 'bot-a', 'workspace');
  const otherWorkspace = join(protectedRoot, 'bots', 'bot-b', 'workspace');
  await mkdir(workspace, { recursive: true });
  await mkdir(otherWorkspace, { recursive: true });
  await writeFile(join(otherWorkspace, 'notes.md'), 'another Bot private state');
  await writeFile(join(protectedRoot, 'runtime.db'), 'runtime state');
  const alias = join(projectRoot, 'state-alias');
  await symlink(protectedRoot, alias, WINDOWS ? 'junction' : 'dir');
  const tools = new Map(createFileTools({ workspace, projectRoot, protectedRoot }).map(tool => [tool.name, tool]));
  const execute = async (name, args) => (await tools.get(name).execute('custom-root-test', args)).details;
  const own = await execute('write_file', { path: 'own.md', content: 'my result' });
  assert.equal((await execute('read_file', { path: own.path })).content, 'my result');
  for (const path of [join(otherWorkspace, 'notes.md'), join(protectedRoot, 'runtime.db'), join(alias, 'bots', 'bot-b', 'workspace', 'notes.md')]) {
    await assert.rejects(execute('read_file', { path }), /protected/);
    await assert.rejects(execute('write_file', { path, content: 'forbidden', overwrite: true }), /protected/);
  }
  await assert.rejects(execute('run_command', { cwd: otherWorkspace, command: 'echo forbidden' }), /protected/);
  const listing = await execute('list_files', { path: projectRoot, recursive: true });
  assert.ok(listing.entries.every(entry => !entry.path.includes('custom-state') && !entry.path.includes('state-alias')));
  assert.equal(await readFile(join(otherWorkspace, 'notes.md'), 'utf8'), 'another Bot private state');
});

test('search skips binary and huge files; pagination and output limits are visible', async t => {
  const { workspace, execute } = await fixture(t);
  await writeFile(join(workspace, 'large.txt'), 'needle'.repeat(200000));
  await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  await writeFile(join(workspace, 'text.txt'), 'needle one\nneedle two\n');
  const result = await execute('search_files', { query: 'needle', maxResults: 1 });
  assert.equal(result.matches.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.skippedFiles, 2);
  await assert.rejects(execute('read_file', { path: 'large.txt' }), /limit/);
  assert.equal((await execute('list_files', { maxEntries: 1 })).truncated, true);
});

test('command runs in the real workspace with UTF-8, filtered environment and redacted output', async t => {
  const old = process.env.RELAY_TEST_SECRET;
  process.env.RELAY_TEST_SECRET = 'test-secret-must-not-reach-child';
  t.after(() => { if (old === undefined) delete process.env.RELAY_TEST_SECRET; else process.env.RELAY_TEST_SECRET = old; });
  const { workspace, execute } = await fixture(t, { redact: value => value.replaceAll('private-marker', '[redacted]') });
  const command = WINDOWS
    ? "[IO.File]::WriteAllText((Join-Path (Get-Location) 'command.txt'), '中文已写入', [Text.Encoding]::UTF8); Write-Output '中文输出 private-marker'; Write-Output ('secret=' + $env:RELAY_TEST_SECRET)"
    : "printf '中文已写入' > command.txt; printf '中文输出 private-marker\\nsecret=%s\\n' \"$RELAY_TEST_SECRET\"";
  const result = await execute('run_command', { command });
  assert.equal(result.cwd, workspace);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.match(result.stdout, /中文输出 \[redacted\]/);
  assert.doesNotMatch(result.stdout, /test-secret-must-not-reach-child/);
  assert.equal((await readFile(join(workspace, 'command.txt'), 'utf8')).replace(/^\uFEFF/, ''), '中文已写入');
});

test('default command file reading preserves UTF-8 Chinese text beside a UUID', async t => {
  const { execute } = await fixture(t);
  const content = '中文组件清单：7e896215-59a0-4e63-a53e-599a39184991\n读回验证完成';
  await execute('write_file', { path: 'result.md', content });
  const command = WINDOWS ? 'Get-Content -LiteralPath \'result.md\' -Raw; Write-Output "EXITCODE=$LASTEXITCODE"' : 'cat result.md';
  const result = await execute('run_command', { command });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.replace(/\r\n/g, '\n'), WINDOWS ? `${content}\nEXITCODE=\n` : content);
});

test('native command failure survives a subsequent successful PowerShell output command', async t => {
  const { execute } = await fixture(t);
  const command = WINDOWS
    ? `& '${process.execPath.replaceAll("'", "''")}' -e 'process.exit(7)'; Write-Output "EXITCODE=$LASTEXITCODE"`
    : 'exit 7';
  const result = await execute('run_command', { command });
  assert.equal(result.exitCode, 7);
  if (WINDOWS) assert.match(result.stdout, /EXITCODE=7/);
});

test('command timeout and cancellation terminate real running shells', async t => {
  const { execute } = await fixture(t);
  const command = WINDOWS ? 'Start-Sleep -Seconds 30' : 'sleep 30';
  const timed = await execute('run_command', { command, timeoutMs: 150 });
  assert.equal(timed.timedOut, true);
  assert.ok(timed.durationMs < 10000);
  const controller = new AbortController();
  const pending = execute('run_command', { command }, controller.signal);
  setTimeout(() => controller.abort(), 150);
  const aborted = await pending;
  assert.equal(aborted.aborted, true);
  assert.ok(aborted.durationMs < 10000);
  await assert.rejects(execute('read_file', { path: 'unused' }, controller.signal), { name: 'AbortError' });
});

test('command output is capped without unbounded buffering', async t => {
  const { execute } = await fixture(t);
  const command = WINDOWS ? "[Console]::Write(('x' * 100000))" : "head -c 100000 /dev/zero | tr '\\0' x";
  const result = await execute('run_command', { command });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 65536);
});

test('cancelling a command kills its real child process, not only the shell', async t => {
  const { workspace, execute } = await fixture(t);
  const controller = new AbortController();
  const command = WINDOWS
    ? "$worker = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') -ArgumentList '-NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"' -WindowStyle Hidden -PassThru; [IO.File]::WriteAllText((Join-Path (Get-Location) 'child.pid'), [string]$worker.Id); Wait-Process -Id $worker.Id"
    : "sleep 30 & child=$!; printf '%s' \"$child\" > child.pid; wait \"$child\"";
  const pending = execute('run_command', { command, timeoutMs: 20000 }, controller.signal);
  t.after(() => controller.abort());
  let pid;
  const deadline = Date.now() + 10000;
  while (!pid && Date.now() < deadline) {
    try { pid = Number(await readFile(join(workspace, 'child.pid'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!pid) await pause(25);
  }
  assert.ok(pid, 'child process must have started');
  process.kill(pid, 0);
  controller.abort();
  assert.equal((await pending).aborted, true);
  // A Unix child may briefly be a zombie until its new parent reaps it. Windows
  // immediately reports ESRCH once taskkill /T has terminated the descendant.
  if (WINDOWS) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('ExecutionLock is FIFO, cancels queued waiters and releases failed operations', async () => {
  const lock = new ExecutionLock();
  const first = await lock.acquire('first');
  assert.equal(lock.owner, 'first');
  const order = [];
  const cancelled = new AbortController();
  const skipped = lock.withLock('skipped', () => order.push('skipped'), cancelled.signal);
  const skippedAssertion = assert.rejects(skipped, { name: 'AbortError' });
  const second = lock.withLock('second', async () => { order.push('second'); await pause(10); });
  const third = lock.withLock('third', () => { order.push('third'); throw new Error('expected'); });
  const thirdAssertion = assert.rejects(third, /expected/);
  const fourth = lock.withLock('fourth', () => order.push('fourth'));
  assert.equal(lock.pending, 4);
  cancelled.abort();
  await skippedAssertion;
  assert.equal(lock.pending, 3);
  first(); first();
  await Promise.all([second, thirdAssertion, fourth]);
  assert.deepEqual(order, ['second', 'third', 'fourth']);
  assert.equal(lock.owner, null);
  assert.equal(lock.pending, 0);
  await assert.rejects(lock.acquire('already aborted', cancelled.signal), { name: 'AbortError' });
});

test('tool mutations respect the shared execution lock, including cancellation while queued', async t => {
  const lock = new ExecutionLock();
  const { workspace, execute } = await fixture(t, { withExecution: (fn, signal) => lock.withLock('bot', fn, signal) });
  const releaseCodex = await lock.acquire('codex');
  const controller = new AbortController();
  const blocked = execute('write_file', { path: 'cancelled.md', content: 'must never be written' }, controller.signal);
  const rejected = assert.rejects(blocked, { name: 'AbortError' });
  await pause(5);
  controller.abort();
  await rejected;
  releaseCodex();
  await assert.rejects(stat(join(workspace, 'cancelled.md')), /ENOENT/);
  await execute('write_file', { path: 'allowed.md', content: 'after Codex' });
  assert.equal(await readFile(join(workspace, 'allowed.md'), 'utf8'), 'after Codex');
});
