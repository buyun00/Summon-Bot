import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BotStore } from '../src/storage/store.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-bot-store-'));
  const path = join(root, 'state.sqlite'), stores = [];
  const open = options => { const store = new BotStore(path, options); stores.push(store); return store; };
  t.after(async () => {
    for (const store of stores) store.close();
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'cleanup is limited to the newly created test directory');
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  return { path, open, store: open() };
}

const message = (id, sessionId = 'conversation:one') => ({ id, from: 'untrusted-body-source', to: 'fixture-bot',
  kind: 'request', sessionId, content: { text: `input:${id}` } });
const revisionConflict = error => error.code === 'REVISION_CONFLICT' && error.status === 409;

test('state, sessions and memories enforce CAS across independent SQLite connections', async t => {
  const f = await fixture(t), a = f.store, b = f.open();
  assert.equal(a.setState('fixture', 'value', { count: 1 }, { expectedRevision: 0 }).revision, 1);
  const staleState = a.getState('fixture', 'value');
  b.setState('fixture', 'value', { count: 2 }, { expectedRevision: staleState.revision });
  assert.throws(() => a.setState('fixture', 'value', { count: 99 }, { expectedRevision: staleState.revision }), revisionConflict);
  assert.deepEqual(a.getState('fixture', 'value').value, { count: 2 });
  assert.equal(a.getState('fixture', 'value').revision, 2);

  const first = a.saveSession({ id: 'session-a', messages: [{ role: 'user', content: 'original' }], expectedRevision: 0 });
  b.saveSession({ ...first, messages: [...first.messages, { role: 'assistant', content: [{ type: 'text', text: 'saved' }] }], expectedRevision: 1 });
  const sessionEvents = a.listEvents().length;
  assert.throws(() => a.saveSession({ ...first, messages: [], expectedRevision: 1 }), revisionConflict);
  assert.equal(a.getSession('session-a').messages.length, 2);
  assert.equal(a.getSession('session-a').revision, 2);
  assert.equal(a.listEvents().length, sessionEvents, 'rejected CAS produces no success event');
  assert.equal(Object.hasOwn(a.getSession('session-a'), 'expectedRevision'), false);

  const memory = a.putMemory({ id: 'memory-a', text: 'original memory', source: { taskId: 'source-task' }, expectedRevision: 0 });
  b.putMemory({ id: memory.id, text: 'new memory', expectedRevision: memory.revision });
  assert.throws(() => a.putMemory({ id: memory.id, text: 'stale overwrite', expectedRevision: memory.revision }), revisionConflict);
  assert.throws(() => a.deleteMemory(memory.id, memory.revision), revisionConflict);
  assert.equal(a.getMemory(memory.id).text, 'new memory');
  assert.deepEqual(a.getMemory(memory.id).source, { taskId: 'source-task' });
  assert.equal(a.deleteMemory(memory.id, 2), true);
  assert.equal(a.getMemory(memory.id), null);
});

test('durable acceptance deduplicates by authenticated source and message ID across restart without requeueing', async t => {
  const f = await fixture(t), store = f.store;
  const first = store.acceptMessage(message('message-1'), 'authenticated-a', 'boot-a');
  assert.equal(first.duplicate, false);
  assert.equal(first.message.from, 'authenticated-a', 'transport source replaces the untrusted body source');
  assert.equal(first.message.sourceMessageId, 'message-1');
  const duplicate = store.acceptMessage(message('message-1'), 'authenticated-a', 'boot-a');
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.task, first.task);
  const differentSource = store.acceptMessage(message('message-1'), 'authenticated-b', 'boot-a');
  assert.equal(differentSource.duplicate, false);
  assert.notEqual(differentSource.task.id, first.task.id);
  assert.equal(store.listEvents().filter(event => event.type === 'task.accepted').length, 2);

  store.close();
  const reopened = f.open(); reopened.recover('boot-b');
  const repeatedAfterRestart = reopened.acceptMessage(message('message-1'), 'authenticated-a', 'boot-b');
  assert.equal(repeatedAfterRestart.duplicate, true);
  assert.equal(repeatedAfterRestart.task.id, first.task.id);
  assert.equal(repeatedAfterRestart.task.status, 'interrupted');
  assert.equal(repeatedAfterRestart.task.error.code, 'PROCESS_RESTARTED');
  assert.equal(repeatedAfterRestart.task.error.recoveredByBootId, 'boot-b');
  assert.equal(reopened.listTasks({ status: 'accepted' }).length, 0);
  assert.equal(reopened.listTasks().length, 2);
  assert.equal(reopened.listMessages().length, 2);
  assert.equal(reopened.listEvents().filter(event => event.type === 'task.accepted').length, 2);
});

