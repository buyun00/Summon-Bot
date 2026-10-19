import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const textOf = message => typeof message.content === 'string' ? message.content : (message.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const payloadOf = message => { try { return JSON.parse(textOf(message)); } catch { return null; } };
const turnsOf = context => context.messages.filter(message => message.role === 'user').map(payloadOf).filter(value => value?.type === 'relay_turn');
const currentTurn = context => turnsOf(context).at(-1);
const tool = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const reply = value => [{ type: 'text', text: JSON.stringify({ reply: value, actions: [] }) }];
const emptyUsage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
async function until(fn, label = 'session operation') {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = fn(); if (value) return value; await pause(15); }
  throw new Error(`Timed out waiting for ${label}`);
}

// Deliberate model double only. Actual pi core, native message events, filesystem,
// HTTP lifecycle and SQLite persistence execute normally. No cache-hit claim is
// made from these synthetic usage values; live validation uses the real provider.
function modelDouble(handler, requests) {
  return { status: {}, complete: async () => ({ content: '{"reply":"summary double","actions":[]}' }),
    stream(model, context, options) {
      const captured = structuredClone(context); requests.push(captured);
      const stream = new AssistantMessageEventStream();
      queueMicrotask(async () => {
        try {
          const content = await handler(captured, options);
          const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: emptyUsage(), stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
        } catch (error) {
          const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
            usage: emptyUsage(), stopReason: options?.signal?.aborted ? 'aborted' : 'error', errorMessage: error.message, timestamp: Date.now() };
          stream.push({ type: 'error', reason: message.stopReason, error: message }); stream.end(message);
        }
      });
      return stream;
    },
  };
}

async function fixture(t, handler, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-session-test-'));
  const project = join(root, 'project'); await mkdir(project);
  const dataDir = join(root, 'state');
  const config = { dataDir, database: join(dataDir, 'relay.sqlite'), defaultCwd: project, port: 0, apiKey: 'session-double-secret', ...overrides };
  const requests = [];
  const provider = modelDouble(handler, requests);
  const executor = { start() {}, stop() {}, list: () => [], get: () => null, create() { throw new Error('This test must not delegate'); } };
  const state = { app: await startServer({ config, provider, executor }), root, project, config, provider, requests };
  state.restart = async () => { await state.app.close(); state.app = await startServer({ config, provider, executor }); };
  state.room = (botId = 'bot-engineer', kind = 'dm') => state.app.social.createRoom({ kind, members: ['user', botId] });
  state.send = (roomId, content, toBotId) => state.app.social.postMessage(roomId, { content, ...(toBotId ? { toBotId } : {}) });
  state.settled = async message => {
    const job = await until(() => state.app.store.list('jobs').find(item => item.messageId === message.id && ['completed', 'failed', 'cancelled', 'interrupted'].includes(item.status)), 'terminal job');
    const run = state.app.store.get('agentRuns', job.agentRunId);
    return { job, run };
  };
  state.completed = async message => {
    const result = await state.settled(message);
    assert.equal(result.job.status, 'completed', result.job.error);
    assert.equal(result.run.status, 'completed', result.run.error);
    return result.run;
  };
  state.session = (botId, roomId) => state.app.store.list('agentSessions').find(session => session.botId === botId && session.roomId === roomId);
  t.after(async () => { await state.app.close(); await rm(root, { recursive: true, force: true }); });
  return state;
}

function assertToolPairs(messages) {
  let awaiting = [];
  for (const message of messages) {
    if (message.role === 'toolResult') {
      const index = awaiting.findIndex(call => call.id === message.toolCallId && call.name === message.toolName);
      assert.notEqual(index, -1, `orphan tool result ${message.toolCallId}`);
      awaiting.splice(index, 1);
    } else {
      assert.equal(awaiting.length, 0, 'a new message cannot precede outstanding tool results');
      if (message.role === 'assistant') awaiting = (message.content || []).filter(part => part.type === 'toolCall');
    }
  }
  assert.equal(awaiting.length, 0, 'every persisted tool call must have an observation before continuing');
}

