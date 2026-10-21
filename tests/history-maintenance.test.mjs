import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { BotStore } from '../bot/src/storage/store.mjs';
import { RecordStore } from '../capabilities/shared/store.mjs';
import { acquireIdentityLock } from '../bot/src/runtime/identity-lock.mjs';
import { acquireServiceLock } from '../scripts/installation/service-lock.mjs';
import { clearHistory } from '../scripts/maintenance/history.mjs';

const identity = () => ({ pid: process.pid, bootId: randomUUID(), state: 'ready' });
const secret = 'private-history-must-not-appear-in-report';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'relay-history-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bot = join(root, 'bots', 'bot-one');
  const run = join(root, 'capabilities', 'service-runtime', 'chatroom', '1', 'run'), launch = join(run, '..', 'launch');
  await mkdir(bot, { recursive: true }); await mkdir(run, { recursive: true }); await mkdir(launch, { recursive: true });
  await mkdir(join(bot, 'artifacts')); await mkdir(join(bot, 'tmp'));
  await writeFile(join(bot, 'bot.json'), JSON.stringify({ id: 'bot-one', token: 'durable-credential' }));
  await writeFile(join(bot, 'artifacts', 'output.txt'), 'durable artifact');
  await writeFile(join(bot, 'tmp', 'retained.txt'), 'temporary files remain');
  const store = new BotStore(join(bot, 'state.sqlite'));
  const { task } = store.acceptMessage({ id: 'message-one', content: secret }, 'user', 'old-boot');
  store.updateTask(task.id, { status: 'completed', output: secret });
  store.saveSession({ id: task.sessionId, messages: [{ role: 'user', content: secret }] });
  store.saveTool({ id: 'tool-one', taskId: task.id, status: 'completed', result: secret });
  store.saveOutbox({ id: 'outbox-one', status: 'accepted', content: secret });
  store.putMemory({ id: 'memory-one', text: 'durable knowledge' });
  store.saveArtifact({ id: 'artifact-one', path: 'artifacts/output.txt' });
  store.setState('profile', 'preferences', { theme: 'dark' });
  for (const kind of ['agentSessions', 'agentRuns', 'toolRuns', 'jobs', 'imported-events', 'imported-kv_state', 'imported-requests', 'imported-sessions']) store.putRecord(kind, { id: 'legacy', content: secret });
  store.putRecord('custom-business-data', { id: 'durable', value: 42 });
  store.putRecord('capability-updates', { id: 'committed', status: 'committed', tools: [] });
  store.close();
  const data = {
    'bot-management': { bots: [{ id: 'bot-one', presetId: 'engineer', name: 'Engineer', desiredState: 'running', lastRestartError: secret }], routines: [{ id: 'routine-one', prompt: 'durable prompt', nextRunAt: '2030-01-01', lastJobId: 'old-job', lastResult: secret }], derivations: [{ id: 'fork-one', status: 'completed', sessions: [secret] }], deliveries: [{ id: 'delivery-one', status: 'completed', content: secret }], 'event-cursors': [{ id: 'bot-one', seq: 1 }] },
    chatroom: { rooms: [{ id: 'room-one', name: 'Room', members: ['bot-one'], status: 'concluded', goal: 'durable goal', summary: secret, completedRounds: 3, concludedAt: '2020-01-01', originMessageId: 'old' }], messages: [{ id: 'message-one', content: secret }], deliveries: [{ id: 'delivery-one', status: 'completed', result: secret }] },
    codex: { works: [{ id: 'work-one', status: 'completed', output: secret }], workEvents: [{ id: 'event-one', content: secret }] },
    'memory-management': { proposals: [{ id: 'proposal-one', status: 'ready', sessions: [secret] }], deliveries: [{ id: 'delivery-one', status: 'completed' }], merges: [{ id: 'merge-one', content: secret }] },
    gateway: { 'imported-sessions': [{ id: 'old-session', content: secret }], 'event-cursors': [{ id: 'bot-one', seq: 3 }] },
    registry: { 'capability-actors': [{ id: 'bot-one', bindings: { chatroom: '1' } }], 'capability-services': [{ id: 'chatroom', activeVersion: '1' }], 'capability-versions': [{ id: 'chatroom@1', token: 'durable-service-credential' }], switches: [{ id: 'switch-one', phase: 'complete' }], 'capability-proposals': [{ id: 'committed', status: 'committed' }], 'capability-requests': [{ id: 'request-one', status: 'completed', args: secret }], 'capability-reconciliations': [{ id: 'resolution-one', note: secret }] },
    knowledge: { nodes: [{ id: 'node-one', title: 'durable knowledge node' }], edges: [{ id: 'edge-one', from: 'node-one', to: 'node-one' }] },
  };
  for (const [domain, kinds] of Object.entries(data)) {
    const db = new RecordStore(join(root, 'capabilities', domain, 'state.sqlite'));
    for (const [kind, values] of Object.entries(kinds)) for (const value of values) db.save(kind, value);
    if (domain === 'gateway') db.db.exec("CREATE TABLE sync_journal_v1(id INTEGER PRIMARY KEY,data TEXT); CREATE TABLE sync_scopes_v1(id TEXT PRIMARY KEY,data TEXT); INSERT INTO sync_journal_v1 VALUES(1,'old'); INSERT INTO sync_scopes_v1 VALUES('chat','old');");
    db.close();
  }
  return { root, bot, run, launch, data };
}
function inspect(path, fn) { const db = new DatabaseSync(path, { readOnly: true }); try { return fn(db); } finally { db.close(); } }
function record(root, domain, kind, id) { return inspect(join(root, 'capabilities', domain, 'state.sqlite'), db => { const row = db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, id); return row && JSON.parse(row.data); }); }
function mutate(root, domain, kind, value) { const store = new RecordStore(join(root, 'capabilities', domain, 'state.sqlite')); try { store.save(kind, value); } finally { store.close(); } }
function historyCount(bot) { return inspect(join(bot, 'state.sqlite'), db => db.prepare('SELECT count(*) AS count FROM messages').get().count); }

