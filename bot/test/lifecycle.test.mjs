import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startBot, requestBot, sendMessage, waitForTask, inspectBotIdentity, BotStore } from '../src/index.mjs';

const managementToken = 'fixture-lifecycle-management-token-38429';
const sleep = ms => new Promise(done => setTimeout(done, ms));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise, message, milliseconds = 5000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function jsonBody(request) { let body = ''; for await (const chunk of request) body += chunk; return JSON.parse(body || '{}'); }
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
const contact = bot => ({ botId: bot.config.botId, url: bot.url, token: bot.config.token });

async function fixture(t, { configured = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-bot-lifecycle-'));
  const started = deferred(), release = deferred(), requests = [], toolRequests = [], bots = [], streams = [];
  const toolServer = createServer(async (request, response) => {
    const body = await jsonBody(request);
    toolRequests.push({ url: request.url, body });
    // The external operation has started before its HTTP response is ready.
    // Disconnecting the caller cannot prove that this effect was undone.
    started.resolve(body);
    await release.promise;
    if (!response.destroyed) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ accepted: true, receipt: 'external-receipt' })); }
  });
  const modelServer = createServer(async (request, response) => {
    const input = await jsonBody(request); requests.push(input);
    const last = input.messages.at(-1);
    const useTool = last?.role === 'user' && String(last.content).includes('LONG_OPERATION');
    const answer = useTool ? { content: null, tool_calls: [{ id: `tool-call-${requests.length}`, type: 'function',
      function: { name: 'long_operation', arguments: JSON.stringify({ marker: 'operation-started' }) } }] }
      : { content: 'fixture completed through the actual Pi Agent' };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: `model-response-${requests.length}`, model: 'fixture-model',
      choices: [{ finish_reason: useTool ? 'tool_calls' : 'stop', message: { role: 'assistant', ...answer } }],
      usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } }));
  });
  let toolUrl, modelUrl;
  t.after(async () => {
    for (const stream of streams) await stream.close();
    release.resolve();
    await Promise.allSettled(bots.map(bot => bot.close()));
    await Promise.allSettled([closeServer(modelServer), closeServer(toolServer)]);
    assert.equal(dirname(resolve(root)), resolve(tmpdir()), 'cleanup remains inside this test temporary directory');
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  toolUrl = await listen(toolServer); modelUrl = await listen(modelServer);
  const config = { botId: 'lifecycle-bot', dataDir: join(root, 'bot-data'), token: managementToken,
    model: { provider: 'openai-compatible', model: 'fixture-model', baseUrl: modelUrl + '/v1', ...(configured ? { apiKey: 'fixture-model-credential' } : {}) },
    limits: { maxTurns: 8, maxTools: 8, timeoutMs: 20000 },
    tools: [{ type: 'http', name: 'long_operation', description: 'A deliberately slow external operation', effect: 'external',
      url: toolUrl + '/tools/long_operation', timeoutMs: 15000,
      inputSchema: { type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false } }],
  };
  const start = async () => { const bot = await startBot(config); bots.push(bot); return bot; };
  const bot = await start();
  return { root, config, bot, start, started, release, requests, toolRequests, streams };
}

async function openEvents(bot, path, extraHeaders = {}) {
  const controller = new AbortController();
  const response = await fetch(bot.url + path, { headers: { authorization: `Bearer ${bot.config.token}`,
    accept: 'text/event-stream', ...extraHeaders }, signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader(), events = [], decoder = new TextDecoder();
  let error, pending = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        pending += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) !== -1) {
          const block = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const lines = block.split('\n'), id = Number(lines.find(line => line.startsWith('id:'))?.slice(3).trim());
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (data) events.push({ id, ...JSON.parse(data) });
        }
      }
    } catch (caught) { if (!controller.signal.aborted) error = caught; }
  })();
  return { events,
    async until(predicate) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (error) throw error;
        const event = events.find(predicate); if (event) return event;
        await sleep(10);
      }
      throw new Error('SSE event did not arrive');
    },
    async close() { controller.abort(); await reader.cancel().catch(() => {}); await pump; },
  };
}

test('cancel after a real HTTP tool starts records unknown effect and cancelled task while health/messages remain responsive', async t => {
  const f = await fixture(t), peer = contact(f.bot);
  const first = await sendMessage(peer, { id: 'long-cancel', sessionId: 'long-session', content: 'LONG_OPERATION' });
  assert.deepEqual(await bounded(f.started.promise, 'external tool never started'), { arguments: { marker: 'operation-started' } });
  const before = await requestBot(peer, `/tasks/${first.taskId}`);
  assert.equal(before.status, 'running'); assert.equal(before.tools.length, 1); assert.equal(before.tools[0].status, 'running');

  const begin = Date.now();
  const [health, messages, queued] = await Promise.all([
    requestBot(peer, '/health'), requestBot(peer, '/messages'),
    sendMessage(peer, { id: 'queued-cancel', sessionId: 'separate-session', content: 'queued response' }),
  ]);
  assert.ok(Date.now() - begin < 2000, 'ordinary HTTP access must not wait for the long tool');
  assert.equal(health.state, 'ready'); assert.equal(health.engine.activeTaskId, first.taskId);
  assert.equal(health.engine.activity, 'waiting'); assert.equal(health.engine.waitingFor.kind, 'tool'); assert.equal(health.engine.waitingFor.name, 'long_operation');
  assert.ok(messages.some(message => message.sourceMessageId === 'long-cancel'));
  assert.equal((await requestBot(peer, `/tasks/${queued.taskId}`)).status, 'accepted');
  await requestBot(peer, `/tasks/${queued.taskId}/cancel`, { method: 'POST', body: {} });
  await requestBot(peer, `/tasks/${first.taskId}/cancel`, { method: 'POST', body: {} });
  const result = await waitForTask(peer, first.taskId, { timeoutMs: 5000, intervalMs: 10 });
  assert.equal(result.status, 'cancelled'); assert.equal(result.cancelRequested, true);
  assert.equal(result.tools.length, 1); assert.equal(result.tools[0].status, 'unknown');
  assert.equal(result.tools[0].effect, 'external');
  assert.equal((await requestBot(peer, `/tasks/${queued.taskId}`)).status, 'cancelled');
  assert.equal(f.requests.length, 1, 'cancelled work must not trigger another model turn or queued execution');
  assert.equal(f.toolRequests.length, 1, 'no retry of the unconfirmed external operation');
});