test('same Bot and room retain complete tool conversation, append only new events and restore after restart', { timeout: 20000 }, async t => {
  let f;
  f = await fixture(t, context => {
    const turn = currentTurn(context);
    if (turn.trigger.content === 'FIRST_FILE_REQUEST') {
      if (!context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'write-once')) {
        return [tool('write-once', 'write_file', { path: 'retained.txt', content: 'FILE_CONTEXT_NONCE_中文_941' })];
      }
      return reply('FIRST_ANSWER_UNIQUE');
    }
    assert.ok(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'write-once'));
    assert.ok(context.messages.some(message => message.role === 'assistant' && textOf(message).includes('FIRST_ANSWER_UNIQUE')));
    assertToolPairs(context.messages);
    return reply(turn.trigger.content === 'AFTER_RESTART' ? 'RESUMED_ANSWER' : 'SECOND_ANSWER');
  });
  const room = f.room();
  const first = f.send(room.id, 'FIRST_FILE_REQUEST');
  const firstRun = await f.completed(first);
  const initialSession = f.session('bot-engineer', room.id);
  const firstHistory = structuredClone(initialSession.messages);
  assert.ok(firstRun.sessionId); assert.equal(firstRun.sessionId, initialSession.id);
  assert.equal(await readFile(join(firstRun.workspace, 'retained.txt'), 'utf8'), 'FILE_CONTEXT_NONCE_中文_941');
  const beforeSecond = f.requests.length;
  const second = f.send(room.id, 'SECOND_MESSAGE');
  const secondRun = await f.completed(second);
  assert.notEqual(secondRun.id, firstRun.id); assert.equal(secondRun.sessionId, firstRun.sessionId);
  const secondRequest = f.requests[beforeSecond];
  assert.deepEqual(secondRequest.messages.slice(0, firstHistory.length), firstHistory);
  assert.deepEqual(currentTurn(secondRequest).messages.map(message => message.id), [second.id]);
  assert.equal(JSON.stringify(secondRequest.messages.filter(message => message.role === 'user')).includes('FIRST_ANSWER_UNIQUE'), false);
  assert.equal(f.app.store.list('toolRuns').length, 1, 'second response must not replay the write');
  assert.equal(firstRun.requests.length, 2); assert.equal(firstRun.requests[0].firstInRun, true); assert.equal(firstRun.requests[1].firstInRun, false);
  assert.equal(secondRun.requests.length, 1); assert.equal(secondRun.requests[0].firstInRun, true);
  const secondHistory = structuredClone(f.session('bot-engineer', room.id).messages);
  await f.restart();
  assert.deepEqual(f.session('bot-engineer', room.id).messages, secondHistory);
  const beforeThird = f.requests.length;
  const thirdRun = await f.completed(f.send(room.id, 'AFTER_RESTART'));
  assert.equal(thirdRun.sessionId, firstRun.sessionId);
  assert.deepEqual(f.requests[beforeThird].messages.slice(0, secondHistory.length), secondHistory);
  assert.equal(f.app.store.list('toolRuns').length, 1);
  assert.equal(await readFile(join(firstRun.workspace, 'retained.txt'), 'utf8'), 'FILE_CONTEXT_NONCE_中文_941');
});

test('sessions isolate native transcripts across rooms and Bot identities', { timeout: 20000 }, async t => {
  const f = await fixture(t, context => reply(`BOT_PRIVATE_ANSWER_${currentTurn(context).trigger.content}`));
  const firstRoom = f.room('bot-engineer');
  const runA = await f.completed(f.send(firstRoom.id, 'ROOM_A_MARKER'));
  const secondRoom = f.app.social.createRoom({ kind: 'group', members: ['user', 'bot-engineer', 'bot-qa'] });
  const beforeB = f.requests.length;
  const runB = await f.completed(f.send(secondRoom.id, 'ROOM_B_MARKER', 'bot-engineer'));
  assert.equal(JSON.stringify(f.requests[beforeB].messages).includes('ROOM_A_MARKER'), false);
  const beforeC = f.requests.length;
  const runC = await f.completed(f.send(secondRoom.id, 'ROOM_C_MARKER', 'bot-qa'));
  assert.equal(new Set([runA.sessionId, runB.sessionId, runC.sessionId]).size, 3);
  assert.equal(f.requests[beforeC].messages.some(message => message.role === 'assistant'), false, 'other Bot replies are room events, never this Bot native assistant transcript');
  assert.equal(f.app.store.list('agentSessions').length, 3);
});