test('offline cleanup erases current/imported conversation and execution history while proving durable data and all files are preserved', async t => {
  const { root, bot } = await fixture(t);
  const result = await clearHistory({ dataRoot: root });
  assert.equal(result.bots.count, 1); assert.equal(result.bots.tables.messages, 1);
  assert.equal(result.bots.records.agentSessions, 1); assert.equal(result.capabilities['bot-management'].records.derivations, 1);
  assert.equal(result.preserved.durable.verified, true); assert.equal(result.preserved.files.verified, true);
  assert.equal(result.preserved.files.before, result.preserved.files.after); assert.ok(result.preserved.files.files >= 4);
  assert.equal(JSON.stringify(result).includes(secret), false); assert.equal(JSON.stringify(result).includes('durable-credential'), false);
  const marker = JSON.parse(await readFile(join(root, 'history.json'), 'utf8'));
  assert.equal(marker.status, 'complete'); assert.equal(marker.historyEpoch, result.historyEpoch); assert.equal(marker.clearedAt, result.clearedAt);
  const store = new BotStore(join(bot, 'state.sqlite'), { readOnly: true });
  try {
    for (const table of ['messages', 'tasks', 'sessions', 'tools', 'events', 'outbox']) assert.equal(store.list(table).length, 0, table);
    for (const kind of ['agentSessions', 'agentRuns', 'toolRuns', 'jobs', 'imported-events', 'imported-kv_state', 'imported-requests', 'imported-sessions']) assert.equal(store.listRecords(kind).length, 0, kind);
    assert.equal(store.getMemory('memory-one').text, 'durable knowledge'); assert.equal(store.getArtifact('artifact-one').path, 'artifacts/output.txt');
    assert.deepEqual(store.getState('profile', 'preferences').value, { theme: 'dark' });
    assert.equal(store.getRecord('custom-business-data', 'durable').value, 42); assert.equal(store.getRecord('capability-updates', 'committed').status, 'committed');
  } finally { store.close(); }
  assert.equal(await readFile(join(bot, 'artifacts', 'output.txt'), 'utf8'), 'durable artifact');
  assert.equal(await readFile(join(bot, 'tmp', 'retained.txt'), 'utf8'), 'temporary files remain');
  assert.equal(JSON.parse(await readFile(join(bot, 'bot.json'), 'utf8')).token, 'durable-credential');
  const room = record(root, 'chatroom', 'rooms', 'room-one');
  assert.deepEqual(room.members, ['bot-one']); assert.equal(room.goal, 'durable goal'); assert.equal(room.summary, ''); assert.equal(room.completedRounds, 0); assert.equal(room.status, 'active'); assert.equal(room.originMessageId, undefined);
  assert.equal(record(root, 'bot-management', 'bots', 'bot-one').presetId, 'engineer'); assert.equal(record(root, 'bot-management', 'bots', 'bot-one').desiredState, 'running');
  assert.equal(record(root, 'bot-management', 'routines', 'routine-one').prompt, 'durable prompt'); assert.equal(record(root, 'bot-management', 'routines', 'routine-one').lastJobId, undefined);
  assert.equal(record(root, 'knowledge', 'nodes', 'node-one').title, 'durable knowledge node'); assert.equal(record(root, 'registry', 'capability-versions', 'chatroom@1').token, 'durable-service-credential');
  for (const [domain, kinds] of Object.entries({ chatroom: ['messages', 'deliveries'], codex: ['works', 'workEvents'], 'memory-management': ['proposals', 'deliveries', 'merges'], 'bot-management': ['derivations', 'deliveries', 'event-cursors'], registry: ['capability-requests', 'capability-reconciliations'] })) {
    inspect(join(root, 'capabilities', domain, 'state.sqlite'), db => { for (const kind of kinds) assert.equal(db.prepare('SELECT count(*) AS count FROM records WHERE kind=?').get(kind).count, 0); });
  }
  inspect(join(root, 'capabilities', 'gateway', 'state.sqlite'), db => { for (const table of ['sync_journal_v1', 'sync_scopes_v1']) assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0); });
  const again = await clearHistory({ dataRoot: root }); assert.notEqual(again.historyEpoch, result.historyEpoch); assert.equal(again.bots.tables.messages, 0); assert.equal(again.preserved.files.verified, true);
});

