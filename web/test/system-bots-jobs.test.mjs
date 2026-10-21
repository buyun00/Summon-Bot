import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
const sidebarCode = source.slice(source.indexOf('function isSystemBot('), source.indexOf('function richText('));
const chatCode = source.slice(source.indexOf('function renderChat('), source.indexOf('function renderDetailPanel('));
const noticeCode = source.slice(source.indexOf('function unresolvedJobLeaves('), source.indexOf('function agentRunVersion('));
const actionCode = source.slice(source.indexOf('async function act('), source.indexOf("document.addEventListener('click'"));

function fixture() {
  const sidebar = { innerHTML: '' }, scroll = { scrollTop: 0 }, shell = { classList: { toggle() {} } };
  const state = { bots: [
    { id: 'bot-engineer', name: '工程伙伴', roleId: 'engineer', presetId: 'engineer' },
    { id: 'user-engineer', name: '工程伙伴', roleId: 'engineer', creationSource: 'custom' },
    { id: 'clone-engineer', name: '工程伙伴分身', roleId: 'engineer', creationSource: 'custom' },
  ], rooms: [{ id: 'user-room', kind: 'dm', members: ['user', 'user-engineer'] }, { id: 'system-room', kind: 'dm', members: ['user', 'bot-engineer'] }], works: [], runtime: { jobs: [] }, provider: {}, activity: [] };
  const ui = { view: 'chat', roomId: 'user-room', messagesRoomId: 'user-room', roomJobs: [], messages: [], drafts: {}, draftTargets: {}, sendingRooms: new Set(), retryingJobs: new Set(), roomQuery: '', systemBotsOpen: false };
  const notices = [], calls = [];
  const context = vm.createContext({ ui, state, Set, Map, console,
    window: {},
    $: selector => selector === '#contact-sidebar' ? sidebar : selector === '.contacts-scroll' ? scroll : selector === '.app-shell' ? shell : null,
    currentBot: () => state.bots.find(bot => state.rooms.find(room => room.id === ui.roomId)?.members?.includes(bot.id)),
    currentAccent: () => '#222222',
    roomById: id => state.rooms.find(room => room.id === id), botById: id => state.bots.find(bot => bot.id === id),
    nameOf: id => state.bots.find(bot => bot.id === id)?.name || id,
    icon: () => '<svg></svg>', avatar: () => '<span class="test-avatar"></span>', groupAvatar: () => '',
    esc: value => String(value ?? '').replaceAll('<', '&lt;'), richText: value => String(value),
    formatTime: () => '12:00', contactTime: () => '今天', formatDay: () => '今天',
    botAvatar: () => ({ color: '#222222' }),
    captureMotion() {}, hydrateMotion() {}, renderSignature: html => html,
    mergedRoomMessages: (_id, messages) => messages,
    visibleAgentRuns: () => [], messageActivity: () => '', renderMessageAttachments: () => '', renderSendStatus: () => '',
    renderAttachmentDrafts: () => '', sendBusy: () => false,
    api: async (url, method, body) => { calls.push({ url, method, body }); return { status: 'completed' }; },
    render() {}, refresh: async () => {}, toast: message => notices.push(message),
  });
  vm.runInContext(`${sidebarCode}\n${noticeCode}\n${chatCode}\n${actionCode}`, context);
  return { context, state, ui, sidebar, notices, calls };
}

test('only explicit presets are hidden by default; custom same-role Bots and clones remain in main contacts', async () => {
  const f = fixture(); f.context.renderTopbar();
  const main = f.sidebar.innerHTML.split('<div class="bot-contacts">')[1].split('<section class="system-bots')[0];
  assert.match(main, /data-id="user-engineer"/); assert.match(main, /data-id="clone-engineer"/);
  assert.doesNotMatch(main, /data-id="bot-engineer"/);
  assert.match(f.sidebar.innerHTML, /data-action="toggle-system-bots" aria-expanded="false"/);
  assert.doesNotMatch(f.sidebar.innerHTML, /data-action="dm-bot" data-id="bot-engineer"/);
  await f.context.act('toggle-system-bots', { dataset: {} });
  assert.match(f.sidebar.innerHTML, /data-action="dm-bot" data-id="bot-engineer"/);
  assert.match(f.sidebar.innerHTML, /aria-expanded="true" aria-controls="system-bot-contacts"/);
});

