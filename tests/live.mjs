import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { startGateway } from '@relay/capabilities';
import { BotStore, inspectBotIdentity } from '@relay/bot';

const args = process.argv.slice(2), option = name => { const index = args.indexOf(`--${name}`); return index < 0 ? undefined : args[index + 1]; };
const envFile = option('env-file');
if (!envFile || !isAbsolute(envFile)) throw new Error('Explicit --env-file ABSOLUTE_PATH is required; repository credentials are never discovered');
const supplied = {};
for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!match) continue;
  let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  supplied[match[1]] = value;
}
const apiKey = supplied.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Explicit env file does not configure DEEPSEEK_API_KEY');
process.env.RELAY_LIVE_MODEL_KEY = apiKey;
const releaseRoot = resolve(option('release-root') || join(dirname(fileURLToPath(import.meta.url)), '..'));
const evidenceRoot = resolve(option('evidence-root') || 'D:/Relay-Bot-data/verification/refactor-20261021');
const runId = `live-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const dataRoot = join(evidenceRoot, runId), workspace = join(dataRoot, 'workspace');
await mkdir(workspace, { recursive: true });
const reportPath = join(evidenceRoot, `${runId}.json`), nonce = randomUUID();
const report = { schemaVersion: 1, runId, startedAt: new Date().toISOString(), realModel: true, model: option('model') || 'deepseek-flash',
  baseUrl: 'https://api.deepseek.com/v1', releaseRoot, dataRoot, passed: false, tasks: [], checks: [], cleanup: {} };
const clean = value => JSON.parse(JSON.stringify(value).split(apiKey).join('[redacted]').replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]'));
const save = () => writeFile(reportPath, JSON.stringify(clean(report), null, 2));
const progress = message => process.stdout.write(`${JSON.stringify({ live: runId, message })}\n`);
let gateway;
const listStore = async (botId, fn) => { const db = new BotStore(join(dataRoot, 'bots', botId, 'state.sqlite'), { readOnly: true }); try { return fn(db); } finally { db.close(); } };
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
async function execute(botId, content, sessionId, expectedTools = []) {
  const id = `live:${randomUUID()}`;
  const receipt = await gateway.manager.send(botId, { id, kind: 'request', content, sessionId });
  const deadline = Date.now() + 240000;
  let task;
  while (Date.now() < deadline) { task = await gateway.manager.request(botId, `/tasks/${receipt.taskId}`); if (terminal.has(task.status)) break; await new Promise(resolve => setTimeout(resolve, 250)); }
  report.tasks.push({ botId, id: task.id, sessionId: task.sessionId, status: task.status, result: task.result, error: task.error,
    tools: task.tools.map(tool => ({ id: tool.id, name: tool.name, status: tool.status, artifacts: tool.artifacts || [], error: tool.error })) });
  await save();
  assert.equal(task.status, 'completed', `${botId}: ${JSON.stringify(task.error || task.status)}`);
  for (const name of expectedTools) assert.ok(task.tools.some(tool => tool.name === name && tool.status === 'completed'), `${botId} did not actually complete ${name}`);
  assert.ok(task.result.usage.total_tokens > 0, `${botId} has no real provider usage`);
  progress(`${botId} completed ${task.id}: ${task.tools.length} audited tools`);
  return task;
}
async function external(name, argumentsValue) {
  const response = await fetch(`${gateway.url}/tools/${name}`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ arguments: argumentsValue }), signal: AbortSignal.timeout(120000) });
  const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
}
try {
  gateway = await startGateway({ dataRoot, releaseRoot, defaultCwd: workspace, seed: false, restore: false,
    model: { provider: 'deepseek', model: report.model, baseUrl: report.baseUrl, apiKeyEnv: 'RELAY_LIVE_MODEL_KEY', contextWindow: 128000, maxTokens: 3000 } });
  const entry = await gateway.manager.create({ id: 'live-entry', roleId: 'entry', name: '真实入口验收' });
  const host = await gateway.manager.create({ id: 'live-chatroom', roleId: 'chatroom', name: '真实聊天室验收' });
  const room = await gateway.chatroom.createRoom({ id: 'live-discussion', name: '隔离真实验收', kind: 'deep', members: ['user', entry.id, host.id], goal: '验证两个角色独立调用工具' });
  await execute(entry.id, `这是明确授权的隔离真实验收。请实际调用 bots_list 查看同伴，再调用 memory_write 写入 id="baseline-memory"，text="继承基准 ${nonce}"。仅完成这两项，最后简短报告。`, 'entry-live', ['bots_list', 'memory_write']);
  await execute(host.id, `这是明确授权的隔离真实验收。请实际调用 chatroom_read，roomId="${room.id}"，核对成员后调用 chatroom_conclude 保存 summary="实际读取成员后形成结论 ${nonce}"。不要发送消息或创建新工作。`, 'chatroom-live', ['chatroom_read', 'chatroom_conclude']);
  const firstIdentities = await Promise.all([gateway.manager.identity(entry.id), gateway.manager.identity(host.id)]);
  assert.ok(firstIdentities.every(value => value.pid !== process.pid)); assert.notEqual(firstIdentities[0].pid, firstIdentities[1].pid);
  report.identities = firstIdentities;
  for (const botId of [entry.id, host.id]) { const health = await gateway.manager.request(botId, '/health'); assert.equal(health.engine.engine, 'pi-agent-core'); assert.equal(health.engine.provider.connected, true); assert.ok(health.engine.provider.calls >= 2); }
  assert.equal(gateway.chatroom.need('rooms', room.id).status, 'concluded');
  report.checks.push('entry and chatroom each used their independent Pi process, real provider and configured HTTP tools');

  await gateway.manager.stop(entry.id); assert.equal(await gateway.manager.identity(entry.id), null);
  const originalMessages = await listStore(entry.id, db => db.getSession('entry-live').messages);
  const derivation = await external('bots_clone', { parentId: entry.id, childId: 'live-child', requestId: `clone:${nonce}`, name: '隔离分身验收', start: false });
  const childId = derivation.childId;
  await listStore(childId, db => { assert.deepEqual(db.getSession('entry-live').messages, originalMessages); assert.equal(db.listTasks().length, 0); assert.equal(db.listOutbox().length, 0); assert.match(db.getMemory('baseline-memory').text, new RegExp(nonce)); });
  const parentConfig = await gateway.manager.config(entry.id), childConfig = await gateway.manager.config(childId);
  assert.notEqual(parentConfig.token, childConfig.token); assert.notEqual(parentConfig.dataDir, childConfig.dataDir);
  const childTask = await execute(childId,
    `现在你是独立分身，明确授权只操作自己的隔离数据。先调用 memory_list 核对继承的 baseline-memory，然后实际调用 memory_write 新建 id="derived-memory"，text="已核验隔离分身经验 ${nonce}"；再调用 artifact_save 写 name="成果.txt"，content="真实分身成果 ${nonce}"。不要改 baseline-memory，不联系其他Bot，不运行命令。最后简短报告实际结果。`,
    'entry-live', ['memory_list', 'memory_write', 'artifact_save']);
  assert.equal(await gateway.manager.identity(entry.id), null);
  assert.equal(await listStore(entry.id, db => db.getMemory('derived-memory')), null);
  const savedArtifact = childTask.tools.flatMap(tool => tool.artifacts || []).find(value => value.name === '成果.txt');
  assert.ok(savedArtifact); assert.equal(await readFile(savedArtifact.path, 'utf8'), `真实分身成果 ${nonce}`);
  report.checks.push('external clone inherited original context and memory, but no task/outbox/secret/runtime identity; child executed independently while parent stayed offline');

  const delivery = await external('bots_deliver', { childId, requestId: `delivery:${nonce}`, result: childTask.result.content });
  assert.equal(delivery.parentId, entry.id); assert.ok(delivery.memories.some(memory => memory.id === 'derived-memory'));
  const deliveredNames = await readdir(delivery.artifactDirectory); assert.ok(deliveredNames.length > 0);
  const deliveredPath = join(delivery.artifactDirectory, savedArtifact.path.split(/[\\/]/).at(-1));
  assert.equal(createHash('sha256').update(await readFile(deliveredPath)).digest('hex'), savedArtifact.sha256);
  await gateway.manager.archive(childId); assert.equal(await gateway.manager.identity(childId), null);
  assert.equal(await readFile(savedArtifact.path, 'utf8'), `真实分身成果 ${nonce}`);
  report.delivery = { id: delivery.id, parentId: delivery.parentId, childId, artifactDirectory: delivery.artifactDirectory, artifactSha256: savedArtifact.sha256, parentOffline: true, childArchived: true };
  report.checks.push('offline parent delivery persisted separately, child archived, original and delivered artifacts retained');

  const memoryBot = await gateway.manager.create({ id: 'live-memory', roleId: 'memory', name: '真实记忆合并验收' });
  await execute(memoryBot.id,
    `这是明确授权的记忆合并验收。请调用 memory_propose，deliveryId=${JSON.stringify(delivery.id)}，核对只包含隔离分身新增的经验。若状态 ready，调用 memory_merge 使用同一deliveryId和空resolutions；若发现conflict则报告并停止。不要直接改写其他记忆。最后报告工具实际状态。`,
    'merge-live', ['memory_propose', 'memory_merge']);
  assert.equal(gateway.memories.store.get('proposals', delivery.id).status, 'merged');
  assert.equal((await listStore(entry.id, db => db.getMemory('derived-memory'))).text, `已核验隔离分身经验 ${nonce}`);
  assert.equal((await listStore(entry.id, db => db.getMemory('baseline-memory'))).text, `继承基准 ${nonce}`);
  report.checks.push('independent memory role used real model to inspect and merge delivery into offline parent through normal memory APIs');
  report.passed = true; report.finishedAt = new Date().toISOString();
} catch (error) {
  report.error = clean({ name: error.name, message: error.message, stack: error.stack }); progress(`FAILED: ${report.error.message}`); process.exitCode = 1;
} finally {
  if (gateway) {
    try { await gateway.stopBots(); report.cleanup.botsStopped = true; } catch (error) { report.cleanup.error = clean(error.message); report.passed = false; process.exitCode = 1; }
    try { report.cleanup.liveIdentities = (await Promise.all(gateway.manager.list().map(async bot => ({ botId: bot.id, identity: await inspectBotIdentity(join(dataRoot, 'bots', bot.id)) })))).filter(item => item.identity); assert.equal(report.cleanup.liveIdentities.length, 0); }
    catch (error) { report.cleanup.identityError = clean(error.message); report.passed = false; process.exitCode = 1; }
    await gateway.close(); report.cleanup.gatewayClosed = true;
  }
  report.finishedAt ||= new Date().toISOString(); await save(); delete process.env.RELAY_LIVE_MODEL_KEY;
  process.stdout.write(`${JSON.stringify({ passed: report.passed, reportPath, dataRoot, completedRealTasks: report.tasks.filter(task => task.status === 'completed').length })}\n`);
}
