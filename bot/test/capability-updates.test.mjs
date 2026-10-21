import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { startBot, requestBot, sendMessage, waitForTask } from '../src/index.mjs';

const token = 'capability-update-fixture-management-token';
const dirs = [];
const fixture = async () => { const dir = await mkdtemp(join(tmpdir(), 'relay-capability-update-')); dirs.push(dir); return dir; };
after(async () => { for (const dir of dirs) { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } });
const deferred = () => { let resolve; const promise = new Promise(value => resolve = value); return { promise, resolve }; };
const contact = bot => ({ botId: bot.config.botId, url: bot.url, token });
const post = (bot, path, body) => requestBot(contact(bot), path, { method: 'POST', body });
const config = (dataDir, baseUrl, tools = [], rest = {}) => ({ botId: 'switch-bot', dataDir, token, tools,
  model: { provider: 'openai-compatible', model: 'fixture', baseUrl, apiKey: 'fixture-key' }, ...rest });
const definition = (url, version) => ({ type: 'http', name: 'version_read', description: `Read capability version ${version}`,
  effect: 'read', inputSchema: { type: 'object', properties: {} }, url: `${url}/${version}`, headers: { authorization: `Bearer capability-secret-${version}-123456789` } });
async function server(handler) {
  const instance = http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }));
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${instance.address().port}`, async close() { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); } };
}
async function model(handler) {
  const requests = [];
  const instance = await server(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const input = JSON.parse(text); requests.push(input); const answer = await handler(input, requests.length);
    if (res.destroyed) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `answer-${requests.length}`, model: 'fixture', choices: [{ finish_reason: answer.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...answer } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  });
  return { ...instance, url: `${instance.url}/v1`, requests };
}
async function status(bot, id, expected) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const update = await requestBot(contact(bot), `/capability-updates/${id}`);
    if (update.status === expected) return update;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Update ${id} did not reach ${expected}`);
}

test('prepare preserves active v1 task and commit routes the queued task to v2 with durable metadata', async t => {
  const dir = await fixture(), entered = deferred(), release = deferred(), calls = [];
  const tools = await server((req, res) => { calls.push(req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: req.url.slice(1) })); }); t.after(() => tools.close());
  const backend = await model(async (input, index) => {
    if (index === 1) { entered.resolve(); await release.promise; }
    if (input.messages.at(-1).role === 'tool') return { content: input.messages.at(-1).content };
    return { content: null, tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'version_read', arguments: '{}' } }] };
  }); t.after(() => backend.close());
  const bot = await startBot(config(dir, backend.url, [definition(tools.url, 'v1')])); t.after(() => bot.close());
  const first = await sendMessage(contact(bot), { content: 'first', sessionId: 'first' }); await entered.promise;
  const update = { id: 'rollout-2', bindingRevision: 'binding-2', tools: [definition(tools.url, 'v2')], bundledToolNames: ['version_read'], reason: 'New version available' };
  assert.equal((await post(bot, '/capability-updates/prepare', update)).status, 'preparing');
  const queued = await sendMessage(contact(bot), { content: 'second', sessionId: 'second' });
  await assert.rejects(post(bot, '/capability-updates/rollout-2/commit'), { status: 409 });
  assert.equal((await requestBot(contact(bot), `/tasks/${queued.taskId}`)).status, 'accepted');
  assert.equal((await requestBot(contact(bot), '/health')).engine.capabilitySwitchPending, true);
  release.resolve();
  const oldResult = await waitForTask(contact(bot), first.taskId);
  assert.equal(oldResult.status, 'completed', JSON.stringify(oldResult)); assert.match(oldResult.result.content, /v1/);
  await status(bot, 'rollout-2', 'ready');
  assert.deepEqual(calls, ['/v1']); assert.equal((await requestBot(contact(bot), `/tasks/${queued.taskId}`)).status, 'accepted');
  assert.equal((await post(bot, '/capability-updates/rollout-2/commit')).status, 'committed');
  const newResult = await waitForTask(contact(bot), queued.taskId);
  assert.equal(newResult.status, 'completed', JSON.stringify(newResult)); assert.match(newResult.result.content, /v2/);
  assert.deepEqual(calls, ['/v1', '/v2']);
  const newRequest = backend.requests.find(request => request.messages.some(message => message.content === 'second'));
  assert.match(JSON.stringify(newRequest.tools), /version v2/);
  assert.match(newRequest.messages[0].content, /binding-2/);
  const saved = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.capabilityUpdateId, 'rollout-2'); assert.equal(saved.capabilityBindingRevision, 'binding-2'); assert.equal(saved.tools[0].url, `${tools.url}/v2`);
  assert.deepEqual(saved.bundledToolNames, ['version_read']);
  assert.equal((await post(bot, '/capability-updates/prepare', update)).status, 'committed');
  assert.equal((await post(bot, '/capability-updates/rollout-2/commit')).status, 'committed');
  await assert.rejects(post(bot, '/capability-updates/prepare', { ...update, tools: [] }), { status: 409 });
  const events = await requestBot(contact(bot), '/events');
  for (const state of ['preparing', 'ready', 'committed']) assert.ok(events.some(event => event.type === `capability.update.${state}`));
  assert.doesNotMatch(JSON.stringify(events), /capability-secret-/);
  assert.doesNotMatch(JSON.stringify(bot.store.listRecords('capability-updates')), /capability-secret-/);
  await bot.close();
  const restarted = await startBot(saved); t.after(() => restarted.close());
  assert.equal((await requestBot(contact(restarted), '/health')).engine.capabilityBindingRevision, 'binding-2');
  assert.equal((await requestBot(contact(restarted), '/capability-updates/rollout-2')).status, 'committed');
  await post(restarted, '/capability-updates/prepare', { id: 'unload', bindingRevision: 'binding-3', tools: [], bundledToolNames: [] }); await status(restarted, 'unload', 'ready');
  await post(restarted, '/capability-updates/unload/commit');
  assert.equal((await requestBot(contact(restarted), '/health')).engine.tools.includes('version_read'), false);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).bundledToolNames, []);
});

