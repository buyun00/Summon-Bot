import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BotStore } from '../src/storage/store.mjs';
import { SessionContext, projectSession } from '../src/context/context.mjs';

// The summary provider is an explicit fixture. SQLite, Pi compaction/projection,
// checkpoint persistence and the Relay history adapter all use real code.
const model = { id: 'fixture-summary', api: 'openai-completions', provider: 'fixture',
  contextWindow: 32768, maxTokens: 1024, reasoning: false };
const config = { agentSessionMaxBytes: 4096, agentReserveTokens: 2048, agentKeepRecentTokens: 128 };
const latestInput = `LATEST_REQUEST ${'Keep the present request. '.repeat(30)}`;
const summaryText = 'FIXTURE_CHECKPOINT: preserve the old decision and its original history reference.';
const assistant = (text, extra = {}) => ({ role: 'assistant', api: model.api, provider: model.provider,
  model: model.id, content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 3,
  usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra });
function transcript() {
  return [
    { role: 'system', content: '', sections: { bot: 'Current fixture instructions.' }, timestamp: 1 },
    { role: 'user', content: `ORIGINAL_EVIDENCE_SENTINEL ${'Historical observations. '.repeat(440)}`, timestamp: 2 },
    assistant('Old answer with no pending side effects.'),
    { role: 'user', content: latestInput, timestamp: 4 },
  ];
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-context-')), path = join(root, 'state.sqlite'), stores = [];
  const open = () => { const store = new BotStore(path); stores.push(store); return store; };
  const store = open(), messages = transcript();
  store.saveSession({ id: 'room:one', messages, checkpoints: [] });
  store.saveSession({ id: 'peer:other', messages: [{ role: 'user', content: 'OTHER_SESSION_PRIVATE', timestamp: 1 }], checkpoints: [] });
  const events = [];
  const context = new SessionContext({ sessions: store, config, onCheckpoint: (sessionId, checkpoint) => events.push({ sessionId, checkpoint }) });
  t.after(async () => { for (const value of stores) value.close(); await rm(root, { recursive: true, force: true }); });
  return { store, open, context, messages, events };
}
function providerFixture(response = assistant(summaryText), beforeResult = () => {}) {
  const requests = [];
  return { requests, streamFn: async (selectedModel, context, options) => {
    requests.push({ selectedModel, context, options });
    return { result: async () => { await beforeResult(); return response; } };
  } };
}

test('Relay compaction persists checkpoints, rebuilds after reopen and retains searchable original history', async t => {
  const { store, open, context, messages, events } = await fixture(t), provider = providerFixture();
  const unrelated = store.getSession('peer:other'), before = projectSession(store.getSession('room:one'));
  assert.ok(before.bytes > config.agentSessionMaxBytes);
  const view = await context.prepare('room:one', { model, streamFn: provider.streamFn, runId: 'task-compact' });
  assert.equal(provider.requests.length, 1);
  assert.match(JSON.stringify(provider.requests[0].context), /ORIGINAL_EVIDENCE_SENTINEL/);
  assert.equal(provider.requests[0].options.sessionId, 'room:one');
  assert.equal(provider.requests[0].options.cacheRetention, 'none');
  assert.ok(view.bytes <= config.agentSessionMaxBytes);
  assert.match(JSON.stringify(view.messages), /FIXTURE_CHECKPOINT/);
  assert.doesNotMatch(JSON.stringify(view.messages), /ORIGINAL_EVIDENCE_SENTINEL|OTHER_SESSION_PRIVATE/);
  assert.ok(view.messages.some(message => message.role === 'user' && message.content === latestInput));
  const saved = store.getSession('room:one');
  assert.deepEqual(saved.messages, messages, 'compaction changes the model view, never the original transcript');
  assert.equal(saved.checkpoints.length, 1);
  assert.equal(saved.checkpoints[0].runId, 'task-compact');
  assert.equal(saved.checkpoints[0].afterMessageCount, messages.length);
  assert.equal(saved.checkpoints[0].bytesAfter, view.bytes);
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, 'room:one');
  assert.deepEqual(store.getSession('peer:other'), unrelated);

  store.close();
  const reopened = open(), resumed = new SessionContext({ sessions: reopened, config });
  const noSummary = async () => { assert.fail('A persisted checkpoint must be reused without another model summary'); };
  assert.deepEqual((await resumed.prepare('room:one', { model, streamFn: noSummary })).messages, view.messages);
  const history = resumed.historyTool('room:one');
  const search = (await history.execute('find-original', { query: 'ORIGINAL_EVIDENCE_SENTINEL' })).details;
  assert.equal(search.messages[0].index, 1);
  assert.match(search.messages[0].preview, /ORIGINAL_EVIDENCE_SENTINEL/);
  let recovered = '', offset = 0;
  do {
    const page = (await history.execute('read-original', { start: 1, limit: 1, offset })).details.messages[0];
    recovered += page.preview; offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(recovered, JSON.stringify(messages[1]), 'every original character remains retrievable after compaction and reopen');
  assert.equal((await history.execute('private-search', { query: 'OTHER_SESSION_PRIVATE' })).details.messages.length, 0);

  const prior = reopened.getSession('room:one');
  reopened.saveSession({ ...prior, messages: [...prior.messages, assistant('Post-checkpoint answer.'), { role: 'user', content: 'FOLLOWUP_AFTER_REOPEN', timestamp: 6 }] });
  const next = await resumed.prepare('room:one', { model, streamFn: noSummary });
  assert.match(JSON.stringify(next.messages), /FIXTURE_CHECKPOINT/);
  assert.match(JSON.stringify(next.messages), /FOLLOWUP_AFTER_REOPEN/);
  assert.doesNotMatch(JSON.stringify(next.messages), /ORIGINAL_EVIDENCE_SENTINEL/);
  assert.deepEqual(reopened.getSession('room:one').messages.slice(0, messages.length), messages);
});