test('changing memory appends context updates without rewriting prior request prefixes', { timeout: 20000 }, async t => {
  const f = await fixture(t, () => reply('context received'));
  const room = f.room('bot-qa');
  await f.completed(f.send(room.id, 'before memory'));
  const firstSession = structuredClone(f.session('bot-qa', room.id));
  f.app.store.save('memories', { botId: 'bot-qa', content: 'TAIL_MEMORY_MARKER_42', category: 'professional', status: 'active' });
  let before = f.requests.length;
  await f.completed(f.send(room.id, 'after memory'));
  const changed = f.requests[before];
  assert.deepEqual(changed.messages.slice(0, firstSession.messages.length), firstSession.messages);
  assert.equal(JSON.stringify(firstSession.messages).includes('TAIL_MEMORY_MARKER_42'), false);
  assert.ok(currentTurn(changed).contextUpdate.memories.some(memory => memory.content === 'TAIL_MEMORY_MARKER_42'));
  before = f.requests.length;
  await f.completed(f.send(room.id, 'unchanged memory'));
  assert.equal(currentTurn(f.requests[before]).contextUpdate, undefined, 'unchanged dynamic context should not be injected again');
});

test('first session consumes older room events instead of applying the former 24-message window', { timeout: 20000 }, async t => {
  const f = await fixture(t, context => {
    const events = currentTurn(context).messages;
    assert.equal(events.length, 36);
    assert.equal(events[0].content, 'OLDER_EVENT_0');
    assert.equal(events[34].content, 'OLDER_EVENT_34');
    return reply('all room history received');
  });
  const room = f.room();
  for (let index = 0; index < 35; index++) f.app.social.appendMessage(room.id, { content: `OLDER_EVENT_${index}` }, 'user');
  await f.completed(f.send(room.id, 'CREATE_SESSION_WITH_HISTORY'));
  assert.equal(f.requests.length, 1);
});

test('provider failure retains confirmed side effects and allows a new turn without replay', { timeout: 20000 }, async t => {
  const f = await fixture(t, context => {
    if (currentTurn(context).trigger.content === 'RECOVER_PROVIDER_ERROR') {
      assertToolPairs(context.messages);
      const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'before-provider-error');
      assert.ok(result); assert.equal(Boolean(result.isError), false);
      assert.equal(context.messages.some(message => message.role === 'assistant' && message.stopReason === 'error'), false);
      return reply('write result retained; prior response failed');
    }
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'before-provider-error')) {
      return [tool('before-provider-error', 'write_file', { path: 'before-provider-error.txt', content: 'CONFIRMED_WRITE' })];
    }
    throw new Error('Deliberate upstream model failure');
  });
  const room = f.room();
  const { job, run } = await f.settled(f.send(room.id, 'TRIGGER_PROVIDER_ERROR'));
  assert.equal(job.status, 'failed'); assert.equal(run.status, 'failed');
  assert.match(run.error, /Deliberate upstream model failure/);
  assert.equal(await readFile(join(run.workspace, 'before-provider-error.txt'), 'utf8'), 'CONFIRMED_WRITE');
  await f.restart();
  await f.completed(f.send(room.id, 'RECOVER_PROVIDER_ERROR'));
  assert.equal(f.app.store.list('toolRuns').length, 1);
});

