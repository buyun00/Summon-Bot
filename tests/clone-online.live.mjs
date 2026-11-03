/** F02: real models and independent Pi processes; the blocking HTTP tool is an explicit fixture. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGateway } from '@summon/capabilities';
import { BotStore, inspectBotIdentity } from '@summon/bot';

const option = name => { const at = process.argv.indexOf(`--${name}`); return at < 0 ? undefined : process.argv[at + 1]; };
const envFile = option('env-file');
if (!envFile || !isAbsolute(envFile)) throw new Error('Explicit --env-file ABSOLUTE_PATH is required');
const supplied = {};
for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!match) continue;
  let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  supplied[match[1]] = value;
}
const apiKey = supplied.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('Explicit env file does not configure DEEPSEEK_API_KEY');
const previousModelKey = process.env.SUMMON_CLONE_ONLINE_MODEL_KEY;
process.env.SUMMON_CLONE_ONLINE_MODEL_KEY = apiKey;
const releaseRoot = resolve(option('release-root') || join(dirname(fileURLToPath(import.meta.url)), '..'));
const evidenceRoot = resolve(option('evidence-root') || 'D:/Relay-Bot-data/verification/refactor-20261021');
const runId = `clone-online-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
const dataRoot = join(evidenceRoot, runId), reportPath = join(evidenceRoot, `${runId}.json`), nonce = randomUUID();
await mkdir(dataRoot, { recursive: true });
const gateToken = randomBytes(32).toString('hex'), at = () => new Date().toISOString();
const report = { schemaVersion: 1, requirement: 'F02', runId, startedAt: at(), releaseRoot, dataRoot,
  realModel: true, model: option('model') || 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
  toolFixture: { name: 'verification_gate', transport: 'HTTP loopback', controlledBy: 'test controller', timeoutMs: 90000, calls: 0 },
  tasks: [], checks: [], cleanup: {}, passed: false };
const clean = value => JSON.parse(JSON.stringify(value).split(apiKey).join('[redacted]').split(gateToken).join('[redacted]').replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]'));
const save = () => writeFile(reportPath, JSON.stringify(clean(report), null, 2) + '\n');
const progress = message => process.stdout.write(JSON.stringify({ runId, message }) + '\n');
const pause = ms => new Promise(done => setTimeout(done, ms));
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
let gateway, releaseGate, gateEntered;
const entered = new Promise(done => { gateEntered = done; }), released = new Promise(done => { releaseGate = done; });
const gate = createServer(async (request, response) => {
  try {
    response.setHeader('content-type', 'application/json');
    if (request.method !== 'POST' || request.url !== '/gate' || request.headers.authorization !== `Bearer ${gateToken}`) { response.statusCode = 401; response.end('{}'); return; }
    let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 16384) throw new Error('Fixture input is too large'); }
    assert.equal(JSON.parse(raw).arguments.gateId, nonce);
    assert.equal(++report.toolFixture.calls, 1, 'the blocking fixture must not be replayed');
    report.toolFixture.enteredAt = at(); gateEntered();
    let timer;
    const allowed = await Promise.race([released, new Promise(done => { timer = setTimeout(() => done(false), 90000); })]); clearTimeout(timer);
    report.toolFixture.respondedAt = at(); report.toolFixture.releasedNormally = allowed === true;
    if (!allowed) response.statusCode = 504;
    if (!response.destroyed) response.end(JSON.stringify({ fixture: true, released: allowed === true, gateId: nonce }));
  } catch (error) { response.statusCode = 500; if (!response.destroyed) response.end(JSON.stringify({ error: clean(error.message), fixture: true })); }
});
async function snapshot(botId, taskId) { return gateway.manager.request(botId, `/tasks/${taskId}`); }
async function completed(botId, taskId, expectedTools) {
  const deadline = Date.now() + 180000; let task;
  do { task = await snapshot(botId, taskId); if (terminal.has(task.status)) break; await pause(150); } while (Date.now() < deadline);
  report.tasks.push({ botId, id: task.id, sessionId: task.sessionId, status: task.status, startedAt: task.startedAt, finishedAt: task.finishedAt,
    usage: task.result?.usage, error: task.error, tools: task.tools.map(tool => ({ id: tool.id, name: tool.name, status: tool.status, startedAt: tool.startedAt, finishedAt: tool.finishedAt })) });
  await save(); assert.equal(task.status, 'completed', JSON.stringify(task.error || task.status));
  assert.ok(task.result.usage.total_tokens > 0, 'actual provider usage is required');
  for (const name of expectedTools) assert.ok(task.tools.some(tool => tool.name === name && tool.status === 'completed'), `Missing completed tool ${name}`);
  return task;
}
async function externalClone(input) {
  const response = await fetch(`${gateway.url}/tools/bots_clone`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ arguments: input }), signal: AbortSignal.timeout(20000) });
  const value = await response.json(); assert.equal(response.ok, true, JSON.stringify(value)); return value;
}
try {
  await new Promise((done, reject) => { gate.once('error', reject); gate.listen(0, '127.0.0.1', done); });
  gateway = await startGateway({ dataRoot, releaseRoot, defaultCwd: join(dataRoot, 'workspace'), seed: false, restore: false,
    model: { provider: 'deepseek', model: report.model, baseUrl: report.baseUrl, apiKeyEnv: 'SUMMON_CLONE_ONLINE_MODEL_KEY', contextWindow: 128000, maxTokens: 2500 } });
  const parentId = 'online-parent', childId = 'online-child';
  await gateway.manager.create({ id: parentId, roleId: 'engineer', name: '在线母体验收', prompt: '你是隔离验收中的工程 Bot。用户已授权以下精确操作。必须实际调用指定工具，按实际结果回复。不要联系同伴或创建其他任务。' });
  const baselineText = `继承基准 ${nonce}`;
  const seed = await gateway.manager.send(parentId, { id: `seed:${nonce}`, kind: 'request', sessionId: 'inherited-context',
    content: `请实际调用 memory_write 一次，id="baseline-memory"，text=${JSON.stringify(baselineText)}。最后简短确认，勿执行其他操作。` });
  await completed(parentId, seed.taskId, ['memory_write']);
  const parentBefore = await gateway.manager.identity(parentId);
  assert.equal(parentBefore.state, 'ready'); assert.notEqual(parentBefore.pid, process.pid);
  const derivation = await externalClone({ parentId, childId, requestId: `clone:${nonce}`, name: '在线母体的分身', start: false });
  assert.equal(derivation.childId, childId);
  const parentAfterClone = await gateway.manager.identity(parentId);
  assert.equal(parentAfterClone.bootId, parentBefore.bootId, 'external clone must not stop or restart the online parent');
  const parentConfig = await gateway.manager.config(parentId), childConfig = await gateway.manager.config(childId);
  assert.notEqual(parentConfig.token, childConfig.token); assert.notEqual(parentConfig.dataDir, childConfig.dataDir);
  const copied = new BotStore(join(childConfig.dataDir, 'state.sqlite'), { readOnly: true });
  try {
    assert.equal(copied.getMemory('baseline-memory').text, baselineText);
    assert.ok(copied.getSession('inherited-context').messages.length > 0);
    assert.equal(copied.listTasks().length, 0); assert.equal(copied.listOutbox().length, 0);
  } finally { copied.close(); }
  childConfig.tools.push({ type: 'http', name: 'verification_gate', description: 'Explicit test fixture. Wait until the independent online parent completes its event. Call once, then wait for released=true.',
    effect: 'read', url: `http://127.0.0.1:${gate.address().port}/gate`, headers: { Authorization: `Bearer ${gateToken}` }, timeoutMs: 95000,
    inputSchema: { type: 'object', properties: { gateId: { type: 'string' } }, required: ['gateId'], additionalProperties: false } });
  await writeFile(join(childConfig.dataDir, 'config.json'), JSON.stringify(childConfig, null, 2), { mode: 0o600 });
  const childReceipt = await gateway.manager.send(childId, { id: `child:${nonce}`, kind: 'request', sessionId: 'inherited-context',
    content: `这是明确授权的隔离并发验收。第一步仅调用 verification_gate，gateId=${JSON.stringify(nonce)}；必须等待工具返回 released=true，返回前不得调用其他工具。第二步才调用 memory_write，id="child-only"，text="子体隔离结果 ${nonce}"。不要改baseline-memory，不联系其他Bot，最后简短确认。` });
  let enterTimer;
  try { await Promise.race([entered, new Promise((_, reject) => { enterTimer = setTimeout(() => reject(new Error('Real child model did not enter the gate tool')), 90000); })]); }
  finally { clearTimeout(enterTimer); }
  const childDuring = await snapshot(childId, childReceipt.taskId), childIdentity = await gateway.manager.identity(childId);
  assert.equal(childDuring.status, 'running'); assert.ok(childDuring.tools.some(tool => tool.name === 'verification_gate' && tool.status === 'running'));
  assert.notEqual(childIdentity.pid, parentBefore.pid); assert.notEqual(childIdentity.pid, process.pid);
  report.identities = { parentBefore, parentAfterClone, child: childIdentity };
  report.childBlockedObservedAt = at(); report.checks.push('online clone preserves parent boot and inherits context/memory without tasks, outbox or shared token');
  progress('Child real Pi is waiting in the explicit HTTP gate; deliver an independent event to the still-online parent');
  const parentEvent = await gateway.manager.send(parentId, { id: `event:${nonce}`, kind: 'event', sessionId: 'online-event',
    content: `这是分身等待期间送达母体的新事件。请实际调用 memory_write，id="parent-online-event"，text="母体并发处理完成 ${nonce}"。不要访问子体或修改baseline-memory。完成工具后简短确认。` });
  report.parentEventAcceptedAt = at();
  const parentTask = await completed(parentId, parentEvent.taskId, ['memory_write']);
  const parentHealth = await gateway.manager.request(parentId, '/health'), stillBlocked = await snapshot(childId, childReceipt.taskId);
  assert.equal(parentHealth.bootId, parentBefore.bootId); assert.equal(parentHealth.state, 'ready');
  assert.equal(stillBlocked.status, 'running'); assert.ok(stillBlocked.tools.some(tool => tool.name === 'verification_gate' && tool.status === 'running'));
  const parentMemories = await gateway.manager.request(parentId, '/memories');
  assert.equal(parentMemories.find(memory => memory.id === 'parent-online-event').text, `母体并发处理完成 ${nonce}`);
  report.parentEventCompletedWhileChildBlocked = { taskId: parentTask.id, checkedAt: at(), parentBootId: parentHealth.bootId, childTaskId: childReceipt.taskId };
  report.checks.push('parent accepted a new event and completed its real Pi memory_write while child task/tool remained running');
  report.toolFixture.releasedAt = at(); releaseGate(true);
  const childTask = await completed(childId, childReceipt.taskId, ['verification_gate', 'memory_write']);
  const [parentFinal, childFinal] = await Promise.all([gateway.manager.request(parentId, '/memories'), gateway.manager.request(childId, '/memories')]);
  assert.equal(parentFinal.some(memory => memory.id === 'child-only'), false);
  assert.equal(childFinal.some(memory => memory.id === 'parent-online-event'), false);
  assert.equal(childFinal.find(memory => memory.id === 'child-only').text, `子体隔离结果 ${nonce}`);
  for (const memories of [parentFinal, childFinal]) assert.equal(memories.find(memory => memory.id === 'baseline-memory').text, baselineText);
  assert.ok(Date.parse(parentTask.finishedAt) <= Date.parse(report.toolFixture.releasedAt));
  assert.ok(Date.parse(childTask.finishedAt) >= Date.parse(report.toolFixture.releasedAt));
  const [parentEnd, childEnd] = await Promise.all([gateway.manager.request(parentId, '/health'), gateway.manager.request(childId, '/health')]);
  for (const health of [parentEnd, childEnd]) { assert.equal(health.engine.engine, 'pi-agent-core'); assert.equal(health.engine.provider.connected, true); }
  report.providers = { parent: parentEnd.engine.provider, child: childEnd.engine.provider };
  report.checks.push('separate process identities and persistent memory isolation remain intact; no parent/child overwrite or restart');
  report.passed = true;
} catch (error) {
  report.error = clean({ name: error.name, message: error.message, stack: error.stack }); process.exitCode = 1; progress(`FAILED: ${report.error.message}`);
} finally {
  releaseGate(false);
  if (gateway) {
    try { await gateway.stopBots(); report.cleanup.botsStopped = true; }
    catch (error) { report.cleanup.shutdownError = clean(error.message); report.passed = false; process.exitCode = 1; }
    try {
      report.cleanup.liveIdentities = (await Promise.all(gateway.manager.list().map(async bot => ({ botId: bot.id, identity: await inspectBotIdentity(join(dataRoot, 'bots', bot.id)) })))).filter(item => item.identity);
      assert.equal(report.cleanup.liveIdentities.length, 0);
    } catch (error) { report.cleanup.identityError = clean(error.message); report.passed = false; process.exitCode = 1; }
    try { await gateway.close(); report.cleanup.gatewayClosed = true; }
    catch (error) { report.cleanup.gatewayError = clean(error.message); report.passed = false; process.exitCode = 1; }
  }
  gate.closeAllConnections(); if (gate.listening) await new Promise(done => gate.close(done)); report.cleanup.fixtureClosed = true;
  if (previousModelKey === undefined) delete process.env.SUMMON_CLONE_ONLINE_MODEL_KEY; else process.env.SUMMON_CLONE_ONLINE_MODEL_KEY = previousModelKey;
  report.finishedAt = at(); await save();
  process.stdout.write(JSON.stringify({ passed: report.passed, reportPath, dataRoot, realTasks: report.tasks.filter(task => task.status === 'completed').length }) + '\n');
}
