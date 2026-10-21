import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecordStore } from '../shared/store.mjs';
import { ChatroomService } from '../chatroom/service.mjs';
import { CodexExecutor } from '../codex/executor.mjs';
import { createCapability } from '../services/builtin.mjs';

const fake = fileURLToPath(new URL('./helpers/fake-codex.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(20); }
  throw new Error('Service ownership fixture timed out');
}
async function codexFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-service-ownership-'));
  const stores = ['1','2'].map(() => new RecordStore(join(directory, 'state.sqlite')));
  const executors = stores.map((store, index) => new CodexExecutor({ store, version: String(index + 1), codexPath: [process.execPath, fake], defaultCwd: directory }));
  t.after(async () => { await Promise.all(executors.map(executor => executor.stop())); stores.forEach(store => store.close()); await rm(directory, { recursive: true, force: true }); });
  return { directory, stores, v1: executors[0], v2: executors[1] };
}
async function chatFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-chat-ownership-'));
  const stores = ['1','2'].map(() => new RecordStore(join(directory, 'state.sqlite'))), bots = new RecordStore(':memory:');
  for (const id of ['a','b','bot-chatroom']) bots.save('bots', { id, name: id, status: 'active', roleId: id === 'bot-chatroom' ? 'chatroom' : 'default' });
  const sent = [], polled = [], tasks = new Map();
  const manager = { store: bots, get: id => bots.get('bots', id), config: async () => ({ workspace: directory }),
    send: async (botId, message) => { sent.push({ botId, message }); return { taskId: `task:${message.id}` }; },
    request: async (botId, path) => { const taskId = decodeURIComponent(path.slice('/tasks/'.length)); polled.push({ botId, taskId }); return tasks.get(taskId) || { status: 'running' }; },
  };
  const services = stores.map((store, index) => new ChatroomService({ store, manager, version: String(index + 1), attachments: { resolve: () => [], stageContext: async context => context } }));
  for (const service of services) service.closed = true;
  t.after(async () => { await Promise.all(services.map(service => service.close())); stores.forEach(store => store.close()); bots.close(); await rm(directory, { recursive: true, force: true }); });
  const tick = async service => { service.closed = false; await service.tick(); service.closed = true; };
  const finish = job => tasks.set(`task:${job.id}`, { status: 'completed', result: { content: 'PASS' } });
  return { v1: services[0], v2: services[1], stores, sent, polled, tasks, tick, finish };
}

test('v2 startup and pump preserve v1 running and queued Codex work without executing either twice', async t => {
  const { v1, v2 } = await codexFixture(t);
  await v1.start(); const held = v1.create({ goal: 'HOLD old version' }), queued = v1.create({ goal: 'Old queued work' });
  await until(() => v1.get(held.id).turnId);
  await v2.start(); const fresh = v2.create({ goal: 'New version work' });
  await until(() => v2.get(fresh.id).status === 'completed');
  assert.equal(v1.get(held.id).status, 'running'); assert.equal(v1.get(queued.id).status, 'queued');
  assert.equal(v2.get(fresh.id).serviceVersion, '2'); assert.equal(v1.get(held.id).serviceVersion, '1');
  assert.equal(v1.get(held.id).events.filter(event => event.type === 'interrupted').length, 0);
  await v2.stop(); assert.equal(v1.get(held.id).status, 'running');
  await v1.cancel(held.id); await until(() => v1.get(queued.id).status === 'completed'); await until(() => !v1.active);
  for (const id of [held.id, queued.id, fresh.id]) assert.equal(v1.get(id).events.filter(event => event.type === 'thread_started').length, 1);
});

test('a foreign service cannot cancel, steer or answer active work without its live Codex connection', async t => {
  const { v1, v2 } = await codexFixture(t); await v1.start(); await v2.start();
  const work = v1.create({ goal: 'HOLD owner connection' }); await until(() => v1.get(work.id).turnId);
  for (const action of [() => v2.cancel(work.id), () => v2.resume(work.id, { content: 'Misrouted update' }), () => v2.answer(work.id, { answer: 'Misrouted answer' })]) await assert.rejects(action(), { code: 'CAPABILITY_WORK_OWNER_MISMATCH', status: 409, serviceVersion: '1' });
  assert.equal(v1.get(work.id).status, 'running'); assert.equal(v1.active.id, work.id);
  await v1.resume(work.id, { content: 'Finish through the owning connection' });
  await until(() => v1.get(work.id).status === 'completed');
  assert.equal(v1.get(work.id).summary, 'Finish through the owning connection');
});