test('shutdown interrupts an accepted queued task without executing it and restart never replays either task', async t => {
  const f = await fixture(t), peer = contact(f.bot);
  const active = await sendMessage(peer, { id: 'long-shutdown', sessionId: 'running-session', content: 'LONG_OPERATION' });
  await bounded(f.started.promise, 'shutdown fixture tool never started');
  const queued = await sendMessage(peer, { id: 'queued-shutdown', sessionId: 'queued-session', content: 'must not execute' });
  assert.equal((await requestBot(peer, `/tasks/${queued.taskId}`)).status, 'accepted');
  const receipt = await requestBot(peer, '/shutdown', { method: 'POST', body: {} });
  assert.equal(receipt.stopping, true);
  await bounded(f.bot.close(), 'Bot did not close after HTTP tool cancellation');
  assert.equal(await inspectBotIdentity(f.config.dataDir), null);
  const disk = new BotStore(join(f.config.dataDir, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal(disk.getTask(active.taskId).status, 'interrupted');
    assert.equal(disk.listTools(active.taskId)[0].status, 'unknown');
    assert.equal(disk.getTask(queued.taskId).status, 'interrupted');
    assert.equal(disk.getTask(queued.taskId).error.code, 'BOT_STOPPED');
    assert.equal(disk.getTask(queued.taskId).startedAt, undefined);
    assert.deepEqual(disk.listTools(queued.taskId), []);
    assert.equal(disk.getSession('queued-session'), null);
  } finally { disk.close(); }
  assert.equal(f.requests.length, 1); assert.equal(f.toolRequests.length, 1);

  const restarted = await f.start(), next = contact(restarted);
  assert.notEqual(restarted.bootId, f.bot.bootId);
  const duplicate = await sendMessage(next, { id: 'queued-shutdown', sessionId: 'queued-session', content: 'must not execute' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.taskId, queued.taskId); assert.equal(duplicate.status, 'interrupted');
  assert.equal((await requestBot(next, '/health')).engine.activeTaskId, null);
  assert.equal(f.requests.length, 1); assert.equal(f.toolRequests.length, 1);
});

test('JSON events and SSE resume cursors expose committed task lifecycle events without replaying earlier events', async t => {
  const f = await fixture(t), peer = contact(f.bot);
  const initial = await requestBot(peer, '/events'), cursor = initial.at(-1).seq;
  const stream = await openEvents(f.bot, '/events?stream=1', { 'Last-Event-ID': String(cursor) }); f.streams.push(stream);
  const accepted = await sendMessage(peer, { id: 'sse-first', sessionId: 'event-session', content: 'ordinary response' });
  const final = await stream.until(event => event.type === 'task.completed' && event.taskId === accepted.taskId);
  assert.ok(stream.events.every(event => event.seq > cursor && event.id === event.seq));
  assert.deepEqual(stream.events.map(event => event.seq), [...new Set(stream.events.map(event => event.seq))].sort((a, b) => a - b));
  for (const type of ['task.accepted', 'task.running', 'session.updated', 'engine.request', 'task.completed']) {
    assert.ok(stream.events.some(event => event.type === type), `${type} must be visible through actual SSE`);
  }
  const snapshot = await requestBot(peer, `/events?after=${cursor}`);
  assert.deepEqual(stream.events.map(({ id, ...event }) => event), snapshot);
  await stream.close();
  const resumed = await openEvents(f.bot, `/events?stream=1&after=${final.seq}`, { 'Last-Event-ID': '0' }); f.streams.push(resumed);
  const second = await sendMessage(peer, { id: 'sse-second', sessionId: 'event-session', content: 'another response' });
  await resumed.until(event => event.type === 'task.completed' && event.taskId === second.taskId);
  assert.ok(resumed.events.every(event => event.seq > final.seq));
  assert.equal(resumed.events.some(event => event.taskId === accepted.taskId), false);
  const byTask = await requestBot(peer, `/events?after=${final.seq}&taskId=${second.taskId}`);
  assert.ok(byTask.length >= 3); assert.ok(byTask.every(event => event.taskId === second.taskId));
  assert.equal(f.requests.length, 2);
});

test('a Bot without a model credential retains healthy management access but rejects message execution with 503', async t => {
  const f = await fixture(t, { configured: false }), peer = contact(f.bot);
  const health = await requestBot(peer, '/health');
  assert.equal(health.state, 'ready'); assert.equal(health.engine.engine, 'pi-agent-core');
  assert.equal(health.engine.initialized, true); assert.equal(health.engine.configured, false);
  const response = await fetch(f.bot.url + '/messages', { method: 'POST',
    headers: { authorization: `Bearer ${managementToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'unconfigured-message', to: f.bot.config.botId, kind: 'request', content: 'must not execute' }) });
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'MODEL_UNCONFIGURED');
  assert.deepEqual(await requestBot(peer, '/tasks'), []); assert.deepEqual(await requestBot(peer, '/messages'), []);
  assert.equal(f.requests.length, 0); assert.equal(f.toolRequests.length, 0);
});