test('cancelled tool execution is retained as an error observation and never automatically replayed', { timeout: 20000 }, async t => {
  const f = await fixture(t, context => {
    if (currentTurn(context).trigger.content === 'CONTINUE_AFTER_CANCEL') {
      assertToolPairs(context.messages);
      const cancelled = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'cancel-wait');
      assert.ok(cancelled?.isError);
      return reply('previous command cancelled; no replay');
    }
    if (!context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'write-before-cancel')) {
      return [tool('write-before-cancel', 'write_file', { path: 'before-cancel.txt', content: 'SIDE_EFFECT_ONCE' })];
    }
    return [tool('cancel-wait', 'run_command', { command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeoutMs: 40000 })];
  });
  const room = f.room();
  const request = f.send(room.id, 'START_CANCEL_CASE');
  const waiting = await until(() => f.app.store.list('toolRuns').find(record => record.toolCallId === 'cancel-wait' && record.status === 'running'), 'cancel target');
  const cancelled = await f.app.agentRuntime.cancel(waiting.runId);
  assert.equal(cancelled.status, 'cancelled');
  await f.settled(request);
  assert.equal(await readFile(join(cancelled.workspace, 'before-cancel.txt'), 'utf8'), 'SIDE_EFFECT_ONCE');
  await f.restart();
  const followup = await f.completed(f.send(room.id, 'CONTINUE_AFTER_CANCEL'));
  assert.equal(followup.sessionId, cancelled.sessionId);
  assert.equal(f.app.store.list('toolRuns').length, 2);
  assert.equal(await readFile(join(cancelled.workspace, 'before-cancel.txt'), 'utf8'), 'SIDE_EFFECT_ONCE');
});

test('restart repairs an incomplete tool pair as unconfirmed without redoing a possible side effect', { timeout: 20000 }, async t => {
  const f = await fixture(t, context => {
    if (currentTurn(context).trigger.content === 'INSPECT_CRASH') {
      assertToolPairs(context.messages);
      const unconfirmed = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'crash-write');
      assert.ok(unconfirmed?.isError); assert.match(textOf(unconfirmed), /未确认|unknown|interrupted/i);
      return reply('possible write has unconfirmed outcome');
    }
    return reply('session initialized');
  });
  const room = f.room();
  const initialRun = await f.completed(f.send(room.id, 'INITIALIZE_CRASH_FIXTURE'));
  const session = f.session('bot-engineer', room.id);
  const partial = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
    content: [tool('crash-write', 'write_file', { path: 'crash-side-effect.txt', content: 'WOULD_OVERWRITE_IF_REPLAYED' })],
    usage: emptyUsage(), stopReason: 'toolUse', timestamp: Date.now() };
  // Explicit crash-state fixture: filesystem effect happened, result persistence did not.
  await writeFile(join(initialRun.workspace, 'crash-side-effect.txt'), 'POSSIBLE_EFFECT_ALREADY_PRESENT');
  f.app.store.save('agentRuns', { id: 'crash-run', sessionId: session.id, botId: 'bot-engineer', roomId: room.id, jobId: 'crash-job', status: 'running', messages: [partial] });
  f.app.store.save('toolRuns', { id: 'crash-run:1:crash-write', runId: 'crash-run', turn: 1, toolCallId: 'crash-write', name: 'write_file', args: partial.content[0].arguments, status: 'running' });
  f.app.store.save('agentSessions', { ...session, messages: [...session.messages, partial], lastRunId: 'crash-run' });
  await f.restart();
  assert.equal(f.app.store.get('agentRuns', 'crash-run').status, 'interrupted');
  await f.completed(f.send(room.id, 'INSPECT_CRASH'));
  assert.equal(await readFile(join(initialRun.workspace, 'crash-side-effect.txt'), 'utf8'), 'POSSIBLE_EFFECT_ALREADY_PRESENT');
  assert.equal(f.app.store.list('toolRuns').length, 1, 'repair is an observation, not a newly executed tool');
});

