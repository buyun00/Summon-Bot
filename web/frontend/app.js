'use strict';

const $ = (selector, root = document) => {
  const first = root.querySelector(selector);
  return first?.closest('[data-motion-ghost]') ? [...root.querySelectorAll(selector)].find(node => !node.closest('[data-motion-ghost]')) || null : first;
};
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)].filter(node => !node.closest('[data-motion-ghost]'));
// Display preferences are local to this browser and independent for each layout.
const UI_BUILD = '2026.11.20';
const themePreferenceKey = 'summon:theme:v1';
const systemDarkMedia = matchMedia('(prefers-color-scheme: dark)');
let themePreference = (() => {
  try { const value = localStorage.getItem(themePreferenceKey); return ['system', 'light', 'dark'].includes(value) ? value : 'system'; }
  catch { return 'system'; }
})();
const isDarkTheme = () => themePreference === 'dark' || (themePreference === 'system' && systemDarkMedia.matches);
function applyTheme() {
  const dark = isDarkTheme();
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0b0c10' : '#f8f6f1');
  window.SummonDesktop?.setTheme?.(dark);
  for (const button of $$('[data-action="set-theme"]')) {
    const active = button.dataset.theme === themePreference;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}
function setThemePreference(mode) {
  if (!['system', 'light', 'dark'].includes(mode)) return;
  themePreference = mode;
  try { localStorage.setItem(themePreferenceKey, mode); } catch {}
  applyTheme();
}
systemDarkMedia.addEventListener('change', () => { if (themePreference === 'system') applyTheme(); });
applyTheme();
let displayDiagnosticSnapshot = null;
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
  return { build: UI_BUILD, userAgent: navigator.userAgent,
    heightStrategy: root.classList.contains('keyboard-open') ? 'visual-viewport' : 'dynamic-viewport',
    layoutHeight: rootStyle.getPropertyValue('--ui-vh').trim(),
    screen: { width: screen.width, height: screen.height },
    window: { width: innerWidth, height: innerHeight, scrollY }, rootHeight: root.clientHeight,
    viewport: viewport ? { height: viewport.height, offsetTop: viewport.offsetTop, scale: viewport.scale } : null,
    zoom: getComputedStyle(root).zoom, keyboard: root.classList.contains('keyboard-open'), units,
    shell: measure('.app-shell'), composer: measure('.composer'), composerWrap: measure('.composer-wrap') };
}
const displayPreferenceKey = 'summon:display-preferences:v4';
const displayDefaults = { desktop: { zoom: 100, font: 100 }, mobile: { zoom: 100, font: 100 } };
const displayBaseZoom = { desktop: 0.92, mobile: 1 };
function normalizeDisplayPreferences(value) {
  const limit = (number, fallback, min, max) => typeof number === 'number' && Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
  return Object.fromEntries(Object.entries(displayDefaults).map(([mode, fallback]) => [mode, {
    zoom: limit(value?.[mode]?.zoom, fallback.zoom, 50, 160),
    font: limit(value?.[mode]?.font, fallback.font, 90, 160),
  }]));
}
function readDisplayPreferences() {
  try {
    const saved = localStorage.getItem(displayPreferenceKey);
    if (saved) return normalizeDisplayPreferences(JSON.parse(saved));
    const previous = JSON.parse(localStorage.getItem('summon:display-preferences:v3'));
    // Rebase saved preferences once: the former 115% is now the desktop default.
    // Keep custom sizes, font choices and mobile settings; the former default adopts the new size.
    if (previous?.desktop && typeof previous.desktop.zoom === 'number') previous.desktop.zoom = previous.desktop.zoom === 100 ? 100 : Math.round(previous.desktop.zoom / 1.15);
    const migrated = normalizeDisplayPreferences(previous);
    localStorage.setItem(displayPreferenceKey, JSON.stringify(migrated));
    localStorage.removeItem('summon:display-preferences:v1');
    localStorage.removeItem('summon:display-preferences:v2');
    localStorage.removeItem('summon:display-preferences:v3');
    return migrated;
  }
  catch { return normalizeDisplayPreferences(null); }
}
const displayMedia = matchMedia('(max-width:640px) and (pointer:coarse)');
let displayPreferences = readDisplayPreferences();
let displaySaved = true;
const displayMode = () => window.SummonDesktop || !displayMedia.matches ? 'desktop' : 'mobile';
function applyDisplayPreferences() {
  const mode = displayMode(), root = document.documentElement, settings = displayPreferences[mode];
  const zoom = displayBaseZoom[mode] * settings.zoom / 100;
  const messages = $('.messages'), reading = captureChatScroll(messages);
  root.style.setProperty('--ui-zoom', zoom);
  root.style.setProperty('--ui-font-scale', settings.font / 100);
  root.style.setProperty('--ui-vh', `${100 / zoom}dvh`);
  root.style.setProperty('--ui-vw', `${100 / zoom}vw`);
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
  $('#modal-content').innerHTML = `<div class="display-settings"><div class="modal-header"><div><h2 id="display-device">显示设置</h2><p id="display-save-status"></p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 22)}</button></div><div class="display-settings-body"><div class="display-setting"><div class="display-setting-label"><span>外观材质</span></div><p>浅色采用暖棉纸片风，暗色切换磨砂类玻璃与扁平彩透头像。</p><div class="display-theme-bar" role="group" aria-label="外观材质"><button type="button" data-action="set-theme" data-theme="system">跟随系统</button><button type="button" data-action="set-theme" data-theme="light">☀ 浅色纸片</button><button type="button" data-action="set-theme" data-theme="dark">☾ 暗色玻璃</button></div></div><div class="display-setting"><div class="display-setting-label"><label for="display-zoom">页面缩放</label><output id="display-zoom-value" for="display-zoom"></output></div><p>一起调整头像、控件、间距与文字的大小。</p><input id="display-zoom" type="range" min="50" max="160" step="1" aria-label="页面缩放"><div class="display-presets"><button data-action="display-preset" data-zoom="85">紧凑 85%</button><button data-action="display-preset" data-zoom="100">默认 100%</button><button data-action="display-preset" data-zoom="115">宽松 115%</button></div></div><div class="display-setting"><div class="display-setting-label"><label for="display-font">文字大小</label><output id="display-font-value" for="display-font"></output></div><p>全站统一调整聊天、统计、管理页面及操作记录的文字大小。</p><input id="display-font" type="range" min="90" max="160" step="5" aria-label="文字大小"><div class="display-range-labels"><span>较小 90%</span><span>较大 160%</span></div></div><div class="display-text-preview"><strong>显示效果预览</strong><p>聊天内容、工具调用与操作结果</p><code>Bot 正在读取文件…</code><small class="display-build">界面版本：${UI_BUILD}</small><button class="text-button" data-action="copy-display-diagnostics">复制显示诊断</button></div></div><div class="modal-footer"><button class="secondary-button" data-action="display-reset">恢复默认</button><button class="primary-button" data-action="close-modal">完成</button></div></div>`;
  syncDisplaySettingsControls(); applyTheme(); showModal(modal);
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  people: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/><circle cx="9" cy="7" r="4"/>',
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
  panel: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M15 3v18"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M12 10v6M9 13h6"/>',
  eyeOff: '<path d="M17.94 17.94A10.1 10.1 0 0 1 12 19c-7 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="m1 1 22 22"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
};
const icon = (name, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
const labels = {
  queued:'待投递', pending:'待确认', sending:'传输中', submitted:'已提交', accepted:'已受理', received:'Bot 已接收',
  processed:'本轮已处理', running:'正在运行', waiting:'等待结果', needs_input:'待输入', completed:'执行已结束', failed:'失败',
  cancelled:'已取消', interrupted:'已中断', active:'启用', idle:'空闲', paused:'已暂停', stopping:'停止中',
  stopped:'已停止', unknown:'状态未知', reception_unknown:'接收情况未知', unsupported:'连接不支持', limited:'达到资源限额',
  revoked:'访问已撤销', access_revoked:'访问已撤销', retry:'等待重试', suspended:'运行已挂起', not_submitted:'未提交',
};
const tabs = [
  { id:'chat', title:'消息', icon:'chat' }, { id:'members', title:'成员', icon:'people' },
  { id:'executions', title:'执行会话', icon:'computer' }, { id:'files', title:'资料', icon:'knowledge' },
  { id:'wakeups', title:'订阅与提醒', icon:'clock' }, { id:'connections', title:'执行连接', icon:'link' },
  { id:'models', title:'模型与用量', icon:'computer' }, { id:'usage', title:'Token 统计', icon:'layers' },
];
const protocolVersion = 3;
const state = { bots: [], rooms: [], executions: [], files: [], wakeups: [], connections: [], workspaces: [] };
const resourceLabels = {
  sessions:'会话数量', models:'并发模型请求', external:'并发外部执行', queue:'待处理事件',
  reserved_calls:'回执记录', period_ms:'统计周期（毫秒）', calls:'调用数', tokens:'Token', active_ms:'累计活跃时间（毫秒）',
};
const ui = {
  view:'chat', roomId:null, botId:null, executionRef:null, executionDetail:null, fileId:null, fileDetail:null,
  messages:[], roomDeliveries:new Map(), roomSummaries:new Map(), mobileRoom:false, reply:null, drafts:{}, draftTargets:{}, draftAttachments:{},
  draftReferences:{}, localMessages:{}, loading:true, refreshing:false, streamConnected:false, connectionNotice:'',
  detailOpen:false, detailTab:'details', profileBotId:null, avatarEditing:false, avatarDraft:null, avatarTab:'bot',
  avatarSelectionRevision:0, searchOpen:false, roomQuery:'', menu:null, sendingRooms:new Set(), navigationSeq:0,
  messageCache:new Map(), roomReadSeq:{}, executionInputs:new Map(), loadingExecutions:new Map(),
  historyEpoch:null, historyGeneration:0, retiredHistoryEpochs:new Set(),
};
const attachmentLimit = 8, attachmentMaxBytes = 20 * 1024 * 1024;
const attachmentDrafts = (roomId = ui.roomId) => ui.draftAttachments[roomId] || [];
const attachmentBusy = (roomId = ui.roomId) => attachmentDrafts(roomId).some(item => item.status !== 'ready');
const sendBusy = (roomId = ui.roomId) => !ui.protocolReady || ui.sendingRooms.has(roomId) || attachmentBusy(roomId);
function attachmentSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function attachmentUrl(item, preview = false) {
  const path = preview ? item?.previewUrl : item?.url;
  if (typeof path === 'string' && /^\/api\/attachments\/[a-z0-9-]+(?:\/preview)?$/i.test(path)) return path;
  return '';
}
function renderMessageAttachments(items = []) {
  if (!items.length) return '';
  const cards = items.map(item => {
    const url = attachmentUrl(item), thumbnail = attachmentUrl(item, true), name = item.name || item.id;
    const title = '<span><strong>' + esc(name) + '</strong><small>' + (item.size == null ? '' : attachmentSize(item.size)) + '</small></span>';
    if (item.unavailable) return '<span class="message-attachment">' + icon('file', 24) + '<span>' + esc(name) + ' · 文件不可用</span></span>';
    if (!url) return '<button type="button" class="message-attachment" data-action="open-file" data-id="' + esc(item.id) + '">' + icon('file', 24) + title + '</button>';
    const view = typeof item.openUrl === 'string' && /^\/api\/attachments\/[a-z0-9-]+\/view$/i.test(item.openUrl) ? item.openUrl : '';
    if (thumbnail) {
      return '<div><button type="button" class="message-attachment has-image" data-action="preview-image" data-src="' + esc(thumbnail) + '" data-download="' + esc(url) + '" data-name="' + esc(name) + '">' +
        '<img src="' + esc(thumbnail) + '" alt="' + esc(name) + '" loading="lazy">' + title + '</button></div>';
    }
    return '<div><a class="message-attachment" href="' + esc(url) + '" download="' + esc(name) + '">' +
      icon('file', 24) + title + '</a>' +
      (view ? '<a class="text-button" href="' + esc(view) + '" target="_blank" rel="noopener noreferrer">打开预览</a>' : '') + '</div>';
  });
  return '<div class="message-attachments">' + cards.join('') + '</div>';
}
function renderAttachmentDrafts() {
  const items = attachmentDrafts();
  if (!items.length) return '';
  return `<div class="attachment-drafts" aria-label="待发送附件">${items.map(item => {
    const preview = item.preview || attachmentUrl(item.attachment, true);
    const status = { uploading:'正在上传…', staged:'已在本机暂存', error:item.error }[item.status] ?? attachmentSize(item.size);
    const canUpload = item.file && ['error','staged'].includes(item.status);
    return `<div class="attachment-draft ${item.status === 'error' ? 'attachment-error' : ''}">
      ${preview ? `<img src="${esc(preview)}" alt="">` : icon('file', 26)}
      <span class="attachment-draft-copy"><strong>${esc(item.name)}</strong><small role="status">${esc(status)}</small></span>
      ${canUpload ? `<button type="button" class="icon-button" data-action="retry-attachment" data-id="${esc(item.key)}"
        aria-label="上传 ${esc(item.name)}" ${ui.protocolReady ? '' : 'disabled'}>${icon('upload', 18)}</button>` : ''}
      <button type="button" class="icon-button" data-action="remove-attachment" data-id="${esc(item.key)}"
        aria-label="移除附件 ${esc(item.name)}" ${ui.sendingRooms.has(ui.roomId) ? 'disabled' : ''}>${icon('close', 18)}</button></div>`;
  }).join('')}</div>`;
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
  if (!roomById(roomId)) return;
  const items = ui.draftAttachments[roomId] ||= [], added = [];
  for (const file of files) {
    if (items.length >= attachmentLimit) { toast('每条消息最多添加 8 个附件。', true); break; }
    if (file.size > attachmentMaxBytes) { toast(`${file.name} 超过 20 MB，请选择小一些的文件。`, true); continue; }
    const item = { key: newClientId(), file, name: file.name, size: file.size, status: 'staged',
      preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : '' };
    items.push(item); added.push(item);
  }
  render();
  void persistClientSession();
  for (const item of added) if (ui.protocolReady && attachmentDrafts(roomId).includes(item)) await uploadAttachment(roomId, item);
}
async function uploadAttachment(roomId, item) {
  item.status = 'uploading'; item.error = ''; render();
  try {
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('文件读取失败，请重新选择。')); reader.readAsDataURL(item.file);
    });
    const attachment = await api('/api/attachments', 'POST', { name: item.name, mimeType: item.file.type || 'application/octet-stream', data }, { clientId:item.key });
    if (!attachmentUrl(attachment)) throw new Error('附件上传未完成，请重试。');
    item.attachment = attachment; item.status = 'ready'; delete item.file;
  } catch (error) { item.status = 'error'; item.error = error.message; }
  persistClientSession();
  if (ui.roomId === roomId) render();
}
function removeAttachment(key) {
  if (ui.sendingRooms.has(ui.roomId)) return;
  const items = attachmentDrafts(), item = items.find(item => item.key === key);
  if (item?.preview) URL.revokeObjectURL(item.preview);
  ui.draftAttachments[ui.roomId] = items.filter(item => item.key !== key); render();
}
const updateDraftKey = 'summon:update-drafts';

