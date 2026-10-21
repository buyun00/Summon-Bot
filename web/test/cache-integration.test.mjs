import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { RecordStore as Store } from '../../capabilities/shared/store.mjs';
import { IncrementalSync } from '../../capabilities/shared/sync.mjs';

const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const cacheSource = readFileSync(new URL('../frontend/cache.js', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('async function loadCurrent()'), source.indexOf('function scheduleRefresh()'));
const refreshCode = source.slice(source.indexOf('async function refresh('), source.indexOf('async function loadCurrent()'));
const outgoingCode = source.slice(source.indexOf('function localRoomMessages('), source.indexOf('function renderSendStatus('));
const attachmentCode = source.slice(source.indexOf('function attachmentUrl('), source.indexOf('function renderMessageAttachments('));
const updateDraftCode = source.slice(source.indexOf("const updateDraftKey ="), source.indexOf('// Local outgoing messages'));
const actionCode = source.slice(source.indexOf('async function act('), source.indexOf("document.addEventListener('click'"));
const bootstrapCode = source.slice(source.indexOf('applyDisplayPreferences(); renderTopbar();'), source.indexOf("const stream = new EventSource("));
const copy = value => structuredClone(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const message = (id, content = id, more = {}) => ({ id, content, roomId: 'room-a', senderId: 'bot-a', ...more });
const room = (id = 'room-a', messages = [message('saved-message')]) => ({
  room: { id, name: id }, messages: messages.map(item => ({ ...item, roomId: id })), jobs: [],
});
const workspace = () => ({
  bots: [{ id: 'bot-a', name: 'Bot A' }], rooms: [{ id: 'room-a' }, { id: 'room-b' }],
  works: [], agentRuns: [], activity: [], routines: [], knowledge: { nodes: [], edges: [] },
  provider: {}, runtime: { started: true, fast: {}, deep: {}, jobs: [] }, defaultCwd: 'test',
});

function localCache() {
  const context = vm.createContext({ window: {}, structuredClone, setTimeout, clearTimeout });
  vm.runInContext(cacheSource, context);
  return context.window.RelayCache;
}

function fixture(cache = localCache()) {
  const events = [], requests = [];
  const ui = {
    view: 'chat', roomId: 'room-lobby', botId: null, workId: null, nodeId: null,
    mobileRoom: false, messages: [], roomJobs: [], messagesRoomId: null, messageCache: new Map(),
    roomReadSeq: {}, drafts: {}, draftTargets: {}, draftAttachments: {}, localMessages: {}, sendingRooms: new Set(), outbound: {},
    loading: true, cacheReady: false, refreshing: false, refreshAgain: false, detailOpen: false, navigationSeq: 0,
  };
  const state = { bots: [], rooms: [], works: [], agentRuns: [], routines: [], knowledge: { nodes: [], edges: [] } };
  const main = { innerHTML: '' };
  const context = vm.createContext({
    RelayCache: cache, ui, state, attachmentLimit: 8, avatarSaveEpoch: 0, avatarSaves: new Map(),
    structuredClone, console, setTimeout, clearTimeout, location: { hash: 'chat' },
    api(path) { requests.push(path); events.push({ kind: 'request', path }); throw new Error('unexpected network'); },
    roomById: id => state.rooms.find(item => item.id === id),
    botById: id => state.bots.find(item => item.id === id),
    profileBot: () => null, refreshOpenAgentRuns() {}, scheduleRefresh() {},
    render() { events.push({ kind: 'render', roomId: ui.roomId, messages: copy(ui.messages), rooms: copy(state.rooms), loading: ui.loading }); },
    renderTopbar() { events.push({ kind: 'topbar' }); },
    showConnection(text) { events.push({ kind: 'connection', text }); },
    applyDisplayPreferences() {}, toast() {}, emptyState: (title, detail) => `${title}: ${detail}`,
    $: () => main,
  });
  vm.runInContext(`${attachmentCode}\n${outgoingCode}\n${helpers}\n${refreshCode}`, context);
  return { cache, context, ui, state, events, requests, main };
}

async function seed(cache, selectedRoom = 'room-a') {
  await cache.writeWorkspace({ snapshot: workspace(), cursor: 'workspace-old' });
  await cache.writeRoom('room-a', { snapshot: room(), cursor: 'room-old' });
  await cache.writeSession({ roomId: selectedRoom, mobileRoom: true, drafts: { 'room-a': '草稿' }, targets: {}, attachments: {}, localMessages: {} });
}

test('actual startup restores the cached conversation before the first network request begins', async () => {
  const cache = localCache(); await seed(cache);
  const f = fixture(cache), network = deferred(), opening = deferred();
  f.context.RelayCache = { ...cache, ready: () => opening.promise };
  f.context.api = path => { f.events.push({ kind: 'request', path }); return network.promise; };
  vm.runInContext(bootstrapCode, f.context);
  assert.ok(f.ui.cacheBootPromise, 'startup must hold network refresh until cache restoration completes');
  assert.equal(f.events.some(event => event.kind === 'request'), false);
  opening.resolve(); await f.ui.cacheBootPromise;
  await Promise.resolve();
  const renderIndex = f.events.findIndex(event => event.kind === 'render' && event.messages.some(item => item.id === 'saved-message'));
  const requestIndex = f.events.findIndex(event => event.kind === 'request');
  assert.ok(renderIndex >= 0, 'cached messages appear without a successful GET');
  assert.ok(requestIndex > renderIndex, 'GET starts after cached messages have rendered');
  assert.equal(f.ui.roomId, 'room-a');
  assert.equal(f.ui.drafts['room-a'], '草稿');
  assert.equal(f.ui.loading, false);
});

test('cached conversation remains visible when the first network refresh fails', async () => {
  const cache = localCache(); await seed(cache);
  const f = fixture(cache);
  await f.context.restoreCachedWorkspace();
  f.context.api = async () => { throw new Error('offline'); };
  await f.context.refresh();
  assert.equal(f.ui.messages[0].id, 'saved-message');
  assert.equal(f.ui.loading, false);
  assert.equal(f.main.innerHTML, '', 'offline feedback must not replace the cached workspace');
  assert.ok(f.events.some(event => event.kind === 'connection' && event.text.includes('offline')));
});

test('changing rooms while storage reads are pending never shows one room in another', async () => {
  const f = fixture(), a = deferred(), b = deferred();
  f.context.RelayCache = { readRoom: id => id === 'room-a' ? a.promise : b.promise };
  f.ui.roomId = 'room-a';
  const first = f.context.restoreRoomMessages('room-a');
  f.ui.roomId = 'room-b';
  const second = f.context.restoreRoomMessages('room-b');
  b.resolve({ snapshot: room('room-b', [message('message-b')]), cursor: 'b' }); await second;
  a.resolve({ snapshot: room(), cursor: 'a' }); await first;
  assert.equal(f.ui.messagesRoomId, 'room-b');
  assert.equal(f.ui.messages[0].id, 'message-b');
  assert.equal(f.ui.messageCache.get('room-a').messages[0].id, 'saved-message');
});

test('a newer live room response wins over a slow cached storage response', async () => {
  const f = fixture(), reading = deferred();
  f.ui.roomId = 'room-a';
  f.context.RelayCache = { readRoom: () => reading.promise };
  const restore = f.context.restoreRoomMessages('room-a');
  const live = room('room-a', [message('live-message')]);
  f.ui.messageCache.set('room-a', { snapshot: live, messages: live.messages, jobs: [], cursor: 'live' });
  reading.resolve({ snapshot: room(), cursor: 'old' }); await restore;
  assert.equal(f.ui.messages[0].id, 'live-message');
  assert.equal(f.ui.messageCache.get('room-a').cursor, 'live');
});

test('actual room selection renders its saved messages before waiting on its GET', async () => {
  const f = fixture(), started = deferred(), network = deferred();
  await f.cache.writeRoom('room-b', { snapshot: room('room-b', [message('saved-b')]), cursor: 'b-cursor' });
  Object.assign(f.state, workspace());
  f.ui.roomId = 'room-a'; f.ui.messages = [message('old-a')]; f.ui.messagesRoomId = 'room-a';
  f.context.api = path => { started.resolve(path); return network.promise; };
  vm.runInContext(actionCode, f.context);
  const selection = f.context.act('select-room', { dataset: { id: 'room-b' } });
  await started.promise;
  assert.equal(f.ui.messages[0].id, 'saved-b');
  assert.ok(f.events.some(event => event.kind === 'render' && event.roomId === 'room-b' && event.messages[0]?.id === 'saved-b'));
  network.resolve({ sync: { version: 1, scope: 'room:room-b', cursor: 'b-new', reset: false }, patch: { values: {}, collections: {} } });
  await selection;
});

test('a slow earlier room selection cannot reopen itself after a newer selection finishes', async () => {
  const f = fixture(), a = deferred(), b = deferred();
  Object.assign(f.state, workspace());
  f.context.RelayCache = { readRoom: id => id === 'room-a' ? a.promise : b.promise };
  const loaded = [];
  f.context.loadCurrent = async () => { loaded.push(f.ui.roomId); };
  vm.runInContext(actionCode, f.context);
  const first = f.context.act('select-room', { dataset: { id: 'room-a' } });
  const second = f.context.act('select-room', { dataset: { id: 'room-b' } });
  b.resolve({ snapshot: room('room-b', [message('saved-b')]), cursor: 'b' }); await second;
  a.resolve({ snapshot: room(), cursor: 'a' }); await first;
  assert.equal(f.ui.roomId, 'room-b');
  assert.equal(f.ui.messages[0].id, 'saved-b');
  assert.deepEqual(loaded, ['room-b'], 'only the latest navigation may continue to its network refresh');
});

test('room delta confirms an optimistic bubble and persists the canonical server message once', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const sync = new IncrementalSync(store), f = fixture(), before = room();
  const initial = sync.respond('room:room-a', before);
  const confirmed = message('canonical-user', '刚发送的消息', { senderId: 'user', clientId: 'client-fixed' });
  const current = room('room-a', [...before.messages, confirmed, message('bot-reply')]);
  f.ui.roomId = 'room-a';
  f.ui.messageCache.set('room-a', { snapshot: before, messages: before.messages, jobs: [], cursor: initial.sync.cursor });
  f.ui.localMessages['room-a'] = { 'client-fixed': {
    roomId: 'room-a', clientId: 'client-fixed', payload: { content: confirmed.content }, status: 'failed', error: 'offline',
    message: { ...confirmed, id: 'local-client-fixed' },
  } };
  f.context.api = async path => {
    const url = new URL(path, 'http://test');
    assert.equal(url.searchParams.get('since'), initial.sync.cursor);
    return sync.respond('room:room-a', current, url.searchParams.get('since'));
  };
  await f.context.loadCurrent();
  const merged = f.context.mergedRoomMessages('room-a', f.ui.messages);
  assert.equal(merged.filter(item => item.clientId === 'client-fixed').length, 1);
  assert.equal(f.ui.localMessages['room-a']['client-fixed'].status, 'sent');
  assert.equal(f.ui.localMessages['room-a']['client-fixed'].message.id, 'canonical-user');
  const persisted = await f.cache.readRoom('room-a');
  assert.deepEqual(persisted.snapshot, current);
  assert.notEqual(persisted.cursor, initial.sync.cursor);
});

test('a later server deletion cannot resurrect a user message already confirmed by GET', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const sync = new IncrementalSync(store), f = fixture(), before = room('room-a', []);
  const initial = sync.respond('room:room-a', before);
  const confirmed = message('canonical-user', '之后会被移除', { senderId: 'user', clientId: 'confirmed-client' });
  let current = room('room-a', [confirmed]);
  f.ui.cacheReady = true; f.ui.roomId = 'room-a';
  f.ui.messageCache.set('room-a', { snapshot: before, messages: [], jobs: [], cursor: initial.sync.cursor });
  f.ui.localMessages['room-a'] = { 'confirmed-client': {
    roomId: 'room-a', clientId: 'confirmed-client', status: 'sent', payload: { content: confirmed.content },
    message: { ...confirmed, id: 'local-confirmed-client' },
  } };
  f.context.api = async path => sync.respond('room:room-a', current, new URL(path, 'http://test').searchParams.get('since'));
  await f.context.loadCurrent();
  assert.equal(f.ui.localMessages['room-a']['confirmed-client'].remoteConfirmed, true);
  assert.equal(f.context.mergedRoomMessages('room-a', f.ui.messages).length, 1);
  current = room('room-a', []);
  await f.context.loadCurrent();
  assert.equal(f.context.mergedRoomMessages('room-a', f.ui.messages).length, 0);
  f.context.persistClientSession();
  const session = await f.cache.readSession();
  assert.equal(session.localMessages['room-a'].length, 0, 'a deleted confirmed record must not return after the next reload');
  assert.equal((await f.cache.readRoom('room-a')).snapshot.messages.length, 0);
});