test('a failed or length-limited summary leaves the complete session unchanged', async t => {
  const { store, context, events } = await fixture(t), before = store.getSession('room:one');
  for (const response of [assistant('partial summary', { stopReason: 'length' }), assistant('', { stopReason: 'error', errorMessage: 'fixture provider failure' })]) {
    const provider = providerFixture(response);
    await assert.rejects(context.prepare('room:one', { model, streamFn: provider.streamFn }), /Summarization.*(token cap|fixture provider failure)/);
    assert.equal(provider.requests.length, 1, 'failed summary calls must not retry implicitly');
    assert.deepEqual(store.getSession('room:one'), before);
  }
  assert.equal(events.length, 0);
});

test('a summary that cannot reduce the model view is rejected before checkpoint persistence', async t => {
  const { store, context, events } = await fixture(t), before = store.getSession('room:one');
  const provider = providerFixture(assistant('Oversized summary. '.repeat(1200)));
  await assert.rejects(context.prepare('room:one', { model, streamFn: provider.streamFn }), /压缩后仍超过容量或未减少上下文/);
  assert.equal(provider.requests.length, 1);
  assert.deepEqual(store.getSession('room:one'), before);
  assert.equal(events.length, 0);
});

test('an oversized current input is retained and rejected without buying a futile summary', async t => {
  const { store, context, events } = await fixture(t), original = store.getSession('room:one');
  const before = store.saveSession({ ...original, messages: [...original.messages.slice(0, -1), { role: 'user', content: 'CURRENT_INPUT_TOO_LARGE '.repeat(600), timestamp: 4 }] });
  const provider = providerFixture();
  await assert.rejects(context.prepare('room:one', { model, streamFn: provider.streamFn }), /当前输入或完整工具结果超过保留容量/);
  assert.equal(provider.requests.length, 0);
  assert.deepEqual(store.getSession('room:one'), before);
  assert.equal(events.length, 0);
});

test('concurrent session changes survive an in-flight compaction without a stale checkpoint', async t => {
  const { store, open, context, events } = await fixture(t);
  const otherConnection = open();
  let latest;
  const provider = providerFixture(assistant(summaryText), () => {
    const current = otherConnection.getSession('room:one');
    latest = otherConnection.saveSession({ ...current, expectedRevision: current.revision,
      messages: [...current.messages, assistant('NEW_CONCURRENT_FACT')] });
  });
  await assert.rejects(context.prepare('room:one', { model, streamFn: provider.streamFn }), /压缩期间会话已变化/);
  assert.deepEqual(store.getSession('room:one'), latest);
  assert.equal(events.length, 0);
});
