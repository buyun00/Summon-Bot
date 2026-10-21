import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const localCode = source.slice(source.indexOf('const attachmentLimit ='), source.indexOf('let refreshTimer;'));
const loadCode = source.slice(source.indexOf('async function loadCurrent()'), source.indexOf('function scheduleRefresh()'));
const submitCode = source.slice(source.indexOf("document.addEventListener('submit', async event =>"), source.indexOf("$('#modal').addEventListener('click'"));
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const payload = (content, extra = {}) => ({ content, attachments: [], toBotId: null, replyTo: null, ...extra });
const received = (entry, extra = {}) => ({ ...clone(entry.message), id: `server-${entry.clientId}`, ...extra });

function fixture(api, storage = new Map()) {
  let serial = 0, refreshes = 0;
  const calls = [], renders = [], notices = [], listeners = {};
  const input = { value: '' }, target = { value: '' }, send = { disabled: false };
  const messages = { scrollTop: 0, scrollHeight: 1000 };
  const ui = { view: 'chat', roomId: 'room-a', detailOpen: false, messages: [], roomJobs: [], draftAttachments: {}, drafts: {}, draftTargets: {}, outbound: {}, localMessages: {}, roomReadSeq: {}, messageCache: new Map(), sendingRooms: new Set(), reply: null };
  let context;
  context = vm.createContext({
    ui, Date, Promise, Set, Map, Object, JSON, Number, String, Math,
    crypto: { randomUUID: () => `client-${++serial}` },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { addEventListener: (name, handler) => { listeners[name] = handler; } },
    URL: { revokeObjectURL() {} },
    roomById: id => ({ id }), profileBot: () => null, refreshOpenAgentRuns() {},
    render() { renders.push({ roomId: ui.roomId, input: input.value, messages: clone(context.mergedRoomMessages(ui.roomId, ui.messages)) }); },
    toast: message => notices.push(message),
    scheduleRefresh() { refreshes++; },
    api: (url, method = 'GET', body) => { calls.push({ url, method, body: body === undefined ? undefined : clone(body) }); return api(url, method, body); },
    $: selector => selector === '.messages' ? messages : selector === '#message-input' ? input : selector === '#message-target' ? target : selector.includes('button[type=submit]') ? send : null,
  });
  vm.runInContext(localCode, context);
  vm.runInContext(loadCode, context);
  vm.runInContext(submitCode, context);
  const submit = text => {
    input.value = text; ui.drafts[ui.roomId] = text;
    return listeners.submit({ target: { id: 'message-form', dataset: { roomId: ui.roomId } }, preventDefault() {} });
  };
  return { context, ui, input, target, send, messages, calls, renders, notices, storage, submit, refreshes: () => refreshes };
}

test('submit renders a local bubble and clears text and attachments before a delayed POST completes', async () => {
  const pending = deferred();
  const f = fixture(() => pending.promise);
  const attachment = { id: 'uploaded-image', name: 'photo.png', size: 42, previewUrl: '/api/attachments/uploaded-image/preview' };
  f.ui.draftAttachments['room-a'] = [{ key: 'draft-image', status: 'ready', attachment }];
  const sending = f.submit('message before network');
  const entry = f.context.localRoomMessages('room-a')[0];
  assert.equal(f.renders.at(-1).messages[0].content, 'message before network');
  assert.equal(f.renders.at(-1).messages[0]._delivery, 'sending');
  assert.deepEqual(f.renders.at(-1).messages[0].attachments, [attachment]);
  assert.equal(f.renders.at(-1).input, '');
  assert.equal(f.ui.drafts['room-a'], '');
  assert.equal(f.ui.draftAttachments['room-a'].length, 0);
  assert.equal(f.ui.sendingRooms.has('room-a'), true);
  pending.resolve(received(entry)); await sending;
  assert.equal(f.renders.at(-1).messages.length, 1);
  assert.equal(f.renders.at(-1).messages[0].id, `server-${entry.clientId}`);
  assert.equal(f.renders.at(-1).messages[0]._delivery, null);
});

test('a GET confirmation wins over a later POST network error', async () => {
  const post = deferred(); let confirmation;
  const f = fixture((_url, method) => method === 'POST' ? post.promise : Promise.resolve({ messages: [confirmation], jobs: [] }));
  const sending = f.submit('already accepted');
  const entry = f.context.localRoomMessages('room-a')[0];
  confirmation = received(entry);
  await f.context.loadCurrent();
  assert.equal(entry.status, 'sent');
  post.reject(new Error('response connection lost')); await sending;
  assert.equal(entry.status, 'sent');
  assert.equal(f.notices.length, 0);
  assert.equal(f.context.mergedRoomMessages('room-a', f.ui.messages).length, 1);
});