test('both cache restoration and refresh isolate the sync baseline from UI avatar mutations', async () => {
  const cache = localCache(), snapshot = workspace();
  snapshot.bots[0].avatar = { color: '#F93498', shape: 'circle' };
  await cache.writeWorkspace({ snapshot, cursor: 'workspace-base' });
  await cache.writeRoom('room-a', { snapshot: room(), cursor: 'room-base' });
  const f = fixture(cache);
  await f.context.restoreCachedWorkspace();
  f.state.bots[0].avatar.color = '#111111';
  assert.equal(f.ui.workspaceSnapshot.bots[0].avatar.color, '#F93498');
  assert.equal((await cache.readWorkspace()).snapshot.bots[0].avatar.color, '#F93498');
  f.context.avatarSaves.set('bot-a', { running: true, target: { color: '#8750EB', shape: 'star' } });
  f.context.loadCurrent = async () => {};
  f.context.api = async () => ({ sync: { version: 1, scope: 'workspace', cursor: 'workspace-fresh', reset: true }, snapshot });
  await f.context.refresh();
  assert.equal(f.state.bots[0].avatar.color, '#8750EB', 'the pending avatar remains visible to the user');
  assert.equal(f.ui.workspaceSnapshot.bots[0].avatar.color, '#F93498', 'the baseline retains the server representation for future deltas');
  f.state.rooms[0].name = 'only a UI mutation';
  assert.equal(f.ui.workspaceSnapshot.rooms[0].name, undefined);
  assert.equal((await cache.readWorkspace()).snapshot.bots[0].avatar.color, '#F93498');
});

