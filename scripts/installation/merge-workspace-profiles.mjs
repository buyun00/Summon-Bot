import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readdir, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, writeJson } from '../build/files.mjs';

const field = 'workspaceProfileId';
const profile = record => record?.[field] ?? null;

async function optionalJson(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function directories(path) {
  try { return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function updateDatabase(path, action) {
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { timeout: 10000 });
  try {
    db.exec('BEGIN IMMEDIATE');
    try { action(db); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}

function cleanProjection(value) {
  if (!value || typeof value !== 'object') return;
  delete value[field];
  if (value.room) delete value.room[field];
  if (Array.isArray(value.wait_refs)) for (const wait of value.wait_refs) if (wait && typeof wait === 'object') delete wait[field];
  if (Array.isArray(value.items)) for (const item of value.items) cleanProjection(item);
  if (Array.isArray(value.messages)) for (const item of value.messages) cleanProjection((item?.message ?? item)?.details);
}

function migrateClientRequests(db) {
  const kind = 'platform-client-calls';
  const existing = db.prepare('SELECT id, data FROM records WHERE kind=?').all(kind);
  const used = new Map(existing.map(row => [row.id, JSON.parse(row.data).call_id]));
  const update = db.prepare('UPDATE records SET id=?, data=? WHERE kind=? AND id=?');
  const remove = db.prepare('DELETE FROM records WHERE kind=? AND id=?');
  for (const row of existing) {
    const key = JSON.parse(row.id);
    if (!Array.isArray(key) || key.length !== 4) continue;
    const id = JSON.stringify([key[0], key[1], key[3]]);
    const value = JSON.parse(row.data);
    if (used.has(id)) {
      if (used.get(id) !== value.call_id) throw new Error('Two existing calls share the same client request identity');
      remove.run(kind, row.id);
    } else {
      used.set(id, value.call_id);
      update.run(id, JSON.stringify({ ...value, id }), kind, row.id);
    }
  }
}

function migrateSharedStore(db, catalog) {
  const list = kind => db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(row => JSON.parse(row.data));
  const save = db.prepare('UPDATE records SET data=? WHERE kind=? AND id=?');
  const bots = new Map(list('platform-bots').map(bot => [bot.id, bot]));
  const directories = new Map(list('platform-workspaces').map(directory => [directory.id, directory]));
  const models = new Map((catalog?.connections ?? []).map(model => [model.id, model]));
  const priorProfiles = list('platform-workspace-profiles');
  const connections = list('platform-connections');
  if (priorProfiles.length || connections.some(entry => Object.hasOwn(entry, field))) {
    for (const entry of connections) {
      const authorized = id => bots.has(id) && profile(bots.get(id)) === profile(entry);
      if (entry.allowed_bot_ids?.includes('*')) {
        // Resolve historical wildcards against the population they actually authorized.
        entry.allowed_bot_ids = [...bots.keys()].filter(authorized);
      } else if (entry.allowed_bot_ids) {
        entry.allowed_bot_ids = entry.allowed_bot_ids.filter(authorized);
      }
      if (entry.repair_bot_ids) entry.repair_bot_ids = entry.repair_bot_ids.filter(authorized);
      if (entry.direct_bot_ids) entry.direct_bot_ids = entry.direct_bot_ids.filter(authorized);
      save.run(JSON.stringify(entry), 'platform-connections', entry.id);
    }
    for (const access of list('platform-access')) {
      const bot = bots.get(access.id);
      const authorized = (id, records) => !records.has(id) || profile(records.get(id)) === profile(bot);
      if (!bot) continue;
      if (access.model_ids) access.model_ids = access.model_ids.filter(id => authorized(id, models));
      if (access.workspace_ids) access.workspace_ids = access.workspace_ids.filter(id => authorized(id, directories));
      save.run(JSON.stringify(access), 'platform-access', access.id);
    }
  }

  migrateClientRequests(db);
  const rows = db.prepare("SELECT kind,id,data FROM records WHERE kind<>'migration-history' AND instr(data,?)>0").all(field);
  for (const { kind, id, data } of rows) {
    const record = JSON.parse(data);
    delete record[field];
    if (kind === 'platform-calls') cleanProjection(record.result);
    if (kind === 'platform-deliveries') {
      cleanProjection(record.event);
      for (const wait of record.wait_refs ?? []) cleanProjection(wait);
    }
    const updated = JSON.stringify(record);
    if (updated !== data) save.run(updated, kind, id);
  }
  for (const bot of bots.values()) {
    if (!bot.instructions?.includes('R2 工作区的 Codex 会话引擎')) continue;
    const { data } = db.prepare("SELECT data FROM records WHERE kind='platform-bots' AND id=?").get(bot.id);
    const current = JSON.parse(data);
    current.instructions = current.instructions.replaceAll('R2 工作区的 Codex 会话引擎', '已分配的 Codex 会话引擎');
    save.run(JSON.stringify(current), 'platform-bots', current.id);
  }
  db.prepare("DELETE FROM records WHERE kind='platform-workspace-profiles'").run();
}

function migrateBotStore(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='records'").get()) return;
  const save = db.prepare('UPDATE records SET data=? WHERE kind=? AND id=?');
  const rows = db.prepare("SELECT kind,id,data FROM records WHERE kind IN ('call','transcript','wait','inbox-event') AND instr(data,?)>0").all(field);
  for (const { kind, id, data } of rows) {
    const record = JSON.parse(data);
    cleanProjection(record);
    cleanProjection(record.event);
    cleanProjection(record.result);
    const updated = JSON.stringify(record);
    if (updated !== data) save.run(updated, kind, id);
  }
}

async function removeEmptyDirectory(path) {
  await rmdir(path).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
}

export async function mergeWorkspaceProfiles(dataRoot) {
  const config = join(dataRoot, 'config');
  const catalogFile = join(config, 'model-connections.json');
  const catalog = await optionalJson(catalogFile);
  const chatroom = join(dataRoot, 'capabilities', 'chatroom');

  updateDatabase(join(chatroom, 'state.sqlite'), db => migrateSharedStore(db, catalog));
  if (catalog) {
    delete catalog.activeByProfile;
    for (const model of catalog.connections) delete model[field];
    await writeJson(catalogFile, catalog);
  }
  const bots = join(dataRoot, 'bots');
  for (const id of await directories(bots)) updateDatabase(join(bots, id, 'state.sqlite'), migrateBotStore);

  const attachments = join(chatroom, 'attachments');
  for (const id of await directories(attachments)) {
    const path = join(attachments, id, 'metadata.json');
    const metadata = await optionalJson(path);
    if (metadata && Object.hasOwn(metadata, field)) {
      delete metadata[field];
      await writeJson(path, metadata);
    }
  }
  updateDatabase(join(dataRoot, 'capabilities', 'gateway', 'state.sqlite'), db => {
    for (const name of ['sync_journal_v1', 'sync_scopes_v1']) {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name)) db.exec('DELETE FROM ' + name);
    }
  });
  const previousConfig = join(config, 'workspaces');
  for (const id of await directories(previousConfig)) await removeEmptyDirectory(join(previousConfig, id));
  await removeEmptyDirectory(previousConfig);
}
