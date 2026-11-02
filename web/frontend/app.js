'use strict';

const $ = (selector, root = document) => {
  const first = root.querySelector(selector);
  return first?.closest('[data-motion-ghost]') ? [...root.querySelectorAll(selector)].find(node => !node.closest('[data-motion-ghost]')) || null : first;
};
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)].filter(node => !node.closest('[data-motion-ghost]'));

// Display preferences are local to this browser and independent for each layout.
const UI_BUILD = '2026.11.02.3';
let displayDiagnosticSnapshot = null;
function isIosStandalone() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && (navigator.standalone === true || matchMedia('(display-mode: standalone)').matches);
}
function readViewportUnits() {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;top:0;width:0;height:100vh;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const units = { vh: style.height, safeTop: style.paddingTop, safeBottom: style.paddingBottom };
  probe.style.height = '100dvh'; units.dvh = getComputedStyle(probe).height; probe.remove();
  return units;
}
function captureDisplayDiagnostics() {
  const root = document.documentElement, viewport = window.visualViewport;
  const measure = selector => {
    const element = $(selector); if (!element || !element.getClientRects().length) return null;
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { top: rect.top, bottom: rect.bottom, height: rect.height, position: style.position, paddingBottom: style.paddingBottom };
  };
  const units = readViewportUnits(), rootStyle = getComputedStyle(root);
  return { build: UI_BUILD, userAgent: navigator.userAgent, standalone: isIosStandalone(),
    statusBarStyle: $('meta[name="apple-mobile-web-app-status-bar-style"]')?.content || null,
    heightStrategy: root.classList.contains('keyboard-open') ? 'visual-viewport' : rootStyle.getPropertyValue('--standalone-vh').trim() ? 'standalone-safe-top-correction' : 'dynamic-viewport',
    layoutHeight: rootStyle.getPropertyValue('--ui-vh').trim(),
    screen: { width: screen.width, height: screen.height },
    window: { width: innerWidth, height: innerHeight, scrollY }, rootHeight: root.clientHeight,
    viewport: viewport ? { height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale } : null,
    zoom: getComputedStyle(root).zoom, keyboard: root.classList.contains('keyboard-open'), units,
    shell: measure('.app-shell'), composer: measure('.composer'), composerWrap: measure('.composer-wrap') };
}
const displayPreferenceKey = 'relay:display-preferences:v2';
const displayDefaults = { desktop: { zoom: 100, font: 100 }, mobile: { zoom: 100, font: 100 } };
function normalizeDisplayPreferences(value) {
  const limit = (number, fallback, min, max) => typeof number === 'number' && Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  return Object.fromEntries(Object.entries(displayDefaults).map(([mode, fallback]) => [mode, {
    zoom: limit(value?.[mode]?.zoom, fallback.zoom, 50, 125),
    font: limit(value?.[mode]?.font, fallback.font, 90, 160),
  }]));
}
function readDisplayPreferences() {
  try {
    const saved = localStorage.getItem(displayPreferenceKey);
    if (saved) return normalizeDisplayPreferences(JSON.parse(saved));
    const previous = JSON.parse(localStorage.getItem('relay:display-preferences:v1'));
    if (previous?.desktop?.zoom === 67 && previous.desktop.font === 120) previous.desktop = { ...displayDefaults.desktop };
    const migrated = normalizeDisplayPreferences(previous);
    localStorage.setItem(displayPreferenceKey, JSON.stringify(migrated));
    return migrated;
  }
  catch { return normalizeDisplayPreferences(null); }
}
const displayMedia = matchMedia('(max-width:820px)');
let displayPreferences = readDisplayPreferences();
let displaySaved = true;
const displayMode = () => displayMedia.matches ? 'mobile' : 'desktop';
function applyDisplayPreferences() {
  const root = document.documentElement, settings = displayPreferences[displayMode()];
  const messages = $('.messages'), reading = captureChatScroll(messages);
  root.style.setProperty('--ui-zoom', settings.zoom / 100);
  root.style.setProperty('--ui-font-scale', settings.font / 100);
  root.style.setProperty('--ui-vh', `var(--standalone-vh, ${10000 / settings.zoom}dvh)`);
  root.style.setProperty('--ui-vw', `${10000 / settings.zoom}vw`);
  syncMobileViewport();
  resizeComposer($('#message-input'));
  restoreChatScroll(messages, reading);
  syncDisplaySettingsControls();
}
function changeDisplayPreference(key, value) {
  const mode = displayMode();
  displayPreferences = normalizeDisplayPreferences({ ...displayPreferences, [mode]: { ...displayPreferences[mode], [key]: value } });
  try { localStorage.setItem(displayPreferenceKey, JSON.stringify(displayPreferences)); displaySaved = true; }
  catch { displaySaved = false; }
  applyDisplayPreferences();
}
function syncDisplaySettingsControls() {
  if (!$('.display-settings')) return;
  const settings = displayPreferences[displayMode()];
  for (const key of ['zoom', 'font']) {
    $(`#display-${key}`).value = settings[key];
    $(`#display-${key}-value`).textContent = `${settings[key]}%`;
  }
  $('#display-device').textContent = displayMode() === 'desktop' ? '电脑显示设置' : '手机显示设置';
  $('#display-save-status').textContent = displaySaved ? '即时生效并自动保存到当前浏览器。电脑和手机分别设置。' : '已在当前页面生效；浏览器暂不允许保存，刷新后会恢复默认。';
}
function openDisplaySettings() {
  displayDiagnosticSnapshot = captureDisplayDiagnostics();
  ui.menu = null; renderTopbar();
  const modal = $('#modal'); captureMotion($('#modal-content')); modal.classList.remove('create-bot-modal');
  $('#modal-content').innerHTML = `<div class="display-settings"><div class="modal-header"><div><h2 id="display-device">显示设置</h2><p id="display-save-status"></p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 22)}</button></div><div class="display-settings-body"><div class="display-setting"><div class="display-setting-label"><label for="display-zoom">页面缩放</label><output id="display-zoom-value" for="display-zoom"></output></div><p>一起调整头像、控件、间距与文字的大小。</p><input id="display-zoom" type="range" min="50" max="125" step="1" aria-label="页面缩放"><div class="display-presets"><button data-action="display-preset" data-zoom="67">紧凑 67%</button><button data-action="display-preset" data-zoom="85">舒适 85%</button><button data-action="display-preset" data-zoom="100">原始 100%</button></div></div><div class="display-setting"><div class="display-setting-label"><label for="display-font">文字大小</label><output id="display-font-value" for="display-font"></output></div><p>单独调整全页字号，操作记录和代码输出也会同步变化。</p><input id="display-font" type="range" min="90" max="160" step="5" aria-label="文字大小"><div class="display-range-labels"><span>较小 90%</span><span>较大 160%</span></div></div><div class="display-text-preview"><strong>显示效果预览</strong><p>聊天内容、工具调用与操作结果</p><code>Bot 正在读取文件…</code><small class="display-build">界面版本：${UI_BUILD}</small><button class="text-button" data-action="copy-display-diagnostics">复制显示诊断</button></div></div><div class="modal-footer"><button class="secondary-button" data-action="display-reset">恢复默认</button><button class="primary-button" data-action="close-modal">完成</button></div></div>`;
  syncDisplaySettingsControls(); showModal(modal);
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/><circle cx="9" cy="7" r="4"/>',
  work: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M3 12a22 22 0 0 0 18 0m-9 0v3"/>',
  knowledge: '<path d="M12 7v15m0-15C8 3 4 3 2 4v15c3-1 6 0 10 3 4-3 7-4 10-3V4c-2-1-6-1-10 3Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 6a8 8 0 0 1 13.2 2.5L20 12M4 12l.7 3.5A8 8 0 0 0 17.9 18"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H4m6-6-6 6 6 6"/>',
  chevronBack: '<path d="m15 5-7 7 7 7"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  install: '<path d="M12 3v12m-5-5 5 5 5-5M5 15v5h14v-5"/>',
  edit: '<path d="m16 3 5 5-13 13H3v-5L16 3Zm-3 3 5 5"/>',
  pin: '<path d="m16 3 5 5-4 2-3 6-2-2-6 6m1-13 3-4 6 6-3 4-6-6Z"/>',
  layers: '<path d="m12 3 10 6-10 6L2 9l10-6Zm-9 12 9 5 9-5M3 12l9 5 9-5"/>',
  spark: '<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z"/>',
  link: '<path d="m10 13 4-4m-6 8-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m4 6a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-2 2" transform="translate(2 0) scale(.9)"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  event: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 14 8-14 8V4Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
const labels = { queued: '等待执行', running: '进行中', waiting: '等待答复', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', active: '活跃', paused: '已暂停', concluded: '已结束', fact: '事实', hypothesis: '假设', opinion: '意见', unverified: '待核查', disputed: '有争议', expired: '已过期', professional: '专业记忆', private: '私人记忆', group: '群聊', dm: '私聊', deep: '深聊' };
const tabs = [{ id: 'chat', title: '消息', icon: 'chat' }, { id: 'members', title: '成员', icon: 'people' }, { id: 'catalog', title: '能力目录', icon: 'link' }, { id: 'works', title: '工作', icon: 'work' }, { id: 'knowledge', title: '知识', icon: 'knowledge' }, { id: 'routines', title: '定时职责', icon: 'clock' }];
const state = { bots: [], rooms: [], works: [], agentRuns: [], routines: [], knowledge: { nodes: [], edges: [] }, provider: {}, runtime: {} };
const ui = { view: 'chat', roomId: 'room-lobby', botId: null, workId: null, nodeId: null, messages: [], roomJobs: [], memories: [], workDetail: null, graph: null, query: '', knowledgeResults: null, roomQuery: '', workFilter: 'all', mobileRoom: false, reply: null, drafts: {}, outbound: {}, loading: true, refreshing: false, refreshAgain: false, streamConnected: false };
Object.assign(ui, { detailOpen: false, detailTab: 'details', profileBotId: null, avatarEditing: false, avatarDraft: null, avatarTab: 'bot', searchOpen: false, menu: null, avatarSaving: false, sendingRooms: new Set(), draftTargets: {}, navigationSeq: 0, messageCache: new Map() });
Object.assign(ui, { agentRunsOpen: new Set(), agentToolsOpen: new Set(), agentRunDetails: new Map(), agentRunRequests: new Map(), agentRunsCancelling: new Set(), draftAttachments: {}, localMessages: {}, roomReadSeq: {} });
Object.assign(ui, { historyEpoch: null, historyGeneration: 0, retiredHistoryEpochs: new Set(), systemBotsOpen: false, retryingJobs: new Set() });
Object.assign(ui, { catalog: [], catalogId: null, catalogDetail: null, catalogQuery: '', catalogKind: '', catalogBusy: false });
const attachmentLimit = 8, attachmentMaxBytes = 20 * 1024 * 1024;
const attachmentDrafts = (roomId = ui.roomId) => ui.draftAttachments[roomId] || [];
const attachmentBusy = (roomId = ui.roomId) => attachmentDrafts(roomId).some(item => item.status !== 'ready');
const sendBusy = (roomId = ui.roomId) => ui.sendingRooms.has(roomId) || attachmentBusy(roomId);
function attachmentSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function attachmentUrl(item, preview = false) {
  return typeof item?.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(item.id) ? `/api/attachments/${encodeURIComponent(item.id)}${preview ? '/preview' : ''}` : '';
}
function renderMessageAttachments(items) {
  if (!Array.isArray(items)) return '';
  return `<div class="message-attachments">${items.filter(item => attachmentUrl(item)).map(item => `<a class="message-attachment ${item.previewUrl ? 'has-image' : ''}" href="${attachmentUrl(item)}" download="${esc(item.name)}" title="下载 ${esc(item.name)}">${item.previewUrl ? `<img src="${attachmentUrl(item, true)}" alt="${esc(item.name)}" loading="lazy">` : icon('file', 28)}<span><strong>${esc(item.name)}</strong><small>${attachmentSize(Number(item.size) || 0)} · 下载</small></span></a>`).join('')}</div>`;
}
function renderAttachmentDrafts() {
  const items = attachmentDrafts();
  if (!items.length) return '';
  return `<div class="attachment-drafts" aria-label="待发送附件">${items.map(item => `<div class="attachment-draft ${item.status === 'error' ? 'attachment-error' : ''}">${item.preview || item.attachment?.previewUrl ? `<img src="${esc(item.preview || attachmentUrl(item.attachment, true))}" alt="">` : icon('file', 26)}<span class="attachment-draft-copy"><strong>${esc(item.name)}</strong><small role="status">${esc(item.status === 'uploading' ? '正在上传…' : item.status === 'error' ? item.error : attachmentSize(item.size))}</small></span>${item.status === 'error' ? `<button type="button" class="icon-button" data-action="retry-attachment" data-id="${esc(item.key)}" aria-label="重试上传 ${esc(item.name)}">${icon('refresh', 18)}</button>` : ''}<button type="button" class="icon-button" data-action="remove-attachment" data-id="${esc(item.key)}" aria-label="移除附件 ${esc(item.name)}" ${ui.sendingRooms.has(ui.roomId) ? 'disabled' : ''}>${icon('close', 18)}</button></div>`).join('')}</div>`;
}
function chooseAttachments() {
  const roomId = ui.roomId;
  if (!roomById(roomId) || ui.sendingRooms.has(roomId)) return;
  const input = document.createElement('input');
  input.type = 'file'; input.hidden = true; input.multiple = true;
  // The system picker owns the photo/camera/file choices; avoid a second menu.
  document.body.append(input);
  input.addEventListener('change', () => { const files = [...(input.files || [])]; input.remove(); void addAttachments(roomId, files); }, { once: true });
  input.addEventListener('cancel', () => input.remove(), { once: true });
  input.click(); // Keep the native picker inside the user's click gesture (including iOS).
  ui.menu = null; render();
}
async function addAttachments(roomId, files) {
  const items = ui.draftAttachments[roomId] ||= [], added = [];
  for (const file of files) {
    if (items.length >= attachmentLimit) { toast('每条消息最多添加 8 个附件。', true); break; }
    if (file.size > attachmentMaxBytes) { toast(`${file.name} 超过 20 MB，请选择小一些的文件。`, true); continue; }
    const item = { key: globalThis.crypto?.randomUUID?.() || `file-${Date.now()}-${Math.random().toString(36).slice(2)}`, file, name: file.name, size: file.size, status: 'uploading',
      preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : '' };
    items.push(item); added.push(item);
  }
  render();
  for (const item of added) if (attachmentDrafts(roomId).includes(item)) await uploadAttachment(roomId, item);
}
async function uploadAttachment(roomId, item) {
  item.status = 'uploading'; item.error = ''; render();
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('文件读取失败，请重新选择。')); reader.readAsDataURL(item.file);
    });
    const attachment = await api('/api/attachments', 'POST', { name: item.name, mimeType: item.file.type || 'application/octet-stream', data });
    if (!attachmentUrl(attachment)) throw new Error('附件上传未完成，请重试。');
    item.attachment = attachment; item.status = 'ready';
  } catch (error) { item.status = 'error'; item.error = error.message; }
  if (ui.roomId === roomId) render();
}
function removeAttachment(key) {
  if (ui.sendingRooms.has(ui.roomId)) return;
  const items = attachmentDrafts(), item = items.find(item => item.key === key);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  ui.draftAttachments[ui.roomId] = items.filter(item => item.key !== key); render();
}
const updateDraftKey = 'relay:update-drafts';
let updateDraftArmed = false;
function preserveUpdateDrafts() {
  if (ui.sendingRooms.size) { toast('消息正在发送，请完成后再更新。'); return false; }
  if (Object.values(ui.draftAttachments).some(items => items.some(item => item.status !== 'ready'))) { toast('请等待附件上传完成，或移除上传失败的附件后再更新。'); return false; }
  try {
    const attachments = Object.fromEntries(Object.entries(ui.draftAttachments).map(([room, items]) => [room, items.map(({ key, name, size, attachment }) => ({ key, name, size, attachment, status: 'ready' }))]));
    const localMessages = Object.fromEntries(Object.entries(ui.localMessages || {}).map(([room, entries]) => [room, Object.values(entries).filter(entry => !entry.remoteConfirmed)]));
    sessionStorage.setItem(updateDraftKey, JSON.stringify({ savedAt: Date.now(), historyEpoch: ui.historyEpoch ?? null, drafts: ui.drafts, targets: ui.draftTargets, attachments, outbound: ui.outbound, localMessages, roomId: ui.roomId, mobileRoom: ui.mobileRoom, roomChosenByUser: !!ui.roomChosenByUser, reply: ui.reply }));
  } catch { toast('浏览器无法暂存草稿，请先复制未发送的文字。', true); return false; }
  updateDraftArmed = true;
  return true;
}
try {
  const saved = JSON.parse(sessionStorage.getItem(updateDraftKey) || 'null');
  sessionStorage.removeItem(updateDraftKey);
  if (saved && Date.now() - saved.savedAt < 86400000 && typeof saved.drafts === 'object' && saved.drafts) {
    ui.updateSnapshotRestored = true;
    ui.historyEpoch = saved.historyEpoch ?? null;
    ui.drafts = Object.fromEntries(Object.entries(saved.drafts).filter(([, value]) => typeof value === 'string'));
    ui.draftTargets = Object.fromEntries(Object.entries(saved.targets || {}).filter(([, value]) => typeof value === 'string'));
    ui.draftAttachments = Object.fromEntries(Object.entries(saved.attachments || {}).filter(([, value]) => Array.isArray(value)).map(([room, items]) => [room, items.filter(item => item.status === 'ready' && attachmentUrl(item.attachment)).slice(0, attachmentLimit)]));
    ui.outbound = Object.fromEntries(Object.entries(saved.outbound || {}).filter(([, value]) => value && typeof value.id === 'string' && typeof value.signature === 'string'));
    for (const [roomId, entries] of Object.entries(saved.localMessages || {})) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (typeof entry?.clientId !== 'string' || typeof entry.payload?.content !== 'string' || !entry.message) continue;
        const rooms = ui.localMessages ||= {}, messages = rooms[roomId] ||= {};
        messages[entry.clientId] = { ...entry, roomId, status: entry.status === 'sent' ? 'sent' : 'failed', error: entry.status === 'sent' ? '' : '尚未确认送达，可重试' };
      }
    }
    if (typeof saved.roomId === 'string') { ui.roomId = saved.roomId; ui.mobileRoom = !!saved.mobileRoom; ui.roomChosenByUser = !!saved.roomChosenByUser; }
    if (saved.reply && typeof saved.reply.id === 'string' && typeof saved.reply.content === 'string') ui.reply = saved.reply;
  }
} catch { /* A blocked or invalid session snapshot must not block the workspace. */ }

// Local outgoing messages remain visible through slow POSTs and stale GET snapshots.
function localRoomMessages(roomId) { return Object.values(ui.localMessages?.[roomId] || {}); }
function mergedRoomMessages(roomId, remote = []) {
  const result = [...remote];
  for (const entry of localRoomMessages(roomId)) {
    const received = remote.find(message => message.senderId === 'user' && message.clientId === entry.clientId);
    if (received) { entry.message = received; entry.status = 'sent'; entry.error = ''; entry.remoteConfirmed = true; }
    else if (!entry.remoteConfirmed) result.push({ ...entry.message, _delivery: entry.status === 'sent' ? null : entry.status, _retryId: entry.clientId, _sendError: entry.error });
  }
  return result;
}
function renderSendStatus(message) {
  if (!message._delivery) return '';
  return `<div class="message-delivery ${message._delivery === 'failed' ? 'failed' : ''}" role="status">${message._delivery === 'failed' ? `<span title="${esc(message._sendError)}">${esc(message._sendError || '未确认送达')}</span><button class="text-button" data-action="retry-message" data-id="${esc(message._retryId)}" ${ui.sendingRooms.has(message.roomId) ? 'disabled' : ''}>重试发送</button>` : '<span>正在发送…</span>'}</div>`;
}
function queueLocalMessage(roomId, payload, attachments) {
  const signature = JSON.stringify(payload), legacy = ui.outbound[roomId];
  const clientId = legacy?.signature === signature ? legacy.id : globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  delete ui.outbound[roomId];
  const rooms = ui.localMessages ||= {}, entries = rooms[roomId] ||= {};
  const message = { ...payload, attachments: attachments.map(item => ({ ...item.attachment })), id: `local-${clientId}`, clientId, roomId, senderId: 'user', kind: 'message', createdAt: new Date().toISOString() };
  return entries[clientId] = { roomId, clientId, payload, message, status: 'sending', error: '' };
}
async function sendLocalMessage(entry, scrollToEnd = false) {
  if (!entry || entry.status === 'sent' || ui.sendingRooms.has(entry.roomId) || ui.localMessages?.[entry.roomId]?.[entry.clientId] !== entry) return;
  const generation = ui.historyGeneration || 0;
  ui.sendingRooms.add(entry.roomId); entry.status = 'sending'; entry.error = '';
  render();
  const messages = $('.messages');
  if (scrollToEnd && messages && ui.roomId === entry.roomId) {
    messages._relayChatScroll?.toBottom(true);
  }
  try {
    const message = await api(`/api/rooms/${encodeURIComponent(entry.roomId)}/messages`, 'POST', { ...entry.payload, clientId: entry.clientId });
    if (generation !== (ui.historyGeneration || 0)) return;
    if (!message?.id || message.clientId !== entry.clientId || message.roomId !== entry.roomId) throw new Error('服务器回执不完整，请重试确认');
    entry.message = message; entry.status = 'sent'; entry.error = '';
  } catch (error) {
    // An SSE-triggered GET may already have confirmed this message before POST fails.
    if (generation === (ui.historyGeneration || 0) && entry.status !== 'sent') { entry.status = 'failed'; entry.error = error.message; toast('消息尚未确认送达，可在消息下方重试。', true); }
  } finally {
    if (generation === (ui.historyGeneration || 0)) ui.sendingRooms.delete(entry.roomId);
    render(); scheduleRefresh();
  }
}
let refreshTimer;
const avatarSaves = new Map();
let avatarSaveEpoch = 0;
ui.avatarSelectionRevision = 0;
function captureMotion(root) { return window.RelayMotion?.capture(root) || (window.RelayAvatars?.capture?.(root), null); }
function hydrateMotion(root, before) { if (window.RelayMotion) window.RelayMotion.hydrate(root, before || undefined); else window.RelayAvatars?.hydrate?.(root); }
function showModal(modal) { if (window.RelayMotion) window.RelayMotion.openDialog(modal); else { if (!modal.open) modal.showModal(); window.RelayAvatars?.hydrate?.(modal); } }
async function closeModal(modal = $('#modal')) { if (window.RelayMotion) await window.RelayMotion.closeDialog(modal); else modal.close(); }
const renderSignature = html => html.replace(/relay-avatar-clip-\d+/g, 'relay-avatar-clip').replace(/crew-\d+/g, 'crew-id').replace(/paper-avatar-\d+/g,'paper-avatar-id');


