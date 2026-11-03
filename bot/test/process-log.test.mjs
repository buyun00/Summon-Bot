import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { createProcessLog, normalizeLogConfig } from '../src/runtime/process-log.mjs';
import { inspectInstanceIdentity } from '../src/runtime/identity-lock.mjs';
import { requestBot } from '../src/messaging/client.mjs';

const moduleUrl = new URL('../src/runtime/process-log.mjs', import.meta.url).href;
const pause = ms => new Promise(done => setTimeout(done, ms));
const cleanups = new WeakMap();
async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'summon-process-log-test-'));
  cleanups.set(t, []);
  t.after(async () => { for (const cleanup of cleanups.get(t).reverse()) await cleanup(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return root;
}
async function logFiles(root) {
  const names = (await readdir(root)).filter(name => /^process(?:\.\d{13}\.\d+\.[a-f0-9-]{36})?\.log$/.test(name));
  const key = name => name === 'process.log' ? [Infinity, Infinity] : name.split('.').slice(1, 3).map(Number);
  names.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]);
  return Promise.all(names.map(async name => ({ name, data: await readFile(join(root, name)) })));
}
async function execute(code) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', error = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => error += data);
  const [status] = await once(child, 'exit'); return { status, output, error };
}
async function waitFor(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(20); }
  throw new Error(message);
}

test('capacity rotation bounds huge UTF-8 writes and leaves unrelated evidence intact', async t => {
  const root = await directory(t); await writeFile(join(root, 'artifact.json'), '{"evidence":true}');
  await mkdir(join(root, `process.${Date.now()}.0.${randomUUID()}.log`));
  const log = createProcessLog(root, { maxFileBytes: 257, maxFiles: 3 });
  const text = '😀汉字'.repeat(2000) + '\nFINAL成果\n'; log.write(text); log.close(); log.close();
  // A directory resembling an archive is never deleted or read as log content.
  const regular = [];
  for (const name of await readdir(root)) if ((await stat(join(root, name))).isFile() && name.endsWith('.log')) regular.push({ name, data: await readFile(join(root, name)) });
  assert.equal(regular.length, 3);
  for (const file of regular) { assert.ok(file.data.length <= 257); new TextDecoder('utf-8', { fatal: true }).decode(file.data); }
  assert.ok((await readFile(join(root, 'process.log'), 'utf8')).endsWith('FINAL成果\n'));
  assert.equal(await readFile(join(root, 'artifact.json'), 'utf8'), '{"evidence":true}');
  assert.ok((await readdir(root)).length === 5);
});

test('retention removes only owned expired archives and bounds an inherited oversized active log', async t => {
  const root = await directory(t), expired = `process.${Date.now() - 8 * 86400000}.0.${randomUUID()}.log`;
  await writeFile(join(root, expired), 'expired'); await writeFile(join(root, 'process.log'), '汉字'.repeat(3000) + '最新');
  await writeFile(join(root, 'process.unrecognized.log'), 'keep');
  const log = createProcessLog(root, { maxFileBytes: 101, maxFiles: 2 }); log.close();
  assert.ok(!(await readdir(root)).includes(expired));
  const active = await readFile(join(root, 'process.log')); assert.ok(active.length <= 101);
  assert.ok(new TextDecoder('utf-8', { fatal: true }).decode(active).endsWith('最新'));
  assert.equal(await readFile(join(root, 'process.unrecognized.log'), 'utf8'), 'keep');
  assert.throws(() => normalizeLogConfig({ maxFileBytes: 3 }), /maxFileBytes/);
  assert.throws(() => normalizeLogConfig({ maxFiles: 0 }), /maxFiles/);
  assert.throws(() => normalizeLogConfig({ retentionDays: 0 }), /retentionDays/);
});

