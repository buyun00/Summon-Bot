(() => {
  'use strict';

  const workspaceId = new URLSearchParams(location.search).get('workspace');
  const workspaceScope = workspaceId ? 'workspace:' + workspaceId : 'workspace';
  const roomScope = id => 'room:' + (workspaceId ? workspaceId + ':' : '') + id;
  const roomPrefix = roomScope('');
  const databaseName = 'summon-workspace-v1' + (workspaceId ? '-' + workspaceId : '');
  const collectionPaths = {
    workspace: ['bots', 'rooms', 'executions', 'files', 'wakeups', 'connections'],
    room: ['messages'],
  };
  const valuePaths = {
    workspace: ['historyEpoch', 'workspaceProfileId', 'modelSettings', 'limits', 'protocolVersion'],
    room: ['historyEpoch', 'room', 'cursor', 'deliveries'],
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const getPath = (value, path) => path.split('.').reduce((parent, key) => object(parent) && own(parent, key) ? parent[key] : undefined, value);
  const kindOf = scope => scope === workspaceScope ? 'workspace'
    : typeof scope === 'string' && scope.startsWith(roomPrefix) && scope.length > roomPrefix.length ? 'room' : null;
  const validId = id => typeof id === 'string' && id.length > 0;

  function collectionValid(items) {
    if (!Array.isArray(items)) return false;
    const ids = new Set();
    return items.every(item => {
      if (!object(item) || !validId(item.id) || ids.has(item.id)) return false;
      ids.add(item.id); return true;
    });
  }

  function snapshotValid(snapshot, scope) {
    const kind = kindOf(scope);
    if (!kind || !object(snapshot)) return false;
    if (kind === 'workspace' && (snapshot.protocolVersion !== 2 || (snapshot.workspaceProfileId ?? null) !== (workspaceId ?? null)
      || !Array.isArray(snapshot.bots) || !Array.isArray(snapshot.rooms))) return false;
    if (kind === 'room' && (!object(snapshot.room) || snapshot.room.id !== scope.slice(roomPrefix.length) || !Number.isSafeInteger(snapshot.room.revision)
      || !Array.isArray(snapshot.room.pins) || !Array.isArray(snapshot.messages) || !object(snapshot.deliveries))) return false;
    return valuePaths[kind].every(path => {
      const value = getPath(snapshot, path);
      if (value === undefined) return true;
      if (path === 'historyEpoch' || path === 'cursor' || path === 'workspaceProfileId') return value === null || validId(value);
      if (path === 'protocolVersion') return value === 2;
      return object(value);
    }) && collectionPaths[kind].every(path => {
      const value = getPath(snapshot, path);
      return value === undefined || collectionValid(value);
    });
  }

  function putPath(target, path, value) {
    const parts = path.split('.');
    const key = parts.pop();
    let parent = target;
    for (const part of parts) {
      if (!object(parent[part])) throw new Error('同步字段的父对象不存在');
      parent = parent[part];
    }
    parent[key] = value;
  }

  // The cursor belongs to the complete snapshot. Never trim collections while
  // retaining a cursor, or a later delta could silently leave history missing.
  function applySync(previous, response) {
    const sync = response?.sync, kind = kindOf(sync?.scope);
    if (!object(response) || !object(sync) || sync.version !== 1 || !kind || !validId(sync.cursor) || typeof sync.reset !== 'boolean') throw new Error('无效的同步响应');
    if (sync.reset) {
      if (!snapshotValid(response.snapshot, sync.scope)) throw new Error('无效的完整同步数据');
      return copy(response.snapshot);
    }
    if (!snapshotValid(previous, sync.scope) || !object(response.patch)) throw new Error('缺少增量同步的完整基础数据');
    if (own(response, 'historyEpoch') && (previous.historyEpoch ?? null) !== response.historyEpoch) throw new Error('历史已清空，需要重新读取完整数据');
    const patch = response.patch;
    if (Object.keys(patch).some(key => !['values', 'collections'].includes(key))) throw new Error('未知的同步操作');
    if (!object(patch.values) || !object(patch.collections)) throw new Error('无效的增量同步数据');
    const result = copy(previous);
    for (const [path, value] of Object.entries(patch.values)) {
      if (!valuePaths[kind].includes(path)) throw new Error('未知的同步字段');
      putPath(result, path, copy(value));
    }
    for (const [path, change] of Object.entries(patch.collections)) {
      if (!collectionPaths[kind].includes(path) || !object(change) || Object.keys(change).some(key => !['upserts', 'removed', 'order'].includes(key))) throw new Error('未知的同步集合');
      const current = getPath(result, path);
      if (!collectionValid(current) || !collectionValid(change.upserts) || !Array.isArray(change.removed) || change.removed.some(id => !validId(id)) || new Set(change.removed).size !== change.removed.length) throw new Error('无效的同步集合');
      const records = new Map(current.map(item => [item.id, item]));
      const removed = new Set(change.removed);
      if (change.upserts.some(item => removed.has(item.id))) throw new Error('同步记录同时被删除和修改');
      // A combined delta may remove an item created and deleted while this
      // client was offline; deleting an absent ID is intentionally harmless.
      const idsChanged = removed.size > 0 || change.upserts.some(item => !records.has(item.id));
      if (idsChanged && !own(change, 'order')) throw new Error('同步记录变化后缺少完整顺序');
      for (const id of removed) records.delete(id);
      for (const item of change.upserts) records.set(item.id, copy(item));
      let items = [...records.values()];
      if (own(change, 'order')) {
        if (!Array.isArray(change.order) || change.order.length !== records.size || new Set(change.order).size !== records.size || change.order.some(id => !validId(id) || !records.has(id))) throw new Error('无效的同步顺序');
        items = change.order.map(id => records.get(id));
      }
      putPath(result, path, items);
    }
    if (!snapshotValid(result, sync.scope)) throw new Error('增量同步结果不完整');
    return result;
  }

  const memory = new Map();
  const queues = new Map();
  const removedRooms = new Set();
  const storageStatus = { persistent: false, error: null };
  let database = null, opening = null, retryAt = 0, generation = 0, resetBarrier = Promise.resolve(), pendingReset = null;
  let sessionObserved = false;

  function clearPersistedHistory(db, record) {
    return new Promise((resolve, reject) => {
      let tx;
      const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(new Error('清除历史缓存超时')); }, 2500);
      try {
        tx = db.transaction(['workspace', 'rooms', 'session'], 'readwrite');
        for (const name of ['workspace', 'rooms', 'session']) tx.objectStore(name).clear();
        tx.objectStore('session').put(record, 'current');
        tx.oncomplete = () => finish();
        tx.onerror = tx.onabort = () => finish(tx.error || new Error('无法清除历史缓存'));
      } catch (error) { finish(error); }
    });
  }

  // Drain writes captured before the reset, then erase all conversation stores
  // in one transaction. New reads/writes wait behind this barrier.
  function resetHistory(historyEpoch, session = {}) {
    const pending = [...queues.values()], previousBarrier = resetBarrier;
    generation++; memory.clear();
    const record = { schema: 1, savedAt: Date.now(), value: { ...copy(session), historyEpoch } };
    const reset = previousBarrier.then(async () => {
      await Promise.allSettled(pending);
      memory.clear(); removedRooms.clear();
      memory.set('session:current', record);
      pendingReset = record;
      if (database) {
        try {
          await clearPersistedHistory(database, record);
          pendingReset = null;
          sessionObserved = true;
        } catch (error) { unavailable(error); }
      }
      return true;
    });
    resetBarrier = reset.catch(() => {});
    return reset;
  }

  function recordError(error) {
    storageStatus.error = String(error?.message || error || '浏览器本地存储不可用');
  }
  function unavailable(error) {
    recordError(error);
    storageStatus.persistent = false;
    retryAt = Date.now() + 2500;
    try { database?.close(); } catch { /* Already closed. */ }
    database = null;
  }

  function ready() {
    if (opening) return opening;
    if (database || Date.now() < retryAt) return Promise.resolve({ ...storageStatus });
    opening = new Promise(resolve => {
      let request, settled = false;
      const finish = async (db, error) => {
        if (settled) { try { db?.close(); } catch { /* Late open. */ } return; }
        settled = true; clearTimeout(timer);
        if (db) {
          if (pendingReset) {
            try {
              const record = memory.get('session:current') || pendingReset;
              await clearPersistedHistory(db, record);
              pendingReset = null;
              sessionObserved = true;
            } catch (error) {
              db.close();
              unavailable(error);
              resolve({ ...storageStatus });
              return;
            }
          }
          database = db; storageStatus.persistent = true; storageStatus.error = null;
          db.onversionchange = () => unavailable('本地存储版本已更新');
          db.onclose = () => { if (database === db) unavailable('本地存储连接已关闭'); };
        } else unavailable(error);
        resolve({ ...storageStatus });
      };
      const timer = setTimeout(() => finish(null, '打开本地存储超时'), 1500);
      Promise.resolve(window.SummonStorageMigration).then(() => {
        if (settled) return;
        if (!window.indexedDB) { void finish(null, '浏览器未提供本地数据库'); return; }
        request = window.indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of ['workspace', 'rooms', 'session']) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        };
        request.onsuccess = () => void finish(request.result);
        request.onerror = () => void finish(null, request.error || '无法打开本地存储');
        request.onblocked = () => void finish(null, '本地存储正在被其他页面更新');
      }).catch(error => void finish(null, error));
    }).finally(() => { opening = null; });
    return opening;
  }

  function transact(store, key, value, writing) {
    return new Promise((resolve, reject) => {
      let tx, result, settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => {
        try { tx?.abort(); } catch { /* Transaction may already have finished. */ }
        finish(new Error('本地存储操作超时'));
      }, 2500);
      try {
        tx = database.transaction(store, writing ? 'readwrite' : 'readonly');
        const records = tx.objectStore(store);
        const request = !writing ? records.get(key) : value === undefined ? records.delete(key) : records.put(value, key);
        request.onsuccess = () => { result = request.result; };
        request.onerror = () => finish(request.error || new Error('本地存储读写失败'));
        tx.oncomplete = () => finish();
        tx.onerror = () => finish(tx.error || new Error('本地存储事务失败'));
        tx.onabort = () => finish(tx.error || new Error('本地存储事务取消'));
      } catch (error) { finish(error); }
    });
  }

  function serialize(store, key, action) {
    const queueKey = `${store}:${key}`;
    const next = (queues.get(queueKey) || Promise.resolve()).then(action, action);
    queues.set(queueKey, next);
    next.finally(() => { if (queues.get(queueKey) === next) queues.delete(queueKey); }).catch(() => {});
    return next;
  }

  function recordValid(record, scope) {
    return object(record) && record.schema === 1 && Number.isFinite(record.savedAt) && (record.cursor === null || validId(record.cursor)) && snapshotValid(record.snapshot, scope);
  }

  async function read(store, key, validate) {
    const capturedGeneration = generation, barrier = resetBarrier;
    return serialize(store, key, async () => {
      try {
        await barrier;
        if (capturedGeneration !== generation || store === 'rooms' && removedRooms.has(key)) return null;
        await ready();
        const memoryKey = `${store}:${key}`;
        let record = memory.get(memoryKey);
        if (database) {
          try {
            const saved = await transact(store, key, undefined, false);
            if (store === 'session') sessionObserved = true;
            if (validate(saved) && (!record || saved.savedAt >= record.savedAt)) {
              record = saved;
              memory.set(memoryKey, record);
            }
          } catch (error) { recordError(error); }
        }
        return capturedGeneration === generation && validate(record) ? copy(record) : null;
      } catch { return null; }
    });
  }

  function removeRoom(key) {
    const capturedGeneration = generation, barrier = resetBarrier;
    return serialize('rooms', key, async () => {
      await barrier;
      if (capturedGeneration !== generation) return;
      removedRooms.add(key);
      memory.delete('rooms:' + key);
      if (!database) return;
      try { await transact('rooms', key, undefined, true); } catch (error) { recordError(error); }
    });
  }

  function write(store, key, record, validate) {
    const capturedGeneration = generation, barrier = resetBarrier;
    let captured;
    try {
      if (!validate(record)) return Promise.resolve(false);
      // Capture synchronously so caller mutations cannot alter a queued write.
      captured = copy(record);
    } catch { return Promise.resolve(false); }
    return serialize(store, key, async () => {
      try {
        await barrier;
        if (capturedGeneration !== generation) return false;
        await ready();
        if (store === 'rooms') removedRooms.delete(key);
        memory.set(`${store}:${key}`, captured);
        if (database) {
          try {
            // A delayed database open may contain drafts this page has never loaded.
            if (store === 'session' && !sessionObserved && sessionValid(await transact(store,key,undefined,false))) return false;
            await transact(store, key, captured, true);
            if (store === 'session') sessionObserved = true;
          }
          catch (error) { recordError(error); return false; }
        }
        return true;
      } catch { return false; }
    });
  }

  const snapshotRecord = value => ({ schema: 1, savedAt: Date.now(), snapshot: value?.snapshot, cursor: value?.cursor ?? null });
  const sessionValid = record => object(record) && record.schema === 1 && Number.isFinite(record.savedAt) && object(record.value);
  window.SummonCache = Object.freeze({
    ready, applySync, resetHistory, removeRoom,
    get status() { return { ...storageStatus }; },
    readWorkspace: () => read('workspace', 'current', record => recordValid(record, workspaceScope)),
    writeWorkspace: value => write('workspace', 'current', snapshotRecord(value), record => recordValid(record, workspaceScope)),
    readRoom: roomId => validId(roomId) ? read('rooms', roomId, record => recordValid(record, roomScope(roomId))) : Promise.resolve(null),
    writeRoom: (roomId, value) => validId(roomId) ? write('rooms', roomId, snapshotRecord(value), record => recordValid(record, roomScope(roomId))) : Promise.resolve(false),
    readSession: async () => (await read('session', 'current', sessionValid))?.value || null,
    writeSession: value => write('session', 'current', { schema: 1, savedAt: Date.now(), value }, sessionValid),
  });
})();
