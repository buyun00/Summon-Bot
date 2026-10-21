import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { CodexExecutor } from '../codex/executor.mjs';

class MemoryStore {
  constructor() { this.data = new Map(); this.counter = 0; }
  get(kind, id) { return this.data.get(kind)?.get(id) || null; }
  list(kind) { return [...(this.data.get(kind)?.values() || [])]; }
  save(kind, value) {
    if (!this.data.has(kind)) this.data.set(kind, new Map());
    const object = { ...value, id: value.id || `test-${++this.counter}`, createdAt: value.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    this.data.get(kind).set(object.id, object);
    return object;
  }
  remove(kind, id) { this.data.get(kind)?.delete(id); }
}
const fake = fileURLToPath(new URL('./helpers/fake-codex.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const start = Date.now();
  while (Date.now() - start < 15000) { const value = check(); if (value) return value; await sleep(20); }
  throw new Error('Timed out waiting for protocol fixture');
}
function fixture(options = {}) {
  const store = options.store || new MemoryStore();
  const executor = new CodexExecutor({ store, codexPath: [process.execPath, fake], ...options });
  return { store, executor };
}

test('replayed social work action reuses the existing external execution record', () => {
  const { executor } = fixture();
  const first = executor.create({ goal: 'One external task', sourceActionId: 'message-1:work:0', sourceMessageId: 'message-1' });
  const repeated = executor.create({ goal: 'One external task', sourceActionId: 'message-1:work:0', sourceMessageId: 'message-1' });
  assert.equal(first.id, repeated.id);
  assert.equal(repeated.sourceMessageId, 'message-1');
  assert.equal(executor.list().length, 1);
});

test('Codex protocol: real lifecycle handling with explicitly fake peer', async t => {
  const results = [];
  const { executor } = fixture({ onResult: work => results.push(work) });
  t.after(() => executor.stop());
  await executor.start();
  const work = executor.create({ goal: 'Produce a result' });
  await until(() => executor.get(work.id).status === 'completed');
  await until(() => results.length);
  assert.equal(executor.get(work.id).model, 'TEST_DOUBLE');
  assert.equal(executor.get(work.id).summary, 'Protocol fixture complete');
  assert.ok(executor.get(work.id).events.some(event => event.type === 'message_delta'));
});

test('consult callback is returned to the same tool request and execution continues', async t => {
  let consulted;
  const { executor } = fixture({ consult: async (work, question, target) => { consulted = { id: work.id, question, target }; return 'Fact from test colleague'; } });
  t.after(() => executor.stop());
  await executor.start();
  const work = executor.create({ goal: 'CONSULT before answering' });
  await until(() => executor.get(work.id).status === 'completed');
  assert.equal(consulted.target, 'expert');
  assert.equal(executor.get(work.id).summary, 'Fact from test colleague');
  assert.equal(executor.get(work.id).question.status, 'answered');
});

test('unavailable consultation stays waiting and can receive an explicit answer', async t => {
  const { executor } = fixture({ consult: async () => { throw new Error('Colleague offline'); } });
  t.after(() => executor.stop());
  await executor.start();
  const work = executor.create({ goal: 'CONSULT' });
  await until(() => executor.get(work.id).events.some(event => event.type === 'consult_failed'));
  assert.equal(executor.get(work.id).status, 'waiting');
  await executor.answer(work.id, { content: 'User supplied fact' });
  await until(() => executor.get(work.id).status === 'completed');
  assert.equal(executor.get(work.id).summary, 'User supplied fact');
});

test('requestUserInput waits for a human answer instead of asking another model', async t => {
  let consulted = false;
  const { executor } = fixture({ consult: async () => { consulted = true; return 'Wrong automatic answer'; } });
  t.after(() => executor.stop());
  await executor.start();
  const work = executor.create({ goal: 'REQUEST_USER_INPUT' });
  await until(() => executor.get(work.id).status === 'waiting');
  assert.equal(consulted, false);
  await executor.answer(work.id, { answer: 'Blue' });
  await until(() => executor.get(work.id).status === 'completed');
  assert.match(executor.get(work.id).summary, /Blue/);
});

test('one execution slot, cancellation and saved-thread continuation', async t => {
  const { executor } = fixture();
  t.after(() => executor.stop());
  await executor.start();
  const first = executor.create({ goal: 'HOLD' });
  const second = executor.create({ goal: 'After first' });
  await until(() => executor.get(first.id).turnId);
  assert.equal(executor.get(second.id).status, 'queued');
  await executor.cancel(first.id);
  assert.equal(executor.get(first.id).status, 'cancelled');
  assert.ok(executor.get(first.id).events.some(event => event.type === 'interrupt_acknowledged'));
  await until(() => executor.get(second.id).status === 'completed');
  await until(() => !executor.active);
  await executor.resume(first.id, { content: 'Continue now' });
  await until(() => executor.get(first.id).events.some(event => event.type === 'thread_resumed'));
  await until(() => executor.get(first.id).turnId);
  await executor.resume(first.id, { content: 'Finish with this update' });
  await until(() => executor.get(first.id).status === 'completed');
  assert.equal(executor.get(first.id).summary, 'Finish with this update');
});

test('restart does not silently repeat running work and stop fully drains callbacks', async () => {
  const store = new MemoryStore();
  store.save('works', { id: 'interrupted-work', status: 'running', goal: 'Do not repeat', threadId: 'saved-thread' });
  const { executor } = fixture({ store });
  await executor.start();
  assert.equal(executor.get('interrupted-work').status, 'interrupted');
  assert.equal(executor.active, null);
  const work = executor.create({ goal: 'HOLD' });
  await until(() => executor.get(work.id).turnId);
  await executor.stop();
  assert.equal(executor.get(work.id).status, 'interrupted');
  assert.equal(executor.active, null);
});

test('total work timeout interrupts a waiting consultation, keeps the thread and releases the slot', async t => {
  const { executor, store } = fixture({ consult: async () => null });
  t.after(() => executor.stop());
  const work = executor.create({ goal: 'CONSULT', timeoutSeconds: 1 });
  assert.equal(work.timeoutSeconds, 30, 'public API clamps short timeouts');
  // Only the protocol fixture shortens an existing record to avoid a 30-second test.
  store.save('works', { ...work, timeoutSeconds: 2 });
  const next = executor.create({ goal: 'Continue the queue' });
  assert.equal(next.timeoutSeconds, 1800);
  await executor.start();
  await until(() => executor.get(work.id).status === 'waiting');
  await until(() => executor.get(work.id).status === 'interrupted');
  await until(() => executor.get(next.id).status === 'completed');
  await until(() => !executor.active);
  const interrupted = executor.get(work.id);
  assert.equal(interrupted.threadId, 'test-thread');
  assert.match(interrupted.error, /time limit/);
  assert.equal(interrupted.events.filter(event => event.type === 'timeout').length, 1);
  assert.equal(interrupted.events.filter(event => event.type === 'thread_started').length, 1);
  assert.equal(interrupted.status, 'interrupted');
});