test('invalid candidates, aborts and conflicts preserve the previous tools and allow a new update', async t => {
  const dir = await fixture(), backend = await model(() => ({ content: 'ok' })); t.after(() => backend.close());
  const bot = await startBot(config(dir, backend.url, [], { peers: [{ botId: 'peer', token: 'capability-update-fixture-peer-token' }] })); t.after(() => bot.close());
  await assert.rejects(requestBot({ ...contact(bot), token: 'capability-update-fixture-peer-token' }, '/capability-updates/prepare', { method: 'POST', body: { id: 'peer', bindingRevision: 'peer', tools: [] } }), { status: 403 });
  await post(bot, '/capability-updates/prepare', { id: 'bad', bindingRevision: 'bad', tools: [{ type: 'http', name: 'state_set', description: 'collision', inputSchema: { type: 'object' }, url: 'http://127.0.0.1:1' }] });
  assert.match((await status(bot, 'bad', 'failed')).error.message, /Duplicate tool/);
  assert.equal((await requestBot(contact(bot), '/health')).engine.capabilitySwitchPending, false);
  await post(bot, '/capability-updates/prepare', { id: 'unknown-managed-tool', bindingRevision: 'invalid', tools: [], bundledToolNames: ['missing'] });
  assert.equal((await status(bot, 'unknown-managed-tool', 'failed')).error.code, 'INVALID_CAPABILITY_UPDATE');
  const good = { id: 'good', bindingRevision: 'binding-good', tools: [] };
  await post(bot, '/capability-updates/prepare', good); await status(bot, 'good', 'ready');
  await assert.rejects(post(bot, '/capability-updates/prepare', { ...good, id: 'conflict' }), { status: 409 });
  assert.equal((await post(bot, '/capability-updates/good/abort')).error.code, 'CAPABILITY_UPDATE_ABORTED');
  assert.equal((await post(bot, '/capability-updates/good/abort')).status, 'failed');
  assert.equal((await post(bot, '/capability-updates/prepare', good)).status, 'failed');
  assert.equal((await requestBot(contact(bot), '/health')).engine.capabilitySwitchPending, false);
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8')).tools, []);
  await post(bot, '/capability-updates/prepare', { ...good, id: 'retry' }); await status(bot, 'retry', 'ready');
  assert.equal((await post(bot, '/capability-updates/retry/commit')).status, 'committed');
  const ack = await sendMessage(contact(bot), { content: 'still executable' }); assert.equal((await waitForTask(contact(bot), ack.taskId)).status, 'completed');
});

test('shutdown aborts a prepared update and releases queued work without a hang', async t => {
  const dir = await fixture(), backend = await model(() => ({ content: 'must not execute while held' })); t.after(() => backend.close());
  const original = config(dir, backend.url), bot = await startBot(original); t.after(() => bot.close());
  await post(bot, '/capability-updates/prepare', { id: 'pending', bindingRevision: 'pending', tools: [] }); await status(bot, 'pending', 'ready');
  const ack = await sendMessage(contact(bot), { content: 'queued' });
  await bot.close(); assert.equal(backend.requests.length, 0);
  const restarted = await startBot(original); t.after(() => restarted.close());
  assert.equal((await requestBot(contact(restarted), '/capability-updates/pending')).error.code, 'CAPABILITY_UPDATE_INTERRUPTED');
  assert.equal((await requestBot(contact(restarted), `/tasks/${ack.taskId}`)).status, 'interrupted');
  assert.equal((await requestBot(contact(restarted), '/health')).engine.capabilityBindingRevision, null);
});

async function childBot(path) {
  const child = fork(new URL('../bin/relay-bot.mjs', import.meta.url), ['--config', path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Bot child readiness timeout: ${stderr}`)), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Bot child exited ${code}: ${stderr}`)); });
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
  });
  return { config: { botId: ready.botId }, url: ready.url, child, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    try { await post(this, '/shutdown'); } catch { child.kill('SIGKILL'); }
    await exited;
  } };
}

test('a real subprocess crash before commit never acknowledges the pending revision after restart', async t => {
  const dir = await fixture(), backend = await model(() => ({ content: 'ok' })); t.after(() => backend.close());
  const path = join(dir, 'input.json'); await writeFile(path, JSON.stringify(config(join(dir, 'data'), backend.url)));
  const first = await childBot(path); t.after(() => first.close());
  await post(first, '/capability-updates/prepare', { id: 'crash-before-commit', bindingRevision: 'not-committed', tools: [] }); await status(first, 'crash-before-commit', 'ready');
  const exited = once(first.child, 'exit'); first.child.kill('SIGKILL'); await exited;
  const second = await childBot(path); t.after(() => second.close());
  assert.equal((await requestBot(contact(second), '/capability-updates/crash-before-commit')).error.code, 'CAPABILITY_UPDATE_INTERRUPTED');
  assert.equal((await requestBot(contact(second), '/health')).engine.capabilityBindingRevision, null);
  await post(second, '/capability-updates/prepare', { id: 'after-crash-retry', bindingRevision: 'committed-after-crash', tools: [] }); await status(second, 'after-crash-retry', 'ready');
  assert.equal((await post(second, '/capability-updates/after-crash-retry/commit')).status, 'committed');
});
