import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { startServer } from '../src/server.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 600; i++) { if (fn()) return; await pause(20); } throw new Error('Timed out waiting for agent'); }
const textReply = reply => [{ type: 'text', text: JSON.stringify({ reply, actions: [] }) }];
const tool = (id, name, args) => ({ type: 'toolCall', id, name, arguments: args });
const observations = context => context.messages.filter(message => message.role === 'toolResult');
// Explicit model test double; the real pi core, HTTP server, file tools and SQLite run unchanged.
function providerFor(handler) {
  return { status: {}, complete: async () => ({ content: '{"reply":"summary double","actions":[]}' }),
    stream(model, context) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        let content;
        try { content = handler(context); } catch (error) {
          const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: {}, stopReason: 'error', errorMessage: error.message, timestamp: Date.now() };
          stream.push({ type: 'error', reason: 'error', error: message }); stream.end(message); return;
        }
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: content.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message);
      });
      return stream;
    },
  };
}
async function fixture(t, handler, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'relay-pi-test-'));
  const project = join(root, 'project'); await mkdir(project);
  const data = join(root, 'state');
  const works = [];
  const executor = { start() {}, stop() {}, list: () => works, get: id => works.find(work => work.id === id),
    create(input) { const result = { ...input, id: `work-${works.length}`, status: 'queued' }; works.push(result); return result; } };
  const config = { dataDir: data, database: join(data, 'relay.sqlite'), defaultCwd: project, port: 0, apiKey: 'test-secret', ...overrides };
  const provider = providerFor(handler);
  const app = await startServer({ config, provider, executor });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const room = botId => app.social.createRoom({ kind: 'dm', members: ['user', botId] });
  const send = (roomId, content) => app.social.postMessage(roomId, { content });
  return { app, root, project, config, provider, executor, works, room, send };
}

test('pi loop feeds real file results back to any Bot and retains memory/Codex actions', async t => {
  let project;
  const f = await fixture(t, context => {
    const results = observations(context);
    switch (results.length) {
      case 0: return [tool('read', 'read_file', { path: join(project, 'source.txt') })];
      case 1:
        assert.match(JSON.stringify(results.at(-1)), /真实中文内容/);
        return [tool('write', 'write_file', { path: 'report.md', content: '真实中文内容\nverified' })];
      case 2: return [tool('readback', 'read_file', { path: 'report.md' })];
      case 3: return [tool('memory', 'relay_action', { action: { type: 'memory', content: '文件已读回', category: 'professional' } })];
      case 4: return [tool('work', 'relay_action', { action: { type: 'work', goal: '复杂后续工作', cwd: project } })];
      default: return textReply('已保存 report.md 并读回；复杂后续已委托。');
    }
  });
  project = f.project; await writeFile(join(project, 'source.txt'), '真实中文内容');
  const bot = f.app.social.createBot({ name: '新文件伙伴' });
  const room = f.room(bot.id); f.send(room.id, '生成报告并记住结果，复杂后续委托 Codex');
  await until(() => f.app.agentRuntime.list().some(run => run.status === 'completed'));
  const run = f.app.agentRuntime.list()[0];
  assert.equal(await readFile(join(run.workspace, 'report.md'), 'utf8'), '真实中文内容\nverified');
  assert.equal(run.botId, bot.id); assert.equal(run.toolCount, 5); assert.equal(run.turns, 6);
  assert.equal(f.app.store.list('memories')[0].botId, bot.id);
  assert.equal(f.works[0].botId, bot.id);
  const detail = await (await fetch(`${f.app.url}/api/agent-runs/${run.id}`)).json();
  assert.equal(detail.tools.length, 5); assert.ok(detail.tools.every(tool => tool.status === 'completed'));
  assert.equal(detail.messages, undefined);
  await until(() => f.app.social.roomMessages(room.id).some(message => message.senderId === bot.id));
});

test('failed tools are observed, recorded and can be corrected without fabricated success', async t => {
  const f = await fixture(t, context => observations(context).length === 0
    ? [tool('denied', 'read_file', { path: '../other-bot/secret.txt' })]
    : textReply(observations(context)[0].isError ? '访问被拒，未读取文件。' : 'unexpected'));
  const room = f.room('bot-qa'); f.send(room.id, '读取越界路径');
  await until(() => f.app.agentRuntime.list().some(run => run.status === 'completed'));
  const detail = f.app.agentRuntime.get(f.app.agentRuntime.list()[0].id);
  assert.equal(detail.tools[0].status, 'failed'); assert.match(detail.summary, /访问被拒/);
});

