(() => {
  'use strict';

  const draftKey = 'summon:update-drafts';
  const readKey = 'summon:room-read-markers:v1';
  const oldDatabase = /^summon-workspace-v1(?:-([0-9a-f-]{36}))?$/i;
  const legacyProfile = new URLSearchParams(location.search).get('workspace');

  function mergeBy(items, more, key) {
    return [...new Map([...items, ...more].map(item => [key(item), item])).values()];
  }

  function mergeSession(previous, next) {
    const merged = { ...previous, ...next };
    for (const key of ['drafts', 'targets', 'references', 'attachments', 'outbound']) {
      merged[key] = { ...previous[key], ...next[key] };
    }
    merged.executionInputs = mergeBy(previous.executionInputs || [], next.executionInputs || [], item => item[0]);
    merged.localMessages = { ...previous.localMessages };
    for (const [room, entries] of Object.entries(next.localMessages || {})) {
      merged.localMessages[room] = mergeBy(merged.localMessages[room] || [], entries, item => item.clientId);
    }
    return merged;
  }

  function open(name, create = false) {
    return new Promise((resolve, reject) => {
      let missing = false;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        if (create) {
          for (const store of ['state', 'rooms', 'session']) request.result.createObjectStore(store);
        } else {
          missing = true;
          request.transaction.abort();
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => missing ? resolve(null) : reject(request.error);
      request.onblocked = () => reject(new Error('本地数据正在其他页面中使用'));
    });
  }

  async function getSession(name) {
    const db = await open(name);
    if (!db) return null;
    try {
      if (!db.objectStoreNames.contains('session')) return null;
      return await new Promise((resolve, reject) => {
        const request = db.transaction('session').objectStore('session').get('current');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  }

  async function writeSession(records) {
    const db = await open('summon-state-v1', true);
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('session', 'readwrite');
        const store = tx.objectStore('session');
        const request = store.get('current');
        request.onsuccess = () => {
          const ordered = [...records, request.result].filter(record => record?.value)
            .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
          if (ordered.length) store.put({ schema: 1, savedAt: Date.now(),
            value: ordered.reduce((value, record) => mergeSession(value, record.value), {}) }, 'current');
        };
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }

  function removeDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = request.onblocked = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  window.SummonStorageMigration = (async () => {
    const drafts = [], draftStores = [], profiles = new Set();
    if (/^[0-9a-f-]{36}$/i.test(legacyProfile || '')) profiles.add(legacyProfile);

    for (const kind of ['localStorage', 'sessionStorage']) {
      try {
        const storage = window[kind];
        for (const key of Object.keys(storage).filter(key => key.startsWith('relay:'))) {
          const destination = 'summon:' + key.slice(6);
          if (storage.getItem(destination) === null) storage.setItem(destination, storage.getItem(key));
          storage.removeItem(key);
        }
        const matches = key => Object.keys(storage).filter(item => item.startsWith(key + ':'));
        const draftKeys = matches(draftKey);
        for (const key of draftKeys) profiles.add(key.slice(draftKey.length + 1));
        const ordered = [...draftKeys, draftKey].flatMap(key => {
          try {
            const value = JSON.parse(storage.getItem(key));
            return value ? [value] : [];
          } catch { return []; }
        }).sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
        if (ordered.length) {
          const value = ordered.reduce(mergeSession, {});
          drafts.push({ value, savedAt: value.savedAt });
          draftStores.push(storage);
          if (draftKeys.length) {
            storage.setItem(draftKey, JSON.stringify(value));
            for (const key of draftKeys) storage.removeItem(key);
          }
        }
        const readKeys = matches(readKey);
        for (const key of readKeys) profiles.add(key.slice(readKey.length + 1));
        if (readKeys.length) {
          let markers;
          for (const key of [readKey, ...readKeys]) {
            let record;
            try { record = JSON.parse(storage.getItem(key)); } catch { continue; }
            if (!record?.rooms) continue;
            markers ??= { historyEpoch: record.historyEpoch, rooms: {} };
            if (markers.historyEpoch === record.historyEpoch) Object.assign(markers.rooms, record.rooms);
          }
          if (markers) {
            storage.setItem(readKey, JSON.stringify(markers));
            for (const key of readKeys) storage.removeItem(key);
          }
        }
      } catch { /* Storage restrictions must not prevent sign-in. */ }
    }

    if (legacyProfile !== null) {
      const url = new URL(location.href);
      url.searchParams.delete('workspace');
      history.replaceState(history.state, '', url);
    }
    if (!window.indexedDB) return;
    const names = typeof indexedDB.databases === 'function'
      ? (await indexedDB.databases()).map(database => database.name)
        .filter(name => name === 'relay-workspace-v1' || oldDatabase.test(name))
      : ['relay-workspace-v1', 'summon-workspace-v1', ...[...profiles].map(id => 'summon-workspace-v1-' + id)];
    if (!names.length) return;
    const sessions = (await Promise.all(names.map(getSession))).filter(Boolean);
    if (drafts.length || sessions.length) {
      await writeSession([...drafts, ...sessions]);
      for (const storage of draftStores) {
        try { storage.removeItem(draftKey); } catch { /* Storage may be restricted. */ }
      }
    }
    await Promise.all(names.map(removeDatabase));
  })().catch(() => {});
})();
