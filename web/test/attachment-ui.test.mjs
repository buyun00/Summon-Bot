import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const attachmentCode = source.slice(source.indexOf('const attachmentLimit ='), source.indexOf('let refreshTimer;'));
const submitCode = source.slice(source.indexOf("document.addEventListener('submit', async event =>"), source.indexOf("$('#modal').addEventListener('click'"));
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function fixture(options = {}) {
  let serial = 0;
  const values = options.storage || new Map();
  const calls = [], notices = [], inputs = [], revoked = [], listeners = {};
  const input = { value: '' }, send = { disabled: false }, target = { value: '' };
  const form = { id: 'message-form', dataset: { roomId: 'room-a' } };
  const ui = { roomId: 'room-a', draftAttachments: {}, drafts: {}, draftTargets: {}, outbound: {}, sendingRooms: new Set(), reply: null };
  const context = vm.createContext({
    ui, Date, Promise, Set, Object, JSON, Number, String, Math,
    crypto: { randomUUID: () => `test-${++serial}` },
    URL: { createObjectURL: () => `blob:test-${++serial}`, revokeObjectURL: value => revoked.push(value) },
    FileReader: class {
      readAsDataURL(file) {
        if (file.readError) { this.onerror(); return; }
        this.result = `data:${file.type};base64,${Buffer.from(file.content || '').toString('base64')}`;
        this.onload();
      }
    },
    sessionStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    document: {
      createElement() {
        const element = { handlers: {}, setAttribute(name, value) { this[name] = value; }, addEventListener(name, callback) { this.handlers[name] = callback; }, click() { this.clicked = true; }, remove() { this.removed = true; } };
        inputs.push(element); return element;
      },
      body: { append() {} },
      addEventListener(name, callback) { listeners[name] = callback; },
    },
    roomById: id => ({ id }), render() {}, toast: message => notices.push(message), icon: () => '<svg></svg>',
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    api: async (url, method, payload) => {
      calls.push({ url, method, payload: clone(payload) });
      return options.api ? options.api(url, method, payload) : url.endsWith('/messages') ? { id: `message-${calls.length}`, roomId: 'room-a', senderId: 'user', ...clone(payload) } : { id: `upload-${calls.length}`, name: payload.name, mimeType: payload.mimeType, size: Buffer.from(payload.data || '', 'base64').length, url: '/unused' };
    },
    $: selector => selector === '#message-input' ? input : selector === '#message-target' ? target : selector.includes('button[type=submit]') ? send : null,
    refresh: async () => {},
    scheduleRefresh() {},
  });
  vm.runInContext(attachmentCode, context);
  vm.runInContext('globalThis.attachmentBusy = attachmentBusy;', context);
  vm.runInContext(submitCode, context);
  const submit = async (text = '') => { input.value = text; await listeners.submit({ target: form, preventDefault() {} }); };
  return { context, ui, calls, notices, inputs, revoked, values, input, form, send, submit };
}

const file = (name = 'notes.txt', overrides = {}) => ({ name, type: 'text/plain', size: 5, content: 'hello', ...overrides });
const ready = (key = 'draft-1', id = 'upload-1') => ({ key, name: 'notes.txt', size: 5, status: 'ready', attachment: { id, name: 'notes.txt', size: 5, mimeType: 'text/plain', url: `/api/attachments/${id}` } });

test('the plus button opens one native picker without a custom menu or file-type restriction', async () => {
  const f = fixture();
  assert.match(source, /data-action="attach-file" aria-label="添加附件"/);
  assert.ok(!source.includes('const extraMenu'));
  f.context.chooseAttachments();
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].accept, undefined);
  assert.equal(f.inputs[0].capture, undefined);
  assert.equal(f.inputs[0].multiple, true);
  assert.equal(f.inputs[0].clicked, true);
  f.ui.roomId = 'room-b';
  f.inputs[0].files = [file()];
  f.inputs[0].handlers.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.ui.draftAttachments['room-a'][0].status, 'ready');
  assert.equal(f.ui.draftAttachments['room-b'], undefined);
  assert.equal(f.inputs[0].removed, true);
});

test('oversized files are rejected before upload and selection is capped at eight files', async () => {
  const f = fixture();
  await f.context.addAttachments('room-a', [file('huge.zip', { size: 20 * 1024 * 1024 + 1 }), ...Array.from({ length: 10 }, (_, index) => file(`${index}.txt`))]);
  assert.equal(f.calls.length, 8);
  assert.equal(f.ui.draftAttachments['room-a'].length, 8);
  assert.ok(f.notices.some(message => message.includes('20 MB')));
  assert.ok(f.notices.some(message => message.includes('8 个附件')));
});

test('failed upload blocks sending, retains the file and can be retried successfully', async () => {
  let attempt = 0;
  const f = fixture({ api: async () => { if (++attempt === 1) throw new Error('断网'); return { id: 'upload-retry' }; } });
  await f.context.addAttachments('room-a', [file()]);
  const item = f.ui.draftAttachments['room-a'][0];
  assert.equal(item.status, 'error');
  assert.equal(item.error, '断网');
  assert.equal(f.context.attachmentBusy('room-a'), true);
  await f.submit();
  assert.equal(f.calls.length, 1);
  await f.context.uploadAttachment('room-a', item);
  assert.equal(item.status, 'ready');
  assert.equal(item.file.name, 'notes.txt');
  assert.equal(f.context.attachmentBusy('room-a'), false);
});