test('restart restores persisted tool receipts before message_end without replay or cross-run ID confusion', { timeout: 20000 }, async t => {
  const receipts = {
    knownSuccess: { content: [{ type: 'text', text: 'CONFIRMED_WRITE_RECEIPT' }], details: { bytes: 17, path: 'receipt.txt' } },
    knownFailure: { content: [{ type: 'text', text: 'CONFIRMED_TOOL_ERROR' }], details: { exitCode: 7, stdout: '', stderr: 'expected failure' } },
  };
  const f = await fixture(t, context => {
    if (currentTurn(context).trigger.content === 'CONTINUE_AFTER_SAVED_RECEIPTS') {
      assertToolPairs(context.messages);
      const success = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'known-success');
      const failure = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'known-failure');
      assert.deepEqual(success.content, receipts.knownSuccess.content); assert.deepEqual(success.details, receipts.knownSuccess.details);
      assert.equal(success.isError, false);
      assert.deepEqual(failure.content, receipts.knownFailure.content); assert.equal(failure.isError, true);
      assert.equal(JSON.stringify(context.messages).includes('UNRELATED_OLD_RECEIPT'), false);
      return reply('persisted receipts restored; no new operations');
    }
    return reply('receipt fixture initialized');
  });
  const room = f.room();
  const initialRun = await f.completed(f.send(room.id, 'INITIALIZE_RECEIPT_FIXTURE'));
  const session = f.session('bot-engineer', room.id);
  const partial = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
    content: [tool('known-success', 'write_file', { path: 'receipt.txt', content: 'DO_NOT_REPLAY' }), tool('known-failure', 'run_command', { command: 'exit 7' })],
    usage: emptyUsage(), stopReason: 'toolUse', timestamp: Date.now() };
  // Crash fixture: tool_execution_end already saved both tool receipts; message_end
  // had not appended their native toolResult messages when the process stopped.
  await writeFile(join(initialRun.workspace, 'receipt.txt'), 'EFFECT_ALREADY_PRESENT');
  f.app.store.save('agentRuns', { id: 'receipt-crash-run', sessionId: session.id, botId: 'bot-engineer', roomId: room.id, status: 'running', messages: [partial] });
  f.app.store.save('toolRuns', { id: 'unrelated:1:known-success', runId: 'unrelated-run', turn: 1, toolCallId: 'known-success', name: 'write_file', status: 'completed', result: { content: [{ type: 'text', text: 'UNRELATED_OLD_RECEIPT' }] } });
  for (const [index, [key, status]] of [['knownSuccess', 'completed'], ['knownFailure', 'failed']].entries()) {
    const call = partial.content[index];
    f.app.store.save('toolRuns', { id: `receipt-crash-run:1:${call.id}`, runId: 'receipt-crash-run', turn: 1,
      toolCallId: call.id, name: call.name, args: call.arguments, status, result: receipts[key], finishedAt: new Date().toISOString() });
  }
  f.app.store.save('agentSessions', { ...session, messages: [...session.messages, partial], lastRunId: 'receipt-crash-run' });
  await f.restart();
  await f.completed(f.send(room.id, 'CONTINUE_AFTER_SAVED_RECEIPTS'));
  assert.equal(await readFile(join(initialRun.workspace, 'receipt.txt'), 'utf8'), 'EFFECT_ALREADY_PRESENT');
  assert.equal(f.app.store.list('toolRuns').length, 3);
});

test('session setup failures close the run, allow cancellation and release the session for another response', { timeout: 20000 }, async t => {
  const f = await fixture(t, () => reply('recovered after setup fault'));
  const room = f.room();
  const sessions = f.app.agentRuntime.sessions;
  const originalLoad = sessions.load;
  sessions.load = () => { throw new Error('Deliberate session setup fault'); };
  const { job, run } = await f.settled(f.send(room.id, 'FAIL_DURING_SESSION_SETUP'));
  assert.equal(job.status, 'failed'); assert.equal(run.status, 'failed'); assert.match(run.error, /Deliberate session setup fault/);
  assert.equal(f.app.agentRuntime.active.size, 0); assert.equal(f.app.agentRuntime.sessionsBusy.size, 0);
  assert.equal(f.app.agentRuntime.pendingStarts.size, 0); assert.equal(f.requests.length, 0);
  const cancelled = await f.app.agentRuntime.cancel(run.id);
  assert.equal(cancelled.status, 'failed', 'already failed setup must not become a permanent running/cancelling record');
  sessions.load = originalLoad;
  const recovery = await f.completed(f.send(room.id, 'RETRY_AFTER_SETUP_FIX'));
  assert.notEqual(recovery.id, run.id); assert.equal(recovery.sessionId, run.sessionId);
});

