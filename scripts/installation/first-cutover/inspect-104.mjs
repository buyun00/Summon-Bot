import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const baseline = '216eb70ee5db1866a30c353ca3332772528b21e1';

export function readRows(file, sql, ...args) {
  if (!existsSync(file)) return [];
  const database = new DatabaseSync(file, { readOnly: true });
  try { return database.prepare(sql).all(...args); }
  finally { database.close(); }
}

export const records = (file, kind) => readRows(file, 'SELECT data FROM records WHERE kind=?', kind)
  .map(({ data }) => JSON.parse(data));
const nativeActive = new Set(['starting', 'running', 'awaiting-input', 'stopping']);
const holdsWork = (status, nativeReview) => ['cancelled', 'paused'].includes(status) || status === 'blocked' && !nativeReview;

export async function inspect104(dataRoot, { since } = {}) {
  const active = [], queued = [], armed = [];
  const started = new Map();
  const observed = (kind, id, status, startedAt, wasStarted) => {
    if (wasStarted || since && typeof startedAt === 'string' && startedAt >= since) {
      started.set(JSON.stringify([kind, id]), { kind, id, status });
    }
  };
  const registry = join(dataRoot, 'capabilities', 'registry', 'state.sqlite');
  for (const row of records(registry, 'native-executions')) {
    observed('native', row.id, row.status, row.launchedAt || row.startedAt, nativeActive.has(row.status));
    if (nativeActive.has(row.status)) active.push({ kind: 'native', id: row.id, status: row.status });
    if (row.status === 'queued') queued.push({ kind: 'native', id: row.id, status: row.status });
    if (row.status === 'queued' || row.moreEvents || row.projectedStatus !== row.status ||
        row.status === 'unknown' && !row.reconciledAt ||
        row.reconciledAt && row.projectedReconciledAt !== row.reconciledAt) {
      armed.push({ kind: 'native-tick', id: row.id, status: row.status });
    }
  }
  for (const kind of ['catalog-requests', 'capability-requests']) {
    for (const { id, status, created_at } of readRows(registry, `SELECT id,created_at,json_extract(data,'$.status') AS status
      FROM records WHERE kind=? AND (json_extract(data,'$.status')='running' OR created_at>=?)`, kind, since || '9999')) {
      if (status === 'running') active.push({ kind, id, status });
      observed(kind, id, status, created_at, status === 'running');
    }
  }
  const usage = join(dataRoot, 'usage.sqlite');
  for (const row of readRows(usage, "SELECT id,bot_id,status,started_at FROM model_usage WHERE status='pending' OR started_at>=?", since || '9999')) {
    const id = `${row.bot_id}:${row.id}`;
    if (row.status === 'pending') active.push({ kind: 'model', id, status: 'pending' });
    observed('model', id, row.status, row.started_at, row.status === 'pending');
  }
  for (const kind of ['native-observation-schedules', 'native-display-sources']) {
    for (const row of records(registry, kind)) armed.push({ kind, id: row.id, status: 'configured' });
  }
  for (const [kind, filter] of [
    ['native-maintenance', row => !row.finishedAt],
    ['catalog-delegations', row => !row.returnedAt],
    ['switches', row => !['complete', 'blocked', 'failed'].includes(row.phase)],
  ]) {
    for (const row of records(registry, kind).filter(filter)) armed.push({ kind, id: row.id, status: row.status || row.phase || 'pending' });
  }
  for (const row of records(registry, 'catalog-requests')) {
    const projection = JSON.stringify([row.status, row.reconciledAt || null]);
    if (row.actor !== 'controller' && row.workId && row.taskId && row.nativeReceiptProjected !== projection) {
      armed.push({ kind: 'remote-projection', id: row.id, status: row.status });
    }
  }
  const management = join(dataRoot, 'capabilities', 'bot-management', 'state.sqlite');
  const gateway = join(dataRoot, 'capabilities', 'gateway', 'state.sqlite');
  for (const [file, kind, filter] of [
    [management, 'routines', row => row.enabled],
    [management, 'reminders', row => ['pending', 'sending'].includes(row.status)],
    [gateway, 'onboarding', row => row.status === 'guiding' && row.setup],
  ]) {
    for (const row of records(file, kind).filter(filter)) armed.push({ kind, id: row.id, status: row.status || 'enabled' });
  }
  for (const bot of await readdir(join(dataRoot, 'bots'), { withFileTypes: true })) {
    if (!bot.isDirectory()) continue;
    const file = join(dataRoot, 'bots', bot.name, 'state.sqlite');
    for (const row of readRows(file, `SELECT task.id,task.status, json_extract(work.data,'$.status') AS work_status,
        json_extract(task.data,'$.metadata.nativeEngineReview') AS native_review, json_extract(task.data,'$.startedAt') AS started_at
      FROM tasks task LEFT JOIN records work ON work.kind='works' AND work.id=json_extract(task.data,'$.workId')
      WHERE task.status IN ('running','accepted') OR json_extract(task.data,'$.startedAt')>=?`, since || '9999')) {
      const fact = { kind: 'bot-task', id: `${bot.name}:${row.id}`, status: row.status };
      observed(fact.kind, fact.id, row.status, row.started_at, row.status === 'running');
      if (row.status === 'running') active.push(fact);
      else if (row.status === 'accepted') {
        if (holdsWork(row.work_status, row.native_review)) queued.push(fact);
        else armed.push(fact);
      }
    }
    for (const row of readRows(file, `SELECT id,kind FROM records
      WHERE kind='knowledge-write' OR (kind='knowledge_reference' AND json_extract(data,'$.status')='pending')
        OR (kind='capability-updates' AND json_extract(data,'$.status') IN ('ready','preparing'))`)) {
      armed.push({ kind: row.kind, id: `${bot.name}:${row.id}`, status: 'pending' });
    }
    for (const row of readRows(file, "SELECT id FROM tools WHERE json_extract(data,'$.status')='running'")) {
      active.push({ kind: 'bot-tool', id: `${bot.name}:${row.id}`, status: 'running' });
    }
    for (const row of readRows(file, `SELECT event.id, json_extract(work.data,'$.status') AS work_status,
          json_extract(event.data,'$.metadata.resume') AS resumes
        FROM records event LEFT JOIN records work ON work.kind='works' AND work.id=json_extract(event.data,'$.workId')
        WHERE event.kind='work-events' AND json_extract(event.data,'$.status')='pending'
          AND json_extract(event.data,'$.receipt') IS NULL`)) {
      // A stopped work holds a task; an explicit resume event can change that.
      if (!['paused', 'cancelled'].includes(row.work_status) || row.resumes) {
        armed.push({ kind: 'work-event', id: `${bot.name}:${row.id}`, status: 'pending' });
      }
    }
    for (const row of readRows(file, "SELECT id FROM records WHERE kind='work-waits' AND json_extract(data,'$.status')='pending'")) {
      armed.push({ kind: 'work-wait', id: `${bot.name}:${row.id}`, status: 'pending' });
    }
    for (const row of readRows(file, "SELECT id FROM outbox WHERE json_extract(data,'$.status')='sending'")) {
      active.push({ kind: 'bot-outbox', id: `${bot.name}:${row.id}`, status: 'sending' });
    }
    if (existsSync(join(dataRoot, 'bots', bot.name, 'config.json'))) {
      const config = JSON.parse(await readFile(join(dataRoot, 'bots', bot.name, 'config.json'), 'utf8'));
      const pendingNotifications = records(file, 'work-notifications').filter(row => ['pending', 'unknown'].includes(row.status));
      // With no matching local contact the direct sender can only retain the
      // pending record. A room fallback still reaches the capability service.
      for (const item of pendingNotifications) {
        if (item.roomId || item.botId && (config.contacts || []).some(contact => contact.botId === item.botId)) {
          armed.push({ kind: 'work-notification', id: `${bot.name}:${item.id}`, status: item.status });
        }
      }
    }
  }
  return { active, queued, armed, started: [...started.values()] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node inspect-104.mjs <existing-data-root>');
    const root = resolve(process.argv[2]);
    const deployment = JSON.parse(await readFile(join(root, 'config', 'deployment.json'), 'utf8'));
    const manifest = JSON.parse(await readFile(join(deployment.releaseRoot, 'release-manifest.json'), 'utf8'));
    if (manifest.sourceCommit !== baseline || manifest.dataFormat) throw new Error('The selected deployment is outside the 0.3.100 migration baseline');
    const { active, queued, armed } = await inspect104(root);
    console.log(JSON.stringify({ active, armed, queued: queued.length, intake_closed: false }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