test('switching rooms or removing a queued file does not attach uploads to the wrong draft', async () => {
  const pending = deferred();
  const f = fixture({ api: () => pending.promise });
  const uploading = f.context.addAttachments('room-a', [file('first.txt'), file('second.txt')]);
  await Promise.resolve();
  const [first, second] = f.ui.draftAttachments['room-a'];
  f.context.removeAttachment(second.key);
  f.ui.roomId = 'room-b';
  pending.resolve({ id: 'upload-first' });
  await uploading;
  assert.equal(first.status, 'ready');
  assert.equal(f.calls.length, 1);
  assert.equal(f.ui.draftAttachments['room-a'].length, 1);
  assert.equal(f.ui.draftAttachments['room-b'], undefined);
});

test('attachment-only sends immediately leave the composer and retain clientId for failed-bubble retry', async () => {
  let attempt = 0;
  const f = fixture({ api: async (_url, _method, payload) => { if (++attempt === 1) throw new Error('响应丢失'); return { id: 'message-1', roomId: 'room-a', senderId: 'user', ...clone(payload) }; } });
  f.ui.draftAttachments['room-a'] = [ready()];
  f.ui.drafts['room-a'] = '';
  await f.submit();
  const clientId = f.calls[0].payload.clientId;
  assert.equal(f.ui.draftAttachments['room-a'].length, 0);
  const entry = f.context.localRoomMessages('room-a')[0];
  assert.equal(entry.message.attachments[0].id, 'upload-1');
  assert.equal(entry.status, 'failed');
  assert.equal(f.ui.sendingRooms.size, 0);
  assert.deepEqual(f.calls[0].payload.attachments, [{ id: 'upload-1' }]);
  assert.equal(f.calls[0].payload.content, '');
  await f.context.sendLocalMessage(entry);
  assert.equal(f.calls[1].payload.clientId, clientId);
  assert.equal(f.ui.draftAttachments['room-a'].length, 0);
  assert.equal(f.ui.outbound['room-a'], undefined);
});

test('sending locks duplicate submits and preserves newly typed text while the request is in flight', async () => {
  const pending = deferred();
  const f = fixture({ api: () => pending.promise });
  f.ui.draftAttachments['room-a'] = [ready()];
  f.ui.drafts['room-a'] = 'first message';
  const sending = f.submit('first message');
  await f.submit('first message');
  assert.equal(f.calls.length, 1);
  f.ui.drafts['room-a'] = 'next message'; f.input.value = 'next message';
  pending.resolve({ id: 'message-1', roomId: 'room-a', senderId: 'user', ...f.calls[0].payload }); await sending;
  assert.equal(f.ui.drafts['room-a'], 'next message');
  assert.equal(f.input.value, 'next message');
  assert.equal(f.ui.draftAttachments['room-a'].length, 0);
});

test('PWA update preserves uploaded attachment references and excludes transient File and blob URL values', () => {
  const f = fixture();
  f.ui.drafts['room-a'] = 'unsent';
  f.ui.draftAttachments['room-a'] = [{ ...ready(), file: file(), preview: 'blob:temporary' }];
  assert.equal(f.context.preserveUpdateDrafts(), true);
  const saved = JSON.parse(f.values.get('summon:update-drafts'));
  assert.equal(saved.attachments['room-a'][0].file, undefined);
  assert.equal(saved.attachments['room-a'][0].preview, undefined);
  const restored = fixture({ storage: f.values });
  assert.equal(restored.ui.drafts['room-a'], 'unsent');
  assert.equal(restored.ui.draftAttachments['room-a'][0].attachment.id, 'upload-1');
  assert.equal(restored.context.attachmentBusy('room-a'), false);
});

test('an ambiguous accepted message retains its clientId through PWA update and is not duplicated on retry', async () => {
  const storedMessages = new Map();
  let loseResponse = true;
  const server = async (_url, _method, payload) => {
    if (!storedMessages.has(payload.clientId)) storedMessages.set(payload.clientId, { id: `message-${storedMessages.size + 1}`, roomId: 'room-a', senderId: 'user', ...clone(payload) });
    if (loseResponse) { loseResponse = false; throw new Error('服务器已接收，但连接中断'); }
    return storedMessages.get(payload.clientId);
  };
  const f = fixture({ api: server });
  f.ui.drafts['room-a'] = 'with attachment';
  f.ui.draftAttachments['room-a'] = [ready()];
  await f.submit('with attachment');
  assert.equal(storedMessages.size, 1);
  const originalId = f.calls[0].payload.clientId;
  assert.equal(f.context.preserveUpdateDrafts(), true);
  const restored = fixture({ storage: f.values, api: server });
  const entry = restored.context.localRoomMessages('room-a')[0];
  assert.equal(entry.clientId, originalId);
  await restored.context.sendLocalMessage(entry);
  assert.equal(restored.calls[0].payload.clientId, originalId);
  assert.equal(storedMessages.size, 1);
  assert.equal(restored.ui.draftAttachments['room-a'].length, 0);
});

test('PWA update blocks pending or failed uploads instead of losing native File objects', () => {
  const f = fixture();
  for (const status of ['uploading', 'error']) {
    f.ui.draftAttachments['room-a'] = [{ ...ready(), status }];
    assert.equal(f.context.preserveUpdateDrafts(), false);
    assert.equal(f.values.has('summon:update-drafts'), false);
  }
});

test('server-provided URLs and unsafe IDs cannot become external image or download URLs', () => {
  const f = fixture();
  const html = f.context.renderMessageAttachments([{ id: 'safe-id', name: '<img onerror=x>', size: 5, url: 'javascript:bad()', previewUrl: 'https://example.invalid/tracker' }, { id: '../outside', name: 'bad', previewUrl: 'https://example.invalid/other' }]);
  assert.ok(html.includes('href="/api/attachments/safe-id"'));
  assert.ok(html.includes('src="/api/attachments/safe-id/preview"'));
  assert.ok(!html.includes('example.invalid'));
  assert.ok(!html.includes('../outside'));
  assert.ok(!html.includes('<img onerror'));
});

