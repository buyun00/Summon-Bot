import { mkdir, open, lstat, copyFile, rename, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { within, readJson, writeJson } from '../build/files.mjs';
import { writeInstallationState } from './installation-state.mjs';

async function ordinaryFile(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`Invalid migration file path: ${path}`);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function migrateInstallation({ dataRoot, appRoot, state, deployment, defaultLimits, publicOrigin }) {
  if (state.phase !== 'converting') throw new Error('Installation conversion is not active');
  const pending = { ...state, stores: { ...state.stores }, file_actions: { ...state.file_actions } };
  const save = () => writeInstallationState(dataRoot, pending);
  const action = async (id, target, perform, resolveSource) => {
    target = resolve(target);
    if (!within(dataRoot, target) || target === resolve(dataRoot)) throw new Error('Migration target must be within the data root');
    await mkdir(dirname(target), { recursive: true });
    if (!within(await realpath(dataRoot), await realpath(dirname(target)))) throw new Error('Migration target resolves outside the data root');
    await ordinaryFile(target);
    const previous = pending.file_actions[id];
    if (previous && previous.target !== target) throw new Error(`Migration file identity changed: ${id}`);
    if (previous?.state === 'committed') return;
    const source = previous?.source ?? await resolveSource?.();
    pending.file_actions[id] = { id, target, source, state: 'writing' };
    await save();
    await perform(target, source);
    pending.file_actions[id].state = 'committed';
    await save();
  };
  const journal = {
    fileTarget(id) { return pending.file_actions[id]?.target; },
    filesFor(prefix) {
      return Object.values(pending.file_actions).filter(entry => entry.id.startsWith(prefix));
    },
    async identifyRemoval(id, target) {
      target = resolve(target);
      if (!within(dataRoot, target) || (pending.file_actions[id] && pending.file_actions[id].target !== target)) {
        throw new Error(`Invalid migration removal target: ${id}`);
      }
      if (pending.file_actions[id]) return;
      pending.file_actions[id] = { id, target, state: 'planned' };
      await save();
    },
    async json(id, target, value) { return action(id, target, path => writeJson(path, value)); },
    async remove(id, target) {
      return action(id, target, path => unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; }));
    },
    async preserve(id, source, target) {
      return action(id, target, async (path, original) => {
        if (await ordinaryFile(path)) return; // Original is immutable during the conversion.
        const staged = `${path}.${state.migration_id}.incoming`;
        await ordinaryFile(staged);
        await copyFile(original, staged);
        const handle = await open(staged, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await rename(staged, path);
      }, async () => {
        const original = await realpath(source);
        const roots = [await realpath(dataRoot), await realpath(join(appRoot, 'releases'))];
        if (!roots.some(root => within(root, original)) || !await ordinaryFile(original)) {
          throw new Error(`Registered material is outside the existing material or release directory: ${id}`);
        }
        return original;
      });
    },
    async step(store, name, work) {
      const key = `${state.migration_id}:${name}`;
      const db = store.db;
      store.transaction(() => {
        db.exec('CREATE TABLE IF NOT EXISTS summon_install_steps (id TEXT PRIMARY KEY)');
        if (db.prepare('SELECT id FROM summon_install_steps WHERE id=?').get(key)) return;
        work();
        db.prepare('INSERT INTO summon_install_steps(id) VALUES (?)').run(key);
      });
      pending.stores[name] = 'committed';
      await save();
    },
    applied(store, name) {
      const exists = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='summon_install_steps'").get();
      return Boolean(exists && store.db.prepare('SELECT 1 FROM summon_install_steps WHERE id=?').get(`${state.migration_id}:${name}`));
    },
  };
  if (state.previous_format === 1) {
    const { convertLegacyData } = await import('./r2-conversion.mjs');
    await convertLegacyData({ dataRoot, appRoot, state: pending, journal, deployment, defaultLimits });
  }
  if (publicOrigin) {
    const path = join(dataRoot, 'config', 'remote-access.json');
    const access = await readJson(path).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
    const url = new URL(publicOrigin);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid configured public origin');
    if (!access.cloudflare) await journal.json('public-origin', path, { ...access, cloudflare: { origin: url.origin, owner: 'external' } });
  }
  const next = { ...deployment, schemaVersion: 4, dataFormat: state.target_format, releaseRoot: state.release_root,
    runIntent: state.previousIntent, limits: { ...defaultLimits, ...deployment.limits },
    ...(state.source_root ? { sourceRoot: state.source_root } : {}) };
  await journal.json('deployment', join(dataRoot, 'config', `deployment.${state.migration_id}.json`), next);
  return pending;
}