test('restart preserves terminal receipts, marks unfinished tools/outbox unknown and remains idempotent', async t => {
  const f = await fixture(t), store = f.store, tasks = new Map();
  for (const status of ['accepted', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted']) {
    const accepted = store.acceptMessage(message(`message-${status}`), 'peer', 'boot-a');
    if (status !== 'accepted') store.updateTask(accepted.task.id, { status,
      ...(status === 'completed' ? { result: { content: 'already delivered', delivery: 'receipt-1' } } : {}),
      ...(status === 'failed' ? { error: { message: 'known failure' } } : {}) });
    tasks.set(status, store.getTask(accepted.task.id));
  }
  const taskId = tasks.get('running').id;
  for (const status of ['running', 'queued', 'completed', 'failed', 'unknown']) store.saveTool({
    id: `tool-${status}`, taskId, sessionId: 'conversation:one', toolCallId: `call-${status}`, name: 'external_operation', status,
    ...(status === 'completed' ? { output: { content: [{ type: 'text', text: 'durable receipt' }] } } : {}),
  });
  const pendingMessage = { id: 'send-1', from: 'fixture-bot', to: 'peer', content: 'do work' };
  store.saveOutbox({ id: 'peer:send-1', to: 'peer', status: 'sending', taskId, message: pendingMessage });
  store.saveOutbox({ id: 'peer:send-2', to: 'peer', status: 'accepted', message: { ...pendingMessage, id: 'send-2' }, receipt: { taskId: 'remote-task-2' } });
  store.saveOutbox({ id: 'peer:send-3', to: 'peer', status: 'unknown', message: { ...pendingMessage, id: 'send-3' } });
  const completedTool = store.getTool('tool-completed'), acceptedOutbox = store.getOutbox('peer:send-2');
  store.close();

  const reopened = f.open(); reopened.recover('boot-b');
  for (const status of ['accepted', 'running', 'waiting']) assert.equal(reopened.getTask(tasks.get(status).id).status, 'interrupted');
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted']) assert.deepEqual(reopened.getTask(tasks.get(status).id), tasks.get(status));
  for (const status of ['running', 'queued']) {
    const tool = reopened.getTool(`tool-${status}`);
    assert.equal(tool.status, 'unknown'); assert.match(tool.error.message, /before a durable tool result/);
  }
  assert.deepEqual(reopened.getTool('tool-completed'), completedTool);
  assert.equal(reopened.getTool('tool-failed').status, 'failed');
  assert.equal(reopened.getTool('tool-unknown').status, 'unknown');
  assert.equal(reopened.getOutbox('peer:send-1').status, 'unknown');
  assert.deepEqual(reopened.getOutbox('peer:send-1').message, pendingMessage);
  assert.deepEqual(reopened.getOutbox('peer:send-2'), acceptedOutbox);
  assert.equal(reopened.getOutbox('peer:send-3').status, 'unknown');
  const eventCount = reopened.listEvents({ limit: 1000 }).length;
  reopened.recover('boot-c');
  assert.equal(reopened.listEvents({ limit: 1000 }).length, eventCount, 'repeated recovery produces no repeated task/tool transitions');
  assert.deepEqual(reopened.updateTask(tasks.get('completed').id, { status: 'running', result: null }), tasks.get('completed'), 'terminal receipt cannot be reopened');
});

test('raw imported records and complete native sessions preserve IDs, timestamps, content and references after reopen', async t => {
  const f = await fixture(t), store = f.store;
  const records = [
    ['messages', { id: 'historical-1', createdAt: '2025-02-03T04:05:06Z', roomId: 'room-1', content: '历史中文\n原文', attachments: [{ id: 'attachment-1', sha256: 'abc', path: 'assets/attachment-1' }] }],
    ['agentRuns', { id: 'historical-1', startedAt: '2025-02-03T04:05:07Z', status: 'completed', originalFields: { marker: true }, artifacts: [{ id: 'artifact-1', path: 'artifacts/retained-output.txt' }] }],
  ];
  const transcript = [
    { role: 'system', content: '', sections: { identity: 'original identity' }, timestamp: 100 },
    { role: 'user', content: [{ type: 'text', text: '历史问题' }], timestamp: 101 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'original-call', name: 'state_get', arguments: { scope: 'facts', key: 'value' } }], stopReason: 'toolUse', timestamp: 102 },
    { role: 'toolResult', toolCallId: 'original-call', toolName: 'state_get', content: [{ type: 'text', text: '{"answer":42}' }], details: { answer: 42 }, isError: false, timestamp: 103 },
    { role: 'assistant', content: [{ type: 'text', text: '完整答复' }], stopReason: 'stop', timestamp: 104 },
  ];
  const checkpoint = { id: 'checkpoint-original', afterMessageCount: 4, firstKeptEntryId: 'm:2', summary: 'Original lossy summary', tokensBefore: 1000 };
  store.transaction(() => {
    for (const [kind, record] of records) store.putRecord(kind, record);
    store.saveSession({ id: 'imported-session', messages: transcript, checkpoints: [checkpoint],
      createdAt: '2025-02-03T04:05:06Z', importedFrom: { botId: 'historical-bot', sessionId: 'historical-session' } });
  });
  store.close();
  const reopened = f.open();
  for (const [kind, record] of records) {
    assert.deepEqual(reopened.getRecord(kind, record.id), record);
    assert.deepEqual(reopened.listRecords(kind), [record]);
  }
  const session = reopened.getSession('imported-session');
  assert.deepEqual(session.messages, transcript); assert.deepEqual(session.checkpoints, [checkpoint]);
  assert.deepEqual(session.importedFrom, { botId: 'historical-bot', sessionId: 'historical-session' });
  assert.equal(session.createdAt, '2025-02-03T04:05:06Z');
  assert.equal(reopened.listTasks().length, 0, 'importing history never fabricates an executable task');
  const readOnly = f.open({ readOnly: true });
  assert.deepEqual(readOnly.getSession('imported-session'), session);
  assert.throws(() => readOnly.setState('test', 'forbidden', true), /readonly|read.only/i);
});

