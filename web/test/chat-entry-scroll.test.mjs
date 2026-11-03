import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const scrollCode = source.slice(source.indexOf('function captureChatScroll('), source.indexOf('function preserveView('));
const renderCode = source.slice(source.indexOf('function render()'), source.indexOf('function restoreFocus('));
const actionCode = source.slice(source.indexOf('async function act('), source.indexOf("document.addEventListener('click'"));

function fixture({ height = 500, contentHeight = 1800 } = {}) {
  let nextFrame = 0, top = 0;
  const frames = new Map(), listeners = new Map(), observers = [];
  const children = [{ id: 'first-message' }, { id: 'last-message' }];
  const messages = {
    clientHeight: height, scrollHeight: contentHeight, isConnected: true, children,
    get scrollTop() { return top; },
    set scrollTop(value) { top = Math.max(0, Math.min(Number(value), this.scrollHeight - this.clientHeight)); },
    getBoundingClientRect: () => ({ top: 70, bottom: 70 + messages.clientHeight }),
    querySelectorAll: () => [],
    addEventListener(name, callback) {
      const entries = listeners.get(name) || new Set();
      entries.add(callback); listeners.set(name, entries);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  class ResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.connected = true; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.connected = false; }
  }
  const context = vm.createContext({
    document: { documentElement: {}, getElementById: () => null },
    getComputedStyle: () => ({ zoom: '1' }),
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame: id => frames.delete(id),
    ResizeObserver, window: { ResizeObserver },
  });
  vm.runInContext(scrollCode, context);
  const fire = name => { for (const listener of [...(listeners.get(name) || [])]) listener({ target: messages }); };
  const flush = () => {
    for (let count = 0; frames.size && count < 10; count++) {
      const pending = [...frames.entries()]; frames.clear();
      for (const [, callback] of pending) callback();
    }
    assert.equal(frames.size, 0, 'scroll tracking must not create an endless animation loop');
  };
  const resize = () => { for (const observer of observers) if (observer.connected) observer.callback(observer.targets.map(target => ({ target }))); };
  const restore = (saved, options) => context.restoreConversationScroll(messages, saved, options);
  const capture = () => context.captureChatScroll(messages);
  const bottom = () => messages.scrollHeight - messages.clientHeight;
  return { context, messages, observers, frames, listeners, restore, capture, fire, flush, resize, bottom };
}

test('a newly opened ready conversation starts at the latest message before the next frame', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  assert.equal(f.messages.scrollTop, f.bottom());
  f.flush();
  assert.equal(f.messages.scrollTop, f.bottom());
});

test('an empty loading conversation moves to the latest message when history arrives', () => {
  const f = fixture({ contentHeight: 500 });
  f.restore(null, { sameView: false, ready: false, wasReady: false });
  const saved = f.capture();
  f.messages.scrollHeight = 2400;
  f.restore(saved, { sameView: true, ready: true, wasReady: false });
  f.flush();
  assert.equal(f.messages.scrollTop, 1900);
});

test('reopening the same room after the mobile contact list starts at the bottom', () => {
  const f = fixture({ height: 0 });
  const saved = f.capture();
  assert.equal(saved.visible, false);
  f.messages.clientHeight = 500;
  f.restore(saved, { sameView: true, ready: true, wasReady: true });
  f.flush();
  assert.equal(f.messages.scrollTop, f.bottom());
});

test('cached room history is not pulled down after the reader scrolls up while its GET is pending', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  f.messages.scrollTop = 320; f.fire('scroll');
  const saved = f.capture();
  assert.equal(saved.atBottom, false);
  f.messages.scrollHeight += 400;
  f.messages.scrollTop = 0;
  f.restore(saved, { sameView: true, ready: true, wasReady: true });
  f.flush();
  assert.equal(f.messages.scrollTop, 320);
});

test('new messages keep a reader already at the bottom at the latest message', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  const saved = f.capture();
  assert.equal(saved.atBottom, true);
  f.messages.scrollHeight += 600;
  f.messages.scrollTop = 0;
  f.restore(saved, { sameView: true, ready: true, wasReady: true });
  f.flush();
  assert.equal(f.messages.scrollTop, f.bottom());
});

test('late attachment image loading and message resizing keep the entry at the bottom', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  f.messages.scrollHeight += 280; f.fire('load'); f.flush();
  assert.equal(f.messages.scrollTop, f.bottom());
  assert.ok(f.observers.some(observer => observer.targets.includes(f.messages.children[1])), 'observe message contents, not only the fixed-height scroll viewport');
  f.messages.scrollHeight += 120; f.resize(); f.flush();
  assert.equal(f.messages.scrollTop, f.bottom());
});