test('an old active file with a recent write survives a new process log owner', async t => {
  const root = await directory(t), path = join(root, 'process.log');
  await writeFile(path, 'older creation'); await pause(250); await writeFile(path, 'fresh diagnostics 今天');
  const file = await stat(path); assert.ok(Date.now() - file.birthtimeMs >= 200);
  const log = createProcessLog(root, { retentionDays: 200 / 86400000, sweepIntervalMs: 10 });
  log.close(); assert.equal(await readFile(path, 'utf8'), 'fresh diagnostics 今天');
});

test('time rotation retains recently written tail data and capacity maintenance does not renew expired data', async t => {
  const root = await directory(t), path = join(root, 'process.log');
  const log = createProcessLog(root, { retentionDays: 200 / 86400000, sweepIntervalMs: 10 });
  log.write('first\n'); const firstTime = Date.now(); await pause(30); log.write('recent tail\n');
  log.maintain(firstTime + 201); log.close();
  assert.ok((await logFiles(root)).some(file => file.name !== 'process.log' && file.data.toString().includes('recent tail')));
  const expiredRoot = join(root, 'expired'); await mkdir(expiredRoot); const expired = join(expiredRoot, 'process.log');
  await writeFile(expired, 'old data'.repeat(200)); const oldTime = new Date(Date.now() - 8 * 86400000); await utimes(expired, oldTime, oldTime);
  const old = createProcessLog(expiredRoot, { maxFileBytes: 128 }); old.close();
  assert.deepEqual((await logFiles(expiredRoot)).map(file => [file.name, file.data.length]), [['process.log', 0]]);
});

test('stdout/stderr capture preserves callbacks, encoding, split UTF-8 and synchronous exit flush', async t => {
  const root = await directory(t), report = join(root, 'callbacks.json');
  const result = await execute(`import {installProcessLog} from ${JSON.stringify(moduleUrl)}; import {writeFileSync} from 'node:fs';
    installProcessLog(${JSON.stringify(root)}, {maxFileBytes:128,maxFiles:5}, {tee:false});
    const calls=[]; let sync=true; const done=name=>()=>calls.push({name,sync});
    process.stdout.write('first ',done('short')); process.stdout.write('e6b189','hex',done('encoding'));
    const emoji=Buffer.from('😀');process.stdout.write(emoji.subarray(0,2));
    process.stderr.write(new Uint8Array(Buffer.from('stderr\\n')),done('bytes'));
    process.stdout.write(emoji.subarray(2)); console.log(' console');console.error('error console');
    sync=false;setImmediate(()=>{writeFileSync(${JSON.stringify(report)},JSON.stringify(calls));
      process.stdout.write(Buffer.from([0xe6]));process.exit(0);});`);
  assert.equal(result.status, 0, result.error); assert.equal(result.output, '');
  assert.deepEqual(JSON.parse(await readFile(report, 'utf8')), [{ name: 'short', sync: false }, { name: 'encoding', sync: false }, { name: 'bytes', sync: false }]);
  const text = (await logFiles(root)).map(file => new TextDecoder('utf-8', { fatal: true }).decode(file.data)).join('');
  assert.equal(text, 'first 汉stderr\n😀 console\nerror console\n�');
});

test('idle log retention is enforced by the child timer without further writes', async t => {
  const root = await directory(t);
  const result = await execute(`import {installProcessLog} from ${JSON.stringify(moduleUrl)};
    installProcessLog(${JSON.stringify(root)},{retentionDays:40/86400000,sweepIntervalMs:10},{tee:false});
    console.log('expires without another write');setTimeout(()=>process.exit(0),120);`);
  assert.equal(result.status, 0, result.error);
  assert.deepEqual((await logFiles(root)).map(file => [file.name, file.data.length]), [['process.log', 0]]);
});