test('an old GET snapshot arriving after POST success cannot erase the confirmed local message', async () => {
  const get = deferred();
  const f = fixture((_url, method, body) => method === 'GET' ? get.promise : Promise.resolve({ id: 'server-new', roomId: 'room-a', senderId: 'user', ...body }));
  const oldRead = f.context.loadCurrent();
  await f.submit('must remain visible');
  get.resolve({ messages: [], jobs: [] }); await oldRead;
  assert.equal(f.ui.messages.length, 0, 'the remote snapshot is genuinely stale');
  const visible = f.context.mergedRoomMessages('room-a', f.ui.messages);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'server-new');
  assert.equal(visible[0]._delivery, null);
});

test('out-of-order GETs keep the newest requested snapshot for each room', async () => {
  const old = deferred(), current = deferred(); let read = 0;
  const f = fixture(() => (++read === 1 ? old : current).promise);
  const first = f.context.loadCurrent(), second = f.context.loadCurrent();
  current.resolve({ messages: [{ id: 'newest', content: 'new' }], jobs: [] }); await second;
  old.resolve({ messages: [{ id: 'older', content: 'old' }], jobs: [] }); await first;
  assert.equal(f.ui.messages[0].id, 'newest');
  assert.equal(f.ui.messageCache.get('room-a').messages[0].id, 'newest');
});

test('two failed messages retry their own payloads and clientIds even after the draft changes', async () => {
  let fail = true;
  const f = fixture((_url, _method, body) => fail ? Promise.reject(new Error('offline')) : Promise.resolve({ id: `server-${body.clientId}`, roomId: 'room-a', senderId: 'user', ...body }));
  const first = f.context.queueLocalMessage('room-a', payload('first', { toBotId: 'bot-first', replyTo: 'reply-first', attachments: [{ id: 'upload-first' }] }), [{ attachment: { id: 'upload-first', name: 'first.txt' } }]);
  await f.context.sendLocalMessage(first);
  const second = f.context.queueLocalMessage('room-a', payload('second', { toBotId: 'bot-second', replyTo: 'reply-second' }), []);
  await f.context.sendLocalMessage(second);
  assert.equal(first.status, 'failed'); assert.equal(second.status, 'failed');
  assert.notEqual(first.clientId, second.clientId);
  f.ui.drafts['room-a'] = 'unsent third draft'; fail = false;
  await f.context.sendLocalMessage(first); await f.context.sendLocalMessage(second);
  assert.deepEqual(f.calls[2].body, f.calls[0].body);
  assert.deepEqual(f.calls[3].body, f.calls[1].body);
  assert.equal(f.ui.drafts['room-a'], 'unsent third draft');
  assert.equal(f.context.mergedRoomMessages('room-a').length, 2);
});

test('switching rooms while POST is pending does not leak its bubble or scroll into the new room', async () => {
  const post = deferred();
  const f = fixture(() => post.promise);
  const sending = f.submit('belongs to room a');
  const entry = f.context.localRoomMessages('room-a')[0];
  f.ui.roomId = 'room-b'; f.context.restoreRoomMessages('room-b'); f.messages.scrollTop = 85;
  post.resolve(received(entry)); await sending;
  assert.equal(f.renders.at(-1).roomId, 'room-b');
  assert.equal(f.renders.at(-1).messages.length, 0);
  assert.equal(f.messages.scrollTop, 85);
  f.ui.roomId = 'room-a'; f.context.restoreRoomMessages('room-a');
  assert.equal(f.context.mergedRoomMessages('room-a', f.ui.messages)[0].content, 'belongs to room a');
});

test('late POST completion does not scroll away from a reading position chosen after sending', async () => {
  const post = deferred();
  const f = fixture(() => post.promise);
  const sending = f.submit('scroll once');
  const entry = f.context.localRoomMessages('room-a')[0];
  assert.equal(f.messages.scrollTop, f.messages.scrollHeight);
  f.messages.scrollTop = 123;
  post.resolve(received(entry)); await sending;
  assert.equal(f.messages.scrollTop, 123);
  assert.equal(f.refreshes(), 1);
});

test('failed local messages survive PWA update with fixed retry identity and payload', async () => {
  const f = fixture(() => Promise.reject(new Error('offline')));
  await f.submit('restore this failed send');
  const entry = f.context.localRoomMessages('room-a')[0];
  assert.equal(f.context.preserveUpdateDrafts(), true);
  const restored = fixture((_url, _method, body) => Promise.resolve({ id: 'restored-confirmed', roomId: 'room-a', senderId: 'user', ...body }), f.storage);
  const recovered = restored.context.localRoomMessages('room-a')[0];
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.clientId, entry.clientId);
  assert.deepEqual(clone(recovered.payload), clone(entry.payload));
  await restored.context.sendLocalMessage(recovered);
  assert.equal(restored.calls[0].body.clientId, entry.clientId);
  assert.equal(recovered.status, 'sent');
});

test('a malformed POST receipt keeps the message available for retry instead of falsely confirming it', async () => {
  const f = fixture(() => Promise.resolve({ id: 'wrong-room-message', roomId: 'room-b', clientId: 'wrong-client' }));
  await f.submit('needs matching receipt');
  const entry = f.context.localRoomMessages('room-a')[0];
  assert.equal(entry.status, 'failed');
  assert.equal(f.context.mergedRoomMessages('room-a')[0].content, 'needs matching receipt');
});