function localRoomMessages(roomId) { return Object.values(ui.localMessages[roomId] || {}); }
function reconcileRoomMessages(roomId, remote) {
  const confirmed = new Set(remote.filter(item => item.senderId === 'user' && item.clientId).map(item => item.clientId));
  for (const entry of localRoomMessages(roomId)) if (confirmed.has(entry.clientId)) delete ui.localMessages[roomId][entry.clientId];
}
function mergedRoomMessages(roomId, remote = []) {
  const known = new Set(remote.map(item => item.id));
  return remote.concat(localRoomMessages(roomId).filter(entry => !known.has(entry.message.id)).map(entry => ({
    ...entry.message, _delivery: entry.status === 'saved' ? null : entry.status, _retryId: entry.clientId, _sendError: entry.error,
  })));
}
function renderSendStatus(message) {
  if (!message._delivery) return '';
  if (message._delivery === 'sending') return '<div class="message-delivery" role="status">正在发送…</div>';
  const rejected = message._delivery === 'rejected';
  return `<div class="message-delivery failed" role="status"><span>${esc(message._sendError || '尚未确认消息是否保存')}</span>
    <button class="text-button" data-action="${rejected ? 'restore-message-draft' : 'retry-message'}" data-id="${esc(message._retryId)}"
      ${!rejected && (!ui.protocolReady || ui.sendingRooms.has(message.roomId)) ? 'disabled' : ''}>${rejected ? '转回草稿' : '查询并重试'}</button></div>`;
}
function queueLocalMessage(roomId, payload, attachments) {
  const clientId = newClientId(), entries = ui.localMessages[roomId] ||= {};
  const message = { content: payload.text, references: payload.references, mentions: payload.mentions, replyTo: payload.reply_to?.id,
    attachments: attachments.map(item => item.attachment), id: 'local-' + clientId, clientId, roomId, senderId: 'user', createdAt: new Date().toISOString() };
  return entries[clientId] = { roomId, clientId, payload, message, status: 'queued' };
}
async function sendLocalMessage(entry, scrollToEnd = false) {
  if (!entry || entry.status === 'saved' || !ui.protocolReady || ui.sendingRooms.has(entry.roomId)) return;
  const retry = entry.status !== 'queued';
  ui.sendingRooms.add(entry.roomId); entry.status = 'sending'; entry.error = '';
  render();
  if (scrollToEnd && ui.roomId === entry.roomId) $('.messages')?._summonChatScroll?.toBottom(true);
  try {
    await persistClientSession();
    const path = roomPath(entry.roomId) + '/messages';
    let receipt;
    if (retry) {
      try { receipt = await api(path + '/receipt?clientId=' + encodeURIComponent(entry.clientId)); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    if (!receipt) {
      try { receipt = await api(path, 'POST', { ...entry.payload, clientId: entry.clientId }); }
      catch (error) {
        error.messageRejected = [400,413,415,422].includes(error.status);
        throw error;
      }
    }
    const message = receipt.message;
    if (!message?.id || message.clientId !== entry.clientId || message.roomId !== entry.roomId || message.senderId !== 'user') throw new Error('服务器回执不完整');
    entry.message = message; entry.status = 'saved';
    if (ui.roomId === entry.roomId && Array.isArray(receipt.deliveries)) ui.roomDeliveries.set(message.id, receipt.deliveries);
  } catch (error) {
    if (ui.localMessages[entry.roomId]?.[entry.clientId] === entry) {
      entry.status = error.messageRejected ? 'rejected' : 'unconfirmed';
      entry.error = entry.status === 'rejected' ? '服务器未受理。' + error.message : error.message;
    }
  } finally {
    ui.sendingRooms.delete(entry.roomId);
    render(); scheduleRefresh();
  }
}

let refreshTimer, syncRetryAt = 0, syncRetryDelay = 0;
const avatarSaves = new Map();
let avatarSaveEpoch = 0;
ui.avatarSelectionRevision = 0;
function captureMotion(root) { return window.SummonMotion?.capture(root) || (window.SummonAvatars?.capture?.(root), null); }
function hydrateMotion(root, before) { if (window.SummonMotion) window.SummonMotion.hydrate(root, before || undefined); else window.SummonAvatars?.hydrate?.(root); }
function showModal(modal) { if (window.SummonMotion) window.SummonMotion.openDialog(modal); else { if (!modal.open) modal.showModal(); window.SummonAvatars?.hydrate?.(modal); } }
async function closeModal(modal = $('#modal')) { if (window.SummonMotion) await window.SummonMotion.closeDialog(modal); else modal.close(); }
const renderSignature = html => html.replace(/summon-avatar-clip-\d+/g, 'summon-avatar-clip').replace(/crew-\d+/g, 'crew-id').replace(/paper-avatar-\d+/g,'paper-avatar-id');


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
function nameOf(id) { return id === 'user' ? ownerName() : botById(id)?.name || (['system', 'platform'].includes(id) ? 'Summon 平台' : id || 'Summon 平台'); }
function statusPill(value) { return `<span class="status ${esc(value)}">${esc(labels[value] || value || '未知')}</span>`; }
function renderPageNavBar(activeView = ui.view) {
  const shortTitles = { members:'成员', executions:'执行', files:'资料', wakeups:'订阅', connections:'连接', models:'模型', usage:'用量' };
  return `<nav class="page-nav-bar" aria-label="页面导航"><div class="page-nav-left"><button type="button" class="float-pill-btn" data-action="navigate" data-view="chat">${icon('back', 15)}<span>聊天</span></button><div class="page-nav-tabs">${tabs.filter(tab => tab.id !== 'chat').map(tab => `<button type="button" class="${activeView === tab.id ? 'active' : ''}" data-action="navigate" data-view="${tab.id}">${shortTitles[tab.id] || tab.title}</button>`).join('')}</div></div></nav>`;
}
window.SummonPageNav = renderPageNavBar;
function pageHeader(buttons = '') { return `${renderPageNavBar()}<div class="page-header"><div><h1>${esc(tabs.find(tab => tab.id === ui.view)?.title)}</h1></div><div class="page-tools">${buttons}</div></div>`; }
function toast(message, error = false) {
  if ($$('.toast').some(node => node.textContent === message)) return;
  const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message; $('#toasts').append(node);
  while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
  setTimeout(() => node.remove(), error ? 10000 : 4000);
}
async function readSyncBody(response, progress) {
  if (!response.body) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder(), chunks = [];
  const paged = response.headers.get('content-type')?.includes('application/x-ndjson');
  let line = '', data, payload, ended = false;
  const frame = value => {
    const part = JSON.parse(value);
    if (ended) throw new SyntaxError('Unexpected page after sync cursor');
    if (!data) {
      if (!part.header?.sync?.cursor || !['snapshot', 'patch'].includes(part.field)) throw new SyntaxError('Missing sync header');
      payload = {}; data = { ...part.header, [part.field]: payload }; return;
    }
    if (part.end) {
      if (part.end !== data.sync.cursor) throw new SyntaxError('Sync cursor changed during read');
      ended = true; return;
    }
    if (!Array.isArray(part.path) || !part.path.length || part.path.some(key =>
      typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new SyntaxError('Invalid sync page');
    const key = part.path.at(-1);
    const parent = part.path.slice(0, -1).reduce((item, child) => item[child] ||= {}, payload);
    if (Array.isArray(part.append)) (parent[key] ||= []).push(...part.append);
    else parent[key] = part.value;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      progress();
      const text = decoder.decode(value, { stream: true });
      if (!paged) { chunks.push(text); continue; }
      const lines = (line + text).split('\n');
      line = lines.pop();
      for (const value of lines) if (value) frame(value);
    }
    const tail = decoder.decode();
    if (!paged) { chunks.push(tail); return JSON.parse(chunks.join('')); }
    if ((line + tail).trim() || !ended) throw new SyntaxError('Incomplete sync snapshot');
    return data;
  } finally { reader.releaseLock(); }
}
async function api(path, method = 'GET', body, { sync = false, clientId } = {}) {
  const bootstrap = path === '/api/bootstrap';
  if (!bootstrap && !ui.protocolReady) throw new Error(ui.protocolNotice || '正在连接 Summon');
  for (let attempt = 0; ; attempt++) {
    let response, data;
    const controller = new AbortController();
    let timer;
    const deadline = ms => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException('Read timed out', 'TimeoutError')), ms);
    };
    try {
      deadline(sync ? 90000 : method === 'GET' ? 60000 : 120000);
      const headers = bootstrap ? {} : { 'X-Summon-Protocol': String(protocolVersion) };
      if (clientId) headers['X-Summon-Client-Id'] = clientId;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      if (response.status === 401) { location.reload(); throw new Error('请重新输入访问 Token'); }
      if (sync) { deadline(90000); data = await readSyncBody(response, () => deadline(90000)); }
      else data = await response.json();
    } catch (error) {
      const timedOut = controller.signal.reason?.name === 'TimeoutError' || /Timeout|Abort/.test(error.name);
      controller.abort();
      const transportFailure = ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'].includes(error.name);
      console.warn('Summon response could not be read', {path:path.split('?')[0],status:response?.status,errorType:error.name,attempt});
      // Snapshot retries are scheduled separately using the last applied cursor.
      if (!sync && method === 'GET' && attempt === 0 && transportFailure && (!response || response.ok)) continue;
      if (!transportFailure) throw error;
      throw new Error(`${timedOut ? '同步超时' : error.name === 'TypeError' ? '响应传输未完成' : '响应内容无法读取'}${response ? `（${response.status}）` : ''}，请重新连接`);
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      const code = data.code ?? data.error?.code;
      if (response.status === 426) setProtocol(false, protocolMessage(code, data));
      if (code === 'updating') showConnection(ui.protocolNotice = protocolMessage(code, data));
      throw Object.assign(new Error(data.error?.message || data.error || `请求失败（${response.status}）`), { code, status: response.status, details: data.details });
    }
    return data;
  }
}
function showConnection(message = '') {
  const banner = $('#connection-banner');
  banner.hidden = !message;
  $('#connection-message', banner).textContent = message;
  $('[data-protocol-download]', banner).hidden = !ui.protocolNotice || navigator.onLine === false;
  ui.connectionNotice = message;
  renderTopbar();
}
function captureChatScroll(messages) {
  if (!messages) return null;
  const top = messages.getBoundingClientRect().top;
  const item = [...messages.querySelectorAll('[data-message-id],[data-agent-run-id]')].find(node => node.getBoundingClientRect().bottom > top);
  const visible = messages.clientHeight > 0, tracking = messages._summonChatScroll;
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
  if (messages._summonChatScroll) {
    messages._summonChatScroll.followBottom = followBottom;
    messages._summonChatScroll.lastTop = messages.scrollTop;
    messages._summonChatScroll.schedule();
    return;
  }
  let frame = 0, scrollFrom = 0, scrollStarted = 0, pointerY = null, draggingScrollbar = false, resizing = false;
  const tracking = { followBottom, lastTop: messages.scrollTop, stopped: false };
  const pinToBottomSync = () => {
    if (tracking.stopped || !messages.isConnected || !messages.clientHeight || !tracking.followBottom || scrollStarted) return;
    const end = Math.max(0, messages.scrollHeight - messages.clientHeight);
    if (Math.abs(end - messages.scrollTop) <= 1) return;
    resizing = true;
    messages.scrollTop = end;
    tracking.lastTop = end;
    resizing = false;
  };
  const schedule = () => {
    if (tracking.stopped || !tracking.followBottom) return;
    if (!scrollStarted) {
      pinToBottomSync();
      return;
    }
    if (frame) return;
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
    if (resizing) return;
    const top = messages.scrollTop;
    const distance = messages.scrollHeight - top - messages.clientHeight;
    if (distance < 36) tracking.followBottom = true;
    else if (!scrollStarted && (draggingScrollbar || top < tracking.lastTop - 2)) tracking.followBottom = false;
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
  // Adjust scrollTop synchronously inside ResizeObserver (before Paint) to prevent 1-frame vertical bounce during window resize.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(pinToBottomSync) : null;
  observer?.observe(messages);
  const composer = messages.parentElement.querySelector('.composer-wrap');
  if (composer) observer?.observe(composer);
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
    delete messages._summonChatScroll;
  };
  messages._summonChatScroll = tracking;
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
  const main = $('#main-content'), active = document.activeElement;
  return { key:main.dataset.viewKey, chatReady:$('.chat-layout')?.dataset.ready === 'true', panelTop:$('.detail-panel')?.scrollTop,
    panelSection:$('.detail-panel')?.dataset.section, top:main.scrollTop, chatScroll:captureChatScroll($('.messages')),
    focusId:active?.id, start:active?.selectionStart, end:active?.selectionEnd };
}
function render() {
  persistClientSession();
  if (ui.composing && document.activeElement?.id === 'message-input' && document.activeElement.form?.dataset.roomId === ui.roomId) { ui.renderDeferred = true; return; }
  ui.renderDeferred = false;
  const saved = preserveView();
  const navigation = window.SummonMotion?.captureNavigation(ui.view === 'chat' ? (ui.mobileRoom ? 'chat:' + ui.roomId : 'list') : ui.view);
  renderTopbar();
  const views = { chat:renderChat, members:renderMembers, executions:renderExecutions, files:renderFiles, wakeups:renderWakeups, connections:renderConnections,
    models:() => globalThis.SummonModels.render({ esc, icon }), usage:() => globalThis.SummonUsage.render({ esc, icon }) };
  const key = ui.view + ':' + ({ chat:ui.roomId, members:ui.botId, executions:refKey(ui.executionRef), files:ui.fileId }[ui.view] || '');
  const main = $('#main-content'), html = views[ui.view](), signature = renderSignature(html);
  const restoreConversation = () => restoreConversationScroll($('.messages'), saved.chatScroll, { sameView:saved.key === key, ready:ui.messagesRoomId === ui.roomId, wasReady:saved.chatReady });
  if (ui.lastMainHtml !== signature || main.dataset.viewKey !== key) {
    const motion = captureMotion(main);
    $('.messages')?._summonChatScroll?.stop();
    main.innerHTML = html; ui.lastMainHtml = signature; main.dataset.viewKey = key; main.scrollTop = saved.top;
    resizeComposer($('#message-input')); hydrateMotion(main, motion);
    const panel = $('.detail-panel'); if (panel && panel.dataset.section === saved.panelSection) panel.scrollTop = saved.panelTop || 0;
  }
  restoreFocus(saved); restoreConversation(); markCurrentRoomRead();
  window.SummonMotion?.finishNavigation(navigation);
}
function restoreFocus(saved) { if (!saved.focusId) return; const target = document.getElementById(saved.focusId); if (target) { target.focus({ preventScroll: true }); if (saved.start != null && target.setSelectionRange && !['number','email','file'].includes(target.type)) target.setSelectionRange(saved.start, saved.end); } }
function updateComposerButton(input) {
  const button = input?.form?.querySelector('.composer-send');
  if (!button) return;
  const hasContent = Boolean(input.value.trim() || attachmentDrafts(input.form.dataset.roomId).length || ui.draftReferences[input.form.dataset.roomId]?.length);
  const label = '发送消息';
  button.innerHTML = icon('send', 22);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = sendBusy(input.form.dataset.roomId) || !hasContent;
}
function resizeComposer(input) { if (!input) return; updateComposerButton(input); input.style.height = 'auto'; const height = input.scrollHeight, limit = parseFloat(getComputedStyle(input).maxHeight) || 150; input.style.height = `${Math.min(limit, height)}px`; input.style.overflowY = height > limit ? 'auto' : 'hidden'; }

const newClientId = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const roomPath = id => '/api/rooms/' + encodeURIComponent(id);
const refKey = ref => ref && JSON.stringify([ref.kind, ref.id]);
const sameRef = (left, right) => !!left && !!right && left.kind === right.kind && left.id === right.id;
const executionPath = ref => '/api/executions/' + encodeURIComponent(ref.kind) + '/' + encodeURIComponent(ref.id);
const filePath = id => '/api/files/' + encodeURIComponent(id);
let stream = null;

function protocolMessage(code, data) {
  if (code === 'updating' || data.updating) return 'Summon 正在更新。草稿和待确认的发送已保留。';
  const expected = Number(data.protocolVersion ?? data.details?.protocolVersion);
  if (expected > protocolVersion) return '此页面需要更新。刷新页面后可继续操作，草稿会保留。';
  return '等待服务器升级到此客户端所需的协议。草稿和待确认的发送已保留。';
}

function setProtocol(ready, notice = '') {
  ui.protocolReady = ready;
  ui.protocolNotice = notice;
  if (!ready) { stream?.close(); stream = null; ui.streamConnected = false; }
  showConnection(notice);
  if (!ui.loading) render();
}

async function handshake() {
  let startup;
  try { startup = await api('/api/bootstrap'); }
  catch (error) {
    if (error.status !== 404) throw error;
    setProtocol(false, protocolMessage('protocol_mismatch', {}));
    return false;
  }
  ui.releasesUrl = startup.releasesUrl;
  if (startup.protocolVersion !== protocolVersion) {
    setProtocol(false, protocolMessage('protocol_mismatch', startup));
    return false;
  }
  ui.protocolReady = true;
  ui.protocolNotice = startup.updating ? protocolMessage('updating', startup) : '';
  if (!stream) {
    stream = new EventSource('/api/stream?protocol=' + protocolVersion);
    stream.onopen = () => { ui.streamConnected = true; scheduleRefresh(); };
    stream.onmessage = scheduleRefresh;
    for (const type of ['change', 'state', 'message', 'room', 'delivery', 'execution']) stream.addEventListener(type, scheduleRefresh);
    stream.onerror = () => { ui.streamConnected = false; scheduleRefresh(); };
  }
  return true;
}

function scheduleRefresh() {
  if (refreshTimer || !navigator.onLine) return;
  refreshTimer = setTimeout(() => { refreshTimer = null; void refresh(); }, Math.max(230, syncRetryAt - Date.now()));
}

async function refresh(force = false) {
  if (ui.refreshing) { ui.refreshAgain = true; return; }
  ui.refreshing = true;
  try {
    if (!await handshake()) {
      ui.loading = false;
      syncRetryAt = Date.now() + 3000;
      render();
      return;
    }
    if (force) ui.stateCursor = null;
    const synced = await requestSyncedSnapshot('/api/state', { snapshot:ui.stateSnapshot, cursor:ui.stateCursor });
    if (!synced) return;
    ui.stateSnapshot = synced.snapshot; ui.stateCursor = synced.cursor;
    Object.assign(state, synced.snapshot);
    globalThis.SummonModels.sync(state.modelSettings);
    globalThis.SummonModels.bind({ api,render,toast,refresh });
    void globalThis.SummonCache?.writeState(synced);
    if (!roomById(ui.roomId)) {
      ui.roomId = state.rooms.find(room => room.members.includes('user'))?.id ?? null;
      ui.reply = null;
      await restoreRoomMessages(ui.roomId);
    }
    if (!botById(ui.botId)) ui.botId = state.bots[0]?.id ?? null;
    const visibleRooms = new Set(state.rooms.map(room => room.id));
    for (const id of ui.messageCache.keys()) if (!visibleRooms.has(id)) {
      ui.messageCache.delete(id);
      void globalThis.SummonCache?.removeRoom(id);
    }
    ui.loading = false;
    render();
    await loadCurrent();
    syncRetryAt = syncRetryDelay = 0;
    showConnection(ui.protocolNotice || (ui.streamConnected ? '' : '正在同步会话'));
    render();
  } catch (error) {
    syncRetryDelay = Math.min(30000, syncRetryDelay ? syncRetryDelay * 2 : 2000);
    syncRetryAt = Date.now() + syncRetryDelay;
    ui.loading = false;
    showConnection(ui.protocolNotice || '暂时无法同步。' + error.message);
    render();
  } finally {
    ui.refreshing = false;
    if (ui.refreshAgain || !ui.streamConnected) { ui.refreshAgain = false; scheduleRefresh(); }
  }
}

async function loadCurrent() {
  const nav = ui.navigationSeq;
  const current = () => nav === ui.navigationSeq;
  if (!ui.protocolReady) return;
  if (ui.view === 'models') return globalThis.SummonModels.load(api, render, toast, refresh);
  if (ui.view === 'usage') return globalThis.SummonUsage.load(api);
  if (ui.view === 'executions') {
    const page = await api('/api/executions');
    if (!current()) return;
    setListPage('executions', page);
    if (ui.executionRef) await loadExecution(ui.executionRef);
    return;
  }
  if (ui.view === 'files') {
    const page = await api('/api/files');
    if (!current()) return;
    setListPage('files', page);
    if (ui.fileId) {
      try { await loadFile(ui.fileId); }
      catch (error) {
        if (error.status !== 404 && error.status !== 403) throw error;
        ui.fileDetail = null; ui.fileId = null;
        toast('此文件已不可读取。',true);
      }
    }
    return;
  }
  if (ui.view === 'wakeups') {
    const page = await api('/api/wakeups');
    if (current()) setListPage('wakeups', page);
    return;
  }
  if (ui.view === 'connections') {
    const first = await api('/api/connections');
    if (!current()) return;
    Object.assign(state, { connections:first.items, limits:first.limits, limitsRevision:first.limits_revision, resourceUsage:first.usage });
    const [connections, workspaces] = await Promise.allSettled([readList('/api/connections',first),readList('/api/workspaces')]);
    if (current()) {
      if (connections.status === 'fulfilled') state.connections = connections.value;
      if (workspaces.status === 'fulfilled') state.workspaces = workspaces.value;
    }
    return;
  }
  if (ui.view !== 'chat' || !ui.roomId) return;
  const id = ui.roomId, request = ui.roomReadSeq[id] = (ui.roomReadSeq[id] || 0) + 1;
  const baseline = ui.messageCache.get(id);
  const synced = await requestSyncedSnapshot(roomPath(id) + '/messages', baseline);
  if (!synced || request !== ui.roomReadSeq[id] || !roomById(id)) return;
  const { messages, deliveries, summaries = {}, room, cursor } = synced.snapshot;
  const earlier = (baseline?.earlier || []).filter(item => !messages.some(message => message.id === item.id));
  const cached = { ...synced, earlier, historyCursor: baseline?.earlier ? baseline.historyCursor : cursor, messages: [...earlier, ...messages] };
  ui.messageCache.set(id, cached);
  void globalThis.SummonCache?.writeRoom(id, synced);
  reconcileRoomMessages(id, messages);
  if (ui.roomId !== id) return;
  ui.messagesRoomId = id; ui.messages = cached.messages; ui.historyCursor = cached.historyCursor;
  ui.roomDeliveries = new Map([...ui.roomDeliveries, ...Object.entries(deliveries || {})]);
  ui.roomSummaries = new Map([...ui.roomSummaries, ...Object.entries(summaries || {})]);
  const index = state.rooms.findIndex(item => item.id === id);
  if (room && room.revision >= state.rooms[index].revision) state.rooms[index] = room;
  const roomRef = encodeURIComponent(id);
  const roomDetails = [
    readList('/api/executions?room=' + roomRef).then(items => { if (ui.roomId === id && current()) ui.roomExecutions = items; }),
  ];
  if (ui.detailOpen && !ui.profileBotId && ui.detailTab === 'details') {
    roomDetails.push(readList('/api/wakeups').then(items => {
      if (ui.roomId !== id || !current()) return;
      ui.roomWakeups = items.filter(item => room.members.includes(item.bot_id) && (item.rule.room === id ||
        item.rule.scope?.kind === 'room' && item.rule.scope.id === id || item.rule.kind === 'event' && !item.rule.room &&
        (!item.rule.ref || item.rule.ref.kind !== 'room' || item.rule.ref.id === id)));
    }));
  }
  if (ui.detailOpen && ui.detailTab === 'library') {
    const bot = profileBot();
    const scope = bot ? 'bot=' + encodeURIComponent(bot.id) : 'room=' + roomRef;
    roomDetails.push(readList('/api/files?' + scope).then(items => { if (ui.roomId === id && current()) ui.roomFiles = items; }));
  }
  await Promise.all(roomDetails);
}

async function loadOlderMessages() {
  const id = ui.roomId, baseline = ui.messageCache.get(id);
  if (!baseline?.historyCursor) return;
  const response = await api(roomPath(id) + '/messages?cursor=' + encodeURIComponent(baseline.historyCursor));
  if (response.historyEpoch !== ui.historyEpoch || response.historyEpoch !== baseline.snapshot.historyEpoch) {
    scheduleRefresh();
    return;
  }
  const current = ui.messageCache.get(id);
  if (!current || !roomById(id) || current.historyCursor !== baseline.historyCursor) return;
  const seen = new Set(current.messages.map(message => message.id));
  const older = response.messages.filter(message => !seen.has(message.id));
  current.earlier = [...older, ...(current.earlier || [])]; current.messages = [...older, ...current.messages];
  current.historyCursor = response.cursor;
  if (ui.roomId === id) {
    ui.messages = current.messages; ui.historyCursor = current.historyCursor;
    ui.roomDeliveries = new Map([...ui.roomDeliveries, ...Object.entries(response.deliveries || {})]);
    ui.roomSummaries = new Map([...ui.roomSummaries, ...Object.entries(response.summaries || {})]);
    render();
  }
}

async function restoreRoomMessages(id) {
  const generation = ui.historyGeneration;
  let cached = ui.messageCache.get(id);
  if (!cached && id) {
    const stored = await globalThis.SummonCache?.readRoom(id);
    if (stored && (stored.snapshot.historyEpoch ?? null) === ui.historyEpoch && generation === ui.historyGeneration)
      cached = ui.messageCache.get(id) || { ...stored, messages:stored.snapshot.messages, historyCursor:stored.snapshot.cursor };
  }
  if (ui.roomId !== id || generation !== ui.historyGeneration) return;
  ui.messages = cached?.messages || []; ui.historyCursor = cached?.historyCursor; ui.messagesRoomId = cached ? id : null;
  ui.roomDeliveries = new Map(Object.entries(cached?.snapshot.deliveries || {}));
  ui.roomSummaries = new Map(Object.entries(cached?.snapshot.summaries || {}));
  ui.roomExecutions = []; ui.roomWakeups = []; ui.roomFiles = [];
}

async function acceptHistoryEpoch(response, generation) {
  if (!Object.hasOwn(response || {}, 'historyEpoch') && !Object.hasOwn(response?.snapshot || {}, 'historyEpoch')) return true;
  const epoch = response.historyEpoch ?? response.snapshot?.historyEpoch ?? null;
  if (epoch === ui.historyEpoch) return true;
  if (generation !== ui.historyGeneration || ui.retiredHistoryEpochs.has(epoch)) { scheduleRefresh(); return false; }
  ui.retiredHistoryEpochs.add(ui.historyEpoch); ui.historyEpoch = epoch; ui.historyGeneration++;
  ui.messages = []; ui.roomDeliveries.clear(); ui.roomSummaries.clear(); ui.messagesRoomId = null;
  ui.messageCache.clear(); ui.stateSnapshot = null; ui.stateCursor = null;
  await globalThis.SummonCache?.resetHistory(epoch, clientSessionSnapshot());
  return true;
}

async function requestSyncedSnapshot(path, previous) {
  const cache = globalThis.SummonCache, cursor = previous?.cursor;
  const generation = ui.historyGeneration;
  const response = await api(cache ? path + '?sync=1&pages=1' + (cursor ? '&since=' + encodeURIComponent(cursor) : '') : path, 'GET', undefined, { sync:true });
  if (!await acceptHistoryEpoch(response, generation)) return null;
  if (!response.sync) return { snapshot:response, cursor:null };
  try { return { snapshot:cache.applySync(previous?.snapshot, response), cursor:response.sync.cursor }; }
  catch (error) { if (!cursor) throw error; return requestSyncedSnapshot(path, null); }
}

function clientSessionSnapshot() {
  const attachments = Object.fromEntries(Object.entries(ui.draftAttachments).map(([id, items]) => [id, items.map(({ preview, ...item }) => item)]));
  const localMessages = Object.fromEntries(Object.entries(ui.localMessages).map(([id, entries]) => [id, Object.values(entries)]));
  const executionInputs = [...ui.executionInputs].filter(([,entry]) => !entry.submitted).map(([key,{ busy, ...entry }]) => [key,entry]);
  return { historyEpoch:ui.historyEpoch, roomId:ui.roomId, mobileRoom:ui.mobileRoom, drafts:ui.drafts, targets:ui.draftTargets,
    references:ui.draftReferences, attachments, localMessages, executionInputs, reply:ui.reply };
}

function persistClientSession() {
  if (!ui.cacheReady || !globalThis.SummonCache) return;
  const session = clientSessionSnapshot();
  const signature = JSON.stringify(session);
  if (signature !== ui.lastSessionSignature) {
    ui.lastSessionSignature = signature;
    ui.lastSessionWrite = globalThis.SummonCache.writeSession(session).then(written => {
      if (globalThis.SummonCache.status.persistent && written) return true;
      try {
        const attachments = Object.fromEntries(Object.entries(session.attachments).map(([id,items]) => [id,items.filter(item => item.status === 'ready')]));
        sessionStorage.setItem(updateDraftKey,JSON.stringify({ ...session,attachments,savedAt:Date.now() }));
        return true;
      } catch { return false; }
    });
  }
  return ui.lastSessionWrite;
}