function formatTime(value, date = false) {
  if (!value) return '—';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', date ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false } : { hour: '2-digit', minute: '2-digit', hour12: false }).format(time);
}
function contactTime(value) {
  const time = new Date(value); if (!value || Number.isNaN(time.getTime())) return '';
  const today = new Date(), day = new Date(time); today.setHours(0, 0, 0, 0); day.setHours(0, 0, 0, 0);
  const elapsed = Math.round((today - day) / 86400000);
  return elapsed === 0 ? formatTime(value) : elapsed === 1 ? '昨天' : elapsed > 1 && elapsed < 7 ? new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(time) : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(time);
}
function formatDay(value) { const time = new Date(value); return Number.isNaN(time.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(time); }
function botById(id) { return state.bots.find(bot => bot.id === id); }
function roomById(id) { return state.rooms.find(room => room.id === id); }
function nameOf(id) { return id === 'user' ? ownerName() : (String(id || '').startsWith('executor:') ? '专业执行端' : botById(id)?.name || (id === 'system' ? 'Relay' : id || 'Relay')); }
function statusPill(value) { return `<span class="status ${esc(value)}">${esc(labels[value] || value || '未知')}</span>`; }
function listText(value) { return Array.isArray(value) ? value.join('、') : String(value || ''); }
function emptyState(title, description, button = '', iconName = 'spark') { return `<div class="empty-state">${icon(iconName, 32)}<h3>${esc(title)}</h3><p>${esc(description)}</p>${button}</div>`; }
function pageHeader(eyebrow, title, description, buttons = '') { return `<div class="page-header"><div><button class="text-button" data-action="navigate" data-view="chat">${icon('back', 17)}返回聊天</button><h1>${esc(tabs.find(tab => tab.id === ui.view)?.title || title)}</h1></div><div class="page-tools">${buttons}</div></div>`; }
function toast(message, error = false) {
  const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message; $('#toasts').append(node);
  setTimeout(() => node.remove(), error ? 10000 : 4000);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(method === 'GET' ? 30000 : 120000) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`服务返回了无法读取的内容（${response.status}）`); }
  if (!response.ok) throw new Error(data.error?.message || data.error || `请求失败（${response.status}）`);
  return data;
}
function showConnection(message = '') { const banner = $('#connection-banner'); banner.hidden = !message; banner.textContent = message; }
function captureChatScroll(messages) {
  if (!messages) return null;
  const top = messages.getBoundingClientRect().top;
  const item = [...messages.querySelectorAll('[data-message-id],[data-agent-run-id]')].find(node => node.getBoundingClientRect().bottom > top);
  const visible = messages.clientHeight > 0, tracking = messages._relayChatScroll;
  const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  return {
    top: messages.scrollTop,
    visible,
    atBottom: visible && (nearBottom || !!tracking?.followBottom),
    anchor: item && { attribute: item.hasAttribute('data-message-id') ? 'data-message-id' : 'data-agent-run-id', id: item.dataset.messageId || item.dataset.agentRunId, offset: item.getBoundingClientRect().top - top },
    outputs: [...messages.querySelectorAll('.agent-tool-body[id]')].map(body => ({ id: body.id, positions: [...body.querySelectorAll('pre')].map(pre => ({ top: pre.scrollTop, left: pre.scrollLeft })) })),
  };
}
function restoreChatScroll(messages, saved) {
  if (!messages || !saved) return;
  messages.scrollTop = saved.atBottom ? messages.scrollHeight : saved.top;
  if (!saved.atBottom && saved.anchor) {
    const item = [...messages.querySelectorAll(`[${saved.anchor.attribute}]`)].find(node => node.getAttribute(saved.anchor.attribute) === saved.anchor.id);
    if (item) {
      // DOM rects are visual pixels; scrollTop uses unzoomed layout pixels.
      const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
      messages.scrollTop += (item.getBoundingClientRect().top - messages.getBoundingClientRect().top - saved.anchor.offset) / zoom;
    }
  }
  for (const output of saved.outputs) {
    const body = document.getElementById(output.id);
    if (body) [...body.querySelectorAll('pre')].forEach((pre, index) => {
      const position = output.positions[index];
      if (position) { pre.scrollTop = position.top; pre.scrollLeft = position.left; }
    });
  }
}
function installChatScrollTracking(messages, followBottom) {
  if (messages._relayChatScroll) {
    messages._relayChatScroll.followBottom = followBottom;
    messages._relayChatScroll.lastTop = messages.scrollTop;
    messages._relayChatScroll.schedule();
    return;
  }
  let frame = 0, scrollFrom = 0, scrollStarted = 0, pointerY = null, draggingScrollbar = false;
  const tracking = { followBottom, lastTop: messages.scrollTop, stopped: false };
  const schedule = () => {
    if (frame || tracking.stopped || !tracking.followBottom) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (tracking.stopped || !messages.isConnected || !messages.clientHeight || !tracking.followBottom) return;
      const end = Math.max(0, messages.scrollHeight - messages.clientHeight);
      const progress = scrollStarted ? Math.min(1, (performance.now() - scrollStarted) / 300) : 1;
      messages.scrollTop = scrollFrom + (end - scrollFrom) * (1 - (1 - progress) ** 3);
      tracking.lastTop = messages.scrollTop;
      if (progress < 1) schedule(); else scrollStarted = 0;
    });
  };
  const onScroll = () => {
    const top = messages.scrollTop;
    if (messages.scrollHeight - top - messages.clientHeight < 40) tracking.followBottom = true;
    else if (draggingScrollbar) tracking.followBottom = false;
    tracking.lastTop = top;
  };
  messages.addEventListener('scroll', onScroll, { passive: true });
  const pause = () => { tracking.followBottom = false; scrollStarted = 0; cancelAnimationFrame(frame); frame = 0; };
  const onWheel = event => { if (event.deltaY < 0) pause(); };
  const onPointerDown = event => { pointerY = event.clientY; draggingScrollbar = event.pointerType === 'mouse' && event.clientX >= messages.getBoundingClientRect().right - 18; if (draggingScrollbar) pause(); };
  const onPointerMove = event => { if (pointerY !== null && event.clientY - pointerY > 5) pause(); };
  const onPointerEnd = () => { pointerY = null; draggingScrollbar = false; };
  const onKey = event => { if (['ArrowUp','PageUp','Home'].includes(event.key)) pause(); };
  messages.addEventListener('wheel', onWheel, { passive: true });
  messages.addEventListener('pointerdown', onPointerDown, { passive: true });
  messages.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerup', onPointerEnd, { passive: true });
  window.addEventListener('pointercancel', onPointerEnd, { passive: true });
  messages.addEventListener('keydown', onKey);
  messages.addEventListener('load', schedule, true);
  messages.addEventListener('error', schedule, true);
  // Images, fonts and expanded content can change height after the first paint.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
  observer?.observe(messages);
  const composer = messages.parentElement.querySelector('.composer-wrap');
  if (composer) observer?.observe(composer);
  for (const child of messages.children) observer?.observe(child);
  tracking.schedule = schedule;
  tracking.toBottom = (smooth = false) => {
    tracking.followBottom = true;
    scrollFrom = messages.scrollTop;
    scrollStarted = smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? performance.now() : 0;
    schedule();
  };
  tracking.stop = () => {
    tracking.stopped = true; cancelAnimationFrame(frame); observer?.disconnect();
    messages.removeEventListener('scroll', onScroll);
    messages.removeEventListener('wheel', onWheel);
    messages.removeEventListener('pointerdown', onPointerDown);
    messages.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerEnd);
    window.removeEventListener('pointercancel', onPointerEnd);
    messages.removeEventListener('keydown', onKey);
    messages.removeEventListener('load', schedule, true);
    messages.removeEventListener('error', schedule, true);
    delete messages._relayChatScroll;
  };
  messages._relayChatScroll = tracking;
  schedule();
}
function restoreConversationScroll(messages, saved, { sameView, ready, wasReady }) {
  if (!messages || !messages.clientHeight) return;
  const entering = !sameView || !saved?.visible || (!wasReady && ready);
  if (entering) messages.scrollTop = messages.scrollHeight;
  else restoreChatScroll(messages, saved);
  installChatScrollTracking(messages, entering || !!saved?.atBottom);
}
function preserveView() {
  const main = $('#main-content'), messages = $('.messages'), works = $('.works-list'), detail = $('.work-detail');
  const active = document.activeElement;
  return { key: main.dataset.viewKey, chatReady: $('.chat-layout')?.dataset.ready === 'true', fields: $$('input[id]:not([type=file]),textarea[id],select[id]', main).map(field => ({ id: field.id, value: field.value })), panelTop: $('.detail-panel')?.scrollTop, panelSection: $('.detail-panel')?.dataset.section, top: main.scrollTop, chatScroll: captureChatScroll(messages), workTop: works?.scrollTop, detailTop: detail?.scrollTop, focusId: active?.id, start: active?.selectionStart, end: active?.selectionEnd };
}
function render() {
  persistClientSession();
  if (ui.composing && document.activeElement?.id === 'message-input' && document.activeElement.form?.dataset.roomId === ui.roomId) { ui.renderDeferred = true; return; }
  ui.renderDeferred = false;
  const saved = preserveView();
  const navigation = window.RelayMotion?.captureNavigation(ui.view === 'chat' ? (ui.mobileRoom ? `chat:${ui.roomId}` : 'list') : ui.view);
  markCurrentRoomRead(); renderTopbar();
  const views = { chat: renderChat, members: renderMembers, catalog: renderCatalog, works: renderWorks, knowledge: renderKnowledge, routines: renderRoutines };
  const key = `${ui.view}:${ui.view === 'chat' ? ui.roomId : ui.view === 'members' ? ui.botId : ui.view === 'works' ? ui.workId : ''}`;
  const main = $('#main-content'), html = views[ui.view]();
  const signature = renderSignature(html);
  const restoreConversation = () => restoreConversationScroll($('.messages'), saved.chatScroll, { sameView: saved.key === key, ready: ui.messagesRoomId === ui.roomId, wasReady: saved.chatReady });
  if (ui.lastMainHtml === signature && main.dataset.viewKey === key) { restoreFocus(saved); restoreConversation(); window.RelayMotion?.finishNavigation(navigation); return; }
  const motion = captureMotion(main);
  $('.messages')?._relayChatScroll?.stop();
  main.innerHTML = html; ui.lastMainHtml = signature;
  main.dataset.viewKey = key;
  if (saved.key === key) for (const field of saved.fields) { const target = document.getElementById(field.id); if (target) target.value = field.value; }
  $('#main-content').scrollTop = saved.top;
  const works = $('.works-list'); if (works) works.scrollTop = saved.workTop || 0;
  const detail = $('.work-detail'); if (detail) detail.scrollTop = saved.detailTop || 0;
  resizeComposer($('#message-input'));
  hydrateMotion(main, motion);
  const panel = $('.detail-panel:not([data-motion-ghost])'); if (panel && panel.dataset.section === saved.panelSection) panel.scrollTop = saved.panelTop || 0;
  restoreFocus(saved);
  restoreConversation();
  window.RelayMotion?.finishNavigation(navigation);
}
function restoreFocus(saved) { if (!saved.focusId) return; const target = document.getElementById(saved.focusId); if (target) { target.focus({ preventScroll: true }); if (saved.start != null && target.setSelectionRange && !['number','email','file'].includes(target.type)) target.setSelectionRange(saved.start, saved.end); } }
function updateComposerButton(input) {
  const button = input?.form?.querySelector('.composer-send');
  if (!button) return;
  const hasContent = Boolean(input.value.trim() || attachmentDrafts(input.form.dataset.roomId).length);
  const label = hasContent ? '发送消息' : '语音输入（暂未开放）';
  button.innerHTML = icon(hasContent ? 'send' : 'microphone', 25);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = sendBusy(input.form.dataset.roomId) || !hasContent;
}
function resizeComposer(input) { if (!input) return; updateComposerButton(input); input.style.height = 'auto'; const height = input.scrollHeight, limit = parseFloat(getComputedStyle(input).maxHeight) || 150; input.style.height = `${Math.min(limit, height)}px`; input.style.overflowY = height > limit ? 'auto' : 'hidden'; }