test('legacy runs migrate only once into the matching Bot and room session', { timeout: 20000 }, async t => {
  const f = await fixture(t, context => {
    assertToolPairs(context.messages);
    assert.ok(context.messages.some(message => message.role === 'toolResult' && textOf(message).includes('LEGACY_OBSERVATION')));
    assert.equal(JSON.stringify(context.messages).includes('FOREIGN_TRANSCRIPT'), false);
    return reply('legacy resumed');
  });
  const room = f.room();
  const legacyAssistant = { role: 'assistant', api: 'openai-completions', provider: 'deepseek', model: 'deepseek-flash',
    content: [tool('legacy-read', 'read_file', { path: 'old.txt' })], usage: emptyUsage(), stopReason: 'toolUse', timestamp: Date.now() };
  const legacy = [
    { role: 'user', content: JSON.stringify({ trigger: { id: 'legacy-trigger', content: 'OLD_REQUEST' }, messages: [] }), timestamp: Date.now() },
    legacyAssistant,
    { role: 'toolResult', toolCallId: 'legacy-read', toolName: 'read_file', content: [{ type: 'text', text: 'LEGACY_OBSERVATION' }], isError: false, timestamp: Date.now() },
    { ...legacyAssistant, content: reply('legacy answer'), stopReason: 'stop' },
  ];
  f.app.store.save('agentRuns', { id: 'legacy-matching', botId: 'bot-engineer', roomId: room.id, status: 'completed', messages: legacy });
  f.app.store.save('agentRuns', { id: 'legacy-foreign', botId: 'bot-qa', roomId: room.id, status: 'completed', messages: [{ role: 'user', content: 'FOREIGN_TRANSCRIPT', timestamp: Date.now() }] });
  await f.completed(f.send(room.id, 'RESUME_LEGACY'));
  const session = f.session('bot-engineer', room.id);
  assert.ok(session.migratedRunIds.includes('legacy-matching')); assert.equal(session.migratedRunIds.includes('legacy-foreign'), false);
  await f.restart();
  await f.completed(f.send(room.id, 'RESUME_LEGACY_AGAIN'));
  const results = f.session('bot-engineer', room.id).messages.filter(message => message.role === 'toolResult' && message.toolCallId === 'legacy-read');
  assert.equal(results.length, 1); assert.equal(f.app.store.list('toolRuns').length, 0);
});

test('context capacity fails explicitly and retains history rather than silently truncating', { timeout: 20000 }, async t => {
  const f = await fixture(t, () => reply('small complete reply'));
  const room = f.room();
  await f.completed(f.send(room.id, 'CAPACITY_OLD_MARKER'));
  const original = structuredClone(f.session('bot-engineer', room.id));
  f.app.agentRuntime.config.agentSessionMaxBytes = 1;
  const requestCount = f.requests.length;
  const { job, run } = await f.settled(f.send(room.id, 'CAPACITY_NEW_MARKER'));
  assert.equal(job.status, 'failed'); assert.equal(run.status, 'failed'); assert.match(run.error, /容量|上限|超|capacity|limit/i);
  assert.equal(f.requests.length, requestCount, 'oversized context must be rejected before another model request');
  const retained = f.session('bot-engineer', room.id);
  assert.deepEqual(retained.messages.slice(0, original.messages.length), original.messages);
  assert.ok(JSON.stringify(retained.messages).includes('CAPACITY_OLD_MARKER'));
});