test('a detached logger continues rotating after its spawning process exits', { timeout: 15000 }, async t => {
  const root = await directory(t), stopped = join(root, 'stopped'), stop = join(root, 'stop'), progress = join(root, 'progress');
  const source = `import {installProcessLog} from ${JSON.stringify(moduleUrl)};import {existsSync,writeFileSync} from 'node:fs';
    const log=installProcessLog(${JSON.stringify(root)},{maxFileBytes:128,maxFiles:2},{tee:false});let n=0;
    const timer=setInterval(()=>{console.log(('独立😀'+n).repeat(70));writeFileSync(${JSON.stringify(progress)},String(++n));
      if(existsSync(${JSON.stringify(stop)})||n>=500){clearInterval(timer);log.close();writeFileSync(${JSON.stringify(stopped)},'done');}},10);`;
  cleanups.get(t).push(async () => { await writeFile(stop, 'stop'); await waitFor(() => readFile(stopped).then(() => true, () => false), 'Detached fixture did not stop'); });
  const parent = await execute(`import {spawn} from 'node:child_process';const child=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(source)}],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();console.log(child.pid);`);
  assert.equal(parent.status, 0, parent.error); assert.ok(Number(parent.output.trim()) > 0);
  await waitFor(() => readFile(progress, 'utf8').then(value => Number(value) >= 12, () => false), 'Detached child did not continue');
  await writeFile(stop, 'stop'); await waitFor(() => readFile(stopped).then(() => true, () => false), 'Detached child did not stop');
  const files = await logFiles(root); assert.equal(files.length, 2);
  for (const file of files) { assert.ok(file.data.length <= 128); new TextDecoder('utf-8', { fatal: true }).decode(file.data); }
});

async function launch(t, root, config, name = 'input.json') {
  const path = join(root, name); await writeFile(path, JSON.stringify(config));
  const child = fork(new URL('../bin/summon-bot.mjs', import.meta.url), ['--config', path], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let stderr = ''; child.stdout.resume(); child.stderr.on('data', data => stderr += data);
  const exited = once(child, 'exit'); let ready;
  cleanups.get(t).push(async () => {
    if (ready && child.exitCode === null) await requestBot({ url: ready.url, token: config.token }, '/shutdown', { method: 'POST' }).catch(() => {});
    if (child.exitCode === null && !ready) child.kill();
    await exited;
  });
  const message = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI receipt timed out: ${stderr}`)), 10000);
    child.once('message', value => { clearTimeout(timer); done(value); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before receipt ${code}: ${stderr}`)); });
  });
  if (message.type === 'ready') ready = message;
  return { child, message, exited, stderr };
}
const botConfig = root => ({ botId: 'logger-test', dataDir: root, token: 'process-log-test-controller-token', model: { provider: 'openai-compatible', model: 'test', baseUrl: 'http://127.0.0.1:1/v1' } });

test('duplicate actual CLI startup cannot truncate or rotate the current owner log', { timeout: 20000 }, async t => {
  const root = await directory(t), config = botConfig(root);
  const first = await launch(t, root, config); assert.equal(first.message.type, 'ready');
  await pause(50); const before = await readFile(join(root, 'logs', 'process.log'));
  const second = await launch(t, root, { ...config, logs: { maxFileBytes: 4, maxFiles: 1 } }, 'duplicate.json');
  assert.equal(second.message.type, 'error'); assert.equal(second.message.code, 'INSTANCE_ALREADY_RUNNING'); assert.equal((await second.exited)[0], 1);
  assert.deepEqual(await readFile(join(root, 'logs', 'process.log')), before);
  assert.equal((await inspectInstanceIdentity(root)).bootId, first.message.bootId);
});

test('CLI log initialization failure returns its cause and releases OS identity', { timeout: 15000 }, async t => {
  const root = await directory(t); await mkdir(join(root, 'logs', 'process.log'), { recursive: true });
  const result = await launch(t, root, botConfig(root));
  assert.equal(result.message.type, 'error'); assert.match(result.message.message, /regular file/);
  assert.equal((await result.exited)[0], 1); assert.equal(await inspectInstanceIdentity(root), null);
});