function unresolvedJobLeaves(jobs = ui.roomJobs, messages = ui.messages) {
  const parents = new Set(jobs.map(job => job.retryOf).filter(Boolean));
  return jobs.filter(job => !parents.has(job.id) && ['failed', 'interrupted'].includes(job.status) && !messages.some(message =>
    message.jobId === job.id && message.replyTo === job.messageId && message.senderId === job.botId && message.kind !== 'error'));
}
function messageJobNotices(messageId, failures) {
  return failures.filter(job => job.messageId === messageId).map(job => {
    const retrying = ui.retryingJobs?.has(job.id);
    return `<div class="job-notice" data-job-id="${esc(job.id)}" role="status"><div><strong>${esc(nameOf(job.botId))} 的${job.lane === 'deep' ? '深聊' : '回复'}${job.status === 'interrupted' ? '已中断' : '未完成'}</strong><p>${esc(job.error?.message || (typeof job.error === 'string' ? job.error : '') || '可根据当前状态重新尝试。')}</p></div><button class="small-button" data-action="retry-job" data-id="${esc(job.id)}" ${retrying ? 'disabled' : ''}>${retrying ? '正在安排…' : '重新尝试'}</button></div>`;
  }).join('');
}
function roomNotices(room, failures = unresolvedJobLeaves()) {
  const conclusion = room?.conclusion ? `<details class="conclusion-panel" open><summary>${icon('knowledge', 14)} 深聊结论</summary><div class="message-content">${richText(room.conclusion)}</div>${room.conclusionId ? `<button class="text-button" data-action="open-knowledge" data-id="${esc(room.conclusionId)}">查看知识记录 ${icon('arrow', 12)}</button>` : ''}</details>` : '';
  const orphaned = failures.filter(job => !ui.messages.some(message => message.id === job.messageId));
  return `${conclusion}${orphaned.length ? `<details class="historical-job-notices"><summary>历史任务记录 · ${orphaned.length}</summary><p>以下任务的原消息不在当前会话记录中。</p>${orphaned.map(job => messageJobNotices(job.messageId, [job])).join('')}</details>` : ''}`;
}
function agentRunVersion(run) { return JSON.stringify([run?.status, run?.toolCount, run?.finishedAt, run?.error, run?.lastTool]); }
function visibleAgentRuns(roomId = ui.roomId) { return (state.agentRuns || []).filter(run => run.roomId === roomId && (['accepted', 'queued', 'running', 'waiting'].includes(run.status) || Number(run.toolCount) > 0)); }
async function loadAgentRunDetails(id, force = false) {
  const generation = ui.historyGeneration || 0;
  if (ui.agentRunRequests.has(id)) return ui.agentRunRequests.get(id);
  const run = state.agentRuns.find(item => item.id === id), version = agentRunVersion(run), previous = ui.agentRunDetails.get(id);
  if (!force && run?.status !== 'running' && previous?.version === version) return;
  const request = (async () => {
    ui.agentRunDetails.set(id, { ...previous, version, loading: true, error: '' });
    try {
      const detail = await api(`/api/agent-runs/${encodeURIComponent(id)}`);
      if (generation !== (ui.historyGeneration || 0)) return;
      ui.agentRunDetails.set(id, { detail, version, loading: false, error: '' });
    } catch (error) { if (generation === (ui.historyGeneration || 0)) ui.agentRunDetails.set(id, { ...previous, version, loading: false, error: error.message }); }
    finally {
      ui.agentRunRequests.delete(id);
      if (ui.view === 'chat' && ui.agentRunsOpen.has(id) && state.agentRuns.some(item => item.id === id && item.roomId === ui.roomId)) render();
      const latest = state.agentRuns.find(item => item.id === id);
      if (ui.agentRunsOpen.has(id) && latest?.roomId === ui.roomId && agentRunVersion(latest) !== version) void loadAgentRunDetails(id);
    }
  })();
  ui.agentRunRequests.set(id, request);
  return request;
}
function refreshOpenAgentRuns() {
  if (ui.view !== 'chat') return;
  for (const run of visibleAgentRuns()) if (ui.agentRunsOpen.has(run.id)) void loadAgentRunDetails(run.id);
}
function agentToolText(value) { return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2); }
function renderAgentToolResult(value) {
  const result = value?.details ?? value;
  if (result && typeof result === 'object' && typeof result.stdout === 'string') {
    const { stdout, stderr, ...metadata } = result;
    return `<span class="agent-output-label">结果</span><pre>${esc(agentToolText(metadata))}</pre><span class="agent-output-label">标准输出</span><pre>${esc(stdout || '（空）')}</pre>${stderr ? `<span class="agent-output-label">错误输出</span><pre>${esc(stderr)}</pre>` : ''}`;
  }
  return `<span class="agent-output-label">结果</span><pre>${esc(agentToolText(result))}</pre>`;
}
function renderAgentArtifacts(runId, tool) {
  const encodeId = value => {
    if (typeof value !== 'string' || !value || value.length > 1024 || value === '.' || value === '..' || /[\x00-\x1f]/.test(value)) return '';
    try { return encodeURIComponent(value); } catch { return ''; }
  };
  const run = encodeId(runId), call = encodeId(tool.id);
  if (!run || !call || !Array.isArray(tool.artifacts)) return '';
  const items = tool.artifacts.filter(item => item && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(item.id));
  if (!items.length) return '';
  return `<span class="agent-output-label">完整产物</span><div class="message-attachments">${items.map(item => {
    const url = `/api/agent-runs/${run}/tools/${call}/artifacts/${encodeURIComponent(item.id)}`;
    return `<a class="message-attachment" href="${url}" download="${esc(item.name || '产物')}" title="下载 ${esc(item.name || '产物')}">${icon('file', 28)}<span><strong>${esc(item.name || '产物')}</strong><small>${attachmentSize(Number(item.size) || 0)} · 下载</small></span></a>`;
  }).join('')}</div>`;
}
function renderAgentContext(run) {
  const compactions = run.compactions || [], resources = run.resources;
  return (compactions.length ? '<div class="agent-run-note">本次压缩了 ' + compactions.length + ' 次上下文；完整会话原文保留。</div>' + compactions.map(item => '<p class="agent-run-note">估算 ' + Number(item.tokensBefore) + ' → ' + Number(item.estimatedTokensAfter) + ' token</p>').join('') : '') +
    (resources?.skills?.length ? '<p class="agent-run-note">可用技能：' + resources.skills.map(skill => esc(skill.name)).join('、') + '</p>' : '') +
    (resources?.diagnostics || []).map(item => '<p class="agent-run-note">资源提示：' + esc(item.message) + '</p>').join('') +
    (run.extensionErrors || []).map(message => '<p class="agent-run-error">扩展事件：' + esc(message) + '</p>').join('');
}
function renderAgentRun(run, { showBot = false } = {}) {
  const open = ui.agentRunsOpen.has(run.id), entry = ui.agentRunDetails.get(run.id), detail = entry?.detail, cancelling = ui.agentRunsCancelling.has(run.id);
  const toolNames = { read_file: '读取文件', write_file: '写入文件', edit_file: '修改文件', list_files: '查看目录', search_files: '搜索文件', search_text: '搜索内容', execute_command: '执行命令', run_command: '执行命令', relay_action: '成员协作', search_knowledge: '搜索知识', read_resource: '读取技能资源', read_session_history: '读取会话原文' };
  const tools = Array.isArray(detail?.tools) ? detail.tools : [];
  const content = open ? `<div class="agent-run-body" id="agent-run-${esc(run.id)}">${run.workspace ? `<p class="agent-workspace">工作目录 <code>${esc(run.workspace)}</code></p>` : ''}${entry?.loading ? '<p class="agent-run-note" role="status">正在读取执行记录…</p>' : ''}${entry?.error ? `<div class="agent-run-error">无法读取执行记录：${esc(entry.error)} <button class="text-button" data-action="refresh-agent-run" data-id="${esc(run.id)}">重试</button></div>` : ''}${renderAgentContext(detail || run)}${tools.map(tool => {
    const key = `${run.id}:${tool.id || tool.toolCallId}`, toolOpen = ui.agentToolsOpen.has(key), input = toolOpen ? agentToolText(tool.args) : '', result = toolOpen ? agentToolText(tool.result) : '';
    const hint = tool.args && typeof tool.args === 'object' ? tool.args.path || tool.args.command || tool.args.query || tool.args.pattern || '' : '';
    return `<div class="agent-tool"><button class="agent-tool-heading" data-action="toggle-agent-tool" data-id="${esc(key)}" aria-expanded="${toolOpen}" aria-controls="agent-tool-${esc(key)}"><span class="agent-disclosure" aria-hidden="true">${toolOpen ? '▾' : '▸'}</span><strong>${esc(toolNames[tool.name] || tool.name || '工具')}</strong>${hint ? `<span class="agent-tool-hint" title="${esc(hint)}">${esc(hint)}</span>` : ''}${statusPill(tool.status)}</button>${toolOpen ? `<div class="agent-tool-body" id="agent-tool-${esc(key)}"><div class="agent-tool-meta"><code>${esc(tool.name)}</code><time>${esc(formatTime(tool.startedAt, true))}${tool.finishedAt ? ` → ${esc(formatTime(tool.finishedAt))}` : ''}</time></div>${renderAgentArtifacts(run.id, tool)}<span class="agent-output-label">输入</span><pre>${esc(input || '无参数')}</pre>${result ? renderAgentToolResult(tool.result) : ''}${tool.error ? `<p class="agent-run-error">${esc(agentToolText(tool.error))}</p>` : ''}${!result && !tool.error ? `<p class="agent-run-note">${tool.status === 'running' ? '工具正在执行，尚无结果。' : '没有记录到结果内容。'}</p>` : ''}</div>` : ''}</div>`;
  }).join('')}${!tools.length && !entry?.loading && !entry?.error ? `<p class="agent-run-note">${run.status === 'running' ? '正在处理，尚无工具调用记录。' : '没有工具调用记录。'}</p>` : ''}${run.error ? `<p class="agent-run-error">${esc(agentToolText(run.error))}</p>` : ''}${run.summary ? `<p class="agent-run-summary">${esc(agentToolText(run.summary))}</p>` : ''}${run.finishedAt ? `<time class="agent-run-note">结束于 ${esc(formatTime(run.finishedAt, true))}</time>` : ''}</div>` : '';
  const latestTool = run.lastTool || tools.at(-1), summary = executionSummary(run, latestTool);
  const memberColor = botById(run.botId) ? botAvatar(run.botId).color : '#8b8e9f';
  return `<div class="message-work-status ${esc(run.status)} ${open ? 'expanded' : ''}" data-agent-run-id="${esc(run.id)}" style="--member-color:${esc(memberColor)}"><div class="work-status-line"><button class="work-status-toggle" data-action="toggle-agent-run" data-id="${esc(run.id)}" aria-expanded="${open}" aria-controls="agent-run-${esc(run.id)}">${showBot ? avatar(run.botId, 22, `run:${run.id}:owner`) : '<i class="work-status-dot" aria-hidden="true"></i>'}<span>${showBot ? `${esc(nameOf(run.botId))} · ` : ''}${esc(summary.text)}</span><span class="work-status-chevron" aria-hidden="true">${icon('chevron', 15)}</span>${summary.path ? `<small class="work-status-path" title="${esc(summary.path)}">${esc(summary.path)}</small>` : ''}</button>${open && ['running', 'accepted', 'queued', 'waiting'].includes(run.status) ? `<button class="agent-run-cancel text-button" data-action="cancel-agent-run" data-id="${esc(run.id)}" ${cancelling ? 'disabled' : ''} aria-label="取消${esc(nameOf(run.botId))}的操作">${cancelling ? '正在取消…' : '取消'}</button>` : ''}</div>${content}</div>`;
}
async function refresh(force = false) {
  if (ui.cacheBootPromise && !ui.cacheReady) await ui.cacheBootPromise;
  if (ui.refreshing) { ui.refreshAgain = true; return; }
  ui.refreshing = true;
  try {
    const avatarReadEpoch = avatarSaveEpoch;
    const synced = await requestSyncedSnapshot('/api/state', ui.workspaceSnapshot ? { snapshot: ui.workspaceSnapshot, cursor: ui.workspaceCursor } : null);
    if (!synced) return;
    const next = synced.snapshot;
    ui.workspaceSnapshot = next; ui.workspaceCursor = synced.cursor;
    void globalThis.RelayCache?.writeWorkspace(synced);
    Object.assign(state, structuredClone(next)); for (const [id, pending] of avatarSaves) { const bot = state.bots?.find(item => item.id === id); if (bot && (pending.running || pending.error || pending.savedVersion !== pending.version || avatarReadEpoch < pending.confirmedEpoch)) bot.avatar = { ...pending.target }; else if (!pending.running && !pending.error) avatarSaves.delete(id); } state.bots ||= []; state.rooms ||= []; state.works ||= []; state.agentRuns ||= []; state.routines ||= []; state.knowledge ||= { nodes: [], edges: [] };
    const preferred = defaultConversationId();
    if (!roomById(ui.roomId) || !ui.roomChosenByUser && preferred !== ui.roomId) { ui.roomId = preferred; ui.reply = null; await restoreRoomMessages(ui.roomId); }
    if (!botById(ui.botId)) ui.botId = state.bots.find(bot => !bot.presetId)?.id || null;
    if (!state.works.some(work => work.id === ui.workId)) ui.workId = state.works[0]?.id || null;
    if (!state.knowledge.nodes?.some(node => node.id === ui.nodeId)) ui.nodeId = state.knowledge.nodes?.[0]?.id || null;
    // Publish the workspace immediately; a slow room GET must not blank the list.
    ui.loading = false; render();
    await loadCurrent();
    ui.loading = false; showConnection(ui.streamConnected ? '' : '实时连接暂未建立，当前显示最近一次读取的状态；正在自动重连。'); render();
  } catch (error) { showConnection(`无法读取最新状态：${error.message}。请检查本地服务后刷新。`); if (ui.loading) $('#main-content').innerHTML = emptyState('暂时无法打开工作空间', error.message, '<button class="primary-button" data-action="refresh">重新连接</button>', 'info'); else if (force) toast(error.message, true); }
  finally { ui.refreshing = false; if (ui.refreshAgain) { ui.refreshAgain = false; scheduleRefresh(); } }
}
async function loadCurrent() {
  if (ui.view === 'catalog') {
    const query = new URLSearchParams({query:ui.catalogQuery,kind:ui.catalogKind});
    const response = await api(`/api/catalog?${query}`);
    ui.catalog = response.entries || [];
    if (ui.catalogId) {
      try { ui.catalogDetail = await api(`/api/catalog/${encodeURIComponent(ui.catalogId)}`); }
      catch (error) { if (!ui.catalog.some(item=>item.id===ui.catalogId)) { ui.catalogId=null;ui.catalogDetail=null; } else throw error; }
    }
  }
  if (ui.view === 'chat' && ui.roomId) {
    const id = ui.roomId, sequence = ui.roomReadSeq[id] = (ui.roomReadSeq[id] || 0) + 1;
    const baseline = ui.messageCache.get(id);
    const synced = await requestSyncedSnapshot(`/api/rooms/${encodeURIComponent(id)}/messages`, baseline?.snapshot ? { snapshot: baseline.snapshot, cursor: baseline.cursor } : null);
    if (!synced) return;
    const response = synced.snapshot;
    if (sequence !== ui.roomReadSeq[id]) return;
    const cached = { snapshot: response, cursor: synced.cursor, messages: Array.isArray(response) ? response : response.messages || [], jobs: response.jobs || [] }; ui.messageCache.set(id, cached);
    void globalThis.RelayCache?.writeRoom(id, synced);
    mergedRoomMessages(id, cached.messages);
    if (id === ui.roomId) { ui.messagesRoomId = id; ui.messages = cached.messages; ui.roomJobs = cached.jobs; refreshOpenAgentRuns(); }
    const bot = profileBot();
    if (ui.detailOpen && bot) {
      ui.botId = bot.id;
      const memories = await api(`/api/bots/${encodeURIComponent(bot.id)}/memories`);
      if (profileBot()?.id === bot.id) ui.memories = memories.memories || [];
    }
  } else if (ui.view === 'members' && ui.botId) {
    const id = ui.botId, response = await api(`/api/bots/${encodeURIComponent(id)}/memories`); if (id === ui.botId) ui.memories = response.memories || response || [];
  } else if (ui.view === 'works' && ui.workId) {
    const id = ui.workId, response = await api(`/api/works/${encodeURIComponent(id)}`); if (id === ui.workId) ui.workDetail = response.work ? { ...response.work, events: response.events || [] } : response;
  } else if (ui.view === 'knowledge') {
    if (ui.query) ui.knowledgeResults = await api(`/api/knowledge/search?q=${encodeURIComponent(ui.query)}`);
    if (ui.nodeId) ui.graph = await api(`/api/knowledge/graph?id=${encodeURIComponent(ui.nodeId)}&depth=1`);
  }
}
function defaultConversationId() {
  const custom = new Set(state.bots.filter(bot => !bot.presetId).map(bot => bot.id));
  return state.rooms.find(room => room.kind === 'dm' && room.members?.includes('user') && room.members.some(id => custom.has(id)))?.id
    || state.rooms.find(room => room.kind !== 'dm')?.id || null;
}
async function restoreRoomMessages(id) {
  const generation = ui.historyGeneration || 0;
  let cached = ui.messageCache.get(id);
  if (!cached && id && globalThis.RelayCache) {
    const stored = await globalThis.RelayCache.readRoom(id);
    if (generation !== (ui.historyGeneration || 0)) return;
    if (stored && (stored.snapshot.historyEpoch ?? null) === (ui.historyEpoch ?? null)) {
      cached = { ...stored, messages: stored.snapshot.messages, jobs: stored.snapshot.jobs };
      // A live response can arrive while IndexedDB is being read.
      if (!ui.messageCache.has(id)) ui.messageCache.set(id, cached);
      else cached = ui.messageCache.get(id);
    }
  }
  if (ui.roomId !== id) return;
  ui.messages = cached?.messages || []; ui.roomJobs = cached?.jobs || []; ui.messagesRoomId = cached ? id : null;
}
function clientSessionSnapshot() {
  const localMessages = Object.fromEntries(Object.entries(ui.localMessages || {}).map(([roomId, entries]) => [roomId,
    Object.values(entries).filter(entry => !entry.remoteConfirmed && (entry.status !== 'sent' || !ui.messageCache.get(roomId)?.messages.some(message => message.clientId === entry.clientId)))]));
  const attachments = Object.fromEntries(Object.entries(ui.draftAttachments || {}).map(([roomId, entries]) => [roomId,
    entries.filter(entry => entry.status === 'ready').map(({ key, name, size, attachment }) => ({ key, name, size, attachment, status: 'ready' }))]));
  return { historyEpoch: ui.historyEpoch ?? null, roomId: ui.roomId, roomChosenByUser: !!ui.roomChosenByUser, mobileRoom: ui.mobileRoom, drafts: ui.drafts, targets: ui.draftTargets, reply: ui.reply, attachments, localMessages };
}
async function acceptHistoryEpoch(response, requestedGeneration) {
  const epoch = response?.historyEpoch ?? response?.snapshot?.historyEpoch ?? null;
  if (epoch === (ui.historyEpoch ?? null)) return true;
  // A response started before an accepted reset must never restore an older
  // epoch, even when its room request happens to be the most recent one.
  if (requestedGeneration !== (ui.historyGeneration || 0) || ui.retiredHistoryEpochs?.has(epoch)) { scheduleRefresh(); return false; }
  (ui.retiredHistoryEpochs ||= new Set()).add(ui.historyEpoch ?? null);
  ui.historyEpoch = epoch; ui.historyGeneration = (ui.historyGeneration || 0) + 1;
  ui.messages = []; ui.roomJobs = []; ui.messagesRoomId = null;
  ui.messageCache.clear(); ui.workspaceSnapshot = null; ui.workspaceCursor = null;
  ui.localMessages = {}; ui.outbound = {}; ui.reply = null; ui.sendingRooms.clear();
  ui.agentRunDetails?.clear(); ui.agentRunRequests?.clear(); ui.agentRunsOpen?.clear(); ui.agentToolsOpen?.clear(); ui.retryingJobs?.clear();
  if (typeof state !== 'undefined') {
    state.agentRuns = []; state.activity = []; state.works = [];
    if (state.runtime) state.runtime.jobs = [];
    for (const room of state.rooms || []) delete room.lastMessage;
  }
  try { sessionStorage.removeItem('relay:update-drafts'); } catch { /* Storage may be blocked. */ }
  const session = clientSessionSnapshot();
  ui.lastSessionSignature = JSON.stringify(session);
  // UI updates immediately; durable cache clearing is a barrier for the new
  // epoch's subsequent snapshot/session writes. Unsent drafts are retained.
  const reset = globalThis.RelayCache?.resetHistory?.(epoch, session);
  render();
  await reset;
  return true;
}
async function requestSyncedSnapshot(path, previous) {
  const cache = globalThis.RelayCache;
  const read = async cursor => {
    const generation = ui.historyGeneration || 0;
    const response = await api(cache ? `${path}?sync=1${cursor ? `&since=${encodeURIComponent(cursor)}` : ''}` : path);
    if (!await acceptHistoryEpoch(response, generation)) return null;
    return response;
  };
  const response = await read(previous?.cursor);
  if (!response) return null;
  if (!response.sync) return { snapshot: response, cursor: null }; // Rolling server update.
  try { return { snapshot: cache.applySync(previous?.snapshot, response), cursor: response.sync.cursor }; }
  catch (error) {
    if (!previous?.cursor) throw error;
    const reset = await read(null);
    if (!reset) return null;
    if (!reset.sync) return { snapshot: reset, cursor: null };
    return { snapshot: cache.applySync(null, reset), cursor: reset.sync.cursor };
  }
}
function persistClientSession() {
  const cache = globalThis.RelayCache;
  if (!cache || !ui.cacheReady) return;
  const session = clientSessionSnapshot();
  const signature = JSON.stringify(session);
  if (signature === ui.lastSessionSignature) return;
  ui.lastSessionSignature = signature;
  void cache.writeSession(session);
}
function restoreClientSession(saved) {
  if (!saved || ui.updateSnapshotRestored) return;
  const selected = roomById(saved.roomId);
  const systemRoom = selected?.kind === 'dm' && selected.members?.includes('user') && selected.members.some(id => state.bots.find(bot => bot.id === id)?.presetId);
  if (typeof saved.roomId === 'string' && selected && (!systemRoom || saved.roomChosenByUser)) { ui.roomId = saved.roomId; ui.mobileRoom = !!saved.mobileRoom; ui.roomChosenByUser = saved.roomChosenByUser !== false; }
  ui.drafts = Object.fromEntries(Object.entries(saved.drafts || {}).filter(([, text]) => typeof text === 'string'));
  ui.draftTargets = Object.fromEntries(Object.entries(saved.targets || {}).filter(([, id]) => typeof id === 'string'));
  ui.draftAttachments = Object.fromEntries(Object.entries(saved.attachments || {}).filter(([, entries]) => Array.isArray(entries)).map(([id, entries]) =>
    [id, entries.filter(entry => entry?.status === 'ready' && attachmentUrl(entry.attachment)).slice(0, attachmentLimit)]));
  for (const [roomId, entries] of Object.entries((saved.historyEpoch ?? null) === (ui.historyEpoch ?? null) ? saved.localMessages || {} : {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.clientId !== 'string' || typeof entry.payload?.content !== 'string' || !entry.message) continue;
      (ui.localMessages[roomId] ||= {})[entry.clientId] = { ...entry, roomId,
        status: entry.status === 'sent' ? 'sent' : 'failed', error: entry.status === 'sent' ? '' : '尚未确认送达，可重试' };
    }
  }
  if ((saved.historyEpoch ?? null) === (ui.historyEpoch ?? null) && saved.reply && typeof saved.reply.id === 'string' && typeof saved.reply.content === 'string') ui.reply = saved.reply;
}
async function restoreCachedWorkspace() {
  try {
    const cache = globalThis.RelayCache;
    if (!cache) return;
    await cache.ready();
    const [workspace, session] = await Promise.all([cache.readWorkspace(), cache.readSession()]);
    const storedEpoch = workspace?.snapshot?.historyEpoch ?? session?.historyEpoch ?? null;
    if (ui.updateSnapshotRestored && (ui.historyEpoch ?? null) !== storedEpoch) { ui.localMessages = {}; ui.outbound = {}; ui.reply = null; }
    ui.historyEpoch = storedEpoch;
    if (workspace) {
      ui.workspaceSnapshot = workspace.snapshot; ui.workspaceCursor = workspace.cursor;
      Object.assign(state, structuredClone(workspace.snapshot));
      restoreClientSession(session);
      if (!roomById(ui.roomId) || !ui.roomChosenByUser) ui.roomId = defaultConversationId();
      await restoreRoomMessages(ui.roomId);
      ui.loading = false;
      showConnection('已显示本机记录，正在同步最新消息…');
    } else restoreClientSession(session);
  } catch { /* An unreadable local cache must not prevent network recovery. */ }
  finally { ui.cacheReady = true; if (!ui.loading) render(); else renderTopbar(); }
}
function scheduleRefresh() { if (refreshTimer) return; refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, 230); }
async function navigate(view) { ui.navigationSeq++; ui.menu = null; ui.view = view; location.hash = view; render(); try { await loadCurrent(); render(); } catch (error) { toast(error.message, true); render(); } }

function roomSection(title, kind, rooms) {
  const filtered = rooms.filter(room => room.kind === kind && (!ui.roomQuery || room.name?.toLowerCase().includes(ui.roomQuery.toLowerCase())));
  if (!filtered.length) return '';
  return `<div class="section-label">${title}<span>${filtered.length}</span></div>${filtered.map(room => {
    const members = (room.members || []).filter(id => id !== 'user');
    const description = room.status === 'concluded' ? '已结束 · 结论已保留' : room.goal || (kind === 'dm' ? members.map(nameOf).join('、') : `${members.length} 位成员 · ${kind === 'deep' ? '独立深入讨论' : '随时交流'}`);
    return `<button class="room-row ${room.id === ui.roomId ? 'selected' : ''}" data-action="select-room" data-id="${esc(room.id)}"><span class="room-symbol">${kind === 'group' ? '#' : icon(kind === 'deep' ? 'layers' : 'chat', 17)}</span><span class="room-copy"><strong>${esc(room.name || '未命名会话')}</strong><p>${esc(description)}</p></span>${room.kind === 'deep' && room.status === 'active' ? '<i class="room-kind-dot"></i>' : ''}</button>`;
  }).join('')}`;
}
function renderMembers() {
  const bot = botById(ui.botId); const expertise = Array.isArray(bot?.expertise) ? bot.expertise : String(bot?.expertise || '').split(/[、,，\n]/).filter(Boolean);
  return `<div class="page">${pageHeader('The people behind the work', '各有专长，一起向前。', '长期身份与专业责任，让每次合作都有积累。', `<button class="primary-button" data-action="new-bot">${icon('plus', 15)}新建成员</button>`)}<div class="bot-directory"><div class="directory-list"><div class="directory-list-head"><span>成员目录</span><span>${state.bots.length} 位成员</span></div>${state.bots.map(item => `<button class="bot-row ${item.id === ui.botId ? 'selected' : ''}" data-action="select-bot" data-id="${esc(item.id)}">${avatar(item.id)}<span class="bot-row-copy"><strong>${esc(item.name)}</strong><p>${esc(item.role || '尚未填写职责')}</p></span><span class="presence ${item.status === 'paused' ? 'disabled' : ''}" title="${item.status === 'paused' ? '已暂停' : '活跃'}"></span></button>`).join('')}</div><section class="profile-detail">${bot ? `<div class="profile-top">${avatar(bot.id, true)}<div><h2>${esc(bot.name)}</h2><p>${esc(bot.role || '平级成员')} · ${bot.status === 'paused' ? '已暂停' : '活跃'}</p></div></div><div class="profile-actions"><button class="primary-button" data-action="dm-bot" data-id="${esc(bot.id)}">${icon('chat', 14)}开始私聊</button><button class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">${icon('edit', 13)}编辑 Profile</button><button class="icon-button" data-action="toggle-bot" data-id="${esc(bot.id)}" title="${bot.status === 'paused' ? '恢复成员' : '暂停成员'}" aria-label="${bot.status === 'paused' ? '恢复成员' : '暂停成员'}">${icon(bot.status === 'paused' ? 'play' : 'pause', 15)}</button></div><div class="profile-block"><h3>专业领域</h3><div class="tag-list">${expertise.map(text => `<span class="tag">${esc(text)}</span>`).join('') || '<span class="subtle">尚未填写</span>'}</div></div><div class="profile-block"><h3>身份与工作方式</h3><p>${esc(bot.prompt || '尚未填写个性与工作方式。')}</p><div class="item-meta">社交模型：deepseek-flash · 专业执行：${esc(bot.executor || 'codex')}</div>${bot.skills?.length ? `<div class="tag-list" style="margin-top:12px">${bot.skills.map(skill => `<span class="tag">${esc(skill)}</span>`).join('')}</div>` : ''}</div><div class="profile-block"><div class="memory-head"><h3>长期记忆<span class="count-pill">${ui.memories.length}</span></h3><button class="text-button" data-action="new-memory">＋ 添加记忆</button></div>${ui.memories.map(memory => `<article class="memory-item"><p>${esc(memory.content)}</p><div class="item-meta"><span>${esc(labels[memory.category] || memory.category)}</span><span>${memory.status === 'expired' ? '已过期' : '有效'}</span>${memory.source ? `<span>来源：${esc(memory.source)}</span>` : ''}${memory.version ? `<span>版本：${esc(memory.version)}</span>` : ''}<button class="text-button" data-action="edit-memory" data-id="${esc(memory.id)}">修订</button></div></article>`).join('') || '<p class="subtle" style="font-size:12px">还没有长期记忆。新的经验会逐步留在这里。</p>'}</div>` : emptyState('认识你的第一位成员', '为成员设定明确的职责、专长和工作方式。', '', 'people')}</section></div></div>`;
}