test('invalid incremental data retries a full reset rather than replacing the cached history', async () => {
  const f = fixture(), calls = [];
  const previous = { snapshot: room(), cursor: 'old-cursor' }, fresh = room('room-a', [message('fresh')]);
  f.context.api = async path => {
    calls.push(path);
    return calls.length === 1
      ? { sync: { version: 1, scope: 'room:room-a', cursor: 'broken', reset: false }, patch: { values: {}, collections: { messages: { upserts: [{ id: 'x' }], removed: [], order: [] } } } }
      : { sync: { version: 1, scope: 'room:room-a', cursor: 'fresh', reset: true }, snapshot: fresh };
  };
  const result = await f.context.requestSyncedSnapshot('/api/rooms/room-a/messages', previous);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /since=old-cursor/); assert.equal(calls[1], '/api/rooms/room-a/messages?sync=1');
  assert.deepEqual(result.snapshot, fresh);
  assert.equal(previous.snapshot.messages[0].id, 'saved-message');
});

test('session persistence omits raw files, blob previews, incomplete uploads, and reconciled outbox entries', async () => {
  const f = fixture(); f.ui.cacheReady = true; f.ui.roomId = 'room-a';
  f.ui.draftAttachments = { 'room-a': [
    { key: 'ready', name: 'photo.png', size: 10, status: 'ready', attachment: { id: 'attachment-ready', name: 'photo.png' }, file: new Blob(['private bytes']), previewUrl: 'blob:temporary' },
    { key: 'uploading', status: 'uploading', file: new Blob(['uploading bytes']), previewUrl: 'blob:pending' },
    { key: 'failed', status: 'error', file: new Blob(['failed bytes']), previewUrl: 'blob:failed' },
  ] };
  f.ui.localMessages['room-a'] = {
    confirmed: { clientId: 'confirmed', status: 'sent', payload: { content: '已确认' }, message: { id: 'confirmed-server' } },
    notReadBack: { clientId: 'notReadBack', status: 'sent', payload: { content: 'POST 已确认' }, message: { id: 'post-server' } },
  };
  f.ui.messageCache.set('room-a', { messages: [{ id: 'confirmed-server', clientId: 'confirmed' }] });
  f.context.persistClientSession();
  const session = await f.cache.readSession();
  assert.equal(session.attachments['room-a'].length, 1);
  assert.deepEqual(Object.keys(session.attachments['room-a'][0]).sort(), ['attachment', 'key', 'name', 'size', 'status']);
  assert.equal(JSON.stringify(session).includes('blob:'), false);
  assert.equal(session.localMessages['room-a'].length, 1);
  assert.equal(session.localMessages['room-a'][0].clientId, 'notReadBack');
});