test('even a small upward scroll cancels late-media following and does not jump back', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  f.messages.scrollTop -= 20; f.fire('scroll');
  const readerTop = f.messages.scrollTop;
  assert.equal(f.capture().atBottom, false);
  f.messages.scrollHeight += 280; f.fire('load'); f.resize(); f.flush();
  assert.equal(f.messages.scrollTop, readerTop);
});

test('scrolling back to the actual bottom re-enables following for new layout changes', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  f.messages.scrollTop = 200; f.fire('scroll');
  f.messages.scrollTop = f.bottom(); f.fire('scroll');
  f.messages.scrollHeight += 210; f.fire('load'); f.flush();
  assert.equal(f.messages.scrollTop, f.bottom());
});

test('a user scroll that precedes its scroll event still cancels a queued media adjustment', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  f.messages.scrollHeight += 300; f.fire('load');
  f.messages.scrollTop = 300;
  f.flush();
  assert.equal(f.messages.scrollTop, 300);
});

test('a detached old conversation cannot be scrolled by a queued layout callback', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  f.messages.scrollHeight += 300; f.fire('load');
  const oldTop = f.messages.scrollTop;
  f.messages.isConnected = false;
  f.flush();
  assert.equal(f.messages.scrollTop, oldTop);
});

test('hidden conversations do not consume an initial scroll or run layout callbacks', () => {
  const f = fixture({ height: 0 });
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  assert.equal(f.messages.scrollTop, 0);
  f.messages.scrollHeight += 300; f.fire('load'); f.resize(); f.flush();
  assert.equal(f.messages.scrollTop, 0);
});

test('stopping tracking disconnects old content observers and cancels scheduled scrolling', () => {
  const f = fixture();
  f.restore(null, { sameView: false, ready: true, wasReady: false });
  f.flush();
  f.messages.scrollHeight += 300; f.fire('load');
  const oldTop = f.messages.scrollTop;
  f.messages._summonChatScroll.stop();
  f.resize(); f.flush();
  assert.ok(f.observers.every(observer => !observer.connected));
  assert.equal(f.messages.scrollTop, oldTop);
});

test('rendering unchanged cached HTML still scrolls when a hidden mobile room becomes visible', () => {
  const f = fixture({ height: 0 });
  const main = { dataset: { viewKey: 'chat:room-a' }, scrollTop: 0 };
  const ui = { view: 'chat', roomId: 'room-a', messagesRoomId: 'room-a', lastMainHtml: 'same-chat', composing: false };
  const layout = { dataset: { ready: 'true' } };
  Object.assign(f.context, {
    ui,
    $: selector => selector === '#main-content' ? main : selector === '.messages' ? f.messages : selector.startsWith('.chat-layout') ? layout : null,
    preserveView: () => ({ key: 'chat:room-a', fields: [], top: 0, chatScroll: f.capture(), chatReady: true }),
    renderTopbar() { f.messages.clientHeight = 500; },
    renderChat: () => 'same-chat', renderMembers() {}, renderWorks() {}, renderKnowledge() {}, renderRoutines() {},
    renderSignature: html => html, restoreFocus() {},
    persistClientSession() {},
    captureMotion() { throw new Error('unchanged HTML should not need replacement'); },
  });
  vm.runInContext(renderCode, f.context);
  f.context.render(); f.flush();
  assert.equal(f.messages.scrollTop, f.bottom());
});

test('the actual select-room action does not force the reader back down after its GET completes', async () => {
  const f = fixture();
  let finishLoad, renders = 0;
  const pending = new Promise(resolve => { finishLoad = resolve; });
  Object.assign(f.context, {
    ui: { navigationSeq: 0, roomId: 'room-before', view: 'chat' },
    location: { hash: 'chat' }, restoreRoomMessages() {}, loadCurrent: () => pending,
    $: selector => selector === '.messages' ? f.messages : null,
    render() {
      const saved = renders ? f.capture() : null;
      f.restore(saved, { sameView: renders++ > 0, ready: true, wasReady: true });
    },
  });
  vm.runInContext(actionCode, f.context);
  const selecting = f.context.act('select-room', { dataset: { id: 'room-a' } });
  await Promise.resolve();
  f.flush();
  assert.equal(f.messages.scrollTop, f.bottom(), 'cached history opens at its latest message');
  f.messages.scrollTop = 320; f.fire('scroll');
  f.messages.scrollHeight += 400;
  finishLoad(); await selecting; f.flush();
  assert.equal(f.messages.scrollTop, 320);
});