function eventText(event) {
  const data = event.data ?? event.payload;
  if (typeof data === 'string') return data;
  if (!data) return event.content || event.message || '';
  if (data.work) return [data.work.progress, data.work.waiting?.event ? `等待：${data.work.waiting.event}` : '', data.work.lastError?.message].filter(Boolean).join('\n') || labels[data.work.status] || data.work.status || data.work.goal || '';
  if (event.type === 'engine.request') return '正在处理当前工作上下文。';
  if (data.item) {
    const item = data.item;
    return [item.text, item.command, item.aggregatedOutput, item.exitCode != null ? `退出码：${item.exitCode}` : ''].filter(Boolean).join('\n') || ({ reasoning: '执行端正在分析目标与上下文。', fileChange: '工作目录文件发生变更。', dynamicToolCall: '执行端正在调用协作工具。' }[item.type] || item.type || '执行状态已更新');
  }
  for (const field of ['text', 'delta', 'message', 'content', 'summary', 'question', 'answer', 'error']) if (typeof data[field] === 'string') return data[field];
  if (event.type === 'thread_started') return `工作会话已建立${data.model ? ` · ${data.model}` : ''}`;
  if (event.type === 'thread_resumed') return '继续已有工作会话。';
  if (event.type === 'turn_completed') return data.error?.message || `本次执行${data.status === 'completed' ? '已完成' : data.status === 'interrupted' ? '已中断' : '已结束'}。`;
  if (event.type === 'queued') return data.goal || '等待执行端接手。';
  return JSON.stringify(data, null, 2);
}
function visibleWorkEvents(events = []) {
  const grouped = [];
  for (const event of events) {
    const last = grouped.at(-1);
    if (['message_delta', 'command_output'].includes(event.type) && last?.type === event.type && last.data?.itemId === event.data?.itemId) last.data.text = (last.data.text || '') + (event.data?.text || '');
    else grouped.push({ ...event, data: typeof event.data === 'object' && event.data ? { ...event.data } : event.data });
  }
  return grouped;
}
function renderWorks() {
  const filters = [{ id: 'all', name: '全部' }, { id: 'active', name: '进行中' }, { id: 'waiting', name: '待答复' }, { id: 'completed', name: '已完成' }, { id: 'attention', name: '待处理' }];
  const works = state.works.filter(work => ui.workFilter === 'all' || (ui.workFilter === 'active' ? ['active', 'queued', 'running'].includes(work.status) : ui.workFilter === 'attention' ? ['blocked', 'paused', 'failed', 'interrupted', 'cancelled'].includes(work.status) : work.status === ui.workFilter));
  const work = ui.workDetail?.id === ui.workId ? ui.workDetail : state.works.find(item => item.id === ui.workId);
  const eventLabels = { 'work.created': '工作已建立', 'work.updated': '工作进度已更新', 'engine.request': '继续处理', 'work.notification': '结果已通知', thread_started: '工作会话已建立', thread_resumed: '工作会话已恢复', message_delta: '执行端消息', command_output: '命令输出', item_started: '开始处理', item_completed: '处理完成', consult_requested: '中途咨询', consult_answer: '咨询答复', consult_failed: '咨询未完成', interrupt_acknowledged: '执行端已停止', interrupt_error: '停止请求异常', resume_queued: '等待恢复', steered: '补充要求已传递', turn_completed: '本轮执行结束', connection_lost: '执行端连接中断', result_delivery_error: '结果回传异常', created: '工作已建立', queued: '进入队列', started: '开始执行', running: '执行中', status: '状态变化', progress: '执行进度', output: '执行输出', message: '执行消息', consultation: '中途咨询', consult: '中途咨询', question: '等待答复', answer: '咨询答复', completed: '工作完成', failed: '执行失败', error: '执行异常', cancelled: '已取消', resumed: '恢复工作', interrupted: '工作中断', command: '执行命令', reasoning: '正在思考', result: '执行结果' };
  return `<div class="page">${pageHeader('Clear goals. Real progress.', '交出去的事，有迹可循。', '专业执行独立推进，过程、咨询和结果都留在这里。', `<button class="primary-button" data-action="new-work">${icon('plus', 15)}委托工作</button>`)}<div class="filter-bar">${filters.map(filter => `<button class="filter-tab ${ui.workFilter === filter.id ? 'active' : ''}" data-action="work-filter" data-id="${filter.id}">${filter.name}</button>`).join('')}</div><div class="works-layout"><div class="works-list">${works.map(item => `<button class="work-row ${item.id === ui.workId ? 'selected' : ''}" data-action="select-work" data-id="${esc(item.id)}"><div class="work-row-top">${statusPill(item.status)}<time>${formatTime(item.createdAt, true)}</time></div><h3>${esc(item.goal)}</h3><div class="item-meta"><span>${esc(nameOf(item.botId))}</span><span>·</span><span>${esc(roomById(item.roomId)?.name || '独立工作')}</span></div></button>`).join('') || emptyState('这里暂时没有工作', '把目标交给合适的成员，执行端会独立推进。', '', 'work')}</div><section class="work-detail">${work ? `<div class="work-detail-header"><div><div class="eyebrow">WORK / ${esc(work.id.slice(-8))}</div><div class="item-meta">${statusPill(work.status)}</div></div><div class="page-tools">${!work.historical && ['active', 'queued', 'running', 'waiting'].includes(work.status) ? `<button class="secondary-button" data-action="pause-work" data-id="${esc(work.id)}">暂停工作</button><button class="danger-button" data-action="cancel-work" data-id="${esc(work.id)}">取消工作</button>` : ''}${!work.historical && ['blocked', 'paused', 'failed', 'interrupted', 'cancelled'].includes(work.status) ? `<button class="primary-button" data-action="resume-work" data-id="${esc(work.id)}">${icon('play', 12)}恢复工作</button>` : ''}</div></div><h2>${esc(work.goal)}</h2>${work.waiting ? `<div class="work-constraints">等待：${esc(work.waiting.event || work.waiting.reason || work.waiting.taskId || work.waiting.until || '外部变化')}</div>` : ''}${work.bindings?.length ? `<div class="item-meta">${work.bindings.map(binding => esc(`${binding.type}: ${binding.externalThreadId || '结果待查询'} · ${binding.status || 'unknown'}`)).join('<br>')}</div>` : ''}<dl class="work-facts"><dt>委托成员</dt><dd>${esc(nameOf(work.botId))}</dd><dt>来源会话</dt><dd>${esc(roomById(work.roomId)?.name || '独立工作')}</dd><dt>工作要求</dt><dd>${esc(work.requirements || work.cwd || '见来源委托')}</dd>${work.model ? `<dt>执行模型</dt><dd>${esc(work.model)}</dd>` : ''}<dt>创建时间</dt><dd>${formatTime(work.createdAt, true)}</dd></dl>${work.constraints ? `<div class="work-description"><div class="item-meta" style="margin:0 0 8px">约束与注意事项</div>${esc(listText(work.constraints))}</div>` : ''}${work.inputRefs?.length ? `<div class="work-description"><div class="item-meta" style="margin:0 0 8px">输入资料</div>${esc(listText(work.inputRefs))}</div>` : ''}${work.error ? `<div class="error-state">${esc(work.error)}</div>` : ''}${work.status === 'interrupted' ? '<div class="context-note">上次执行已中断。恢复会继续已有工作对话；已进行的操作不会被视为从未发生。</div>' : ''}${!work.historical ? `<form id="work-message-form" class="consultation" data-id="${esc(work.id)}"><h3>补充工作要求</h3>${['paused', 'cancelled'].includes(work.status) ? '<p>补充会先保存，恢复工作后处理。</p>' : ''}<textarea id="work-message" name="message" aria-label="补充工作要求" placeholder="补充信息、纠正要求或继续这项工作…" required></textarea><button class="primary-button" type="submit" ${ui.workSubmissions?.[work.id]?.sending ? 'disabled' : ''}>发送补充</button></form>` : ''}${work.summary ? `<div class="work-description"><div class="eyebrow" style="margin-bottom:10px">执行结果</div>${richText(work.summary)}</div>` : ''}<div class="log-title"><strong>进度记录</strong><span class="subtle">${(work.events || []).length} 条</span></div><div class="timeline">${visibleWorkEvents(work.events).map(event => `<article class="timeline-item ${['error', 'failed'].includes(event.type) ? 'error' : ''}"><div class="timeline-meta"><strong>${esc(eventLabels[event.type] || event.type)}</strong><time>${formatTime(event.createdAt || event.timestamp)}</time></div><div class="timeline-body">${esc(eventText(event))}</div></article>`).join('') || '<p class="subtle" style="font-size:12px">暂无详细进度。</p>'}</div>` : emptyState('选择一项工作', '选择一项工作查看进度，或发起你的第一份委托。', '', 'work')}</section></div></div>`;
}

function renderKnowledge() {
  const nodes = ui.query && ui.knowledgeResults ? ui.knowledgeResults.nodes || [] : state.knowledge.nodes || [];
  const selected = state.knowledge.nodes?.find(node => node.id === ui.nodeId);
  const graph = ui.graph || state.knowledge;
  const edges = (graph.edges || []).filter(edge => edge.from === ui.nodeId || edge.to === ui.nodeId);
  const nodeTitle = id => graph.nodes?.find(node => node.id === id)?.title || state.knowledge.nodes?.find(node => node.id === id)?.title || id;
  return `<div class="page">${pageHeader('A shared understanding', '把共识留下，让经验相连。', '事实、假设和待核查事项分别记录，保留来源与修订。', `<button class="secondary-button" data-action="new-edge">${icon('link', 14)}建立关联</button><button class="primary-button" data-action="new-node">${icon('plus', 15)}新增知识</button>`)}<form id="knowledge-search-form" class="knowledge-toolbar"><input id="knowledge-query" class="search-input" placeholder="搜索知识内容、标题与成员记忆…" value="${esc(ui.query)}" aria-label="搜索知识"><button class="secondary-button" type="submit">${icon('search', 14)}搜索</button>${ui.query ? '<button class="text-button" type="button" data-action="clear-search">清除筛选</button>' : ''}</form><div class="knowledge-layout"><div class="knowledge-list">${nodes.map(node => `<button class="knowledge-node ${node.id === ui.nodeId ? 'selected' : ''}" data-action="select-node" data-id="${esc(node.id)}"><div class="knowledge-meta"><span>${esc(labels[node.type] || node.type || '知识')}</span><span>${node.status === 'active' ? '有效' : esc(labels[node.status] || node.status)}</span></div><h3>${esc(node.title)}</h3><p>${esc(node.content)}</p><div class="item-meta">${node.source ? `<span>来源：${esc(node.source)}</span>` : '<span>尚未注明来源</span>'}${node.version ? `<span>· ${esc(node.version)}</span>` : ''}</div></button>`).join('') || emptyState(ui.query ? '没有找到匹配的知识' : '还没有知识记录', ui.query ? '试试其他关键词，或查看下方匹配的成员记忆。' : '保存有用的事实、讨论结论与专业经验，下一次合作可以从这里继续。', '', 'knowledge')}${ui.query && ui.knowledgeResults?.memories?.length ? `<div class="section-label">相关成员记忆</div>${ui.knowledgeResults.memories.map(memory => `<article class="knowledge-node"><div class="knowledge-meta">${esc(nameOf(memory.botId))} · ${esc(labels[memory.category] || '记忆')}</div><p style="margin-top:10px">${esc(memory.content)}</p></article>`).join('')}` : ''}</div><section class="knowledge-detail">${selected ? `<div class="knowledge-meta"><span>${esc(labels[selected.type] || '知识')} · ${selected.status === 'active' ? '有效' : esc(labels[selected.status] || selected.status)}</span><button class="text-button" data-action="edit-node" data-id="${esc(selected.id)}">${icon('edit', 12)} 修订</button></div><h2>${esc(selected.title)}</h2><div class="knowledge-content">${richText(selected.content)}</div><div class="item-meta">${selected.source ? `来源：${esc(selected.source)}` : '尚未注明来源'}${selected.version ? `<br>适用版本：${esc(selected.version)}` : ''}</div><div class="context-section" style="margin-top:25px"><div class="memory-head"><h4>关联知识</h4><button class="text-button" data-action="new-edge">＋ 关联</button></div>${edges.map(edge => `<div class="relationship"><button class="relation-node" data-action="select-node" data-id="${esc(edge.from)}">${esc(nodeTitle(edge.from))}</button><button class="relation-label" data-action="edit-edge" data-id="${esc(edge.id)}" title="修订关系">${esc(edge.relation)}</button><button class="relation-node" data-action="select-node" data-id="${esc(edge.to)}">${esc(nodeTitle(edge.to))}</button></div>`).join('') || '<p>这条知识尚未建立关联。</p>'}</div>${selected.history?.length ? `<details class="context-section"><summary style="font-size:11px;cursor:pointer">修订历史 · ${selected.history.length} 次</summary>${selected.history.map(entry => `<div class="memory-item"><div class="item-meta">${formatTime(entry.updatedAt || entry.createdAt || entry.at, true)}</div><p>${esc(entry.content || entry.snapshot?.content || JSON.stringify(entry))}</p></div>`).join('')}</details>` : ''}` : emptyState('选择一条知识', '选择一条知识，查看内容、来源、历史与关联。', '', 'link')}</section></div></div>`;
}

function renderRoutines() {
  const enabled = state.routines.filter(routine => routine.enabled).length;
  function interval(seconds) { return seconds % 3600 === 0 ? `每 ${seconds / 3600} 小时` : seconds % 60 === 0 ? `每 ${seconds / 60} 分钟` : `每 ${seconds} 秒`; }
  return `<div class="page">${pageHeader('Make room for the recurring', '该惦记的事，按时想起。', '为成员安排持续职责，也可以随时投递一次新的事件。', `<button class="secondary-button" data-action="new-event">${icon('event', 14)}投递事件</button><button class="primary-button" data-action="new-routine">${icon('plus', 15)}新增职责</button>`)}<div class="routine-summary">${icon('clock', 27)}<div><strong>${enabled} 项职责正在运行</strong><p>到期后投递给指定成员；服务重启后继续保留安排。</p></div></div>${state.routines.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>职责</th><th>负责成员</th><th>执行频率</th><th>下一次</th><th>状态</th><th></th></tr></thead><tbody>${state.routines.map(routine => `<tr><td><strong>${esc(routine.name || '定时职责')}</strong><p>${esc(routine.instruction)}</p>${routine.lastStatus ? `<div class="item-meta">最近：${esc(labels[routine.lastStatus] || routine.lastStatus)}</div>` : ''}</td><td><span class="routine-owner">${avatar(routine.botId)}${esc(nameOf(routine.botId))}</span><p>${esc(roomById(routine.roomId)?.name || '未指定会话')}</p></td><td style="white-space:nowrap">${interval(Number(routine.intervalSeconds) || 60)}</td><td style="white-space:nowrap">${routine.enabled ? formatTime(routine.nextRunAt, true) : '已暂停'}${routine.lastRunAt ? `<p>上次 ${formatTime(routine.lastRunAt, true)}</p>` : ''}</td><td><button class="toggle ${routine.enabled ? 'on' : ''}" data-action="toggle-routine" data-id="${esc(routine.id)}" role="switch" aria-checked="${!!routine.enabled}" aria-label="${routine.enabled ? '暂停' : '开启'}${esc(routine.name)}"></button></td><td><button class="icon-button" data-action="edit-routine" data-id="${esc(routine.id)}" aria-label="编辑职责" title="编辑职责">${icon('edit', 14)}</button></td></tr>`).join('')}</tbody></table></div>` : emptyState('还没有定时职责', '例如每天整理项目待办，或定期回顾最近讨论。你可以随时暂停和修改。', '<button class="secondary-button" data-action="new-routine">创建第一项职责</button>', 'clock')}</div>`;
}

const catalogKindLabel = kind => ({mcp:'MCP',http:'HTTP API',skill:'Skill',service:'内置服务'})[kind] || kind;
const catalogPath = id => `/api/catalog/${encodeURIComponent(id)}`;
function catalogAvailability(entry) {
  if (entry.enabled === false) return '已停用';
  if (entry.status === 'ready' && entry.lastProbe?.scope === 'configuration') return '配置就绪（未调用）';
  return ({ready:'可用',available:'可用',unavailable:'不可用',blocked:'依赖不可用',unknown:'待探测',unprobed:'待探测',error:'连接失败',disabled:'已停用'})[entry.status] || entry.status || (entry.kind==='skill'?'可用':'待探测');
}
function renderCatalog() {
  const detail=ui.catalogDetail?.entry || ui.catalogDetail;
  const tools=detail?.tools || detail?.config?.tools || [];
  const readOnly=detail?.readOnly || detail?.kind==='service';
  const header=pageHeader('', '能力目录', '', `<button class="secondary-button" data-action="catalog-new" data-kind="mcp">＋ MCP</button><button class="secondary-button" data-action="catalog-new" data-kind="http">＋ HTTP API</button><button class="primary-button" data-action="catalog-new" data-kind="skill">＋ Skill</button>`);
  return `<div class="page catalog-page">${header}<p class="subtle">每个 MCP、HTTP API 和共享 Skill 都有独立的维护 Bot，保存时自动创建并绑定。</p><form id="catalog-search-form" class="catalog-search"><input id="catalog-query" aria-label="搜索能力目录" placeholder="搜索名称、用途或资源引用" value="${esc(ui.catalogQuery)}"><select id="catalog-kind" aria-label="能力类型">${[['','全部类型'],['mcp','MCP'],['http','HTTP API'],['skill','Skill'],['service','内置服务']].map(([value,label])=>`<option value="${value}" ${ui.catalogKind===value?'selected':''}>${label}</option>`).join('')}</select><button class="secondary-button" type="submit">搜索</button></form><div class="catalog-layout"><div class="catalog-list">${ui.catalog.map(entry=>`<button class="catalog-row ${entry.id===ui.catalogId?'selected':''}" data-action="catalog-open" data-id="${esc(entry.id)}"><span class="item-meta">${esc(catalogKindLabel(entry.kind))} · ${esc(catalogAvailability(entry))}</span><strong>${esc(entry.name || entry.id)}</strong><p>${esc(entry.description || '')}</p><span class="subtle">${entry.ownerBotId?`负责：${esc(nameOf(entry.ownerBotId))}`:'平台服务'}</span></button>`).join('') || '<p class="panel-empty">没有匹配的能力。可以添加 MCP、HTTP API 或 Skill。</p>'}</div><section class="catalog-detail">${detail?`<div class="profile-block"><div class="item-meta">${esc(catalogKindLabel(detail.kind))} · ${esc(catalogAvailability(detail))} · 修订 ${detail.revision||0}</div><h2>${esc(detail.name || detail.id)}</h2><p>${esc(detail.description)}</p>${detail.lastError?`<p class="error-text">${esc(detail.lastError)}</p>`:''}${detail.unavailableReason||detail.reason?`<p class="subtle">${esc(detail.unavailableReason||detail.reason)}</p>`:''}<div class="profile-actions">${readOnly?'':`<button class="primary-button" data-action="catalog-edit" data-id="${esc(detail.id)}">编辑</button>${detail.kind!=='skill'?`<button class="secondary-button" data-action="catalog-probe" data-id="${esc(detail.id)}">探测连接</button>`:''}<button class="secondary-button" data-action="catalog-toggle" data-id="${esc(detail.id)}">${detail.enabled===false?'启用':'停用'}</button><button class="text-button" data-action="catalog-remove" data-id="${esc(detail.id)}">移除</button>`}</div></div><div class="profile-block"><h3>责任与范围</h3><p>专属维护 Bot：${detail.ownerBotId?esc(nameOf(detail.ownerBotId)):'平台服务'}</p><p>允许使用：${(detail.allowedBotIds||[]).map(id=>id==='*'?'全部 Bot':esc(nameOf(id))).join('、')||'负责成员'}</p><p>适用引用：${esc((detail.scopeRefs||[]).join('、')||'未限定')}</p><p>依赖：${(detail.dependencies||[]).map(id=>esc(ui.catalog.find(e=>e.id===id)?.name||id)).join('、')||'无'}</p><small class="subtle">目录 ID：${esc(detail.id)}</small></div>${detail.kind==='skill'?`<div class="profile-block"><h3>当前方法</h3><div class="message-content">${richText(detail.content || '')}</div></div><div class="profile-block"><h3>附属资源</h3>${Object.entries(detail.files||{}).map(([path,content])=>`<details><summary>${esc(path)}</summary><pre class="catalog-code">${esc(content)}</pre></details>`).join('')||'<p class="subtle">无附属文件</p>'}</div>`:`<div class="profile-block"><h3>工具</h3>${tools.map(tool=>`<details><summary>${esc(tool.name)} · ${esc(tool.effect||'external')}</summary><p>${esc(tool.description)}</p><pre class="catalog-code">${esc(JSON.stringify(tool.inputSchema||{},null,2))}</pre></details>`).join('')||'<p class="subtle">探测连接后显示当前工具。</p>'}</div><div class="profile-block"><h3>执行配置</h3><pre class="catalog-code">${esc(JSON.stringify(detail.config||{},null,2))}</pre></div>`}`:'<div class="panel-empty">选择一项查看用途、负责人、工具与方法。</div>'}</section></div></div>`;
}
function catalogBotChoices(selected=[], ownerId) {
  return `<div class="form-field"><label>允许使用的 Bot</label><label class="catalog-choice"><input type="checkbox" name="allowedBotIds" value="*" ${selected.includes('*')?'checked':''}> 全部 Bot</label>${state.bots.filter(bot=>!bot.archivedAt&&bot.id!==ownerId).map(bot=>`<label class="catalog-choice"><input type="checkbox" name="allowedBotIds" value="${esc(bot.id)}" ${selected.includes(bot.id)?'checked':''}> ${esc(bot.name)}</label>`).join('')}<small>专属维护 Bot 始终可用；这里选择其他使用者。未选时仅维护 Bot 可用。</small></div>`;
}
function catalogEditor(entry, kind=entry?.kind||'mcp') {
  const dependencies=[...ui.catalog];for(const id of entry?.dependencies||[])if(!dependencies.some(item=>item.id===id))dependencies.push({id,name:id});
  const sample=kind==='mcp'?{transport:'http',url:'http://127.0.0.1:9000/mcp',headersEnv:{Authorization:'SERVICE_AUTH'}}:{tools:[{name:'get_item',description:'读取指定对象',url:'http://127.0.0.1:9000/items/{id}',method:'GET',effect:'read',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id']}}]};
  const editing=Boolean(entry);
  const common=`${editing?'':field('目录 ID','id','',{required:true,placeholder:'例如：inventory-api'})}${field('名称','name',entry?.name||'',{required:true,placeholder:kind==='skill'?'小写英文，用短横线分词':'连接名称'})}${field('用途与适用条件','description',entry?.description||'',{type:'textarea',required:true})}${editing?`<div class="context-note">专属维护 Bot：${esc(nameOf(entry.ownerBotId))}。负责人由系统固定绑定。</div>`:'<div class="context-note">保存时自动创建一个专属维护 Bot，无需预先创建或选择成员。收到咨询或维护提案时按需启动。</div>'}${catalogBotChoices(entry?.allowedBotIds||[],entry?.ownerBotId)}${field('适用资源引用','scopeRefs',(entry?.scopeRefs||[]).join('\n'),{type:'textarea',rows:2,help:'每行一个实际连接、账号或对象的稳定引用；不填凭据。'})}<div class="form-field"><label for="field-dependencies">依赖能力</label><select id="field-dependencies" name="dependencies" multiple>${dependencies.filter(item=>item.id!==entry?.id&&item.kind!=='service').map(item=>`<option value="${esc(item.id)}" ${(entry?.dependencies||[]).includes(item.id)?'selected':''}>${esc(item.name||item.id)}</option>`).join('')}</select><small>依赖停用或不可用时，相关 Skill 会同步显示不可用。</small></div>`;
  const body=kind==='skill'?`${!editing?'<div class="form-field"><label for="catalog-package">导入 Skill 文件夹（可选）</label><input id="catalog-package" type="file" multiple webkitdirectory><small>读取 SKILL.md 及 scripts、references、assets 中的文本文件。</small></div>':''}${field('Skill 正文','content',entry?.content||'',{type:'textarea',rows:10,required:true})}${field('附属文件（JSON）','files',JSON.stringify(entry?.files||{},null,2),{type:'textarea',rows:5,help:'相对路径映射到文本内容，例如 {"references/guide.md":"使用说明"}。'})}`:`${field('执行配置（JSON）','config',JSON.stringify(entry?.config||sample,null,2),{type:'textarea',rows:12,required:true,help:'HTTP 支持 method、路径参数、query 与 body 映射。凭据使用 headersEnv 或 env 引用已有环境变量。'})}`;
  openModal(editing?'编辑能力':`添加 ${catalogKindLabel(kind)}`,'保存用途、责任关系和当前有效配置。',common+body,async data=>{
    const payload={kind,name:String(data.get('name')).trim(),description:String(data.get('description')).trim(),allowedBotIds:data.getAll('allowedBotIds'),dependencies:data.getAll('dependencies'),scopeRefs:String(data.get('scopeRefs')).split('\n').map(s=>s.trim()).filter(Boolean)};
    if(editing)payload.expectedRevision=entry.revision;else payload.id=String(data.get('id')).trim();
    if(kind==='skill'){payload.content=String(data.get('content'));payload.files=JSON.parse(String(data.get('files')||'{}'));}else payload.config=JSON.parse(String(data.get('config')));
    const saved=await api(editing?catalogPath(entry.id):'/api/catalog',editing?'PATCH':'POST',payload);
    ui.catalogId=saved.id||saved.entry?.id||entry?.id||payload.id;toast(editing?'能力已保存':'能力和专属维护 Bot 已创建');
  });
  const picker=$('#catalog-package');
  if(picker)picker.onchange=async()=>{try{
    const files={};let total=0;
    for(const file of picker.files){total+=file.size;if(total>512*1024)throw new Error('Skill 文本包不能超过 512 KiB');const parts=(file.webkitRelativePath||file.name).split('/');const path=parts.length>1?parts.slice(1).join('/'):parts[0];if(path!=='SKILL.md'&&!/^(scripts|references|assets)\//.test(path))continue;const content=await file.text();if(content.includes('\0'))throw new Error('请导入文本资源');files[path]=content;}
    const source=files['SKILL.md'];if(!source)throw new Error('文件夹根目录需要 SKILL.md');delete files['SKILL.md'];
    const header=source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);let content=source;
    if(header){content=source.slice(header[0].length);for(const key of ['name','description']){const match=header[1].match(new RegExp(`^${key}:\\s*(.+)$`,'m'));if(match){let value=match[1].trim();try{value=JSON.parse(value);}catch{value=value.replace(/^['"]|['"]$/g,'');}$(`#field-${key}`).value=value;}}}
    $('#field-content').value=content.trim();$('#field-files').value=JSON.stringify(files,null,2);if(!$('#field-id').value)$('#field-id').value=$('#field-name').value;
  }catch(error){$('#modal-form .form-error').textContent=error.message;}};
}
async function catalogAction(action,element) {
  const id=element.dataset.id;
  if(action==='catalog-new')return catalogEditor(null,element.dataset.kind);
  if(action==='catalog-open'){ui.catalogId=id;await loadCurrent();return render();}
  const response=await api(catalogPath(id)),entry=response.entry||response;
  if(action==='catalog-edit')return catalogEditor(entry);
  if(action==='catalog-probe'){await api(`${catalogPath(id)}/probe`,'POST',{});toast('连接探测已完成');}
  if(action==='catalog-toggle')await api(catalogPath(id),'PATCH',{enabled:entry.enabled===false,expectedRevision:entry.revision});
  if(action==='catalog-remove')return openModal('移除能力',`移除“${entry.name||entry.id}”及其目录关系，并停止、归档专属维护 Bot。聊天和工作历史继续保留。`,'<p>依赖它的方法会显示依赖缺失。</p>',async()=>{await api(catalogPath(id),'DELETE',{});ui.catalogId=null;ui.catalogDetail=null;toast('能力已移除');},'移除');
  await loadCurrent();render();
}
document.addEventListener('submit',event=>{if(event.target.id!=='catalog-search-form')return;event.preventDefault();ui.catalogQuery=$('#catalog-query').value.trim();ui.catalogKind=$('#catalog-kind').value;void loadCurrent().then(render).catch(error=>toast(error.message,true));});

