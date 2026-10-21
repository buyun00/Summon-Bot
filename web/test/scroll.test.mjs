import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function captureChatScroll('), source.indexOf('function preserveView('));
function fixture(zoom = 1) {
  const pre = { scrollTop: 91, scrollLeft: 17 };
  const body = { id: 'agent-tool-run:tool', querySelectorAll: () => [pre] };
  const messages = { scrollTop: 640, getBoundingClientRect: () => ({ top: 50 }), querySelectorAll: selector => selector === '.agent-tool-body[id]' ? [body] : [item] };
  const item = { position: 600, dataset: { agentRunId: 'run' }, hasAttribute: () => false, getAttribute: () => 'run', getBoundingClientRect: () => ({ top: 50 + (item.position - messages.scrollTop) * zoom, bottom: 50 + (800 + item.position - messages.scrollTop) * zoom }) };
  const context = vm.createContext({ document: { documentElement: {}, getElementById: id => id === body.id ? body : null }, getComputedStyle: () => ({ zoom: String(zoom) }) });
  vm.runInContext(functions, context);
  return { context, messages, item, pre };
}
test('refresh preserves reading position and nested Pi output scroll across repeated replacements', () => {
  const { context, messages, pre } = fixture();
  for (let i = 0; i < 5; i++) {
    const saved = context.captureChatScroll(messages);
    messages.scrollTop = 0; pre.scrollTop = 0; pre.scrollLeft = 0;
    context.restoreChatScroll(messages, saved);
    assert.equal(messages.scrollTop, 640);
    assert.equal(pre.scrollTop, 91);
    assert.equal(pre.scrollLeft, 17);
  }
});
test('content growing above the visible item keeps that item at the same screen offset', () => {
  const { context, messages, item } = fixture();
  const saved = context.captureChatScroll(messages);
  item.position += 220; messages.scrollTop = 0;
  context.restoreChatScroll(messages, saved);
  assert.equal(messages.scrollTop, 860);
  assert.equal(item.getBoundingClientRect().top, 10);
});
test('unanchored refresh preserves the offset instead of jumping to the bottom', () => {
  const { context, messages } = fixture();
  context.restoreChatScroll(messages, { top: 975, outputs: [] });
  assert.equal(messages.scrollTop, 975);
});

test('desktop zoom keeps the reading anchor fixed when content above it grows', () => {
  const { context, messages, item } = fixture(2 / 3);
  const saved = context.captureChatScroll(messages);
  const before = item.getBoundingClientRect().top;
  item.position += 220;
  messages.scrollTop = 0;
  context.restoreChatScroll(messages, saved);
  assert.equal(messages.scrollTop, 860);
  assert.equal(item.getBoundingClientRect().top, before);
});

