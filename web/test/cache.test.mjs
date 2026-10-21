import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/cache.js', import.meta.url), 'utf8');
const clone = value => structuredClone(value);
const workspace = () => ({
  bots: [{ id: 'bot-a', name: 'A' }], rooms: [{ id: 'room-a' }], works: [], agentRuns: [],
  activity: [], routines: [], knowledge: { nodes: [], edges: [] },
  runtime: { jobs: [], started: true, fast: { running: 0 }, deep: { running: 0 } },
  provider: { configured: true }, defaultCwd: 'D:/Relay-Bot',
});
const room = () => ({ room: { id: 'room-a' }, messages: [{ id: 'message-a', roomId: 'room-a', content: '已有消息' }], jobs: [] });
const envelope = (scope, patch) => ({ sync: { version: 1, scope, cursor: 'cursor-2', reset: false }, patch: { values: {}, collections: {}, ...patch } });

function fakeStorage() {
  const stores = new Map();
  const commits = [];
  const control = { failWrites: false, writeDelays: [], reads: 0, opens: 0 };
  const database = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore(name) { stores.set(name, new Map()); },
    close() {},
    transaction(name, mode) {
      const tx = {
        objectStore() {
          return {
            get(key) {
              const request = {};
              setTimeout(() => {
                control.reads++;
                request.result = clone(stores.get(name)?.get(key));
                request.onsuccess?.();
                tx.oncomplete?.();
              }, 1);
              return request;
            },
            put(value, key) {
              const request = {};
              setTimeout(() => {
                if (control.failWrites) {
                  tx.error = new Error('QuotaExceededError');
                  tx.onabort?.(); return;
                }
                stores.get(name).set(key, clone(value));
                commits.push({ name, key, value: clone(value) });
                request.result = key; request.onsuccess?.(); tx.oncomplete?.();
              }, control.writeDelays.shift() ?? 1);
              return request;
            },
          };
        },
        abort() { tx.onabort?.(); },
      };
      assert.ok(['readwrite', 'readonly'].includes(mode));
      return tx;
    },
  };
  const indexedDB = {
    open(name, version) {
      assert.equal(name, 'relay-workspace-v1'); assert.equal(version, 1); control.opens++;
      const request = {};
      setTimeout(() => {
        request.result = database;
        request.onupgradeneeded?.(); request.onsuccess?.();
      }, 1);
      return request;
    },
  };
  return { indexedDB, stores, commits, control };
}

function load(indexedDB) {
  const window = { indexedDB };
  const context = vm.createContext({ window, structuredClone, setTimeout, clearTimeout, Date, console });
  vm.runInContext(source, context);
  return window.RelayCache;
}

test('snapshot and cursor survive a fresh page with complete message history', async () => {
  const storage = fakeStorage(), cache = load(storage.indexedDB);
  const history = room();
  history.messages = Array.from({ length: 1200 }, (_, index) => ({ id: `message-${index}`, roomId: 'room-a', content: `消息 ${index}` }));
  await cache.writeWorkspace({ snapshot: workspace(), cursor: 'workspace-1' });
  await cache.writeRoom('room-a', { snapshot: history, cursor: 'room-1' });
  await cache.writeSession({ roomId: 'room-a', drafts: { 'room-a': '未发送' }, localMessages: {} });
  const fresh = load(storage.indexedDB);
  assert.equal((await fresh.readWorkspace()).cursor, 'workspace-1');
  assert.equal((await fresh.readRoom('room-a')).snapshot.messages.length, 1200);
  assert.equal((await fresh.readRoom('room-a')).cursor, 'room-1');
  assert.equal((await fresh.readSession()).drafts['room-a'], '未发送');
  assert.equal(fresh.status.persistent, true);
});