function restoreClientSession(saved) {
  if (!saved) return;
  ui.roomId = saved.roomId ?? ui.roomId; ui.mobileRoom = !!saved.mobileRoom;
  ui.drafts = saved.drafts || {}; ui.draftTargets = saved.targets || {}; ui.draftReferences = saved.references || {};
  ui.reply = saved.reply || null;
  if (Array.isArray(saved.executionInputs)) for (const [key,entry] of saved.executionInputs)
    if (typeof key === 'string' && typeof entry?.text === 'string') ui.executionInputs.set(key,entry);
  for (const [id, entries] of Object.entries(saved.attachments || {})) {
    ui.draftAttachments[id] = entries.filter(entry => entry.status === 'ready' && attachmentUrl(entry.attachment) || entry.file instanceof File)
      .map(entry => ['ready','staged'].includes(entry.status) ? entry : { ...entry, status:'error', error:'上传尚未确认，可重试' });
  }
  for (const [roomId, entries] of Object.entries(saved.localMessages || {})) for (const entry of entries) {
    if (typeof entry?.clientId !== 'string' || !entry.payload || !entry.message) continue;
    let payload = entry.payload;
    if (typeof payload.content === 'string') {
      const { content, toBotId, replyTo, attachments = [] } = payload;
      payload = { text:content, mentions:toBotId ? [toBotId] : [], reply_to:replyTo ? { kind:'event', id:replyTo } : undefined,
        attachments:attachments.map(item => ({ kind:'file', id:item.id })) };
    }
    (ui.localMessages[roomId] ||= {})[entry.clientId] = { ...entry, roomId,payload,
      status:['rejected','saved'].includes(entry.status) ? entry.status : 'unconfirmed',
      error:entry.status === 'saved' ? '' : entry.error || '尚未确认消息是否保存' };
  }
  for (const [roomId,previous] of Object.entries(saved.outbound || {})) {
    if (typeof previous?.id !== 'string' || ui.localMessages[roomId]?.[previous.id]) continue;
    let original;
    try { original = JSON.parse(previous.signature); } catch { continue; }
    if (typeof original?.content !== 'string') continue;
    const drafts = attachmentDrafts(roomId).map(item => item.attachment).filter(Boolean);
    const attachments = (original.attachments || []).map(item => drafts.find(file => file.id === item.id) || item);
    const payload = { text:original.content, mentions:original.toBotId ? [original.toBotId] : [],
      attachments:attachments.map(item => ({ kind:'file',id:item.id })), ...(original.replyTo ? { reply_to:messageRef(original.replyTo) } : {}) };
    const message = { id:'local-' + previous.id, clientId:previous.id, roomId, content:payload.text, mentions:payload.mentions, attachments,
      replyTo:payload.reply_to?.id, senderId:'user', createdAt:new Date(saved.savedAt || Date.now()).toISOString() };
    (ui.localMessages[roomId] ||= {})[previous.id] = { roomId,clientId:previous.id,payload,message,status:'unconfirmed',error:'尚未确认消息是否保存' };
  }
}

async function restoreCachedState() {
  const cache = globalThis.SummonCache;
  try {
    await cache?.ready();
    const [cached, session] = await Promise.all([cache?.readState(), cache?.readSession()]);
    let savedUpdateSession;
    try { savedUpdateSession = JSON.parse(sessionStorage.getItem(updateDraftKey) || localStorage.getItem(updateDraftKey) || 'null'); } catch {}
    ui.historyEpoch = cached?.snapshot.historyEpoch ?? session?.historyEpoch ?? savedUpdateSession?.historyEpoch ?? null;
    restoreClientSession(session);
    if (savedUpdateSession) restoreClientSession({ ...session, ...savedUpdateSession, attachments: { ...session?.attachments, ...savedUpdateSession.attachments } });
    if (cached) {
      ui.stateSnapshot = cached.snapshot; ui.stateCursor = cached.cursor;
      Object.assign(state, cached.snapshot);
      globalThis.SummonModels.sync(state.modelSettings);
      if (!roomById(ui.roomId)) ui.roomId = state.rooms[0]?.id ?? null;
      await restoreRoomMessages(ui.roomId);
      ui.loading = false;
    }
  } catch { /* Initial network synchronization can recover. */ }
  finally {
    ui.cacheReady = true;
    const saved = await persistClientSession();
    if (saved && cache?.status.persistent) {
      try { sessionStorage.removeItem(updateDraftKey); localStorage.removeItem(updateDraftKey); } catch {}
    }
    if (!ui.loading) render();
  }
}

async function navigate(view) {
  ui.navigationSeq++; ui.menu = null; ui.view = view; location.hash = view;
  if (view === 'chat') await restoreRoomMessages(ui.roomId);
  render();
  await loadCurrent();
  render();
}

function setListPage(kind, page, append = false) {
  const pages = ui.listPages ||= {};
  const current = pages[kind];
  const key = item => item.execution_ref ? refKey(item.execution_ref) : item.id;
  if (append) {
    const unique = new Map([...state[kind], ...page.items].map(item => [key(item), item]));
    state[kind] = [...unique.values()];
    pages[kind] = { ...current, ...page, extended:true,
      next_cursor:page.next_cursor === current.next_cursor ? null : page.next_cursor };
    return;
  }
  const firstItems = new Set(page.items.map(key));
  if (current?.extended && current.firstCursor === page.next_cursor) {
    const retained = state[kind].filter(item => !current.firstItems.has(key(item)) && !firstItems.has(key(item)));
    state[kind] = [...page.items, ...retained];
    pages[kind] = { ...current, firstItems };
  } else {
    state[kind] = page.items;
    pages[kind] = { ...page, firstItems, firstCursor:page.next_cursor };
  }
}

async function readList(endpoint, firstPage) {
  let cursor;
  const items = [], visited = new Set();
  do {
    if (visited.has(cursor)) { console.warn('服务返回了重复的分页游标', endpoint.split('?')[0]); break; }
    visited.add(cursor);
    const query = cursor ? (endpoint.includes('?') ? '&cursor=' : '?cursor=') + encodeURIComponent(cursor) : '';
    const page = firstPage ?? await api(endpoint + query);
    firstPage = undefined;
    items.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor);
  return items;
}

async function selectRoom(id) {
  if (!id) return;
  ui.navigationSeq++; ui.roomId = id; ui.view = 'chat'; ui.mobileRoom = true;
  ui.reply = null; ui.menu = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false;
  location.hash = 'chat';
  await restoreRoomMessages(id);
  render();
  await loadCurrent();
  render();
}

function memberChoices(selected = []) {
  return `<fieldset class="form-field member-options"><legend>Bot 成员</legend>${state.bots.map(bot => `<label class="member-choice">${avatar(bot.id,32)}
    <span>${esc(bot.name)}</span><input type="checkbox" name="members" value="${esc(bot.id)}" ${selected.includes(bot.id) ? 'checked' : ''}></label>`).join('')}</fieldset>`;
}

async function roomWorkspaceField(current) {
  const choices = (await readList('/api/workspaces')).filter(item => item.write !== false || item.id === current);
  return selectField('群项目目录', 'workspace', [{ value:'', label:'未绑定' },
    ...choices.map(item => ({ value:item.id, label:item.name + ' · ' + item.path }))],current || '');
}

async function openRoomForm() {
  const workspaceField = await roomWorkspaceField();
  openModal('创建会话', '', field('会话名称', 'title', '', { placeholder:'选填' }) + workspaceField + memberChoices(), async data => {
    const title = data.get('title').trim();
    const workspace = data.get('workspace');
    const room = await api('/api/rooms', 'POST', { members:data.getAll('members'), mode:'group', ...(workspace ? {workspace} : {}), ...(title ? { title } : {}) });
    state.rooms.push(room);
    await selectRoom(room.id);
  }, '创建');
}

async function openRoomEdit() {
  const room = roomById(ui.roomId);
  if (!room) return;
  const old = room.members.filter(id => id !== 'user');
  const workspaceField = room.mode === 'group' ? await roomWorkspaceField(room.workspace?.id) : '';
  openModal('编辑会话', '', field('会话名称', 'title', room.name, { placeholder:'留空保留原名称' }) + workspaceField + memberChoices(old), async data => {
    const selected = data.getAll('members'), previous = old.filter(id => botById(id)), title = data.get('title').trim();
    await api(roomPath(room.id), 'PATCH', { revision:room.revision, ...(title && title !== room.name ? { title } : {}),
      ...(workspaceField && data.get('workspace') !== (room.workspace?.id || '') ? {workspace:data.get('workspace') || null} : {}),
      add_members:selected.filter(id => !old.includes(id)), remove_members:previous.filter(id => !selected.includes(id)) });
  });
}

function leaveRoom() {
  const room = roomById(ui.roomId);
  openModal('退出会话',room.name,'',async () => {
    await api(roomPath(room.id),'PATCH',{ revision:room.revision,remove_members:['user'] });
  },'退出');
}

function formatBotModelSummary(bot) {
  const m = bot?.model;
  const eff = bot?.effective_models;
  const modeText = !m ? '未绑定模型' : m.mode === 'follow_default' ? '跟随默认用途表' : m.mode === 'follow_connection' ? '固定连接 · 用途跟表' : '显式固定';
  if (!eff?.conversation) return modeText;
  const fmt = item => item ? `${item.id}${item.thinking_level ? ` (${item.thinking_level})` : ''}` : '—';
  return `${modeText} · ① ${fmt(eff.fast_read)} · ② ${fmt(eff.conversation)} · ③ ${fmt(eff.pi_session)}`;
}

async function openBotEdit(bot) {
  if (!bot) return;
  const model = bot.model && typeof bot.model === 'object' ? bot.model : null;
  const initialMode = !model ? 'none' : model.mode === 'follow_default' ? 'follow_default' : model.mode === 'follow_connection' ? 'follow_connection' : 'custom';
  const path = '/api/bots/' + encodeURIComponent(bot.id);
  const [settings, files] = await Promise.all([
    api('/api/model-settings').catch(() => ({ connections:[] })),
    readList('/api/files?bot=' + encodeURIComponent(bot.id)).catch(() => []),
  ]);
  const currentId = model?.connection_id || settings.activeId || settings.connections[0]?.id || '';
  const connOptions = settings.connections.map(item => ({ value:item.id, label:`${item.name || item.id}${item.active ? '（默认）' : ''}` }));
  if (currentId && !connOptions.some(item => item.value === currentId)) connOptions.push({ value:currentId, label:currentId + ' · 当前绑定' });
  const optionalConnOptions = [{ value:'', label:'沿用主连接' }, ...connOptions];
  const materialId = bot.material_index_ref?.id || '';
  const materialOptions = [{ value:'',label:'未选择' }, ...files.map(item => ({ value:item.id,label:item.path || item.name || item.id }))];
  if (materialId && !materialOptions.some(item => item.value === materialId)) materialOptions.push({ value:materialId,label:materialId + ' · 当前索引' });
  const role = bot.role_id || '';
  const roles = [{ value:'', label:'普通 Bot' }, { value:'tool-onboarding', label:'工具接入' }, { value:'catalog-maintainer', label:'连接维护' }];
  if (!roles.some(item => item.value === role)) roles.push({ value:role, label:role });
  const modes = [
    { value:'follow_default', label:'跟随全局默认用途表（推荐）' },
    { value:'follow_connection', label:'固定连接，用途跟表' },
    { value:'custom', label:'显式固定 / 按用途覆盖' },
    { value:'none', label:'未绑定模型' },
  ];
  const fastOv = model?.purposes?.fast_read || {};
  const piOv = model?.purposes?.pi_session || {};
  const purposeOverridesHtml = `<details class="models-advanced" data-model-custom><summary>按用途单独覆盖（可选，如 ① 快读指定其他连接）</summary>
    <p class="form-help">① 快读（留空沿用主配置）</p>
    ${selectField('快读连接','fast_connection_id',optionalConnOptions,fastOv.connection_id || '')}
    ${field('快读模型','fast_model_id',fastOv.id || '',{ placeholder:'留空沿用连接/主模型' })}
    ${field('快读思考档','fast_thinking_level',fastOv.thinking_level ?? '',{ placeholder:'例如 off',list:'bot-all-thinking-levels' })}
    <p class="form-help">③ 独立 Pi（留空沿用主配置）</p>
    ${selectField('Pi 连接','pi_connection_id',optionalConnOptions,piOv.connection_id || '')}
    ${field('Pi 模型','pi_model_id',piOv.id || '',{ placeholder:'留空沿用连接/主模型' })}
    ${field('Pi 思考档','pi_thinking_level',piOv.thinking_level ?? '',{ placeholder:'例如 high / max',list:'bot-all-thinking-levels' })}
  </details>`;
  openModal('编辑 Bot', '', field('名称','name',bot.name,{ required:true }) + field('行为指令','instructions',bot.instructions || '',{ type:'textarea',rows:5 }) +
    field('团队公开职责','public_duty',bot.public_duty || '') +
    selectField('内置职责','role_id',roles,role) +
    selectField('模型策略','model_mode',modes,initialMode) +
    `<p class="form-help" data-bot-model-effective>${esc(formatBotModelSummary(bot))}</p>` +
    `<div data-model-conn>${selectField('模型连接','connection_id',connOptions.length ? connOptions : [{ value:'',label:'暂无可用连接' }],currentId)}</div>` +
    `<div data-model-custom>${field('模型名称','model_id',model?.id || '',{ placeholder:'留空使用连接配置' })}${field('推理强度','thinking_level',model?.thinking_level || '',{ placeholder:'留空继承连接',list:'bot-thinking-levels' })}</div>` +
    purposeOverridesHtml +
    '<datalist id="bot-thinking-levels"></datalist><datalist id="bot-all-thinking-levels">' +
    ['off','minimal','low','medium','high','xhigh','max'].map(v => `<option value="${v}"></option>`).join('') +
    '</datalist>' + selectField('选材索引','material_index',materialOptions,materialId), async data => {
    const mode = data.get('model_mode');
    const connection_id = data.get('connection_id');
    const id = data.get('model_id').trim(), thinking_level = data.get('thinking_level').trim();
    let binding = null;
    if (mode === 'follow_default') binding = { mode:'follow_default' };
    else if (mode === 'follow_connection') {
      if (!connection_id) throw new Error('请选择一个模型连接');
      binding = { mode:'follow_connection', connection_id };
    } else if (mode === 'custom') {
      if (!connection_id) throw new Error('请选择一个模型连接');
      const purposes = {};
      const readOv = prefix => {
        const cid = data.get(prefix + '_connection_id').trim();
        const mid = data.get(prefix + '_model_id').trim();
        const tl = data.get(prefix + '_thinking_level').trim();
        if (!cid && !mid && !tl) return null;
        return { ...(cid ? { connection_id:cid } : {}), ...(mid ? { id:mid } : {}), ...(tl ? { thinking_level:tl } : {}) };
      };
      const f = readOv('fast'), p = readOv('pi');
      if (f) purposes.fast_read = f;
      if (p) purposes.pi_session = p;
      binding = { mode:'custom', connection_id, ...(id ? { id } : {}), thinking_level:thinking_level || null,
        ...(Object.keys(purposes).length ? { purposes } : {}) };
    }
    const sameBinding = JSON.stringify(bot.model ?? null) === JSON.stringify(binding ?? null);
    await api(path, 'PATCH', {
      revision:bot.revision, name:data.get('name').trim(), instructions:data.get('instructions'), ...(sameBinding ? {} : { model:binding }),
      ...(data.get('public_duty').trim() !== (bot.public_duty || '') ? {public_duty:data.get('public_duty').trim()} : {}),
      ...(data.get('role_id') !== role ? { role_id:data.get('role_id') || null } : {}),
      ...(data.get('material_index') !== materialId ? { material_index_ref:data.get('material_index') ? { kind:'file',id:data.get('material_index') } : null } : {}),
    });
  });
  const form = $('#modal-form'), levels = $('#bot-thinking-levels', form);
  const updateVisibility = () => {
    const mode = form.elements.model_mode.value;
    for (const el of $$('[data-model-conn]', form)) el.hidden = !['follow_connection','custom'].includes(mode);
    for (const el of $$('[data-model-custom]', form)) el.hidden = mode !== 'custom';
  };
  const updateLevels = () => {
    const entry = settings.connections.find(item => item.id === form.elements.connection_id.value);
    const known = !form.elements.model_id.value.trim() || form.elements.model_id.value.trim() === entry?.model;
    const values = globalThis.SummonModels.thinkingChoices(known ? entry?.thinkingLevels : undefined, form.elements.thinking_level.value);
    levels.replaceChildren(...values.map(value => new Option(value === 'off' ? '关闭思考' : value, value)));
  };
  form.elements.model_mode.addEventListener('change', updateVisibility);
  form.elements.connection_id.addEventListener('change', updateLevels);
  form.elements.model_id.addEventListener('input', updateLevels);
  updateVisibility();
  updateLevels();
}

function resourceChoices(name, records, ids) {
  const options = [...records, ...ids.filter(id => id !== '*' && !records.some(item => item.id === id))
    .map(id => ({ id, name: id + ' · 现有授权' }))];
  return `<fieldset class="form-field member-options"><legend>${esc(name)}</legend>${options.map(item => `<label class="member-choice">
    <span>${esc(item.name || item.id)}${item.path ? `<small>${esc(item.path)}</small>` : ''}</span>
    <input type="checkbox" name="${esc(name)}" value="${esc(item.id)}" ${ids.includes(item.id) ? 'checked' : ''}></label>`).join('')}</fieldset>`;
}

async function editBotAccess(bot) {
  const path = '/api/bots/' + encodeURIComponent(bot.id) + '/access';
  const [access, models, workspaces] = await Promise.all([
    api(path), api('/api/model-settings').catch(() => ({ connections:[] })), readList('/api/workspaces').catch(() => []),
  ]);
  const policy = access.execution_onboarding ? JSON.stringify(access.execution_onboarding,null,2) : '';
  const permissions = resourceChoices('模型连接',models.connections,access.model_ids) + resourceChoices('执行目录',workspaces,access.workspace_ids) +
    field('工具接入授权（JSON）','execution_onboarding',policy,{ type:'textarea',rows:6,placeholder:'{"discover":{"path":true}}',
      help:'可设置发现范围、指定程序和服务目标，并授权提交配置或分配负责人。留空撤销工具接入授权。' });
  openModal(bot.name + ' 的资源权限','',permissions,async data => {
    const raw = data.get('execution_onboarding').trim();
    await api(path,'PATCH',{ revision:access.revision, model_ids:data.getAll('模型连接'), workspace_ids:data.getAll('执行目录'),
      ...(raw !== policy ? { execution_onboarding:raw ? JSON.parse(raw) : null } : {}) });
  });
}

function editWorkspace(item) {
  const body = field('目录名称','name',item?.name || '',{ required:true }) + field('绝对路径','path',item?.path || '',{ required:true,placeholder:'D:/projects/example' }) +
    `<label class="checkbox-line"><input type="checkbox" name="write" ${item?.write === true ? 'checked' : ''}>允许执行器写入</label>`;
  openModal(item ? '编辑执行目录' : '登记执行目录','',body,async data => {
    await api('/api/workspaces' + (item ? '/' + encodeURIComponent(item.id) : ''),item ? 'PATCH' : 'POST',{
      name:data.get('name').trim(),path:data.get('path').trim(),write:data.has('write'),...(item ? { revision:item.revision } : {}),
    });
  });
}

function editConnection(item) {
  const available = state.bots.map(bot => ({ id:bot.id,name:bot.name }));
  const basic = field('名称','name',item?.name || '',{ required:true }) + field('说明','description',item?.description || '') +
    `<label class="checkbox-line"><input type="checkbox" name="enabled" ${item?.enabled !== false ? 'checked' : ''}>启用</label>`;
  const configuration = item ? field('要修改的连接配置（JSON）','config','',{ type:'textarea',rows:6,placeholder:'留空保留连接配置' })
    : selectField('协议','kind',['codex','cli','ssh','mcp','http'].map(value => ({value,label:value})),'codex') +
    `<div data-native-connection>${field('可执行文件','file','',{ placeholder:'绝对路径' })}
    ${field('实际可执行文件','canonical_file','',{ placeholder:'如果已通过链接安装，填写其实际路径' })}</div>` +
    field('其他连接设置（JSON）','config','{}',{ type:'textarea',rows:6,required:true });
  const maintainer = [{ value:'',label:'未分配' }, ...botOptions()];
  const controls = selectField('负责人','maintainer_bot_id',maintainer,item?.maintainer_bot_id ?? '') +
    resourceChoices('允许修复的 Bot',available,item?.repair_bot_ids || []);
  openModal(item ? '执行连接设置' : '新增执行连接','',basic + configuration + controls,async data => {
    const input = { name:data.get('name').trim(), description:data.get('description'), enabled:data.has('enabled'),
      maintainer_bot_id:data.get('maintainer_bot_id') || null, repair_bot_ids:data.getAll('允许修复的 Bot') };
    const raw = data.get('config').trim();
    if (raw || !item) {
      const config = JSON.parse(raw);
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('连接设置须为 JSON 对象。');
      if (item) input.config_patch = config;
      else {
        const kind = data.get('kind');
        if (['codex','cli','ssh'].includes(kind)) {
          const file = data.get('file').trim(), canonical = data.get('canonical_file').trim();
          if (file) config.file = file;
          if (canonical || file) config.canonical_file = canonical || file;
        }
        Object.assign(input,{ kind,config });
      }
    }
    if (item) input.revision = item.revision;
    await api('/api/connections' + (item ? '/' + encodeURIComponent(item.id) : ''),item ? 'PATCH' : 'POST',input);
  });
  if (!item) {
    const form = $('#modal-form');
    const sync = () => { $('[data-native-connection]',form).hidden = !['codex','cli','ssh'].includes(form.elements.kind.value); };
    form.elements.kind.addEventListener('change',sync); sync();
  }
}

