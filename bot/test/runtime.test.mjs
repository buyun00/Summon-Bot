import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { startBot, requestBot, sendMessage, waitForTask, inspectBotIdentity, withBotDataLease } from '../src/index.mjs';

const token = 'test-management-token-at-least-24';
const fixtureDirectories = [];
async function fixtureDirectory(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  fixtureDirectories.push(dir);
  return dir;
}
// File-level cleanup runs after all per-test Bot/server shutdown hooks.
after(async () => {
  for (const dir of fixtureDirectories) {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
async function modelServer(handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const data of req) text += data; const input = JSON.parse(text); requests.push(input);
    const answer = await handler(input, requests.length);
    if (res.destroyed) return;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `answer-${requests.length}`, model: 'test-model', choices: [{ finish_reason: answer.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', ...answer } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const configFor = (dataDir, baseUrl, rest = {}) => ({ botId: 'test-bot', dataDir, token, model: { provider: 'openai-compatible', model: 'test-model', baseUrl, apiKey: 'fixture-key' }, ...rest });
const call = (name, args, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const contact = bot => ({ botId: bot.config.botId, url: bot.url, token: bot.config.token });

test('one actual Pi agent executes tools, persists transcripts/artifacts and deduplicates messages', async t => {
  const dir = await fixtureDirectory('summon-core-pi-');
  const model = await modelServer(input => input.messages.at(-1).role === 'tool' ? { content: '完成，已记录状态。' } :
    { content: null, tool_calls: [call('state_set', { scope: 'test', key: 'count', value: 1 }), call('artifact_save', { name: '结果.txt', content: '中文证据' }, 'call-2')] });
  t.after(() => model.close());
  const bot = await startBot(configFor(dir, model.url)); t.after(() => bot.close());
  const ack = await sendMessage(contact(bot), { id: 'stable-id', content: '保存证据', sessionId: 'shared' });
  const result = await waitForTask(contact(bot), ack.taskId);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.result.content, '完成，已记录状态。');
  assert.equal(result.tools.length, 2); assert.equal(result.tools[0].status, 'completed');
  assert.equal(bot.store.getState('test', 'count').value, 1);
  const artifact = result.tools[1].artifacts[0]; assert.equal(await readFile(artifact.path, 'utf8'), '中文证据');
  assert.equal((await requestBot(contact(bot), `/artifacts/${artifact.id}`)).toolRunId, result.tools[1].id);
  assert.ok(bot.store.getSession('shared').messages.some(message => message.role === 'toolResult'));
  assert.equal(model.requests.length, 2);
  const duplicate = await sendMessage(contact(bot), { id: 'stable-id', content: 'different payload', sessionId: 'shared' });
  assert.equal(duplicate.taskId, ack.taskId); assert.equal(duplicate.duplicate, true); assert.equal(model.requests.length, 2);
  assert.ok(!(JSON.stringify(await requestBot(contact(bot), '/health'))).includes(token));
  await assert.rejects(requestBot({ ...contact(bot), token: 'wrong' }, '/health'), { status: 401 });
  assert.equal((await inspectBotIdentity(dir)).bootId, bot.bootId);
  await assert.rejects(startBot(configFor(dir, model.url)), { code: 'INSTANCE_ALREADY_RUNNING' });
});

test('external data lease excludes Bot startup and releases OS ownership even when maintenance fails', async () => {
  const dir = await fixtureDirectory('summon-core-lease-');
  await assert.rejects(withBotDataLease(dir, async () => {
    assert.equal((await inspectBotIdentity(dir)).state, 'maintenance');
    await assert.rejects(startBot(configFor(dir, 'http://127.0.0.1:1/v1')), { code: 'INSTANCE_ALREADY_RUNNING' });
    throw new Error('fixture operation failed');
  }), /fixture operation failed/);
  assert.equal(await inspectBotIdentity(dir), null);
});

test('configured skills are loaded explicitly and both peers communicate with their own authenticated identity', async t => {
  const dir = await fixtureDirectory('summon-core-peer-'), skill = join(dir, 'skill'); await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: evidence\ndescription: Record clear observations\n---\nOBSERVATION_SENTINEL 中文技能');
  const model = await modelServer(() => ({ content: 'peer response' })); t.after(() => model.close());
  const peerToken = 'peer-shared-token-at-least-24';
  const receiver = await startBot(configFor(join(dir, 'b'), model.url, { botId: 'b', peers: [{ botId: 'a', token: peerToken }], skills: [skill] })); t.after(() => receiver.close());
  const ack = await sendMessage({ botId: 'b', url: receiver.url, token: peerToken }, { id: 'peer-id', from: 'a', content: '/skill:evidence observe', sessionId: 'skill' });
  const result = await waitForTask({ url: receiver.url, token: peerToken }, ack.taskId);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.source, 'a');
  assert.match(JSON.stringify(model.requests), /OBSERVATION_SENTINEL/);
  await assert.rejects(sendMessage({ botId: 'b', url: receiver.url, token: peerToken }, { id: 'spoof', from: 'c', content: 'spoof' }), { status: 400 });
  await assert.rejects(requestBot({ url: receiver.url, token: peerToken }, '/memories'), { status: 403 });
  assert.equal((await requestBot(contact(receiver), '/events')).some(event => event.type === 'skill.loaded'), true);
});

test('imported contextKey resumes the original session and current task policy blocks builtin writes', async t => {
  const dir = await fixtureDirectory('summon-core-history-');
  const model = await modelServer(input => input.messages.at(-1).role === 'tool' ? { content: '只读策略阻止了写入。' } :
    { content: null, tool_calls: [call('memory_write', { text: 'MUST_NOT_WRITE' })] }); t.after(() => model.close());
  const bot = await startBot(configFor(dir, model.url)); t.after(() => bot.close());
  const original = [{ role: 'system', content: 'OBSOLETE_BASE_PROMPT', sections: { obsolete: 'OBSOLETE_ROLE' }, timestamp: 1 },
    { role: 'user', content: 'ORIGINAL_HISTORY_SENTINEL', timestamp: 2 },
    { role: 'assistant', content: [{ type: 'text', text: 'Original retained answer' }], api: 'openai-completions', provider: 'fixture', model: 'old-model', stopReason: 'stop', usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } }, timestamp: 3 }];
  bot.store.saveSession({ id: 'original-id', contextKey: 'room:old-room', messages: original, checkpoints: [] });
  const ack = await sendMessage(contact(bot), { id: 'read-only', content: 'continue old context', sessionId: 'room:old-room', metadata: { toolPolicy: { allowedEffects: ['read'] } } });
  const task = await waitForTask(contact(bot), ack.taskId);
  assert.equal(task.status, 'completed', JSON.stringify(task)); assert.equal(task.sessionId, 'original-id');
  assert.equal(task.tools[0].status, 'failed'); assert.equal(task.tools[0].error.code, 'TOOL_POLICY_DENIED');
  assert.equal(bot.store.listMemories().length, 0);
  assert.match(JSON.stringify(model.requests[0].messages), /ORIGINAL_HISTORY_SENTINEL/);
  assert.doesNotMatch(model.requests[0].messages[0].content, /OBSOLETE_/);
  assert.deepEqual(bot.store.getSession('original-id').messages.slice(0, original.length), original);
  assert.equal(bot.store.getSession('room:old-room'), null);
});

async function childBot(configPath) {
  const child = fork(new URL('../bin/summon-bot.mjs', import.meta.url), ['--config', configPath], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', data => stderr += data);
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child readiness timeout: ${stderr}`)), 20000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exit ${code}: ${stderr}`)); });
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } if (message.type === 'error') { clearTimeout(timer); reject(new Error(JSON.stringify(message))); } });
  });
  return { child, contact: { botId: ready.botId, url: ready.url, token }, ready,
    async stop() { if (child.exitCode !== null || child.signalCode !== null) return; const done = once(child, 'exit'); try { await requestBot(this.contact, '/shutdown', { method: 'POST' }); } catch {} await done; } };
}

