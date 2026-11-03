// Offline model-protocol fixture for testing an installed tarball, not a real-model acceptance.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { inspectBotIdentity, requestBot, sendMessage, waitForTask } from '@summon/bot';

const root = await mkdtemp(join(tmpdir(), 'summon-bot-installed-'));
const installedEntry = fileURLToPath(import.meta.resolve('@summon/bot'));
const cli = join(dirname(installedEntry), '..', 'bin', 'summon-bot.mjs');
const management = 'installed-management-token-24chars', peer = 'installed-peer-token-more-than-24';
const children = [];
let modelCalls = 0;
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const data of req) raw += data; const input = JSON.parse(raw); modelCalls++;
  const invoke = input.model === 'sender-model' && input.messages.at(-1).role === 'user';
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: input.model, choices: [{ finish_reason: invoke ? 'tool_calls' : 'stop',
    message: invoke ? { role: 'assistant', content: null, tool_calls: [{ id: 'direct-call', type: 'function', function: { name: 'messages_send', arguments: JSON.stringify({ to: 'receiver', id: 'direct-message', content: 'peer payload', sessionId: 'direct' }) } }] }
      : { role: 'assistant', content: 'FIXTURE_CONFIRMED' } }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }));
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${model.address().port}/v1`;
async function launch(botId, extra = {}) {
  const dataDir = join(root, botId); await mkdir(dataDir);
  const configPath = join(dataDir, 'input.json');
  await writeFile(configPath, JSON.stringify({ botId, dataDir, token: management, model: { provider: 'openai-compatible', model: `${botId}-model`, baseUrl, apiKey: 'fixture-model-key' }, ...extra }));
  const child = spawn(process.execPath, [cli, '--config', configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const item = { child, dataDir }; children.push(item); let log = '';
  child.stdout.on('data', data => log += data); child.stderr.on('data', data => log += data);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(log);
    const identity = await inspectBotIdentity(dataDir);
    if (identity?.url) {
      const contact = { botId, url: identity.url, token: management };
      const health = await requestBot(contact, '/health');
      if (health.state === 'ready' && health.bootId === identity.bootId) { Object.assign(item, { contact, health }); return item; }
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Installed CLI readiness timeout: ${log}`);
}
async function stop(item) {
  if (item.child.exitCode !== null || item.child.signalCode !== null) return;
  const exited = once(item.child, 'exit');
  if (item.contact) await requestBot(item.contact, '/shutdown', { method: 'POST' }); else item.child.kill();
  await exited;
}
try {
  const receiver = await launch('receiver', { peers: [{ botId: 'sender', token: peer }] });
  const sender = await launch('sender', { contacts: [{ botId: 'receiver', url: receiver.contact.url, token: peer }] });
  assert.notEqual(sender.health.pid, receiver.health.pid); assert.notEqual(sender.health.pid, process.pid);
  const receipt = await sendMessage(sender.contact, { id: 'installed-task', content: 'Ask receiver directly' });
  const result = await waitForTask(sender.contact, receipt.taskId);
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tools[0].status, 'completed');
  const peerTask = await waitForTask(receiver.contact, result.tools[0].output.details.taskId);
  assert.equal(peerTask.source, 'sender'); assert.equal(peerTask.status, 'completed');
  await stop(sender);
  const after = await sendMessage(receiver.contact, { id: 'independent', content: 'Still available' });
  assert.equal((await waitForTask(receiver.contact, after.taskId)).status, 'completed');
  console.log(JSON.stringify({ passed: true, installedEntry, root, independentPids: [sender.health.pid, receiver.health.pid], modelFixtureCalls: modelCalls, directPeerTask: peerTask.id }));
} finally {
  await Promise.allSettled(children.map(stop)); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
}
