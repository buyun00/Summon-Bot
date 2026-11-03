// Explicit write verification only. Every write targets this script's own new
// disposable chat and files under its own test directory. Never retries create.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { DesktopIpc } from '../src/desktop-ipc.js';

if (!process.argv.includes('--write')) throw Error('Use --write only with explicit authorization for a disposable integration chat.');
const config = loadConfig(), ipc = new DesktopIpc(config);
const scenario = process.argv.includes('--project') ? 'project' : 'projectless';
const file = path.join(config.dataDir, `smoke-permissions-${scenario}-result.json`);
const resume = process.argv.includes('--resume');
if (fs.existsSync(file) && !resume) throw Error('A saved attempt exists. Inspect it or use --resume; a new create will not be submitted.');
if (resume && !fs.existsSync(file)) throw Error('No saved attempt exists.');
const evidence = resume ? JSON.parse(fs.readFileSync(file, 'utf8')) : { at: new Date().toISOString(), scenario, checks: {}, createKey: `permissions-create-${randomUUID()}`, archiveKey: `permissions-archive-${randomUUID()}` };
const save = () => fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
const base = `http://${config.host}:${config.port}`;
const headers = { 'Content-Type': 'application/json', ...(config.auth?.bearerToken ? { Authorization: `Bearer ${config.auth.bearerToken}` } : {}) };
async function api(route, { method = 'GET', body, key } = {}) {
  const response = await fetch(base + route, { method, headers: { ...headers, ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(90000) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(data)}`);
  return { data, replayed: response.headers.get('idempotency-replayed') };
}
try {
  if (!resume) {
    evidence.marker = `API_PERMISSION_SMOKE_${randomUUID()}`;
    evidence.testDir = path.join(config.dataDir, `permissions-smoke-${randomUUID()}`);
    const repository = path.join(evidence.testDir, 'repository');
    fs.mkdirSync(repository, { recursive: true });
    const git = spawnSync('git', ['init', '--quiet', repository], { encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, 'Disposable git repository could not be initialized.');
    evidence.outsideFile = path.join(evidence.testDir, 'outside-workspace.txt');
    evidence.gitFile = path.join(repository, '.git', 'api-permission-smoke.txt');
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const command = `$ErrorActionPreference = 'Stop'\nSet-Content -LiteralPath ${quote(evidence.outsideFile)} -Value ${quote(evidence.marker)}\nSet-Content -LiteralPath ${quote(evidence.gitFile)} -Value ${quote(evidence.marker)}\n$response = Invoke-WebRequest -Uri 'https://example.com/' -Method Head -TimeoutSec 25\nWrite-Output ('NETWORK_STATUS=' + $response.StatusCode)`;
    let target = { type: 'projectless', directoryName: 'codex-api-permissions-smoke' };
    if (scenario === 'project') {
      const { data } = await api('/v1/projects');
      const projects = Array.isArray(data.projects) ? data.projects : Object.values(data).flatMap(value => Array.isArray(value) ? value : []);
      const project = projects.find(entry => (entry.rootPaths || []).some(root => path.resolve(root).toLowerCase() === 'd:\\codex-desktop-api'));
      assert.ok(project, 'The existing Codex-Desktop-API saved project is required; no project will be created.');
      target = { type: 'project', projectId: project.projectId ?? project.id, environment: { type: 'local' } };
    }
    evidence.body = { title: `API 首轮权限验证 ${scenario}`, target, prompt: `This is an explicitly authorized disposable API permission integration test. Do not delegate, ask questions, or change any other files. In this FIRST turn, run exactly this PowerShell command once, without requesting escalation or changing permissions:\n\n${command}\n\nAfter it succeeds, reply exactly: ${evidence.marker}. If it fails, report the actual error and stop. Do not retry or repair permissions.` };
    evidence.stage = 'submitting'; save();
    const created = await api('/v1/threads', { method: 'POST', key: evidence.createKey, body: evidence.body });
    evidence.created = created.data; evidence.threadId = created.data.threadId; evidence.stage = 'created'; save();
    console.log(JSON.stringify({ stage: evidence.stage, scenario, threadId: evidence.threadId, permissionInheritance: created.data.permissionInheritance }));
  }
  assert.ok(evidence.threadId, 'No confirmed thread id. Inspect the saved operation; never retry create with a new key.');
  const expected = evidence.created.permissionInheritance;
  assert.equal(expected.profileId, ':danger-full-access'); assert.equal(expected.approvalPolicy, 'never');
  assert.equal(expected.contextVerifiedBeforeFirstMessage, true); assert.equal(expected.verifiedAfterCreation, true);
  evidence.checks.preflightAndReadback = true;
  const snapshot = await ipc.permissionSnapshot(evidence.threadId);
  try {
    const p = snapshot.permissions;
    evidence.currentPermissions = { activePermissionProfile: p.activePermissionProfile, sandboxPolicy: p.sandboxPolicy, approvalPolicy: p.approvalPolicy, approvalsReviewer: p.approvalsReviewer };
    assert.equal(p.activePermissionProfile.id, ':danger-full-access'); assert.equal(p.approvalPolicy, 'never'); assert.equal(p.sandboxPolicy.type, 'dangerFullAccess');
  } finally { ipc.unfollow(evidence.threadId, 'local', snapshot.owner); }
  const deadline = Date.now() + 240000;
  let completed = false;
  while (Date.now() < deadline) {
    const { data } = await api(`/v1/threads/${evidence.threadId}/messages?limit=3&maxOutputCharsPerItem=5000`);
    if (data.turns?.some(turn => turn.status === 'completed' && turn.items?.some(item => item.type === 'agentMessage' && item.text?.includes(evidence.marker)))) {
      assert.equal(data.turns.length, 1, 'The user prompt must execute as the first turn without a bootstrap turn.');
      const commands = data.turns[0].items.filter(item => item.type === 'commandExecution');
      assert.ok(commands.length >= 1, 'First-turn command execution was not observed.');
      assert.ok(commands.some(item => JSON.stringify(item.output).includes('NETWORK_STATUS=200')), 'Successful external network access was not observed in the first turn.');
      completed = true; evidence.checks.oneTurnOnly = true; evidence.checks.firstTurnNetwork = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(completed, 'First-turn completion was not observed; inspect this chat without creating another.');
  assert.equal(fs.readFileSync(evidence.outsideFile, 'utf8').trim(), evidence.marker);
  assert.equal(fs.readFileSync(evidence.gitFile, 'utf8').trim(), evidence.marker);
  evidence.checks.firstTurnOutsideWorkspaceWrite = true; evidence.checks.firstTurnGitWrite = true;
  const replay = await api('/v1/threads', { method: 'POST', key: evidence.createKey, body: evidence.body });
  assert.equal(replay.replayed, 'true'); assert.equal(replay.data.threadId, evidence.threadId); evidence.checks.createIdempotency = true;
  await api(`/v1/threads/${evidence.threadId}/archive`, { method: 'POST', key: evidence.archiveKey, body: {} });
  evidence.checks.archived = true; evidence.stage = 'completed'; evidence.ok = true;
} catch (error) { evidence.ok = false; evidence.error = error.message; process.exitCode = 1; }
finally { ipc.close(); save(); console.log(JSON.stringify({ ok: evidence.ok, scenario, threadId: evidence.threadId, stage: evidence.stage, checks: evidence.checks, error: evidence.error }, null, 2)); }