async function openHostLimits() {
  const current = await api('/api/connections/limits');
  const fields = Object.entries(current.limits).map(([key,value]) => field(resourceLabels[key] || key,key,value,
    { type:'number', min:key === 'period_ms' ? 1000 : 0, required:true })).join('');
  openModal('宿主额度','',`<div class="limits-fields">${fields}</div>`,async data => {
    const limits = Object.fromEntries(Object.keys(current.limits).map(key => {
      const value = Number(data.get(key));
      if (!Number.isSafeInteger(value) || value < (key === 'period_ms' ? 1000 : 0)) throw new Error('请填写有效的额度整数。');
      return [key,value];
    }));
    await api('/api/connections/limits','PATCH',{ revision:current.revision,limits });
  });
}

async function openExecutionForm() {
  const [connections, workspaces] = await Promise.all([readList('/api/connections'),readList('/api/workspaces')]);
  const engines = connections.filter(item => item.id !== 'pi' && item.available !== false);
  if (!engines.length) { toast('先配置一个可用的执行连接。'); return; }
  const choices = [{ value:'',label:'选择目录' }, ...workspaces.map(item => ({ value:item.id,label:item.name + ' · ' + item.path }))];
  const engineOptions = engines.map(item => ({ value:item.id,label:item.name || item.id }));
  const codex = `<div class="form-row" data-codex-binding>${field('模型','model','',{ placeholder:'留空采用连接配置' })}${field('推理强度','effort','',{ placeholder:'留空使用连接默认值' })}</div>`;
  openModal('打开执行会话','',selectField('连接','engine',engineOptions,engineOptions[0].value) + selectField('执行目录','workspace',choices,'') +
    codex + selectField('输入格式','format',[{value:'text',label:'文本'},{value:'json',label:'JSON'}],'text') +
    field('输入','input','',{ type:'textarea',rows:6,required:true }),async data => {
    const engine = data.get('engine'), workspace = data.get('workspace'), raw = data.get('input');
    const isCodex = engines.find(item => item.id === engine).protocol === 'codex';
    const model = data.get('model').trim(), effort = data.get('effort').trim();
    const input = data.get('format') === 'json' && !isCodex ? JSON.parse(raw) : isCodex
      ? { text:raw, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : raw;
    const detail = await api('/api/executions','POST',{ engine,input,
      ...(workspace ? { workspace:{ kind:'workspace',id:workspace } } : {}) },{ clientId:newClientId() });
    ui.executionRef = detail.execution_ref; ui.executionDetail = detail;
  },'打开会话');
  const form = $('#modal-form');
  const sync = () => {
    const isCodex = engines.find(item => item.id === form.elements.engine.value)?.protocol === 'codex';
    $('[data-codex-binding]',form).hidden = !isCodex;
    form.elements.format.closest('.form-field').hidden = isCodex;
  };
  form.elements.engine.addEventListener('change',sync); sync();
}

function openFileEdit(element) {
  const before = element.dataset.id ? ui.fileDetail : null;
  const spaces = [...state.rooms.map(room => ({ value:refKey(room.ref), label:room.name })),
    ...state.bots.map(bot => ({ value:refKey({ kind:'bot', id:bot.id }), label:bot.name + ' 的私有资料' }))];
  const scope = before?.space ?? (element.dataset.space ? { kind:element.dataset.kind, id:element.dataset.space } : ui.roomId ? roomRef(ui.roomId) : null);
  if (!before && !spaces.length) { toast('先创建会话或 Bot。'); return; }
  openModal(before ? '编辑资料' : '新增资料', '', (before ? '' : selectField('资料空间','space',spaces,refKey(scope))) +
    (before ? `<p>${esc(before.path)}</p>` : field('文件路径','path','',{ required:true, placeholder:'例如 notes.md' })) +
    field('正文','content',before?.content || '',{ type:'textarea',rows:8 }), async data => {
    const [kind,id] = before ? [before.space.kind,before.space.id] : JSON.parse(data.get('space'));
    const path = before?.path ?? data.get('path').trim();
    const saved = await api('/api/files','POST',{ space:{ kind,id }, path, content_or_source:data.get('content'),
      ...(before ? { revision:before.revision, sources:before.sources } : {}) });
    if (ui.view === 'files') { ui.fileId = saved.id; await loadFile(saved.id); }
  });
}

function wakeupById(id) { return (ui.view === 'chat' ? ui.roomWakeups : state.wakeups)?.find(item => item.id === id); }
function wakeupRequest(item, data) { return api('/api/wakeups','POST',{ bot:{ kind:'bot', id:item.bot_id }, id:item.id, revision:item.revision, ...data }); }

function openWakeupEdit(item, roomId) {
  const rule = item?.rule;
  if (rule?.kind === 'room_base') {
    const count = rule.message_count;
    openModal('基础关注', '', selectField('关注范围','mode',[{value:'all',label:'所有消息'},{value:'mentions',label:count ? '@ 或回复' : '仅 @ 或回复'}],rule.mode) +
      (count ? field('累计多少条新消息后回看','message_count',count,{ type:'number', min:1, step:1, required:true }) : ''), data =>
      wakeupRequest(item,{ event_or_time:{ ...rule, mode:data.get('mode'), ...(count && { message_count:Number(data.get('message_count')) }) } }));
    return;
  }
  const selectedRoomId = item ? rule?.room?.id || rule?.room || (rule?.scope?.kind === 'room' ? rule.scope.id : '') : roomId;
  const room = roomById(selectedRoomId);
  const botsIn = scopedRoom => scopedRoom ? botOptions().filter(bot => scopedRoom.members.includes(bot.value)) : botOptions();
  const bots = botsIn(room);
  const rooms = [{ value:'',label:'全部可访问空间' }, ...state.rooms
    .filter(room => !item || room.members.includes(item.bot_id) || room.id === selectedRoomId)
    .map(value => ({ value:value.id,label:value.name }))];
  if (selectedRoomId && !rooms.some(option => option.value === selectedRoomId)) rooms.push({ value:selectedRoomId,label:'当前会话范围' });
  const next = rule?.at ? new Date(rule.at) : null;
  const refId = rule?.ref?.id || '';
  const localTime = next && Number.isFinite(next.valueOf()) ? new Date(next.valueOf() - next.getTimezoneOffset() * 60000).toISOString().slice(0,16) : '';
  const kind = rule?.kind || 'event';
  const author = rule?.author?.id;
  const eventTypes = ['message','file.revised','call.receipt'];
  const intervalMinutes = rule?.interval_ms ? String(rule.interval_ms / 60000) : '';
  openModal(item ? '编辑订阅' : '新增订阅或提醒', '', (item ? '' : selectField('订阅类型','kind',[
    { value:'event',label:'事件订阅' },{ value:'time',label:'定时提醒' },
  ],kind)) + (item ? '' : selectField('接收 Bot','bot',[{value:'',label:'选择 Bot'},...bots],bots[0]?.value ?? '')) +
    selectField('会话范围','room',rooms,selectedRoomId || '') + `<div class="form-row" data-wakeup-kind="event">
    ${field('事件类型','event_type',rule?.type || 'message',{ list:'wakeup-event-types' })}
    <datalist id="wakeup-event-types">${eventTypes.map(value => `<option value="${value}"></option>`).join('')}</datalist>
    ${selectField('作者','author',[],author || '')}</div>
    <div class="form-row" data-wakeup-kind="event">
    ${field('对象类型','ref_kind',rule?.ref?.kind || '',{ placeholder:'选填' })}
    ${field('对象 ID','ref_id',refId,{ placeholder:'选填' })}</div>
    <div class="form-row" data-wakeup-kind="time">${field('提醒时间','at',localTime,{ type:'datetime-local' })}
    ${field('重复间隔（分钟）','interval',intervalMinutes,{ type:'number',step:'any' })}</div>`, async data => {
    const chosen = data.get('kind') || kind, roomId = data.get('room');
    let event_or_time;
    if (chosen === 'time') {
      const at = new Date(data.get('at')), minutes = data.get('interval');
      const interval = minutes === intervalMinutes && rule?.interval_ms ? rule.interval_ms : Math.round(Number(minutes) * 60000);
      if (!Number.isFinite(at.valueOf())) throw new Error('请选择提醒时间。');
      if (minutes && (!Number.isSafeInteger(interval) || interval < 1000)) throw new Error('重复间隔至少为 1 秒。');
      const scope = roomId ? roomRef(roomId) : rule?.scope?.kind !== 'room' ? rule?.scope : null;
      event_or_time = { kind:'time', at:at.toISOString(), ...(minutes ? { interval_ms:interval } : {}), ...(scope ? { scope } : {}) };
    } else {
      const author = data.get('author'), refKind = data.get('ref_kind').trim(), refId = data.get('ref_id').trim();
      if (Boolean(refKind) !== Boolean(refId)) throw new Error('请选择对象类型并填写对应的 ID。');
      const identity = author === rule?.author?.id ? rule.author : { kind:author === 'user' ? 'user' : 'bot',id:author };
      event_or_time = { kind:'event', type:data.get('event_type').trim(), ...(roomId ? { room:roomId } : {}),
        ...(author ? { author:identity } : {}), ...(refKind ? { ref:{ kind:refKind,id:refId } } : {}) };
    }
    if (item) await wakeupRequest(item,{ event_or_time });
    else {
      if (!data.get('bot')) throw new Error('请选择接收 Bot。');
      await api('/api/wakeups','POST',{ bot:{ kind:'bot',id:data.get('bot') }, event_or_time });
    }
  });
  const form = $('#modal-form');
  const showKind = () => { for (const row of $$('[data-wakeup-kind]',form)) row.hidden = row.dataset.wakeupKind !== (form.elements.kind?.value || kind); };
  form.elements.kind?.addEventListener('change', showKind); showKind();
  const updatePeople = (initial = false) => {
    const options = botsIn(roomById(form.elements.room.value));
    const populate = (name, choices, value) => {
      const element = form.elements[name];
      if (!element) return;
      element.replaceChildren(...choices.map(item => new Option(item.label,item.value)));
      element.value = choices.some(item => item.value === value) ? value : '';
    };
    const authors = [{value:'',label:'任意'},{value:'user',label:ownerName()},...options];
    if (author && !authors.some(item => item.value === author)) authors.push({ value:author,label:author + ' · 当前作者' });
    populate('bot',[{value:'',label:'选择 Bot'},...options],form.elements.bot?.value);
    populate('author',authors,initial ? author || '' : form.elements.author.value);
  };
  form.elements.room.addEventListener('change', () => updatePeople());
  updatePeople(true);
}

async function addReference() {
  const room = roomById(ui.roomId);
  if (!room) return;
  const items = await readList('/api/files?room=' + encodeURIComponent(room.id)).catch(() => []);
  if (ui.roomId !== room.id) return;
  const options = [{ value:'',label:'选择资料' }, ...items.map(item => ({ value:item.id, label:item.name || item.path }))];
  openModal('添加资料引用','',selectField('资料','file',options,'') + field('文件 ID','file_id','',{ placeholder:'也可直接填写可引用的文件 ID' }),data => {
    const id = data.get('file_id').trim() || data.get('file');
    if (id) addDraftReference(room.id,{ kind:'file',id });
    else throw new Error('请选择资料或填写文件 ID。');
  },'加入消息');
}

function addDraftReference(roomId, ref) {
  const selected = ui.draftReferences[roomId] ||= [];
  if (!selected.some(item => sameRef(item,ref))) selected.push(ref);
  render();
}

async function openReference(ref) {
  if (ref.kind === 'file') { ui.fileId = ref.id; ui.fileDetail = null; return navigate('files'); }
  if (ref.kind === 'session' || ref.kind === 'conversation') { ui.executionRef = ref; ui.executionDetail = null; ui.stopResults = null; return navigate('executions'); }
  if (ref.kind === 'bot') return act('open-bot-details',{ dataset:{ id:ref.id } });
  if (ref.kind === 'room') return selectRoom(ref.id);
  if (ref.kind === 'event') {
    const anchor = $('.messages [data-message-id="' + CSS.escape(ref.id) + '"]');
    if (anchor) {
      anchor.scrollIntoView({ block:'center' });
      $('.message-bubble',anchor)?.focus({ preventScroll:true });
      return;
    }
  }
  let value;
  if (ref.kind === 'event') value = await api('/api/events/' + encodeURIComponent(ref.id));
  else if (ref.kind === 'connection') value = await api('/api/connections/' + encodeURIComponent(ref.id));
  else if (ref.kind === 'call') value = await api('/api/calls/' + encodeURIComponent(ref.id));
  else value = (await api('/api/platform/read','POST',{ arguments:{ ref } })).result;
  openModal(refType[ref.kind] || '引用','',`<pre class="execution-output">${esc(value.content ?? JSON.stringify(value,null,2))}</pre>`);
}

function configurePin(ref, remove) {
  const room = roomById(ui.roomId);
  return api(roomPath(room.id),'PATCH',{ revision:room.revision, [remove ? 'pin_remove' : 'pin_add']:[ref] });
}

function restoreMessageDraft(entry) {
  if (entry?.status !== 'rejected') return;
  const { roomId,clientId,payload,message } = entry;
  if (ui.drafts[roomId] || attachmentDrafts(roomId).length || ui.draftReferences[roomId]?.length
    || ui.draftTargets[roomId]?.length || ui.reply?.roomId === roomId)
    throw new Error('请先保存或清空输入框里的草稿，再恢复这条消息。');
  ui.drafts[roomId] = payload.text;
  ui.draftTargets[roomId] = payload.mentions || [];
  ui.draftReferences[roomId] = payload.references || [];
  ui.draftAttachments[roomId] = (message.attachments || []).map(attachment => ({
    key:newClientId(),status:'ready',name:attachment.name,size:attachment.size,attachment,
  }));
  if (payload.reply_to?.id) ui.reply = ui.messages.find(item => item.id === payload.reply_to.id) ??
    { id:payload.reply_to.id,roomId,content:'原消息' };
  delete ui.localMessages[roomId][clientId];
  render();
  $('#message-input')?.focus();
}

async function controlExecution(action) {
  const detail = ui.executionDetail;
  const base = { target:detail.execution_ref, control_version:detail.control_version };
  if (action === 'resume-execution') {
    await api('/api/executions/input','POST',{ ...base,kind:'resume',resume_ref:detail.resume_ref },{ clientId:newClientId() });
    await refresh(); return;
  }
  openModal('暂停执行','',selectField('范围','scope',[
    { value:'target',label:'仅此执行' },{ value:'target_and_owned_calls',label:'包括独占子执行' },
  ],'target'),async data => {
    const result = await api('/api/executions/stop','POST',{ ...base,scope:data.get('scope') },{ clientId:newClientId() });
    ui.stopResults = result.targets;
  },'暂停并请求停止');
}

async function act(action, element) {
  const { id, kind } = element.dataset;
  const ref = { kind,id };
  if (action.startsWith('usage-')) return globalThis.SummonUsage.act(action,element,api,render);
  if (action.startsWith('models-')) return globalThis.SummonModels.act(action,element,{ api,render,toast,refresh });
  if (action === 'set-theme') return setThemePreference(element.dataset.theme);
  if (action === 'toggle-folder') return toggleFolderCollapsed(id);
  if (action === 'home-pin') return togglePinEntry(element.dataset.key);
  if (action === 'home-move') return moveEntryToFolder(element.dataset.key, element.dataset.folder || null);
  if (action === 'home-hide') return setHiddenEntry(element.dataset.key, true);
  if (action === 'home-restore') { setHiddenEntry(element.dataset.key, false); return openHiddenConversationsModal(); }
  if (action === 'manage-hidden') return openHiddenConversationsModal();
  if (action === 'home-new-folder') {
    const targetKey = element.dataset.key;
    return openModal('新建分组', '', field('分组名称', 'name', '', { placeholder: '如 Tech、工作', required: true }), data => {
      createHomeFolder(data.get('name'), targetKey);
    }, '创建');
  }
  if (action === 'folder-rename') {
    const folder = homeOrg.folders.find(f => f.id === id);
    if (!folder) return;
    return openModal('重命名分组', '', field('分组名称', 'name', folder.name, { required: true }), data => {
      renameHomeFolder(id, data.get('name'));
    }, '保存');
  }
  if (action === 'folder-delete') return deleteHomeFolder(id);
  if (action === 'home-details') {
    const roomId = element.dataset.room, botId = element.dataset.bot;
    if (roomId) {
      await selectRoom(roomId);
      ui.detailOpen = true; ui.profileBotId = null;
      return render();
    }
    if (botId) return act('open-bot-details', { dataset: { id: botId } });
    return;
  }
  if (action === 'toggle-sidebar') { $('.app-shell')?.classList.toggle('sidebar-collapsed'); return; }
  if (action === 'back-to-room-details') { ui.profileBotId = null; ui.detailTab = 'details'; ui.avatarEditing = false; render(); await loadCurrent(); return render(); }
  if (action === 'copy-code') {
    const code = element.closest('.code-block')?.querySelector('pre code')?.textContent || '';
    await navigator.clipboard?.writeText(code);
    const before = element.textContent; element.textContent = '✓ 已复制';
    setTimeout(() => { if (element.isConnected) element.textContent = before; }, 1400);
    return;
  }
  if (action === 'copy-message') {
    const text = element.closest('.bubble-column')?.querySelector('.message-content')?.textContent || '';
    await navigator.clipboard?.writeText(text);
    return toast('已复制消息文字');
  }
  if (action === 'preview-image') {
    const lb = $('#lightbox'); if (!lb) return;
    lb.innerHTML = `<div class="lightbox-card"><div style="display:flex;justify-content:space-between;align-items:center;gap:12px"><strong>${esc(element.dataset.name || '图片预览')}</strong><div style="display:flex;align-items:center;gap:8px"><a class="secondary-button" href="${esc(element.dataset.download || element.dataset.src)}" download="${esc(element.dataset.name || '')}">下载原图</a><button type="button" class="icon-button" data-action="close-lightbox" aria-label="关闭">${icon('close', 18)}</button></div></div><img src="${esc(element.dataset.src)}" alt="${esc(element.dataset.name || '')}"></div>`;
    lb.hidden = false; return;
  }
  if (action === 'close-lightbox') { const lb = $('#lightbox'); if (lb) { lb.hidden = true; lb.innerHTML = ''; } return; }
  if (action === 'navigate') return navigate(element.dataset.view);
  if (action === 'refresh') return refresh(true);
  if (action === 'close-modal') return closeModal();
  if (action === 'client-downloads') return window.SummonClients?.open(ui.releasesUrl);
  if (action === 'desktop-connection') return window.SummonDesktop?.openConnectionSettings();
  if (action === 'update-app') { await persistClientSession(); location.reload(); return; }
  if (action === 'display-settings') return openDisplaySettings();
  if (action === 'copy-display-diagnostics') {
    await navigator.clipboard.writeText(JSON.stringify({ beforeSettings:displayDiagnosticSnapshot,current:captureDisplayDiagnostics() },null,2));
    return toast('显示诊断已复制');
  }
  if (action === 'display-preset') return changeDisplayPreference('zoom',Number(element.dataset.zoom));
  if (action === 'display-reset') { displayPreferences[displayMode()] = { ...displayDefaults[displayMode()] }; return changeDisplayPreference('zoom',displayDefaults[displayMode()].zoom); }
  if (action === 'toggle-search') { ui.searchOpen = !ui.searchOpen; if (!ui.searchOpen) ui.roomQuery = ''; renderTopbar(); $('#room-search')?.focus(); return; }
  if (['toggle-create','toggle-apps','toggle-chat-menu','toggle-mention-menu'].includes(action)) {
    const menu = action === 'toggle-mention-menu' ? 'mentions' : action.slice(7);
    ui.menu = ui.menu === menu ? null : menu; return render();
  }
  if (action === 'select-room') return selectRoom(id);
  if (action === 'room-back') { ui.mobileRoom = false; ui.detailOpen = false; return render(); }
  if (action === 'new-room') return openRoomForm();
  if (action === 'edit-room') return openRoomEdit();
  if (action === 'leave-room') return leaveRoom();
  if (action === 'older-messages') return loadOlderMessages();
  if (action === 'dm-bot') {
    const bot = botById(id);
    if (!bot) return;
    let room = botConversation(id);
    if (!room) { room = await api('/api/rooms','POST',{ title:bot.name,members:[id],mode:'direct' }); state.rooms.push(room); }
    return selectRoom(room.id);
  }
  if (action === 'toggle-details' || action === 'open-bot-details') {
    if (!ui.roomId && action === 'open-bot-details') { ui.botId = id; return navigate('members'); }
    ui.detailOpen = action === 'open-bot-details' || !ui.detailOpen;
    ui.profileBotId = action === 'open-bot-details' ? id : null;
    ui.detailTab = 'details'; ui.avatarEditing = false; ui.roomFiles = [];
    render(); await loadCurrent(); return render();
  }
  if (action === 'close-details') { ui.detailOpen = false; ui.profileBotId = null; return render(); }
  if (action === 'detail-tab') { ui.detailTab = element.dataset.tab; ui.avatarEditing = false; render(); await loadCurrent(); return render(); }
  if (action === 'toggle-mention') {
    const room = roomById(ui.roomId), chosen = selectedMentions(room);
    ui.draftTargets[room.id] = chosen.includes(id) ? chosen.filter(value => value !== id) : [...chosen,id];
    ui.menu = null; render(); $('#message-input')?.focus(); return;
  }
  if (action === 'add-reference') return addReference();
  if (action === 'remove-reference') { ui.draftReferences[ui.roomId] = ui.draftReferences[ui.roomId].filter(item => !sameRef(item,ref)); return render(); }
  if (action === 'open-reference') return openReference(ref);
  if (action === 'reply-message') {
    ui.reply = mergedRoomMessages(ui.roomId,ui.messages).find(item => item.id === id && !item._delivery);
    render(); $('#message-input')?.focus(); return;
  }
  if (action === 'cancel-reply') { ui.reply = null; return render(); }
  if (action === 'retry-message') return sendLocalMessage(ui.localMessages[ui.roomId]?.[id]);
  if (action === 'restore-message-draft') return restoreMessageDraft(ui.localMessages[ui.roomId]?.[id]);
  if (action === 'attach-file') return chooseAttachments();
  if (action === 'remove-attachment') return removeAttachment(id);
  if (action === 'retry-attachment') {
    const item = attachmentDrafts().find(item => item.key === id);
    if (ui.protocolReady && item?.file && ['error','staged'].includes(item.status)) return uploadAttachment(ui.roomId,item);
    return;
  }
  if (action === 'pin' || action === 'unpin') { await configurePin(ref,action === 'unpin'); return refresh(); }
  if (action === 'copy-conversation') {
    const text = ui.messages.map(message => nameOf(message.senderId) + ' · ' + formatTime(message.createdAt,true) + '\n' + message.content).join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      return toast('已复制当前加载的会话文字');
    } catch {
      return openModal('复制已加载的会话文字', '', `<textarea class="execution-output" rows="10" aria-label="已加载的会话文字" readonly>${esc(text)}</textarea>`);
    }
  }
  if (action === 'new-bot') return openCreateBot();
  if (action === 'edit-bot') return openBotEdit(botById(id));
  if (action === 'bot-access') return editBotAccess(botById(id));
  if (action === 'select-bot') { ui.botId = id; return render(); }
  if (action === 'toggle-bot') {
    const bot = botById(id);
    await api('/api/bots/' + encodeURIComponent(id),'PATCH',{ revision:bot.revision,enabled:!bot.enabled,...(bot.enabled ? {} : { resume_ref:bot.resume_ref }) });
    return refresh();
  }
  if (action === 'avatar-greet') return window.SummonAvatars?.greet(element);
  if (action === 'edit-avatar') {
    ui.avatarSelectionRevision++; ui.avatarEditing = !ui.avatarEditing; ui.avatarDraft = { ...botAvatar(profileBot()) }; ui.avatarTab = 'bot'; return render();
  }
  if (action === 'avatar-tab') { ui.avatarTab = element.dataset.tab; return render(); }
  if (action === 'avatar-save-retry') return persistAvatar();
  if (['avatar-shape','avatar-template','avatar-random','avatar-reset'].includes(action)) {
    ui.avatarSelectionRevision++;
    if (action === 'avatar-shape') ui.avatarDraft = { ...ui.avatarDraft,shape:element.dataset.shape,image:null };
    if (action === 'avatar-template') {
      const template = window.SummonAvatars.templates.find(item => item.id === element.dataset.template);
      if (template) { const { id,name,...palette } = template; ui.avatarDraft = { ...ui.avatarDraft,...palette,image:null }; }
    }
    if (action === 'avatar-random') {
      const { shapes,colors } = window.SummonAvatars;
      ui.avatarDraft = { ...ui.avatarDraft,shape:shapes[Math.floor(Math.random() * shapes.length)].id,color:colors[Math.floor(Math.random() * colors.length)],image:null };
    }
    if (action === 'avatar-reset') ui.avatarDraft = window.SummonAvatars.defaults(profileBot()?.id,0);
    return updateAvatarPicker(element.dataset.mode || 'edit');
  }
  if (action === 'open-execution') return openReference(ref);
  if (action === 'new-execution') return openExecutionForm();
  if (action === 'stop-execution' || action === 'resume-execution') return controlExecution(action);
  if (action === 'more-execution-output') {
    const detail = ui.executionDetail, selected = detail.execution_ref;
    const next = await api(executionPath(selected) + '?cursor=' + encodeURIComponent(detail.next_cursor));
    if (sameRef(ui.executionRef,selected) && ui.executionDetail?.next_cursor === detail.next_cursor
      && (next.next_cursor !== detail.next_cursor || next.messages?.length || next.output_page?.text)) {
      const pages = detail.output_pages || (detail.output_page ? [detail.output_page] : []);
      const nextPage = next.output_page?.text ? [next.output_page] : [];
      ui.executionDetail = { ...next,messages:[...(detail.messages || []),...(next.messages || [])],output_pages:[...pages,...nextPage] }; render();
    }
    return;
  }
  if (action === 'open-file') return openReference({ kind:'file',id });
  if (action === 'edit-file') return openFileEdit(element);
  if (action === 'more-file') { await loadFile(ui.fileId,ui.fileDetail.next_cursor); return render(); }
  if (action === 'add-wakeup' || action === 'edit-wakeup') return openWakeupEdit(wakeupById(id),element.dataset.room);
  if (action === 'toggle-wakeup') { const item = wakeupById(id); await wakeupRequest(item,{ enabled:!item.enabled }); return refresh(); }
  if (action === 'more-list') {
    const page = ui.listPages[kind], endpoint = element.dataset.endpoint, navigation = ui.navigationSeq;
    if (!page?.next_cursor) return;
    const next = await api(endpoint + '?cursor=' + encodeURIComponent(page.next_cursor));
    if (navigation === ui.navigationSeq && ui.listPages[kind]?.next_cursor === page.next_cursor) { setListPage(kind,next,true); render(); }
    return;
  }
  if (action === 'open-connection') return openReference({ kind:'connection',id });
  if (action === 'edit-connection') return editConnection(state.connections.find(item => item.id === id));
  if (action === 'edit-workspace') return editWorkspace(state.workspaces.find(item => item.id === id));
  if (action === 'edit-limits') return openHostLimits();
}
function field(label, name, value = '', options = {}) {
  const { type = 'text', placeholder = '', help = '', required = false, rows, min, list, step } = options;
  const control = type === 'textarea' ? `<textarea id="field-${name}" name="${name}" ${required ? 'required' : ''} ${rows ? `rows="${rows}"` : ''} placeholder="${esc(placeholder)}">${esc(value)}</textarea>` : `<input id="field-${name}" name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${min != null ? `min="${min}"` : ''} ${list ? `list="${esc(list)}"` : ''} ${step ? `step="${step}"` : ''} placeholder="${esc(placeholder)}">`;
  return `<div class="form-field"><label for="field-${name}">${esc(label)}</label>${control}${help ? `<small>${esc(help)}</small>` : ''}</div>`;
}
function selectField(label, name, options, value, help = '') { return `<div class="form-field"><label for="field-${name}">${label}</label><select id="field-${name}" name="${name}">${options.map(option => `<option value="${esc(option.value)}" ${option.value === value ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select>${help ? `<small>${esc(help)}</small>` : ''}</div>`; }
function botOptions() { return state.bots.map(bot => ({ value: bot.id, label: bot.name })); }
function openModal(title, description, content, save, submitLabel = '保存') {
  const modal = $('#modal');
  captureMotion($('#modal-content'));
  modal.classList.remove('create-bot-modal'); ui.menu = null; renderTopbar();
  const header = `<div class="modal-header"><div><h2>${esc(title)}</h2>${description ? `<p>${esc(description)}</p>` : ''}</div><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close',17)}</button></div>`;
  $('#modal-content').innerHTML = header + (save ? `<form id="modal-form" class="modal-form">${content}<div class="form-error" role="alert"></div><div class="modal-footer"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit">${esc(submitLabel)}</button></div></form>`
    : `<div class="modal-form read-modal">${content}</div>`);
  if (save) $('#modal-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target; const button = $('button[type=submit]', form); const error = $('.form-error', form); error.textContent = ''; button.disabled = true;
    try { await save(new FormData(form), form); if (modal.open && $('#modal-form') === form) await closeModal(modal); await refresh(); } catch (cause) { if (form.isConnected) error.textContent = cause.message; else toast(cause.message, true); } finally { button.disabled = false; }
  };
  showModal(modal);
}
function closeFloatingMenus() {
  const hadMenu = Boolean(ui.menu);
  ui.menu = null;
  if (hadMenu) ui.lastSidebarHtml = null;
  for (const menu of document.querySelectorAll('.context-menu,.floating-context-menu')) menu.remove();
  for (const button of document.querySelectorAll('[data-action="toggle-apps"],[data-action="toggle-create"],[data-action="toggle-chat-menu"],[data-action="toggle-mention-menu"]')) button.setAttribute('aria-expanded', 'false');
}
function openFloatingContextMenu(x, y, html) {
  closeFloatingMenus();
  const menu = document.createElement('div');
  menu.className = 'floating-context-menu';
  menu.innerHTML = html;
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.max(10, Math.min(x, window.innerWidth - rect.width - 10));
  const top = Math.max(10, Math.min(y, window.innerHeight - rect.height - 10));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}
function openHomeEntryContextMenu(key, x, y) {
  const entry = buildHomeEntries().find(item => item.key === key);
  if (!entry) return;
  const pinned = isPinnedEntry(key);
  const currentFolder = folderIdForEntry(key);
  const avatarHtml = entry.kind === 'room'
    ? groupAvatar(entry.room, 28, `ctx:group:${entry.id}`)
    : avatar(entry.id, 28, `ctx:${entry.id}`);
  const folderOptions = `
    <button type="button" class="floating-menu-sub-item" data-action="home-move" data-key="${esc(key)}" data-folder="">
      ${icon('folder', 15)}<span>主要</span>${currentFolder === null ? icon('check', 15) : ''}
    </button>
    ${homeOrg.folders.map(f => `<button type="button" class="floating-menu-sub-item" data-action="home-move" data-key="${esc(key)}" data-folder="${esc(f.id)}">
      ${icon('folder', 15)}<span>${esc(f.name)}</span>${currentFolder === f.id ? icon('check', 15) : ''}
    </button>`).join('')}
    <button type="button" class="floating-menu-sub-item accent" data-action="home-new-folder" data-key="${esc(key)}">
      ${icon('folderPlus', 15)}<span>新建分组</span>
    </button>`;
  openFloatingContextMenu(x, y, `
    <div class="floating-menu-preview">
      <div class="floating-menu-preview-head">${avatarHtml}<strong>${esc(entry.title)}</strong></div>
      <div class="floating-menu-preview-bubble">${esc(entry.fullPreview)}</div>
    </div>
    <button type="button" class="floating-menu-item" data-action="home-pin" data-key="${esc(key)}">${icon('pin', 16)}<span>${pinned ? '取消置顶' : '置顶'}</span></button>
    <button type="button" class="floating-menu-item" data-action="home-toggle-move">${icon('folder', 16)}<span>移动到</span>${icon('chevronDown', 15)}</button>
    <div class="floating-menu-sub" hidden>${folderOptions}</div>
    ${entry.roomId ? `<button type="button" class="floating-menu-item" data-action="home-details" data-room="${esc(entry.roomId)}">${icon('info', 16)}<span>会话详情</span></button>`
      : `<button type="button" class="floating-menu-item" data-action="home-details" data-bot="${esc(entry.botId)}">${icon('settings', 16)}<span>Bot 设置</span></button>`}
    <div class="floating-menu-sep"></div>
    <button type="button" class="floating-menu-item danger" data-action="home-hide" data-key="${esc(key)}">${icon('eyeOff', 16)}<span>隐藏</span></button>
  `);
}
function openHomeFolderContextMenu(folderId, x, y) {
  const folder = homeOrg.folders.find(f => f.id === folderId);
  if (!folder) return;
  openFloatingContextMenu(x, y, `
    <button type="button" class="floating-menu-item" data-action="folder-rename" data-id="${esc(folder.id)}">${icon('edit', 16)}<span>重命名分组</span></button>
    <button type="button" class="floating-menu-item danger" data-action="folder-delete" data-id="${esc(folder.id)}">${icon('close', 16)}<span>删除分组</span></button>
  `);
}
function openHiddenConversationsModal() {
  const hiddenSet = new Set(homeOrg.hiddenKeys);
  const hidden = buildHomeEntries().filter(entry => hiddenSet.has(entry.key));
  const body = hidden.length
    ? `<div class="hidden-list">${hidden.map(entry => `<div class="hidden-list-row">
        <div class="hidden-list-copy"><strong>${esc(entry.title)}</strong><small>${esc(entry.preview)}</small></div>
        <button type="button" class="secondary-button" data-action="home-restore" data-key="${esc(entry.key)}">取消隐藏</button>
      </div>`).join('')}</div>`
    : '<p class="panel-empty">没有已隐藏的对话</p>';
  openModal('已隐藏对话', '点击“取消隐藏”可恢复显示在侧栏列表中。', body);
}
document.addEventListener('contextmenu', event => {
  const entryEl = event.target.closest('[data-home-key]');
  if (entryEl) {
    event.preventDefault();
    openHomeEntryContextMenu(entryEl.dataset.homeKey, event.clientX, event.clientY);
    return;
  }
  const folderEl = event.target.closest('.folder-header[data-folder-id]');
  if (folderEl) {
    event.preventDefault();
    openHomeFolderContextMenu(folderEl.dataset.folderId, event.clientX, event.clientY);
  }
});
document.addEventListener('click', event => {
  if (event.target.id === 'lightbox') { event.target.hidden = true; event.target.innerHTML = ''; return; }
  if (event.target.closest('summon-wordmark') && ui.view !== 'chat') { void navigate('chat'); return; }
  const button = event.target.closest('[data-action]');
  if (button?.dataset.action === 'home-toggle-move') {
    const sub = button.nextElementSibling;
    if (sub?.classList.contains('floating-menu-sub')) sub.hidden = !sub.hidden;
    button.classList.toggle('expanded', !sub?.hidden);
    return;
  }
  if (!event.target.closest('.menu-anchor,.context-menu,.floating-context-menu') || button?.closest('.context-menu,.floating-context-menu')) closeFloatingMenus();
  if (button && !button.disabled) act(button.dataset.action, button).catch(error => toast(error.message, true));
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeFloatingMenus();
    const lb = $('#lightbox'); if (lb && !lb.hidden) { lb.hidden = true; lb.innerHTML = ''; }
    if (ui.detailOpen && !$('#modal')?.open) { ui.detailOpen = false; ui.profileBotId = null; render(); }
  }
});
document.addEventListener('summon-selection-warning', event => toast(event.detail, true));
document.addEventListener('input', event => {
  if (event.target.id === 'display-zoom') return changeDisplayPreference('zoom', Number(event.target.value));
  if (event.target.id === 'display-font') return changeDisplayPreference('font', Number(event.target.value));
  if (event.target.id === 'create-bot-name') $('#create-bot-submit').disabled = !event.target.value.trim();
  if (event.target.id === 'message-input') { ui.drafts[event.target.form.dataset.roomId] = event.target.value; resizeComposer(event.target); persistClientSession(); }
  if (event.target.id === 'room-search') { ui.roomQuery = event.target.value; renderTopbar(); }
  const form = event.target.closest('.execution-input-form');
  if (form && ['input','structured'].includes(event.target.name)) {
    const entry = ui.executionInputs.get(form.dataset.input) || {};
    if (event.target.name === 'structured') entry.structured = event.target.checked;
    else entry.text = event.target.value;
    ui.executionInputs.set(form.dataset.input, entry);
    persistClientSession();
  }
});
document.addEventListener('keydown', event => { if (event.target.id === 'message-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); const button = $('#message-form button[type=submit]'); if (!button?.disabled) $('#message-form')?.requestSubmit(); } });
document.addEventListener('compositionstart', event => { if (event.target.id === 'message-input') ui.composing = true; });
document.addEventListener('compositionend', event => { if (event.target.id !== 'message-input') return; ui.composing = false; ui.drafts[event.target.form.dataset.roomId] = event.target.value; persistClientSession(); if (ui.renderDeferred) render(); });
document.addEventListener('submit', event => {
  const form = event.target;
  if (form.id !== 'message-form' && !form.matches('.execution-input-form')) return;
  event.preventDefault();
  const action = form.id === 'message-form' ? submitRoomMessage(form) : submitExecutionInput(form);
  void action.catch(error => toast(error.message,true));
});

async function submitRoomMessage(form) {
  const room = roomById(form.dataset.roomId);
  if (!room || sendBusy(room.id)) return;
  const text = form.elements.content.value, attachments = attachmentDrafts(room.id), references = ui.draftReferences[room.id] || [];
  if (!text.trim() && !attachments.length && !references.length) return;
  const payload = { text, mentions:selectedMentions(room), references, attachments:attachments.map(item => ({ kind:'file',id:item.attachment.id })),
    ...(ui.reply?.roomId === room.id ? { reply_to:messageRef(ui.reply.id) } : {}) };
  const entry = queueLocalMessage(room.id,payload,attachments);
  for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
  ui.drafts[room.id] = ''; ui.draftTargets[room.id] = []; ui.draftAttachments[room.id] = []; ui.draftReferences[room.id] = [];
  if (ui.reply?.roomId === room.id) ui.reply = null;
  await sendLocalMessage(entry,true);
}

async function submitExecutionInput(form) {
  const detail = ui.executionDetail;
  const option = detail && inputOptions(detail).find(item => item.key === form.dataset.input);
  if (!option || !ui.protocolReady) return;
  const text = form.elements.input.value;
  if (!text.length) return;
  const entry = ui.executionInputs.get(option.key) || {};
  if (entry.busy || entry.submitted) return;
  const structured = form.elements.structured?.checked === true;
  let input = text;
  if (structured) {
    try { input = JSON.parse(text); }
    catch { throw new Error('JSON 输入格式无效。'); }
  }
  if (entry.submittedText !== text || (entry.submittedStructured === true) !== structured) entry.clientId = newClientId();
  Object.assign(entry,{ text,structured,submittedText:text,submittedStructured:structured,busy:true }); ui.executionInputs.set(option.key,entry);
  render();
  try {
    await persistClientSession();
    const receipt = await api('/api/executions/input','POST',{ target:detail.execution_ref,kind:option.kind,control_version:detail.control_version,
      input_target:option.input_target,input },{ clientId:entry.clientId });
    entry.receipt = { status:receipt.status, call_id:receipt.call_id };
    entry.submitted = !['unknown','prepared','not_submitted','failed','unsupported'].includes(receipt.status);
    await refresh();
  } finally { entry.busy = false; render(); }
}
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
  return window.SummonAvatars.normalize({ ...window.SummonAvatars.defaults(bot?.id || '', index), ...(bot?.avatar || {}) });
}
function face(config, size = 60, options = {}) { return window.SummonAvatars ? window.SummonAvatars.render(config, size, options) : `<span class="face-fallback" style="width:${size}px;height:${size}px;background:${esc(config?.color || '#959595')}"></span>`; }
function avatar(id, large = false, key = `bot:${id}`) {
  const size = typeof large === 'number' ? large : large ? 104 : 60;
  if (id === 'user') return `<img class="user-avatar" src="/icons/user-avatar.jpg?v=owner-20261028" width="${size}" height="${size}" style="width:${size}px;height:${size}px" alt="" aria-hidden="true">`;
  if (!botById(id)) return `<span class="system-avatar" style="width:${size}px;height:${size}px">${icon(String(id).startsWith('executor:') ? 'computer' : 'event', Math.round(size * .5))}</span>`;
  const motion = ({ paused:'sleep', running:'orbit', waiting:'notify' })[botActivity(botById(id)).kind] || 'idle';
  return `<span class="bot-avatar" style="width:${size}px;height:${size}px" aria-hidden="true">${face(botAvatar(id), size, { key, identity: `bot:${id}`, state: motion })}</span>`;
}
function groupAvatar(room, size = 96, key = `group:${room?.id}:${size}`) {
  const members = (room?.members || []).filter(id => id === 'user' || botById(id)).slice(0, 4);
  if (!members.length) return `<span class="group-avatar group-avatar-empty" style="width:${size}px;height:${size}px">${icon('chat', Math.round(size * .6))}</span>`;
  return `<span class="group-avatar" data-count="${members.length}" style="width:${size}px;height:${size}px">${members.map((id, index) => `<span class="group-face pos-${index}">${avatar(id, members.length === 1 ? size : Math.round(size * .64), `${key}:${index}`)}</span>`).join('')}</span>`;
}
function currentBot() {
  const room = roomById(ui.roomId);
  return directRoom(room) ? botById(room.members.find(id => id !== 'user')) : null;
}
function profileBot() { return ui.profileBotId ? botById(ui.profileBotId) : currentBot(); }
function currentAccent() { const bot = currentBot() || (roomById(ui.roomId)?.members || []).map(id => botById(id)).find(Boolean); return bot ? botAvatar(bot).color : '#222222'; }
function ownerName() { return state.user?.name || state.owner?.name || 'Lin'; }
function directRoom(room) { return room?.mode ? room.mode === 'direct' : room?.members?.length === 2 && room.members.includes('user'); }
function botActivity(bot) {
  if (bot.enabled === false) return { kind:'paused', text:'Bot 已暂停' };
  const execution = [...state.executions, ...(ui.roomExecutions || [])].find(item =>
    (item.bot_id === bot.id || item.execution_actor?.id === bot.id) && ['running', 'waiting', 'needs_input', 'awaiting_input'].includes(item.status));
  return execution ? { kind:execution.status === 'running' ? 'running' : 'waiting', text:labels[execution.status] || '待输入' }
    : { kind:'idle', text:'启用' };
}
function messagePreview(message) { return message?.content?.replace(/\s+/g, ' ').trim() || message?.attachments?.map(file => file.name).join('、') || (message?.references?.length ? '共享了引用' : '消息'); }
function roomPreview(room) {
  const message = room.lastMessage;
  return message ? nameOf(message.senderId) + ' · ' + messagePreview(message) : '还没有消息';
}
function roomReadMarkers() {
  if (ui.readMarkersEpoch !== ui.historyEpoch || !ui.readMarkers) {
    ui.readMarkersEpoch = ui.historyEpoch;
    try { const saved = JSON.parse(localStorage.getItem('summon:room-read-markers:v1')); ui.readMarkers = saved?.historyEpoch === (ui.historyEpoch ?? null) ? saved.rooms || {} : {}; }
    catch { ui.readMarkers = {}; }
  }
  return ui.readMarkers;
}
function saveRoomReadMarkers() { try { localStorage.setItem('summon:room-read-markers:v1', JSON.stringify({ historyEpoch: ui.historyEpoch ?? null, rooms: ui.readMarkers })); } catch {} }
function markCurrentRoomRead() {
  if (ui.view !== 'chat' || document.hidden || displayMedia.matches && !ui.mobileRoom || ui.messagesRoomId !== ui.roomId) return;
  const last = ui.messages.at(-1);
  if (!last?.createdAt) return;
  const markers = roomReadMarkers();
  if (compareMessagePosition(last, markers[ui.roomId]) > 0) {
    markers[ui.roomId] = { createdAt:last.createdAt, sequence:last.sequence }; saveRoomReadMarkers();
    renderTopbar();
  }
}
function compareMessagePosition(message, marker) {
  if (!marker) return 1;
  return String(message.createdAt).localeCompare(marker.createdAt ?? marker) || (message.sequence ?? 0) - (marker.sequence ?? 0);
}
function unreadRoomBadge(room) {
  const count = Number(room.unreadCount);
  if (Number.isFinite(count) && count > 0) return `<span class="unread-count" aria-label="${count} 条未读">${count > 99 ? '99+' : count}</span>`;
  const markers = roomReadMarkers(), last = room.lastMessage;
  if (!last?.createdAt) return '';
  if (last.senderId === 'user' || compareMessagePosition(last, markers[room.id]) <= 0) return '';
  const known = ui.messageCache.get(room.id)?.messages?.filter(message => message.senderId !== 'user' && compareMessagePosition(message, markers[room.id]) > 0).length;
  return known ? `<span class="unread-count" aria-label="${known} 条未读">${known > 99 ? '99+' : known}</span>` : '<i class="unread-dot" aria-label="有新消息"></i>';
}
function botConversation(botId) {
  return state.rooms.filter(room => directRoom(room) && room.members.includes(botId)).sort(recentConversations)[0];
}
function conversationUpdatedAt(room) { return room?.lastMessage?.createdAt || room?.updatedAt || room?.createdAt || ''; }
function recentConversations(a, b) { return String(conversationUpdatedAt(b)).localeCompare(String(conversationUpdatedAt(a))); }
function renderContactTime(room) {
  const time = room?.lastMessage?.createdAt;
  return time ? `<time class="contact-time" datetime="${esc(time)}" title="${esc(formatTime(time, true))}">${esc(contactTime(time))}</time>` : '';
}
const homeOrgStorageKey = 'summon:homeOrg:v1';
function loadHomeOrg() {
  try {
    const raw = JSON.parse(localStorage.getItem(homeOrgStorageKey) || '{}');
    return {
      pinnedKeys: Array.isArray(raw.pinnedKeys) ? raw.pinnedKeys : [],
      hiddenKeys: Array.isArray(raw.hiddenKeys) ? raw.hiddenKeys : [],
      folders: Array.isArray(raw.folders) ? raw.folders.filter(f => f && typeof f.id === 'string' && typeof f.name === 'string') : [],
      collapsedIds: Array.isArray(raw.collapsedIds) ? raw.collapsedIds : [],
    };
  } catch {
    return { pinnedKeys: [], hiddenKeys: [], folders: [], collapsedIds: [] };
  }
}
let homeOrg = loadHomeOrg();
function saveHomeOrg() {
  try { localStorage.setItem(homeOrgStorageKey, JSON.stringify(homeOrg)); } catch {}
}
const isPinnedEntry = key => homeOrg.pinnedKeys.includes(key);
const isHiddenEntry = key => homeOrg.hiddenKeys.includes(key);
const isFolderCollapsed = id => homeOrg.collapsedIds.includes(id);
const folderIdForEntry = key => homeOrg.folders.find(f => Array.isArray(f.keys) && f.keys.includes(key))?.id || null;
function togglePinEntry(key) {
  if (isPinnedEntry(key)) homeOrg.pinnedKeys = homeOrg.pinnedKeys.filter(k => k !== key);
  else {
    homeOrg.hiddenKeys = homeOrg.hiddenKeys.filter(k => k !== key);
    homeOrg.pinnedKeys = [...homeOrg.pinnedKeys, key];
  }
  saveHomeOrg(); renderTopbar();
}
function setHiddenEntry(key, hidden) {
  if (hidden) {
    homeOrg.pinnedKeys = homeOrg.pinnedKeys.filter(k => k !== key);
    if (!homeOrg.hiddenKeys.includes(key)) homeOrg.hiddenKeys = [...homeOrg.hiddenKeys, key];
  } else {
    homeOrg.hiddenKeys = homeOrg.hiddenKeys.filter(k => k !== key);
  }
  saveHomeOrg(); renderTopbar();
}
function moveEntryToFolder(key, folderId) {
  homeOrg.folders = homeOrg.folders.map(f => {
    const stripped = (f.keys || []).filter(k => k !== key);
    return f.id === folderId ? { ...f, keys: [...stripped, key] } : { ...f, keys: stripped };
  });
  saveHomeOrg(); renderTopbar();
}
function toggleFolderCollapsed(id) {
  if (isFolderCollapsed(id)) homeOrg.collapsedIds = homeOrg.collapsedIds.filter(x => x !== id);
  else homeOrg.collapsedIds = [...homeOrg.collapsedIds, id];
  saveHomeOrg(); renderTopbar();
}
function createHomeFolder(rawName, moveKey = null) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  const folder = { id: newClientId(), name, keys: moveKey ? [moveKey] : [] };
  if (moveKey) homeOrg.folders = homeOrg.folders.map(f => ({ ...f, keys: (f.keys || []).filter(k => k !== moveKey) }));
  homeOrg.folders = [...homeOrg.folders, folder];
  saveHomeOrg(); renderTopbar();
  return folder;
}
function renameHomeFolder(id, rawName) {
  const name = String(rawName || '').trim();
  if (!name) return;
  homeOrg.folders = homeOrg.folders.map(f => f.id === id ? { ...f, name } : f);
  saveHomeOrg(); renderTopbar();
}
function deleteHomeFolder(id) {
  homeOrg.folders = homeOrg.folders.filter(f => f.id !== id);
  homeOrg.collapsedIds = homeOrg.collapsedIds.filter(x => x !== id);
  saveHomeOrg(); renderTopbar();
}
function buildHomeEntries() {
  const dmByBot = new Map();
  for (const bot of state.bots) {
    const dm = botConversation(bot.id);
    if (dm) dmByBot.set(bot.id, dm);
  }
  const primaryDirectIds = new Set([...dmByBot.values()].map(r => r.id));
  const entries = [];
  for (const room of state.rooms) {
    if (primaryDirectIds.has(room.id)) continue;
    const last = room.lastMessage;
    const preview = last ? roomPreview(room) : '开始聊天';
    const fullPreview = last?.content?.trim() || preview;
    entries.push({
      key: `room:${room.id}`,
      kind: 'room',
      id: room.id,
      room,
      roomId: room.id,
      botId: null,
      title: room.name,
      preview,
      fullPreview,
      sortDate: conversationUpdatedAt(room),
      running: false,
      paused: false,
      live: ui.streamConnected && !ui.connectionNotice,
      selected: room.id === ui.roomId && ui.view === 'chat',
    });
  }
  const activeBot = currentBot();
  for (const bot of state.bots) {
    const dm = dmByBot.get(bot.id) || null;
    const activity = botActivity(bot);
    const live = ui.streamConnected && !ui.connectionNotice;
    const running = live && ['running', 'waiting'].includes(activity.kind);
    const paused = activity.kind === 'paused';
    const preview = running || paused ? activity.text : dm?.lastMessage ? roomPreview(dm) : '发起对话';
    const fullPreview = paused ? '该 Bot 当前已暂停。' : dm?.lastMessage?.content?.trim() || preview;
    entries.push({
      key: `bot:${bot.id}`,
      kind: 'bot',
      id: bot.id,
      bot,
      room: dm,
      roomId: dm?.id || null,
      botId: bot.id,
      title: bot.name,
      preview,
      fullPreview,
      sortDate: conversationUpdatedAt(dm),
      running,
      paused,
      live,
      activity,
      selected: ui.view === 'chat' && activeBot?.id === bot.id && !ui.profileBotId,
    });
  }
  return entries.sort((a, b) => String(b.sortDate).localeCompare(String(a.sortDate)) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
}
function renderHomePinnedTile(entry) {
  const avatarHtml = entry.kind === 'room'
    ? groupAvatar(entry.room, 60, `pinned:group:${entry.id}`)
    : avatar(entry.id, 60, `pinned:${entry.id}`);
  const badge = entry.room ? unreadRoomBadge(entry.room) : '';
  return `<button type="button" class="pinned-tile ${entry.selected ? 'selected' : ''}" data-action="${entry.kind === 'room' ? 'select-room' : 'dm-bot'}" data-id="${esc(entry.id)}" data-home-key="${esc(entry.key)}" title="${esc(entry.title)}">
    <span class="pinned-tile-avatar">${avatarHtml}${badge}</span>
    <span class="pinned-tile-title">${esc(entry.title)}</span>
  </button>`;
}
function renderHomeEntryRow(entry) {
  if (entry.kind === 'room') {
    return `<button class="contact-row ${entry.selected ? 'selected' : ''}" data-action="select-room" data-id="${esc(entry.id)}" data-home-key="${esc(entry.key)}" ${entry.selected ? 'aria-current="page"' : ''} title="${esc(entry.title)}">
      <span class="contact-avatar-wrap">${groupAvatar(entry.room, 44, `sidebar:group:${entry.id}`)}</span>
      <span class="contact-copy"><span class="contact-heading"><strong>${esc(entry.title)}</strong>${renderContactTime(entry.room)}</span><span class="contact-preview">${esc(entry.preview)}</span></span>
      ${unreadRoomBadge(entry.room)}
    </button>`;
  }
  return `<button class="contact-row ${entry.selected ? 'selected' : ''}" data-action="dm-bot" data-id="${esc(entry.id)}" data-home-key="${esc(entry.key)}" ${entry.selected ? 'aria-current="page"' : ''} style="--member-color:${esc(botAvatar(entry.bot).color)}" title="${esc(entry.title)} · ${esc(entry.live ? entry.activity.text : '状态待同步')}">
    <span class="contact-avatar-wrap">${avatar(entry.id, 44, `sidebar:${entry.id}`)}<i class="presence-dot ${entry.live ? entry.activity.kind : 'unknown'}" aria-hidden="true"></i></span>
    <span class="contact-copy"><span class="contact-heading"><strong>${esc(entry.title)}</strong>${renderContactTime(entry.room)}</span><span class="contact-preview ${entry.running ? 'is-working' : ''}">${esc(entry.preview)}</span></span>
    ${entry.room ? unreadRoomBadge(entry.room) : ''}
  </button>`;
}
function renderTopbar() {
  const sidebar = $('#contact-sidebar'), oldTop = $('.contacts-scroll')?.scrollTop || 0;
  const query = ui.roomQuery.trim().toLowerCase();
  const allEntries = buildHomeEntries();
  const hiddenSet = new Set(homeOrg.hiddenKeys);
  const visibleEntries = allEntries.filter(entry => !hiddenSet.has(entry.key));
  const filteredEntries = query
    ? visibleEntries.filter(entry => entry.title.toLowerCase().includes(query) || entry.preview.toLowerCase().includes(query))
    : visibleEntries;
  const byKey = new Map(visibleEntries.map(entry => [entry.key, entry]));
  const pinnedEntries = query ? [] : homeOrg.pinnedKeys.map(key => byKey.get(key)).filter(Boolean);
  const pinnedSet = new Set(homeOrg.pinnedKeys);
  const unpinnedEntries = query ? filteredEntries : filteredEntries.filter(entry => !pinnedSet.has(entry.key));
  const assignedKeys = new Set(homeOrg.folders.flatMap(f => f.keys || []));
  const defaultEntries = unpinnedEntries.filter(entry => !assignedKeys.has(entry.key));
  let contactsHtml = '';
  if (pinnedEntries.length) {
    contactsHtml += `<section class="sidebar-section pinned-section"><div class="pinned-shelf">${pinnedEntries.map(renderHomePinnedTile).join('')}</div></section>`;
  }
  if (query) {
    contactsHtml += `<section class="sidebar-section"><div class="bot-contacts">${filteredEntries.map(renderHomeEntryRow).join('') || '<p class="sidebar-empty">没有匹配的对话</p>'}</div></section>`;
  } else {
    if (defaultEntries.length || !homeOrg.folders.length) {
      const collapsed = isFolderCollapsed('__default__');
      contactsHtml += `<section class="sidebar-section folder-section ${collapsed ? 'is-collapsed' : ''}"><button type="button" class="folder-header ${collapsed ? 'collapsed' : ''}" data-action="toggle-folder" data-id="__default__"><span class="folder-header-label"><span>主要</span>${icon('chevronDown', 13)}</span><span class="folder-count">${defaultEntries.length}</span></button>
        <div class="bot-contacts">${defaultEntries.map(renderHomeEntryRow).join('') || '<p class="sidebar-empty">还没有对话</p>'}</div></section>`;
    }
    for (const folder of homeOrg.folders) {
      const folderKeys = new Set(folder.keys || []);
      const folderEntries = unpinnedEntries.filter(entry => folderKeys.has(entry.key));
      const collapsed = isFolderCollapsed(folder.id);
      contactsHtml += `<section class="sidebar-section folder-section ${collapsed ? 'is-collapsed' : ''}"><button type="button" class="folder-header ${collapsed ? 'collapsed' : ''}" data-action="toggle-folder" data-id="${esc(folder.id)}" data-folder-id="${esc(folder.id)}"><span class="folder-header-label"><span>${esc(folder.name)}</span>${icon('chevronDown', 13)}</span><span class="folder-count">${folderEntries.length}</span></button>
        <div class="bot-contacts">${folderEntries.map(renderHomeEntryRow).join('') || '<p class="sidebar-empty">右键任意对话可移入此分组</p>'}</div></section>`;
    }
  }
  const menu = ui.menu === 'create' ? `<div class="context-menu create-menu"><button data-action="new-bot">${icon('person', 19)}创建 Bot</button><button data-action="new-room">${icon('people', 19)}创建群聊</button></div>` : '';
  const hiddenCount = allEntries.filter(entry => hiddenSet.has(entry.key)).length;
  const settings = ui.menu === 'apps' ? `<div class="context-menu apps-menu">
    ${tabs.filter(tab => tab.id !== 'chat').map(tab => `<button data-action="navigate" data-view="${tab.id}">${icon(tab.icon, 19)}${tab.title}</button>`).join('')}
    ${hiddenCount ? `<button data-action="manage-hidden">${icon('eyeOff', 19)}已隐藏对话（${hiddenCount}）</button>` : ''}
    ${window.SummonDesktop?.openConnectionSettings ? `<button data-action="desktop-connection">${icon('computer', 19)}实例连接</button>` : ''}
    <button data-action="display-settings">${icon('settings', 19)}显示设置</button>
    <button data-action="client-downloads">${icon('install', 19)}客户端下载与更新</button>
    <button data-action="update-app">${icon('refresh', 19)}刷新页面</button></div>` : '';
  const connected = ui.streamConnected && ui.protocolReady;
  const html = `<div class="sidebar-toolbar"><summon-wordmark></summon-wordmark>
      <div class="search-slot ${ui.searchOpen ? 'open' : ''}">${ui.searchOpen ? `<input id="room-search" value="${esc(ui.roomQuery)}" placeholder="搜索会话与 Bot" aria-label="搜索会话与 Bot">` : ''}
        <button class="round-button" data-action="toggle-search" title="搜索" aria-label="搜索">${icon('search', 20)}</button></div>
      <div class="menu-anchor"><button class="round-button create-button" data-action="toggle-create" aria-label="新建" aria-expanded="${ui.menu === 'create'}">${icon('plus', 23)}</button>${menu}</div></div>
    <div class="contacts-scroll">${contactsHtml}</div>
    <div class="sidebar-controls">
      <div class="rail-quick-actions">
        <div class="menu-anchor"><button type="button" class="rail-action-btn" data-action="toggle-create" title="新建" aria-label="新建" aria-expanded="${ui.menu === 'create'}">${icon('plus', 20)}</button>${menu}</div>
        <button type="button" class="rail-action-btn" data-action="display-settings" title="显示设置" aria-label="显示设置">${icon('settings', 18)}</button>
      </div>
      <nav class="sidebar-shortcuts" aria-label="常用功能">
      <button class="${ui.view === 'executions' ? 'selected' : ''}" data-action="navigate" data-view="executions">${icon('computer', 17)}<span>执行</span></button>
      <button class="${ui.view === 'files' ? 'selected' : ''}" data-action="navigate" data-view="files">${icon('knowledge', 17)}<span>资料</span></button></nav>
    <div class="sidebar-footer"><div class="menu-anchor sidebar-owner-anchor">
      <button class="sidebar-owner" data-action="toggle-apps" aria-label="设置" aria-expanded="${ui.menu === 'apps'}">
      <span class="sidebar-owner-visual"><span class="contact-avatar-wrap"><img class="sidebar-owner-frame" src="/icons/owner-paper-frame.png" width="100" height="100" alt="">
        ${avatar('user', 48)}<i class="presence-dot ${connected ? 'idle' : 'unknown'}" aria-hidden="true"></i></span></span>
      <span class="sidebar-owner-name">${esc(ownerName())}</span></button>${settings}</div>
      ${globalThis.SummonModels.sidebar({ esc, icon, invalidate:() => { ui.lastSidebarHtml = null; } })}</div></div>`;
  const signature = renderSignature(html);
  if (ui.lastSidebarHtml !== signature) {
    const motion = captureMotion(sidebar), toolbar = $('.sidebar-toolbar',sidebar);
    const searchActive = document.activeElement?.id === 'room-search';
    const searchIndex = searchActive ? document.activeElement.selectionStart : 0;
    const next = document.createElement('template');
    next.innerHTML = html;
    if (toolbar) {
      const wordmark = $('summon-wordmark',toolbar), replacement = $('.sidebar-toolbar',next.content);
      for (const node of [...toolbar.childNodes]) if (node !== wordmark) node.remove();
      toolbar.append(...[...replacement.children].filter(node => node.localName !== 'summon-wordmark'));
      replacement.remove();
      for (const node of [...sidebar.childNodes]) if (node !== toolbar) node.remove();
      sidebar.append(next.content);
    } else sidebar.replaceChildren(next.content);
    ui.lastSidebarHtml = signature; hydrateMotion(sidebar, motion);
    if (searchActive) { const search = $('#room-search'); search?.focus(); search?.setSelectionRange(searchIndex, searchIndex); }
  }
  if ($('.contacts-scroll')) $('.contacts-scroll').scrollTop = oldTop;
  $('.app-shell').classList.toggle('mobile-room', ui.view === 'chat' && ui.mobileRoom);
  $('.app-shell').classList.toggle('management-open', ui.view !== 'chat');
}

function richText(value) {
  const regex = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let result = '', last = 0, match;
  const formatInline = text => text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((segment, index) => {
    if (index % 2 && segment.startsWith('`')) return `<code>${esc(segment.slice(1, -1))}</code>`;
    if (index % 2) return `<strong>${esc(segment.slice(2, -2))}</strong>`;
    return esc(segment);
  }).join('').replace(/^[-*] (.+)$/gm, '<span class="markdown-li">$1</span>');
  while ((match = regex.exec(String(value || ''))) !== null) {
    if (match.index > last) result += formatInline(String(value).slice(last, match.index));
    const lang = match[1] || 'code', code = match[2].replace(/\n$/, '');
    result += `<div class="code-block"><div class="code-head"><span>${esc(lang)}</span><button type="button" class="code-copy" data-action="copy-code">复制</button></div><pre><code>${esc(code)}</code></pre></div>`;
    last = regex.lastIndex;
  }
  if (last < String(value || '').length) result += formatInline(String(value).slice(last));
  return result;
}
function botMention(id, label) {
  const bot = botById(id); if (!bot) return esc(label || nameOf(id));
  return `<button type="button" class="bot-mention" data-action="open-bot-details" data-id="${esc(id)}" style="--member-color:${esc(botAvatar(bot).color)}">${avatar(id, 25, '')}<span>@${esc(label || bot.name)}</span></button>`;
}
const refType = { room:'会话', event:'消息', file:'文件', bot:'Bot', session:'执行会话', conversation:'内部对话', call:'调用', wakeup:'订阅', connection:'连接' };
const roomRef = id => ({ kind:'room', id });
const messageRef = id => ({ kind:'event', id });

function refLabel(ref) {
  if (ref.kind === 'event') return ui.messages.find(item => item.id === ref.id) ? messagePreview(ui.messages.find(item => item.id === ref.id)) : '消息 ' + ref.id;
  if (ref.kind === 'file') return [...state.files, ...(ui.roomFiles || [])].find(item => item.id === ref.id)?.name || '文件 ' + ref.id;
  if (ref.kind === 'room') return roomById(ref.id)?.name || ref.id;
  if (ref.kind === 'bot') return nameOf(ref.id);
  return (refType[ref.kind] || ref.kind) + ' ' + ref.id;
}

function renderReference(ref, action = 'open-reference') {
  return `<button type="button" class="reference-chip" data-action="${action}" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">${icon(ref.kind === 'file' ? 'file' : 'link', 14)}<span>${esc(refLabel(ref))}</span></button>`;
}

function renderMessageSummaries(message) {
  if (message._delivery) return '';
  const items = ui.roomSummaries.get(message.id);
  if (!items?.length) return '';
  const open = ui.expandedSummaries?.has(message.id);
  const badge = items.length === 1 ? `快读摘要 · ${nameOf(items[0].bot_id)}` : `快读摘要 · ${items.length} 位伙伴`;
  const preview = items[0]?.summary || '';
  return `<details class="message-summaries" data-summary-id="${esc(message.id)}" ${open ? 'open' : ''}>
    <summary><span class="summary-badge">${esc(badge)}</span>${preview ? `<span class="summary-preview">${esc(preview)}</span>` : ''}</summary>
    <div class="message-summaries-list">${items.map(item =>
      `<div class="message-summary-item"><strong>${esc(nameOf(item.bot_id))}</strong><span>${esc(item.summary)}</span></div>`).join('')}</div>
  </details>`;
}

function renderDelivery(message) {
  if (message._delivery) return renderSendStatus(message);
  return '';
}

function renderChatMessage(message, timeline, grouped, isGroup) {
  const sender = message.senderId, own = sender === 'user', platform = ['system', 'platform'].includes(sender);
  const parent = timeline.find(item => item.id === message.replyTo);
  const pinned = roomById(ui.roomId)?.pins.some(ref => ref.kind === 'event' && ref.id === message.id);
  const mentions = message.mentions || [];
  const identity = own || grouped || (!isGroup && !platform) ? '' : `<div class="message-identity"><strong>${esc(nameOf(sender))}</strong><time datetime="${esc(message.createdAt)}" title="${esc(formatTime(message.createdAt,true))}">${formatTime(message.createdAt)}</time></div>`;
  const ownTime = own && message.createdAt ? `<time class="outgoing-time" datetime="${esc(message.createdAt)}" title="${esc(formatTime(message.createdAt,true))}">${formatTime(message.createdAt)}</time>` : '';
  const avatarSlot = own || (!isGroup && !platform) ? '' : grouped ? '<span class="message-avatar-spacer"></span>' : botById(sender)
    ? `<button class="message-avatar-button" data-action="open-bot-details" data-id="${esc(sender)}" aria-label="查看 ${esc(nameOf(sender))}">${avatar(sender,36,'message:' + message.id)}</button>`
    : `<span class="message-avatar">${avatar(sender,36,'message:' + message.id)}</span>`;
  const reply = message.replyTo ? `<button type="button" class="reply-quote" data-action="open-reference" data-kind="event" data-id="${esc(message.replyTo)}">
    <strong>${esc(parent ? nameOf(parent.senderId) : '引用消息')}</strong><span>${esc(parent ? messagePreview(parent) : '查看原文')}</span></button>` : '';
  const actions = message._delivery ? '' : `<div class="bubble-actions">
    <button data-action="reply-message" data-id="${esc(message.id)}" title="回复" aria-label="回复">${icon('back',16)}</button>
    <button data-action="copy-message" data-id="${esc(message.id)}" title="复制" aria-label="复制">${icon('copy',15)}</button>
    <button data-action="${pinned ? 'unpin' : 'pin'}" data-kind="event" data-id="${esc(message.id)}" title="${pinned ? '取消置顶' : '置顶'}" aria-label="${pinned ? '取消置顶' : '置顶'}">${icon('pin',16)}</button>
  </div>`;
  return `<article data-message-id="${esc(message.id)}" data-motion-key="message:${esc(message.clientId || message.id)}"
      class="chat-message ${own ? 'outgoing' : 'incoming'} ${isGroup ? 'in-group' : 'direct-message'} ${grouped ? 'continuation' : ''} ${platform ? 'system-message' : ''}"
      style="--member-color:${own || platform ? 'var(--accent)' : esc(botAvatar(sender).color)}">
    ${avatarSlot}
    <div class="bubble-column">${identity}<div class="message-bubble" tabindex="0">${reply}
      ${mentions.length ? `<div class="bubble-target">${mentions.map(id => id === 'user' ? `<span>@${esc(ownerName())}</span>` : botMention(id)).join('')}</div>` : ''}
      ${message.content ? `<div class="message-content">${richText(message.content)}</div>` : ''}
      ${renderMessageAttachments(message.attachments)}
      ${message.references?.length ? `<div class="reference-list">${message.references.map(ref => renderReference(ref)).join('')}</div>` : ''}
      ${ownTime}
    </div>${renderMessageSummaries(message)}${renderDelivery(message)}${actions}</div></article>`;
}

function renderChat() {
  const room = roomById(ui.roomId), bot = currentBot(), isGroup = !directRoom(room);
  const members = (room?.members || []).filter(id => id !== 'user').map(botById).filter(Boolean);
  const title = room?.name || '消息';
  const timeline = mergedRoomMessages(ui.roomId, ui.messages);
  let previousDay = '';
  const messages = timeline.map((message, index) => {
    const previous = timeline[index - 1];
    const elapsed = Date.parse(message.createdAt) - Date.parse(previous?.createdAt);
    const day = formatDay(message.createdAt);
    const divider = day !== previousDay ? `<div class="date-divider">${esc(day)}</div>` : '';
    const grouped = day === previousDay && previous?.senderId === message.senderId && elapsed >= 0 && elapsed <= 120000;
    previousDay = day;
    return divider + renderChatMessage(message, timeline, grouped, isGroup);
  }).join('');
  const subtitle = isGroup ? `${members.length} 位伙伴` : bot ? botActivity(bot).text : '';
  const header = `<div class="floating-header"><div class="header-left"><button class="mobile-back icon-button" data-action="room-back" aria-label="返回会话">${icon('chevronBack',23)}</button>
    <button type="button" class="sidebar-toggle-btn" data-action="toggle-sidebar" title="收起 / 展开侧栏" aria-label="收起 / 展开侧栏">${icon('panel',18)}</button></div>
    ${room ? `<button type="button" class="chat-title-pill" data-action="toggle-details" aria-expanded="${!!ui.detailOpen}" title="展开右侧会话详情侧栏">${bot ? avatar(bot.id,30,'slot:title') : groupAvatar(room,30,'slot:title-group')}
      <span class="chat-title-copy"><strong>${esc(title)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</span></button>` : ''}
    <div class="chat-header-actions"></div></div>`;
  const pins = room?.pins?.length ? `<div class="room-pins"><strong>置顶</strong>${room.pins.map(ref => renderReference(ref)).join('')}</div>` : '';
  const executions = ui.roomExecutions || [];
  const active = executions.length ? `<details class="conversation-activity" data-execution-disclosure ${ui.openRoomExecution === room.id ? 'open' : ''}><summary>执行过程（${executions.length}）</summary>
    ${executions.map(renderExecutionRow).join('')}</details>` : '';
  const body = room ? `<div class="messages ${isGroup ? 'group-messages' : ''}" role="log" aria-label="聊天记录">${pins}
      ${ui.historyCursor ? '<button class="text-button room-history" data-action="older-messages">更早的消息</button>' : ''}
      ${messages || `<div class="conversation-empty">${groupAvatar(room,86)}<p>${ui.messagesRoomId === room.id ? '还没有消息' : '正在读取消息…'}</p></div>`}${active}</div>
      ${renderChatComposer(room, members)}` : `<div class="conversation-empty"><p>${ui.protocolNotice || '选择一位伙伴或创建会话'}</p>
        ${ui.protocolReady ? '<button class="secondary-button" data-action="new-room">创建会话</button>' : ''}</div>`;
  return `<div data-room-id="${esc(ui.roomId)}" data-ready="${ui.messagesRoomId === ui.roomId}" class="chat-layout ${ui.detailOpen ? 'detail-open' : ''}"
    style="--accent:${esc(currentAccent())}"><section class="conversation">${header}${body}</section>${ui.detailOpen && room ? renderDetailPanel(room, ui.profileBotId ? profileBot() : null) : ''}</div>`;
}

function selectedMentions(room) {
  const value = ui.draftTargets[room.id];
  return (Array.isArray(value) ? value : value ? [value] : []).filter(id => room.members.includes(id));
}

function renderFloatingBotActivity(room, members) {
  const liveStatuses = new Set(['running', 'waiting', 'queued', 'needs_input', 'awaiting_input']);
  const seen = new Set(), items = [];
  for (const exec of ui.roomExecutions || []) {
    if (!liveStatuses.has(exec.status)) continue;
    const botId = exec.execution_actor?.id || exec.bot_id;
    if (!botId || !botById(botId) || seen.has(botId)) continue;
    seen.add(botId);
    const statusText = labels[exec.status] || '正在处理';
    items.push({ botId, label: `${nameOf(botId)} · ${statusText}`, ref: exec.execution_ref });
  }
  for (const member of members) {
    if (seen.has(member.id)) continue;
    const act = botActivity(member);
    if (['running', 'waiting'].includes(act.kind)) {
      seen.add(member.id);
      items.push({ botId: member.id, label: `${member.name} · ${act.text}`, ref: null });
    }
  }
  if (!items.length) return '';
  return `<div class="bot-activity-dock" aria-live="polite">${items.map(item => {
    const attrs = item.ref
      ? `data-action="open-execution" data-kind="${esc(item.ref.kind)}" data-id="${esc(item.ref.id)}"`
      : `data-action="open-bot-details" data-id="${esc(item.botId)}"`;
    return `<div class="bot-activity-row"><button type="button" class="activity-trigger" ${attrs}>${face(botAvatar(item.botId), 30, { key: `dock:${room.id}:${item.botId}`, identity: `bot:${item.botId}`, state: 'work' })}<span class="shimmer-status">${esc(item.label)}</span></button></div>`;
  }).join('')}</div>`;
}

function renderChatComposer(room, members) {
  const mentions = selectedMentions(room), references = ui.draftReferences[room.id] || [];
  const menu = ui.menu === 'mentions' ? `<div class="mention-menu context-menu" aria-label="@ 成员">${members.map(member => `<button type="button"
      class="mention-choice" data-action="toggle-mention" data-id="${esc(member.id)}" aria-pressed="${mentions.includes(member.id)}">
      ${avatar(member.id,32,'')}<span>${esc(member.name)}</span>${mentions.includes(member.id) ? icon('check',16) : ''}</button>`).join('')}</div>` : '';
  const reply = ui.reply?.roomId === room.id ? `<div class="reply-preview">${avatar(ui.reply.senderId,25,'')}<span>回复 ${esc(nameOf(ui.reply.senderId))}
    · ${esc(messagePreview(ui.reply))}</span><button type="button" class="icon-button" data-action="cancel-reply" aria-label="取消回复">${icon('close',16)}</button></div>` : '';
  const floatingActivity = renderFloatingBotActivity(room, members);
  return `<div class="composer-wrap">${floatingActivity}${reply}${renderAttachmentDrafts()}
    ${references.length ? `<div class="reference-list draft-references">${references.map(ref => `<span>${renderReference(ref)}
      <button type="button" class="icon-button" aria-label="移除引用" data-action="remove-reference" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">${icon('close',14)}</button></span>`).join('')}</div>` : ''}
    <form id="message-form" class="composer" data-room-id="${esc(room.id)}">
      <button class="composer-plus" type="button" data-action="attach-file" aria-label="添加附件" ${ui.sendingRooms.has(room.id) ? 'disabled' : ''}>${icon('plus',22)}</button>
      <textarea id="message-input" name="content" rows="1" maxlength="16000" aria-label="消息内容" placeholder="给 ${esc(room.name)} 发消息">${esc(ui.drafts[room.id] || '')}</textarea>
      <div class="composer-tools"><div class="menu-anchor">${members.length ? `<button class="composer-mention ${mentions.length ? 'has-target' : ''}" type="button"
        data-action="toggle-mention-menu" aria-label="@ 成员" aria-expanded="${ui.menu === 'mentions'}">${mentions.length ? esc(mentions.map(id => '@' + nameOf(id)).join(' ')) : '@'}</button>${menu}` : ''}</div>
        <button class="icon-button" type="button" data-action="add-reference" title="添加资料引用" aria-label="添加资料引用">${icon('link',18)}</button></div>
      <button type="submit" class="composer-send" ${sendBusy(room.id) ? 'disabled' : ''} aria-label="发送消息">${icon('send',22)}</button>
    </form><div class="composer-hint">Enter 发送<span> · </span>Shift + Enter 换行</div></div>`;
}

function renderDetailPanel(room, bot) {
  const tab = ui.detailTab;
  const tabs = bot ? [{ id:'details', label:'详情' }, { id:'library', label:'资料' }] :
    [{ id:'details', label:'关注' }, { id:'members', label:'成员' }, { id:'library', label:'资料' }, { id:'pins', label:'置顶' }];
  let body;
  if (bot && ui.avatarEditing) body = renderAvatarPicker('edit');
  else if (tab === 'members') {
    body = `<div class="profile-members">${room.members.map(id => `<button ${id === 'user' ? 'disabled' : 'data-action="open-bot-details"'} data-id="${esc(id)}">${avatar(id,44)}<span>${esc(nameOf(id))}</span></button>`).join('')}
      <button data-action="edit-room" class="add-member">${icon('edit',22)}<span>编辑成员</span></button></div>`;
  } else if (tab === 'library') {
    const space = bot ? { kind:'bot', id:bot.id } : roomRef(room.id);
    body = `<div class="profile-section-heading"><span>资料</span><button class="icon-button" data-action="edit-file" data-kind="${space.kind}" data-space="${esc(space.id)}" aria-label="新增资料">${icon('plus',20)}</button></div>
      ${(ui.roomFiles || []).map(file => {
        const pinned = !bot && room.pins.some(ref => sameRef(ref,file.ref));
        return `<div class="pin-row"><button class="profile-record record-button" data-action="open-file" data-id="${esc(file.id)}"><strong>${esc(file.name || file.path)}</strong></button>
          ${!bot ? `<button class="text-button" data-action="${pinned ? 'unpin' : 'pin'}" data-kind="file" data-id="${esc(file.id)}">${pinned ? '取消置顶' : '置顶'}</button>` : ''}</div>`;
      }).join('') || '<p class="panel-empty">没有资料</p>'}`;
  } else if (tab === 'pins') {
    body = room.pins.map(ref => `<div class="pin-row">${renderReference(ref)}<button class="text-button" data-action="unpin" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">取消置顶</button></div>`).join('') || '<p class="panel-empty">没有置顶</p>';
  } else if (bot) {
    body = `<p class="subtle" style="margin:0 0 10px;font-size:var(--text-caption)">${esc(formatBotModelSummary(bot))}</p><div class="profile-prompt">${esc(bot.instructions || '')}</div><div class="profile-more-actions">
      <button data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot</button><button data-action="bot-access" data-id="${esc(bot.id)}">资源权限</button>${renderBotControls(bot)}</div>`;
  } else {
    const wakeups = ui.roomWakeups || [];
    const base = wakeups.filter(item => item.rule.kind === 'room_base');
    const extra = wakeups.filter(item => item.rule.kind !== 'room_base');
    const runnable = wakeups.filter(item => item.enabled && botById(item.bot_id)?.enabled &&
      (item.rule.kind === 'room_base' || item.rule.kind === 'event' && item.rule.type === 'message'));
    const allMessages = runnable.some(({ rule }) => rule.mode === 'all' || rule.kind === 'event' && !rule.author && !rule.ref);
    body = `<div class="profile-section-heading"><span>基础关注</span><button class="text-button" data-action="edit-room">编辑会话</button></div>
      ${base.map(renderWakeupRow).join('') || '<p class="panel-empty">没有成员关注</p>'}
      <div class="profile-section-heading"><span>自定义订阅</span><button class="icon-button" data-action="add-wakeup" data-room="${esc(room.id)}" aria-label="添加订阅">${icon('plus',20)}</button></div>
      ${extra.map(renderWakeupRow).join('') || '<p class="panel-empty">没有自定义订阅</p>'}
      ${wakeups.length && !runnable.length ? '<p class="panel-empty">当前没有启用的消息关注可唤醒 Bot。</p>'
        : runnable.length && !allMessages && !runnable.some(item => item.rule.message_count) ? '<p class="panel-empty">本群消息仅按上方定向关注和筛选条件唤醒。</p>' : ''}`;
  }
  const showBackToRoom = Boolean(bot && !directRoom(room));
  const toolbarLeft = showBackToRoom
    ? `<button type="button" class="text-button" data-action="back-to-room-details">${icon('back', 15)} 返回群聊</button>`
    : `<span class="subtle" style="font-size:var(--text-caption)">${bot ? (ui.avatarEditing ? '编辑头像' : '伙伴详情') : '会话详情'}</span>`;
  const footer = bot
    ? `<div class="detail-panel-footer"><button type="button" class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot</button><button type="button" class="secondary-button" data-action="bot-access" data-id="${esc(bot.id)}">资源权限</button>${renderBotControls(bot)}</div>`
    : `<div class="detail-panel-footer"><button type="button" class="secondary-button" data-action="edit-room">编辑会话</button><button type="button" class="secondary-button" data-action="copy-conversation">复制文字</button><button type="button" class="text-button" data-action="leave-room">退出会话</button></div>`;
  return `<aside class="detail-panel" data-section="${esc(tab + ':' + (bot?.id || room.id))}"><div class="detail-panel-inner">
    <div class="detail-panel-toolbar">${toolbarLeft}<button class="round-button" data-action="close-details" aria-label="关闭详情">${icon('close',20)}</button></div>
    <div class="profile-identity">${bot ? `<button class="profile-avatar" data-action="edit-avatar" aria-label="编辑头像" title="点击实时编辑头像">${face(ui.avatarEditing ? ui.avatarDraft : botAvatar(bot),104,{ key:'slot:profile',preview:true,followPointer:true })}</button>` : groupAvatar(room,92)}
      <h2>${esc(bot?.name || room.name)}</h2></div><nav class="profile-tabs" aria-label="详情分类">${tabs.map(item => `<button class="${tab === item.id ? 'active' : ''}" data-action="detail-tab" data-tab="${item.id}">${item.label}</button>`).join('')}</nav>
    <div class="detail-panel-body">${body}</div>${footer}</div></aside>`;
}

const inputActions = { reply:'回答', steer:'追加输入', next:'继续输入' };
const inputLabels = { codex_turn:'Codex 轮次', pi_run:'Pi 运行', cli_process:'CLI 进程', service_call:'服务调用', idle_input:'下次输入位置' };
const stopLabels = { pending:'停止待确认', unknown:'停止结果未知', stopped:'已确认停止', unsupported:'连接不支持停止' };
const executionLabel = item => item.kind === 'conversation' ? '内部对话' : item.engine === 'pi' ? 'Pi 会话' : (item.engine || '执行会话');
const executionTitle = item => [executionLabel(item), item.space?.kind === 'room' ? roomById(item.space.id)?.name : null].filter(Boolean).join(' · ');
const executionError = item => [item.last_error?.message, item.last_error?.code].filter(Boolean).join(' · ');

function renderExecutionRow(item) {
  const ref = item.execution_ref;
  const status = item.status || 'unknown';
  const error = executionError(item);
  const selected = sameRef(ui.executionRef, ref);
  return `<button class="profile-record record-button execution-row ${selected ? 'selected' : ''}" data-action="open-execution" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">
    <strong>${esc(executionTitle(item))}</strong>
    <small>${esc([item.bot_id && nameOf(item.bot_id), labels[status] || status, item.control?.state === 'paused' && '控制已暂停'].filter(Boolean).join(' · '))}</small>
    ${error ? `<small class="execution-error">${esc(error)}</small>` : ''}</button>`;
}

async function loadExecution(ref) {
  const request = {};
  ui.loadingExecutions.set(refKey(ref), request);
  try {
    const detail = await api(executionPath(ref));
    if (ui.loadingExecutions.get(refKey(ref)) !== request || !sameRef(ui.executionRef, ref)) return;
    const previous = ui.executionDetail;
    if (sameRef(previous?.execution_ref,ref)) {
      const remote = new Set((detail.messages || []).map(entry => entry.id));
      if (previous.messages?.some(entry => !remote.has(entry.id))) {
        detail.messages = [...(detail.messages || []),...previous.messages.filter(entry => !remote.has(entry.id))];
        detail.next_cursor = previous.next_cursor;
      }
      if (previous.output_call_id === detail.output_call_id && previous.output_pages?.length > 1) {
        detail.output_pages = [detail.output_page, ...previous.output_pages.slice(1)].filter(Boolean);
        detail.next_cursor = previous.next_cursor;
      }
    }
    ui.executionDetail = detail;
  } catch (error) {
    if (error.status === 404 && sameRef(ui.executionRef, ref)) ui.executionDetail = null;
    throw error;
  } finally {
    if (ui.loadingExecutions.get(refKey(ref)) === request) ui.loadingExecutions.delete(refKey(ref));
  }
}

function inputOptions(detail) {
  return (detail.input_targets || []).flatMap(option => (option.kinds || []).filter(kind => Object.hasOwn(inputActions, kind))
    .map(kind => {
      const requestId = option.input_target?.request_id;
      const request = requestId == null ? null : detail.pending_input?.find(item => item.id === requestId);
      return { ...option, kind, question:request?.text ?? option.question, choices:request?.choices ?? option.choices,
        key:JSON.stringify([detail.execution_ref,detail.control_version,kind,option.input_target]) };
    }));
}

function renderInputOption(option, index) {
  const target = option.input_target, pending = ui.executionInputs.get(option.key);
  const nativeId = target.turn_id ?? target.run_id ?? target.instance_id ?? target.operation_id ?? target.call_id ?? target.input_revision;
  const id = 'execution-input-' + index;
  const question = option.question;
  const choices = option.choices || [];
  return `<form class="execution-input-form" data-input="${esc(option.key)}"><label for="${id}">${inputActions[option.kind]}</label>
    <small>${esc(inputLabels[target.kind] || target.kind)} · ${esc(nativeId)}${target.request_id ? ` · 请求 ${esc(target.request_id)}` : ''}</small>
    ${question ? `<p class="execution-input-question">${esc(question)}</p>` : ''}
    ${choices.length ? `<select name="input" id="${id}" required><option value="">选择回答</option>${choices.map(choice => `<option value="${esc(choice.id)}" ${pending?.text === choice.id ? 'selected' : ''}>${esc(choice.label || choice.id)}</option>`).join('')}</select>`
      : `<textarea id="${id}" name="input" rows="2" required>${esc(pending?.text || '')}</textarea>
        ${target.kind === 'service_call' ? `<label class="checkbox-line"><input type="checkbox" name="structured" ${pending?.structured ? 'checked' : ''}>JSON 输入</label>` : ''}`}
    ${pending?.receipt?.status ? `<small>原输入回执 · ${esc(labels[pending.receipt.status] || pending.receipt.status)}</small>` : ''}
    <button class="primary-button" type="submit" ${!ui.protocolReady || pending?.busy || pending?.submitted ? 'disabled' : ''}>${pending?.submitted ? '已提交' : inputActions[option.kind]}</button></form>`;
}

function renderExecutionDetail(detail) {
  if (!detail) return '<p class="panel-empty">选择会话查看输入、输出和控制</p>';
  const error = executionError(detail);
  const paused = detail.control?.state === 'paused';
  const canResume = paused && detail.resume_ref && detail.control.stop_status === 'stopped';
  const stop = !paused && detail.can_stop;
  const logs = (detail.messages || []).map(entry => {
    const msg = entry.message || entry;
    const content = msg.content ?? msg.text ?? msg.output ?? msg;
    const display = Array.isArray(content) ? content.map(part => part.text ?? JSON.stringify(part)).join('\n')
      : typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    return `<article class="execution-log"><small>${esc(msg.role || entry.type || '输出')}</small><pre>${esc(display)}</pre></article>`;
  }).join('');
  const output = detail.output == null || detail.output === detail.output_page?.text ? '' :
    `<pre class="execution-output">${esc(typeof detail.output === 'string' ? detail.output : JSON.stringify(detail.output,null,2))}</pre>`;
  const streamOutput = (detail.output_pages || (detail.output_page ? [detail.output_page] : [])).map(page =>
    `<pre class="execution-output">${esc(page.text ?? '')}</pre>`).join('');
  const native = detail.native ? `<details><summary>连接返回的标识</summary><pre class="execution-output">${esc(JSON.stringify(detail.native,null,2))}</pre></details>` : '';
  return `<div class="execution-facts"><h2>${esc(executionTitle(detail))}</h2><dl>
    <dt>执行状态</dt><dd>${statusPill(detail.status || 'unknown')}</dd>
    ${error ? `<dt>最近运行错误</dt><dd class="execution-error">${esc(error)}</dd>` : ''}
    <dt>控制</dt><dd>${statusPill(detail.control?.state)} ${esc(stopLabels[detail.control?.stop_status] || '')}</dd>
    ${detail.execution_actor || detail.bot_id ? `<dt>执行身份</dt><dd>${esc(nameOf(detail.execution_actor?.id || detail.bot_id))}</dd>` : ''}
    ${detail.submitted_by ? `<dt>提交者</dt><dd>${esc(nameOf(detail.submitted_by.id))}</dd>` : ''}
    ${detail.model?.id ? `<dt>模型</dt><dd>${esc(detail.model.id)}${detail.model.thinking_level ? ' · ' + esc(detail.model.thinking_level) : ''}</dd>` : ''}
    ${detail.latest_call_id ? `<dt>调用</dt><dd>${renderReference({ kind:'call',id:detail.latest_call_id })}</dd>` : ''}
    </dl>${native}</div>
    <div class="execution-actions">${stop ? '<button class="secondary-button" data-action="stop-execution">暂停并请求停止</button>' : ''}
      ${canResume ? '<button class="secondary-button" data-action="resume-execution">恢复控制</button>' : ''}</div>
    ${ui.stopResults ? `<ul class="execution-stop-results">${ui.stopResults.map(item => `<li>${esc(refLabel(item.target))} · ${esc(stopLabels[item.control.stop_status] || item.control.stop_status)}</li>`).join('')}</ul>` : ''}
    ${inputOptions(detail).map(renderInputOption).join('')}
    ${output || logs || streamOutput ? `<h3>输入与输出</h3>${output}${logs}${streamOutput}` : ''}
    ${detail.next_cursor ? '<button data-action="more-execution-output" class="text-button">读取后续日志</button>' : ''}`;
}

function trackedList(kind, endpoint, renderRow) {
  const page = ui.listPages?.[kind];
  const rows = state[kind].map(renderRow).join('') || '<p class="panel-empty">暂无记录</p>';
  return rows + (page?.next_cursor ? `<button class="text-button" data-action="more-list" data-kind="${kind}" data-endpoint="${endpoint}">加载更多</button>` : '');
}

function renderExecutions() {
  return `<div class="page">${pageHeader('<button class="primary-button" data-action="new-execution">打开会话</button>')}<div class="object-layout"><section class="object-list">${trackedList('executions','/api/executions',renderExecutionRow)}</section>
    <section class="object-detail">${renderExecutionDetail(ui.executionDetail)}</section></div></div>`;
}

function renderBotControls(bot) {
  const resumable = bot.resume_ref && bot.control?.stop_status === 'stopped';
  if (!bot.enabled && !resumable) return `<span>${esc(stopLabels[bot.control?.stop_status] || 'Bot 已暂停')}</span>`;
  return `<button data-action="toggle-bot" data-id="${esc(bot.id)}">${bot.enabled ? '暂停 Bot' : '恢复 Bot'}</button>`;
}

function renderMembers() {
  const bot = botById(ui.botId);
  const rows = state.bots.map(item => `<button class="profile-record record-button member-row ${item.id === ui.botId ? 'selected' : ''}" data-action="select-bot" data-id="${esc(item.id)}">
    ${avatar(item.id,40)}<span><strong>${esc(item.name)}</strong><small>${esc(botActivity(item).text)}</small></span></button>`).join('');
  const controls = bot ? `<h2>${esc(bot.name)}</h2><p class="subtle" style="margin:6px 0 12px;font-size:var(--text-caption)">${esc(formatBotModelSummary(bot))}</p><p class="profile-prompt">${esc(bot.instructions || '')}</p><div class="execution-actions">
    <button class="primary-button" data-action="dm-bot" data-id="${esc(bot.id)}">发消息</button><button class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">编辑</button>
    <button class="secondary-button" data-action="bot-access" data-id="${esc(bot.id)}">资源权限</button>${renderBotControls(bot)}</div>` : '';
  return `<div class="page">${pageHeader('<button class="primary-button" data-action="new-bot">创建 Bot</button>')}
    <div class="object-layout"><section class="object-list">${rows || '<p class="panel-empty">暂无 Bot</p>'}</section><section class="object-detail">${controls}</section></div></div>`;
}

async function loadFile(id, cursor) {
  const detail = await api(filePath(id) + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''));
  if (ui.fileId === id) ui.fileDetail = cursor ? { ...detail, content:(ui.fileDetail.content || '') + (detail.content || '') } : detail;
}

function renderFiles() {
  const item = ui.fileDetail;
  const rows = trackedList('files','/api/files', file => `<button class="profile-record record-button ${file.id === ui.fileId ? 'selected' : ''}" data-action="open-file" data-id="${esc(file.id)}">
    <strong>${esc(file.name || file.path)}</strong><small>${esc(file.space ? refLabel(file.space) : '')} · 修订 ${esc(file.revision)}</small></button>`);
  const link = typeof item?.url === 'string' && item.url === filePath(item.id) + '/download' ? item.url : attachmentUrl(item);
  const detail = item ? `<h2>${esc(item.path || item.name)}</h2><p>修订 ${esc(item.revision)}</p><div class="execution-actions">
    ${link ? `<a href="${esc(link)}" download>下载</a>` : ''}${item.path && typeof item.content === 'string' && !item.next_cursor ? `<button class="secondary-button" data-action="edit-file" data-id="${esc(item.id)}">编辑</button>` : ''}</div>
    ${typeof item.content === 'string' ? `<pre class="execution-output">${esc(item.content)}</pre>` :
      item.content_status === 'unavailable' ? '<p>文件内容不可用</p>' : ''}
    ${item.next_cursor ? '<button class="text-button" data-action="more-file">读取后续内容</button>' : ''}
    ${item.sources?.length ? `<div class="reference-list">${item.sources.map(ref => renderReference(ref)).join('')}</div>` : ''}` : '<p class="panel-empty">选择文件查看内容</p>';
  return `<div class="page">${pageHeader('<button class="primary-button" data-action="edit-file">新增资料</button>')}
    <div class="object-layout"><section class="object-list">${rows}</section><section class="object-detail">${detail}</section></div></div>`;
}

function describeWakeup(rule) {
  if (rule.kind === 'room_base') return rule.mode === 'all' ? '所有消息' :
    rule.message_count ? `@ 或回复，或累计 ${rule.message_count} 条新消息` : '仅 @ 或回复';
  if (rule.kind === 'event') return [rule.type === 'message' ? '消息' : rule.type, !rule.room && '所有可访问会话',
    rule.author && '作者 · ' + nameOf(rule.author.id), rule.ref && refLabel(rule.ref)].filter(Boolean).join(' · ');
  return formatTime(rule.at,true) + (rule.interval_ms ? ' · 每 ' + rule.interval_ms / 60000 + ' 分钟' : ' · 单次');
}

function renderWakeupRow(item) {
  return `<div class="wakeup-row"><div class="wakeup-copy"><strong>${esc(nameOf(item.bot_id))}</strong><span>${esc(describeWakeup(item.rule))}</span>
    ${item.rule.room && ui.view !== 'chat' ? `<small>${esc(roomById(item.rule.room)?.name || item.rule.room)}</small>` : ''}
    ${botById(item.bot_id)?.enabled === false ? '<small>Bot 已暂停</small>' : ''}</div>
    <button class="text-button" data-action="edit-wakeup" data-id="${esc(item.id)}">编辑</button>
    <button class="text-button" data-action="toggle-wakeup" data-id="${esc(item.id)}">${item.enabled ? '停用' : '启用'}</button></div>`;
}

function renderWakeups() {
  const custom = state.wakeups.filter(item => item.rule.kind !== 'room_base');
  const basic = state.wakeups.filter(item => item.rule.kind === 'room_base');
  return `<div class="page">${pageHeader('<button class="primary-button" data-action="add-wakeup">新增订阅</button>')}
    <div class="object-layout"><section class="object-list"><h2>基础关注</h2>${basic.map(renderWakeupRow).join('') || '<p class="panel-empty">暂无基础关注</p>'}</section>
    <section class="object-detail"><h2>自定义订阅与提醒</h2>${custom.map(renderWakeupRow).join('') || '<p class="panel-empty">暂无自定义订阅与提醒</p>'}
    ${ui.listPages?.wakeups?.next_cursor ? '<button class="text-button" data-action="more-list" data-kind="wakeups" data-endpoint="/api/wakeups">加载更多</button>' : ''}</section></div></div>`;
}

function renderConnections() {
  const limits = state.limits, usage = state.resourceUsage;
  const amount = { ...usage, models:usage?.running_models, external:usage?.running_external };
  return `<div class="page">${pageHeader('<button class="secondary-button" data-action="edit-workspace">登记执行目录</button><button class="primary-button" data-action="edit-connection">新增连接</button>')}<div class="object-layout">
    <section class="object-list">${state.connections.map(item => `<div class="profile-record"><strong>${esc(item.name || item.id)}</strong><small>${esc(item.protocol || item.kind || item.id)}${item.maintainer ? ' · ' + esc(item.maintainer.name || nameOf(item.maintainer.id)) : ''}</small>
      <div class="connection-actions"><button class="text-button" data-action="open-connection" data-id="${esc(item.id)}">接入信息</button>
      ${item.id !== 'pi' ? `<button class="text-button" data-action="edit-connection" data-id="${esc(item.id)}">设置</button>` : ''}</div></div>`).join('') || '<p class="panel-empty">暂无执行连接</p>'}</section>
    <section class="object-detail"><div class="profile-section-heading"><h2>宿主资源</h2>
    ${state.limitsRevision != null ? '<button class="text-button" data-action="edit-limits">调整额度</button>' : ''}</div>
    ${limits ? `<dl class="resource-facts">${Object.entries(limits).map(([key, value]) => `<dt>${esc(resourceLabels[key] || key)}</dt>
      <dd>${amount[key] != null ? esc(amount[key]) + ' / ' : ''}${esc(value)}</dd>`).join('')}</dl>` : '<p class="panel-empty">等待资源状态</p>'}
    ${usage?.resets_at ? `<p>当前统计期至 ${esc(formatTime(usage.resets_at,true))}</p>` : ''}<h3>执行目录</h3>
    ${state.workspaces.map(item => `<div class="wakeup-row"><div class="wakeup-copy"><strong>${esc(item.name)}</strong><small>${esc(item.path)}</small>
      <span>${item.write ? '可写' : '只读'}</span></div>${item.revision != null ? `<button class="text-button" data-action="edit-workspace" data-id="${esc(item.id)}">编辑</button>` : ''}</div>`).join('') || '<p class="panel-empty">未登记执行目录</p>'}</section></div></div>`;
}
function renderAvatarPicker(mode = 'create') {
  const selected = window.SummonAvatars.normalize(ui.avatarDraft || botAvatar(profileBot())), tab = ui.avatarTab || 'bot';
  const save = mode === 'edit' ? avatarSaves.get(profileBot()?.id) : null;
  const saveStatus = save?.error ? `<div class="avatar-save-status error" role="status">头像尚未保存<button type="button" data-action="avatar-save-retry">重试</button><small>${esc(save.error)}</small></div>` : save && (save.running || save.savedVersion !== save.version) ? '<div class="avatar-save-status" role="status">正在保存…</div>' : mode === 'edit' ? '<div class="avatar-save-status" aria-hidden="true"></div>' : ''; 
  const picker = `<div class="shape-grid">${window.SummonAvatars.shapes.map(shape => `<button type="button" class="shape-choice ${selected.shape === shape.id && !selected.image ? 'selected' : ''}" data-action="avatar-shape" data-shape="${shape.id}" data-mode="${mode}" aria-label="${shape.label}" aria-pressed="${selected.shape === shape.id}">${face({ ...selected, shape: shape.id, image: null }, 52, { static: true })}<small>${shape.label}</small></button>`).join('')}</div><div class="crew-palettes">${window.SummonAvatars.templates.map(p => `<button type="button" data-action="avatar-template" data-template="${p.id}" data-mode="${mode}" title="${p.name}" aria-label="${p.name}" aria-pressed="${selected.color === p.color && selected.secondary === p.secondary}" style="background:linear-gradient(135deg,${p.color} 82%,${p.secondary} 82%)">${p.name}</button>`).join('')}</div><details class="crew-custom" ${ui.avatarCustomOpen ? 'open' : ''}><summary>自定义颜色</summary>${[['color','纸片颜色'],['secondary','衬纸颜色'],['ink','边线颜色'],['paper','眼睛留白']].map(([key,label])=>`<label>${label}<input type="color" data-avatar-custom="${key}" data-mode="${mode}" value="${selected[key]}"></label>`).join('')}</details>`;

  return `${saveStatus}<div class="avatar-picker ${mode === 'create' ? 'create-picker' : ''}">${mode === 'edit' ? `<div class="avatar-tabs">${[{ id: 'bot', label: 'Bot' }, { id: 'generate', label: '生成' }, { id: 'upload', label: '上传' }].map(item => `<button type="button" class="${tab === item.id ? 'active' : ''}" data-action="avatar-tab" data-tab="${item.id}">${item.label}</button>`).join('')}<button class="avatar-reset" type="button" data-action="avatar-reset">重置</button></div>` : ''}${mode === 'create' || tab === 'bot' ? picker : tab === 'generate' ? `<div class="avatar-tool"><p>随机组合造型与颜色</p><button class="secondary-button" data-action="avatar-random" type="button">${icon('spark', 18)}生成一个造型</button></div>` : `<div class="avatar-tool"><p>使用自己的图片</p><label class="upload-label" for="avatar-upload">${icon('upload', 23)}选择图片</label><input id="avatar-upload" type="file" accept="image/*" hidden><small>所选图片将缩放为头像</small></div>`}</div>`;
}
function openCreateBot() {
  window.SummonAvatars?.release('slot:create-preview');
  ui.avatarSelectionRevision++;
  ui.avatarEditing = false;
  ui.avatarCustomOpen = false;
  ui.avatarDraft = window.SummonAvatars.normalize({ shape: 'cercle',color:'#7D824B' });
  ui.menu = null; render();
  const modal = $('#modal'); captureMotion($('#modal-content')); modal.classList.add('create-bot-modal');
  $('#modal-content').innerHTML = `<div class="modal-header"><h2>创建新 Bot</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 24)}</button></div><form id="modal-form" class="create-bot-form"><div class="create-bot-body"><button type="button" id="create-avatar-preview" class="create-avatar-preview" data-action="avatar-greet" aria-label="和 Bot 打招呼">${face(ui.avatarDraft, 144, { key: 'slot:create-preview', identity: 'create-preview', preview: true, intro: true, followPointer: true })}</button><input id="create-bot-name" name="name" placeholder="给你的 Bot 起个名字" aria-label="Bot 名字" required maxlength="100" autocomplete="off"><div class="create-picker-scroll"><div id="create-avatar-picker">${renderAvatarPicker('create')}</div><div class="form-error" role="alert"></div></div></div><div class="modal-footer"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button id="create-bot-submit" class="primary-button" type="submit" disabled>创建</button></div></form>`;
  $('#modal-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target, button = $('#create-bot-submit', form), name = $('#create-bot-name', form).value.trim(), avatar = { ...ui.avatarDraft }; if (!name) return;
    button.disabled = true; $('.form-error', event.target).textContent = '';
    try { const bot = await api('/api/bots', 'POST', { name, instructions:'', avatar }); const ownsDialog = modal.open && $('#modal-form') === form; if (ownsDialog) await closeModal(modal); const stillOwns = $('#modal-form') === form; if (ownsDialog && stillOwns) ui.avatarDraft = null; await refresh(); if (ownsDialog && stillOwns && $('#modal-form') === form) await act('dm-bot', { dataset: { id: bot.id } }); else toast(`${bot.name} 已创建`); }
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
  if (mode === 'create') { const root = $('#modal-content'), motion = captureMotion(root); $('#create-avatar-preview').innerHTML = face(ui.avatarDraft, 144, { key: 'slot:create-preview', identity: 'create-preview', preview: true, followPointer: true }); $('#create-avatar-picker').innerHTML = renderAvatarPicker('create'); hydrateMotion(root, motion); }
  else return persistAvatar();
}
document.addEventListener('change', async event => {
  if (event.target.dataset.avatarCustom) { const key = event.target.dataset.avatarCustom; if (!['color','secondary','ink','paper'].includes(key)) return; ui.avatarSelectionRevision++; ui.avatarDraft = { ...ui.avatarDraft, [key]: event.target.value, image: null }; if(event.target.dataset.mode === 'create') { const root = $('#create-avatar-preview'); root.innerHTML = face(ui.avatarDraft,144,{key:'slot:create-preview',preview:true}); hydrateMotion(root); } else await persistAvatar(); return; }
  if (event.target.id !== 'avatar-upload') return;
  const file = event.target.files?.[0], botId = profileBot()?.id;
  if (!file || !botId) return;
  const revision = ++ui.avatarSelectionRevision;
  try {
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

// Use the visible phone viewport without replacing controls or interrupting IME input.
function syncMobileViewport() {
  const viewport = window.visualViewport, root = document.documentElement;
  if (!displayMedia.matches) {
    if (root.classList.contains('keyboard-open')) {
      root.style.removeProperty('--mobile-vh'); root.style.removeProperty('--mobile-vtop'); root.style.removeProperty('--mobile-page-top'); root.classList.remove('keyboard-open');
    }
    return;
  }
  const messages = $('.messages'), atBottom = messages && (messages._summonChatScroll?.followBottom || messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40);
  const zoom = Number(getComputedStyle(root).zoom) || 1;
  const editing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
  const units = readViewportUnits();
  // Root height is affected by our own layout. Use viewport units instead so
  // keyboard detection cannot toggle itself while the shell is being resized.
  const layoutHeight = Math.max(innerHeight, parseFloat(units.vh) || 0);
  // Scale removes pinch-zoom's reduction from keyboard detection; an input's
  // automatic zoom must not disable fitting a genuinely open keyboard.
  const keyboardOpen = editing && !!viewport && layoutHeight - viewport.height * viewport.scale > 100;
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
  if (atBottom) messages._summonChatScroll?.schedule();
}
let viewportFrame = 0, resizeIdleTimer = 0;
function markWindowResizing() {
  document.documentElement.classList.add('summon-resizing');
  clearTimeout(resizeIdleTimer);
  resizeIdleTimer = setTimeout(() => {
    document.documentElement.classList.remove('summon-resizing');
    if (window.SummonAvatars) window.SummonAvatars.hydrate?.(document);
  }, 140);
}
function queueViewportSync() {
  if (!displayMedia.matches) return;
  cancelAnimationFrame(viewportFrame);
  viewportFrame = requestAnimationFrame(syncMobileViewport);
}
window.visualViewport?.addEventListener('resize', queueViewportSync);
window.visualViewport?.addEventListener('scroll', queueViewportSync);
window.addEventListener('resize', () => { markWindowResizing(); queueViewportSync(); }, { passive: true });
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
window.addEventListener('pagehide', () => { persistClientSession(); });
syncMobileViewport();

document.addEventListener('toggle', event => { if(event.target.matches?.('.crew-custom')) ui.avatarCustomOpen = event.target.open; }, true);
document.addEventListener('toggle', event => {
  const detail = event.target;
  if (!detail.isConnected || detail.closest?.('[data-motion-ghost]')) return;
  if (detail.matches?.('[data-execution-disclosure]')) ui.openRoomExecution = detail.open ? ui.roomId : null;
  if (detail.matches?.('[data-delivery-id]')) {
    const expanded = ui.expandedDeliveries ||= new Set();
    if (detail.open) expanded.add(detail.dataset.deliveryId);
    else expanded.delete(detail.dataset.deliveryId);
  }
  if (detail.matches?.('[data-summary-id]')) {
    const expanded = ui.expandedSummaries ||= new Set();
    if (detail.open) expanded.add(detail.dataset.summaryId);
    else expanded.delete(detail.dataset.summaryId);
  }
},true);

const initialView = location.hash.slice(1);
if (tabs.some(tab => tab.id === initialView)) ui.view = initialView;
applyDisplayPreferences();
renderTopbar();
void restoreCachedState().then(() => refresh());
setInterval(() => { if (!ui.streamConnected && navigator.onLine && !document.hidden) scheduleRefresh(); }, 3000);
window.addEventListener('offline', () => { setProtocol(false, '当前离线。草稿和待确认的发送已保留。'); persistClientSession(); });
window.addEventListener('online', scheduleRefresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); else persistClientSession(); });