function field(label, name, value = '', options = {}) {
  const { type = 'text', placeholder = '', help = '', required = false, rows, min } = options;
  const control = type === 'textarea' ? `<textarea id="field-${name}" name="${name}" ${required ? 'required' : ''} ${rows ? `rows="${rows}"` : ''} placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${min != null ? `min="${min}"` : ''} placeholder="${esc(placeholder)}">`;
  return `<div class="form-field"><label for="field-${name}">${label}</label>${control}${help ? `<small>${esc(help)}</small>` : ''}</div>`;
}
function selectField(label, name, options, value, help = '') { return `<div class="form-field"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}">${options.map(option => `<option value="${esc(option.value)}" ${option.value === value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>${help ? `<small>${esc(help)}</small>` : ''}</div>`; }
function botOptions() { return state.bots.map(bot => ({ value: bot.id, label: bot.name })); }
function roomOptions() { return state.rooms.filter(room => room.status !== 'concluded').map(room => ({ value: room.id, label: room.name })); }
function memberChoices(selected = []) { return `<div class="form-field"><label>参与成员</label>${state.bots.map(bot => `<label class="member-choice">${avatar(bot.id)}<span>${esc(bot.name)}<small>${esc(bot.role)}</small></span><input type="checkbox" name="members" value="${esc(bot.id)}" ${selected.includes(bot.id) ? 'checked' : ''}></label>`).join('')}<small>勾选需要参与会话的 Bot。</small></div>`; }
function openModal(title, description, content, save, submitLabel = '保存') {
  const modal = $('#modal');
  captureMotion($('#modal-content'));
  modal.classList.remove('create-bot-modal'); ui.menu = null; renderTopbar();
  $('#modal-content').innerHTML = `<div class="modal-header"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 17)}</button></div><form id="modal-form" class="modal-form">${content}<div class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">${esc(submitLabel)}</button></div></form>`;
  $('#modal-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target; const button = $('button[type=submit]', form); const error = $('.form-error', form); error.textContent = ''; button.disabled = true;
    try { await save(new FormData(form), form); if (modal.open && $('#modal-form') === form) await closeModal(modal); await refresh(); } catch (cause) { if (form.isConnected) error.textContent = cause.message; else toast(cause.message, true); } finally { button.disabled = false; }
  };
  showModal(modal);
}
function openRoomForm(kind = 'group') {
  const current = roomById(ui.roomId);
  openModal('新建会话', '选好成员和交流方式，留出适合这个话题的空间。', `${selectField('会话方式', 'kind', [{ value: 'group', label: '群聊 · 日常交流' }, { value: 'dm', label: '私聊 · 一对一沟通' }, { value: 'deep', label: '深聊 · 围绕目标深入讨论' }], kind)}${field('会话名称', 'name', '', { required: true, placeholder: kind === 'deep' ? '例如：下一版交互方案' : '给这段对话一个名字' })}${memberChoices(kind === 'deep' ? (current?.members || []).filter(id => id !== 'user') : state.bots.filter(bot => bot.status !== 'paused').map(bot => bot.id))}${field('讨论目标', 'goal', '', { type: 'textarea', placeholder: '这段对话需要解决什么？', help: '深聊需要明确目标，结束后将沉淀结论并回到来源会话。' })}${selectField('来源会话', 'originRoomId', [{ value: '', label: '无来源 · 独立会话' }, ...roomOptions()], kind === 'deep' ? ui.roomId : '')}`, async data => {
    const members = data.getAll('members'); const roomKind = data.get('kind');
    if (!members.length) throw new Error('请至少选择一位成员。');
    if (roomKind === 'dm' && members.length > 2) throw new Error('私聊最多选择两位成员；多人讨论请选择群聊。');
    if (roomKind === 'deep' && !data.get('goal').trim()) throw new Error('请填写深聊目标。');
    const room = await api('/api/rooms', 'POST', { name: data.get('name').trim(), kind: roomKind, members: roomKind === 'dm' && members.length === 2 ? members : ['user', ...members], goal: data.get('goal').trim(), originRoomId: data.get('originRoomId') || null });
    ui.roomChosenByUser = true; ui.navigationSeq++; ui.roomId = room.id || room.room?.id; ui.view = 'chat'; location.hash = 'chat'; ui.mobileRoom = true; ui.reply = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; toast('会话已创建');
  }, '创建会话');
}
function openBotForm(id) {
  const bot = botById(id);
  openModal(bot ? '编辑成员 Profile' : '认识一位新成员', '明确专业责任与工作方式，让成员拥有持续的身份。', `${field('成员名称', 'name', bot?.name || '', { required: true, placeholder: '例如：架构师' })}${field('主要职责', 'role', bot?.role || '', { required: true, placeholder: '这个成员长期负责什么？' })}${field('专业领域', 'expertise', listText(bot?.expertise), { placeholder: '用逗号分隔，例如：系统设计、代码审查' })}${field('能力描述（不安装 Skill）', 'skills', (bot?.skills || []).join('\n'), { type: 'textarea', placeholder: '每行一项，例如：代码阅读与定位、回归测试设计', help: '作为成员协作时的能力说明，不自动安装外部技能。' })}${field('身份与工作方式', 'prompt', bot?.prompt || '', { type: 'textarea', rows: 5, placeholder: '专业背景、协作偏好、遇到问题时如何处理…' })}<div class="context-note">社交模型统一为 DeepSeek Flash。专业执行交给独立执行端。</div>`, async data => {
    const payload = { name: data.get('name').trim(), role: data.get('role').trim(), expertise: data.get('expertise').trim(), skills: data.get('skills').split('\n').map(text => text.trim()).filter(Boolean), prompt: data.get('prompt').trim() };
    const result = await api(bot ? `/api/bots/${encodeURIComponent(bot.id)}` : '/api/bots', bot ? 'PATCH' : 'POST', payload);
    ui.botId = result.id || bot?.id; toast(bot ? 'Profile 已更新' : '新成员已加入');
  });
}
function openMemoryForm(id) {
  const memory = ui.memories.find(item => item.id === id);
  openModal(memory ? '修订长期记忆' : '添加长期记忆', `记录在 ${nameOf(ui.botId)} 的个人记忆中。`, `${field('记忆内容', 'content', memory?.content || '', { type: 'textarea', required: true, rows: 4 })}<div class="form-row">${selectField('记忆类别', 'category', [{ value: 'professional', label: '专业记忆' }, { value: 'private', label: '私人记忆' }], memory?.category || 'professional')}${selectField('状态', 'status', [{ value: 'active', label: '有效' }, { value: 'expired', label: '已过期' }], memory?.status || 'active')}</div>${field('来源', 'source', memory?.source || '', { placeholder: '例如：项目讨论、用户补充' })}${field('适用版本', 'version', memory?.version || '', { placeholder: '选填' })}`, async data => {
    await api(memory ? `/api/memories/${encodeURIComponent(memory.id)}` : `/api/bots/${encodeURIComponent(ui.botId)}/memories`, memory ? 'PATCH' : 'POST', Object.fromEntries(data)); toast('记忆已保存');
  });
}
async function openBotContacts(id) {
  const {contacts=[]}=await api(`/api/bots/${encodeURIComponent(id)}/contacts`);
  const connected=new Set(contacts.map(contact=>contact.botId));
  const candidates=state.bots.filter(bot=>bot.id!==id&&!bot.archivedAt);
  openModal('Bot 直连联系人', `${nameOf(id)} 可直接与这些联系人交换消息，已有连接不依赖群聊转发。`,
    `<div class="context-note">已连接：${contacts.map(contact=>esc(nameOf(contact.botId))).join('、')||'暂无'}</div>${selectField('联系人','botId',candidates.map(bot=>({value:bot.id,label:`${bot.name}${connected.has(bot.id)?' · 已连接':''}`})),candidates[0]?.id)}${selectField('操作','enabled',[{value:'true',label:'建立双向直连'},{value:'false',label:'断开双向直连'}],'true')}`,
    async data=>{await api(`/api/bots/${encodeURIComponent(id)}/contacts`,'POST',{botId:data.get('botId'),enabled:data.get('enabled')==='true'});toast('直连联系人已更新');});
}
function openWorkForm() {
  openModal('委托一项工作', '明确目标与边界，成员持续推进，并按需要使用已有工具与 Codex。', `${field('工作目标', 'goal', '', { type: 'textarea', required: true, placeholder: '希望完成什么？请描述可以观察的结果。', rows: 4 })}<div class="form-row">${selectField('委托成员', 'botId', botOptions(), ui.view === 'members' ? ui.botId : profileBot()?.id || state.bots[0]?.id)}${selectField('结果回到', 'roomId', roomOptions(), ui.roomId)}</div>${field('工作目录', 'cwd', state.defaultCwd || '', { required: true, placeholder: '项目的绝对路径' })}${field('约束与注意事项', 'constraints', '', { type: 'textarea', placeholder: '已有修改、操作边界、需要保留的行为…' })}${field('输入资料', 'inputRefs', '', { type: 'textarea', placeholder: '每行一项：文件路径、资料说明或链接', help: '提供已有资料的位置，方便执行端理解上下文。' })}`, async data => {
    const work = await api('/api/works', 'POST', { ...Object.fromEntries(data), inputRefs: data.get('inputRefs').split('\n').map(text => text.trim()).filter(Boolean) }); ui.workId = work.id || work.work?.id; ui.view = 'works'; toast('工作已交给成员');
  }, '开始工作');
}
function openNodeForm(id, message) {
  const node = state.knowledge.nodes?.find(item => item.id === id);
  openModal(node ? '修订知识' : '留下一条知识', '明确哪些已知、哪些待核查，并保留信息来源。', `${field('标题', 'title', node?.title || (message ? message.content.slice(0, 35) : ''), { required: true })}${field('内容', 'content', node?.content || message?.content || '', { type: 'textarea', required: true, rows: 5 })}<div class="form-row">${selectField('性质', 'type', ['fact', 'hypothesis', 'opinion', 'unverified'].map(value => ({ value, label: labels[value] })), node?.type || 'unverified')}${selectField('状态', 'status', [{ value: 'active', label: '有效' }, { value: 'disputed', label: '有争议' }, { value: 'expired', label: '已过期' }], node?.status || 'active')}</div>${field('来源', 'source', node?.source || (message ? `会话 ${roomById(message.roomId)?.name || message.roomId} / 消息 ${message.id}` : ''), { placeholder: '文档、讨论或观察记录' })}${field('适用版本', 'version', node?.version || '', { placeholder: '选填，例如 v0.1' })}`, async data => {
    const result = await api(node ? `/api/knowledge/nodes/${encodeURIComponent(node.id)}` : '/api/knowledge/nodes', node ? 'PATCH' : 'POST', Object.fromEntries(data)); ui.nodeId = result.id || node?.id; toast('知识已保存');
  });
}
function openEdgeForm() {
  const nodes = state.knowledge.nodes || []; if (nodes.length < 2) { toast('至少需要两条知识才能建立关联。'); return; }
  const options = nodes.map(node => ({ value: node.id, label: node.title }));
  openModal('建立知识关联', '关系有方向，例如：方案依赖条件，结论来自观察。', `${selectField('起点', 'from', options, ui.nodeId || nodes[0].id)}${field('关系', 'relation', '', { required: true, placeholder: '例如：依赖、支持、来自、修订' })}${selectField('终点', 'to', options, nodes.find(node => node.id !== ui.nodeId)?.id)}${field('来源', 'source', '', { placeholder: '选填：关联的依据' })}`, async data => { if (data.get('from') === data.get('to')) throw new Error('请选择两条不同的知识。'); await api('/api/knowledge/edges', 'POST', Object.fromEntries(data)); toast('关联已建立'); });
}
function openEdgeEdit(id) {
  const edge = (state.knowledge.edges || []).find(item => item.id === id) || ui.graph?.edges?.find(item => item.id === id); if (!edge) return;
  openModal('修订知识关系', '', `${field('关系', 'relation', edge.relation, { required: true })}${field('来源', 'source', edge.source || '')}${selectField('状态', 'status', [{ value: 'active', label: '有效' }, { value: 'expired', label: '已过期' }], edge.status || 'active')}`, async data => { await api(`/api/knowledge/edges/${encodeURIComponent(id)}`, 'PATCH', Object.fromEntries(data)); toast('知识关系已更新'); });
}
function openRoutineForm(id) {
  const routine = state.routines.find(item => item.id === id);
  openModal(routine ? '修改定时职责' : '安排定时职责', '成员会按周期接收职责，在指定会话里回应。', `${field('职责名称', 'name', routine?.name || '', { required: true, placeholder: '例如：项目进度回顾' })}${field('具体职责', 'instruction', routine?.instruction || '', { type: 'textarea', required: true, placeholder: '到期时，成员需要关注或完成什么？' })}<div class="form-row">${selectField('负责成员', 'botId', botOptions(), routine?.botId || profileBot()?.id || state.bots[0]?.id)}${selectField('投递到会话', 'roomId', roomOptions(), routine?.roomId || ui.roomId)}</div>${field('间隔（分钟）', 'intervalMinutes', (routine?.intervalSeconds || 3600) / 60, { type: 'number', min: 1, required: true, help: '最短 1 分钟。重启后只补一次到期职责。' })}<label class="checkbox-line"><input type="checkbox" name="enabled" ${routine?.enabled !== false ? 'checked' : ''}>立即启用</label>`, async data => {
    await api(routine ? `/api/routines/${encodeURIComponent(routine.id)}` : '/api/routines', routine ? 'PATCH' : 'POST', { name: data.get('name'), instruction: data.get('instruction'), botId: data.get('botId'), roomId: data.get('roomId'), intervalSeconds: Number(data.get('intervalMinutes')) * 60, enabled: data.has('enabled') }); toast('职责已保存');
  });
}
function openEventForm() {
  openModal('投递一次事件', '把新的进展或待办交给合适的成员。', `${field('事件类型', 'type', '人工提醒', { required: true, placeholder: '例如：项目更新、人工提醒' })}${field('事件内容', 'content', '', { type: 'textarea', required: true, rows: 4 })}<div class="form-row">${selectField('接收成员', 'botId', botOptions(), state.bots[0]?.id)}${selectField('来源会话', 'roomId', roomOptions(), ui.roomId)}</div>`, async data => { await api('/api/events', 'POST', Object.fromEntries(data)); toast('事件已投递'); }, '投递事件');
}