test('explicit resumption of terminal old work transfers ownership to the new service and retains its saved thread', async t => {
  const { v1, v2 } = await codexFixture(t); await v1.start();
  const work = v1.create({ goal: 'HOLD until explicit continuation' }); await until(() => v1.get(work.id).turnId); await v1.stop();
  assert.equal(v1.get(work.id).status, 'interrupted'); const threadId = v1.get(work.id).threadId;
  await v2.start(); await v2.resume(work.id, { content: 'Continue the remaining work' });
  await until(() => v2.get(work.id).events.some(event => event.type === 'thread_resumed')); await until(() => v2.get(work.id).turnId);
  assert.equal(v2.get(work.id).serviceVersion, '2'); assert.equal(v2.get(work.id).threadId, threadId);
  await v2.resume(work.id, { content: 'Verified new owner continuation' }); await until(() => v2.get(work.id).status === 'completed');
  assert.equal(v2.get(work.id).summary, 'Verified new owner continuation');
});

test('a completed Codex row remains active until its result callback drains, and shutdown waits for it', async t => {
  const { v1 } = await codexFixture(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), continuation = new Promise(resolve => { release = resolve; });
  v1.onResult = async () => { entered(); await continuation; };
  await v1.start(); const work = v1.create({ goal: 'Deliver actual final result' });
  try {
    await started; assert.equal(v1.get(work.id).status, 'completed'); assert.equal(v1.active.id, work.id);
    let stopped = false; const stopping = v1.stop().then(() => { stopped = true; });
    await delay(20); assert.equal(stopped, false); release(); await stopping; assert.equal(v1.active, null);
  } finally { release(); }
});

test('chatroom ticks poll only owned pending deliveries and new messages belong to the new version', async t => {
  const { v1, v2, sent, polled, tick, finish } = await chatFixture(t);
  const room = v1.createRoom({ members: ['user','a'] });
  const oldMessage = v1.post(room.id, { content: 'Old request', toBotId: 'a' }), old = v1.jobs().find(job => job.messageId === oldMessage.id);
  await tick(v2); assert.equal(sent.length, 0); assert.equal(polled.length, 0);
  await tick(v1); assert.equal(sent.length, 1); assert.equal(v1.need('deliveries', old.id).status, 'running');
  const newMessage = v2.post(room.id, { content: 'New request', toBotId: 'a' }), fresh = v2.jobs().find(job => job.messageId === newMessage.id); finish(fresh);
  const previousPolls = polled.length; await tick(v2);
  assert.equal(polled.length, previousPolls + 1); assert.equal(polled.at(-1).taskId, `task:${fresh.id}`);
  assert.equal(v2.need('deliveries', fresh.id).status, 'completed'); assert.equal(fresh.serviceVersion, '2');
  assert.equal(v1.need('deliveries', old.id).status, 'running'); finish(old); await tick(v1); await tick(v2);
  assert.equal(sent.filter(item => item.message.id === old.id).length, 1); assert.equal(sent.filter(item => item.message.id === fresh.id).length, 1);
  await assert.rejects(v2.deliver(old), { status: 409 });
});

test('explicit chat retry assigns the new version while preserving an uncertain receipt id', async t => {
  const { v1, v2, stores, tick, sent, finish } = await chatFixture(t), room = v1.createRoom({ members: ['user','a'] });
  const trigger = v1.post(room.id, { content: 'Receipt was lost', toBotId: 'a' }), old = v1.jobs().find(job => job.messageId === trigger.id);
  stores[0].save('deliveries', { ...old, status: 'interrupted', error: 'Receipt not observed' });
  const retry = v2.retry(old.id); assert.equal(retry.id, old.id); assert.equal(retry.serviceVersion, '2');
  await tick(v1); assert.equal(sent.length, 0); finish(retry); await tick(v2);
  assert.equal(sent.length, 1); assert.equal(v2.need('deliveries', retry.id).status, 'completed');
});