test('active gateway, Web, Bot, capability worker, launcher and concurrent maintenance all refuse before clearing', async t => {
  const { root, bot, run, launch } = await fixture(t);
  for (const [label, acquire] of [
    ['gateway', () => acquireServiceLock(root, 'gateway', identity)], ['web', () => acquireServiceLock(root, 'web', identity)],
    ['bot', () => acquireIdentityLock(bot, identity)], ['worker', () => acquireIdentityLock(run, identity)], ['launcher', () => acquireIdentityLock(launch, identity)],
    ['maintenance', () => acquireServiceLock(root, 'history-maintenance', identity)],
  ]) {
    const lock = await acquire();
    try { await assert.rejects(clearHistory({ dataRoot: root }), error => error.code.startsWith('HISTORY_'), label); assert.equal(historyCount(bot), 1, label); }
    finally { await lock.close(); }
  }
  await assert.rejects(readFile(join(root, 'history.json')), { code: 'ENOENT' });
});

test('unknown OS identity and unresolved execution outcomes cannot be interpreted as stopped', async t => {
  const { root, bot } = await fixture(t);
  const lock = await acquireServiceLock(root, 'gateway', () => ({ state: 'invalid-no-pid' }));
  try { await assert.rejects(clearHistory({ dataRoot: root }), { code: 'HISTORY_MAINTENANCE_FAILED' }); }
  finally { await lock.close(); }
  mutate(root, 'registry', 'capability-requests', { id: 'request-one', status: 'unknown' });
  await assert.rejects(clearHistory({ dataRoot: root }), { code: 'HISTORY_PENDING_WORK' });
  mutate(root, 'registry', 'capability-requests', { id: 'request-one', status: 'completed' });
  mutate(root, 'codex', 'works', { id: 'work-one', status: 'running' });
  await assert.rejects(clearHistory({ dataRoot: root }), { code: 'HISTORY_PENDING_WORK' });
  mutate(root, 'codex', 'works', { id: 'work-one', status: 'completed' });
  const store = new BotStore(join(bot, 'state.sqlite')); store.saveTool({ id: 'tool-one', taskId: store.listTasks()[0].id, status: 'unknown' }); store.close();
  await assert.rejects(clearHistory({ dataRoot: root }), { code: 'HISTORY_PENDING_WORK' });
  assert.equal(historyCount(bot), 1); await assert.rejects(readFile(join(root, 'history.json')), { code: 'ENOENT' });
});

test('filesystem links and hard-linked databases cannot escape the explicitly selected data root', async t => {
  const { root, bot } = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'relay-history-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'keep.txt'), 'outside');
  const linked = join(root, 'bots', 'outside-link');
  await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  try { await assert.rejects(clearHistory({ dataRoot: root }), { code: 'HISTORY_UNSAFE_PATH' }); }
  finally { await unlink(linked); }
  const alias = join(outside, 'state.sqlite'); await link(join(bot, 'state.sqlite'), alias);
  try { await assert.rejects(clearHistory({ dataRoot: root }), { code: 'HISTORY_UNSAFE_PATH' }); }
  finally { await unlink(alias); }
  assert.equal(historyCount(bot), 1); assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'outside');
});
