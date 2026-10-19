// Opt-in real Codex integration test. Uses the installed account/configuration.
// The consultation callback is an explicit deterministic fixture, not a social model.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { CodexExecutor } from '../src/codex.mjs';

const directory = resolve('.relay/evidence', `codex-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(directory, { recursive: true });
const database = join(directory, 'evidence.sqlite');
const marker = `relay-${randomBytes(6).toString('hex')}`;
const resumedMarker = `resumed-${randomBytes(6).toString('hex')}`;
const results = [];
const recoveryOnly = process.argv.includes('--recovery-only');
const observations = [];
let store = new Store(database);
let executor;
let consultMode = 'answer';
const print = value => { console.log(JSON.stringify(value)); observations.push({ at: new Date().toISOString(), ...value }); };
const makeExecutor = () => new CodexExecutor({
  store, defaultCwd: directory,
  consult: async (work, question) => {
    print({ type: 'real_dynamic_tool_received', workId: work.id, question, consultMode });
    return consultMode === 'answer' ? marker : consultMode === 'resumed' ? resumedMarker : null;
  },
  onResult: work => { results.push({ id: work.id, status: work.status }); print({ type: 'result_callback', id: work.id, status: work.status }); },
});
async function waitFor(id, predicate, description, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const work = executor.get(id);
    if (predicate(work)) return work;
    if (work.status === 'failed') throw new Error(`${description}: ${work.error}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  const work = executor.get(id);
  throw new Error(`${description} timed out; status=${work.status}, error=${work.error || ''}`);
}
async function idle() {
  while (executor.active) await new Promise(resolveWait => setTimeout(resolveWait, 50));
}
let report = { kind: 'real_codex_protocol_with_fixture_consultation', evidenceDirectory: directory, recoveryOnly, passed: false, checks: {}, observations };
try {
  executor = makeExecutor();
  await executor.start();
  let initialId;
  if (!recoveryOnly) {
  const first = executor.create({ botId: 'protocol-test', goal: 'This is a small live integration test. First call relay_consult to ask for the integration marker. The marker is deliberately not in this prompt. Write the exact returned marker into protocol.txt in the working directory, then read the file back and report the path and actual verification. Do not inspect other directories or use other services. No commits, pushes or branch changes.' });
  initialId = first.id;
  print({ type: 'created', id: first.id, directory });
  const completed = await waitFor(first.id, work => work.status === 'completed', 'Initial real delegation');
  await idle();
  assert.equal(readFileSync(join(directory, 'protocol.txt'), 'utf8').trim(), marker);
  assert.ok(completed.events.some(event => event.type === 'consult_requested'));
  assert.ok(completed.events.some(event => event.type === 'consult_answer'));
  assert.ok(completed.events.some(event => event.type === 'item_completed' && ['commandExecution', 'fileChange'].includes(event.data.item?.type)));
  assert.ok(results.some(result => result.id === first.id));
  report.checks.delegation = true;
  report.checks.dynamicConsultationAndContinuation = true;
  report.model = completed.model;
  report.reasoningEffort = completed.reasoningEffort;
  }

  consultMode = 'hold';
  const second = executor.create({ botId: 'protocol-test', goal: 'Live cancellation test. Immediately call relay_consult asking for the cancellation-test marker. Wait for its answer before doing any other operation. Do not write or read any file before the consultation returns.' });
  await waitFor(second.id, work => work.status === 'waiting', 'Pending live tool consultation');
  const threadId = executor.get(second.id).threadId;
  await executor.cancel(second.id);
  await idle();
  assert.equal(executor.get(second.id).status, 'cancelled');
  assert.ok(executor.get(second.id).events.some(event => event.type === 'interrupt_acknowledged'));
  report.checks.cancelWithInterruptAcknowledgement = true;

  await executor.resume(second.id, { content: 'Cancellation was intentional. Continue the same integration test. First call relay_consult again asking for the restart-test marker. Do not write anything until the answer comes back.' });
  await waitFor(second.id, work => work.status === 'waiting' && work.events.filter(event => event.type === 'consult_requested').length >= 2, 'Consultation on resumed Codex thread');
  assert.equal(executor.get(second.id).threadId, threadId);
  report.checks.resumePreservesDynamicTool = true;
  await executor.stop();
  assert.equal(executor.get(second.id).status, 'interrupted');
  store.close();

  store = new Store(database);
  executor = makeExecutor();
  await executor.start();
  assert.equal(executor.get(second.id).status, 'interrupted');
  assert.equal(executor.active, null);
  report.checks.restartDoesNotAutomaticallyRerun = true;
  consultMode = 'resumed';
  await executor.resume(second.id, { content: 'Service restart was intentional. Call relay_consult again for the final restart-test marker. Write the exact answer into resumed.txt in the working directory and read it back. Then report the actual result. Do not change other files or inspect other directories.' });
  const resumed = await waitFor(second.id, work => work.status === 'completed', 'Resume after actual adapter and database restart');
  await idle();
  assert.equal(resumed.threadId, threadId);
  assert.equal(readFileSync(join(directory, 'resumed.txt'), 'utf8').trim(), resumedMarker);
  report.checks.explicitResumeAfterRestart = true;
  report.workIds = [initialId, second.id].filter(Boolean);
  report.passed = true;
  print({ type: 'passed', checks: report.checks });
} catch (error) {
  report.error = error.stack;
  print({ type: 'failed', message: error.message });
  process.exitCode = 1;
} finally {
  await executor?.stop();
  report.works = store.list('works').map(work => ({ ...work, events: store.list('workEvents').filter(event => event.workId === work.id) }));
  store.close();
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`Evidence: ${join(directory, 'report.json')}`);
}