test('a discussion spanning two versions settles a completed batch once and creates one host continuation', async t => {
  const { v1, v2, finish } = await chatFixture(t);
  const room = v1.createRoom({ kind: 'deep', members: ['user','a','b'], goal: 'Compare evidence', rounds: 2 });
  const host = v1.jobs(room.id).find(job => job.botId === 'bot-chatroom');
  const first = v1.post(room.id, { content: 'a provides old-version evidence', toBotId: 'a' }, 'bot-chatroom');
  const second = v2.post(room.id, { content: 'b provides new-version evidence', toBotId: 'b' }, 'bot-chatroom');
  const a = v1.jobs(room.id).find(job => job.messageId === first.id), b = v2.jobs(room.id).find(job => job.messageId === second.id);
  assert.equal(a.discussionBatch, host.id); assert.equal(b.discussionBatch, host.id);
  finish(a); finish(b); finish(host); await v1.deliver(a); await v2.deliver(b);
  assert.equal(v1.need('rooms', room.id).completedRounds || 0, 0);
  await v1.deliver(host); v2.settleDiscussion(v2.need('rooms', room.id)); v1.settleDiscussion(v1.need('rooms', room.id));
  assert.equal(v1.need('rooms', room.id).completedRounds, 1);
  assert.equal(v1.messages(room.id).filter(message => message.id === `discussion-results:${host.id}`).length, 1);
  assert.equal(v1.jobs(room.id).filter(job => job.messageId === `discussion-results:${host.id}`).length, 1);
});

async function builtinFixture(t, seed) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-builtin-ownership-'));
  const store = new RecordStore(join(directory, 'capabilities', 'codex', 'state.sqlite'));
  seed?.(store, directory);
  const bridge = createServer(async (request, response) => { for await (const _chunk of request) {} response.setHeader('Content-Type','application/json'); response.end('{}'); });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const capabilities = [];
  t.after(async () => { await Promise.all(capabilities.map(capability => capability.close())); store.close(); bridge.closeAllConnections(); await new Promise(resolve => bridge.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const create = async version => {
    const capability = await createCapability({ id: 'codex', version, dataRoot: directory, releaseRoot: resolve(import.meta.dirname, '../..'), defaultCwd: directory, gatewayUrl: `http://127.0.0.1:${bridge.address().port}`, gatewayToken: 'test-only', codexPath: [process.execPath, fake] }); capabilities.push(capability); return capability;
  };
  return { store, create };
}

test('concurrent builtin bootstraps adopt legacy records once, interrupt unknown work and do not duplicate queued execution', async t => {
  const { store, create } = await builtinFixture(t, (db, directory) => {
    db.save('works', { id: 'legacy-queued', goal: 'Complete imported queue', cwd: directory, status: 'queued' });
    db.save('works', { id: 'legacy-running', goal: 'Do not replay uncertain work', cwd: directory, status: 'running', threadId: 'saved-thread' });
  });
  await Promise.all([create('1'), create('2')]);
  await until(() => store.get('works','legacy-queued').status === 'completed');
  const queued = store.get('works','legacy-queued'), interrupted = store.get('works','legacy-running');
  assert.ok(['1','2'].includes(queued.serviceVersion)); assert.equal(queued.serviceVersion, interrupted.serviceVersion);
  assert.equal(interrupted.status, 'interrupted'); assert.equal(interrupted.threadId, 'saved-thread');
  assert.equal(store.list('workEvents').filter(event => event.workId === queued.id && event.type === 'thread_started').length, 1);
  assert.equal(store.list('workEvents').filter(event => event.workId === interrupted.id && event.type === 'thread_started').length, 0);
});

test('builtin mutation locks deduplicate simultaneous request IDs across old and new workers', async t => {
  const { store, create } = await builtinFixture(t), [v1, v2] = await Promise.all([create('1'), create('2')]);
  const [first, second] = await Promise.all([v1.operations.create({ goal: 'One deduplicated work', sourceActionId: 'shared-request' }), v2.operations.create({ goal: 'One deduplicated work', sourceActionId: 'shared-request' })]);
  assert.equal(first.id, second.id); assert.equal(store.list('works').length, 1);
  await until(() => store.get('works', first.id).status === 'completed');
  assert.equal(store.list('workEvents').filter(event => event.workId === first.id && event.type === 'thread_started').length, 1);
  await until(() => v1.pendingWork() + v2.pendingWork() === 0);
  assert.equal(v1.pendingWork() + v2.pendingWork(), 0);
});
