import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { initializeDeployment, launchService, stopService, inspectService, deploymentPath } from '../scripts/installation/system.mjs';
import { inspectServiceLock } from '../scripts/installation/service-lock.mjs';
import { BotManager } from '../capabilities/bot-management/service.mjs';
import { RecordStore } from '../capabilities/shared/store.mjs';

const releaseRoot = resolve(import.meta.dirname, '..');
const model = { provider: 'openai-compatible', model: 'test', baseUrl: 'http://127.0.0.1:1/v1' };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function rootDirectory() { return mkdtemp(join(tmpdir(), 'relay-service-log-test-')); }
async function removeRoot(root) { assert.equal(dirname(root), resolve(tmpdir())); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }

test('service startup IPC reports invalid logging configuration and releases its OS lock', { timeout: 15000 }, async t => {
  const root = await rootDirectory(); t.after(() => removeRoot(root));
  const { config } = await initializeDeployment({ dataRoot: root, releaseRoot, port: 0 });
  config.logs = { maxFiles: 0 }; await writeFile(deploymentPath(root), JSON.stringify(config));
  const began = Date.now(); await assert.rejects(launchService(config, 'gateway', { timeoutMs: 5000 }), /logs.maxFiles/);
  assert.ok(Date.now() - began < 5000); assert.equal(await inspectServiceLock(root, 'gateway'), null);
});

test('a failed duplicate service cannot modify the active process log', { timeout: 20000 }, async t => {
  const root = await rootDirectory(), { config } = await initializeDeployment({ dataRoot: root, releaseRoot, port: 0 });
  t.after(async () => { await stopService(config, 'gateway'); await removeRoot(root); });
  const live = await launchService(config, 'gateway'); await pause(50);
  const path = join(root, 'capabilities/gateway/logs/process.log'), before = await readFile(path);
  const child = fork(new URL('../scripts/installation/service.mjs', import.meta.url), ['--type', 'gateway', '--config', deploymentPath(root)], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const exited = once(child, 'exit'); const [receipt] = await once(child, 'message');
  assert.equal(receipt.type, 'error'); assert.match(receipt.message, /EADDRINUSE|EACCES/); assert.equal((await exited)[0], 1);
  assert.deepEqual(await readFile(path), before); assert.equal((await inspectService(config, 'gateway')).bootId, live.bootId);
});

test('service launch completes with no retained parent pipe or IPC dependency', { timeout: 20000 }, async t => {
  const root = await rootDirectory(), { config } = await initializeDeployment({ dataRoot: root, releaseRoot, port: 0 });
  t.after(async () => { await stopService(config, 'gateway'); await removeRoot(root); });
  const source = `import {launchService} from ${JSON.stringify(new URL('../scripts/installation/system.mjs', import.meta.url).href)};
    console.log(JSON.stringify(await launchService(${JSON.stringify(config)},'gateway')));`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; parent.stdout.on('data', data => stdout += data); parent.stderr.on('data', data => stderr += data);
  const [exit] = await once(parent, 'exit'); assert.equal(exit, 0, stderr);
  const started = JSON.parse(stdout.trim()); const live = await inspectService(config, 'gateway');
  assert.equal(live.state, 'ready'); assert.equal(live.bootId, started.bootId);
  assert.ok((await readFile(join(root, 'capabilities/gateway/logs/process.log'), 'utf8')).includes('gateway.ready'));
});

test('Bot manager receives log initialization failure before readiness timeout', { timeout: 20000 }, async t => {
  const root = await rootDirectory(); await mkdir(join(root, 'management'), { recursive: true });
  const store = new RecordStore(join(root, 'management/state.sqlite'));
  const manager = new BotManager({ store, dataRoot: root, releaseRoot, model });
  t.after(async () => { await manager.shutdownAll(); store.close(); await removeRoot(root); });
  await manager.create({ id: 'log-test', roleId: 'default' });
  await mkdir(join(root, 'bots/log-test/logs/process.log'), { recursive: true });
  const began = Date.now(); await assert.rejects(manager.start('log-test'), /process.log must be a regular file/);
  assert.ok(Date.now() - began < 5000); assert.equal(await manager.identity('log-test'), null);
});
