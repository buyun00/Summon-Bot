/** Real DeepSeek/Pi acceptance; version_probe and its file gate are explicit fixtures. */
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir, mkdtemp, rm, realpath, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const option = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const envFile = option('env-file');
if (!envFile || !isAbsolute(envFile)) throw new Error('Explicit --env-file ABSOLUTE_PATH is required');
const evidenceRoot = resolve(option('evidence-root') || 'D:/Relay-Bot-data/verification/capability-services-20261021');
const releaseRoot = resolve(option('release-root') || join(import.meta.dirname, '..'));
await mkdir(evidenceRoot, { recursive: true });
const fixtureRoot = await mkdtemp(join(evidenceRoot, `hot-upgrade-live-${new Date().toISOString().replace(/[:.]/g, '-')}-`));
const runId = basename(fixtureRoot), reportPath = join(evidenceRoot, `${runId}.json`), logPath = join(evidenceRoot, `${runId}.events.jsonl`);
const dataRoot = join(fixtureRoot, 'data'), workspace = join(fixtureRoot, 'workspace'), gatePath = join(fixtureRoot, 'release-v1.json');
const callLog = join(fixtureRoot, 'fixture-calls.jsonl'), nonce = randomUUID(), at = () => new Date().toISOString();
const report = { schemaVersion: 1, runId, startedAt: at(), releaseRoot, dataRoot, fixtureRoot,
  realModel: true, gateExplicitFixture: true, fixtureCapability: 'version-probe', fixtureBusinessLogic: true,
  model: option('model') || 'deepseek-flash', maxTokens: 1500, realTaskBudget: 3,
  checks: [], tasks: [], services: [], cleanup: {}, passed: false };