test('acceptance and multi-record imports roll back with their events when durable recording fails', async t => {
  const { store } = await fixture(t);
  const appendEvent = store.appendEvent;
  store.appendEvent = () => { throw new Error('fixture durable event failure'); };
  assert.throws(() => store.acceptMessage(message('unacknowledged'), 'peer', 'boot-a'), /durable event failure/);
  store.appendEvent = appendEvent;
  assert.equal(store.listMessages().length, 0); assert.equal(store.listTasks().length, 0); assert.equal(store.listEvents().length, 0);
  assert.equal(store.acceptMessage(message('unacknowledged'), 'peer', 'boot-a').duplicate, false);

  const eventCount = store.listEvents().length;
  assert.throws(() => store.transaction(() => {
    store.putRecord('raw', { id: 'must-rollback', content: 'partial import' });
    store.saveSession({ id: 'must-rollback', messages: [] });
    store.putMemory({ id: 'must-rollback', text: 'partial memory' });
    store.setState('import', 'partial', true);
    throw new Error('fixture import validation failed');
  }), /import validation failed/);
  assert.equal(store.getRecord('raw', 'must-rollback'), null); assert.equal(store.getSession('must-rollback'), null);
  assert.equal(store.getMemory('must-rollback'), null); assert.equal(store.getState('import', 'partial'), null);
  assert.equal(store.listEvents().length, eventCount);
});