test('writes serialize per key and reads wait for the latest atomically paired cursor', async () => {
  const storage = fakeStorage(), cache = load(storage.indexedDB);
  storage.control.writeDelays.push(25, 1);
  const first = room(), second = room();
  second.messages.push({ id: 'message-b', roomId: 'room-a', content: '新的消息' });
  const one = cache.writeRoom('room-a', { snapshot: first, cursor: 'one' });
  const two = cache.writeRoom('room-a', { snapshot: second, cursor: 'two' });
  second.messages[1].content = '调用方之后的修改';
  const received = await cache.readRoom('room-a');
  await Promise.all([one, two]);
  assert.equal(received.cursor, 'two');
  assert.equal(received.snapshot.messages[1].content, '新的消息');
  assert.deepEqual(storage.commits.map(commit => commit.value.cursor), ['one', 'two']);
});

test('quota failure preserves the newest full record in memory without throwing', async () => {
  const storage = fakeStorage(), cache = load(storage.indexedDB);
  await cache.writeRoom('room-a', { snapshot: room(), cursor: 'old' });
  storage.control.failWrites = true;
  const updated = room(); updated.messages.push({ id: 'new', content: '新消息' });
  assert.equal(await cache.writeRoom('room-a', { snapshot: updated, cursor: 'new' }), true);
  const received = await cache.readRoom('room-a');
  assert.equal(received.cursor, 'new'); assert.equal(received.snapshot.messages.length, 2);
  assert.equal(cache.status.persistent, false);
  assert.match(cache.status.error, /QuotaExceeded/);
  assert.equal(storage.stores.get('rooms').get('room-a').cursor, 'old');
});

test('unavailable IndexedDB falls back to isolated memory records and defensive copies', async () => {
  const cache = load(undefined);
  const status = await cache.ready();
  assert.equal(status.persistent, false);
  await cache.writeRoom('room-a', { snapshot: room(), cursor: 'a' });
  const received = await cache.readRoom('room-a'); received.snapshot.messages.length = 0;
  assert.equal((await cache.readRoom('room-a')).snapshot.messages.length, 1);
  assert.equal(await cache.readRoom('room-b'), null);
  assert.equal(await load(undefined).readRoom('room-a'), null);
});

test('corrupt persisted snapshots and invalid writes cannot block startup', async () => {
  const storage = fakeStorage(), cache = load(storage.indexedDB);
  await cache.ready();
  storage.stores.get('workspace').set('current', { schema: 1, savedAt: Date.now(), cursor: 'bad', snapshot: { bots: {}, rooms: [] } });
  storage.stores.get('rooms').set('room-a', { schema: 1, savedAt: Date.now(), cursor: 'bad', snapshot: { ...room(), messages: [{ id: 'same' }, { id: 'same' }] } });
  assert.equal(await cache.readWorkspace(), null);
  assert.equal(await cache.readRoom('room-a'), null);
  assert.equal(await cache.writeRoom('room-a', { snapshot: { messages: [], jobs: [] }, cursor: 'bad' }), false);
  assert.equal(await cache.writeSession(null), false);
  assert.equal(await cache.writeWorkspace({ snapshot: workspace(), cursor: 'good' }), true);
  assert.equal((await cache.readWorkspace()).cursor, 'good');
});

test('reset produces a standalone defensive snapshot', () => {
  const cache = load(), snapshot = workspace();
  const result = cache.applySync(null, { sync: { version: 1, scope: 'workspace', cursor: 'reset', reset: true }, snapshot });
  result.bots[0].name = 'changed';
  assert.equal(snapshot.bots[0].name, 'A');
});

test('room delta updates changed records, removes records, and follows exact server order', () => {
  const cache = load(), previous = room();
  previous.messages.push({ id: 'obsolete', content: 'old' });
  const next = cache.applySync(previous, envelope('room:room-a', {
    values: { room: { id: 'room-a', title: '新标题' } },
    collections: { messages: {
      upserts: [{ id: 'message-a', content: '修订' }, { id: 'message-b', content: '新增' }],
      removed: ['obsolete'], order: ['message-b', 'message-a'],
    } },
  }));
  assert.deepEqual(next.messages.map(message => message.id), ['message-b', 'message-a']);
  assert.equal(next.messages[1].content, '修订');
  assert.equal(next.room.title, '新标题');
  assert.equal(previous.messages[0].content, '已有消息');
  assert.equal(previous.messages[1].id, 'obsolete');
});