test('reload restores interrupted sends as retryable with their original idempotency key and payload', async () => {
  const f = fixture(); Object.assign(f.state, workspace()); f.ui.cacheReady = true; f.ui.roomId = 'room-a';
  f.ui.localMessages['room-a'] = { fixed: {
    clientId: 'fixed', roomId: 'room-a', status: 'sending', error: '',
    payload: { content: '仍在发送的消息', attachments: ['attachment-a'], toBotId: 'bot-a' },
    message: message('local-fixed', '仍在发送的消息', { senderId: 'user', clientId: 'fixed' }),
  } };
  f.context.persistClientSession();
  const saved = await f.cache.readSession(), reloaded = fixture(f.cache);
  Object.assign(reloaded.state, workspace());
  reloaded.context.restoreClientSession(saved);
  const restored = reloaded.ui.localMessages['room-a'].fixed;
  assert.equal(restored.status, 'failed'); assert.match(restored.error, /可重试/);
  assert.equal(restored.clientId, 'fixed');
  assert.deepEqual(restored.payload, f.ui.localMessages['room-a'].fixed.payload);
  assert.equal(reloaded.context.mergedRoomMessages('room-a', [])[0]._delivery, 'failed');
});

test('a newer PWA update draft is not overwritten by an older durable session', () => {
  const f = fixture(); Object.assign(f.state, workspace());
  f.ui.updateSnapshotRestored = true;
  f.ui.roomId = 'room-b'; f.ui.drafts = { 'room-b': '更新前刚输入的草稿' };
  f.context.restoreClientSession({ roomId: 'room-a', drafts: { 'room-a': '旧草稿' }, localMessages: {} });
  assert.equal(f.ui.roomId, 'room-b');
  assert.equal(f.ui.drafts['room-b'], '更新前刚输入的草稿');
  assert.equal(f.ui.drafts['room-a'], undefined);
});

