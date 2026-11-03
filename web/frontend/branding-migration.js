(() => {
  'use strict';

  // Convert each browser's saved state once; successful copies remove the old entries.
  for (const kind of ['localStorage', 'sessionStorage']) {
    try {
      const storage = window[kind];
      for (const key of Object.keys(storage).filter(key => key.startsWith('relay:'))) {
        const destination = `summon:${key.slice(6)}`;
        if (storage.getItem(destination) === null) storage.setItem(destination, storage.getItem(key));
        storage.removeItem(key);
      }
    } catch { /* Blocked storage must not prevent opening the application. */ }
  }

  window.SummonStorageMigration = (async () => {
    if (!window.indexedDB) return;
    try { if (localStorage.getItem('summon:branding-storage:v1') === 'done') return; } catch {}
    const previous = await new Promise((resolve, reject) => {
      let absent = false;
      const request = indexedDB.open('relay-workspace-v1');
      request.onupgradeneeded = () => { absent = true; request.transaction.abort(); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => absent ? resolve(null) : reject(request.error);
      request.onblocked = () => reject(new Error('本地数据正在其他页面中使用'));
    });
    if (previous) {
      let current;
      try {
        const names = [...previous.objectStoreNames];
        const records = await new Promise((resolve, reject) => {
          const transaction = previous.transaction(names, 'readonly');
          const values = [];
          for (const name of names) {
            const request = transaction.objectStore(name).openCursor();
            request.onsuccess = () => {
              const cursor = request.result;
              if (cursor) { values.push({ store: name, key: cursor.key, value: cursor.value }); cursor.continue(); }
            };
          }
          transaction.oncomplete = () => resolve(values);
          transaction.onabort = transaction.onerror = () => reject(transaction.error);
        });
        current = await new Promise((resolve, reject) => {
          const request = indexedDB.open('summon-workspace-v1', 1);
          request.onupgradeneeded = () => {
            for (const name of ['workspace', 'rooms', 'session']) request.result.createObjectStore(name);
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const transaction = current.transaction(['workspace', 'rooms', 'session'], 'readwrite');
          for (const record of records) {
            if (!current.objectStoreNames.contains(record.store)) continue;
            const store = transaction.objectStore(record.store), request = store.get(record.key);
            request.onsuccess = () => { if (request.result === undefined) store.put(record.value, record.key); };
          }
          transaction.oncomplete = resolve;
          transaction.onabort = transaction.onerror = () => reject(transaction.error);
        });
      } finally { previous.close(); current?.close(); }
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase('relay-workspace-v1');
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('请关闭仍在使用旧页面的标签页'));
      });
    }
    try { localStorage.setItem('summon:branding-storage:v1', 'done'); } catch {}
  })().catch(() => {});
})();