async function act(action, element) {
  if (action.startsWith('catalog-')) return catalogAction(action, element);
  const id = element?.dataset.id;
  if (action === 'attach-file') return chooseAttachments();
  if (action === 'remove-attachment') return removeAttachment(id);
  if (action === 'retry-attachment') { const item = attachmentDrafts().find(item => item.key === id); if (item?.file && item.status === 'error') return uploadAttachment(ui.roomId, item); return; }
  if (action === 'toggle-agent-run') { if (ui.agentRunsOpen.has(id)) { ui.agentRunsOpen.delete(id); return render(); } ui.agentRunsOpen.add(id); const request = loadAgentRunDetails(id, true); render(); return request; }
  if (action === 'refresh-agent-run') { const request = loadAgentRunDetails(id, true); render(); return request; }
  if (action === 'toggle-agent-tool') { if (ui.agentToolsOpen.has(id)) ui.agentToolsOpen.delete(id); else ui.agentToolsOpen.add(id); return render(); }
  if (action === 'cancel-agent-run') {
    if (ui.agentRunsCancelling.has(id)) return;
    ui.agentRunsCancelling.add(id); render();
    try { await api(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, 'POST', {}); toast('取消请求已提交'); await refresh(); }
    finally { ui.agentRunsCancelling.delete(id); render(); }
    return;
  }
  if (action === 'toggle-search') { ui.searchOpen = !ui.searchOpen; if (!ui.searchOpen) ui.roomQuery = ''; render(); $('#room-search')?.focus(); return; }
  if (action === 'toggle-mention-menu') { ui.menu = ui.menu === 'mentions' ? null : 'mentions'; return render(); }
  if (action === 'choose-message-target') {
    if (id && !roomById(ui.roomId)?.members?.includes(id)) return;
    ui.draftTargets[ui.roomId] = id || '';
    const select = $('#message-target'); if (select) select.value = id || '';
    ui.menu = null; render(); $('#message-input')?.focus(); return;
  }
  if (['toggle-create', 'toggle-apps', 'toggle-chat-menu'].includes(action)) { const menu = action.slice(7); ui.menu = ui.menu === menu ? null : menu; return render(); }
  if (action === 'toggle-details') { ui.menu = null; ui.detailOpen = !ui.detailOpen; ui.profileBotId = null; ui.avatarEditing = false; ui.detailTab = 'details'; render(); await loadCurrent(); return render(); }
  if (action === 'close-details') { ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; return render(); }
  if (action === 'detail-tab') { ui.detailTab = element.dataset.tab; ui.avatarEditing = false; render(); await loadCurrent(); return render(); }
  if (action === 'open-bot-details') { if (!botById(id)) return; ui.profileBotId = id; ui.botId = id; ui.detailOpen = true; ui.avatarEditing = false; ui.detailTab = 'details'; ui.memories = []; render(); await loadCurrent(); return render(); }
  if (action === 'edit-avatar') { ui.avatarSelectionRevision++; const bot = profileBot(); if (!bot) return; ui.avatarEditing = !ui.avatarEditing; ui.avatarDraft = { ...botAvatar(bot) }; ui.avatarTab = 'bot'; return render(); }
  if (action === 'avatar-tab') { ui.avatarTab = element.dataset.tab; return render(); }
  if (action === 'avatar-save-retry') return persistAvatar();
  if (['avatar-shape', 'avatar-color', 'avatar-template', 'avatar-random', 'avatar-reset'].includes(action)) {
    ui.avatarSelectionRevision++;
    if (action === 'avatar-shape') ui.avatarDraft = { ...ui.avatarDraft, shape: element.dataset.shape, image: null };
    if (action === 'avatar-template') { const template = window.RelayAvatars.templates.find(p => p.id === element.dataset.template); if (template) { const {id, name, ...palette} = template; ui.avatarDraft = { ...ui.avatarDraft, ...palette, image: null }; } }
    if (action === 'avatar-color') ui.avatarDraft = { ...ui.avatarDraft, color: element.dataset.color, image: null };
    if (action === 'avatar-random') { const shapes = window.RelayAvatars.shapes, colors = window.RelayAvatars.colors; ui.avatarDraft = { shape: shapes[Math.floor(Math.random() * shapes.length)].id, color: colors[Math.floor(Math.random() * colors.length)], image: null }; }
    if (action === 'avatar-reset') ui.avatarDraft = { ...window.RelayAvatars.defaults(profileBot()?.id, state.bots.findIndex(bot => bot.id === profileBot()?.id)), image: null };
    return updateAvatarPicker(element.dataset.mode || 'edit');
  }
  if (action === 'copy-conversation') { await navigator.clipboard.writeText(mergedRoomMessages(ui.roomId, ui.messages).map(message => `${nameOf(message.senderId)} · ${formatTime(message.createdAt, true)}\n${message.content}`).join('\n\n')); return toast('会话文字已复制'); }
  if (action === 'install-app') { ui.menu = null; render(); if (window.RelayPwa?.install) return window.RelayPwa.install(); return toast('安装入口正在准备，请稍后重试。'); }
  if (action === 'update-app') { if (!preserveUpdateDrafts()) return; if (window.RelayPwa?.update) return window.RelayPwa.update(); location.reload(); return; }
  if (action === 'show-owner' || action === 'display-settings') return openDisplaySettings();
  if (action === 'copy-display-diagnostics') {
    await navigator.clipboard.writeText(JSON.stringify({ beforeSettings: displayDiagnosticSnapshot, current: captureDisplayDiagnostics() }, null, 2));
    return toast('显示诊断已复制，不包含聊天内容');
  }
  if (action === 'display-preset') return changeDisplayPreference('zoom', Number(element.dataset.zoom));
  if (action === 'display-reset') { displayPreferences[displayMode()] = { ...displayDefaults[displayMode()] }; return changeDisplayPreference('zoom', displayDefaults[displayMode()].zoom); }
  if (action === 'edit-room' || action === 'edit-room-members') return openRoomEdit(action === 'edit-room-members');
  if (action === 'navigate') return navigate(element.dataset.view);
  if (action === 'refresh') return refresh(true);
  if (action === 'close-modal') return closeModal();
  if (action === 'new-room') return openRoomForm();
  if (action === 'new-deep') return openRoomForm('deep');
  if (action === 'select-room') { ui.roomChosenByUser = true; const navigationSeq = ++ui.navigationSeq; ui.roomId = id; ui.view = 'chat'; location.hash = 'chat'; ui.reply = null; ui.menu = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; ui.mobileRoom = true; await restoreRoomMessages(id); if (navigationSeq !== ui.navigationSeq) return; render(); await loadCurrent(); if (navigationSeq !== ui.navigationSeq) return; render(); return; }
  if (action === 'room-back') { ++ui.navigationSeq; ui.mobileRoom = false; ui.menu = null; ui.detailOpen = false; document.activeElement?.blur?.(); return render(); }
  if (action === 'reply-message') { ui.reply = mergedRoomMessages(ui.roomId, ui.messages).find(message => message.id === id && !message._delivery); render(); $('#message-input')?.focus(); return; }
  if (action === 'retry-message') return sendLocalMessage(ui.localMessages?.[ui.roomId]?.[id]);
  if (action === 'cancel-reply') { ui.reply = null; return render(); }
  if (action === 'save-message') return openNodeForm(null, mergedRoomMessages(ui.roomId, ui.messages).find(message => message.id === id && !message._delivery));
  if (action === 'conclude-room') { element.disabled = true; try { await api(`/api/rooms/${encodeURIComponent(ui.roomId)}/conclude`, 'POST', {}); toast('深聊结束请求已提交，结论将保留在会话中。'); await refresh(); } finally { element.disabled = false; } return; }
  if (action === 'new-bot') return openCreateBot();
  if (action === 'avatar-greet') return window.RelayAvatars?.greet(element);
  if (action === 'edit-bot') return openBotForm(id);
  if (action === 'bot-contacts') return openBotContacts(id);
  if (action === 'select-bot' || action === 'open-profile') { ui.botId = id; ui.memories = []; return navigate('members'); }
  if (action === 'toggle-bot') { const bot = botById(id); await api(`/api/bots/${encodeURIComponent(id)}`, 'PATCH', { status: bot.status === 'paused' ? 'active' : 'paused' }); toast(bot.status === 'paused' ? '成员已恢复' : '成员已暂停'); return refresh(); }
  if (action === 'dm-bot') {
    if (!botById(id)) return;
    const navigationSeq = ++ui.navigationSeq;
    const existing = state.rooms.find(room => room.kind === 'dm' && room.status !== 'concluded' && room.members?.includes(id) && room.members.filter(member => member !== 'user').length === 1);
    const room = existing || await api('/api/rooms', 'POST', { name: `与 ${nameOf(id)} 的私聊`, kind: 'dm', members: ['user', id] });
    if (!existing) state.rooms.push(room);
    if (navigationSeq !== ui.navigationSeq) return;
    ui.roomChosenByUser = true; ui.roomId = room.id; ui.botId = id; ui.reply = null; ui.menu = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false; ui.mobileRoom = true; ui.view = 'chat'; location.hash = 'chat'; await restoreRoomMessages(room.id); if (navigationSeq !== ui.navigationSeq) return; render(); await refresh(); return;
  }
  if (action === 'new-memory') return openMemoryForm();
  if (action === 'edit-memory') return openMemoryForm(id);
  if (action === 'new-work') return openWorkForm();
  if (action === 'select-work' || action === 'open-work') { ui.workId = id; ui.workDetail = null; return navigate('works'); }
  if (action === 'work-filter') { ui.workFilter = id; return render(); }
  if (['cancel-work', 'pause-work', 'resume-work'].includes(action)) { element.disabled = true; try { await api(`/api/works/${encodeURIComponent(id)}/${action.replace('-work', '')}`, 'POST', {}); toast({ 'cancel-work': '取消请求已提交', 'pause-work': '工作已暂停', 'resume-work': '恢复请求已提交' }[action]); await refresh(); } finally { element.disabled = false; } return; }
  if (action === 'new-node') return openNodeForm();
  if (action === 'edit-node') return openNodeForm(id);
  if (action === 'new-edge') return openEdgeForm();
  if (action === 'edit-edge') return openEdgeEdit(id);
  if (action === 'select-node') { ui.nodeId = id; ui.graph = null; await loadCurrent(); return render(); }
  if (action === 'open-knowledge') { ui.nodeId = id; return navigate('knowledge'); }
  if (action === 'toggle-system-bots') { ui.systemBotsOpen = !ui.systemBotsOpen; return renderTopbar(); }
  if (action === 'retry-job') {
    const retrying = ui.retryingJobs ||= new Set();
    if (retrying.has(id)) return;
    retrying.add(id); element.disabled = true;
    const generation = ui.historyGeneration || 0;
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(id)}/retry`, 'POST', {});
      if (generation !== (ui.historyGeneration || 0)) return;
      toast(result.status === 'completed' ? '任务已经完成' : '已重新安排处理'); await refresh();
    } finally { retrying.delete(id); element.disabled = false; if (generation === (ui.historyGeneration || 0)) render(); }
    return;
  }
  if (action === 'clear-search') { ui.query = ''; if ($('#knowledge-query')) $('#knowledge-query').value = ''; ui.knowledgeResults = null; return render(); }
  if (action === 'new-routine') return openRoutineForm();
  if (action === 'edit-routine') return openRoutineForm(id);
  if (action === 'toggle-routine') { const routine = state.routines.find(item => item.id === id); await api(`/api/routines/${encodeURIComponent(id)}`, 'PATCH', { enabled: !routine.enabled }); toast(routine.enabled ? '职责已暂停' : '职责已启用'); return refresh(); }
  if (action === 'new-event') return openEventForm();
}

document.addEventListener('click', event => { const button = event.target.closest('[data-action]'); if (button && !button.disabled) act(button.dataset.action, button).catch(error => toast(error.message, true)); });
document.addEventListener('input', event => {
  if (event.target.id === 'display-zoom') return changeDisplayPreference('zoom', Number(event.target.value));
  if (event.target.id === 'display-font') return changeDisplayPreference('font', Number(event.target.value));
  if (event.target.id === 'create-bot-name') $('#create-bot-submit').disabled = !event.target.value.trim();
  if (event.target.id === 'message-input') { ui.drafts[event.target.form.dataset.roomId] = event.target.value; resizeComposer(event.target); persistClientSession(); }
  if (event.target.id === 'room-search') { ui.roomQuery = event.target.value; render(); }
});
document.addEventListener('keydown', event => { if (event.target.id === 'message-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); const button = $('#message-form button[type=submit]'); if (!button?.disabled) $('#message-form')?.requestSubmit(); } });
document.addEventListener('compositionstart', event => { if (event.target.id === 'message-input') ui.composing = true; });
document.addEventListener('compositionend', event => { if (event.target.id !== 'message-input') return; ui.composing = false; ui.drafts[event.target.form.dataset.roomId] = event.target.value; persistClientSession(); if (ui.renderDeferred) render(); });
document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id === 'modal-form') return;
  if (!['message-form', 'work-message-form', 'knowledge-search-form'].includes(form.id)) return;
  event.preventDefault(); const button = $('button[type=submit]', form); button.disabled = true;
  try {
    if (form.id === 'message-form') {
      const raw = $('#message-input', form).value, content = raw.trim();
      const roomId = form.dataset.roomId, attachments = attachmentDrafts(roomId).slice();
      if (!content && !attachments.length) return;
      if (attachmentBusy(roomId)) { toast('请等待附件上传完成，失败的附件可以重试或移除。'); return; }
      if (ui.sendingRooms.has(roomId)) return;
      const payload = { content, attachments: attachments.map(item => ({ id: item.attachment.id })), toBotId: $('#message-target', form).value || null, replyTo: ui.reply?.id || null };
      const entry = queueLocalMessage(roomId, payload, attachments);
      // Clear both state and the existing DOM before render() preserves input focus.
      ui.drafts[roomId] = ''; $('#message-input', form).value = '';
      const sentKeys = new Set(attachments.map(item => item.key));
      for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      ui.draftAttachments[roomId] = attachmentDrafts(roomId).filter(item => !sentKeys.has(item.key));
      if (ui.roomId === roomId && ui.reply?.id === payload.replyTo) ui.reply = null;
      await sendLocalMessage(entry, true);
    } else if (form.id === 'work-message-form') {
      const field = $('#work-message', form), message = field.value.trim(), submissions = ui.workSubmissions ||= {}, submission = submissions[form.dataset.id];
      if (!message || submission?.sending) return;
      const pending = submission?.message === message ? submission : { id: crypto.randomUUID(), workId: form.dataset.id, message }; submissions[form.dataset.id] = pending; pending.sending = true;
      try {
        await api(`/api/works/${encodeURIComponent(pending.workId)}/send`, 'POST', { id: pending.id, message });
        const current = $('#work-message-form');
        if (current?.dataset.id === pending.workId && $('#work-message', current).value.trim() === message) $('#work-message', current).value = '';
        delete submissions[pending.workId]; toast('补充已记录'); await refresh();
      } finally {
        pending.sending = false; const current = $('#work-message-form');
        if (current?.dataset.id === pending.workId) $('button[type=submit]', current).disabled = false;
      }
    }
    else { ui.query = $('#knowledge-query').value.trim(); await loadCurrent(); render(); }
  } catch (error) { toast(error.message, true); } finally { button.disabled = false; const currentSend = $('#message-form button[type=submit]'); if (currentSend) updateComposerButton($('#message-input')); }
});
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const box = $('#modal').getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeModal(); } });
$('#modal').addEventListener('cancel', event => { event.preventDefault(); closeModal(); });
window.addEventListener('hashchange', () => { const view = location.hash.slice(1); if (tabs.some(tab => tab.id === view) && ui.view !== view) navigate(view); });
// Conversation-first layout, matched to the supplied reference screens.
Object.assign(icons, {
  send: '<path d="M12 21V3m-7 7 7-7 7 7"/>',
  microphone: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  attachment: '<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L12 3a2.5 2.5 0 0 1 4 3L6 16a1 1 0 0 1-2-2l8-8" transform="translate(1 0)"/>',
  settings: '<path d="m9 3-.5 2.2-2 .8-1.9-1.1-2 3.5L4.2 10v2l-1.6 1.6 2 3.5 2.2-.5 1.7 1.1L9 21h4l.5-2.3 1.7-1.1 2.2.5 2-3.5L17.8 13v-2l1.6-1.6-2-3.5L15.5 7l-2-.8L13 3Z"/><circle cx="11" cy="12" r="3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  computer: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  file: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/>',
});

function botAvatar(botOrId) {
  const bot = typeof botOrId === 'string' ? botById(botOrId) : botOrId;
  const index = Math.max(0, state.bots.findIndex(item => item.id === bot?.id));
  return window.RelayAvatars.normalize({ ...window.RelayAvatars.defaults(bot?.id || '', index), ...(bot?.avatar || {}) });
}
function face(config, size = 60, options = {}) { return window.RelayAvatars ? window.RelayAvatars.render(config, size, options) : `<span class="face-fallback" style="width:${size}px;height:${size}px;background:${esc(config?.color || '#959595')}"></span>`; }
function avatar(id, large = false, key = `bot:${id}`) {
  const size = typeof large === 'number' ? large : large ? 104 : 60;
  if (id === 'user') return `<img class="user-avatar" src="/icons/user-avatar.jpg?v=owner-20261028" width="${size}" height="${size}" style="width:${size}px;height:${size}px" alt="" aria-hidden="true">`;
  if (!botById(id)) return `<span class="system-avatar" style="width:${size}px;height:${size}px">${icon(String(id).startsWith('executor:') ? 'computer' : 'event', Math.round(size * .5))}</span>`;
  const work=botWorkState(botById(id));
  const recent=(state.agentRuns||[]).filter(run=>run.botId===id).at(-1);
  const active=(state.agentRuns||[]).filter(run=>run.botId===id&&['accepted','queued','running','waiting'].includes(run.status)).at(-1)||(state.runtime?.jobs||[]).filter(job=>job.botId===id&&['accepted','queued','running','waiting'].includes(job.status)).at(-1);
  const motion=work.kind==='paused'?'asleep':work.kind==='working'?'work':work.kind==='waiting'?(active?.status==='waiting'?'wait':'think'):['failed','interrupted'].includes(recent?.status)?'failed':'idle';
  return `<span class="bot-avatar" style="width:${size}px;height:${size}px" aria-hidden="true">${face(botAvatar(id), size, { key, identity: `bot:${id}`, state: motion })}</span>`;
}
function groupAvatar(room, size = 96, key = `group:${room?.id}:${size}`) {
  const members = (room?.members || []).filter(id => id === 'user' || botById(id)).slice(0, 4);
  if (!members.length) return `<span class="group-avatar group-avatar-empty" style="width:${size}px;height:${size}px">${icon(room?.kind === 'deep' ? 'layers' : 'chat', Math.round(size * .6))}</span>`;
  return `<span class="group-avatar" data-count="${members.length}" style="width:${size}px;height:${size}px">${members.map((id, index) => `<span class="group-face pos-${index}">${avatar(id, members.length === 1 ? size : Math.round(size * .64), `${key}:${index}`)}</span>`).join('')}</span>`;
}
function currentBot() {
  const room = roomById(ui.roomId);
  return room?.kind === 'dm' && room.members?.includes('user') ? botById(room.members.find(id => id !== 'user')) : null;
}
function profileBot() { return ui.profileBotId ? botById(ui.profileBotId) : currentBot(); }
function currentAccent() { const bot = currentBot() || (roomById(ui.roomId)?.members || []).map(id => botById(id)).find(Boolean); return bot ? botAvatar(bot).color : '#222222'; }
function providerLabel() {
  const provider = state.provider || {};
  if (provider.testDouble || /test.?double|regression double/i.test(provider.model || '')) return '界面验证替身';
  return provider.lastError ? '连接异常' : provider.connected ? '已连接' : provider.configured ? '已配置 · 待调用' : '未配置';
}
function isSystemBot(bot) { return typeof bot?.presetId === 'string' && bot.presetId.length > 0; }
function ownerName() { return state.user?.name || state.owner?.name || '你'; }
function botRole(bot) { return listText(bot?.expertise) || bot?.role || ''; }
function executionSummary(run, tool) {
  const count = Number(run.toolCount) || 0, path = typeof tool?.path === 'string' ? tool.path : typeof tool?.args?.path === 'string' ? tool.args.path : '';
  if (run.status === 'completed') return { text: count ? `已完成 ${count} 项操作` : '已完成回复', path: '' };
  if (['failed', 'interrupted', 'cancelled'].includes(run.status)) return { text: labels[run.status] || run.status, path: '' };
  if (run.status === 'waiting') return { text: '等待答复', path: '' };
  if (['queued', 'accepted'].includes(run.status)) return { text: run.status === 'queued' ? '等待执行' : '已接收，准备处理', path: '' };
  const actions = { read_file: '正在读取文件', write_file: '正在写入文件', edit_file: '正在修改文件', list_files: '正在查看目录', search_files: '正在查找文件', search_text: '正在搜索内容', execute_command: '正在执行命令', run_command: '正在执行命令', messages_send: '正在联系同伴', chatroom_dm: '正在联系同伴', chatroom_send: '正在发送消息', tasks_get: '正在查看同伴进度', tasks_cancel: '正在取消同伴任务', work_create: '正在建立工作', work_wait: '正在登记等待', work_notify: '正在通知结果', knowledge_write: '正在整理知识', skill_write: '正在更新技能', contacts_list: '正在查看联系人', search_knowledge: '正在搜索知识', read_resource: '正在读取技能', read_session_history: '正在回顾会话' };
  const target = tool?.targetBotId || tool?.args?.targetBotId || tool?.args?.toBotId;
  const text = tool?.status === 'running' ? actions[tool.name] || '正在执行操作' : count ? `正在处理 · ${count} 项操作` : '正在处理';
  return { text: target && botById(target) ? `${text} · ${nameOf(target)}` : text, path };
}
function botWorkState(bot) {
  if (bot.status === 'paused') return { kind: 'paused', text: '已暂停' };
  const job = (state.runtime?.jobs || []).filter(job => job.botId === bot.id && ['accepted', 'queued', 'running', 'waiting'].includes(job.status)).at(-1);
  const run = (state.agentRuns || []).filter(run => run.botId === bot.id && ['accepted', 'queued', 'running', 'waiting'].includes(run.status)).at(-1);
  if (run) return { kind: run.status === 'running' ? 'working' : 'waiting', text: executionSummary(run, run.lastTool).text };
  if (job) return { kind: job.status === 'running' ? 'working' : 'waiting', text: job.status === 'running' ? '正在处理' : job.status === 'waiting' ? '等待答复' : '等待执行' };
  return { kind: 'idle', text: '空闲' };
}
function roomPreview(room) {
  const message = room.lastMessage;
  if (!message) return room.status === 'concluded' ? '已结束 · 结论已保留' : room.goal || '还没有消息';
  const content = message.content || message.attachments?.map(item => `[附件] ${item.name}`).join('、') || '附件';
  return `${nameOf(message.senderId)}：${content.replace(/\s+/g, ' ')}`;
}
function roomReadMarkers() {
  if (ui.readMarkersEpoch !== ui.historyEpoch || !ui.readMarkers) {
    ui.readMarkersEpoch = ui.historyEpoch;
    try { const saved = JSON.parse(localStorage.getItem('relay:room-read-markers:v1')); ui.readMarkers = saved?.historyEpoch === (ui.historyEpoch ?? null) ? saved.rooms || {} : {}; }
    catch { ui.readMarkers = {}; }
  }
  return ui.readMarkers;
}
function saveRoomReadMarkers() { try { localStorage.setItem('relay:room-read-markers:v1', JSON.stringify({ historyEpoch: ui.historyEpoch ?? null, rooms: ui.readMarkers })); } catch {} }
function markCurrentRoomRead() {
  if (ui.view !== 'chat' || document.hidden || displayMedia.matches && !ui.mobileRoom || ui.messagesRoomId !== ui.roomId) return;
  const last = mergedRoomMessages(ui.roomId, ui.messages).filter(message => !message._delivery).at(-1);
  if (!last?.createdAt) return;
  const markers = roomReadMarkers();
  if (markers[ui.roomId] !== last.createdAt) { markers[ui.roomId] = last.createdAt; saveRoomReadMarkers(); }
}
function unreadRoomBadge(room) {
  const count = Number(room.unreadCount);
  if (Number.isFinite(count) && count > 0) return `<span class="unread-count" aria-label="${count} 条未读">${count > 99 ? '99+' : count}</span>`;
  const markers = roomReadMarkers(), last = room.lastMessage;
  if (!last?.createdAt) return '';
  if (!markers[room.id]) { markers[room.id] = last.createdAt; saveRoomReadMarkers(); return ''; }
  if (last.senderId === 'user' || last.createdAt <= markers[room.id]) return '';
  const known = ui.messageCache.get(room.id)?.messages?.filter(message => message.senderId !== 'user' && message.createdAt > markers[room.id]).length;
  return known ? `<span class="unread-count" aria-label="${known} 条未读">${known > 99 ? '99+' : known}</span>` : '<i class="unread-dot" aria-label="有新消息"></i>';
}
function renderBotContact(bot, selectedBot) {
  const work = botWorkState(bot), dm = state.rooms.find(room => room.kind === 'dm' && room.members?.includes('user') && room.members?.includes(bot.id));
  return `<button class="contact-row ${ui.view === 'chat' && selectedBot?.id === bot.id && !ui.profileBotId ? 'selected' : ''}" data-action="dm-bot" data-id="${esc(bot.id)}" style="--member-color:${esc(botAvatar(bot).color)}"><span class="contact-avatar-wrap">${avatar(bot.id, 56, `sidebar:${bot.id}`)}</span><span class="contact-copy"><span class="contact-heading"><strong>${esc(bot.name)}</strong><small class="contact-role">${esc(botRole(bot))}</small></span><span class="contact-status ${work.kind}"><i class="status-dot" aria-hidden="true"></i>${esc(work.text)}</span></span>${dm ? unreadRoomBadge(dm) : ''}</button>`;
}
function renderTopbar() {
  const oldContactTop = $('.contacts-scroll')?.scrollTop || 0, oldPeerOpen = $('.peer-conversations')?.open;
  const query = (ui.roomQuery || '').trim().toLowerCase();
  const groups = state.rooms.filter(room => room.kind !== 'dm' && (!query || `${room.name} ${room.goal}`.toLowerCase().includes(query)));
  const matchingBots = state.bots.filter(bot => !query || `${bot.name} ${bot.role} ${bot.expertise}`.toLowerCase().includes(query));
  const bots = matchingBots.filter(bot => !isSystemBot(bot)), systemBots = matchingBots.filter(isSystemBot);
  const peerRooms = state.rooms.filter(room => room.kind === 'dm' && !room.members?.includes('user') && (!query || room.name.toLowerCase().includes(query)));
  const selectedBot = currentBot();
  const selectedSystem = ui.view === 'chat' && isSystemBot(selectedBot) ? selectedBot : null;
  if (selectedSystem && selectedSystem.id !== ui.selectedSystemBotId) ui.systemBotsOpen = true;
  ui.selectedSystemBotId = selectedSystem?.id || null;
  const systemOpen = ui.systemBotsOpen || !!query;
  const systemGroup = systemBots.length ? `<section class="system-bots ${selectedSystem ? 'has-selection' : ''}" aria-label="系统 Bot"><button class="system-bots-toggle" data-action="toggle-system-bots" aria-expanded="${systemOpen}" aria-controls="system-bot-contacts">${icon('settings', 18)}<span>系统 Bot${selectedSystem ? `<small>当前：${esc(selectedSystem.name)}</small>` : ''}</span><span class="system-bots-count">${systemBots.length}</span><span aria-hidden="true">${systemOpen ? '▾' : '▸'}</span></button>${systemOpen ? `<div id="system-bot-contacts">${systemBots.map(bot => renderBotContact(bot, selectedBot)).join('')}</div>` : '<div id="system-bot-contacts" hidden></div>'}</section>` : '';
  const activeWorks = state.works.filter(work => !work.historical && ['active', 'queued', 'running', 'waiting'].includes(work.status)).length;
  const menu = ui.menu === 'create' ? `<div class="context-menu create-menu"><button data-action="new-bot">${icon('person', 19)}创建新 Bot</button><button data-action="new-room">${icon('people', 19)}创建群聊</button><button data-action="new-deep">${icon('layers', 19)}创建深聊</button></div>` : '';
  const appMenu = ui.menu === 'apps' ? `<div class="context-menu apps-menu"><div class="menu-title">连接应用</div><div class="connection-row"><span class="app-emblem flash">D</span><div><strong>DeepSeek Flash</strong><small class="${state.provider.lastError ? 'error-text' : ''}">${esc(providerLabel())}</small></div><button class="icon-button" data-action="refresh" title="刷新状态" aria-label="刷新状态">${icon('refresh', 17)}</button></div>${state.provider.lastError ? `<p class="menu-error">${esc(state.provider.lastError)}</p>` : ''}<div class="connection-row"><span class="app-emblem codex">${icon('computer', 21)}</span><div><strong>Codex</strong><small>${activeWorks ? `${activeWorks} 项工作进行中` : '专业执行端'}</small></div></div><div class="menu-separator"></div>${tabs.filter(tab => tab.id !== 'chat').map(tab => `<button data-action="navigate" data-view="${tab.id}">${icon(tab.icon, 19)}${tab.id === 'members' ? '管理 Bot' : tab.title}${tab.id === 'works' && activeWorks ? `<span class="menu-count">${activeWorks}</span>` : ''}</button>`).join('')}<button data-action="new-event">${icon('event', 19)}投递事件</button><div class="menu-separator"></div><button data-action="display-settings">${icon('settings', 19)}显示设置</button><button data-action="install-app">${icon('install', 19)}安装到设备</button><button data-action="update-app">${icon('refresh', 19)}刷新页面</button></div>` : '';
  const sidebar = $('#contact-sidebar');
  const html = `<div class="sidebar-toolbar"><summon-wordmark></summon-wordmark><div class="search-slot ${ui.searchOpen ? 'open' : ''}">${ui.searchOpen ? `<input id="room-search" value="${esc(ui.roomQuery)}" placeholder="搜索群聊与伙伴" aria-label="搜索会话与 Bot">` : ''}<button class="round-button" data-action="toggle-search" title="搜索" aria-label="搜索">${icon('search', 24)}</button></div><div class="menu-anchor"><button class="round-button create-button" data-action="toggle-create" aria-label="新建" title="新建" aria-expanded="${ui.menu === 'create'}">${icon('plus', 27)}</button>${menu}</div></div><div class="contacts-scroll"><section class="sidebar-section group-section"><h2 class="sidebar-section-title">群聊</h2><div class="group-grid">${groups.map(room => `<button class="group-tile ${room.id === ui.roomId && ui.view === 'chat' ? 'selected' : ''}" data-action="select-room" data-id="${esc(room.id)}" title="${esc(room.name)}">${groupAvatar(room, 58)}<span class="group-copy"><strong>${esc(room.name)}</strong><span class="group-preview">${room.kind === 'deep' ? `<span class="group-kind">${room.status === 'concluded' ? '已结束' : '深聊'}</span>` : ''}${esc(roomPreview(room))}</span></span>${unreadRoomBadge(room)}</button>`).join('') || '<p class="sidebar-empty">还没有群聊</p>'}</div></section><section class="sidebar-section partner-section"><h2 class="sidebar-section-title">伙伴</h2><div class="bot-contacts">${bots.map(bot => renderBotContact(bot, selectedBot)).join('') || (!query ? '<p class="sidebar-empty">创建一位伙伴，开始协作</p>' : '')}</div></section>${systemGroup}${peerRooms.length ? `<details class="peer-conversations" ${query ? 'open' : ''}><summary>Bot 之间的对话 <span>${peerRooms.length}</span>${icon('chevron', 14)}</summary>${peerRooms.map(room => `<button class="peer-room ${room.id === ui.roomId ? 'selected' : ''}" data-action="select-room" data-id="${esc(room.id)}">${groupAvatar(room, 44)}<span>${esc(room.name)}</span>${unreadRoomBadge(room)}</button>`).join('')}</details>` : ''}${!matchingBots.length && !groups.length && query ? '<div class="sidebar-empty">没有找到匹配项</div>' : ''}</div><div class="sidebar-footer"><button class="sidebar-owner" data-action="show-owner" title="显示设置"><span class="contact-avatar-wrap">${avatar('user', 50)}<i class="presence-dot ${ui.streamConnected ? 'idle' : 'paused'}" aria-hidden="true"></i></span><span class="owner-copy"><strong>${esc(ownerName())}</strong><small>${navigator.onLine === false ? '离线' : ui.streamConnected ? '在线' : '正在连接'}</small></span></button><div class="menu-anchor apps-anchor"><button class="sidebar-settings icon-button" data-action="toggle-apps" title="设置与应用" aria-label="设置与应用" aria-expanded="${ui.menu === 'apps'}">${icon('settings', 27)}</button>${appMenu}</div></div>`;
  const signature = renderSignature(html);
  if (ui.lastSidebarHtml !== signature) { const motion = captureMotion(sidebar); sidebar.innerHTML = html; ui.lastSidebarHtml = signature; hydrateMotion(sidebar, motion); }
  if ($('.contacts-scroll')) $('.contacts-scroll').scrollTop = oldContactTop;
  if ($('.peer-conversations') && oldPeerOpen !== undefined) $('.peer-conversations').open = oldPeerOpen;
  $('.app-shell').classList.toggle('mobile-room', ui.view === 'chat' && ui.mobileRoom);
  $('.app-shell').classList.toggle('management-open', ui.view !== 'chat');
}
function richText(value) {
  const blocks = String(value || '').split(/```(?:[\w-]+)?\n?([\s\S]*?)```/g);
  return blocks.map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.trim())}</code></pre>`;
    let offset = 0;
    return part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((segment, index) => {
      const before = offset ? part[offset - 1] : i ? '`' : ''; offset += segment.length;
      const after = part[offset] || (i < blocks.length - 1 ? '`' : '');
      if (index % 2 && segment.startsWith('`')) return `<code>${esc(segment.slice(1, -1))}</code>`;
      if (index % 2) return `<strong>${mentionText(segment.slice(2, -2), '*', '*')}</strong>`;
      return mentionText(segment, before, after);
    }).join('').replace(/^[-*] (.+)$/gm, '<span class="markdown-li">$1</span>');
  }).join('');
}
function botMention(id, label) {
  const bot = botById(id); if (!bot) return esc(label || nameOf(id));
  return `<button type="button" class="bot-mention" data-action="open-bot-details" data-id="${esc(id)}" style="--member-color:${esc(botAvatar(bot).color)}">${avatar(id, 25, '')}<span>@${esc(label || bot.name)}</span></button>`;
}
function mentionText(text, before = '', after = '') {
  const aliases = state.bots.flatMap(bot => [[bot.name, bot.id], [bot.id, bot.id]]).filter(([name]) => name).sort((a, b) => b[0].length - a[0].length);
  if (!aliases.length) return esc(text);
  const byAlias = new Map(aliases.map(([name, id]) => [name.toLowerCase(), id])), expression = new RegExp(`(^|\\s)@(${aliases.map(([name]) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=$|[\\s，。！？:：,!?])`, 'giu');
  let cursor = 0, result = '';
  for (const match of text.matchAll(expression)) {
    if (!match[1] && match.index === 0 && before && !/\s/.test(before)) continue;
    if (match.index + match[0].length === text.length && after && !/[\s，。！？:：,!?]/.test(after)) continue;
    result += esc(text.slice(cursor, match.index)) + esc(match[1]) + botMention(byAlias.get(match[2].toLowerCase()));
    cursor = match.index + match[0].length;
  }
  return result + esc(text.slice(cursor));
}
function messageActivity(message, room) {
  if (message._activity === 'sent') return `<div class="message-work-status collaboration-status"><span>已联系</span>${botMention(message.toBotId)}</div>`;
  if (message.peerReplyId) {
    const peer = (state.activity || []).find(item => item.id === message.peerReplyId);
    return `<div class="message-work-status collaboration-status">${peer ? `消息来自 ${botMention(peer.senderId)}` : '同伴回复已回到本会话'}</div>`;
  }
  return '';
}
function chatExecutionBindings(messages) {
  const runs = visibleAgentRuns(), active = [], byMessage = new Map(), orphaned = [], linkedJobs = new Set();
  for (const run of runs) {
    const job = ui.roomJobs.find(job => job.taskId === run.id || job.agentRunId === run.id);
    if (job) linkedJobs.add(job.id);
    if (['accepted', 'queued', 'running', 'waiting'].includes(run.status)) { active.push(run); continue; }
    const sourceId = job?.messageId || run.input?.trigger?.id;
    const explicitReply = job && messages.find(message => message.jobId === job.id && message.senderId === run.botId && message.kind !== 'error');
    const directReply = sourceId ? messages.filter(message => message.senderId === run.botId && !message.jobId && message.replyTo === sourceId && message.kind !== 'error').at(-1) : null;
    const anchor = explicitReply || directReply || messages.find(message => message.id === sourceId);
    if (!anchor) { orphaned.push(run); continue; }
    if (!byMessage.has(anchor.id)) byMessage.set(anchor.id, []);
    byMessage.get(anchor.id).push(run);
  }
  const pending = ui.roomJobs.filter(job => !linkedJobs.has(job.id) && ['accepted', 'queued', 'running', 'waiting'].includes(job.status));
  return { byMessage, orphaned, pending, active };
}
function pendingJobStatus(job) {
  const text = job.status === 'running' ? '正在处理' : job.status === 'waiting' ? '等待答复' : '等待执行';
  return `<div class="message-work-status ${esc(job.status)}" role="status">${avatar(job.botId, 22, `pending:${job.id}`)}<span>${esc(nameOf(job.botId))} · ${text}</span></div>`;
}
function renderComposerActivity(executions) {
  const statuses = executions.active.map(run => renderAgentRun(run, { showBot: true })).join('') + executions.pending.map(pendingJobStatus).join('');
  return statuses ? `<div class="composer-activity" aria-label="当前运行状态" aria-live="polite">${statuses}</div>` : '';
}
function collaborationBindings(messages, activities) {
  const byMessage = new Map(), orphaned = [];
  for (const activity of activities) {
    const sourceId = activity.returnTo?.messageId;
    const reply = messages.filter(message => message.senderId === activity.senderId && message.replyTo === sourceId && message.kind !== 'error').at(-1);
    const anchor = reply || messages.find(message => message.id === sourceId);
    if (!anchor) { orphaned.push(activity); continue; }
    if (!byMessage.has(anchor.id)) byMessage.set(anchor.id, []);
    byMessage.get(anchor.id).push(activity);
  }
  return { byMessage, orphaned };
}
function renderCollaborationStatus(activities) {
  const targets = [...new Set(activities.map(activity => activity.toBotId).filter(id => botById(id)))];
  if (!targets.length) return '';
  return `<div class="message-work-status collaboration-status"><span class="collaboration-avatars">${targets.map(id => `<button type="button" data-action="dm-bot" data-id="${esc(id)}" title="查看与 ${esc(nameOf(id))} 的对话" aria-label="查看与 ${esc(nameOf(id))} 的对话">${avatar(id, 28, '')}</button>`).join('')}</span><span>已联系 ${targets.length} 位伙伴</span></div>`;
}
function renderChatMessage(message, { isGroup, conversationMessages, failures, executions, collaborations }) {
  const sender = message.senderId || 'system', own = sender === 'user', senderBot = botById(sender);
  const memberColor = senderBot ? botAvatar(senderBot).color : '#8b8e9f';
  const reply = message.replyTo ? conversationMessages.find(item => item.id === message.replyTo) : null;
  const replyColor = reply && botById(reply.senderId) ? botAvatar(reply.senderId).color : '#8b8e9f';
  const replyHtml = reply ? `<div class="bubble-reply" style="--reply-color:${esc(replyColor)}"><span class="reply-avatar">${avatar(reply.senderId, 42, '')}</span><span class="reply-copy"><span class="reply-author" style="color:${esc(replyColor)}">${botById(reply.senderId) ? '@' : ''}${esc(nameOf(reply.senderId))}</span><span class="reply-text">${esc(reply.content?.slice(0, 140) || (reply.attachments?.length ? '[附件]' : '消息'))}</span></span></div>` : '';
  const alreadyMentioned = message.toBotId && [botById(message.toBotId)?.name, message.toBotId].filter(Boolean).some(name => message.content?.includes(`@${name}`));
  const workStatuses = (executions.byMessage.get(message.id) || []).map(run => renderAgentRun(run, { showBot: sender !== run.botId })).join('');
  return `<article data-message-id="${esc(message.id)}" data-motion-key="message:${esc(message.clientId || message.id)}" class="chat-message ${own ? 'outgoing' : 'incoming'} ${isGroup ? 'in-group' : ''} ${message.kind === 'error' ? 'error' : ''} ${sender === 'system' || message.kind === 'event' ? 'system-message' : ''}" style="--member-color:${esc(memberColor)}">${!own ? senderBot ? `<button class="message-avatar-button" data-action="open-bot-details" data-id="${esc(sender)}" title="${esc(nameOf(sender))}">${avatar(sender, 56, `message:${message.id}`)}</button>` : `<span class="message-avatar-button">${avatar(sender, 56, `message:${message.id}`)}</span>` : ''}<div class="bubble-column"><div class="message-meta">${senderBot ? `<button class="speaker-name" data-action="open-bot-details" data-id="${esc(sender)}">${esc(nameOf(sender))}</button>` : `<span class="speaker-name">${esc(nameOf(sender))}</span>`}${senderBot && botRole(senderBot) ? `<span class="speaker-role">${esc(botRole(senderBot))}</span>` : ''}<time datetime="${esc(message.createdAt)}" title="${esc(formatTime(message.createdAt, true))}">${esc(formatTime(message.createdAt))}</time></div><div class="message-bubble" tabindex="0">${replyHtml}${message.toBotId && !alreadyMentioned ? `<div class="bubble-target">${botMention(message.toBotId)}</div>` : ''}${message.content ? `<div class="message-content">${richText(message.content)}</div>` : ''}${renderMessageAttachments(message.attachments)}</div>${renderSendStatus(message)}${workStatuses}${renderCollaborationStatus(collaborations.byMessage.get(message.id) || [])}${messageActivity(message)}<div class="bubble-actions" ${message._delivery ? 'hidden' : ''}><button data-action="reply-message" data-id="${esc(message.id)}" title="回复" aria-label="回复">${icon('back', 17)}</button><button data-action="save-message" data-id="${esc(message.id)}" title="保存为知识" aria-label="保存为知识">${icon('knowledge', 17)}</button></div>${messageJobNotices(message.id, failures)}</div></article>`;
}
function renderChat() {
  const room = roomById(ui.roomId), bot = currentBot(), isGroup = room?.kind !== 'dm' || !room?.members?.includes('user');
  const members = (room?.members || []).filter(id => id !== 'user').map(botById).filter(Boolean);
  const title = bot?.name || room?.name || 'Summon';
  const accent = currentAccent();
  const activities = (state.activity || []).filter(message => message.returnTo?.roomId === ui.roomId && message.roomId !== ui.roomId && message.toBotId).map(message => ({ ...message, _activity: 'sent' }));
  const conversationMessages = mergedRoomMessages(ui.roomId, ui.messages);
  const failures = unresolvedJobLeaves(ui.roomJobs, conversationMessages);
  const executions = chatExecutionBindings(conversationMessages), collaborations = collaborationBindings(conversationMessages, activities);
  const timeline = conversationMessages.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  let previousDay = '';
  const messages = timeline.map(message => {
    const date = formatDay(message.createdAt), divider = date !== previousDay ? `<div class="date-divider">${esc(date)}</div>` : ''; previousDay = date;
    return divider + renderChatMessage(message, { isGroup, conversationMessages, failures, executions, collaborations });
  }).join('');
  const chatMenu = ui.menu === 'chat-menu' ? `<div class="context-menu chat-menu"><button data-action="toggle-details">${icon('info', 19)}查看${isGroup ? '群聊' : 'Bot'}详情</button><button data-action="copy-conversation">${icon('copy', 19)}复制会话文字</button><button data-action="display-settings">${icon('settings', 19)}显示设置</button><button data-action="new-work">${icon('work', 19)}委托工作</button><button data-action="new-deep">${icon('layers', 19)}发起深聊</button>${room?.kind === 'deep' && room.status !== 'concluded' ? `<button data-action="conclude-room">${icon('check', 19)}结束深聊</button>` : ''}</div>` : '';
  const memberSummary = isGroup ? `${room?.members?.includes('user') ? '你和 ' : ''}${members.length} 位伙伴` : bot ? botRole(bot) || '私聊' : '选择一个会话';
  const header = `<div class="floating-header"><button class="mobile-back icon-button" data-action="room-back" aria-label="返回会话">${icon('chevronBack', 23)}</button><button class="chat-title-pill" data-action="toggle-details" aria-expanded="${!!ui.detailOpen}" title="查看${isGroup ? '群聊' : 'Bot'}详情">${bot ? avatar(bot.id, 56, 'slot:title') : groupAvatar(room, 58, 'slot:title-group')}<span class="chat-title-copy"><strong>${esc(title)}</strong><small>${esc(memberSummary)}</small></span></button><div class="header-members" aria-label="会话成员">${members.slice(0, 8).map(member => `<button class="header-member" data-action="open-bot-details" data-id="${esc(member.id)}" aria-label="查看 ${esc(member.name)}" title="${esc(member.name)} · ${esc(botRole(member))}">${avatar(member.id, 39, `header:${member.id}`)}</button>`).join('')}${members.length > 8 ? `<button class="header-member member-overflow" data-action="toggle-details" title="查看全部成员">+${members.length - 8}</button>` : ''}</div><div class="mobile-chat-actions menu-anchor"><button class="round-button" data-action="toggle-chat-menu" aria-label="会话更多操作" aria-expanded="${ui.menu === 'chat-menu'}">${icon('more', 24)}</button>${chatMenu}</div></div>`;
  const extraStatuses = executions.orphaned.map(run => renderAgentRun(run, { showBot: true })).join('') + renderCollaborationStatus(collaborations.orphaned);
  const body = room ? `<div class="messages ${isGroup ? 'group-messages' : ''}" role="log" aria-label="聊天记录">${messages || `<div class="conversation-empty">${bot ? avatar(bot.id, 86, 'slot:empty') : groupAvatar(room, 86)}<span>${esc(title)}</span><p>${esc(ui.messagesRoomId === ui.roomId ? room.goal || '发一条消息，和伙伴一起开始' : '正在读取消息…')}</p></div>`}${roomNotices(room, failures)}${extraStatuses ? `<div class="conversation-activity">${extraStatuses}</div>` : ''}</div>${renderChatComposer(room, members, title, isGroup, executions)}` : `<div class="conversation-empty"><p>选择一位伙伴，开始聊天</p><button class="secondary-button" data-action="new-bot">创建新 Bot</button></div>`;
  return `<div data-room-id="${esc(ui.roomId)}" data-ready="${ui.messagesRoomId === ui.roomId}" class="chat-layout ${ui.detailOpen ? 'detail-open' : ''}" style="--accent:${esc(accent)}"><section class="conversation">${header}${body}</section>${ui.detailOpen ? renderDetailPanel(room, profileBot()) : ''}</div>`;
}
function renderChatComposer(room, members, title, isGroup, executions) {
  const activity = renderComposerActivity(executions);
  if (room.status === 'concluded') return `<div class="composer-wrap">${activity}<div class="closed-notice">深聊已结束 <button class="text-button" data-action="new-deep">发起新的深聊</button></div></div>`;
  const target = members.find(member => member.id === ui.draftTargets[ui.roomId]);
  const mentionMenu = ui.menu === 'mentions' ? `<div class="mention-menu context-menu" role="menu" aria-label="选择负责的伙伴"><button type="button" class="mention-choice" data-action="choose-message-target" data-id="" role="menuitem">${icon('people', 25)}<span>自动选择负责人<small>按消息与已有工作选择合适伙伴</small></span>${!target ? icon('check', 16) : ''}</button>${members.map(member => `<button type="button" class="mention-choice" style="--member-color:${esc(botAvatar(member).color)}" data-action="choose-message-target" data-id="${esc(member.id)}" role="menuitem">${avatar(member.id, 32, '')}<span>${esc(member.name)}<small>${esc(botRole(member))}</small></span>${target?.id === member.id ? icon('check', 16) : ''}</button>`).join('')}</div>` : '';
  const reply = ui.reply ? `<div class="reply-preview">${avatar(ui.reply.senderId, 25, '')}<span>回复 ${esc(nameOf(ui.reply.senderId))}：${esc(ui.reply.content?.slice(0, 100) || '[附件]')}</span><button type="button" class="icon-button" data-action="cancel-reply" aria-label="取消回复">${icon('close', 16)}</button></div>` : '';
  return `<div class="composer-wrap">${activity}${reply}${renderAttachmentDrafts()}<form id="message-form" class="composer" data-room-id="${esc(ui.roomId)}"><button class="composer-plus" type="button" data-action="attach-file" title="添加附件" aria-label="添加附件" ${ui.sendingRooms.has(ui.roomId) ? 'disabled' : ''}>${icon('plus', 23)}</button><textarea id="message-input" name="content" rows="1" aria-label="消息内容" placeholder="给 ${esc(title)} 发消息…">${esc(ui.drafts[ui.roomId] || '')}</textarea>${isGroup ? `<div class="composer-tools"><div class="menu-anchor"><button class="composer-mention ${target ? 'has-target' : ''}" style="--member-color:${esc(target ? botAvatar(target).color : '#747a8d')}" type="button" data-action="toggle-mention-menu" aria-label="${target ? `消息对象：${esc(target.name)}` : '选择负责的伙伴'}" aria-expanded="${ui.menu === 'mentions'}">${target ? `${avatar(target.id, 23, '')}<span>@${esc(target.name)}</span>` : '@'}</button>${mentionMenu}</div></div>` : ''}<select id="message-target" class="message-target visually-hidden" aria-label="消息对象" tabindex="-1" aria-hidden="true"><option value="">自动选择负责人</option>${members.map(item => `<option value="${esc(item.id)}" ${target?.id === item.id ? 'selected' : ''}>@ ${esc(item.name)}</option>`).join('')}</select><button type="submit" class="composer-send" ${sendBusy() ? 'disabled' : ''} title="发送消息" aria-label="发送消息">${icon('send', 25)}</button></form></div>`;
}
function renderDetailPanel(room, bot) {
  const tab = ui.detailTab || 'details', isBot = !!bot;
  const ownedRoutines = state.routines.filter(routine => isBot ? routine.botId === bot.id : routine.roomId === room?.id);
  const ownedWorks = state.works.filter(work => isBot ? work.botId === bot.id : work.roomId === room?.id);
  const selectedAvatar = ui.avatarEditing ? ui.avatarDraft || botAvatar(bot) : botAvatar(bot);
  let body = '';
  if (ui.avatarEditing && bot) body = renderAvatarPicker('edit');
  else if (tab === 'members' && !isBot) body = `<div class="profile-members">${(room?.members || []).filter(id => id !== 'user').map(id => `<button data-action="open-bot-details" data-id="${esc(id)}">${avatar(id, 50)}<span>${esc(nameOf(id))}</span></button>`).join('')}<button class="add-member" data-action="edit-room-members">${icon('plus', 24)}<span>添加成员</span></button></div>`;
  else if (tab === 'library') body = `<div class="profile-section-heading"><span>${isBot ? '记忆' : '共享知识'}</span><button class="icon-button" data-action="${isBot ? 'new-memory' : 'new-node'}" aria-label="${isBot ? '添加记忆' : '新增知识'}">${icon('plus', 20)}</button></div>${isBot ? ui.memories.map(memory => `<article class="profile-record"><p>${esc(memory.content)}</p><div class="item-meta">${esc(labels[memory.category] || '记忆')} · ${memory.status === 'expired' ? '已过期' : '有效'}<button class="text-button" data-action="edit-memory" data-id="${esc(memory.id)}">修订</button></div></article>`).join('') || '<p class="panel-empty">还没有记忆</p>' : ''}${(state.knowledge.nodes || []).map(node => `<button class="profile-record record-button" data-action="open-knowledge" data-id="${esc(node.id)}"><strong>${esc(node.title)}</strong><p>${esc(node.content?.slice(0, 150))}</p></button>`).join('') || (!isBot ? '<p class="panel-empty">还没有知识记录</p>' : '')}<button class="panel-footer-link" data-action="navigate" data-view="knowledge">查看全部知识 ${icon('arrow', 17)}</button>`;
  else if (tab === 'computer') body = `<div class="profile-section-heading"><span>Codex 工作</span><button class="icon-button" data-action="new-work" aria-label="委托工作">${icon('plus', 20)}</button></div>${ownedWorks.map(work => `<button class="profile-record record-button" data-action="open-work" data-id="${esc(work.id)}"><strong>${esc(work.goal)}</strong><div class="item-meta">${statusPill(work.status)}</div></button>`).join('') || '<p class="panel-empty">还没有委托工作</p>'}<button class="panel-footer-link" data-action="navigate" data-view="works">查看所有工作 ${icon('arrow', 17)}</button>`;
  else body = `${isBot ? `<button class="profile-description" data-action="edit-bot" data-id="${esc(bot.id)}"><span>${esc(bot.role || '项目协作')}</span>${icon('edit', 16)}</button>${bot.prompt ? `<p class="profile-prompt">${esc(bot.prompt)}</p>` : ''}${bot.skills?.length ? `<div class="tag-list">${bot.skills.map(skill => `<span class="tag">${esc(skill)}</span>`).join('')}</div>` : ''}` : `<button class="profile-description" data-action="edit-room"><span>${esc(room?.goal || '添加群聊说明')}</span>${icon('edit', 16)}</button>`}<div class="profile-section-heading"><span>例行任务</span><button class="icon-button" data-action="new-routine" aria-label="新增职责">${icon('plus', 20)}</button></div>${ownedRoutines.map(routine => `<div class="profile-routine"><button class="routine-text" data-action="edit-routine" data-id="${esc(routine.id)}"><strong>${esc(routine.name)}</strong><span>每 ${Math.round(routine.intervalSeconds / 60)} 分钟</span></button><button class="toggle ${routine.enabled ? 'on' : ''}" data-action="toggle-routine" data-id="${esc(routine.id)}" role="switch" aria-checked="${!!routine.enabled}" aria-label="${routine.enabled ? '暂停' : '启用'}${esc(routine.name)}"></button></div>`).join('') || '<p class="panel-empty">没有例行任务</p>'}<div class="profile-more-actions">${isBot ? `<button data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot 资料</button><button data-action="bot-contacts" data-id="${esc(bot.id)}">直连联系人</button><button data-action="toggle-bot" data-id="${esc(bot.id)}">${bot.status === 'paused' ? '恢复 Bot' : '暂停 Bot'}</button>` : `<button data-action="new-deep">发起深聊</button>${room?.kind === 'deep' && room.status !== 'concluded' ? '<button data-action="conclude-room">结束深聊并保留结论</button>' : ''}<button data-action="new-work">委托工作</button>`}</div>`;
  return `<aside class="detail-panel" data-section="${ui.avatarEditing ? `avatar:${ui.avatarTab}` : tab}:${bot?.id || room?.id}"><div class="detail-panel-inner"><div class="detail-panel-toolbar"><button class="round-button" data-action="copy-conversation" title="复制会话文字" aria-label="复制会话文字">${icon('copy', 21)}</button><button class="round-button" data-action="close-details" title="关闭详情" aria-label="关闭详情">${icon('close', 26)}</button></div><div class="profile-identity ${ui.avatarEditing ? 'editing-avatar' : ''}">${isBot ? `<button class="profile-avatar" data-action="edit-avatar" data-id="${esc(bot.id)}" aria-label="编辑头像" title="编辑头像">${face(selectedAvatar, 104, { key: 'slot:profile', identity: `bot:${bot.id}`, preview: true, intro: true })}<span class="avatar-pencil">${icon('edit', 23)}</span></button>` : groupAvatar(room, 104)}${!ui.avatarEditing ? `<h2>${esc(bot?.name || room?.name)}</h2>${isBot ? `<button class="profile-subtitle" data-action="edit-bot" data-id="${esc(bot.id)}">${esc(listText(bot.expertise) || '添加专业标签')}</button>` : ''}` : ''}</div>${!ui.avatarEditing ? `<nav class="profile-tabs" aria-label="详情分类">${[{ id: 'details', label: '详情' }, { id: 'library', label: '资料库' }, { id: isBot ? 'computer' : 'members', label: isBot ? '电脑' : '成员' }].map(item => `<button class="${tab === item.id ? 'active' : ''}" data-action="detail-tab" data-tab="${item.id}">${item.label}</button>`).join('')}</nav>` : ''}<div class="detail-panel-body" data-motion-key="detail-content">${body}</div></div></aside>`;
}
function renderAvatarPicker(mode = 'create') {
  const selected = window.RelayAvatars.normalize(ui.avatarDraft || botAvatar(profileBot())), tab = ui.avatarTab || 'bot';
  const save = mode === 'edit' ? avatarSaves.get(profileBot()?.id) : null;
  const saveStatus = save?.error ? `<div class="avatar-save-status error" role="status">头像尚未保存<button type="button" data-action="avatar-save-retry">重试</button><small>${esc(save.error)}</small></div>` : save && (save.running || save.savedVersion !== save.version) ? '<div class="avatar-save-status" role="status">正在保存…</div>' : mode === 'edit' ? '<div class="avatar-save-status" aria-hidden="true"></div>' : ''; 
  const picker = `<div class="shape-grid">${window.RelayAvatars.shapes.map(shape => `<button type="button" class="shape-choice ${selected.shape === shape.id && !selected.image ? 'selected' : ''}" data-action="avatar-shape" data-shape="${shape.id}" data-mode="${mode}" aria-label="${shape.label}" aria-pressed="${selected.shape === shape.id}">${face({ ...selected, shape: shape.id, image: null }, 52, { static: true })}<small>${shape.label}</small></button>`).join('')}</div><div class="crew-palettes">${window.RelayAvatars.templates.map(p => `<button type="button" data-action="avatar-template" data-template="${p.id}" data-mode="${mode}" title="${p.name}" aria-label="${p.name}" aria-pressed="${selected.color === p.color && selected.secondary === p.secondary}" style="background:linear-gradient(135deg,${p.color} 82%,${p.secondary} 82%)">${p.name}</button>`).join('')}</div><details class="crew-custom" ${ui.avatarCustomOpen ? 'open' : ''}><summary>自定义颜色</summary>${[['color','纸片颜色'],['secondary','衬纸颜色'],['ink','边线颜色'],['paper','眼睛留白']].map(([key,label])=>`<label>${label}<input type="color" data-avatar-custom="${key}" data-mode="${mode}" value="${selected[key]}"></label>`).join('')}</details>`;

  return `${saveStatus}<div class="avatar-picker ${mode === 'create' ? 'create-picker' : ''}">${mode === 'edit' ? `<div class="avatar-tabs">${[{ id: 'bot', label: 'Bot' }, { id: 'generate', label: '生成' }, { id: 'upload', label: '上传' }].map(item => `<button type="button" class="${tab === item.id ? 'active' : ''}" data-action="avatar-tab" data-tab="${item.id}">${item.label}</button>`).join('')}<button class="avatar-reset" type="button" data-action="avatar-reset">重置</button></div>` : ''}${mode === 'create' || tab === 'bot' ? picker : tab === 'generate' ? `<div class="avatar-tool"><p>随机组合造型与颜色</p><button class="secondary-button" data-action="avatar-random" type="button">${icon('spark', 18)}生成一个造型</button></div>` : `<div class="avatar-tool"><p>使用自己的图片</p><label class="upload-label" for="avatar-upload">${icon('upload', 23)}选择图片</label><input id="avatar-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden><small>PNG、JPG 或 WebP，将缩放后保存在本机</small></div>`}</div>`;
}
function openCreateBot() {
  window.RelayAvatars?.release('slot:create-preview');
  ui.avatarSelectionRevision++;
  ui.avatarEditing = false;
  ui.avatarCustomOpen = false;
  ui.avatarDraft = window.RelayAvatars.normalize({ shape: 'cercle',color:'#7D824B' });
  ui.menu = null; render();
  const modal = $('#modal'); captureMotion($('#modal-content')); modal.classList.add('create-bot-modal');
  $('#modal-content').innerHTML = `<div class="modal-header"><h2>创建新 Bot</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 24)}</button></div><form id="modal-form" class="create-bot-form"><div class="create-bot-body"><button type="button" id="create-avatar-preview" class="create-avatar-preview" data-action="avatar-greet" aria-label="和 Bot 打招呼">${face(ui.avatarDraft, 144, { key: 'slot:create-preview', identity: 'create-preview', preview: true, intro: true })}</button><input id="create-bot-name" name="name" placeholder="给你的 Bot 起个名字" aria-label="Bot 名字" required maxlength="100" autocomplete="off"><div class="create-picker-scroll"><div id="create-avatar-picker">${renderAvatarPicker('create')}</div><div class="form-error" role="alert"></div></div></div><div class="modal-footer"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button id="create-bot-submit" class="primary-button" type="submit" disabled>创建</button></div></form>`;
  $('#modal-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target, button = $('#create-bot-submit', form), name = $('#create-bot-name', form).value.trim(), avatar = { ...ui.avatarDraft }; if (!name) return;
    button.disabled = true; $('.form-error', event.target).textContent = '';
    try { const bot = await api('/api/bots', 'POST', { name, role: '项目协作', avatar }); const ownsDialog = modal.open && $('#modal-form') === form; if (ownsDialog) await closeModal(modal); const stillOwns = $('#modal-form') === form; if (ownsDialog && stillOwns) ui.avatarDraft = null; await refresh(); if (ownsDialog && stillOwns && $('#modal-form') === form) await act('dm-bot', { dataset: { id: bot.id } }); else toast(`${bot.name} 已创建`); }
    catch (error) { if (form.isConnected) $('.form-error', form).textContent = error.message; else toast(error.message, true); } finally { button.disabled = false; }
  };
  showModal(modal);
  if (!matchMedia('(pointer:coarse)').matches) $('#create-bot-name').focus({ preventScroll: true });
}
async function persistAvatar() {
  const bot = profileBot(); if (!bot) return;
  const botId = bot.id;
  let entry = avatarSaves.get(botId);
  if (!entry) { entry = { version: 0, savedVersion: 0, running: false, error: null, target: null }; avatarSaves.set(botId, entry); }
  entry.target = { ...ui.avatarDraft }; entry.version++; entry.error = null;
  bot.avatar = { ...entry.target }; render();
  if (entry.running) return entry.promise;
  entry.running = true;
  entry.promise = (async () => {
    while (entry.savedVersion !== entry.version) {
      const version = entry.version, target = { ...entry.target };
      try {
        const saved = await api(`/api/bots/${encodeURIComponent(botId)}`, 'PATCH', { avatar: target });
        entry.savedVersion = version;
        if (version === entry.version) {
          const current = botById(botId); if (current) Object.assign(current, saved);
          if (profileBot()?.id === botId && ui.avatarEditing) ui.avatarDraft = { ...saved.avatar };
        }
      } catch (error) {
        if (version !== entry.version) continue;
        entry.error = error.message; toast(`头像未保存：${error.message}`, true); break;
      }
    }
    entry.running = false;
    if (!entry.error && entry.savedVersion === entry.version) { entry.confirmedEpoch = ++avatarSaveEpoch; scheduleRefresh(); }
    render();
    return !entry.error;
  })();
  return entry.promise;
}
function updateAvatarPicker(mode) {
  if (mode === 'create') { const root = $('#modal-content'), motion = captureMotion(root); $('#create-avatar-preview').innerHTML = face(ui.avatarDraft, 144, { key: 'slot:create-preview', identity: 'create-preview', preview: true, intro: true }); $('#create-avatar-picker').innerHTML = renderAvatarPicker('create'); hydrateMotion(root, motion); }
  else return persistAvatar();
}
function openRoomEdit(membersOnly = false) {
  const room = roomById(ui.roomId); if (!room || room.kind === 'dm') return;
  openModal(membersOnly ? '群聊成员' : '群聊详情', '', `${!membersOnly ? `${field('群聊名称', 'name', room.name, { required: true })}${field('群聊说明', 'goal', room.goal || '', { type: 'textarea' })}` : ''}${memberChoices((room.members || []).filter(id => id !== 'user'))}`, async data => {
    const members = data.getAll('members'); if (!members.length) throw new Error('群聊至少需要一位 Bot。');
    await api(`/api/rooms/${encodeURIComponent(room.id)}`, 'PATCH', { members: room.members.includes('user') ? ['user', ...members] : members, ...(!membersOnly ? { name: data.get('name').trim(), goal: data.get('goal').trim() } : {}) }); toast('群聊已更新');
  });
}