test('PWA update snapshots preserve POST-confirmed messages until GET has acknowledged them', () => {
  const storage = new Map(), sessionStorage = {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  const f = fixture();
  f.context.sessionStorage = sessionStorage;
  vm.runInContext(updateDraftCode, f.context);
  f.ui.roomId = 'room-a';
  f.ui.localMessages['room-a'] = {
    postOnly: { roomId: 'room-a', clientId: 'postOnly', status: 'sent', payload: { content: 'POST 已确认' }, message: message('post-server', 'POST 已确认', { senderId: 'user', clientId: 'postOnly' }) },
    getConfirmed: { roomId: 'room-a', clientId: 'getConfirmed', status: 'sent', remoteConfirmed: true, payload: { content: 'GET 已确认' }, message: message('get-server') },
    unconfirmed: { roomId: 'room-a', clientId: 'unconfirmed', status: 'failed', payload: { content: '未确认' }, message: message('local-unconfirmed') },
  };
  assert.equal(f.context.preserveUpdateDrafts(), true);
  const snapshot = JSON.parse(storage.get('relay:update-drafts'));
  assert.deepEqual(snapshot.localMessages['room-a'].map(entry => entry.clientId), ['postOnly', 'unconfirmed']);
  const updated = fixture();
  updated.context.sessionStorage = sessionStorage;
  vm.runInContext(updateDraftCode, updated.context);
  const entries = updated.ui.localMessages['room-a'];
  assert.equal(entries.postOnly.status, 'sent', 'a confirmed POST must not become a false failure during application update');
  assert.equal(entries.postOnly.message.id, 'post-server');
  assert.equal(entries.unconfirmed.status, 'failed');
  assert.equal(entries.getConfirmed, undefined);
  assert.equal(updated.context.mergedRoomMessages('room-a', []).filter(item => item.clientId === 'postOnly').length, 1);
});

test('a rolling server update can return a legacy snapshot without poisoning its cursor', async () => {
  const f = fixture(), snapshot = room();
  f.context.api = async () => snapshot;
  const result = await f.context.requestSyncedSnapshot('/api/rooms/room-a/messages', { snapshot, cursor: 'old' });
  assert.equal(result.cursor, null);
  assert.deepEqual(result.snapshot, snapshot);
});

test('server journal composition is accepted by the real browser cache merger across missed revisions', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const sync = new IncrementalSync(store), cache = localCache();
  const before = room('room-a', [message('a'), message('b'), message('c')]);
  const initial = sync.respond('room:room-a', before);
  const client = cache.applySync(null, initial);
  sync.respond('room:room-a', room('room-a', [message('b', 'edit-1'), message('temporary'), message('c')]));
  sync.respond('room:room-a', room('room-a', [message('c'), message('a', 're-added'), message('b', 'edit-2')]));
  const current = room('room-a', [message('a', 're-added'), message('c'), message('b', 'edit-final')]);
  const delta = sync.respond('room:room-a', current, initial.sync.cursor);
  assert.equal(delta.sync.reset, false);
  assert.deepEqual(delta.patch.collections.messages.removed, ['temporary']);
  assert.deepEqual(cache.applySync(client, delta), current);
});

