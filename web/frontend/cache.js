(() => {
  'use strict';

  const databaseName = 'relay-workspace-v1';
  const collectionPaths = {
    workspace: ['bots', 'rooms', 'works', 'agentRuns', 'activity', 'routines', 'knowledge.nodes', 'knowledge.edges', 'runtime.jobs'],
    room: ['messages', 'jobs'],
  };
  const valuePaths = {
    workspace: ['historyEpoch', 'provider', 'defaultCwd', 'runtime.started', 'runtime.fast', 'runtime.deep'],
    room: ['historyEpoch', 'room'],
  };
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const getPath = (value, path) => path.split('.').reduce((parent, key) => object(parent) && own(parent, key) ? parent[key] : undefined, value);
  const kindOf = scope => scope === 'workspace' ? 'workspace' : typeof scope === 'string' && scope.startsWith('room:') && scope.length > 5 ? 'room' : null;
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
    if (kind === 'workspace' && (!Array.isArray(snapshot.bots) || !Array.isArray(snapshot.rooms))) return false;
    if (kind === 'workspace' && ['knowledge', 'runtime'].some(key => own(snapshot, key) && !object(snapshot[key]))) return false;
    if (kind === 'room' && (!object(snapshot.room) || snapshot.room.id !== scope.slice(5) || !Array.isArray(snapshot.messages) || !Array.isArray(snapshot.jobs))) return false;
    return valuePaths[kind].every(path => {
      const value = getPath(snapshot, path);
      if (value === undefined) return true;
      if (path === 'historyEpoch') return value === null || validId(value);
      if (path === 'defaultCwd') return typeof value === 'string';
      if (path === 'runtime.started') return typeof value === 'boolean';
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
  const storageStatus = { persistent: false, error: null };
  let database = null, opening = null, generation = 0, resetBarrier = Promise.resolve();

  // Drain writes captured before the reset, then erase all conversation stores
  // in one transaction. New reads/writes wait behind this barrier.
  function resetHistory(historyEpoch, session = {}) {
    const pending = [...queues.values()], previousBarrier = resetBarrier;
    generation++; memory.clear();
    const record = { schema: 1, savedAt: Date.now(), value: { ...copy(session), historyEpoch } };
    const reset = previousBarrier.then(async () => {
      await Promise.allSettled(pending); await ready(); memory.clear();
      memory.set('session:current', record);
      if (database) {
        try {
          await new Promise((resolve, reject) => {
            let tx, settled = false;
            const finish = error => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
            const timer = setTimeout(() => { try { tx?.abort(); } catch {} finish(new Error('清除历史缓存超时')); }, 2500);
            try {
              tx = database.transaction(['workspace', 'rooms', 'session'], 'readwrite');
              for (const name of ['workspace', 'rooms', 'session']) tx.objectStore(name).clear();
              tx.objectStore('session').put(record, 'current');
              tx.oncomplete = () => finish(); tx.onerror = tx.onabort = () => finish(tx.error || new Error('无法清除历史缓存'));
            } catch (error) { finish(error); }
          });
        } catch (error) { unavailable(error); }
      }
      return true;
    });
    resetBarrier = reset.catch(() => {});
    return reset;
  }

  function unavailable(error) {
    storageStatus.persistent = false;
    storageStatus.error = String(error?.message || error || '浏览器本地存储不可用');
    try { database?.close(); } catch { /* Already closed. */ }
    database = null;
  }

  function ready() {
    if (opening) return opening;
    opening = new Promise(resolve => {
      let request, settled = false;
      const finish = (db, error) => {
        if (settled) { try { db?.close(); } catch { /* Late open. */ } return; }
        settled = true; clearTimeout(timer);
        if (db) {
          database = db; storageStatus.persistent = true; storageStatus.error = null;
          db.onversionchange = () => unavailable('本地存储版本已更新，请重新打开页面');
          db.onclose = () => { if (database === db) unavailable('本地存储连接已关闭'); };
        } else unavailable(error);
        resolve({ ...storageStatus });
      };
      const timer = setTimeout(() => finish(null, '打开本地存储超时'), 1500);
      try {
        if (!window.indexedDB) { finish(null, '浏览器未提供本地数据库'); return; }
        request = window.indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const store of ['workspace', 'rooms', 'session']) if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
        };
        request.onsuccess = () => finish(request.result);
        request.onerror = () => finish(null, request.error || '无法打开本地存储');
        request.onblocked = () => finish(null, '本地存储正在被其他页面更新');
      } catch (error) { finish(null, error); }
    });
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
        const request = writing ? tx.objectStore(store).put(value, key) : tx.objectStore(store).get(key);
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
        if (capturedGeneration !== generation) return null;
        await ready();
        const memoryKey = `${store}:${key}`;
        let record = memory.get(memoryKey);
        if (database) {
          try {
            record = await transact(store, key, undefined, false);
            if (validate(record)) memory.set(memoryKey, record);
          } catch (error) { unavailable(error); }
        }
        return capturedGeneration === generation && validate(record) ? copy(record) : null;
      } catch { return null; }
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
        memory.set(`${store}:${key}`, captured);
        if (database) {
          try { await transact(store, key, captured, true); }
          catch (error) { unavailable(error); }
        }
        return true;
      } catch { return false; }
    });
  }

  const snapshotRecord = value => ({ schema: 1, savedAt: Date.now(), snapshot: value?.snapshot, cursor: value?.cursor ?? null });
  const sessionValid = record => object(record) && record.schema === 1 && Number.isFinite(record.savedAt) && object(record.value);
  window.RelayCache = Object.freeze({
    ready, applySync, resetHistory,
    get status() { return { ...storageStatus }; },
    readWorkspace: () => read('workspace', 'current', record => recordValid(record, 'workspace')),
    writeWorkspace: value => write('workspace', 'current', snapshotRecord(value), record => recordValid(record, 'workspace')),
    readRoom: roomId => validId(roomId) ? read('rooms', roomId, record => recordValid(record, `room:${roomId}`)) : Promise.resolve(null),
    writeRoom: (roomId, value) => validId(roomId) ? write('rooms', roomId, snapshotRecord(value), record => recordValid(record, `room:${roomId}`)) : Promise.resolve(false),
    readSession: async () => (await read('session', 'current', sessionValid))?.value || null,
    writeSession: value => write('session', 'current', { schema: 1, savedAt: Date.now(), value }, sessionValid),
  });
})();