document.addEventListener('change', async event => {
  if (event.target.id === 'message-target') { ui.draftTargets[event.target.form.dataset.roomId] = event.target.value; persistClientSession(); }
  if (event.target.dataset.avatarCustom) { const key = event.target.dataset.avatarCustom; if (!['color','secondary','ink','paper'].includes(key)) return; ui.avatarSelectionRevision++; ui.avatarDraft = { ...ui.avatarDraft, [key]: event.target.value, image: null }; if(event.target.dataset.mode === 'create') { const root = $('#create-avatar-preview'); root.innerHTML = face(ui.avatarDraft,144,{key:'slot:create-preview',preview:true}); hydrateMotion(root); } else await persistAvatar(); return; }
  if (event.target.id !== 'avatar-upload') return;
  const file = event.target.files?.[0], botId = profileBot()?.id;
  if (!file || !botId) return;
  const revision = ++ui.avatarSelectionRevision;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片。');
    const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取图片。')); reader.readAsDataURL(file); });
    const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('无法打开这张图片。')); image.src = source; });
    const canvas = document.createElement('canvas'), ratio = Math.min(1, 256 / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * ratio)); canvas.height = Math.max(1, Math.round(img.height * ratio));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL('image/png');
    if (image.length > 400000) throw new Error('这张图片缩放后仍然过大，请选择较小的图片。');
    if (profileBot()?.id !== botId || !ui.avatarEditing || revision !== ui.avatarSelectionRevision) return;
    ui.avatarDraft = { ...ui.avatarDraft, image }; if (await persistAvatar()) toast('头像已更新');
  } catch (error) { if (revision === ui.avatarSelectionRevision) toast(error.message, true); }
});