test('a selected system conversation reveals its group and remains clearly labelled after manual collapse', async () => {
  const f = fixture(); f.ui.roomId = 'system-room'; f.context.renderTopbar();
  assert.equal(f.ui.systemBotsOpen, true);
  assert.match(f.sidebar.innerHTML, /当前：工程伙伴/);
  await f.context.act('toggle-system-bots', { dataset: {} });
  assert.match(f.sidebar.innerHTML, /aria-expanded="false" aria-controls="system-bot-contacts"/);
  assert.match(f.sidebar.innerHTML, /当前：工程伙伴/);
});

test('retry chains show only failed leaves, and only a strongly linked Bot reply suppresses a migrated failure', () => {
  const f = fixture(), job = { id: 'old', messageId: 'trigger', botId: 'user-engineer', status: 'interrupted' };
  const pending = { ...job, id: 'retry-1', retryOf: 'old', status: 'queued' };
  assert.equal(f.context.unresolvedJobLeaves([job, pending], []).length, 0);
  assert.equal(f.context.unresolvedJobLeaves([job, { ...pending, status: 'completed' }], []).length, 0);
  const failures = f.context.unresolvedJobLeaves([job, { ...pending, status: 'failed' }], []);
  assert.deepEqual(Array.from(failures, item => item.id), ['retry-1']);
  const reply = { id: 'answer', jobId: 'old', replyTo: 'trigger', senderId: 'user-engineer', kind: 'reply' };
  assert.equal(f.context.unresolvedJobLeaves([job], [reply]).length, 0);
  for (const changed of [{ jobId: 'other' }, { replyTo: 'other' }, { senderId: 'other' }, { kind: 'error' }]) {
    assert.equal(f.context.unresolvedJobLeaves([job], [{ ...reply, ...changed }]).length, 1);
  }
  assert.equal(job.status, 'interrupted', 'rendering must not rewrite historical job state');
});

test('a failure renders beside its triggering message, before later unrelated replies; missing triggers go into collapsed history', () => {
  const f = fixture();
  f.ui.messages = [{ id: 'trigger', senderId: 'user', content: 'old request', createdAt: '2026-01-01' }, { id: 'later', senderId: 'user-engineer', content: 'new unrelated reply', createdAt: '2026-01-02' }];
  f.ui.roomJobs = [{ id: 'old', messageId: 'trigger', botId: 'user-engineer', status: 'interrupted' }, { id: 'orphan', messageId: 'missing', botId: 'user-engineer', status: 'failed' }];
  const html = f.context.renderChat();
  const trigger = html.indexOf('data-message-id="trigger"'), notice = html.indexOf('data-job-id="old"'), end = html.indexOf('</article>', trigger), later = html.indexOf('data-message-id="later"');
  assert.ok(trigger < notice && notice < end && end < later);
  assert.match(html, /<details class="historical-job-notices"><summary>历史任务记录 · 1/);
  assert.equal(html.split('data-job-id="old"').length - 1, 1);
});

test('retry clicks stay deduplicated across rerenders and an existing completion gets the correct toast', async () => {
  const f = fixture(); let resolve;
  f.context.api = async () => { f.calls.push('retry'); return new Promise(done => { resolve = done; }); };
  const firstButton = { dataset: { id: 'old' }, disabled: false };
  const first = f.context.act('retry-job', firstButton);
  const second = f.context.act('retry-job', { dataset: { id: 'old' } });
  await second; assert.equal(f.calls.length, 1); assert.equal(firstButton.disabled, true);
  resolve({ id: 'retry-1', status: 'completed' }); await first;
  assert.deepEqual(f.notices, ['任务已经完成']); assert.equal(firstButton.disabled, false);
  assert.equal(f.ui.retryingJobs.size, 0);
});
