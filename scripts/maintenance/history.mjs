import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstat, realpath, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BotStore } from '../../bot/src/storage/store.mjs';
import { acquireIdentityLock, inspectInstanceIdentity } from '../../bot/src/runtime/identity-lock.mjs';
import { acquireServiceLock, inspectServiceLock } from '../installation/service-lock.mjs';
import { assertInstallationWritable } from '../installation/installation-state.mjs';
import { parseArgs } from '../build/files.mjs';
import { observeStoppedNativeWriters } from '../installation/drain.mjs';

const fail = (message, code = 'HISTORY_CLEANUP_REFUSED') => Object.assign(new Error(message), { code });
const domains = Object.freeze({
  chatroom: ['messages', 'room-public-history', 'room-goals', 'platform-events', 'platform-deliveries', 'platform-calls', 'platform-waits',
    'platform-client-calls', 'platform-sessions', 'platform-conversations', 'platform-inputs', 'session-operations', 'session-inputs', 'session-service-events'],
  gateway: [],
});
const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root, value) => { const part = relative(root, value); return !part || !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); };

async function stat(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function safePath(root, path, { directory = false, required = false } = {}) {
  path = resolve(path);
  if (!inside(root, path)) throw fail('Maintenance path leaves the selected data root', 'HISTORY_UNSAFE_PATH');
  const parts = relative(root, path).split(sep).filter(Boolean);
  let current = root;
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) current = join(current, part);
    const info = await stat(current);
    if (!info) {
      if (required || index < parts.length) throw fail('Required maintenance path is missing', 'HISTORY_INVALID_LAYOUT');
      return null;
    }
    if (info.isSymbolicLink()) throw fail('Maintenance paths cannot contain links', 'HISTORY_UNSAFE_PATH');
    if (index < parts.length && !info.isDirectory()) throw fail('Maintenance ancestor is not a directory', 'HISTORY_UNSAFE_PATH');
    if (index === parts.length && (directory ? !info.isDirectory() : !info.isFile())) throw fail('Maintenance path has an unexpected file type', 'HISTORY_UNSAFE_PATH');
    if (!inside(root, await realpath(current))) throw fail('Maintenance path resolves outside the selected data root', 'HISTORY_UNSAFE_PATH');
    if (index === parts.length && !directory && info.nlink !== 1) throw fail('Maintenance database or marker cannot be a hard link', 'HISTORY_UNSAFE_PATH');
  }
  return path;
}
async function safeRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail('An explicit dataRoot is required', 'HISTORY_INVALID_LAYOUT');
  const root = resolve(input);
  if (root === parse(root).root) throw fail('A filesystem root is not a deployment data root', 'HISTORY_INVALID_LAYOUT');
  let parent = root;
  while (parent !== dirname(parent)) {
    const info = await stat(parent);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw fail('Data root ancestors must be real directories', 'HISTORY_UNSAFE_PATH');
    parent = dirname(parent);
  }
  if (normalize(await realpath(root)) !== normalize(root)) throw fail('Data root must have a direct physical path', 'HISTORY_UNSAFE_PATH');
  await safePath(root, join(root, 'bots'), { directory: true, required: true });
  await safePath(root, join(root, 'capabilities'), { directory: true, required: true });
  return root;
}
async function database(root, folder) {
  const path = join(folder, 'state.sqlite');
  for (const suffix of ['', '-wal', '-shm', '-journal']) await safePath(root, `${path}${suffix}`);
  return await stat(path) ? path : null;
}
async function childDirectories(root, folder) {
  if (!await safePath(root, folder, { directory: true })) return [];
  const result = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw fail('Managed instance directories cannot be links', 'HISTORY_UNSAFE_PATH');
    if (entry.isDirectory()) result.push(await safePath(root, join(folder, entry.name), { directory: true, required: true }));
  }
  return result.sort();
}
async function inventory(root) {
  const bots = await childDirectories(root, join(root, 'bots'));
  const botDatabases = (await Promise.all(bots.map(folder => database(root, folder)))).filter(Boolean);
  const capabilities = {};
  for (const domain of Object.keys(domains)) {
    const folder = join(root, 'capabilities', domain);
    if (await safePath(root, folder, { directory: true })) capabilities[domain] = await database(root, folder);
  }
  await safePath(root, join(root, 'history.json'));
  return { bots, botDatabases, capabilities };
}
function withReadOnly(path, operation) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return operation(db); } finally { db.close(); }
}
function hasTable(db, table) { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)); }
function checkSchema(snapshot) {
  for (const path of snapshot.botDatabases) withReadOnly(path, db => {
    if (db.prepare('PRAGMA user_version').get().user_version !== 1 || !hasTable(db, 'records')) throw fail(`Unsupported Bot database: ${path}`, 'HISTORY_INVALID_SCHEMA');
  });
  for (const path of Object.values(snapshot.capabilities)) {
    if (!path) continue;
    withReadOnly(path, db => {
      if (!hasTable(db, 'records')) throw fail(`Unsupported capability database: ${path}`, 'HISTORY_INVALID_SCHEMA');
    });
  }
}
async function verifyStopped(root, snapshot) {
  for (const type of ['gateway', 'web']) {
    const owner = await inspectServiceLock(root, type);
    if (owner) throw fail(`${type} PID ${owner.pid} still owns the service`, 'HISTORY_ACTIVE_OWNER');
  }
  for (const directory of snapshot.bots) {
    const owner = await inspectInstanceIdentity(directory);
    if (owner) throw fail(`${directory} is still owned by PID ${owner.pid}`, 'HISTORY_ACTIVE_OWNER');
  }
}
function compact(db, path, warnings) {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);'); }
  catch (error) { warnings.push(`History deleted; database compaction pending for ${path}: ${error.message}`); }
}
function clearDomain(path, domain, warnings) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    const result = { records: {}, updated: {}, tables: {} };
    try {
      for (const kind of domains[domain]) result.records[kind] = Number(db.prepare('DELETE FROM records WHERE kind=?').run(kind).changes);
      if (domain === 'chatroom') {
        result.updated.observations = Number(db.prepare(`UPDATE records SET data=json_set(data,'$.observation',
          json_object('generation',lower(hex(randomblob(16))),'through',NULL,'start_sequence',0,'work_start',0,'first_user',json('true'),'pending',NULL))
          WHERE kind='platform-wakeups' AND json_type(data,'$.observation')='object'`).run().changes);
        result.updated.rooms = Number(db.prepare(`UPDATE records SET data=json_set(data,'$.pins',
          json(COALESCE((SELECT json_group_array(json(pin.value)) FROM json_each(data,'$.pins') AS pin
          WHERE json_extract(pin.value,'$.kind')<>'event'),'[]')))
          WHERE kind='rooms' AND EXISTS (SELECT 1 FROM json_each(data,'$.pins') WHERE json_extract(value,'$.kind')='event')`).run().changes);
      }
      if (domain === 'gateway') for (const table of ['sync_journal_v1', 'sync_scopes_v1']) if (hasTable(db, table)) result.tables[table] = Number(db.prepare(`DELETE FROM ${table}`).run().changes);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    compact(db, path, warnings);
    return result;
  } finally { db.close(); }
}
async function marker(root, value) {
  const destination = join(root, 'history.json'), temporary = join(root, `.history-${randomUUID()}.tmp`);
  await safePath(root, destination);
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await rename(temporary, destination); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Explicit offline maintenance. Never backs up, exports, or removes artifact files. */
export async function clearHistory({ dataRoot } = {}) {
  const root = await safeRoot(dataRoot), locks = [], bootId = randomUUID();
  const identity = () => ({ pid: process.pid, bootId, state: 'maintenance', purpose: 'clear-history' });
  let historyEpoch, startedAt;
  try {
    locks.push(await acquireServiceLock(root, 'installation', identity));
    const installation = await assertInstallationWritable(root);
    if (!installation) throw fail('Use the history command for the selected deployment format', 'HISTORY_INVALID_SCHEMA');
    const snapshot = await inventory(root);
    await verifyStopped(root, snapshot);
    for (const type of ['gateway', 'web']) locks.push(await acquireServiceLock(root, type, identity));
    for (const directory of snapshot.bots) locks.push(await acquireIdentityLock(directory, identity));
    if (JSON.stringify(await inventory(root)) !== JSON.stringify(snapshot)) throw fail('Managed data layout changed during maintenance acquisition', 'HISTORY_LAYOUT_CHANGED');
    if (typeof BotStore.prototype.clearHistory !== 'function') throw fail('Bot package does not support history cleanup', 'HISTORY_INVALID_SCHEMA');
    checkSchema(snapshot);
    try { await observeStoppedNativeWriters({ dataRoot: root, releaseRoot: installation.release_root }); }
    catch (error) {
      if (error.code !== 'INSTALLATION_ACTIVE_WRITER') throw error;
      throw fail(error.message, 'HISTORY_PENDING_WORK');
    }
    historyEpoch = randomUUID(); startedAt = new Date().toISOString();
    // Publish an epoch before deletion as well: a partial failure must not leave browser caches valid.
    await marker(root, { historyEpoch, startedAt, status: 'clearing' });
    const result = { historyEpoch, bots: { count: snapshot.bots.length, databases: snapshot.botDatabases.length, tables: {}, records: {} }, capabilities: {} };
    const warnings = [];
    for (const path of snapshot.botDatabases) {
      await database(root, dirname(path));
      const store = new BotStore(path);
      try {
        store.db.exec('PRAGMA secure_delete=ON'); const counts = store.clearHistory();
        counts.records['migration-conversation-history'] = Number(store.db.prepare("DELETE FROM records WHERE kind='migration-conversation-history'").run().changes);
        for (const group of ['tables', 'records']) for (const [name, count] of Object.entries(counts[group])) result.bots[group][name] = (result.bots[group][name] || 0) + count;
        compact(store.db, path, warnings);
      } finally { store.close(); }
    }
    for (const [domain, path] of Object.entries(snapshot.capabilities)) if (path) {
      await database(root, dirname(path)); result.capabilities[domain] = clearDomain(path, domain, warnings);
    }
    result.clearedAt = new Date().toISOString();
    await marker(root, { historyEpoch, clearedAt: result.clearedAt, status: 'complete' });
    return warnings.length ? { ...result, warnings } : result;
  } catch (error) {
    if (historyEpoch) await marker(root, { historyEpoch, startedAt, status: 'failed', code: 'HISTORY_PARTIAL_FAILURE' }).catch(() => {});
    if (error.code?.startsWith('HISTORY_')) throw error;
    throw fail('History cleanup could not verify exclusive ownership or complete its database operation', 'HISTORY_MAINTENANCE_FAILED');
  } finally { for (const lock of locks.reverse()) await lock.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { options } = parseArgs(process.argv.slice(2));
  clearHistory({ dataRoot: options['data-root'] }).then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2)))
    .catch(error => { console.error(JSON.stringify({ ok: false, code: error.code, error: error.message })); process.exitCode = 1; });
}
