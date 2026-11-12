import { randomUUID } from 'node:crypto';

const WORKSPACE_COLLECTIONS = ['bots', 'rooms', 'works', 'agentRuns', 'activity', 'routines',
  'knowledge.nodes', 'knowledge.edges', 'runtime.jobs'];
const ROOM_COLLECTIONS = ['messages', 'jobs'];
const emptyPatch = () => ({ values: {}, collections: {} });
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const atPath = (value, path) => path.split('.').reduce((parent, key) => parent?.[key], value);

// A transport page belongs to one captured snapshot or patch. A client only
// advances its existing cursor after it has received the matching end frame.
export function* syncPages(value) {
  const { snapshot, patch, ...header } = value;
  const field = snapshot ? 'snapshot' : 'patch';
  const line = item => JSON.stringify(item) + '\n';
  function* branch(path, data, depth = 0) {
    if (Array.isArray(data) && data.length) {
      for (let index = 0; index < data.length; index += 64)
        yield line({ path, append: data.slice(index, index + 64) });
    } else if (data && typeof data === 'object' && !Array.isArray(data) && depth > 0 && Object.keys(data).length) {
      for (const [key, child] of Object.entries(data)) yield* branch([...path, key], child, depth - 1);
    } else yield line({ path, value: data });
  }
  yield line({ header, field });
  for (const [key, data] of Object.entries(snapshot || patch)) {
    const depth = field === 'patch' && key === 'collections' ? 2 : field === 'snapshot' && ['knowledge', 'runtime'].includes(key) ? 1 : 0;
    yield* branch([key], data, depth);
  }
  yield line({ end: value.sync.cursor });
}

// Group scalar/object branches separately from record collections. In particular,
// changing a lane counter never resends runtime.jobs or the entire workspace.
function valuesOf(snapshot, collectionPaths) {
  const values = {};
  const walk = (value, prefix = '') => {
    for (const [key, child] of Object.entries(value || {})) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (collectionPaths.includes(path)) continue;
      if (collectionPaths.some(collection => collection.startsWith(`${path}.`))) walk(child, path);
      else values[path] = child;
    }
  };
  walk(snapshot);
  return values;
}

function diffSnapshots(previous, current, collectionPaths) {
  const patch = emptyPatch();
  const beforeValues = valuesOf(previous, collectionPaths);
  const afterValues = valuesOf(current, collectionPaths);
  for (const path of new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)])) {
    if (!equal(beforeValues[path], afterValues[path])) patch.values[path] = afterValues[path] ?? null;
  }
  for (const path of collectionPaths) {
    const before = atPath(previous, path) || [];
    const after = atPath(current, path) || [];
    const beforeMap = new Map(before.map(record => [record.id, record]));
    const afterMap = new Map(after.map(record => [record.id, record]));
    const upserts = after.filter(record => !equal(beforeMap.get(record.id), record));
    const removed = before.filter(record => !afterMap.has(record.id)).map(record => record.id);
    const beforeOrder = before.map(record => record.id);
    const afterOrder = after.map(record => record.id);
    const reordered = !equal(beforeOrder, afterOrder);
    if (upserts.length || removed.length || reordered) {
      patch.collections[path] = { upserts, removed, ...(reordered ? { order: afterOrder } : {}) };
    }
  }
  return patch;
}

function combinePatches(patches) {
  const result = emptyPatch();
  const collections = new Map();
  for (const patch of patches) {
    Object.assign(result.values, patch.values);
    for (const [path, changes] of Object.entries(patch.collections)) {
      let combined = collections.get(path);
      if (!combined) collections.set(path, combined = { upserts: new Map(), removed: new Set() });
      for (const id of changes.removed) {
        combined.upserts.delete(id);
        combined.removed.add(id);
      }
      for (const record of changes.upserts) {
        combined.removed.delete(record.id);
        combined.upserts.set(record.id, record);
      }
      if (changes.order) combined.order = changes.order;
    }
  }
  for (const [path, combined] of collections) result.collections[path] = {
    upserts: [...combined.upserts.values()], removed: [...combined.removed],
    ...(combined.order ? { order: combined.order } : {}),
  };
  return result;
}

function readCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || !/^[\w-]+$/.test(cursor)) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return value && value.v === 1 && typeof value.s === 'string' && typeof value.e === 'string'
      && Number.isSafeInteger(value.r) && value.r >= 1 ? value : null;
  } catch { return null; }
}

/** Durable transport cache; never modifies the underlying business records. */
export class IncrementalSync {
  constructor(store, { historyLimit = 1024 } = {}) {
    this.store = store;
    this.historyLimit = Math.max(1, Math.min(4096, Math.floor(Number(historyLimit) || 1024)));
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_scopes_v1 (
        scope TEXT PRIMARY KEY, epoch TEXT NOT NULL, revision INTEGER NOT NULL, snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_journal_v1 (
        scope TEXT NOT NULL, revision INTEGER NOT NULL, patch TEXT NOT NULL,
        PRIMARY KEY (scope, revision)
      );
    `);
    this.readScope = store.db.prepare('SELECT epoch, revision, snapshot FROM sync_scopes_v1 WHERE scope = ?');
    this.writeScope = store.db.prepare(`INSERT INTO sync_scopes_v1(scope,epoch,revision,snapshot) VALUES(?,?,?,?)
      ON CONFLICT(scope) DO UPDATE SET epoch=excluded.epoch, revision=excluded.revision, snapshot=excluded.snapshot`);
    this.writePatch = store.db.prepare('INSERT INTO sync_journal_v1(scope,revision,patch) VALUES(?,?,?)');
    this.readPatches = store.db.prepare('SELECT revision, patch FROM sync_journal_v1 WHERE scope = ? AND revision > ? ORDER BY revision');
    this.prunePatches = store.db.prepare('DELETE FROM sync_journal_v1 WHERE scope = ? AND revision <= ?');
  }

  respond(scope, snapshot, since) {
    const collectionPaths = scope === 'workspace' || scope.startsWith('workspace:') ? WORKSPACE_COLLECTIONS
      : scope.startsWith('room:') ? ROOM_COLLECTIONS : null;
    if (!collectionPaths) throw new TypeError('Unknown incremental sync scope');
    // Normalize once so undefined fields cannot differ from their persisted JSON.
    const serialized = JSON.stringify(snapshot);
    const current = JSON.parse(serialized);
    return this.store.transaction(() => {
      let state = this.readScope.get(scope);
      if (!state) {
        state = { epoch: randomUUID(), revision: 1, snapshot: serialized };
        this.writeScope.run(scope, state.epoch, state.revision, serialized);
      } else if (state.snapshot !== serialized) {
        const patch = diffSnapshots(JSON.parse(state.snapshot), current, collectionPaths);
        if (Object.keys(patch.values).length || Object.keys(patch.collections).length) {
          state.revision++;
          this.writePatch.run(scope, state.revision, JSON.stringify(patch));
          this.prunePatches.run(scope, state.revision - this.historyLimit);
        }
        this.writeScope.run(scope, state.epoch, state.revision, serialized);
      }
      const cursor = Buffer.from(JSON.stringify({ v: 1, s: scope, e: state.epoch, r: state.revision })).toString('base64url');
      const sync = { version: 1, scope, cursor, reset: false };
      const requested = readCursor(since);
      const reset = () => ({ sync: { ...sync, reset: true }, snapshot: current });
      if (!requested || requested.s !== scope || requested.e !== state.epoch || requested.r > state.revision) return reset();
      if (requested.r === state.revision) return { sync, patch: emptyPatch() };
      const rows = this.readPatches.all(scope, requested.r);
      // A missing journal revision means this client's baseline has expired.
      if (rows.length !== state.revision - requested.r || rows.some((row, index) => row.revision !== requested.r + index + 1)) return reset();
      return { sync, patch: combinePatches(rows.map(row => JSON.parse(row.patch))) };
    });
  }
}
