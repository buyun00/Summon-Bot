import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireServiceLock, inspectServiceLock } from '../scripts/installation/service-lock.mjs';

const identity = bootId => ({ protocol: 'relay-service-v1', type: 'web', pid: process.pid, bootId, state: 'ready' });
async function fixture(t, respond) {
  const root = await mkdtemp(join(tmpdir(), 'relay-service-identity-test-'));
  const physical = await realpath(root), key = createHash('sha256').update(`${process.platform === 'win32' ? physical.toLowerCase() : physical}:web`).digest('hex').slice(0, 40);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\relay-service-${key}` : process.platform === 'linux' ? `\0relay-service-${key}` : { host: '127.0.0.1', port: 30000 + parseInt(key.slice(0, 8), 16) % 25000 };
  const sockets = new Set(), cleanup = []; let connections = 0, server;
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise(done => server.close(done));
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true });
  });
  if (respond) {
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      respond(socket, ++connections, server);
    });
    await new Promise((done, reject) => { server.once('error', reject); server.listen(endpoint, done); });
  }
  return { root, endpoint, cleanup, connections: () => connections };
}

test('service close drains a reply accepted before shutdown starts', async t => {
  const f = await fixture(t); let closing, owner;
  owner = await acquireServiceLock(f.root, 'web', () => { closing = owner.close(); return identity('draining'); }); f.cleanup.push(() => owner.close());
  assert.equal((await inspectServiceLock(f.root, 'web')).bootId, 'draining');
  await closing; assert.equal(await inspectServiceLock(f.root, 'web'), null);
});

test('service EOF rehandshake preserves a replacement owner instead of reporting stopped', async t => {
  const f = await fixture(t, (socket, count) => socket.end(count === 1 ? '' : JSON.stringify(identity('replacement')) + '\n'));
  assert.equal((await inspectServiceLock(f.root, 'web')).bootId, 'replacement'); assert.equal(f.connections(), 2);
});

test('service EOF reports absence only after a fresh OS connection refuses it', async t => {
  const f = await fixture(t, (socket, count, server) => { server.close(); socket.end(); });
  assert.equal(await inspectServiceLock(f.root, 'web'), null); assert.equal(f.connections(), 1);
});

test('persistent incomplete service replies exhaust bounded retries without implying stopped', async t => {
  const f = await fixture(t, socket => socket.end());
  await assert.rejects(inspectServiceLock(f.root, 'web'), error => error.code === 'SERVICE_IDENTITY_UNAVAILABLE' && error.cause.code === 'SERVICE_HANDSHAKE_INCOMPLETE');
  assert.equal(f.connections(), 3);
});

test('invalid service identities fail closed without retries', async t => {
  for (const value of [null, false, 0, [], {}, { ...identity('wrong-type'), type: 'gateway' }, { ...identity('wrong-protocol'), protocol: 'other' }, { ...identity('missing-pid'), pid: undefined }, { ...identity(''), bootId: '' }]) {
    const f = await fixture(t, socket => socket.end(JSON.stringify(value) + '\n'));
    await assert.rejects(inspectServiceLock(f.root, 'web'), error => error.code === 'SERVICE_IDENTITY_UNAVAILABLE' && error.cause.code === 'SERVICE_IDENTITY_INVALID');
    assert.equal(f.connections(), 1);
  }
});

test('silent and trickling service handshakes share an absolute two-second deadline', async t => {
  const quiet = await fixture(t, () => {});
  let began = Date.now(); await assert.rejects(inspectServiceLock(quiet.root, 'web'), error => error.cause?.code === 'SERVICE_HANDSHAKE_TIMEOUT');
  assert.ok(Date.now() - began < 3000); assert.equal(quiet.connections(), 1);
  const trickle = await fixture(t, socket => { const timer = setInterval(() => socket.write(' '), 25); socket.on('close', () => clearInterval(timer)); });
  began = Date.now(); await assert.rejects(inspectServiceLock(trickle.root, 'web'), error => error.cause?.code === 'SERVICE_HANDSHAKE_TIMEOUT');
  assert.ok(Date.now() - began < 3000); assert.equal(trickle.connections(), 1);
});

test('service close is idempotent and bounded with an accepted peer left half open', async t => {
  const f = await fixture(t), owner = await acquireServiceLock(f.root, 'web', () => identity('held'));
  const socket = net.createConnection(typeof f.endpoint === 'string' ? { path: f.endpoint, allowHalfOpen: true } : { ...f.endpoint, allowHalfOpen: true });
  socket.on('error', () => {}); f.cleanup.push(async () => { socket.destroy(); await owner.close(); });
  await once(socket, 'data'); const began = Date.now(), closing = owner.close();
  assert.equal(owner.close(), closing); await closing; assert.ok(Date.now() - began < 1500);
  assert.equal(await inspectServiceLock(f.root, 'web'), null);
});