const initialView = location.hash.slice(1); if (tabs.some(tab => tab.id === initialView)) ui.view = initialView;
applyDisplayPreferences(); renderTopbar();
ui.cacheBootPromise = restoreCachedWorkspace();
ui.cacheBootPromise.then(() => refresh());
const stream = new EventSource('/api/stream');
stream.onopen = () => { const wasConnected = ui.streamConnected; ui.streamConnected = true; if (!wasConnected) scheduleRefresh(); };
stream.onmessage = () => scheduleRefresh();
stream.addEventListener('change', () => scheduleRefresh());
stream.addEventListener('state', () => scheduleRefresh());
stream.onerror = () => { ui.streamConnected = false; showConnection('实时连接已断开，正在自动重连。已显示的记录仍然保留。'); };
window.addEventListener('offline', () => { ui.streamConnected = false; persistClientSession(); showConnection('当前离线，草稿与未确认消息已保留；恢复网络后可重试发送。'); });
window.addEventListener('online', () => { showConnection('网络已恢复，正在同步最新状态…'); scheduleRefresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); else persistClientSession(); });



// Use the visible phone viewport without replacing controls or interrupting IME input.
function syncMobileViewport() {
  const viewport = window.visualViewport, root = document.documentElement;
  const standalone = matchMedia('(max-width:820px)').matches && isIosStandalone();
  root.classList.toggle('ios-standalone', standalone);
  if (!standalone) root.style.removeProperty('--standalone-vh');
  if (!matchMedia('(max-width:820px)').matches) {
    root.style.removeProperty('--mobile-vh'); root.style.removeProperty('--mobile-vtop'); root.style.removeProperty('--mobile-page-top'); root.classList.remove('keyboard-open'); return;
  }
  const messages = $('.messages'), atBottom = messages && (messages._relayChatScroll?.followBottom || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40);
  const zoom = Number(getComputedStyle(root).zoom) || 1;
  const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const units = readViewportUnits();
  // Root height is affected by our own layout. Use viewport units instead so
  // keyboard detection cannot toggle itself while the shell is being resized.
  const layoutHeight = Math.max(innerHeight, parseFloat(units.vh) || 0);
  // Scale removes pinch-zoom's reduction from keyboard detection; an input's
  // automatic zoom must not disable fitting a genuinely open keyboard.
  const keyboardOpen = editing && !!viewport && layoutHeight - viewport.height * viewport.scale > 100;
  if (standalone) {
    const largeHeight = parseFloat(units.vh), dynamicHeight = parseFloat(units.dvh), safeTop = parseFloat(units.safeTop);
    // Some installed iOS WebViews subtract the top inset from dvh while
    // still exposing that same inset to the page. Correct only that signature.
    // A system-reserved status bar reports safeTop=0 and must not be stretched.
    const shortened = Number.isFinite(largeHeight) && Number.isFinite(dynamicHeight) && Number.isFinite(safeTop)
      && dynamicHeight > 0 && safeTop > 0 && largeHeight > dynamicHeight && Math.abs(largeHeight - dynamicHeight - safeTop) <= 2;
    if (shortened) root.style.setProperty('--standalone-vh', `${100 / zoom}vh`);
    else root.style.removeProperty('--standalone-vh');
  }
  // A dismissed iOS keyboard can leave a stale visual viewport. Let CSS own
  // the full height unless an input is focused and the keyboard reduces it.
  if (keyboardOpen) {
    root.style.setProperty('--mobile-vh', `${viewport.height / zoom}px`);
    root.style.setProperty('--mobile-vtop', `${Math.max(0, viewport.offsetTop) / zoom}px`);
    const pageTop = Number.isFinite(viewport.pageTop) ? viewport.pageTop : window.scrollY + viewport.offsetTop;
    root.style.setProperty('--mobile-page-top', `${Math.max(0, pageTop) / zoom}px`);
  } else {
    root.style.removeProperty('--mobile-vh'); root.style.removeProperty('--mobile-vtop'); root.style.removeProperty('--mobile-page-top');
    // Only the inner panels scroll. Undo WebKit's document pan after dismissal.
    if ((!viewport || Math.abs(viewport.scale - 1) < .02) && window.scrollY) window.scrollTo(window.scrollX, 0);
  }
  root.classList.toggle('keyboard-open', keyboardOpen);
  if (atBottom) messages._relayChatScroll?.schedule();
}
let viewportFrame = 0;
function queueViewportSync() { cancelAnimationFrame(viewportFrame); viewportFrame = requestAnimationFrame(syncMobileViewport); }
window.visualViewport?.addEventListener('resize', queueViewportSync);
window.visualViewport?.addEventListener('scroll', queueViewportSync);
window.addEventListener('resize', queueViewportSync);
window.addEventListener('scroll', queueViewportSync, { passive: true });
window.addEventListener('pageshow', queueViewportSync);
window.addEventListener('orientationchange', queueViewportSync);
document.addEventListener('visibilitychange', () => { if (!document.hidden) queueViewportSync(); });
displayMedia.addEventListener('change', applyDisplayPreferences);
window.addEventListener('storage', event => { if (event.key === displayPreferenceKey || event.key === null) { displayPreferences = readDisplayPreferences(); displaySaved = true; applyDisplayPreferences(); } });
document.addEventListener('focusin', queueViewportSync);
document.addEventListener('focusout', () => {
  queueViewportSync();
  // iOS reports intermediate sizes during its keyboard dismissal animation.
  setTimeout(queueViewportSync, 120); setTimeout(queueViewportSync, 350);
});
window.addEventListener('relay:pwa-change', () => renderTopbar());
window.addEventListener('relay:pwa-before-update', event => { if (!preserveUpdateDrafts()) event.preventDefault(); });
window.addEventListener('pagehide', () => { persistClientSession(); if (updateDraftArmed) preserveUpdateDrafts(); });
syncMobileViewport();

document.addEventListener('toggle', event => { if(event.target.matches?.('.crew-custom')) ui.avatarCustomOpen = event.target.open; }, true);
