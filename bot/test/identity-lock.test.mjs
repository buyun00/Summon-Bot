import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireIdentityLock, inspectInstanceIdentity } from '../src/runtime/identity-lock.mjs';
import { requestBot } from '../src/messaging/client.mjs';

const pause = ms => new Promise(done => setTimeout(done, ms));
const identity = bootId => ({ protocol: 'summon-instance-lock-v1', botId: 'identity-test', pid: process.pid, bootId, state: 'ready' });
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'summon-identity-test-'));
  t.after(async () => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return dir;
}
async function endpoint(dir) {
  const probe = await acquireIdentityLock(dir, () => identity('probe'));
  const address = probe.address; await probe.close(); return address;
}
async function fixture(t, respond) {
  const dir = await directory(t), address = await endpoint(dir), sockets = new Set();
  let connections = 0;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    respond(socket, ++connections, server);
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(address, done); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(done => server.close(done));
  });
  return { dir, connections: () => connections };
}

test('closing during an accepted OS identity handshake drains the complete frame', async t => {
  const dir = await directory(t); let closing, lock;
  lock = await acquireIdentityLock(dir, () => { closing = lock.close(); return identity('closing-boot'); });
  t.after(() => lock.close());
  // close runs synchronously inside the real server accept callback, before
  // socket.end writes its frame: the former destroy-first close loses it.
  assert.equal((await inspectInstanceIdentity(dir)).bootId, 'closing-boot');
  await closing;
  assert.equal(await inspectInstanceIdentity(dir), null);
});

test('a truncated connection is rechecked and a replacement owner is never reported stopped', async t => {
  const f = await fixture(t, (socket, count) => socket.end(count === 1 ? '' : JSON.stringify(identity('replacement-boot')) + '\n'));
  assert.equal((await inspectInstanceIdentity(f.dir)).bootId, 'replacement-boot');
  assert.equal(f.connections(), 2);
});

test('a truncated connection only reports stopped after a fresh OS connection proves the endpoint absent', async t => {
  const f = await fixture(t, (socket, count, server) => { server.close(); socket.end(); });
  assert.equal(await inspectInstanceIdentity(f.dir), null);
  assert.equal(f.connections(), 1);
});

test('persistent incomplete handshakes and invalid JSON identities fail closed', async t => {
  const empty = await fixture(t, socket => socket.end());
  await assert.rejects(inspectInstanceIdentity(empty.dir), error => error.code === 'INSTANCE_IDENTITY_UNAVAILABLE' && error.cause.code === 'IDENTITY_HANDSHAKE_INCOMPLETE');
  assert.equal(empty.connections(), 3, 'retries are bounded');
  for (const value of [null, false, 0, [], {}, { protocol: 'other' }]) {
    const invalid = await fixture(t, socket => socket.end(JSON.stringify(value) + '\n'));
    await assert.rejects(inspectInstanceIdentity(invalid.dir), error => error.code === 'INSTANCE_IDENTITY_UNAVAILABLE' && error.cause.code === 'IDENTITY_PROTOCOL_INVALID');
    assert.equal(invalid.connections(), 1, 'an incompatible complete response is not retried');
  }
  const silent = await fixture(t, () => {});
  await assert.rejects(inspectInstanceIdentity(silent.dir), error => error.code === 'INSTANCE_IDENTITY_UNAVAILABLE' && error.cause.code === 'IDENTITY_HANDSHAKE_TIMEOUT');
  assert.equal(silent.connections(), 1);
});

test('identity shutdown is idempotent and bounded even when a connected peer does not close', async t => {
  const dir = await directory(t), lock = await acquireIdentityLock(dir, () => identity('held-boot'));
  const socket = net.createConnection(typeof lock.address === 'string' ? { path: lock.address, allowHalfOpen: true } : { ...lock.address, allowHalfOpen: true });
  socket.on('error', () => {}); t.after(() => { socket.destroy(); return lock.close(); });
  await once(socket, 'data');
  const began = Date.now(), closing = lock.close();
  assert.equal(lock.close(), closing);
  await closing; assert.ok(Date.now() - began < 2000);
  assert.equal(await inspectInstanceIdentity(dir), null);
});

test('continuous incomplete identity bytes cannot extend the absolute handshake deadline', async t => {
  const f = await fixture(t, socket => {
    const timer = setInterval(() => socket.write(' '), 25);
    socket.on('close', () => clearInterval(timer));
  });
  const began = Date.now();
  await assert.rejects(inspectInstanceIdentity(f.dir), error => error.code === 'INSTANCE_IDENTITY_UNAVAILABLE' && error.cause.code === 'IDENTITY_HANDSHAKE_TIMEOUT');
  assert.ok(Date.now() - began < 2500, 'incomplete data must not restart the timeout');
  assert.equal(f.connections(), 1);
});

test('the actual CLI waits for final identity cleanup after the stopped event before exiting', async t => {
  const dir = await directory(t), token = 'identity-cli-management-token-24';
  const configPath = join(dir, 'input.json');
  await writeFile(configPath, JSON.stringify({ botId: 'identity-test', dataDir: dir, token,
    model: { provider: 'openai-compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1' } }));
  // A child-local I/O barrier makes the final persistence window deterministic;
  // no production module is mocked and the CLI owns a real OS identity/SQLite.
  const preload = `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    const originalRename = fs.promises.rename, dir = process.env.BOT_TEST_FINAL_WRITE_DIR;
    const released = new Promise(done => process.on('message', message => { if (message.type === 'release-final-write') done(); }));
    fs.promises.rename = async (source, target) => {
      if (target === join(dir, 'run', 'current.json') && JSON.parse(await fs.promises.readFile(source, 'utf8')).state === 'stopped') {
        process.send({ type: 'final-write-started' }); await released;
        await originalRename(source, target); await fs.promises.writeFile(join(dir, 'final-write-complete'), 'persisted'); return;
      }
      return originalRename(source, target);
    }; syncBuiltinESMExports();`;
  const child = fork(new URL('../bin/summon-bot.mjs', import.meta.url), ['--config', configPath], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, BOT_TEST_FINAL_WRITE_DIR: dir },
    execArgv: ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`],
  });
  const exited = once(child, 'exit'); let ready, stderr = '';
  child.stderr.on('data', data => stderr += data); child.stdout.resume();
  t.after(async () => {
    if (child.connected) child.send({ type: 'release-final-write' }, () => {});
    if (child.exitCode === null && child.signalCode === null) {
      if (ready) await requestBot({ url: ready.url, token }, '/shutdown', { method: 'POST' }).catch(() => {});
      else child.kill();
    }
    await exited;
  });
  ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI readiness timeout: ${stderr}`)), 20000);
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); done(message); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before ready: ${code}: ${stderr}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const writing = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Final persistence barrier was not reached')), 10000);
    child.on('message', message => { if (message.type === 'final-write-started') { clearTimeout(timer); done(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('CLI exited before final persistence barrier')); });
  });
  await requestBot({ url: ready.url, token }, '/shutdown', { method: 'POST' });
  await writing;
  assert.equal((await inspectInstanceIdentity(dir)).bootId, ready.bootId, 'final data write still holds ownership');
  await pause(60); assert.equal(child.exitCode, null, 'process must await the complete close promise');
  child.send({ type: 'release-final-write' });
  const [code] = await exited; assert.equal(code, 0, stderr);
  assert.equal(await readFile(join(dir, 'final-write-complete'), 'utf8'), 'persisted');
  assert.equal(await inspectInstanceIdentity(dir), null);
});