test('real subprocess crash recovers uncertain task without replay and releases OS identity', async t => {
  const dir = await fixtureDirectory('summon-core-crash-');
  let notify; const entered = new Promise(resolve => notify = resolve);
  const model = await modelServer(async () => { notify(); await new Promise(resolve => setTimeout(resolve, 700)); return { content: 'late result' }; }); t.after(() => model.close());
  const path = join(dir, 'input.json'); await writeFile(path, JSON.stringify(configFor(join(dir, 'data'), model.url)));
  const first = await childBot(path); t.after(() => first.stop());
  assert.notEqual(first.child.pid, process.pid);
  const ack = await sendMessage(first.contact, { id: 'uncertain', content: 'work' }); await entered;
  const death = once(first.child, 'exit'); first.child.kill('SIGKILL'); await death;
  const second = await childBot(path); t.after(() => second.stop());
  assert.notEqual(second.ready.bootId, first.ready.bootId);
  const recovered = await requestBot(second.contact, `/tasks/${ack.taskId}`); assert.equal(recovered.status, 'interrupted');
  const duplicate = await sendMessage(second.contact, { id: 'uncertain', content: 'work' }); assert.equal(duplicate.taskId, ack.taskId); assert.equal(duplicate.duplicate, true);
  assert.equal(model.requests.length, 1); await second.stop(); assert.equal(await inspectBotIdentity(join(dir, 'data')), null);
});