test('workspace nested arrays and scalar values merge without destroying siblings', () => {
  const cache = load(), previous = workspace();
  const next = cache.applySync(previous, envelope('workspace', {
    values: { 'runtime.fast': { running: 1 }, provider: { configured: false } },
    collections: { 'runtime.jobs': { upserts: [{ id: 'job-a' }], removed: [], order: ['job-a'] }, 'knowledge.nodes': { upserts: [{ id: 'node-a' }], removed: [], order: ['node-a'] } },
  }));
  assert.equal(next.runtime.fast.running, 1); assert.equal(next.runtime.deep.running, 0);
  assert.equal(next.runtime.jobs[0].id, 'job-a'); assert.equal(next.knowledge.nodes[0].id, 'node-a');
  assert.deepEqual(next.knowledge.edges, []); assert.equal(previous.runtime.jobs.length, 0);
});

test('empty delta keeps all earlier history and rejects missing incremental bases', () => {
  const cache = load();
  assert.deepEqual(cache.applySync(room(), envelope('room:room-a')), room());
  assert.throws(() => cache.applySync(null, envelope('room:room-a')));
  assert.throws(() => cache.applySync(room(), envelope('room:another-room')));
});

test('unknown and prototype-related dot paths are rejected without modifying prototypes', () => {
  const cache = load();
  for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'runtime.__proto__', 'unknown', 'messages']) {
    assert.throws(() => cache.applySync(workspace(), envelope('workspace', { values: { [path]: true } })));
  }
  assert.throws(() => cache.applySync(workspace(), envelope('workspace', { collections: { '__proto__.items': { upserts: [], removed: [] } } })));
  assert.equal({}.polluted, undefined);
});

test('duplicate IDs, conflicting changes, and incomplete orders fail the whole patch', () => {
  const cache = load(), previous = room();
  const invalid = [
    { upserts: [{ id: 'x' }, { id: 'x' }], removed: [] },
    { upserts: [{ id: 'x' }], removed: ['x'] },
    { upserts: [], removed: ['x', 'x'] },
    { upserts: [], removed: [], order: [] },
    { upserts: [{ id: 'x' }], removed: [], order: ['x', 'x'] },
    { upserts: [], removed: [], order: ['missing'] },
    { upserts: [], removed: [], unexpected: true },
    { upserts: [{ id: 'x' }], removed: [] },
  ];
  for (const change of invalid) assert.throws(() => cache.applySync(previous, envelope('room:room-a', { collections: { messages: change } })));
  assert.deepEqual(previous, room());
});

test('a combined offline delta can remove a record the client never saw', () => {
  const cache = load(), previous = room();
  const result = cache.applySync(previous, envelope('room:room-a', {
    collections: { messages: { upserts: [], removed: ['temporary'], order: ['message-a'] } },
  }));
  assert.deepEqual(result, previous);
});

test('invalid sync versions, scopes, cursors and snapshot collections are rejected', () => {
  const cache = load(), base = { sync: { version: 1, scope: 'workspace', cursor: 'one', reset: true }, snapshot: workspace() };
  for (const overrides of [{ version: 2 }, { scope: 'unknown' }, { cursor: '' }, { reset: 1 }]) {
    assert.throws(() => cache.applySync(null, { ...base, sync: { ...base.sync, ...overrides } }));
  }
  assert.throws(() => cache.applySync(null, { ...base, snapshot: { ...workspace(), knowledge: { nodes: {}, edges: [] } } }));
  assert.throws(() => cache.applySync(null, { ...base, snapshot: { ...workspace(), knowledge: null } }));
  assert.throws(() => cache.applySync(workspace(), envelope('workspace', { values: { provider: [] } })));
});