test('tool loops stop at budget and do not report an unfinished operation as completed', async t => {
  const f = await fixture(t, context => [tool(`list-${observations(context).length}`, 'list_files', {})], { agentMaxTurns: 2 });
  const room = f.room('bot-components'); f.send(room.id, '执行循环');
  await until(() => f.app.agentRuntime.list().some(run => run.status === 'failed'));
  const run = f.app.agentRuntime.list()[0];
  assert.equal(run.turns, 2); assert.equal(run.toolCount, 2); assert.match(run.error, /预算/);
});

test('reused call IDs across turns preserve distinct actions and tool records', async t => {
  const f = await fixture(t, context => {
    const index = observations(context).length;
    return index < 2 ? [tool('reused', 'relay_action', { action: { type: 'memory', content: `memory ${index}` } })] : textReply('saved both');
  });
  const room = f.room('bot-components'); f.send(room.id, '保存两条记忆');
  await until(() => f.app.agentRuntime.list().some(run => run.status === 'completed'));
  assert.equal(f.app.store.list('memories').length, 2);
  assert.equal(f.app.agentRuntime.get(f.app.agentRuntime.list()[0].id).tools.length, 2);
});

test('invalid final structured replies fail the run before completion is recorded', async t => {
  const f = await fixture(t, () => [{ type: 'text', text: '{"reply":{},"actions":{}}' }]);
  const room = f.room('bot-qa'); f.send(room.id, 'invalid final');
  await until(() => f.app.agentRuntime.list().some(run => run.status === 'failed'));
  assert.match(f.app.agentRuntime.list()[0].error, /格式错误/);
});

test('a legacy action in final text is corrected into a real tool call once', async t => {
  const f = await fixture(t, context => {
    if (observations(context).length) return textReply('saved');
    if (context.messages.filter(message => message.role === 'user').length > 1) return [tool('actual-memory', 'relay_action', { action: { type: 'memory', content: 'once' } })];
    return [{ type: 'text', text: '{"reply":"planned","actions":[{"type":"memory","content":"once"}]}' }];
  });
  const room = f.room('bot-qa'); f.send(room.id, '保存一次');
  await until(() => f.app.agentRuntime.list().some(run => run.status === 'completed'));
  assert.equal(f.app.store.list('memories').length, 1);
  assert.equal(f.app.agentRuntime.list()[0].toolCount, 1);
  assert.equal(f.app.agentRuntime.list()[0].turns, 3);
});

test('long commands release chat slots; HTTP cancel settles execution and preserves records on restart', async t => {
  const f = await fixture(t, context => {
    const raw = context.messages.find(message => message.role === 'user').content;
    const input = JSON.parse(typeof raw === 'string' ? raw : raw.map(part => part.text).join(''));
    if (input.trigger.content === 'ping') return textReply('pong');
    return observations(context).length ? textReply('command finished') : [tool('sleep', 'run_command', {
      command: process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30', timeoutMs: 40000,
    })];
  });
  for (const bot of ['bot-engineer', 'bot-components', 'bot-qa']) f.send(f.room(bot).id, 'wait');
  await until(() => f.app.agentRuntime.list().length === 3 && f.app.store.list('toolRuns').length === 3);
  const bot = f.app.social.createBot({ name: '聊天检查' });
  const chat = f.room(bot.id); f.send(chat.id, 'ping');
  await until(() => f.app.social.roomMessages(chat.id).some(message => message.content === 'pong'));
  const runs = f.app.agentRuntime.list().filter(run => run.status === 'running');
  await Promise.all(runs.map(async run => {
    const response = await fetch(`${f.app.url}/api/agent-runs/${run.id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200); assert.equal((await response.json()).status, 'cancelled');
  }));
  f.app.store.save('agentRuns', { id: 'unconfirmed-run', status: 'running', botId: bot.id, roomId: chat.id, messages: [] });
  f.app.store.save('toolRuns', { id: 'unconfirmed-tool', runId: 'unconfirmed-run', status: 'running', name: 'write_file' });
  await f.app.close();
  const restarted = await startServer({ config: f.config, provider: f.provider, executor: f.executor });
  try {
    assert.equal(restarted.agentRuntime.get('unconfirmed-run').status, 'interrupted');
    assert.equal(restarted.agentRuntime.get('unconfirmed-run').tools[0].status, 'interrupted');
    assert.equal(restarted.agentRuntime.active.size, 0);
    assert.ok(restarted.social.roomMessages(chat.id).some(message => message.content === 'pong'));
  } finally { await restarted.close(); }
});