const previousKey = process.env.SUMMON_HOT_UPGRADE_LIVE_KEY;
let apiKey = '', gateway, supervisor, botApi, submitted = 0;
const credentials = new Set();
const clean = value => {
  let text = JSON.stringify(value);
  for (const secret of credentials) if (secret) text = text.split(secret).join('[redacted]');
  return JSON.parse(text.replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[redacted]'));
};
const save = () => writeFile(reportPath, JSON.stringify(clean(report), null, 2) + '\n');
const progress = async message => { const entry = clean({ runId, at: at(), message }); process.stdout.write(JSON.stringify(entry) + '\n'); await appendFile(logPath, JSON.stringify(entry) + '\n'); };
const check = (name, evidence = {}) => report.checks.push({ name, passed: true, checkedAt: at(), ...evidence });
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function until(checkValue, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await checkValue(); if (value) return value; await delay(150); }
  throw new Error(message);
}
async function api(operation, body, expectedStatus = 200) {
  const response = await fetch(`${gateway.url}/api/capabilities/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${gateway.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const result = await response.json(); assert.equal(response.status, expectedStatus, JSON.stringify(clean(result))); return result;
}
function taskEvidence(botId, task) {
  return { botId, id: task.id, sessionId: task.sessionId, status: task.status, createdAt: task.createdAt, startedAt: task.startedAt,
    finishedAt: task.finishedAt, result: task.result, error: task.error, tools: task.tools || [] };
}
async function submit(botId, label) {
  assert.ok(++submitted <= report.realTaskBudget, 'Live acceptance must not exceed three real model tasks');
  const receipt = await gateway.manager.send(botId, { id: `${runId}:${label}`, sessionId: label, kind: 'request',
    content: `这是已授权的隔离热更新验收。只实际调用一次 version_probe，严格使用你当前看到的工具 schema，将唯一必填字符串字段填为 ${JSON.stringify(nonce)}。如果工具等待，请等待返回，不重试，不调用其他工具。收到结果后只用一句话报告返回的 version 和 pid，不要分析或继续操作。` });
  report.receipts ||= []; report.receipts.push({ botId, label, taskId: receipt.taskId, acceptedAt: at() }); await save(); return receipt;
}
async function complete(botId, receipt, expectedVersion, expectedPid) {
  const task = await until(async () => {
    const value = await gateway.manager.request(botId, `/tasks/${encodeURIComponent(receipt.taskId)}`);
    return ['completed','failed','cancelled','interrupted'].includes(value.status) && value;
  }, `Real ${botId} task did not finish`, 180000);
  report.tasks.push(taskEvidence(botId, task)); await save();
  assert.equal(task.status, 'completed', JSON.stringify(clean(task.error || task.status)));
  assert.ok((task.result?.usage?.total_tokens || task.result?.usage?.totalTokens || 0) > 0, 'Observed real provider usage is required');
  assert.equal(task.tools.length, 1, 'Each real task must call exactly one tool');
  const tool = task.tools[0]; assert.equal(tool.name, 'version_probe'); assert.equal(tool.status, 'completed');
  let result = tool.output?.details;
  if (!result?.version) {
    for (const block of tool.output?.content || []) if (block.type === 'text') { try { const value = JSON.parse(block.text); if (value.version) result = value; } catch {} }
  }
  assert.equal(result?.fixture, true); assert.equal(result.version, expectedVersion); assert.equal(result.pid, expectedPid); assert.equal(result.nonce, nonce);
  await progress(`${botId} completed a real Pi task with one audited ${expectedVersion} tool call`); return task;
}
async function pack(version) {
  const packageRoot = join(fixtureRoot, 'package-source', version); await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'capability.json'), JSON.stringify({ id: 'version-probe', version, stateVersion: '1', entry: 'index.mjs' }));
  const source = `import { readFile, appendFile } from 'node:fs/promises';
export function createCapability(options) {
  let calls = 0;
  return { tools: [{ name: 'version_probe', description: 'Explicit hot-update verification fixture. Call once using the current required field, then wait for its result. The v1 request deliberately waits for the test controller gate.', effect: 'read', inputSchema: { type: 'object', properties: { ${version}: { type: 'string' } }, required: ['${version}'], additionalProperties: false } }],
    async callTool(name, args, context, signal) {
      if (name !== 'version_probe' || Object.keys(args).length !== 1 || typeof args.${version} !== 'string' || args.${version} !== options.nonce) throw new Error('Fixture schema or nonce mismatch');
      const call = { fixture: true, version: '${version}', pid: process.pid, nonce: args.${version}, actor: context.actor, callSequence: ++calls, enteredAt: new Date().toISOString() };
      await appendFile(options.callLog, JSON.stringify({ ...call, event: 'entered' }) + '\\n');
      if ('${version}' === 'v1') {
        const deadline = Date.now() + 135000;
        for (;;) {
          signal?.throwIfAborted();
          let gate; try { gate = JSON.parse(await readFile(options.gatePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (gate?.released === true && gate.nonce === options.nonce) break;
          if (Date.now() >= deadline) throw new Error('Explicit fixture gate timed out');
          await new Promise(done => setTimeout(done, 50));
        }
      }
      const result = { ...call, returnedAt: new Date().toISOString() };
      await appendFile(options.callLog, JSON.stringify({ ...result, event: 'returned' }) + '\\n'); return result;
    }
  };
}
`;
  await writeFile(join(packageRoot, 'index.mjs'), source); return packageRoot;
}
async function createBot(id) {
  await gateway.manager.create({ id, roleId: 'engineer', name: id, prompt: '你是隔离验收 Bot。遵循验收任务，只调用明确指定的 version_probe 一次，等待真实工具结果，简短回复。不要使用任何其他工具或技能，不联系同伴，不创建工作。',
    limits: { maxTurns: 3, maxTools: 2, timeoutMs: 240000, maxContextBytes: 128000 } });
  await api('grant', { botId: id, tools: ['version_probe'] });
  await until(() => gateway.registry.bindingsFor(id)['version-probe'] && gateway.control.inventory().switches.find(item => item.id === id)?.phase === 'complete', `Offline grant did not complete for ${id}`);
  return id;
}
async function releaseGate() { await writeFile(gatePath, JSON.stringify({ released: true, nonce, at: at() })); }

await save();
try {
  const supplied = {};
  for (const line of (await readFile(envFile, 'utf8')).split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/); if (!match) continue;
    let value = match[2]; if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    supplied[match[1]] = value;
  }
  apiKey = supplied.DEEPSEEK_API_KEY; if (!apiKey) throw new Error('The explicit env file does not configure DEEPSEEK_API_KEY');
  credentials.add(apiKey); process.env.SUMMON_HOT_UPGRADE_LIVE_KEY = apiKey;
  report.baseUrl = supplied.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
  const endpoint = new URL(report.baseUrl); assert.ok(['http:','https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password);
  const { startGateway } = await import(pathToFileURL(join(releaseRoot, 'capabilities/gateway/index.mjs')).href);
  const { CapabilityServiceSupervisor } = await import(pathToFileURL(join(releaseRoot, 'capabilities/services/supervisor.mjs')).href);
  botApi = await import(pathToFileURL(join(releaseRoot, 'bot/src/index.mjs')).href);
  supervisor = new CapabilityServiceSupervisor({ dataRoot, releaseRoot });
  await mkdir(workspace, { recursive: true });
  await progress('Starting isolated gateway and independent capability workers from the selected release');
  gateway = await startGateway({ dataRoot, releaseRoot, defaultCwd: workspace, seed: false, restore: false,
    model: { provider: 'deepseek', model: report.model, baseUrl: report.baseUrl, apiKeyEnv: 'SUMMON_HOT_UPGRADE_LIVE_KEY', contextWindow: 128000, maxTokens: report.maxTokens } });
  credentials.add(gateway.token);
  const v1 = await api('deploy', { id: 'version-probe', version: 'v1', packageRoot: await pack('v1'), options: { gatePath, callLog, nonce } });
  report.services.push(v1); assert.notEqual(v1.pid, process.pid);
  const old = await createBot('hot-live-old');
  const oldReceipt = await submit(old, 'old-v1');
  const v1Health = await until(async () => { const health = await gateway.supervisor.status('version-probe', 'v1'); return health.activeRequests > 0 && health; }, 'Real old Bot never entered the explicit v1 gate', 90000);
  const oldBlocked = await gateway.manager.request(old, `/tasks/${oldReceipt.taskId}`), before = await gateway.manager.identity(old);
  assert.equal(oldBlocked.status, 'running'); assert.ok(oldBlocked.tools.some(tool => tool.name === 'version_probe' && tool.status === 'running'));
  report.identities = { oldBefore: before }; report.gateEnteredAt = at();
  check('real old Pi task was observed inside the live v1 service request', { botPid: before.pid, servicePid: v1Health.pid, activeRequests: v1Health.activeRequests });
  await progress('Real old Bot is waiting inside v1; publishing v2 with a changed required argument');
  const v2 = await api('deploy', { id: 'version-probe', version: 'v2', packageRoot: await pack('v2'), options: { gatePath, callLog, nonce } });
  report.services.push(v2); assert.notEqual(v2.pid, v1.pid);
  await until(() => gateway.control.inventory().switches.find(item => item.id === old)?.phase === 'preparing', 'Old Bot was not notified to prepare');
  assert.equal(gateway.registry.bindingsFor(old)['version-probe'], 'v1');
  await api('retire', { id: 'version-probe', version: 'v1' }, 409);
  const young = await createBot('hot-live-new'); assert.equal(gateway.registry.bindingsFor(young)['version-probe'], 'v2');
  const newReceipt = await submit(young, 'new-v2'); await complete(young, newReceipt, 'v2', v2.pid);
  const stillBlocked = await gateway.manager.request(old, `/tasks/${oldReceipt.taskId}`);
  assert.equal(stillBlocked.status, 'running'); assert.equal(gateway.registry.bindingsFor(old)['version-probe'], 'v1');
  report.identities.newBot = await gateway.manager.identity(young); assert.notEqual(report.identities.newBot.pid, before.pid);
  check('new Bot used v2 while the active old Bot retained v1; premature retirement rejected', { oldBinding: 'v1', newBinding: 'v2', oldTaskStatus: stillBlocked.status });
  report.gateReleasedAt = at(); await releaseGate(); await complete(old, oldReceipt, 'v1', v1.pid);
  await until(() => gateway.registry.bindingsFor(old)['version-probe'] === 'v2' && gateway.control.inventory().switches.find(item => item.id === old)?.phase === 'complete', 'Old Bot did not acknowledge the v2 switch');
  report.identities.oldAfter = await gateway.manager.identity(old); assert.equal(report.identities.oldAfter.pid, before.pid); assert.equal(report.identities.oldAfter.bootId, before.bootId);
  check('old Bot switched only after completing its v1 task and kept its process identity', { pid: before.pid, bootId: before.bootId, newBinding: 'v2' });
  const follow = await submit(old, 'old-after-v2'); await complete(old, follow, 'v2', v2.pid);
  assert.equal((await api('retire', { id: 'version-probe', version: 'v1' })).state, 'stopped');
  await api('unload', { id: 'version-probe' });
  await until(() => [old, young].every(id => !gateway.registry.bindingsFor(id)['version-probe'] && gateway.control.inventory().switches.find(item => item.id === id)?.phase === 'complete'), 'Capability unload was not acknowledged by both Bots');
  for (const id of [old, young]) {
    const health = await gateway.manager.request(id, '/health'); assert.ok(!health.engine.tools.includes('version_probe'));
    assert.equal(health.engine.engine, 'pi-agent-core'); assert.equal(health.engine.provider.connected, true);
  }
  assert.equal((await api('retire', { id: 'version-probe', version: 'v2' })).state, 'stopped');
  const calls = (await readFile(callLog, 'utf8')).trim().split(/\r?\n/).map(line => JSON.parse(line)); report.fixtureCalls = calls;
  assert.equal(calls.filter(call => call.event === 'entered' && call.version === 'v1').length, 1);
  assert.equal(calls.filter(call => call.event === 'entered' && call.version === 'v2').length, 2);
  assert.equal(calls.filter(call => call.event === 'returned').length, 3);
  assert.equal(report.tasks.length, 3);
  check('unload removed the tool from both live Bots and both fixture versions retired after drain');
  report.functionalPassed = true;
  await progress('All three real model tasks and cooperative version switch/unload checks passed');
} catch (error) {
  report.error = clean({ name: error.name, code: error.code, message: error.message, stack: error.stack });
  process.exitCode = 1; await progress(`FAILED: ${report.error.message}`);
} finally {
  try { await releaseGate(); } catch {}
  let safeToRemove = false;
  try {
    if (gateway) {
      // The explicit sandbox is the only process/data scope of this cleanup.
      for (const bot of gateway.manager.list()) for (const task of await gateway.manager.tasks(bot.id)) if (!report.tasks.some(item => item.id === task.id)) {
        try { report.tasks.push(taskEvidence(bot.id, await gateway.manager.request(bot.id, `/tasks/${task.id}`))); } catch {}
      }
      await gateway.stopBots(); report.cleanup.botsStopped = true;
      const identities = await Promise.all(gateway.manager.list().map(async bot => ({ botId: bot.id, identity: await botApi.inspectBotIdentity(join(dataRoot, 'bots', bot.id)) })));
      report.cleanup.botIdentities = identities; assert.ok(identities.every(item => !item.identity), 'A sandbox Bot is still running');
      await gateway.close(); report.cleanup.gatewayClosed = true;
    }
    if (supervisor) {
      let workers = await supervisor.list();
      for (const worker of workers) if (worker.state !== 'stopped') {
        assert.equal(worker.pendingWork || 0, 0, 'A sandbox service still owns background work'); assert.equal(worker.activeRequests || 0, 0, 'A sandbox service still owns requests');
        await supervisor.stop(worker.id, worker.version);
      }
      workers = await supervisor.list(); report.cleanup.workers = workers.map(({ id, version, state, pid, pendingWork, activeRequests }) => ({ id, version, state, pid, pendingWork, activeRequests }));
      assert.ok(workers.every(worker => worker.state === 'stopped'), 'A sandbox worker is still running');
    }
    if (botApi && existsSync(join(dataRoot, 'bots'))) {
      for (const entry of await readdir(join(dataRoot, 'bots'), { withFileTypes: true })) if (entry.isDirectory()) assert.equal(await botApi.inspectBotIdentity(join(dataRoot, 'bots', entry.name)), null);
    }
    const actualRoot = await realpath(fixtureRoot), actualEvidence = await realpath(evidenceRoot);
    assert.equal(dirname(actualRoot), actualEvidence, 'Cleanup must stay within the explicit evidence directory');
    assert.equal(basename(actualRoot), runId); assert.ok(runId.startsWith('hot-upgrade-live-'));
    safeToRemove = true; report.cleanup.verifiedStoppedAt = at(); await save();
    await rm(actualRoot, { recursive: true, force: false, maxRetries: 5, retryDelay: 150 });
    report.cleanup.fixtureRemoved = !existsSync(actualRoot); assert.equal(report.cleanup.fixtureRemoved, true);
  } catch (error) {
    report.cleanup.error = clean({ message: error.message, code: error.code, safeToRemove }); process.exitCode = 1;
  }
  report.passed = report.functionalPassed === true && report.cleanup.fixtureRemoved === true;
  report.finishedAt = at(); await save();
  if (previousKey === undefined) delete process.env.SUMMON_HOT_UPGRADE_LIVE_KEY; else process.env.SUMMON_HOT_UPGRADE_LIVE_KEY = previousKey;
  if (!report.passed) process.exitCode = 1;
  await progress(report.passed ? 'PASS: owned Bots/services stopped and the sandbox directory was removed' : 'FAIL: inspect the retained report and cleanup status');
  process.stdout.write(JSON.stringify({ passed: report.passed, reportPath, logPath, completedRealTasks: report.tasks.filter(task => task.status === 'completed').length, fixtureRemoved: report.cleanup.fixtureRemoved === true }) + '\n');
}
