'use strict';

const $ = (selector, root = document) => {
  const first = root.querySelector(selector);
  return first?.closest('[data-motion-ghost]') ? [...root.querySelectorAll(selector)].find(node => !node.closest('[data-motion-ghost]')) || null : first;
};
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)].filter(node => !node.closest('[data-motion-ghost]'));
// Display preferences are local to this browser and independent for each layout.
const UI_BUILD = '2026.11.24';
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
    const input = $(`#display-${key}`), output = $(`#display-${key}-value`);
    if (input) input.value = settings[key];
    if (output) output.textContent = `${settings[key]}%`;
  }
  const deviceEl = $('#display-device');
  if (deviceEl) deviceEl.textContent = displayMode() === 'desktop' ? '电脑显示' : '手机显示';
  const statusEl = $('#display-save-status');
  if (statusEl) statusEl.textContent = displaySaved ? '即时生效并自动保存到本机（电脑和手机分别保存）' : '当前页面已生效；浏览器暂不允许保存，刷新后会恢复默认';
  for (const button of $$('[data-action="display-preset"]')) {
    const active = Number(button.dataset.zoom) === settings.zoom;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
}
const SETTINGS_TABS = [
  { id: 'general', title: '通用', icon: 'settings' },
  { id: 'models', title: '模型', icon: 'spark' },
  { id: 'wakeups', title: '订阅', icon: 'clock' },
  { id: 'connection', title: '连接', icon: 'link' },
  { id: 'updates', title: '更新', icon: 'install' },
];
function renderSettingsNodeSelector() {
  const hub = window.SummonHub;
  const online = hub?.onlineNodes?.() || [];
  if (online.length <= 1) return '';
  return `<div class="hub-node-selector-bar"><span>当前配置的电脑：</span><select data-hub-select="active-node" aria-label="切换配置的电脑">${online.map(n => `<option value="${esc(n.id)}" ${n.id === hub.state.activeNodeId ? 'selected' : ''}>${esc(n.name)}${n.isLocal ? '（本机）' : ''}</option>`).join('')}</select></div>`;
}
function renderSettingsPanelBody(tab) {
  const connected = ui.streamConnected && ui.protocolReady;
  if (tab === 'general') {
    const hostLabel = location.host || location.origin;
    const identity = ownerIdentity();
    const profile = readLocalProfile();
    return `<div class="settings-section">
      <h3 class="settings-group-label">账户</h3>
      <div class="settings-card">
        <div class="settings-row settings-account-row">
          <div class="settings-account-main">
            ${avatar('user', 42)}
            <div class="settings-row-copy">
              <strong>${esc(identity.signedIn ? identity.name : (profile.name || '本地账户'))}</strong>
              <small><i class="settings-status-dot ${connected ? 'is-ok' : 'is-warn'}" aria-hidden="true"></i>${identity.signedIn ? `@${esc(identity.username || '')} · 云端账号` : '未登录云端账号 · 仅本机使用'} · ${esc(hostLabel)}</small>
            </div>
          </div>
          <div class="settings-row-actions">
            ${!connected ? '<button type="button" class="secondary-button small-button" data-action="refresh">重新连接</button>' : ''}
            ${identity.signedIn
              ? '<button type="button" class="secondary-button small-button" data-hub-action="logout">退出账号</button>'
              : '<button type="button" class="primary-button small-button" data-action="open-account-login">登录云端账号</button>'}
          </div>
        </div>
        <div class="settings-row settings-row-stack">
          <div class="settings-row-copy">
            <strong>本地资料</strong>
            <small>自定义本机显示的昵称与头像（保存在本机浏览器）</small>
          </div>
          <form class="settings-profile-form" id="local-profile-form">
            <input name="name" type="text" maxlength="32" value="${esc(profile.name || '')}" placeholder="${esc(identity.signedIn ? identity.name : '本地账户')}" autocomplete="off">
            <button type="submit" class="secondary-button small-button">保存昵称</button>
            <label class="secondary-button small-button settings-upload-btn">更换头像<input type="file" accept="image/png,image/jpeg,image/webp" data-action="upload-owner-avatar" hidden></label>
            ${profile.avatar ? '<button type="button" class="text-button" data-action="clear-owner-avatar">恢复默认</button>' : ''}
          </form>
        </div>
      </div>
    </div>
    <div class="settings-section display-settings">
      <div class="settings-group-head">
        <h3 class="settings-group-label">外观与显示</h3>
        <span id="display-device" class="settings-group-badge"></span>
      </div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-copy">
            <strong>主题</strong>
            <small>浅色采用暖棉纸片风，暗色切换磨砂类玻璃</small>
          </div>
          <div class="display-theme-bar" role="group" aria-label="外观材质">
            <button type="button" data-action="set-theme" data-theme="system">跟随系统</button>
            <button type="button" data-action="set-theme" data-theme="light">浅色</button>
            <button type="button" data-action="set-theme" data-theme="dark">暗色</button>
          </div>
        </div>
        <div class="settings-row settings-row-stack">
          <div class="settings-row-head">
            <div class="settings-row-copy">
              <label for="display-zoom"><strong>页面缩放</strong></label>
              <small>一起调整头像、控件、间距与文字的大小</small>
            </div>
            <div class="settings-zoom-meta">
              <output id="display-zoom-value" for="display-zoom"></output>
              <div class="display-presets">
                <button type="button" data-action="display-preset" data-zoom="85">85%</button>
                <button type="button" data-action="display-preset" data-zoom="100">100%</button>
                <button type="button" data-action="display-preset" data-zoom="115">115%</button>
              </div>
            </div>
          </div>
          <input id="display-zoom" class="settings-range" type="range" min="50" max="160" step="1" aria-label="页面缩放">
        </div>
        <div class="settings-row settings-row-stack">
          <div class="settings-row-head">
            <div class="settings-row-copy">
              <label for="display-font"><strong>文字大小</strong></label>
              <small>统一调整聊天与界面的文字尺寸</small>
            </div>
            <output id="display-font-value" for="display-font"></output>
          </div>
          <input id="display-font" class="settings-range" type="range" min="90" max="160" step="5" aria-label="文字大小">
        </div>
        <div class="settings-row">
          <div class="settings-row-copy">
            <strong>显示偏好</strong>
            <small id="display-save-status"></small>
          </div>
          <button type="button" class="secondary-button small-button" data-action="display-reset">恢复默认</button>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <h3 class="settings-group-label">初始化与新手引导</h3>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-copy">
            <strong>首启开场动效与 AI 接入引导</strong>
            <small>随时预览首次安装后的全屏开场动效、模型连通性检测与 Summon 群专注初始化流程</small>
          </div>
          <button type="button" class="secondary-button small-button" data-action="preview-onboarding">预览引导</button>
        </div>
      </div>
    </div>`;
  }
  if (tab === 'models') {
    return renderSettingsNodeSelector() + globalThis.SummonModels.render({ esc, icon, embedded: true });
  }
  if (tab === 'wakeups') {
    const custom = (state.wakeups || []).filter(item => item.rule.kind !== 'room_base');
    return renderSettingsNodeSelector() + `<div class="settings-section">
      <div class="settings-group-head">
        <h3 class="settings-group-label">定时提醒与自定义订阅</h3>
        <button type="button" class="primary-button small-button" data-action="add-wakeup">${icon('plus', 14)}新增订阅</button>
      </div>
      <div class="settings-card">
        ${custom.length ? custom.map(item => `<div class="settings-row settings-wakeup-item">${renderWakeupRow(item)}</div>`).join('')
          : '<div class="settings-row"><div class="settings-row-copy"><strong>暂无定时或自定义订阅</strong><small>可为任意 Bot 设置定时巡检、周期汇报或事件触发提醒</small></div></div>'}
        ${ui.listPages?.wakeups?.next_cursor ? '<div class="settings-row"><button type="button" class="text-button" data-action="more-list" data-kind="wakeups" data-endpoint="/api/wakeups">加载更多</button></div>' : ''}
      </div>
      <p class="settings-footnote">各群聊的基础消息关注规则（全量监听 / 仅 @ 唤醒）请在对应群聊右侧详情面板中调整。</p>
    </div>`;
  }
  if (tab === 'connection') {
    if (window.SummonHub?.state?.user?.role === 'admin' && !window.SummonHub.state.invitesLoaded) {
      void window.SummonHub.loadInvites();
    }
    const isDesktop = Boolean(window.SummonDesktop?.openConnectionSettings);
    const localInstance = document.documentElement.dataset.localInstance === 'true' || location.hostname === '127.0.0.1' || location.hostname === 'localhost';
    const engines = state.engines || [];
    const workspaces = state.workspaces || [];
    const hubSection = window.SummonHub?.renderHubSettingsSection?.() || '';
    return `${renderSettingsNodeSelector()}${hubSection}<div class="settings-section">
      <h3 class="settings-group-label">实例</h3>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-copy">
            <strong>${isDesktop ? (localInstance ? '本机正式实例' : '远程实例') : '当前服务入口'}</strong>
            <small><i class="settings-status-dot ${connected ? 'is-ok' : 'is-warn'}" aria-hidden="true"></i>${esc(location.origin)} · ${connected ? '实时连接正常' : '连接中断'}</small>
          </div>
          <div class="settings-row-actions">
            <button type="button" class="secondary-button small-button" data-action="refresh">重新连接</button>
          </div>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-group-head">
        <h3 class="settings-group-label">本机凭据</h3>
      </div>
      <div class="settings-card">
        <div class="settings-row">
          <div class="settings-row-copy">
            <strong>隐私输入</strong>
            <small>管理 runtime.env 环境变量、中枢登录与 API Key</small>
          </div>
          <div class="settings-row-actions">
            <button type="button" class="secondary-button small-button" data-action="open-secret-input" data-secret-tab="env">${icon('shield', 14)} 打开</button>
          </div>
        </div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-group-head">
        <h3 class="settings-group-label">执行目录（Workspace）</h3>
        <button type="button" class="secondary-button small-button" data-action="edit-workspace">${icon('plus', 14)}登记目录</button>
      </div>
      <div class="settings-card">
        ${workspaces.length ? workspaces.map(item => `<div class="settings-row">
          <div class="settings-row-copy">
            <strong>${esc(item.name)} <span class="settings-pill">${item.write ? '可写' : '只读'}</span></strong>
            <small>${esc(item.path)}</small>
          </div>
          ${item.revision != null ? `<button type="button" class="secondary-button small-button" data-action="edit-workspace" data-id="${esc(item.id)}">编辑</button>` : ''}
        </div>`).join('') : '<div class="settings-row"><div class="settings-row-copy"><strong>未登记执行目录</strong><small>登记本机项目目录后，群聊和执行引擎才能读写对应代码库</small></div></div>'}
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-group-head">
        <h3 class="settings-group-label">工作引擎</h3>
      </div>
      <div class="settings-card">
        ${engines.length ? engines.map(item => {
          const statusPill = item.available
            ? '<span class="settings-pill">已就绪</span>'
            : !item.enabled
              ? '<span class="settings-pill">已停用</span>'
              : '<span class="settings-pill">未检测到 CLI</span>';
          const metaParts = [item.summary || item.id];
          if (item.command) metaParts.push(`CLI: ${item.command}${item.installed ? '（已检测到）' : '（未检测到）'}`);
          if (item.env_slots?.length) metaParts.push(`可选凭据: ${item.env_slots.join(', ')}`);
          return `<div class="settings-row">
            <div class="settings-row-copy">
              <strong>${esc(item.name)} ${statusPill}</strong>
              <small>${esc(metaParts.join(' · '))}</small>
            </div>
            <div class="settings-row-actions">
              <button type="button" class="secondary-button small-button" data-action="check-work-engine" data-id="${esc(item.id)}">自检</button>
              <button type="button" class="secondary-button small-button" data-action="open-engine-files" data-id="${esc(item.id)}">文件</button>
              <button type="button" class="secondary-button small-button" data-action="toggle-work-engine" data-id="${esc(item.id)}" data-enabled="${item.enabled ? '0' : '1'}">${item.enabled ? '停用' : '启用'}</button>
            </div>
          </div>`;
        }).join('') : '<div class="settings-row"><div class="settings-row-copy"><strong>暂无工作引擎</strong></div></div>'}
      </div>
      <p class="settings-footnote">本机已检测到的工作引擎（engines/）对所有群聊 Bot 透明开放，无需拉入业务群；由 Summon 系统群主控统一负责自检与协议自愈。</p>
    </div>`;
  }
  return `<div class="settings-section">
    <h3 class="settings-group-label">客户端下载与更新</h3>
    <div class="settings-card settings-card-clients">
      <div class="client-release-content" id="client-release-content"></div>
    </div>
  </div>
  <div class="settings-section">
    <h3 class="settings-group-label">网页界面与诊断</h3>
    <div class="settings-card">
      <div class="settings-row">
        <div class="settings-row-copy">
          <strong>网页界面</strong>
          <small>版本 ${esc(UI_BUILD)} · 服务端更新后重新加载生效</small>
        </div>
        <button type="button" class="secondary-button small-button" data-action="update-app">重新加载</button>
      </div>
      <div class="settings-row">
        <div class="settings-row-copy">
          <strong>显示诊断信息</strong>
          <small>复制视口、缩放与布局参数用于排查界面问题</small>
        </div>
        <button type="button" class="secondary-button small-button" data-action="copy-display-diagnostics">复制诊断</button>
      </div>
    </div>
  </div>`;
}
function renderSettingsModalShell(tab = ui.settingsTab || 'general') {
  const current = SETTINGS_TABS.find(item => item.id === tab) || SETTINGS_TABS[0];
  ui.settingsTab = current.id;
  return `<div class="settings-shell">
    <nav class="settings-nav" aria-label="设置分类">
      ${SETTINGS_TABS.map(item => `<button type="button" class="settings-nav-item ${item.id === current.id ? 'active' : ''}" data-action="settings-tab" data-tab="${item.id}" aria-current="${item.id === current.id ? 'page' : 'false'}">${icon(item.icon, 17)}<span>${item.title}</span></button>`).join('')}
    </nav>
    <div class="settings-main">
      <header class="settings-main-header">
        <h2>${current.title}</h2>
        <button type="button" class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 19)}</button>
      </header>
      <div class="settings-main-body">${renderSettingsPanelBody(current.id)}</div>
    </div>
  </div>`;
}
function refreshOpenSettingsBody() {
  const modal = $('#modal');
  if (!modal?.open || !modal.classList.contains('settings-modal')) return;
  if (ui.settingsTab === 'updates') return; // SummonClients manages #client-release-content itself
  const body = $('.settings-main-body', modal);
  if (!body) return;
  // Avoid clobbering active text input inside model/settings forms
  const active = document.activeElement;
  if (active && body.contains(active) && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) && active.type !== 'range') return;
  const oldTop = body.scrollTop;
  body.innerHTML = renderSettingsPanelBody(ui.settingsTab);
  body.scrollTop = oldTop;
  if (ui.settingsTab === 'general') { syncDisplaySettingsControls(); applyTheme(); }
}
async function loadSettingsTabData(tab) {
  if (!ui.protocolReady) return;
  if (tab === 'models') {
    await globalThis.SummonModels.load(api, render, toast, refresh);
    refreshOpenSettingsBody();
  } else if (tab === 'wakeups') {
    try {
      const page = await api('/api/wakeups');
      setListPage('wakeups', page);
      refreshOpenSettingsBody();
    } catch {}
  } else if (tab === 'connection') {
    try {
      const [enginesRes, workspaces] = await Promise.allSettled([api('/api/engines'), readList('/api/workspaces')]);
      if (enginesRes.status === 'fulfilled' && Array.isArray(enginesRes.value?.items)) state.engines = enginesRes.value.items;
      if (workspaces.status === 'fulfilled') state.workspaces = workspaces.value;
      refreshOpenSettingsBody();
    } catch {}
  }
}
function openSettingsModal(tab = 'general', releasesUrl = ui.releasesUrl) {
  const modal = $('#modal');
  const alreadySettings = modal.open && modal.classList.contains('settings-modal');
  if (!alreadySettings) {
    displayDiagnosticSnapshot = captureDisplayDiagnostics();
    captureMotion($('#modal-content'));
  }
  ui.returnToSettingsTab = null;
  ui.menu = null;
  renderTopbar();
  modal.classList.remove('create-bot-modal');
  modal.classList.add('settings-modal');
  $('#modal-content').innerHTML = renderSettingsModalShell(tab);
  if (ui.settingsTab === 'general') { syncDisplaySettingsControls(); applyTheme(); }
  if (ui.settingsTab === 'updates') window.SummonClients?.mount?.(releasesUrl || ui.releasesUrl);
  if (!modal.open) showModal(modal);
  if (['models', 'wakeups', 'connection'].includes(ui.settingsTab)) {
    void loadSettingsTabData(ui.settingsTab);
  }
}
window.SummonOpenSettings = openSettingsModal;
function openDisplaySettings() { return openSettingsModal('general'); }
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
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  archiveRestore: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M12 17v-5m-2.5 2.5L12 12l2.5 2.5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/>',
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
  { id:'chat', title:'消息', icon:'chat' },
  { id:'overview', title:'工作总览', icon:'layers' },
  { id:'usage', title:'Token 用量', icon:'layers' },
];
const protocolVersion = 3;
const DRAFT_ROOM_ID = '__new_group__';
const BOT_MAINTENANCE_ROOM_ID = 'room-default-bot-maintenance';
const NEW_GROUP_SUGGESTIONS = [
  {
    id: 'dev',
    title: '软件与网页开发',
    desc: '写代码、做网页或应用，按需配前端与测试专员',
    prompt: '我想建一个软件与网页开发群，用来推进架构、代码和界面实现，先帮我配好团队并确认要绑定的项目目录。',
  },
  {
    id: 'schedule',
    title: '个人日程与事务',
    desc: '排差旅、管待办，个人习惯说一遍永久记住',
    prompt: '我想建一个个人日程与日常事务群，帮我整理待办、规划行程并长期记住我的习惯偏好。',
  },
  {
    id: 'ops',
    title: '服务器运维排障',
    desc: '查日志、盯告警，高风险操作主动拦住',
    prompt: '我想建一个线上服务运维与排障群，负责查日志、处理故障并长期维护运维手册。',
  },
  {
    id: 'research',
    title: '专题研究与写作',
    desc: '查资料、磨方案，把讨论沉淀成活文档',
    prompt: '我想建一个专题研究与方案写作群，用来收集资料、推演方案并长期维护专业文档。',
  },
];
const state = { bots: [], archivedBots: [], engines: [], roles: [], rooms: [], archivedRooms: [], executions: [], files: [], wakeups: [], workspaces: [] };
const resourceLabels = {
  running_models:'运行中模型请求', running_external:'运行中外部执行',
  calls:'当前周期调用数', tokens:'当前周期 Token', active_ms:'累计活跃时间（毫秒）',
};
const ui = {
  view:'chat', lastPanelView:'overview', settingsTab:'general', returnToSettingsTab:null, roomId:null, creatingRoom:false, creatingRoomBusy:false, draftWorkspaceId:'', botId:null, executionRef:null, executionDetail:null, fileId:null, fileDetail:null, fileRevision:null,
  messages:[], roomActivities:[], roomGoal:null, roomDrawerMode:'plan', optimisticRoomWork:{}, roomWorkEpoch:{}, roomSuspendedRuns:[], activityTickerIndex:0, mobileRoom:false, draftReplies:{}, drafts:{}, draftTargets:{}, draftAttachments:{},
  draftReferences:{}, localMessages:{}, loading:true, refreshing:false, streamConnected:false, connectionNotice:'',
  detailOpen:false, detailTab:'details', profileBotId:null, avatarEditing:false, avatarDraft:null, avatarTab:'bot',
  avatarSelectionRevision:0, searchOpen:false, roomQuery:'', archiveDrawerOpen:false, menu:null, sendingRooms:new Set(), navigationSeq:0,
  messageCache:new Map(), roomReadSeq:{}, executionInputs:new Map(), loadingExecutions:new Map(),
  promptDrafts:new Map(), promptSubmitting:new Set(), execPromptDrafts:new Map(), execPromptBusy:new Set(), execPromptMasked:new Map(),
  historyEpoch:null, historyGeneration:0, retiredHistoryEpochs:new Set(), desktopUpdate:null,
};
document.addEventListener('summon-desktop-update', event => {
  ui.desktopUpdate = event.detail || null;
  ui.lastSidebarHtml = null;
  renderTopbar();
});
const attachmentLimit = 8, attachmentMaxBytes = 20 * 1024 * 1024;
const attachmentDrafts = (roomId = ui.roomId) => ui.draftAttachments[roomId] || [];
const attachmentBusy = (roomId = ui.roomId) => attachmentDrafts(roomId).some(item => item.status !== 'ready');
const sendBusy = (roomId = ui.roomId) => !ui.protocolReady || ui.sendingRooms.has(roomId) || attachmentBusy(roomId);
function attachmentSize(bytes) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function attachmentUrl(item, preview = false) {
  const path = preview ? item?.previewUrl : item?.url;
  if (typeof path === 'string' && /^\/api\/(?:attachments\/[a-z0-9-]+(?:\/preview)?|files\/[^/?#]+\/download(?:\?revision=\d+)?)$/i.test(path)) {
    return window.SummonHub?.apiPath?.(path) || path;
  }
  return '';
}
function renderMessageAttachments(items = []) {
  if (!items.length) return '';
  const cards = items.map(item => {
    const url = attachmentUrl(item), thumbnail = attachmentUrl(item, true), name = item.name || item.id;
    const title = '<span><strong>' + esc(name) + '</strong><small>' + (item.size == null ? '' : attachmentSize(item.size)) + '</small></span>';
    if (item.unavailable) return '<span class="message-attachment">' + icon('file', 24) + '<span>' + esc(name) + ' · 文件不可用</span></span>';
    if (!url) return '<button type="button" class="message-attachment" data-action="open-file" data-id="' + esc(item.id) + '">' + icon('file', 24) + title + '</button>';
    const rawView = typeof item.openUrl === 'string' && /^\/api\/attachments\/[a-z0-9-]+\/view$/i.test(item.openUrl) ? item.openUrl : '';
    const view = rawView ? (window.SummonHub?.apiPath?.(rawView) || rawView) : '';
    if (thumbnail) {
      return '<div><button type="button" class="message-attachment has-image" data-action="preview-image" data-src="' + esc(thumbnail) + '" data-download="' + esc(url) + '" data-name="' + esc(name) + '">' +
        '<img src="' + esc(thumbnail) + '" alt="' + esc(name) + '" loading="lazy">' + title + '</button></div>';
    }
    const fileIdMatch = typeof item.url === 'string' ? item.url.match(/^\/api\/files\/([^/?#]+)\/download/i) : null;
    const fileId = fileIdMatch ? decodeURIComponent(fileIdMatch[1]) : '';
    return '<div class="message-attachment-row">' +
      '<button type="button" class="message-attachment message-attachment-open" data-action="open-attachment"' +
        ' data-url="' + esc(url) + '"' +
        (view ? ' data-view="' + esc(view) + '"' : '') +
        (fileId ? ' data-file-id="' + esc(fileId) + '"' : '') +
        ' data-name="' + esc(name) + '"' +
        ' title="使用默认程序打开">' +
        icon('file', 24) + title +
      '</button>' +
      '<a class="message-attachment-download" href="' + esc(url) + '" download="' + esc(name) + '" title="下载文件" aria-label="下载 ' + esc(name) + '">' +
        icon('install', 16) +
      '</a>' +
    '</div>';
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
function matchAuthorizedWorkspaceFile(localPath) {
  if (!localPath || !Array.isArray(state.workspaces) || !state.workspaces.length) return null;
  const norm = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const target = norm(localPath);
  const lowerTarget = target.toLowerCase();
  let best = null;
  for (const ws of state.workspaces) {
    const root = norm(ws.path);
    if (!root) continue;
    const prefix = root.toLowerCase() + '/';
    if (lowerTarget.startsWith(prefix)) {
      const rel = target.slice(root.length + 1);
      if (rel && !rel.split('/').some(p => !p || p === '.' || p === '..')) {
        if (!best || root.length > best.rootLen) best = { workspace_id: ws.id, path: rel, rootLen: root.length };
      }
    }
  }
  return best ? { kind: 'workspace_file', workspace_id: best.workspace_id, path: best.path } : null;
}
async function addAttachments(roomId, files) {
  if (!roomById(roomId)) return;
  const items = ui.draftAttachments[roomId] ||= [], added = [];
  const localPaths = files.map(file => window.SummonDesktop?.getPathForFile?.(file) || '');
  if (localPaths.some(Boolean) && (!Array.isArray(state.workspaces) || !state.workspaces.length)) {
    try { state.workspaces = await readList('/api/workspaces'); } catch {}
  }
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const localPath = localPaths[i];
    const wsRef = localPath ? matchAuthorizedWorkspaceFile(localPath) : null;
    if (wsRef) {
      addDraftReference(roomId, wsRef);
      toast(`已关联工作区活文件：${wsRef.path}`);
      continue;
    }
    if (items.length >= attachmentLimit) { toast('每条消息最多添加 8 个附件。', true); break; }
    if (file.size > attachmentMaxBytes) { toast(`${file.name} 超过 20 MB，请选择小一些的文件。`, true); continue; }
    const item = { key: newClientId(), file, name: file.name || 'clipboard-file', size: file.size, status: 'staged',
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
  if (message._delivery === 'sending' || message._delivery === 'queued') {
    return '<div class="message-delivery is-sending" role="status" aria-label="正在发送"><span class="sending-progress-track"><span class="sending-progress-bar"></span></span></div>';
  }
  const rejected = message._delivery === 'rejected';
  return `<div class="message-delivery failed" role="status"><span>${esc(message._sendError || '尚未确认消息是否保存')}</span>
    <button class="text-button" data-action="${rejected ? 'restore-message-draft' : 'retry-message'}" data-id="${esc(message._retryId)}"
      ${!rejected && (!ui.protocolReady || ui.sendingRooms.has(message.roomId)) ? 'disabled' : ''}>${rejected ? '转回草稿' : '查询并重试'}</button></div>`;
}
function isBotPaused(bot) {
  return !bot || bot.enabled === false || bot.control?.state === 'paused' || bot.activity === 'paused';
}
function preferredWorkingBotId(roomId, deliveries = [], mentions = []) {
  for (const d of deliveries || []) {
    const bot = botById(d?.bot_id);
    if (bot && !isBotPaused(bot)) return bot.id;
  }
  const room = roomById(roomId);
  if (!room) return null;
  for (const id of mentions || []) {
    if (!room.members?.includes(id)) continue;
    const bot = botById(id);
    if (bot && !isBotPaused(bot)) return bot.id;
  }
  if (room.lead_bot_id) {
    const lead = botById(room.lead_bot_id);
    if (lead && !isBotPaused(lead)) return lead.id;
  }
  const memberBots = (room.members || []).map(botById).filter(b => b && !isBotPaused(b));
  const primary = memberBots.find(b => !isBuiltinGroupBot(b));
  return (primary || memberBots[0])?.id || null;
}
function reconcileOptimisticRoomWork(roomId, messages = [], activities = [], suspendedRuns = []) {
  const work = ui.optimisticRoomWork?.[roomId];
  if (!work) return;
  const hasLiveExec = (ui.roomExecutions || []).some(e => LIVE_EXEC_STATUSES.has(e.status));
  if ((activities || []).length || hasLiveExec || (suspendedRuns || []).length) {
    delete ui.optimisticRoomWork[roomId];
    return;
  }
  const sentIdx = (messages || []).findIndex(m => m.id === work.sentMessageId);
  if (sentIdx >= 0) {
    const hasReplyAfter = messages.slice(sentIdx + 1).some(m => m.senderId !== 'user' && m.senderId !== 'system' && m.senderId !== 'platform');
    if (hasReplyAfter) {
      delete ui.optimisticRoomWork[roomId];
      return;
    }
  }
  if (Date.now() - work.startedAt >= 3000) delete ui.optimisticRoomWork[roomId];
}
function queueLocalMessage(roomId, payload, attachments) {
  const clientId = newClientId(), entries = ui.localMessages[roomId] ||= {};
  const message = { content: payload.text, references: payload.references, mentions: payload.mentions, replyTo: payload.reply_to?.id,
    ...(payload.prompt_response ? { promptResponse: payload.prompt_response } : {}),
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
    const currentRoom = roomById(entry.roomId);
    const activeGoal = (ui.roomGoal && ui.roomGoal.room_id === entry.roomId) ? ui.roomGoal : currentRoom?.goal;
    if (activeGoal && ['completed', 'stopped'].includes(activeGoal.status)) {
      if (ui.roomGoal?.room_id === entry.roomId) ui.roomGoal = null;
      if (currentRoom) currentRoom.goal = null;
      if (ui.openRoomExecution === entry.roomId && ui.roomDrawerMode !== 'executions') ui.openRoomExecution = null;
    }
    const targetBotId = preferredWorkingBotId(entry.roomId, receipt.deliveries, message.mentions);
    if (targetBotId) {
      ui.optimisticRoomWork[entry.roomId] = { botId: targetBotId, sentMessageId: message.id, startedAt: Date.now() };
      for (const delay of [1600, 3400]) {
        setTimeout(() => {
          if (ui.optimisticRoomWork[entry.roomId]?.sentMessageId === message.id && ui.roomId === entry.roomId) {
            void loadCurrent().then(() => render());
          }
        }, delay);
      }
    }
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
async function closeModal(modal = $('#modal'), { suppressReturn = false } = {}) {
  const returnTab = !suppressReturn && !modal.classList.contains('settings-modal') ? ui.returnToSettingsTab : null;
  if (returnTab) ui.returnToSettingsTab = null;
  if (window.SummonMotion) await window.SummonMotion.closeDialog(modal); else modal.close();
  if (returnTab) openSettingsModal(returnTab);
}
const renderSignature = html => html
  .replace(/summon-avatar-clip-\d+/g, 'summon-avatar-clip')
  .replace(/crew-\d+/g, 'crew-id')
  .replace(/paper-avatar-\d+/g, 'paper-avatar-id')
  .replace(/(data-live-timer[^>]*>)[^<]*/g, '$1')
  .replace(/(data-live-quiet-duration[^>]*>)[^<]*/g, '$1');


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
function botById(id) {
  const local = state.bots.find(bot => bot.id === id);
  if (local || !window.SummonHub?.state?.nodeSnapshots) return local;
  for (const snap of window.SummonHub.state.nodeSnapshots.values()) {
    const found = (snap.bots || []).find(bot => bot.id === id);
    if (found) return found;
  }
  return undefined;
}
function isArchivedRoom(room) { return Boolean(room?.archived_at); }
function roomById(id) { return state.rooms.find(room => room.id === id) || (state.archivedRooms || []).find(room => room.id === id); }
function nameOf(id) { return id === 'user' ? ownerName() : botById(id)?.name || (['system', 'platform'].includes(id) ? 'Summon 平台' : id || 'Summon 平台'); }
function statusPill(value) { return `<span class="status ${esc(value)}">${esc(labels[value] || value || '未知')}</span>`; }
function renderPageNavBar(activeView = ui.view) {
  const shortTitles = { overview:'工作总览', usage:'Token 用量' };
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
      const targetUrl = window.SummonHub?.apiPath?.(path) || path;
      response = await fetch(targetUrl, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      if (response.status === 401) {
        if (window.SummonHub?.state?.mode === 'hub') {
          window.SummonHub.openAuthOverlay({ mode: 'login', dismissible: false });
          throw new Error('请重新登录 Summon Bot 账号');
        }
        location.reload();
        throw new Error('请重新输入访问 Token');
      }
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
function canvasOverviewContext() {
  return {
    state, esc, icon, avatar, groupAvatar, labels, LIVE_EXEC_STATUSES,
    executionLabel, executionError, executionPath, refKey, sameRef,
    roomById, botById, nameOf, formatTime, formatMemoryScope, formatBotModelSummary,
    renderReference, renderBotControls, api, toast, refresh, selectRoom,
  };
}
function render() {
  persistClientSession();
  const activeEl = document.activeElement;
  const activeChatKey = ui.creatingRoom ? DRAFT_ROOM_ID : ui.roomId;
  if (ui.composing && (activeEl?.id === 'message-input' && activeEl.form?.dataset.roomId === activeChatKey ||
      activeEl?.matches?.('.prompt-custom-input, .exec-prompt-input'))) { ui.renderDeferred = true; return; }
  ui.renderDeferred = false;
  const saved = preserveView();
  const navigation = window.SummonMotion?.captureNavigation(ui.view === 'chat' ? (ui.mobileRoom ? 'chat:' + activeChatKey : 'list') : ui.view);
  renderTopbar();
  globalThis.SummonCanvasOverview?.setContext(canvasOverviewContext());
  const main = $('#main-content');
  if (ui.view === 'overview') {
    const key = 'overview:canvas';
    if (main.dataset.viewKey !== key || !main.querySelector('[data-cv-host]')) {
      $('.messages')?._summonChatScroll?.stop();
      main.innerHTML = globalThis.SummonCanvasOverview.renderShell();
      ui.lastMainHtml = null;
      main.dataset.viewKey = key;
      main.scrollTop = 0;
    }
    globalThis.SummonCanvasOverview.mount(main);
    refreshOpenSettingsBody();
    window.SummonMotion?.finishNavigation(navigation);
    return;
  }
  const views = { chat:renderChat, usage:() => globalThis.SummonUsage.render({ esc, icon }) };
  const viewFn = views[ui.view] || renderChat;
  const key = ui.view + ':' + (ui.view === 'chat' ? activeChatKey : '');
  const html = viewFn(), signature = renderSignature(html);
  const restoreConversation = () => restoreConversationScroll($('.messages'), saved.chatScroll, { sameView:saved.key === key, ready:ui.creatingRoom || ui.messagesRoomId === ui.roomId, wasReady:saved.chatReady });
  if (ui.lastMainHtml !== signature || main.dataset.viewKey !== key) {
    const motion = captureMotion(main);
    $('.messages')?._summonChatScroll?.stop();
    main.innerHTML = html; ui.lastMainHtml = signature; main.dataset.viewKey = key; main.scrollTop = saved.top;
    resizeComposer($('#message-input')); hydrateMotion(main, motion);
    const panel = $('.detail-panel'); if (panel && panel.dataset.section === saved.panelSection) panel.scrollTop = saved.panelTop || 0;
  }
  restoreFocus(saved); restoreConversation(); markCurrentRoomRead();
  syncBotActivityDock();
  refreshOpenSettingsBody();
  window.SummonMotion?.finishNavigation(navigation);
}
function restoreFocus(saved) { if (!saved.focusId) return; const target = document.getElementById(saved.focusId); if (target) { target.focus({ preventScroll: true }); if (saved.start != null && target.setSelectionRange && !['number','email','file'].includes(target.type)) target.setSelectionRange(saved.start, saved.end); } }
function updateComposerButton(input) {
  const button = input?.form?.querySelector('.composer-send');
  if (!button) return;
  const targetRoomId = input.form.dataset.roomId;
  const isDraft = targetRoomId === DRAFT_ROOM_ID;
  const hasContent = Boolean(input.value.trim() || (!isDraft && (attachmentDrafts(targetRoomId).length || ui.draftReferences[targetRoomId]?.length)));
  const label = isDraft ? '创建并发送' : '发送消息';
  button.innerHTML = icon('send', 22);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = (isDraft ? (!ui.protocolReady || ui.creatingRoomBusy) : sendBusy(targetRoomId)) || !hasContent;
}
function resizeComposer(input) { if (!input) return; updateComposerButton(input); input.style.height = 'auto'; const height = input.scrollHeight, limit = parseFloat(getComputedStyle(input).maxHeight) || 150; input.style.height = `${Math.min(limit, height)}px`; input.style.overflowY = height > limit ? 'auto' : 'hidden'; }

const newClientId = () => globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const roomPath = id => '/api/rooms/' + encodeURIComponent(id);
const refKey = ref => ref && JSON.stringify([ref.kind, ref.id]);
const sameRef = (left, right) => !!left && !!right && left.kind === right.kind &&
  (left.kind === 'workspace_file' ? left.workspace_id === right.workspace_id && left.path === right.path : left.id === right.id);
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
  const hub = window.SummonHub;
  if (hub?.state?.initialized) {
    if (hub.state.mode === 'hub' && !hub.state.authenticated) return false;
    if (!hub.onlineNodes().length || !hub.state.activeNodeId) {
      ui.protocolReady = false;
      ui.protocolNotice = '';
      ui.streamConnected = hub.state.sseConnected;
      return false;
    }
  }
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
  if (hub?.state?.initialized && hub.state.activeNodeId) {
    ui.streamConnected = hub.state.sseConnected;
  } else if (!stream) {
    stream = new EventSource('/api/stream?protocol=' + protocolVersion);
    stream.onopen = () => { ui.streamConnected = true; scheduleRefresh(); };
    const onStream = () => {
      scheduleRefresh();
      window.SummonOnboarding?.notifyUpdate?.();
    };
    stream.onmessage = onStream;
    for (const type of ['change', 'state', 'message', 'room', 'delivery', 'execution', 'onboarding', 'workspace', 'engine']) stream.addEventListener(type, onStream);
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
    window.SummonHub?.syncActiveSnapshot?.(state);
    if (!Array.isArray(state.workspaces) || !state.workspaces.length) {
      void readList('/api/workspaces').then(list => { if (Array.isArray(list)) state.workspaces = list; }).catch(() => {});
    }
    globalThis.SummonModels.sync(state.modelSettings);
    globalThis.SummonModels.start({ api,render,toast,refresh });
    window.SummonOnboarding?.syncState?.(state.onboarding);
    void globalThis.SummonCache?.writeState(synced);
    if (!ui.creatingRoom && (!roomById(ui.roomId) || directRoom(roomById(ui.roomId)))) {
      const nextGroup = defaultGroupRoom();
      ui.roomId = nextGroup?.id ?? null;
      if (!ui.roomId) ui.creatingRoom = true;
      await restoreRoomMessages(ui.roomId);
    }
    if (!botById(ui.botId)) ui.botId = state.bots[0]?.id ?? null;
    if (ui.archiveDrawerOpen && !(state.archivedRooms || []).length) ui.archiveDrawerOpen = false;
    const visibleRooms = new Set([...state.rooms, ...(state.archivedRooms || [])].map(room => room.id));
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
  if (ui.view === 'usage') return globalThis.SummonUsage.load(api);
  if (ui.view === 'overview') {
    const [execPage, filesPage, workspaces] = await Promise.allSettled([
      api('/api/executions'),
      api('/api/files'),
      state.workspaces?.length ? Promise.resolve(state.workspaces) : readList('/api/workspaces'),
    ]);
    if (!current()) return;
    if (execPage.status === 'fulfilled') setListPage('executions', execPage.value);
    if (filesPage.status === 'fulfilled') setListPage('files', filesPage.value);
    if (workspaces.status === 'fulfilled' && Array.isArray(workspaces.value)) state.workspaces = workspaces.value;
    return;
  }
  if (ui.view !== 'chat' || !ui.roomId) return;
  const id = ui.roomId, request = ui.roomReadSeq[id] = (ui.roomReadSeq[id] || 0) + 1;
  const baseline = ui.messageCache.get(id);
  const synced = await requestSyncedSnapshot(roomPath(id) + '/messages', baseline);
  if (!synced || request !== ui.roomReadSeq[id] || !roomById(id)) return;
  const { messages, activities = [], suspendedRuns = [], goal = null, room, cursor } = synced.snapshot;
  const earlier = (baseline?.earlier || []).filter(item => !messages.some(message => message.id === item.id));
  const cached = { ...synced, earlier, historyCursor: baseline?.earlier ? baseline.historyCursor : cursor, messages: [...earlier, ...messages] };
  ui.messageCache.set(id, cached);
  void globalThis.SummonCache?.writeRoom(id, synced);
  reconcileRoomMessages(id, messages);
  if (ui.roomId !== id) return;
  ui.messagesRoomId = id; ui.messages = cached.messages; ui.historyCursor = cached.historyCursor;
  ui.roomActivities = Array.isArray(activities) ? activities : [];
  ui.roomSuspendedRuns = Array.isArray(suspendedRuns) ? suspendedRuns : [];
  ui.roomGoal = goal ?? null;
  const activeIndex = state.rooms.findIndex(item => item.id === id);
  if (room && activeIndex >= 0 && room.revision >= state.rooms[activeIndex].revision) {
    state.rooms[activeIndex] = { ...room, goal: goal ?? null };
  }
  const archivedIndex = (state.archivedRooms || []).findIndex(item => item.id === id);
  if (room && archivedIndex >= 0 && room.revision >= state.archivedRooms[archivedIndex].revision) {
    state.archivedRooms[archivedIndex] = { ...room, goal: goal ?? null };
  }
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
  if (ui.roomId === id && current()) {
    reconcileOptimisticRoomWork(id, cached.messages, ui.roomActivities, ui.roomSuspendedRuns);
  }
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
  ui.roomActivities = Array.isArray(cached?.snapshot.activities) ? cached.snapshot.activities : [];
  ui.roomGoal = cached?.snapshot.goal || roomById(id)?.goal || null;
  ui.roomDrawerMode = 'plan';
  ui.roomExecutions = []; ui.roomWakeups = []; ui.roomFiles = [];
}

async function acceptHistoryEpoch(response, generation) {
  if (!Object.hasOwn(response || {}, 'historyEpoch') && !Object.hasOwn(response?.snapshot || {}, 'historyEpoch')) return true;
  const epoch = response.historyEpoch ?? response.snapshot?.historyEpoch ?? null;
  if (epoch === ui.historyEpoch) return true;
  if (generation !== ui.historyGeneration || ui.retiredHistoryEpochs.has(epoch)) { scheduleRefresh(); return false; }
  ui.retiredHistoryEpochs.add(ui.historyEpoch); ui.historyEpoch = epoch; ui.historyGeneration++;
  ui.messages = []; ui.roomActivities = []; ui.roomGoal = null; ui.roomSuspendedRuns = []; ui.messagesRoomId = null;
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
    references:ui.draftReferences, attachments, localMessages, executionInputs, replies:ui.draftReplies };
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
  ui.draftReplies = saved.replies || {};
  if (saved.reply?.roomId && !ui.draftReplies[saved.reply.roomId]) ui.draftReplies[saved.reply.roomId] = saved.reply;
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
      if (!ui.creatingRoom && (!roomById(ui.roomId) || directRoom(roomById(ui.roomId)))) {
        ui.roomId = defaultGroupRoom()?.id ?? null;
        if (!ui.roomId) ui.creatingRoom = true;
      }
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
  if (view === 'models') return openSettingsModal('models');
  if (view === 'wakeups') return openSettingsModal('wakeups');
  if (view === 'connections') return openSettingsModal('connection');
  if (['members', 'executions', 'files'].includes(view)) view = 'overview';
  if (!['chat', 'overview', 'usage'].includes(view)) view = 'chat';
  ui.navigationSeq++; ui.menu = null; ui.view = view; location.hash = view;
  if (view !== 'chat') { ui.creatingRoom = false; ui.lastPanelView = view; }
  if (view === 'chat' && !ui.creatingRoom) await restoreRoomMessages(ui.roomId);
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

function groupRooms() {
  return state.rooms.filter(room => !directRoom(room) && room.members.includes('user'));
}

function defaultGroupRoom() {
  const groups = groupRooms().sort(recentConversations);
  return groups.find(room => room.id !== BOT_MAINTENANCE_ROOM_ID) || groups[0] || null;
}

function eggBotMember() {
  return state.bots.find(bot => bot.role_id === 'eggbot' && bot.enabled)
    || state.bots.find(bot => bot.role_id === 'eggbot')
    || null;
}

async function openNewGroupDraft() {
  ui.navigationSeq++;
  ui.creatingRoom = true;
  ui.view = 'chat';
  ui.mobileRoom = true;
  ui.menu = null;
  ui.detailOpen = false;
  ui.profileBotId = null;
  ui.avatarEditing = false;
  ui.openRoomExecution = null;
  location.hash = 'chat';
  if ((!Array.isArray(state.workspaces) || !state.workspaces.length) && ui.protocolReady) {
    void readList('/api/workspaces').then(list => {
      if (Array.isArray(list)) {
        state.workspaces = list;
        if (ui.creatingRoom) render();
      }
    }).catch(() => {});
  }
  render();
  if (!matchMedia('(pointer: coarse)').matches) $('#message-input')?.focus();
}

async function submitDraftGroupMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || !ui.protocolReady || ui.creatingRoomBusy) return;
  ui.creatingRoomBusy = true;
  render();
  const workspace = ui.draftWorkspaceId || '';
  try {
    const room = await api('/api/rooms', 'POST', {
      members: [],
      mode: 'group',
      auto_title: true,
      skip_welcome: true,
      ...(workspace ? { workspace } : {}),
    });
    const latestBots = await readList('/api/bots').catch(() => null);
    if (latestBots) state.bots = latestBots;
    if (!state.rooms.some(item => item.id === room.id)) state.rooms.push(room);
    ui.creatingRoom = false;
    ui.creatingRoomBusy = false;
    ui.draftWorkspaceId = '';
    ui.drafts[DRAFT_ROOM_ID] = '';
    ui.navigationSeq++;
    ui.roomId = room.id;
    ui.view = 'chat';
    ui.mobileRoom = true;
    ui.menu = null;
    ui.detailOpen = false;
    ui.profileBotId = null;
    ui.avatarEditing = false;
    ui.messagesRoomId = room.id;
    ui.messages = [];
    ui.historyCursor = null;
    ui.roomSuspendedRuns = [];
    ui.roomActivities = [];
    ui.roomGoal = null;
    ui.roomDrawerMode = 'plan';
    ui.openRoomExecution = null;
    ui.activityTickerIndex = 0;
    location.hash = 'chat';
    const leadId = (room.lead_bot_id && room.members.includes(room.lead_bot_id))
      ? room.lead_bot_id
      : (room.members || []).map(botById).find(b => b?.role_id === 'group-lead' && b.enabled)?.id || null;
    const lead = leadId ? botById(leadId) : null;
    const mentions = leadId && (!lead || lead.enabled) ? [leadId] : [];
    const entry = queueLocalMessage(room.id, { text, mentions, references: [], attachments: [] }, []);
    await sendLocalMessage(entry, true);
    await loadCurrent();
    render();
  } catch (error) {
    ui.creatingRoomBusy = false;
    ui.drafts[DRAFT_ROOM_ID] = text;
    render();
    throw error;
  }
}

async function selectRoom(id, nodeId = null) {
  if (!id) return;
  const hub = window.SummonHub;
  if (nodeId && hub && nodeId !== hub.state.activeNodeId) {
    const switched = await hub.switchNode(nodeId, { refresh: false });
    if (switched) {
      ui.stateSnapshot = null;
      ui.stateCursor = null;
      ui.messagesRoomId = null;
      ui.messages = [];
      ui.historyCursor = null;
      ui.draftWorkspaceId = '';
      const snap = hub.state.nodeSnapshots.get(nodeId);
      if (snap) {
        state.rooms = snap.rooms || [];
        state.archivedRooms = snap.archivedRooms || [];
        state.bots = snap.bots || [];
      }
      ui.navigationSeq++; ui.creatingRoom = false; ui.roomId = id; ui.view = 'chat'; ui.mobileRoom = true;
      ui.menu = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false;
      ui.roomSuspendedRuns = []; ui.roomActivities = []; ui.roomGoal = null; ui.roomDrawerMode = 'plan'; ui.openRoomExecution = null; ui.activityTickerIndex = 0;
      location.hash = 'chat';
      render();
      await refresh(true);
      return;
    }
  }
  ui.navigationSeq++; ui.creatingRoom = false; ui.roomId = id; ui.view = 'chat'; ui.mobileRoom = true;
  ui.menu = null; ui.detailOpen = false; ui.profileBotId = null; ui.avatarEditing = false;
  ui.roomSuspendedRuns = []; ui.roomActivities = []; ui.roomGoal = roomById(id)?.goal || null; ui.roomDrawerMode = 'plan';
  ui.openRoomExecution = null; ui.activityTickerIndex = 0;
  location.hash = 'chat';
  await restoreRoomMessages(id);
  render();
  await loadCurrent();
  render();
}

function isBuiltinGroupBot(bot) {
  return bot?.role_id === 'eggbot';
}

function memberChoices(selected = [], { excludeBuiltin = false, legend = 'Bot 成员' } = {}) {
  const list = excludeBuiltin ? state.bots.filter(bot => !isBuiltinGroupBot(bot)) : state.bots;
  if (!list.length) return '';
  return `<fieldset class="form-field member-options"><legend>${esc(legend)}</legend>${list.map(bot => {
    const roleTag = bot.role_id === 'group-lead' ? '主控' : bot.role_id === 'eggbot' ? '团队孵化' : '';
    return `<label class="member-choice">${avatar(bot.id,32)}
    <span>${esc(bot.name)}${roleTag ? ` <em class="member-role-badge">${esc(roleTag)}</em>` : ''}</span><input type="checkbox" name="members" value="${esc(bot.id)}" ${selected.includes(bot.id) ? 'checked' : ''}></label>`;
  }).join('')}</fieldset>`;
}

async function roomWorkspaceField(current) {
  const choices = (await readList('/api/workspaces')).filter(item => item.write !== false || item.id === current);
  return selectField('群项目目录', 'workspace', [{ value:'', label:'未绑定' },
    ...choices.map(item => ({ value:item.id, label:item.name + ' · ' + item.path }))],current || '');
}

async function openRoomEdit() {
  const room = roomById(ui.roomId);
  if (!room || isArchivedRoom(room)) return;
  const old = room.members.filter(id => id !== 'user');
  const workspaceField = room.mode === 'group' ? await roomWorkspaceField(room.workspace?.id) : '';
  openModal('编辑会话', '', field('会话名称', 'title', room.name, { placeholder:'留空保留原名称' }) + workspaceField + memberChoices(old), async data => {
    const selected = data.getAll('members'), previous = old.filter(id => botById(id)), title = data.get('title').trim();
    await api(roomPath(room.id), 'PATCH', { revision:room.revision, ...(title && title !== room.name ? { title } : {}),
      ...(workspaceField && data.get('workspace') !== (room.workspace?.id || '') ? {workspace:data.get('workspace') || null} : {}),
      add_members:selected.filter(id => !old.includes(id)), remove_members:previous.filter(id => !selected.includes(id)) });
  });
}

async function archiveRoom(roomId) {
  const room = roomById(roomId || ui.roomId);
  if (!room?.archivable || isArchivedRoom(room)) return;
  await api(roomPath(room.id) + '/archive', 'POST', { revision: room.revision });
  const key = `room:${room.id}`;
  if (homeOrg.pinnedKeys.includes(key)) {
    homeOrg.pinnedKeys = homeOrg.pinnedKeys.filter(k => k !== key);
    saveHomeOrg();
  }
  const wasSelected = ui.roomId === room.id;
  await refresh();
  if (wasSelected && !ui.archiveDrawerOpen) {
    const next = defaultGroupRoom();
    ui.detailOpen = false;
    ui.profileBotId = null;
    if (next) await selectRoom(next.id);
    else { ui.roomId = null; ui.creatingRoom = true; render(); }
  }
  toast(`已将「${room.name}」收进归档群助手`);
}

async function restoreRoom(roomId) {
  const room = roomById(roomId || ui.roomId);
  if (!room || !isArchivedRoom(room)) return;
  await api(roomPath(room.id) + '/restore', 'POST', { revision: room.revision });
  await refresh();
  if (!(state.archivedRooms || []).length) ui.archiveDrawerOpen = false;
  toast(`已将「${room.name}」移出归档`);
  render();
}

async function stopCurrentRoom() {
  const room = roomById(ui.roomId);
  if (!room) return;
  delete ui.optimisticRoomWork[room.id];
  const result = await api(roomPath(room.id) + '/stop', 'POST', {});
  const convCount = result.conversations?.length || 0;
  const sessCount = result.sessions?.length || 0;
  const detachedCount = result.detached?.length || 0;
  toast(`已打断本群在途工作：对话 ${convCount}、子执行 ${sessCount}${detachedCount ? `（后台脱钩 ${detachedCount}）` : ''}`);
  await refresh();
}

function archiveBotConfirm(bot) {
  if (!bot) return;
  openModal('归档 Bot', bot.name, '<p>归档后将自动移出所有群聊、打断其非共享在途执行，并从常用列表中隐藏。历史消息与私有文件仍对宿主只读保留，可随时恢复。</p>', async () => {
    await api('/api/bots/' + encodeURIComponent(bot.id) + '/archive', 'POST', { revision: bot.revision });
    if (ui.profileBotId === bot.id) ui.profileBotId = null;
  }, '确认归档');
}

function deleteBotConfirm(bot) {
  if (!bot) return;
  openModal('彻底删除 Bot', bot.name, '<p>将永久删除该自定义 Bot 的配置与订阅，并清理其未完成任务。历史群消息仍保留发送者名称快照。</p>', async () => {
    await api('/api/bots/' + encodeURIComponent(bot.id), 'DELETE', { revision: bot.revision });
    if (ui.botId === bot.id) ui.botId = null;
    if (ui.profileBotId === bot.id) ui.profileBotId = null;
  }, '彻底删除');
}

function deleteGroup() {
  const room = roomById(ui.roomId);
  if (!room?.deletable) return;
  openModal('删除群聊', room.name, '<p>删除后，所有成员都无法再打开这个群聊；群内已保存的平台文件仍可在“资料”页中只读下载。</p>', async () => {
    await api(roomPath(room.id), 'DELETE', { revision:room.revision });
    ui.detailOpen = false;
  }, '删除群聊');
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
  const settings = await api('/api/model-settings').catch(() => ({ connections:[] }));
  const currentId = model?.connection_id || settings.activeId || settings.connections[0]?.id || '';
  const connOptions = settings.connections.map(item => ({ value:item.id, label:`${item.name || item.id}${item.active ? '（默认）' : ''}` }));
  if (currentId && !connOptions.some(item => item.value === currentId)) connOptions.push({ value:currentId, label:currentId + ' · 当前绑定' });
  const optionalConnOptions = [{ value:'', label:'沿用主连接' }, ...connOptions];
  const role = bot.role_id || '';
  const catalogRoles = (state.roles || []).map(item => ({ value: item.id, label: `${item.name} (${item.id})` }));
  const roles = [{ value:'', label:'未指定内置角色' }, ...(catalogRoles.length ? catalogRoles : [
    { value:'default', label:'默认成员 (default)' },
    { value:'group-lead', label:'群主控 (group-lead)' },
    { value:'eggbot', label:'EggBot (eggbot)' },
  ])];
  if (role && !roles.some(item => item.value === role)) roles.push({ value:role, label:role });
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
    '</datalist>', async data => {
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
  const permissions = resourceChoices('模型连接',models.connections,access.model_ids) + resourceChoices('执行目录',workspaces,access.workspace_ids);
  openModal(bot.name + ' 的资源权限','',permissions,async data => {
    await api(path,'PATCH',{ revision:access.revision, model_ids:data.getAll('模型连接'), workspace_ids:data.getAll('执行目录') });
  });
}

function editWorkspace(item) {
  const canPick = Boolean(window.SummonDesktop?.pickDirectory);
  const body = field('目录名称','name',item?.name || '',{ required:true }) + field('绝对路径','path',item?.path || '',{ required:true,placeholder:'D:/projects/example' }) +
    (canPick ? '<div style="margin:-4px 0 8px"><button type="button" class="secondary-button small-button" data-action="pick-workspace-dir">选择本地文件夹…</button></div>' : '') +
    `<label class="checkbox-line"><input type="checkbox" name="write" ${item ? (item.write === true ? 'checked' : '') : 'checked'}>允许执行器写入</label>`;
  openModal(item ? '编辑执行目录' : '登记执行目录','',body,async data => {
    await api('/api/workspaces' + (item ? '/' + encodeURIComponent(item.id) : ''),item ? 'PATCH' : 'POST',{
      name:data.get('name').trim(),path:data.get('path').trim(),write:data.has('write'),...(item ? { revision:item.revision } : {}),
    });
  });
}

async function toggleWorkEngine(engineId, enabled) {
  if (!engineId) return;
  const updated = await api(`/api/engines/${encodeURIComponent(engineId)}`, 'PATCH', { enabled });
  const list = (state.engines || []).filter(item => item.id !== engineId);
  list.push(updated);
  list.sort((a, b) => a.id.localeCompare(b.id));
  state.engines = list;
  toast(updated.enabled ? `已启用工作引擎「${updated.name}」` : `已停用工作引擎「${updated.name}」`);
  refreshOpenSettingsBody();
}

async function checkWorkEngine(engineId) {
  if (!engineId) return;
  const result = await api(`/api/engines/${encodeURIComponent(engineId)}/check`, 'POST', { wake: true });
  ui.returnToSettingsTab = null;
  const modal = $('#modal');
  if (modal?.open) await closeModal(modal);
  toast(`已通知 Summon 主控自检「${result?.engine?.name || engineId}」`);
  if (result?.room_id) {
    ui.view = 'chat';
    ui.roomId = result.room_id;
    await loadCurrent();
    render();
  }
}

async function openEngineFileModal(engineId, relPath) {
  const engine = (state.engines || []).find(item => item.id === engineId);
  const file = await api(`/api/engines/${encodeURIComponent(engineId)}/file?path=${encodeURIComponent(relPath)}`);
  const title = `${engine?.name || engineId} · ${relPath}`;
  openModal(title, '', `<p class="subtle" style="margin:0 0 8px">${esc(relPath)}</p>` +
    field('文件内容', 'content', file.content || '', { type: 'textarea', rows: 14 }), async data => {
    await api(`/api/engines/${encodeURIComponent(engineId)}/file`, 'PUT', { path: relPath, content: data.get('content') });
    toast(`已保存 ${relPath}`);
  });
}

async function openEngineFilesModal(engineId) {
  const engine = await api(`/api/engines/${encodeURIComponent(engineId)}`);
  const files = Array.isArray(engine.files) ? engine.files : [];
  const metaHtml = `<p class="subtle" style="margin:0 0 10px;font-size:12.5px">CLI：<code>${esc(engine.command || '—')}</code>${engine.detected_path ? `（${esc(engine.detected_path)}）` : '（未检测到）'}</p>`;
  const rows = files.map(file => `<div class="pin-row">
    <button type="button" class="profile-record record-button" data-action="open-engine-file" data-engine-id="${esc(engine.id)}" data-path="${esc(file.path)}">
      <strong>${esc(file.path)}</strong><small>${Math.max(1, Math.round((file.size || 0) / 1024 * 10) / 10)} KB</small>
    </button></div>`).join('');
  openModal(`工作引擎文件 · ${engine.name || engine.id}`, engine.summary || '', metaHtml + (rows || '<p class="panel-empty">暂无文件</p>'));
}

async function openBotFolderFileModal(botId, relPath = null) {
  const bot = botById(botId) || (state.archivedBots || []).find(item => item.id === botId);
  if (!bot) return;
  let initialContent = '';
  if (relPath) {
    const file = await api(`/api/bots/${encodeURIComponent(botId)}/file?path=${encodeURIComponent(relPath)}`);
    initialContent = file.content || '';
  }
  const title = relPath ? `${bot.name} · ${relPath}` : `新增 Bot 文件 · ${bot.name}`;
  const pathField = relPath
    ? `<p class="subtle" style="margin:0 0 8px">${esc(relPath)}</p>`
    : field('文件路径（相对 Bot 目录）', 'path', 'skills/', { required: true, placeholder: '例如 skills/guide.md 或 scripts/run.mjs' });
  openModal(title, '', pathField + field('文件内容', 'content', initialContent, { type: 'textarea', rows: 14 }), async data => {
    const targetPath = relPath || data.get('path').trim();
    await api(`/api/bots/${encodeURIComponent(botId)}/file`, 'PUT', { path: targetPath, content: data.get('content') });
    toast(`已保存 ${targetPath}`);
  });
}

function renderBotFolderSection(bot) {
  if (!bot) return '';
  const files = Array.isArray(bot.folder_files) ? bot.folder_files : [];
  const rows = files.map(file => `<div class="pin-row">
    <button type="button" class="profile-record record-button" data-action="open-bot-folder-file" data-bot-id="${esc(bot.id)}" data-path="${esc(file.path)}">
      <strong>${esc(file.path)}</strong><small>${Math.max(1, Math.round((file.size || 0) / 1024 * 10) / 10)} KB</small>
    </button></div>`).join('');
  return `<div class="profile-section-heading" style="margin-top:14px"><span>Bot 目录文件（skills / scripts / memory）</span>
    ${!bot.archived_at ? `<button type="button" class="icon-button" data-action="new-bot-folder-file" data-bot-id="${esc(bot.id)}" aria-label="新增 Bot 文件">${icon('plus', 18)}</button>` : ''}</div>
    ${rows || '<p class="panel-empty">暂无目录文件</p>'}`;
}

async function openExecutionForm() {
  const workspaces = await readList('/api/workspaces');
  const choices = [{ value:'', label:'默认工作区' }, ...workspaces.map(item => ({ value:item.id, label:item.name + ' · ' + item.path }))];
  openModal('执行本机命令', '', selectField('执行目录', 'workspace', choices, '') +
    field('命令（Shell）', 'shell', '', { type:'textarea', rows:4, required:true, placeholder:'输入要在本机执行的命令' }), async data => {
    const workspace = data.get('workspace');
    const detail = await api('/api/executions', 'POST', {
      engine: 'exec',
      input: { shell: data.get('shell').trim() },
      ...(workspace ? { workspace: { kind: 'workspace', id: workspace } } : {}),
    }, { clientId: newClientId() });
    ui.executionRef = detail.execution_ref; ui.executionDetail = detail;
  }, '执行');
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
    if (ui.view === 'files') { ui.fileId = saved.id; ui.fileRevision = null; await loadFile(saved.id); }
  });
}

function wakeupById(id) {
  return (state.wakeups || []).find(item => item.id === id)
    || (ui.roomWakeups || []).find(item => item.id === id);
}
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
  const [items, workspaces] = await Promise.all([
    readList('/api/files?room=' + encodeURIComponent(room.id)).catch(() => []),
    state.workspaces?.length ? Promise.resolve(state.workspaces) : readList('/api/workspaces').catch(() => []),
  ]);
  if (workspaces.length) state.workspaces = workspaces;
  if (ui.roomId !== room.id) return;
  const options = [{ value:'',label:'选择平台资料' }, ...items.map(item => ({ value:item.id, label:item.name || item.path }))];
  const wsOptions = [{ value:'', label:'选择授权工作区（活文件引用）' }, ...workspaces.map(ws => ({ value: ws.id, label: `${ws.name} (${ws.path})` }))];
  const defaultWs = room.workspace?.id || workspaces[0]?.id || '';
  openModal('添加资料或工作区文件引用','',
    selectField('平台资料','file',options,'') +
    field('或填写平台文件 ID','file_id','',{ placeholder:'可引用的平台文件 ID' }) +
    '<hr style="border:none;border-top:1px solid var(--line);margin:12px 0">' +
    selectField('工作区活文件 · 目录','workspace_id',wsOptions,defaultWs) +
    '<div class="ws-browser" data-ws-browser>' +
      '<div class="ws-browser-bar">' +
        '<span class="ws-browser-crumb" data-ws-crumb>目录：/</span>' +
        '<button type="button" class="secondary-button ws-browser-up" data-ws-up disabled>上级目录</button>' +
      '</div>' +
      '<div class="ws-browser-list" data-ws-list role="listbox" aria-label="工作区文件列表"><div class="ws-browser-empty">选择工作区后浏览文件</div></div>' +
    '</div>' +
    field('工作区相对路径','workspace_path','',{ placeholder:'例如 docs/readme.md 或 dist/output.html' }),
    data => {
      const wsId = data.get('workspace_id')?.trim();
      const wsPath = data.get('workspace_path')?.trim().replace(/\\/g, '/').replace(/^\/+/, '');
      if (wsId && wsPath) {
        addDraftReference(room.id, { kind: 'workspace_file', workspace_id: wsId, path: wsPath });
        return;
      }
      const id = data.get('file_id').trim() || data.get('file');
      if (id) addDraftReference(room.id,{ kind:'file',id });
      else throw new Error('请选择平台资料、填写文件 ID，或选择工作区与相对路径。');
    },'加入消息');

  const form = $('#modal-form');
  if (!form) return;
  const wsSelect = form.elements.workspace_id;
  const pathInput = form.elements.workspace_path;
  const crumbEl = $('[data-ws-crumb]', form);
  const upBtn = $('[data-ws-up]', form);
  const listEl = $('[data-ws-list]', form);
  let currentDir = '.';
  let browseSeq = 0;
  let loadedEntries = [];
  let nextCursor = null;

  function renderEntries() {
    if (!loadedEntries.length) {
      listEl.innerHTML = '<div class="ws-browser-empty">此目录暂无可读文件</div>';
      return;
    }
    const sorted = [...loadedEntries].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    const itemsHtml = sorted.map(entry => {
      const isDir = entry.kind === 'directory';
      const selected = !isDir && pathInput.value.trim() === entry.path;
      return `<button type="button" class="ws-browser-item${selected ? ' selected' : ''}" role="option" aria-selected="${selected ? 'true' : 'false'}" data-ws-entry-kind="${isDir ? 'directory' : 'file'}" data-ws-entry-path="${esc(entry.path)}">${isDir ? '📁' : '📄'} <span>${esc(entry.name)}${isDir ? '/' : ''}</span></button>`;
    }).join('');
    const moreHtml = nextCursor
      ? '<button type="button" class="secondary-button ws-browser-more" data-ws-more>加载更多</button>'
      : '';
    listEl.innerHTML = itemsHtml + moreHtml;
  }

  async function loadDir(wsId, dir = '.', cursor = null) {
    const seq = ++browseSeq;
    const append = Boolean(cursor);
    if (!append) {
      currentDir = dir || '.';
      loadedEntries = [];
      nextCursor = null;
    }
    if (!wsId) {
      crumbEl.textContent = '目录：/';
      upBtn.disabled = true;
      listEl.innerHTML = '<div class="ws-browser-empty">选择工作区后浏览文件</div>';
      return;
    }
    crumbEl.textContent = currentDir === '.' ? '目录：/' : `目录：/${currentDir}`;
    upBtn.disabled = currentDir === '.';
    if (!append) {
      listEl.innerHTML = '<div class="ws-browser-empty">加载中…</div>';
    } else {
      const moreBtn = $('[data-ws-more]', listEl);
      if (moreBtn) { moreBtn.disabled = true; moreBtn.textContent = '加载中…'; }
    }
    try {
      const query = '?directory=' + encodeURIComponent(currentDir) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const res = await api('/api/workspaces/' + encodeURIComponent(wsId) + query);
      if (seq !== browseSeq || !form.isConnected) return;
      const incoming = Array.isArray(res?.items) ? res.items : [];
      const seen = new Set(loadedEntries.map(item => item.path));
      for (const item of incoming) {
        if (!seen.has(item.path)) {
          seen.add(item.path);
          loadedEntries.push(item);
        }
      }
      nextCursor = res?.next_cursor && res.next_cursor !== cursor ? res.next_cursor : null;
      renderEntries();
    } catch (error) {
      if (seq !== browseSeq || !form.isConnected) return;
      if (append) renderEntries();
      else listEl.innerHTML = `<div class="ws-browser-empty">${esc(error.message || '无法读取工作区目录')}</div>`;
    }
  }

  wsSelect?.addEventListener('change', () => {
    pathInput.value = '';
    void loadDir(wsSelect.value, '.');
  });
  upBtn?.addEventListener('click', () => {
    if (currentDir === '.') return;
    const parts = currentDir.split('/').filter(Boolean);
    parts.pop();
    void loadDir(wsSelect.value, parts.length ? parts.join('/') : '.');
  });
  listEl?.addEventListener('click', event => {
    const moreBtn = event.target.closest('[data-ws-more]');
    if (moreBtn && nextCursor) {
      void loadDir(wsSelect.value, currentDir, nextCursor);
      return;
    }
    const btn = event.target.closest('[data-ws-entry-path]');
    if (!btn) return;
    const kind = btn.dataset.wsEntryKind;
    const entryPath = btn.dataset.wsEntryPath;
    if (kind === 'directory') {
      void loadDir(wsSelect.value, entryPath);
    } else {
      pathInput.value = entryPath;
      for (const el of listEl.querySelectorAll('.ws-browser-item')) {
        const isSelf = el === btn;
        el.classList.toggle('selected', isSelf);
        el.setAttribute('aria-selected', isSelf ? 'true' : 'false');
      }
    }
  });
  if (defaultWs) void loadDir(defaultWs, '.');
}

function addDraftReference(roomId, ref) {
  const selected = ui.draftReferences[roomId] ||= [];
  if (!selected.some(item => sameRef(item,ref))) selected.push(ref);
  render();
}

async function openReference(ref) {
  if (ref.kind === 'workspace_file') {
    const rawDownloadUrl = `/api/workspaces/${encodeURIComponent(ref.workspace_id)}/file?path=${encodeURIComponent(ref.path)}`;
    const downloadUrl = window.SummonHub?.apiPath?.(rawDownloadUrl) || rawDownloadUrl;
    const previewUrl = `${downloadUrl}&preview=1`;
    const ws = (state.workspaces || []).find(item => item.id === ref.workspace_id);
    const fileName = ref.path.split('/').pop() || ref.path;
    let contentLength = 0;
    try {
      const check = await fetch(downloadUrl, { method: 'HEAD' });
      if (!check.ok) {
        const msg = check.status === 404 ? '工作区文件已移动、重命名或被删除（404）。' : check.status === 403 ? '该工作区目录权限已撤销或无权读取（403）。' : `无法读取工作区文件（HTTP ${check.status}）。`;
        return openModal('工作区文件不可用', ws?.name || ref.workspace_id, `<p>${esc(msg)}</p><p><small>${esc(ref.path)}</small></p>`);
      }
      contentLength = Number(check.headers.get('content-length') || 0);
    } catch { /* fall through to modal with links */ }
    const ext = (fileName.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
    const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
    const textExts = new Set(['.txt', '.md', '.markdown', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm', '.xml', '.yml', '.yaml', '.csv', '.py', '.sh', '.ps1', '.swift', '.kt', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.sql', '.log', '.toml', '.ini', '.env']);
    let previewHtml = '';
    if (imageExts.has(ext)) {
      previewHtml = `<div class="ws-preview-box"><img class="ws-preview-image" src="${esc(previewUrl)}" alt="${esc(fileName)}"></div>`;
    } else if (textExts.has(ext) && contentLength <= 131072) {
      try {
        const res = await fetch(previewUrl);
        if (res.ok) previewHtml = `<pre class="execution-output ws-preview-text">${esc(await res.text())}</pre>`;
      } catch {}
    }
    return openModal('工作区活文件', ws?.name || ref.workspace_id,
      `<p><strong>${esc(fileName)}</strong></p><p><small>${esc(ref.path)}</small></p>` +
      previewHtml +
      `<div style="display:flex;gap:10px;margin-top:14px">
         <a class="primary-button" href="${esc(previewUrl)}" target="_blank" rel="noopener noreferrer">新标签页预览</a>
         <a class="secondary-button" href="${esc(downloadUrl)}" download="${esc(fileName)}">流式下载</a>
       </div>`);
  }
  if (ref.kind === 'file') {
    await navigate('overview');
    globalThis.SummonCanvasOverview?.focusFile(ref.id);
    return;
  }
  if (ref.kind === 'session' || ref.kind === 'conversation') {
    await navigate('overview');
    globalThis.SummonCanvasOverview?.focusExecution(ref);
    return;
  }
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
  else if (ref.kind === 'call') {
    value = await api('/api/calls/' + encodeURIComponent(ref.id));
    const status = typeof value.result?.status === 'string' ? value.result.status : (value.status || 'unknown');
    const httpStatus = typeof value.result?.status === 'number' ? value.result.status : null;
    const exitCode = Number.isInteger(value.result?.exit_code) ? value.result.exit_code
      : (Number.isInteger(value.result?.native?.exit_code) ? value.result.native.exit_code
        : (Number.isInteger(value.result?.output?.exit_code) ? value.result.output.exit_code : null));
    const errText = value.result?.error || value.result?.output?.error || '';
    const errCode = value.result?.code || value.result?.output?.code || '';
    const outText = typeof value.result?.output === 'string'
      ? value.result.output
      : (value.result?.output?.text || value.result?.output?.message || '');
    const summaryRows = [
      `<dt>工具</dt><dd>${esc(value.tool || '—')}</dd>`,
      `<dt>状态</dt><dd>${statusPill(status)}</dd>`,
      httpStatus !== null ? `<dt>HTTP 状态</dt><dd>${esc(String(httpStatus))}</dd>` : '',
      exitCode !== null ? `<dt>退出码</dt><dd>${esc(String(exitCode))}</dd>` : '',
      value.submitted_by?.id ? `<dt>发起者</dt><dd>${esc(nameOf(value.submitted_by.id))}</dd>` : '',
      value.target?.kind && value.target?.id ? `<dt>目标</dt><dd>${renderReference(value.target)}</dd>` : '',
      errText || errCode ? `<dt>错误信息</dt><dd class="execution-error">${esc([errCode, errText].filter(Boolean).join(' · '))}</dd>` : '',
      outText ? `<dt>结果摘要</dt><dd><pre class="execution-output">${esc(outText.slice(0, 2000))}</pre></dd>` : '',
    ].filter(Boolean).join('');
    return openModal('调用详情', value.tool || '', `<div class="execution-facts"><dl>${summaryRows}</dl></div><details style="margin-top:12px"><summary>查看原始数据</summary><pre class="execution-output">${esc(JSON.stringify(value, null, 2))}</pre></details>`);
  }
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
    || ui.draftTargets[roomId]?.length || ui.draftReplies[roomId])
    throw new Error('请先保存或清空输入框里的草稿，再恢复这条消息。');
  ui.drafts[roomId] = payload.text;
  ui.draftTargets[roomId] = payload.mentions || [];
  ui.draftReferences[roomId] = payload.references || [];
  ui.draftAttachments[roomId] = (message.attachments || []).map(attachment => ({
    key:newClientId(),status:'ready',name:attachment.name,size:attachment.size,attachment,
  }));
  if (payload.reply_to?.id) ui.draftReplies[roomId] = ui.messages.find(item => item.id === payload.reply_to.id) ??
    { id:payload.reply_to.id,roomId,content:'原消息' };
  delete ui.localMessages[roomId][clientId];
  render();
  $('#message-input')?.focus();
}

async function controlExecution() {
  const detail = ui.executionDetail;
  const base = { target:detail.execution_ref, control_version:detail.control_version };
  openModal('打断当前运行','中止当前在途工作并立即脱钩，会话保持活跃可直接接下一句话。',selectField('范围','scope',[
    { value:'target_and_owned_calls',label:'此执行及全部非共享后代子执行（推荐）' },
    { value:'target',label:'仅打断当前此执行' },
  ],'target_and_owned_calls'),async data => {
    const result = await api('/api/executions/stop','POST',{ ...base,scope:data.get('scope') },{ clientId:newClientId() });
    ui.stopResults = result.targets;
  },'立即打断');
}

async function act(action, element) {
  const { id, kind, workspaceId, path: refPath } = element.dataset;
  const ref = kind === 'workspace_file' ? { kind, workspace_id: workspaceId, path: refPath } : { kind, id };
  if (action.startsWith('usage-')) return globalThis.SummonUsage.act(action,element,api,render);
  if (action.startsWith('models-')) return globalThis.SummonModels.act(action,element,{ api,render,toast,refresh });
  if (action === 'set-theme') return setThemePreference(element.dataset.theme);
  if (action === 'toggle-folder') return toggleFolderCollapsed(id);
  if (action === 'home-pin') return togglePinEntry(element.dataset.key);
  if (action === 'home-move') return moveEntryToFolder(element.dataset.key, element.dataset.folder || null);
  if (action === 'open-archive-assistant') {
    $('.app-shell')?.classList.remove('sidebar-collapsed');
    ui.archiveDrawerOpen = true;
    return renderTopbar();
  }
  if (action === 'close-archive-assistant') {
    ui.archiveDrawerOpen = false;
    return renderTopbar();
  }
  if (action === 'archive-room') return archiveRoom(id || element.dataset.room);
  if (action === 'restore-room') return restoreRoom(id || element.dataset.room);
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
  if (action === 'back-to-room-details') { ui.profileBotId = null; ui.detailTab = 'members'; ui.avatarEditing = false; render(); await loadCurrent(); return render(); }
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
  if (action === 'preview-onboarding') {
    await closeModal($('#modal'), { suppressReturn: true });
    if (window.SummonDesktop?.previewDesktopIntro) {
      await window.SummonDesktop.previewDesktopIntro();
    } else {
      window.SummonOnboarding?.startPreview();
    }
    return;
  }
  if (action === 'pick-workspace-dir') {
    const picked = await window.SummonDesktop?.pickDirectory?.();
    if (picked) {
      const form = $('#modal-content form');
      if (form?.elements?.path) form.elements.path.value = picked;
      if (form?.elements?.name && !form.elements.name.value.trim()) {
        const base = picked.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || picked;
        form.elements.name.value = base;
      }
    }
    return;
  }
  if (action === 'navigate') return navigate(element.dataset.view);
  if (action === 'refresh') return refresh(true);
  if (action === 'close-modal') return closeModal();
  if (action === 'open-settings') return openSettingsModal(element.dataset.tab || 'general');
  if (action === 'settings-tab') return openSettingsModal(element.dataset.tab || 'general');
  if (action === 'settings-navigate') { await closeModal($('#modal'), { suppressReturn: true }); return navigate(element.dataset.view); }
  if (action === 'open-panel') return navigate(ui.lastPanelView || 'overview');
  if (action === 'open-panel-room') {
    await navigate('overview');
    if (element.dataset.room) globalThis.SummonCanvasOverview?.focusRoom(element.dataset.room);
    return;
  }
  if (action === 'client-downloads') return openSettingsModal('updates', ui.releasesUrl);
  if (action === 'install-desktop-update') {
    closeFloatingMenus();
    return window.SummonClients?.install?.();
  }
  if (action === 'desktop-connection') return window.SummonDesktop?.openConnectionSettings();
  if (action === 'update-app') { await persistClientSession(); location.reload(); return; }
  if (action === 'display-settings') return openSettingsModal('general');
  if (action === 'copy-display-diagnostics') {
    await navigator.clipboard.writeText(JSON.stringify({ beforeSettings:displayDiagnosticSnapshot,current:captureDisplayDiagnostics() },null,2));
    return toast('显示诊断已复制');
  }
  if (action === 'display-preset') return changeDisplayPreference('zoom',Number(element.dataset.zoom));
  if (action === 'display-reset') { displayPreferences[displayMode()] = { ...displayDefaults[displayMode()] }; return changeDisplayPreference('zoom',displayDefaults[displayMode()].zoom); }
  if (action === 'toggle-search') { ui.searchOpen = !ui.searchOpen; if (!ui.searchOpen) ui.roomQuery = ''; renderTopbar(); $('#room-search')?.focus(); return; }
  if (action === 'open-account-login') {
    closeFloatingMenus();
    await closeModal($('#modal'), { suppressReturn: true });
    window.SummonHub?.openAuthOverlay?.({ mode: 'login', dismissible: window.SummonHub?.state?.mode === 'local' });
    return;
  }
  if (action === 'clear-owner-avatar') {
    saveLocalProfile({ avatar: '' });
    ui.lastSidebarHtml = null;
    refreshOpenSettingsBody();
    render();
    return toast('已恢复默认头像');
  }
  if (action === 'owner-click') {
    const identity = ownerIdentity();
    if (!identity.signedIn && !identity.localAccepted && window.SummonHub?.openAuthOverlay) {
      window.SummonHub.openAuthOverlay({ mode: 'login', dismissible: true });
      return;
    }
    ui.menu = ui.menu === 'apps' ? null : 'apps';
    return render();
  }
  if (['toggle-apps','toggle-chat-menu','toggle-mention-menu','toggle-draft-workspace'].includes(action)) {
    const menu = action === 'toggle-mention-menu' ? 'mentions' : action === 'toggle-draft-workspace' ? 'draft-workspace' : action.slice(7);
    ui.menu = ui.menu === menu ? null : menu; return render();
  }
  if (action === 'select-room') return selectRoom(id, element.dataset.nodeId || null);
  if (action === 'room-back') { ui.mobileRoom = false; ui.detailOpen = false; return render(); }
  if (action === 'new-room') return openNewGroupDraft();
  if (action === 'draft-suggestion') {
    const item = NEW_GROUP_SUGGESTIONS.find(s => s.id === id);
    if (!item) return;
    return submitDraftGroupMessage(item.prompt);
  }
  if (action === 'select-draft-workspace') {
    ui.draftWorkspaceId = id || '';
    ui.menu = null;
    return render();
  }
  if (action === 'clear-draft-workspace') {
    ui.draftWorkspaceId = '';
    return render();
  }
  if (action === 'edit-room') return openRoomEdit();
  if (action === 'stop-room') return stopCurrentRoom();
  if (action === 'delete-group') return deleteGroup();
  if (action === 'older-messages') return loadOlderMessages();
  if (action === 'toggle-details' || action === 'open-bot-details') {
    if (!ui.roomId && action === 'open-bot-details') { ui.botId = id; return navigate('members'); }
    ui.detailOpen = action === 'open-bot-details' || !ui.detailOpen;
    ui.profileBotId = action === 'open-bot-details' ? id : null;
    ui.detailTab = ui.profileBotId ? 'details' : 'members'; ui.avatarEditing = false; ui.roomFiles = [];
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
  if (action === 'open-secret-input') {
    return window.SummonSecretInput?.openStandalone?.({
      tab: element.dataset.secretTab || 'env',
    });
  }
  if (action === 'remove-reference') { ui.draftReferences[ui.roomId] = ui.draftReferences[ui.roomId].filter(item => !sameRef(item,ref)); return render(); }
  if (action === 'open-reference') return openReference(ref);
  if (action === 'reply-message') {
    const roomId = element.closest('.chat-layout')?.dataset.roomId;
    if (!roomId || roomId !== ui.roomId || !id || id.startsWith('local-')) return;
    const message = mergedRoomMessages(roomId,ui.messages).find(item => item.id === id && !item._delivery);
    ui.draftReplies[roomId] = message ?? { id,roomId,content:'原消息' };
    persistClientSession();
    render(); $('#message-input')?.focus(); return;
  }
  if (action === 'cancel-reply') { delete ui.draftReplies[ui.roomId]; persistClientSession(); return render(); }
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
  if (action === 'select-bot') { ui.botId = id; return render(); }
  if (action === 'toggle-bot') {
    const bot = botById(id);
    await api('/api/bots/' + encodeURIComponent(id),'PATCH',{ revision:bot.revision,enabled:!bot.enabled });
    return refresh();
  }
  if (action === 'archive-bot') return archiveBotConfirm(botById(id));
  if (action === 'restore-bot') {
    const bot = (state.archivedBots || []).find(item => item.id === id) || botById(id);
    if (!bot) return;
    await api('/api/bots/' + encodeURIComponent(id) + '/restore', 'POST', { revision: bot.revision });
    toast(`已恢复 ${bot.name}`);
    return refresh();
  }
  if (action === 'delete-bot') {
    const bot = botById(id) || (state.archivedBots || []).find(item => item.id === id);
    return deleteBotConfirm(bot);
  }
  if (action === 'retry-suspended') {
    const conversationId = element.dataset.conversation, runId = element.dataset.run;
    await api('/api/executions/retry', 'POST', { target: { kind: 'conversation', id: conversationId }, run_id: runId });
    toast('已重新排队重试');
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
  if (action === 'toggle-room-executions') {
    if (!ui.roomId) return;
    ui.openRoomExecution = ui.openRoomExecution === ui.roomId ? null : ui.roomId;
    if (ui.openRoomExecution) ui.roomDrawerMode = 'plan';
    return render();
  }
  if (action === 'close-room-executions') {
    ui.openRoomExecution = null;
    return render();
  }
  if (action === 'toggle-drawer-mode') {
    ui.roomDrawerMode = ui.roomDrawerMode === 'executions' ? 'plan' : 'executions';
    return render();
  }
  if (action === 'resume-room-goal') {
    if (!ui.roomId) return;
    await api(roomPath(ui.roomId) + '/goal', 'POST', { action: 'resume' });
    toast('已继续推进当前计划');
    return refresh();
  }
  if (action === 'clear-room-goal') {
    if (!ui.roomId) return;
    await api(roomPath(ui.roomId) + '/goal', 'POST', { action: 'clear' });
    ui.roomGoal = null;
    const room = roomById(ui.roomId);
    if (room) room.goal = null;
    ui.openRoomExecution = null;
    return refresh();
  }
  if (action === 'scroll-to-work') {
    const messages = $('.messages');
    if (messages?._summonChatScroll?.toBottom) messages._summonChatScroll.toBottom(true);
    else if (messages) messages.scrollTo({ top: messages.scrollHeight, behavior: 'smooth' });
    return;
  }
  if (action === 'new-execution') return openExecutionForm();
  if (action === 'stop-execution') return controlExecution();
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
  if (action === 'open-attachment') {
    const url = element?.dataset?.url || '';
    const view = element?.dataset?.view || '';
    const fileId = element?.dataset?.fileId || '';
    const name = element?.dataset?.name || 'file';
    if (window.SummonDesktop?.openAttachment && url) {
      try {
        await window.SummonDesktop.openAttachment({ url, name });
      } catch (error) {
        const message = String(error?.message || '').replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim();
        toast(message || '无法使用默认程序打开文件', true);
      }
      return;
    }
    if (fileId) return openReference({ kind: 'file', id: fileId });
    if (view) { window.open(view, '_blank', 'noopener,noreferrer'); return; }
    if (url) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
    return;
  }
  if (action === 'open-file-revision') {
    const targetRev = Number(element.dataset.revision);
    const latestRev = ui.fileDetail?.latest_revision ?? ui.fileDetail?.revision;
    ui.fileRevision = Number.isSafeInteger(targetRev) && targetRev > 0 && targetRev !== latestRev ? targetRev : null;
    await loadFile(id, null, ui.fileRevision);
    return render();
  }
  if (action === 'edit-file') return openFileEdit(element);
  if (action === 'more-file') { await loadFile(ui.fileId,ui.fileDetail.next_cursor,ui.fileDetail.revision); return render(); }
  if (action === 'add-wakeup' || action === 'edit-wakeup') return openWakeupEdit(wakeupById(id),element.dataset.room);
  if (action === 'toggle-wakeup') {
    const item = wakeupById(id);
    if (!item) return;
    await wakeupRequest(item,{ enabled:!item.enabled });
    await refresh();
    if ($('#modal')?.open && $('#modal')?.classList.contains('settings-modal') && ui.settingsTab === 'wakeups') void loadSettingsTabData('wakeups');
    return;
  }
  if (action === 'delete-wakeup') {
    const item = wakeupById(id);
    if (!item || !confirm('确认删除这条订阅/提醒规则？')) return;
    await api('/api/wakeups/' + encodeURIComponent(item.id), 'DELETE', { revision: item.revision });
    toast('订阅规则已删除');
    await refresh();
    if ($('#modal')?.open && $('#modal')?.classList.contains('settings-modal') && ui.settingsTab === 'wakeups') void loadSettingsTabData('wakeups');
    return;
  }
  if (action === 'prompt-select-all') {
    const msgId = element.dataset.msgId, qid = element.dataset.qid;
    if (!msgId || !qid) return;
    const msg = ui.messages.find(item => item.id === msgId);
    const q = msg?.prompt?.questions?.find(item => item.id === qid);
    if (!q?.options?.length) return;
    const draft = getPromptDraft(msgId);
    const qDraft = draft[qid] || { selected: [], custom: '' };
    const allIds = q.options.map(opt => opt.id);
    const allSelected = allIds.every(id => qDraft.selected.includes(id));
    qDraft.selected = allSelected ? [] : allIds;
    draft[qid] = qDraft;
    ui.activePromptMsgId = msgId;
    return render();
  }
  if (action === 'prompt-toggle') {
    const msgId = element.dataset.msgId, qid = element.dataset.qid, optId = element.dataset.optId, mode = element.dataset.mode;
    if (!msgId || !qid || !optId) return;
    const draft = getPromptDraft(msgId);
    const qDraft = draft[qid] || { selected: [], custom: '' };
    if (mode === 'multi') {
      const idx = qDraft.selected.indexOf(optId);
      if (idx >= 0) qDraft.selected.splice(idx, 1);
      else qDraft.selected.push(optId);
    } else {
      qDraft.selected = qDraft.selected[0] === optId ? [] : [optId];
      if (qDraft.selected.length) qDraft.custom = '';
    }
    draft[qid] = qDraft;
    ui.activePromptMsgId = msgId;
    return render();
  }
  if (action === 'prompt-secret-open') {
    return openSecretPromptModal(element.dataset.msgId);
  }
  if (action === 'prompt-submit') {
    return submitPromptCard(element.dataset.msgId);
  }
  if (action === 'prompt-skip') {
    return skipPromptCard(element.dataset.msgId);
  }
  if (action === 'exec-prompt-toggle-secret') {
    const key = element.dataset.execKey;
    if (!key) return;
    const next = !isExecPromptSecret(key, element.dataset.question || '');
    ui.execPromptMasked.set(key, next);
    return render();
  }
  if (action === 'exec-prompt-select') {
    const key = element.dataset.execKey, choiceId = element.dataset.choiceId;
    if (!key || !choiceId) return;
    ui.execPromptDrafts.set(key, choiceId);
    return render();
  }
  if (action === 'exec-prompt-submit') {
    return submitExecPromptCard(element.dataset.execKey);
  }
  if (action === 'exec-prompt-skip') {
    return skipExecPromptCard(element.dataset.execKey);
  }
  if (action === 'more-list') {
    const page = ui.listPages[kind], endpoint = element.dataset.endpoint, navigation = ui.navigationSeq;
    if (!page?.next_cursor) return;
    const next = await api(endpoint + '?cursor=' + encodeURIComponent(page.next_cursor));
    if (navigation === ui.navigationSeq && ui.listPages[kind]?.next_cursor === page.next_cursor) { setListPage(kind,next,true); render(); }
    return;
  }
  if (action === 'toggle-work-engine') return toggleWorkEngine(id, element.dataset.enabled === '1');
  if (action === 'check-work-engine') return checkWorkEngine(id);
  if (action === 'open-engine-files') return openEngineFilesModal(id);
  if (action === 'open-engine-file') return openEngineFileModal(element.dataset.engineId, element.dataset.path);
  if (action === 'open-bot-folder-file') return openBotFolderFileModal(element.dataset.botId, element.dataset.path);
  if (action === 'new-bot-folder-file') return openBotFolderFileModal(element.dataset.botId, null);
  if (action === 'edit-workspace') return editWorkspace(state.workspaces.find(item => item.id === id));
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
  if (modal.open && modal.classList.contains('settings-modal')) ui.returnToSettingsTab = ui.settingsTab;
  captureMotion($('#modal-content'));
  modal.classList.remove('create-bot-modal', 'settings-modal'); ui.menu = null; renderTopbar();
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
  for (const button of document.querySelectorAll('[data-action="owner-click"],[data-action="toggle-apps"],[data-action="toggle-chat-menu"],[data-action="toggle-mention-menu"],[data-action="toggle-draft-workspace"]')) button.setAttribute('aria-expanded', 'false');
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
  const entry = [...buildHomeEntries(state.rooms), ...buildHomeEntries(state.archivedRooms || [])].find(item => item.key === key);
  if (!entry) return;
  const avatarHtml = groupAvatar(entry.room, 28, `ctx:group:${entry.id}`);
  if (entry.archived) {
    openFloatingContextMenu(x, y, `
      <div class="floating-menu-preview">
        <div class="floating-menu-preview-head">${avatarHtml}<strong>${esc(entry.title)}</strong></div>
        <div class="floating-menu-preview-bubble">${esc(entry.fullPreview)}</div>
      </div>
      <button type="button" class="floating-menu-item" data-action="restore-room" data-id="${esc(entry.roomId)}">${icon('archiveRestore', 16)}<span>移出归档</span></button>
      <button type="button" class="floating-menu-item" data-action="home-details" data-room="${esc(entry.roomId)}">${icon('info', 16)}<span>群聊详情</span></button>
    `);
    return;
  }
  const pinned = isPinnedEntry(key);
  const currentFolder = folderIdForEntry(key);
  const folderOptions = `
    <button type="button" class="floating-menu-sub-item" data-action="home-move" data-key="${esc(key)}" data-folder="">
      ${icon('folder', 15)}<span>${entry.isSystem ? '系统' : '群聊'}</span>${currentFolder === null ? icon('check', 15) : ''}
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
    <button type="button" class="floating-menu-item" data-action="home-details" data-room="${esc(entry.roomId)}">${icon('info', 16)}<span>群聊详情</span></button>
    ${entry.room.archivable ? `<div class="floating-menu-sep"></div>
    <button type="button" class="floating-menu-item" data-action="archive-room" data-id="${esc(entry.roomId)}">${icon('archive', 16)}<span>归档到群助手</span></button>` : ''}
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
    if (window.SummonSecretInput?.isOpen?.()) return;
    closeFloatingMenus();
    const lb = $('#lightbox'); if (lb && !lb.hidden) { lb.hidden = true; lb.innerHTML = ''; }
    if (ui.view === 'overview' && !$('#modal')?.open && globalThis.SummonCanvasOverview?.closeInspectorIfOpen()) return;
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
  if (event.target.matches('.prompt-custom-input')) {
    const msgId = event.target.dataset.msgId, qid = event.target.dataset.qid, mode = event.target.dataset.mode;
    const draft = getPromptDraft(msgId);
    const qDraft = draft[qid] || { selected: [], custom: '' };
    qDraft.custom = event.target.value;
    if (mode === 'single' && qDraft.custom.trim()) {
      qDraft.selected = [];
      const card = event.target.closest('.prompt-card');
      for (const btn of $$('.prompt-option.selected', event.target.closest('.prompt-question') || card)) {
        btn.classList.remove('selected');
        btn.setAttribute('aria-pressed', 'false');
      }
    }
    draft[qid] = qDraft;
    ui.activePromptMsgId = msgId;
    syncPromptSubmitButton(msgId, event.target.closest('.prompt-card'));
  }
  if (event.target.matches('.exec-prompt-input')) {
    const key = event.target.dataset.execKey;
    ui.execPromptDrafts.set(key, event.target.value);
    const card = event.target.closest('.exec-pending-card');
    const submitBtn = card?.querySelector('[data-action="exec-prompt-submit"]');
    if (submitBtn) submitBtn.disabled = !ui.protocolReady || ui.execPromptBusy.has(key) || !event.target.value.trim();
  }
  const form = event.target.closest('.execution-input-form');
  if (form && ['input','structured'].includes(event.target.name)) {
    const entry = ui.executionInputs.get(form.dataset.input) || {};
    if (event.target.name === 'structured') entry.structured = event.target.checked;
    else entry.text = event.target.value;
    ui.executionInputs.set(form.dataset.input, entry);
    persistClientSession();
  }
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  if (window.SummonSecretInput?.isOpen?.()) return;
  const target = event.target;
  if (target.id === 'message-input') {
    event.preventDefault();
    const button = $('#message-form button[type=submit]');
    if (!button?.disabled) $('#message-form')?.requestSubmit();
    return;
  }
  if (target.matches?.('.exec-prompt-input')) {
    event.preventDefault();
    void submitExecPromptCard(target.dataset.execKey).catch(error => toast(error.message, true));
    return;
  }
  if (target.matches?.('.prompt-custom-input')) {
    event.preventDefault();
    void submitPromptCard(target.dataset.msgId).catch(error => toast(error.message, true));
    return;
  }
  const execCard = target.closest?.('.exec-pending-card');
  if (execCard && !target.matches?.('[data-action="exec-prompt-skip"]')) {
    const key = execCard.dataset.execKey;
    if (key && String(ui.execPromptDrafts.get(key) ?? '').trim()) {
      event.preventDefault();
      void submitExecPromptCard(key).catch(error => toast(error.message, true));
      return;
    }
  }
  const promptCard = target.closest?.('.prompt-card[data-prompt-msg]:not(.is-answered)');
  if (promptCard && !target.matches?.('[data-action="prompt-skip"]')) {
    const msgId = promptCard.dataset.promptMsg;
    const msg = mergedRoomMessages(ui.roomId, ui.messages).find(item => item.id === msgId);
    if (msg?.prompt && isPromptReady(msg.prompt, ui.promptDrafts.get(msgId))) {
      event.preventDefault();
      void submitPromptCard(msgId).catch(error => toast(error.message, true));
      return;
    }
  }
  if (ui.activePromptMsgId && ui.view === 'chat' && !$('#modal')?.open &&
      (!target || target === document.body || target.matches?.('.messages, .message-bubble'))) {
    const msgId = ui.activePromptMsgId;
    const timeline = mergedRoomMessages(ui.roomId, ui.messages);
    const msg = timeline.find(item => item.id === msgId);
    if (msg?.prompt && !findPromptAnswer(msg, timeline) && isPromptReady(msg.prompt, ui.promptDrafts.get(msgId))) {
      event.preventDefault();
      void submitPromptCard(msgId).catch(error => toast(error.message, true));
    }
  }
});
document.addEventListener('compositionstart', event => { if (event.target.id === 'message-input' || event.target.matches?.('.prompt-custom-input, .exec-prompt-input')) ui.composing = true; });
document.addEventListener('compositionend', event => {
  if (event.target.id === 'message-input') { ui.composing = false; ui.drafts[event.target.form.dataset.roomId] = event.target.value; persistClientSession(); if (ui.renderDeferred) render(); return; }
  if (event.target.matches?.('.prompt-custom-input, .exec-prompt-input')) { ui.composing = false; if (ui.renderDeferred) render(); }
});
document.addEventListener('paste', event => {
  if (!ui.roomId || ui.creatingRoom || ui.view !== 'chat') return;
  const target = event.target;
  if (target && !target.closest?.('.conversation') && target.id !== 'message-input') return;
  const files = [...(event.clipboardData?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  void addAttachments(ui.roomId, files);
});
document.addEventListener('dragover', event => {
  if (!ui.roomId || ui.creatingRoom || ui.view !== 'chat') return;
  if (event.dataTransfer?.types?.includes('Files') && event.target?.closest?.('.conversation')) {
    event.preventDefault();
  }
});
document.addEventListener('drop', event => {
  if (!ui.roomId || ui.creatingRoom || ui.view !== 'chat') return;
  if (!event.target?.closest?.('.conversation')) return;
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  event.preventDefault();
  void addAttachments(ui.roomId, files);
});
window.SummonDesktop?.onNativeFileDrop?.(async payload => {
  if (!ui.roomId || ui.creatingRoom || ui.view !== 'chat') return;
  const items = Array.isArray(payload?.files) ? payload.files : [];
  if (!items.length) return;
  const target = typeof payload?.x === 'number' && typeof payload?.y === 'number'
    ? document.elementFromPoint(payload.x, payload.y)
    : null;
  if (target && !target.closest?.('.conversation') && document.querySelector('.conversation')) return;
  if (!Array.isArray(state.workspaces) || !state.workspaces.length) {
    try { state.workspaces = await readList('/api/workspaces'); } catch {}
  }
  const filesToUpload = [];
  let linkedAny = false;
  for (const meta of items) {
    const wsRef = meta?.path ? matchAuthorizedWorkspaceFile(meta.path) : null;
    if (wsRef) {
      addDraftReference(ui.roomId, wsRef);
      toast(`已关联工作区活文件：${wsRef.path}`);
      linkedAny = true;
      continue;
    }
    if (Number(meta?.size) > attachmentMaxBytes) {
      toast(`${meta?.name || '文件'} 超过 20 MB，请选择小一些的文件。`, true);
      continue;
    }
    try {
      const bytes = await window.SummonDesktop.readDroppedFile(meta.dropId);
      const file = new File([new Uint8Array(bytes)], meta.name || 'file', { type: meta.mime || 'application/octet-stream' });
      window.SummonDesktop.registerFilePath?.(file, meta.path || '');
      filesToUpload.push(file);
    } catch (error) {
      toast(error?.message || `读取 ${meta?.name || '文件'} 失败`, true);
    }
  }
  if (linkedAny && !filesToUpload.length) {
    render();
    void persistClientSession();
  }
  if (filesToUpload.length) {
    void addAttachments(ui.roomId, filesToUpload);
  }
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (form.id === 'local-profile-form') {
    event.preventDefault();
    const name = String(form.elements.name?.value || '').trim().slice(0, 32);
    saveLocalProfile({ name, localAccepted: true });
    ui.lastSidebarHtml = null;
    refreshOpenSettingsBody();
    render();
    toast(name ? '本地昵称已保存' : '已恢复默认名称');
    return;
  }
  if (form.id !== 'message-form' && !form.matches('.execution-input-form')) return;
  event.preventDefault();
  const action = form.id === 'message-form' ? submitRoomMessage(form) : submitExecutionInput(form);
  void action.catch(error => toast(error.message,true));
});

async function submitRoomMessage(form) {
  if (form.dataset.roomId === DRAFT_ROOM_ID) {
    return submitDraftGroupMessage(form.elements.content.value);
  }
  const room = roomById(form.dataset.roomId);
  if (!room || sendBusy(room.id)) return;
  const text = form.elements.content.value, attachments = attachmentDrafts(room.id), references = ui.draftReferences[room.id] || [];
  if (!text.trim() && !attachments.length && !references.length) return;
  const payload = { text, mentions:selectedMentions(room), references, attachments:attachments.map(item => ({ kind:'file',id:item.attachment.id })),
    ...(ui.draftReplies[room.id] ? { reply_to:messageRef(ui.draftReplies[room.id].id) } : {}) };
  const entry = queueLocalMessage(room.id,payload,attachments);
  for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
  ui.drafts[room.id] = ''; ui.draftTargets[room.id] = []; ui.draftAttachments[room.id] = []; ui.draftReferences[room.id] = [];
  delete ui.draftReplies[room.id];
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
      ...(option.request_id ? { request_id: option.request_id } : {}), input },{ clientId:entry.clientId });
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
const localProfileKey = 'summon:local-profile:v1';
function readLocalProfile() {
  try {
    const raw = JSON.parse(localStorage.getItem(localProfileKey) || '{}');
    return {
      name: typeof raw.name === 'string' ? raw.name.trim().slice(0, 32) : '',
      avatar: typeof raw.avatar === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(raw.avatar) ? raw.avatar : '',
      localAccepted: Boolean(raw.localAccepted),
    };
  } catch {
    return { name: '', avatar: '', localAccepted: false };
  }
}
function saveLocalProfile(patch) {
  const next = { ...readLocalProfile(), ...patch };
  try { localStorage.setItem(localProfileKey, JSON.stringify(next)); } catch {}
  return next;
}
function ownerIdentity() {
  const hubState = window.SummonHub?.state;
  const signedIn = Boolean(hubState?.authenticated && hubState?.user);
  const hubUser = signedIn ? hubState.user : null;
  const profile = readLocalProfile();
  const cloudName = String(hubUser?.displayName || hubUser?.username || '').trim();
  const name = profile.name || cloudName || state.user?.name || state.owner?.name || (signedIn ? '用户' : '本地账户');
  const sidebarLabel = signedIn ? (profile.name || cloudName || '用户') : (profile.name || (profile.localAccepted ? '本地账户' : '登录'));
  return {
    signedIn,
    username: hubUser?.username || '',
    name,
    sidebarLabel,
    customAvatar: profile.avatar,
    localAccepted: profile.localAccepted,
  };
}
function renderUserAvatar(size) {
  const identity = ownerIdentity();
  if (identity.customAvatar) {
    return `<img class="user-avatar" src="${esc(identity.customAvatar)}" width="${size}" height="${size}" style="width:${size}px;height:${size}px" alt="" aria-hidden="true">`;
  }
  if (identity.signedIn) {
    const ch = [...(identity.name || identity.username || 'U')][0]?.toUpperCase() || 'U';
    const fontSize = Math.max(11, Math.round(size * 0.44));
    return `<span class="user-avatar is-initial" style="width:${size}px;height:${size}px;font-size:${fontSize}px" aria-hidden="true">${esc(ch)}</span>`;
  }
  const iconSize = Math.max(14, Math.round(size * 0.56));
  return `<span class="user-avatar is-guest" style="width:${size}px;height:${size}px" aria-hidden="true"><svg viewBox="0 0 24 24" width="${iconSize}" height="${iconSize}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.2" r="3.6"/><path d="M5.2 19.2c.9-3.2 3.5-5 6.8-5s5.9 1.8 6.8 5"/></svg></span>`;
}
function avatar(id, large = false, key = '') {
  const size = typeof large === 'number' ? large : large ? 104 : 60;
  if (id === 'user') return renderUserAvatar(size);
  if (!botById(id)) return `<span class="system-avatar" style="width:${size}px;height:${size}px">${icon(String(id).startsWith('executor:') ? 'computer' : 'event', Math.round(size * .5))}</span>`;
  const motion = key ? (botActivity(botById(id)).motion || 'idle') : 'idle';
  return `<span class="bot-avatar" style="width:${size}px;height:${size}px" aria-hidden="true">${face(botAvatar(id), size, { key, static: !key, identity: `bot:${id}`, state: motion })}</span>`;
}
function groupAvatar(room, size = 96, _key = '') {
  const bots = (room?.members || []).filter(id => botById(id));
  const members = (bots.length ? bots : (room?.members || []).filter(id => id === 'user')).slice(0, 4);
  if (!members.length) return `<span class="group-avatar group-avatar-empty" style="width:${size}px;height:${size}px">${icon('chat', Math.round(size * .6))}</span>`;
  return `<span class="group-avatar" data-count="${members.length}" style="width:${size}px;height:${size}px">${members.map((id, index) => `<span class="group-face pos-${index}">${avatar(id, members.length === 1 ? size : Math.round(size * .64), '')}</span>`).join('')}</span>`;
}
function currentBot() {
  const room = roomById(ui.roomId);
  return directRoom(room) ? botById(room.members.find(id => id !== 'user')) : null;
}
function profileBot() { return ui.profileBotId ? botById(ui.profileBotId) : currentBot(); }
function currentAccent() { const bot = currentBot() || (roomById(ui.roomId)?.members || []).map(id => botById(id)).find(Boolean); return bot ? botAvatar(bot).color : '#222222'; }
function ownerName() { return ownerIdentity().name; }
function directRoom(room) { return room?.mode ? room.mode === 'direct' : room?.members?.length === 2 && room.members.includes('user'); }
function botActivity(bot) {
  if (!bot) return { kind:'idle', text:'在线', motion:'idle' };
  if (bot.enabled === false || bot.activity === 'paused') return { kind:'paused', text:'已暂停', motion:'sleep' };
  const execution = [...state.executions, ...(ui.roomExecutions || [])].find(item =>
    (item.bot_id === bot.id || item.execution_actor?.id === bot.id) && ['running', 'submitted', 'waiting', 'queued', 'needs_input', 'awaiting_input'].includes(item.status));
  if (execution || bot.activity === 'working') {
    const needsInput = execution && ['needs_input', 'awaiting_input'].includes(execution.status);
    return { kind:'running', text: needsInput ? '等待输入' : '工作中', motion:'work' };
  }
  if (bot.activity === 'error') return { kind:'error', text:'运行异常', motion:'failed' };
  return { kind:'idle', text:'在线', motion:'idle' };
}
function messagePreview(message) {
  return message?.content?.replace(/\s+/g, ' ').trim()
    || message?.prompt?.title
    || message?.prompt?.questions?.[0]?.label
    || message?.attachments?.map(file => file.name).join('、')
    || (message?.references?.length ? '共享了引用' : '消息');
}
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
  if (ui.view !== 'chat' || ui.creatingRoom || document.hidden || displayMedia.matches && !ui.mobileRoom || ui.messagesRoomId !== ui.roomId) return;
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
function conversationUpdatedAt(room) { return room?.lastMessage?.createdAt || room?.updatedAt || room?.createdAt || ''; }
function recentConversations(a, b) { return String(conversationUpdatedAt(b)).localeCompare(String(conversationUpdatedAt(a))); }
function renderContactTime(room) {
  const time = room?.lastMessage?.createdAt;
  return time ? `<time class="contact-time" datetime="${esc(time)}" title="${esc(formatTime(time, true))}">${esc(contactTime(time))}</time>` : '';
}
const homeOrgStorageKey = 'summon:homeOrg:v1';
const DEFAULT_FOLDER_ID = '__default__';
function loadHomeOrg() {
  try {
    const raw = JSON.parse(localStorage.getItem(homeOrgStorageKey) || '{}');
    return {
      pinnedKeys: Array.isArray(raw.pinnedKeys) ? raw.pinnedKeys : [],
      folders: Array.isArray(raw.folders) ? raw.folders.filter(f => f && typeof f.id === 'string' && typeof f.name === 'string') : [],
      collapsedIds: Array.isArray(raw.collapsedIds) ? raw.collapsedIds.filter(id => id !== DEFAULT_FOLDER_ID) : [],
    };
  } catch {
    return { pinnedKeys: [], folders: [], collapsedIds: [] };
  }
}
let homeOrg = loadHomeOrg();
function saveHomeOrg() {
  try {
    localStorage.setItem(homeOrgStorageKey, JSON.stringify({
      ...homeOrg,
      collapsedIds: homeOrg.collapsedIds.filter(id => id !== DEFAULT_FOLDER_ID),
    }));
  } catch {}
}
const isPinnedEntry = key => homeOrg.pinnedKeys.includes(key);
const isFolderCollapsed = id => homeOrg.collapsedIds.includes(id);
const folderIdForEntry = key => homeOrg.folders.find(f => Array.isArray(f.keys) && f.keys.includes(key))?.id || null;
function togglePinEntry(key) {
  if (isPinnedEntry(key)) homeOrg.pinnedKeys = homeOrg.pinnedKeys.filter(k => k !== key);
  else homeOrg.pinnedKeys = [...homeOrg.pinnedKeys, key];
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
function roomExclusiveLiveBot(room) {
  const members = (room?.members || []).filter(id => id !== 'user');
  const candidates = [];
  if (room?.lead_bot_id) {
    const lead = botById(room.lead_bot_id);
    if (lead) candidates.push(lead);
  }
  for (const id of members) {
    if (id === room?.lead_bot_id) continue;
    const bot = botById(id);
    if (!bot || isBuiltinGroupBot(bot)) continue;
    const roomCount = state.rooms.filter(r => !directRoom(r) && r.members.includes(id)).length;
    if (roomCount <= 1) candidates.push(bot);
  }
  for (const bot of candidates) {
    const act = botActivity(bot);
    if (['running', 'waiting'].includes(act.kind)) return { bot, activity: act };
  }
  return null;
}

function buildHomeEntries(sourceRooms = state.rooms) {
  const hub = window.SummonHub;
  const activeNodeId = hub?.state?.activeNodeId || '';
  const live = ui.streamConnected && !ui.connectionNotice;
  const entries = [];
  for (const room of sourceRooms || []) {
    if (directRoom(room)) continue;
    const nodeId = room._nodeId || activeNodeId;
    const nodeName = room._nodeName || (nodeId ? hub?.nodeLabel?.(nodeId) : '');
    const sameNode = !nodeId || nodeId === activeNodeId;
    const archived = isArchivedRoom(room);
    const last = room.lastMessage;
    const active = !archived && live && sameNode ? roomExclusiveLiveBot(room) : null;
    const running = Boolean(active);
    const preview = active
      ? `${active.bot.name} · ${active.activity.text}`
      : last ? roomPreview(room) : (archived ? '已归档' : '开始聊天');
    const fullPreview = last?.content?.trim() || preview;
    entries.push({
      key: nodeId && hub?.onlineNodes?.().length > 1 ? `room:${nodeId}:${room.id}` : `room:${room.id}`,
      kind: 'room',
      id: room.id,
      nodeId,
      nodeName,
      room,
      roomId: room.id,
      botId: null,
      archived,
      isSystem: room.id === BOT_MAINTENANCE_ROOM_ID,
      title: room.name,
      preview,
      fullPreview,
      sortDate: archived ? (room.archived_at || conversationUpdatedAt(room)) : conversationUpdatedAt(room),
      running,
      paused: false,
      live,
      selected: sameNode && room.id === ui.roomId && ui.view === 'chat' && !ui.creatingRoom,
    });
  }
  return entries.sort((a, b) => String(b.sortDate).localeCompare(String(a.sortDate)) || a.title.localeCompare(b.title, 'zh-Hans-CN'));
}
function renderHomePinnedTile(entry) {
  const avatarHtml = groupAvatar(entry.room, 60, `pinned:group:${entry.nodeId || ''}:${entry.id}`);
  const badge = entry.room ? unreadRoomBadge(entry.room) : '';
  return `<button type="button" class="pinned-tile ${entry.selected ? 'selected' : ''}" data-action="select-room" data-id="${esc(entry.id)}" data-node-id="${esc(entry.nodeId || '')}" data-home-key="${esc(entry.key)}" title="${esc(entry.title)}${entry.nodeName ? ' · ' + esc(entry.nodeName) : ''}">
    <span class="pinned-tile-avatar">${avatarHtml}${badge}</span>
    <span class="pinned-tile-title">${esc(entry.title)}</span>
  </button>`;
}
function renderHomeEntryRow(entry, { showArchivedBadge = false } = {}) {
  const showNodeTag = Boolean(entry.nodeName && window.SummonHub?.onlineNodes?.().length > 1);
  return `<button class="contact-row ${entry.selected ? 'selected' : ''} ${entry.archived ? 'is-archived' : ''}" data-action="select-room" data-id="${esc(entry.id)}" data-node-id="${esc(entry.nodeId || '')}" data-home-key="${esc(entry.key)}" ${entry.selected ? 'aria-current="page"' : ''} title="${esc(entry.title)}${entry.nodeName ? ' · ' + esc(entry.nodeName) : ''}">
    <span class="contact-avatar-wrap">${groupAvatar(entry.room, 44, `sidebar:group:${entry.nodeId || ''}:${entry.id}`)}${entry.running ? '<i class="presence-dot running" aria-hidden="true"></i>' : ''}</span>
    <span class="contact-copy"><span class="contact-heading"><strong>${esc(entry.title)}</strong>${showNodeTag ? `<span class="contact-node-tag">${esc(entry.nodeName)}</span>` : ''}${showArchivedBadge ? '<span class="contact-archive-tag">已归档</span>' : renderContactTime(entry.room)}</span><span class="contact-preview ${entry.running ? 'is-working' : ''}">${esc(entry.preview)}</span></span>
    ${entry.archived ? '' : unreadRoomBadge(entry.room)}
  </button>`;
}
function renderTopbar() {
  const sidebar = $('#contact-sidebar'), oldTop = $('.contacts-scroll')?.scrollTop || 0;
  const query = ui.roomQuery.trim().toLowerCase();
  const hub = window.SummonHub;
  const useMixed = Boolean(hub?.state?.initialized && hub.onlineNodes().length);
  const sourceVisible = useMixed ? hub.mixedRooms(state.rooms) : state.rooms;
  const sourceArchived = useMixed ? hub.mixedRooms(state.archivedRooms || [], { includeArchived: true, activeArchived: state.archivedRooms || [] }) : (state.archivedRooms || []);
  const visibleEntries = buildHomeEntries(sourceVisible);
  const archivedEntries = buildHomeEntries(sourceArchived);
  const allSearchEntries = [...visibleEntries, ...archivedEntries];
  const filteredEntries = query
    ? allSearchEntries.filter(entry => entry.title.toLowerCase().includes(query) || entry.preview.toLowerCase().includes(query))
    : visibleEntries;
  const byKey = new Map(visibleEntries.map(entry => [entry.key, entry]));
  const pinnedEntries = query ? [] : homeOrg.pinnedKeys.map(key => byKey.get(key)).filter(Boolean);
  const pinnedSet = new Set(homeOrg.pinnedKeys);
  const unpinnedEntries = query ? filteredEntries : filteredEntries.filter(entry => !pinnedSet.has(entry.key));
  const assignedKeys = new Set(homeOrg.folders.flatMap(f => f.keys || []));
  const defaultEntries = unpinnedEntries.filter(entry => !assignedKeys.has(entry.key) && !entry.isSystem);
  const systemEntries = unpinnedEntries.filter(entry => !assignedKeys.has(entry.key) && entry.isSystem);
  let contactsHtml = '';
  if (query) {
    contactsHtml += `<section class="sidebar-section"><div class="bot-contacts">${filteredEntries.map(entry => renderHomeEntryRow(entry, { showArchivedBadge: entry.archived })).join('') || '<p class="sidebar-empty">没有匹配的群聊</p>'}</div></section>`;
  } else if (ui.archiveDrawerOpen && archivedEntries.length) {
    contactsHtml += `<section class="sidebar-section archive-assistant-panel">
      <div class="archive-assistant-header">
        <button type="button" class="archive-assistant-back" data-action="close-archive-assistant" aria-label="返回群聊列表">${icon('chevronBack', 16)}<span>返回</span></button>
        <strong>归档群助手</strong>
        <span class="archive-assistant-count">${archivedEntries.length}</span>
      </div>
      <div class="bot-contacts">${archivedEntries.map(entry => renderHomeEntryRow(entry)).join('')}</div>
    </section>`;
  } else {
    if (pinnedEntries.length) {
      contactsHtml += `<section class="sidebar-section pinned-section"><div class="pinned-shelf">${pinnedEntries.map(renderHomePinnedTile).join('')}</div></section>`;
    }
    if (defaultEntries.length || archivedEntries.length || !homeOrg.folders.length) {
      const collapsed = isFolderCollapsed(DEFAULT_FOLDER_ID);
      const archiveAssistantHtml = archivedEntries.length ? (() => {
        const previewNames = archivedEntries.slice(0, 3).map(e => e.title).join('、')
          + (archivedEntries.length > 3 ? ` 等 ${archivedEntries.length} 个群` : '');
        const hasSelectedArchived = archivedEntries.some(e => e.selected);
        return `<button type="button" class="contact-row archive-assistant-row ${hasSelectedArchived ? 'selected' : ''}" data-action="open-archive-assistant" title="归档群助手（${archivedEntries.length} 个已归档群聊）">
          <span class="contact-avatar-wrap"><span class="archive-assistant-avatar" aria-hidden="true">${icon('archive', 20)}</span></span>
          <span class="contact-copy"><span class="contact-heading"><strong>归档群助手</strong><span class="archive-assistant-count">${archivedEntries.length}</span></span><span class="contact-preview">${esc(previewNames)}</span></span>
        </button>`;
      })() : '';
      const defaultBodyHtml = defaultEntries.map(renderHomeEntryRow).join('') + archiveAssistantHtml;
      contactsHtml += `<section class="sidebar-section folder-section ${collapsed ? 'is-collapsed' : ''}"><button type="button" class="folder-header ${collapsed ? 'collapsed' : ''}" data-action="toggle-folder" data-id="${DEFAULT_FOLDER_ID}"><span class="folder-header-label"><span>群聊</span>${icon('chevronDown', 13)}</span><span class="folder-count">${defaultEntries.length + archivedEntries.length}</span></button>
        <div class="bot-contacts">${defaultBodyHtml || '<p class="sidebar-empty">点右上角 + 开始建一个新群</p>'}</div></section>`;
    }
    for (const folder of homeOrg.folders) {
      const folderKeys = new Set(folder.keys || []);
      const folderEntries = unpinnedEntries.filter(entry => folderKeys.has(entry.key));
      const collapsed = isFolderCollapsed(folder.id);
      contactsHtml += `<section class="sidebar-section folder-section ${collapsed ? 'is-collapsed' : ''}"><button type="button" class="folder-header ${collapsed ? 'collapsed' : ''}" data-action="toggle-folder" data-id="${esc(folder.id)}" data-folder-id="${esc(folder.id)}"><span class="folder-header-label"><span>${esc(folder.name)}</span>${icon('chevronDown', 13)}</span><span class="folder-count">${folderEntries.length}</span></button>
        <div class="bot-contacts">${folderEntries.map(renderHomeEntryRow).join('') || '<p class="sidebar-empty">右键任意群聊可移入此分组</p>'}</div></section>`;
    }
    if (systemEntries.length) {
      const collapsed = isFolderCollapsed('__system__');
      contactsHtml += `<section class="sidebar-section folder-section system-folder-section ${collapsed ? 'is-collapsed' : ''}"><button type="button" class="folder-header ${collapsed ? 'collapsed' : ''}" data-action="toggle-folder" data-id="__system__"><span class="folder-header-label"><span>系统</span>${icon('chevronDown', 13)}</span><span class="folder-count">${systemEntries.length}</span></button>
        <div class="bot-contacts">${systemEntries.map(renderHomeEntryRow).join('')}</div></section>`;
    }
  }
  const identity = ownerIdentity();
  const desktopUpdate = ui.desktopUpdate || window.SummonClients?.getDesktopUpdate?.() || null;
  const updateReady = Boolean(window.SummonDesktop && ['downloaded', 'manual'].includes(desktopUpdate?.status));
  const updateDownloading = Boolean(window.SummonDesktop && desktopUpdate?.status === 'downloading');
  const updateMenuItem = updateReady
    ? `<button class="apps-menu-update" data-action="install-desktop-update">${icon('install', 17)}<span>安装更新${desktopUpdate?.version ? ` v${esc(desktopUpdate.version)}` : ''}</span></button><div class="apps-menu-divider"></div>`
    : updateDownloading
      ? `<div class="apps-menu-update-progress">${icon('install', 15)}<span>正在下载更新 ${Number(desktopUpdate?.percent) || 0}%</span></div><div class="apps-menu-divider"></div>`
      : '';
  const settings = ui.menu === 'apps' ? `<div class="context-menu apps-menu">
    ${updateMenuItem}
    ${identity.signedIn
      ? `<div class="apps-menu-account"><strong>${esc(identity.name)}</strong><small>@${esc(identity.username || '')} · 云端账号</small></div>`
      : `<button class="apps-menu-login" data-action="open-account-login">${icon('link', 17)}<span>登录云端账号</span></button>`}
    <div class="apps-menu-divider"></div>
    <button data-action="open-panel">${icon('layers', 18)}<span>面板</span></button>
    <button data-action="open-settings">${icon('settings', 18)}<span>设置</span></button>
    ${identity.signedIn ? `<div class="apps-menu-divider"></div><button data-hub-action="logout">${icon('close', 16)}<span>退出账号</span></button>` : ''}
  </div>` : '';
  const connected = ui.streamConnected && ui.protocolReady;
  const creatingActive = ui.view === 'chat' && ui.creatingRoom;
  const nodeStrip = hub?.renderNodeFilterBar?.() || '';
  const html = `<div class="sidebar-toolbar"><summon-wordmark></summon-wordmark>
      <div class="search-slot ${ui.searchOpen ? 'open' : ''}">${ui.searchOpen ? `<input id="room-search" value="${esc(ui.roomQuery)}" placeholder="搜索群聊" aria-label="搜索群聊">` : ''}
        <button class="round-button" data-action="toggle-search" title="搜索群聊" aria-label="搜索群聊">${icon('search', 20)}</button></div>
      <button class="round-button create-button ${creatingActive ? 'selected' : ''}" data-action="new-room" title="新建群聊" aria-label="新建群聊" aria-pressed="${creatingActive}">${icon('plus', 23)}</button></div>
    ${nodeStrip}
    <div class="contacts-scroll">${contactsHtml}</div>
    <div class="sidebar-controls">
      <div class="rail-quick-actions">
        <button type="button" class="rail-action-btn ${creatingActive ? 'selected' : ''}" data-action="new-room" title="新建群聊" aria-label="新建群聊" aria-pressed="${creatingActive}">${icon('plus', 20)}</button>
        <button type="button" class="rail-action-btn ${ui.view !== 'chat' ? 'selected' : ''}" data-action="open-panel" title="面板" aria-label="面板">${icon('layers', 18)}</button>
        <button type="button" class="rail-action-btn" data-action="open-settings" title="设置" aria-label="设置">${icon('settings', 18)}</button>
      </div>
    <div class="sidebar-footer"><div class="menu-anchor sidebar-owner-anchor">
      <button class="sidebar-owner ${identity.signedIn ? '' : 'is-guest'} ${updateReady ? 'has-update' : ''}" data-action="owner-click" title="${updateReady ? `有新版本 v${esc(desktopUpdate?.version || '')} 可安装` : (identity.signedIn ? esc(identity.name) : '点击登录云端账号或管理设置')}" aria-label="${updateReady ? '有新版本可安装' : (identity.signedIn ? esc(identity.name) : '登录或设置')}" aria-expanded="${ui.menu === 'apps'}">
      <span class="sidebar-owner-visual"><span class="contact-avatar-wrap"><img class="sidebar-owner-frame" src="/icons/owner-paper-frame.png" width="100" height="100" alt="">
        ${avatar('user', 48)}<i class="presence-dot ${connected ? (identity.signedIn ? 'idle' : 'local') : 'unknown'}" aria-hidden="true"></i>${updateReady ? '<i class="update-ready-dot" aria-hidden="true"></i>' : ''}</span></span>
      <span class="sidebar-owner-name">${esc(identity.sidebarLabel)}</span></button>${settings}</div>
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

function safeHref(raw) {
  const value = String(raw || '').trim();
  if (/^https?:\/\/[^\s<>"']+$/i.test(value)) return value;
  if (/^\/(?!\/)[^\s<>"']*$/.test(value)) return value;
  return '';
}
function linkifyPlain(text) {
  const pattern = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2048})\)|(https?:\/\/[^\s<>"'()]+|\/(?:api\/(?:files|attachments|workspaces|games|releases)\/[^\s<>"'()]+|view(?:[/?#][^\s<>"'()]*)?))/g;
  let out = '', last = 0, m;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out += esc(text.slice(last, m.index));
    const label = m[1] || m[3];
    let rawUrl = m[2] || m[3];
    let trailing = '';
    if (!m[1]) {
      const punct = rawUrl.match(/[.,;:!?。，；：！？）】》]+$/);
      if (punct) { trailing = punct[0]; rawUrl = rawUrl.slice(0, -trailing.length); }
    }
    const href = safeHref(rawUrl);
    if (href) {
      out += `<a class="message-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(m[1] ? label : rawUrl)}</a>${esc(trailing)}`;
    } else {
      out += esc(m[0]);
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) out += esc(text.slice(last));
  return out;
}
function richText(value) {
  const regex = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let result = '', last = 0, match;
  const formatInline = text => text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((segment, index) => {
    if (index % 2 && segment.startsWith('`')) return `<code>${esc(segment.slice(1, -1))}</code>`;
    if (index % 2) return `<strong>${linkifyPlain(segment.slice(2, -2))}</strong>`;
    return linkifyPlain(segment);
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
  return `<button type="button" class="bot-mention" data-action="open-bot-details" data-id="${esc(id)}" style="--member-color:${esc(botAvatar(bot).color)}">@${esc(label || bot.name)}</button>`;
}
const refType = { room:'会话', event:'消息', file:'文件', workspace_file:'工作区活文件', bot:'Bot', session:'执行会话', conversation:'内部对话', call:'调用', wakeup:'订阅' };
const roomRef = id => ({ kind:'room', id });
const messageRef = id => ({ kind:'event', id });

function refLabel(ref) {
  if (ref.kind === 'workspace_file') {
    const ws = (state.workspaces || []).find(item => item.id === ref.workspace_id);
    const name = String(ref.path || '').split('/').pop() || ref.path;
    return ws ? `${ws.name}/${ref.path}` : name;
  }
  if (ref.kind === 'event') return ui.messages.find(item => item.id === ref.id) ? messagePreview(ui.messages.find(item => item.id === ref.id)) : '消息 ' + ref.id;
  if (ref.kind === 'file') return [...state.files, ...(ui.roomFiles || [])].find(item => item.id === ref.id)?.name || '文件 ' + ref.id;
  if (ref.kind === 'room') return roomById(ref.id)?.name || ref.id;
  if (ref.kind === 'bot') return nameOf(ref.id);
  return (refType[ref.kind] || ref.kind) + ' ' + ref.id;
}

function renderReference(ref, action = 'open-reference') {
  if (ref?.access === 'redacted') {
    return `<span class="reference-chip" style="opacity:.65;cursor:default" title="该来源位于私有或异群空间，当前受限">${icon('link', 14)}<span>受限来源 (${esc(String(ref.id || '').slice(0, 8))})</span></span>`;
  }
  if (ref?.kind === 'workspace_file') {
    return `<button type="button" class="reference-chip" data-action="${action}" data-kind="workspace_file" data-workspace-id="${esc(ref.workspace_id)}" data-path="${esc(ref.path)}">${icon('file', 14)}<span>${esc(refLabel(ref))}</span></button>`;
  }
  return `<button type="button" class="reference-chip" data-action="${action}" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">${icon(ref.kind === 'file' ? 'file' : 'link', 14)}<span>${esc(refLabel(ref))}</span></button>`;
}

function formatMemoryScope(appliesTo = []) {
  if (!Array.isArray(appliesTo) || !appliesTo.length) return '默认范围';
  return appliesTo.map(scope => {
    if (scope.kind === 'bot') return '全群通用（个人偏好）';
    if (scope.kind === 'room') return `仅限本群（${roomById(scope.id)?.name || scope.id.slice(0, 8)}）`;
    return `${refType[scope.kind] || scope.kind} ${scope.id.slice(0, 8)}`;
  }).join(' · ');
}

function renderBotMemorySection(bot) {
  const items = bot?.memory_items || [];
  if (!items.length) return '';
  const rows = items.map(item => `<div class="wakeup-row" style="flex-direction:column;align-items:flex-start;gap:4px">
    <div style="display:flex;justify-content:space-between;width:100%;gap:8px;align-items:center">
      <strong>${esc(item.item_id)}</strong>
      <button type="button" class="text-button" data-action="open-bot-folder-file" data-bot-id="${esc(bot.id)}" data-path="${esc(item.path)}">编辑</button>
    </div>
    ${item.note ? `<div style="font-size:var(--text-caption);white-space:pre-wrap">${esc(item.note.slice(0, 260))}</div>` : ''}
  </div>`).join('');
  return `<div class="profile-section-heading" style="margin-top:12px"><span>私有记忆（.local/memory · ${items.length}）</span></div>${rows}`;
}

function renderDelivery(message) {
  return message._delivery ? renderSendStatus(message) : '';
}

function renderRoomSuspendedBanner() {
  const runs = ui.roomSuspendedRuns || [];
  if (!runs.length) return '';
  const latestByBot = new Map();
  for (const run of runs) latestByBot.set(run.bot_id, run);
  return `<div class="suspended-runs-banner">${[...latestByBot.values()].map(run => {
    const errCode = run.error?.code;
    const isAuth = errCode === 'auth_expired';
    const isQuota = errCode === 'quota_exhausted';
    const summary = isAuth ? '模型登录已失效' : isQuota ? '模型额度已用尽' : '暂时无法回复';
    const actionBtn = isAuth
      ? '<button type="button" class="text-button" data-action="navigate" data-view="models">重新登录</button>'
      : isQuota
        ? '<button type="button" class="text-button" data-action="navigate" data-view="models">更换模型</button>'
        : `<button type="button" class="text-button" data-action="retry-suspended" data-conversation="${esc(run.conversation_id)}" data-run="${esc(run.run_id)}">重试</button>`;
    return `<div class="suspended-run-row" role="status"><span>${esc(nameOf(run.bot_id))} · ${esc(summary)}</span>${actionBtn}</div>`;
  }).join('')}</div>`;
}

function getPromptDraft(msgId) {
  let draft = ui.promptDrafts.get(msgId);
  if (!draft) { draft = {}; ui.promptDrafts.set(msgId, draft); }
  return draft;
}

function isPromptReady(prompt, draft) {
  if (!prompt?.questions?.length) return false;
  return prompt.questions.every(q => {
    if (q.required === false) return true;
    const item = draft?.[q.id];
    const hasSelected = Array.isArray(item?.selected) && item.selected.length > 0;
    const hasCustom = typeof item?.custom === 'string' && item.custom.trim().length > 0;
    return q.mode === 'text' ? hasCustom : (hasSelected || hasCustom);
  });
}

function syncPromptSubmitButton(msgId, cardEl) {
  if (!cardEl) return;
  const msg = mergedRoomMessages(ui.roomId, ui.messages).find(item => item.id === msgId);
  const btn = cardEl.querySelector('[data-action="prompt-submit"]');
  if (!btn || !msg?.prompt) return;
  const ready = isPromptReady(msg.prompt, ui.promptDrafts.get(msgId));
  btn.disabled = !ui.protocolReady || ui.promptSubmitting.has(msgId) || !ready;
}

function findPromptAnswer(message, timeline) {
  if (message.promptAnswer && (message.promptAnswer.skipped || message.promptAnswer.answers?.length)) return message.promptAnswer;
  const reply = (timeline || []).find(item => item.promptResponse?.prompt_message_id === message.id);
  if (reply?.promptResponse && (reply.promptResponse.skipped || reply.promptResponse.answers?.length)) {
    return { by: reply.senderId, messageId: reply.id, answeredAt: reply.createdAt,
      ...(reply.promptResponse.skipped ? { skipped: true } : {}),
      ...(reply.promptResponse.secret_delivery ? { secret_delivery: reply.promptResponse.secret_delivery } : {}),
      answers: reply.promptResponse.answers || [] };
  }
  return null;
}

function renderMessagePrompt(message, timeline) {
  const prompt = message?.prompt;
  if (!prompt?.questions?.length) return '';
  const kind = prompt.kind || 'question';
  const kindLabel = kind === 'secret' ? '隐私输入' : kind === 'permission' ? '权限确认' : kind === 'confirm' ? '操作确认' : '待你选择';
  const answered = findPromptAnswer(message, timeline);
  if (answered) {
    if (answered.skipped) {
      return `<div class="prompt-card is-${esc(kind)} is-answered is-skipped" data-prompt-msg="${esc(message.id)}">
        <div class="prompt-card-head"><span class="prompt-kind-badge is-skipped">${kind === 'secret' ? '已取消' : '已跳过'}</span>${prompt.title ? `<strong class="prompt-title">${esc(prompt.title)}</strong>` : ''}</div>
        <div class="prompt-answer-row"><span class="prompt-answer-q">${kind === 'secret' ? '已取消本次隐私输入' : '已跳过本次选择，由 Bot 自行处理'}</span></div>
      </div>`;
    }
    const doneLabel = kind === 'secret' ? '已提交' : kind === 'permission' ? '已确认权限' : kind === 'confirm' ? '已确认' : '已提交选择';
    const rows = answered.answers.map(ans => {
      if (ans.redacted) {
        return `<div class="prompt-answer-row"><span class="prompt-answer-q">${esc(ans.label || ans.question_id)}</span><span class="prompt-answer-redacted">••••••</span></div>`;
      }
      const parts = [...(ans.selected_labels || [])];
      if (ans.custom_text) parts.push(ans.custom_text);
      return `<div class="prompt-answer-row"><span class="prompt-answer-q">${esc(ans.label || ans.question_id)}</span><span class="prompt-answer-v">${esc(parts.join(' · ') || '—')}</span></div>`;
    }).join('');
    return `<div class="prompt-card is-${esc(kind)} is-answered" data-prompt-msg="${esc(message.id)}">
      <div class="prompt-card-head"><span class="prompt-kind-badge is-done">${icon('check', 13)} ${esc(doneLabel)}</span>${prompt.title ? `<strong class="prompt-title">${esc(prompt.title)}</strong>` : ''}</div>
      <div class="prompt-answer-list">${rows}</div>
    </div>`;
  }
  const busy = ui.promptSubmitting.has(message.id);
  if (kind === 'secret') {
    const openLabel = prompt.submit_label || (prompt.secret_target?.kind === 'hub_login' ? '登录' : '填写');
    return `<div class="prompt-card is-secret" data-prompt-msg="${esc(message.id)}">
      <div class="prompt-card-head">
        <span class="prompt-kind-badge">${icon('shield', 13)} 隐私输入</span>
        ${prompt.title ? `<strong class="prompt-title">${esc(prompt.title)}</strong>` : ''}
      </div>
      <div class="prompt-card-foot">
        <button type="button" class="secondary-button prompt-skip-btn" data-action="prompt-skip" data-msg-id="${esc(message.id)}" ${!ui.protocolReady || busy ? 'disabled' : ''}>取消</button>
        <button type="button" class="primary-button prompt-submit-btn prompt-secret-open-btn" data-action="prompt-secret-open" data-msg-id="${esc(message.id)}" ${!ui.protocolReady || busy ? 'disabled' : ''}>${busy ? '提交中…' : esc(openLabel)}</button>
      </div>
    </div>`;
  }
  const draft = ui.promptDrafts.get(message.id) || {};
  const ready = isPromptReady(prompt, draft);
  const submitLabel = prompt.submit_label || (kind === 'permission' ? '确认授权' : kind === 'confirm' ? '确认' : '提交选择');
  const questionsHtml = prompt.questions.map((q, qIndex) => {
    const qDraft = draft[q.id] || { selected: [], custom: '' };
    const modeTag = q.mode === 'multi' ? '多选' : q.mode === 'text' ? '填写' : '单选';
    const optionsHtml = q.mode !== 'text' ? `<div class="prompt-options">${(q.options || []).map(opt => {
      const selected = qDraft.selected.includes(opt.id);
      const toneClass = opt.tone === 'primary' ? 'tone-primary' : opt.tone === 'danger' ? 'tone-danger' : '';
      const optElId = `prompt-opt-${message.id}-${q.id}-${opt.id}`;
      return `<button type="button" id="${esc(optElId)}" class="prompt-option ${selected ? 'selected' : ''} ${toneClass}"
        data-action="prompt-toggle" data-msg-id="${esc(message.id)}" data-qid="${esc(q.id)}" data-opt-id="${esc(opt.id)}" data-mode="${esc(q.mode)}"
        aria-pressed="${selected}" ${busy ? 'disabled' : ''}>
        <span class="prompt-option-indicator ${q.mode === 'multi' ? 'is-checkbox' : 'is-radio'}" aria-hidden="true">${selected ? icon('check', 12) : ''}</span>
        <span class="prompt-option-copy">
          <span class="prompt-option-label">${esc(opt.label)}${opt.recommended ? '<em class="prompt-rec-badge">推荐</em>' : ''}</span>
          ${opt.description ? `<small class="prompt-option-desc">${esc(opt.description)}</small>` : ''}
        </span>
      </button>`;
    }).join('')}</div>` : '';
    const inputId = `prompt-input-${message.id}-${q.id}`;
    const placeholder = q.custom_placeholder || (q.mode === 'text' ? '请输入回答，按 Enter 提交…' : q.mode === 'multi' ? '补充说明或自填其他选项（选填，Enter 提交）' : '或自定义填写其他想法（Enter 提交）…');
    const customHtml = (q.mode === 'text' || q.allow_custom)
      ? `<div class="prompt-custom-wrap"><input type="text" id="${esc(inputId)}" class="prompt-custom-input"
          data-msg-id="${esc(message.id)}" data-qid="${esc(q.id)}" data-mode="${esc(q.mode)}"
          value="${esc(qDraft.custom || '')}" placeholder="${esc(placeholder)}" ${busy ? 'disabled' : ''}></div>`
      : '';
    const allSelected = q.mode === 'multi' && (q.options || []).length > 0 && (q.options || []).every(opt => qDraft.selected.includes(opt.id));
    const selectAllBtn = q.mode === 'multi' && (q.options || []).length > 1
      ? `<button type="button" class="text-button" style="font-size:12px;padding:0 4px" data-action="prompt-select-all" data-msg-id="${esc(message.id)}" data-qid="${esc(q.id)}" ${busy ? 'disabled' : ''}>${allSelected ? '取消全选' : '全选'}</button>`
      : '';
    return `<div class="prompt-question" data-qid="${esc(q.id)}">
      <div class="prompt-question-head">
        <span class="prompt-question-label">${prompt.questions.length > 1 ? `${qIndex + 1}. ` : ''}${esc(q.label)}</span>
        <span class="prompt-question-meta">${selectAllBtn}${esc(modeTag)}${q.required === false ? ' · 选填' : ''}</span>
      </div>
      ${optionsHtml}${customHtml}
    </div>`;
  }).join('');
  return `<div class="prompt-card is-${esc(kind)}" data-prompt-msg="${esc(message.id)}">
    <div class="prompt-card-head"><span class="prompt-kind-badge">${esc(kindLabel)}</span>${prompt.title ? `<strong class="prompt-title">${esc(prompt.title)}</strong>` : ''}</div>
    <div class="prompt-questions">${questionsHtml}</div>
    <div class="prompt-card-foot">
      <span class="prompt-enter-hint">Enter 提交</span>
      <button type="button" class="secondary-button prompt-skip-btn" data-action="prompt-skip" data-msg-id="${esc(message.id)}" ${!ui.protocolReady || busy ? 'disabled' : ''}>跳过</button>
      <button type="button" class="primary-button prompt-submit-btn" data-action="prompt-submit" data-msg-id="${esc(message.id)}" ${!ui.protocolReady || busy || !ready ? 'disabled' : ''}>${busy ? '提交中…' : esc(submitLabel)}</button>
    </div>
  </div>`;
}

function openSecretPromptModal(msgId) {
  const room = roomById(ui.roomId);
  if (!room || !msgId || ui.promptSubmitting.has(msgId) || !ui.protocolReady) return;
  const timeline = mergedRoomMessages(room.id, ui.messages);
  const message = timeline.find(item => item.id === msgId);
  const prompt = message?.prompt;
  if (!prompt || prompt.kind !== 'secret') return;
  window.SummonSecretInput?.openForPrompt?.(message, {
    onStart: () => {
      ui.promptSubmitting.add(msgId);
      render();
    },
    onError: () => {
      ui.promptSubmitting.delete(msgId);
      render();
    },
    onSubmitted: async ({ answers, secret_delivery, summaryText }) => {
      const mentions = message.senderId && message.senderId !== 'user' && message.senderId !== 'system' && room.members.includes(message.senderId)
        ? [message.senderId] : [];
      const payload = {
        text: summaryText,
        mentions,
        reply_to: messageRef(message.id),
        prompt_response: {
          prompt_message_id: message.id,
          answers,
          ...(secret_delivery ? { secret_delivery } : {}),
        },
      };
      try {
        const entry = queueLocalMessage(room.id, payload, []);
        await sendLocalMessage(entry, true);
      } finally {
        ui.promptSubmitting.delete(msgId);
        render();
      }
    },
  });
}

async function submitPromptCard(msgId) {
  const room = roomById(ui.roomId);
  if (!room || !msgId || ui.promptSubmitting.has(msgId) || !ui.protocolReady) return;
  const timeline = mergedRoomMessages(room.id, ui.messages);
  const message = timeline.find(item => item.id === msgId);
  const prompt = message?.prompt;
  if (!prompt?.questions?.length) return;
  const draft = ui.promptDrafts.get(msgId) || {};
  if (!isPromptReady(prompt, draft)) {
    toast('请先完成必选项', true);
    return;
  }
  const answers = [];
  const summaryLines = [];
  for (const q of prompt.questions) {
    const item = draft[q.id] || { selected: [], custom: '' };
    const optMap = new Map((q.options || []).map(o => [o.id, o.label]));
    const selected_ids = (item.selected || []).filter(id => optMap.has(id));
    const selected_labels = selected_ids.map(id => optMap.get(id));
    const custom_text = (item.custom || '').trim();
    if (!selected_ids.length && !custom_text) continue;
    answers.push({
      question_id: q.id,
      label: q.label,
      selected_ids,
      selected_labels,
      ...(custom_text ? { custom_text } : {}),
    });
    const parts = [...selected_labels];
    if (custom_text) parts.push(selected_labels.length ? `补充：${custom_text}` : custom_text);
    summaryLines.push(prompt.questions.length === 1 ? `已选择：${parts.join('、')}` : `${q.label}：${parts.join('、')}`);
  }
  if (!answers.length) return;
  const mentions = message.senderId && message.senderId !== 'user' && message.senderId !== 'system' && room.members.includes(message.senderId)
    ? [message.senderId] : [];
  const payload = {
    text: summaryLines.join('\n'),
    mentions,
    reply_to: messageRef(message.id),
    prompt_response: { prompt_message_id: message.id, answers },
  };
  ui.promptSubmitting.add(msgId);
  render();
  try {
    const entry = queueLocalMessage(room.id, payload, []);
    await sendLocalMessage(entry, true);
    ui.promptDrafts.delete(msgId);
    if (ui.activePromptMsgId === msgId) ui.activePromptMsgId = null;
  } finally {
    ui.promptSubmitting.delete(msgId);
    render();
  }
}

async function skipPromptCard(msgId) {
  const room = roomById(ui.roomId);
  if (!room || !msgId || ui.promptSubmitting.has(msgId) || !ui.protocolReady) return;
  const timeline = mergedRoomMessages(room.id, ui.messages);
  const message = timeline.find(item => item.id === msgId);
  const prompt = message?.prompt;
  if (!prompt?.questions?.length) return;
  const mentions = message.senderId && message.senderId !== 'user' && message.senderId !== 'system' && room.members.includes(message.senderId)
    ? [message.senderId] : [];
  const kind = prompt.kind || 'question';
  const payload = {
    text: kind === 'secret' ? '已取消' : kind === 'permission' ? '已跳过权限确认' : '已跳过选择，由你自行处理',
    mentions,
    reply_to: messageRef(message.id),
    prompt_response: { prompt_message_id: message.id, skipped: true, answers: [] },
  };
  ui.promptSubmitting.add(msgId);
  render();
  try {
    const entry = queueLocalMessage(room.id, payload, []);
    await sendLocalMessage(entry, true);
    ui.promptDrafts.delete(msgId);
    if (ui.activePromptMsgId === msgId) ui.activePromptMsgId = null;
  } finally {
    ui.promptSubmitting.delete(msgId);
    render();
  }
}

function activeRoomPendingRequests() {
  const items = [];
  for (const exec of ui.roomExecutions || []) {
    if (!exec?.pending_requests?.length) continue;
    for (const req of exec.pending_requests) {
      const key = JSON.stringify([exec.execution_ref, exec.control_version, req.request_id]);
      items.push({ exec, req, key });
    }
  }
  return items;
}

function execSkipChoiceId(choices = []) {
  return choices.find(c => ['cancel', 'decline', 'deny'].includes(c.id))?.id || null;
}

const EXEC_SECRET_HINT_RE = /password|passwd|passphrase|token|secret|api[_\s-]?key|credential|otp|2fa|\bpin\b|密码|口令|密钥|令牌|验证码/i;

function isExecPromptSecret(key, question = '') {
  if (ui.execPromptMasked.has(key)) return ui.execPromptMasked.get(key);
  return EXEC_SECRET_HINT_RE.test(String(question || ''));
}

function renderRoomPendingPrompts() {
  const items = activeRoomPendingRequests();
  if (!items.length) return '';
  return `<div class="chat-pending-prompts">${items.map(({ exec, req, key }) => {
    const isApproval = req.kind === 'approval';
    const busy = ui.execPromptBusy.has(key);
    const currentVal = ui.execPromptDrafts.get(key) ?? '';
    const choices = req.choices || [];
    const isSecretText = !choices.length && isExecPromptSecret(key, req.question);
    const skipId = execSkipChoiceId(choices);
    const actorLabel = nameOf(exec.execution_actor?.id || exec.bot_id);
    const keySlug = key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
    const inputId = 'exec-prompt-' + keySlug;
    const body = choices.length
      ? `<div class="prompt-options">${choices.map(choice => {
          const cid = choice.id;
          const selected = currentVal === cid;
          const toneClass = cid === 'accept' ? 'tone-primary' : ['deny', 'decline', 'cancel'].includes(cid) ? 'tone-danger' : '';
          return `<button type="button" id="${esc('exec-opt-' + keySlug + '-' + cid)}" class="prompt-option ${selected ? 'selected' : ''} ${toneClass}"
            data-action="exec-prompt-select" data-exec-key="${esc(key)}" data-choice-id="${esc(cid)}" aria-pressed="${selected}" ${busy ? 'disabled' : ''}>
            <span class="prompt-option-indicator is-radio" aria-hidden="true">${selected ? icon('check', 12) : ''}</span>
            <span class="prompt-option-copy"><span class="prompt-option-label">${esc(choice.label || cid)}</span></span>
          </button>`;
        }).join('')}</div>`
      : `<div class="prompt-custom-wrap"><input type="${isSecretText ? 'password' : 'text'}" id="${esc(inputId)}" class="exec-prompt-input prompt-custom-input"
          data-exec-key="${esc(key)}" value="${esc(currentVal)}" placeholder="${isSecretText ? '隐私输入（Enter 提交）' : '输入回答，按 Enter 提交…'}"
          ${isSecretText ? 'autocomplete="off" spellcheck="false"' : ''} ${busy ? 'disabled' : ''}></div>`;
    const secretToggleBtn = !choices.length
      ? `<button type="button" class="exec-secret-toggle ${isSecretText ? 'active' : ''}" data-action="exec-prompt-toggle-secret" data-exec-key="${esc(key)}" data-question="${esc(req.question || '')}" ${busy ? 'disabled' : ''}>${icon('lock', 12)} 隐私</button>`
      : '';
    return `<div class="prompt-card exec-pending-card ${isSecretText ? 'is-secret' : isApproval ? 'is-permission' : 'is-question'}" data-exec-key="${esc(key)}">
      <div class="prompt-card-head">
        <span class="prompt-kind-badge">${isSecretText ? `${icon('shield', 12)} 隐私输入` : isApproval ? '执行权限审批' : '执行会话提问'}</span>
        <strong class="prompt-title">${esc(actorLabel)}${exec.engine ? ` · ${esc(exec.engine)}` : ''}</strong>
        ${secretToggleBtn}
      </div>
      ${req.question ? `<p class="exec-pending-question">${esc(req.question)}</p>` : ''}
      ${body}
      <div class="prompt-card-foot">
        <span class="prompt-enter-hint">Enter 提交</span>
        ${skipId ? `<button type="button" class="secondary-button prompt-skip-btn" data-action="exec-prompt-skip" data-exec-key="${esc(key)}" ${!ui.protocolReady || busy ? 'disabled' : ''}>跳过</button>` : ''}
        <button type="button" class="primary-button prompt-submit-btn ${isSecretText ? 'prompt-secret-open-btn' : ''}" data-action="exec-prompt-submit" data-exec-key="${esc(key)}" ${!ui.protocolReady || busy || !String(currentVal).trim() ? 'disabled' : ''}>${busy ? '提交中…' : isSecretText ? '提交' : isApproval ? '确认审批' : '提交回答'}</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}

async function submitExecPromptCard(key, overrideValue = null) {
  const item = activeRoomPendingRequests().find(entry => entry.key === key);
  if (!item || ui.execPromptBusy.has(key) || !ui.protocolReady) return;
  const val = String(overrideValue ?? ui.execPromptDrafts.get(key) ?? '').trim();
  if (!val) return;
  const isSecretText = !overrideValue && !(item.req.choices || []).length && isExecPromptSecret(key, item.req.question);
  ui.execPromptBusy.add(key);
  render();
  try {
    if (isSecretText && item.exec.execution_ref?.kind === 'session') {
      await api('/api/secrets/deliver', 'POST', {
        target: {
          kind: 'session_input',
          session_id: item.exec.execution_ref.id,
          control_version: item.exec.control_version,
          request_id: item.req.request_id,
        },
        fields: { input: val },
      }, { clientId: newClientId() });
    } else {
      await api('/api/executions/input', 'POST', {
        target: item.exec.execution_ref,
        kind: 'reply',
        control_version: item.exec.control_version,
        request_id: item.req.request_id,
        input: val,
      }, { clientId: newClientId() });
    }
    ui.execPromptDrafts.delete(key);
    ui.execPromptMasked.delete(key);
    toast(overrideValue ? '已跳过该执行请求' : isSecretText ? '已提交' : item.req.kind === 'approval' ? '已提交审批决定' : '已提交执行回答');
    await refresh();
  } finally {
    ui.execPromptBusy.delete(key);
    render();
  }
}

async function skipExecPromptCard(key) {
  const item = activeRoomPendingRequests().find(entry => entry.key === key);
  if (!item) return;
  const skipId = execSkipChoiceId(item.req.choices || []);
  if (!skipId) return;
  return submitExecPromptCard(key, skipId);
}

const MESSAGE_ACK_DELAY_MS = 1000;
let ackRevealTimer = null;
let ackRevealTargetAt = 0;

function scheduleAckReveal(targetAt) {
  const delay = Math.max(20, targetAt - Date.now() + 20);
  if (ackRevealTimer && ackRevealTargetAt && ackRevealTargetAt <= targetAt + 10) return;
  if (ackRevealTimer) clearTimeout(ackRevealTimer);
  ackRevealTargetAt = targetAt;
  ackRevealTimer = setTimeout(() => {
    ackRevealTimer = null;
    ackRevealTargetAt = 0;
    if (ui.view === 'chat') render();
  }, delay);
}

function resolveMessageAcks(message, timeline) {
  const candidates = [];
  const seen = new Set();
  for (const item of message.acks || []) {
    if (!item?.botId || seen.has(item.botId)) continue;
    seen.add(item.botId);
    candidates.push({ botId: item.botId, label: item.label || '收到', at: parseTimestampMs(item.at) });
  }
  const mentions = message.mentions || [];
  if (mentions.length && !message._delivery) {
    const activeBots = new Set([
      ...(ui.roomActivities || []).filter(a => a.phase && a.phase !== 'fast_read').map(a => a.bot_id),
      ...(ui.roomExecutions || []).filter(e => LIVE_EXEC_STATUSES.has(e.status)).map(e => e.execution_actor?.id || e.bot_id),
    ].filter(Boolean));
    for (const botId of mentions) {
      if (botId === 'user' || seen.has(botId) || !activeBots.has(botId)) continue;
      const latestForBot = [...timeline].reverse().find(m => !m._delivery && (m.mentions || []).includes(botId));
      if (latestForBot?.id === message.id) {
        seen.add(botId);
        candidates.push({ botId, label: '收到', at: 0 });
      }
    }
  }
  if (!candidates.length) return [];
  const nowMs = Date.now();
  const msgAt = parseTimestampMs(message.createdAt);
  const minRevealAt = msgAt > 0 ? msgAt + MESSAGE_ACK_DELAY_MS : 0;
  const visible = [];
  for (const item of candidates) {
    const revealAt = Math.max(minRevealAt, item.at || 0);
    if (revealAt > nowMs) {
      scheduleAckReveal(revealAt);
      continue;
    }
    const fresh = revealAt > 0 && (nowMs - revealAt) < 550;
    visible.push({ botId: item.botId, label: item.label, fresh });
  }
  return visible;
}

function renderMessageAcks(message, timeline) {
  const acks = resolveMessageAcks(message, timeline);
  if (!acks.length) return '';
  return `<div class="message-acks" aria-label="快捷确认">${acks.map(ack => {
    const appearance = botAvatar(ack.botId);
    return `<span class="message-ack-pill ${ack.fresh ? 'is-fresh' : ''}" style="--ack-color:${esc(appearance.color || 'var(--ok)')}">
      <span class="message-ack-badge">${icon('check', 11)}<span>${esc(ack.label)}</span></span>
      <span class="message-ack-sep" aria-hidden="true"></span>
      ${face(appearance, 15, { static: true })}
      <span class="message-ack-name">${esc(nameOf(ack.botId))}</span>
    </span>`;
  }).join('')}</div>`;
}

function renderChatMessage(message, timeline, grouped, isGroup, previous = null) {
  const sender = message.senderId, own = sender === 'user', platform = ['system', 'platform'].includes(sender);
  const senderLabel = message.senderName || nameOf(sender);
  const rawParent = message.replyTo ? timeline.find(item => item.id === message.replyTo) : null;
  const showReplyQuote = Boolean(message.replyTo && message.replyTo !== previous?.id && !rawParent?.promptResponse);
  const parent = showReplyQuote ? rawParent : null;
  const pinned = roomById(ui.roomId)?.pins.some(ref => ref.kind === 'event' && ref.id === message.id);
  const mentions = message.mentions || [];
  const identity = own || grouped || (!isGroup && !platform) ? '' : `<div class="message-identity"><strong>${esc(senderLabel)}</strong><time datetime="${esc(message.createdAt)}" title="${esc(formatTime(message.createdAt,true))}">${formatTime(message.createdAt)}</time></div>`;
  const ownTime = own && message.createdAt ? `<time class="outgoing-time" datetime="${esc(message.createdAt)}" title="${esc(formatTime(message.createdAt,true))}">${formatTime(message.createdAt)}</time>` : '';
  const avatarSlot = own || (!isGroup && !platform) ? '' : grouped ? '<span class="message-avatar-spacer"></span>' : botById(sender)
    ? `<button class="message-avatar-button" data-action="open-bot-details" data-id="${esc(sender)}" aria-label="查看 ${esc(nameOf(sender))}">${avatar(sender,36,'')}</button>`
    : `<span class="message-avatar">${avatar(sender,36,'')}</span>`;
  const reply = showReplyQuote ? `<button type="button" class="reply-quote" data-action="open-reference" data-kind="event" data-id="${esc(message.replyTo)}">
    <strong>${esc(parent ? nameOf(parent.senderId) : '引用消息')}</strong><span>${esc(parent ? messagePreview(parent) : '查看原文')}</span></button>` : '';
  const actions = message._delivery ? '' : `<div class="bubble-actions">
    <button data-action="reply-message" data-id="${esc(message.id)}" title="回复" aria-label="回复">${icon('back',16)}</button>
    <button data-action="copy-message" data-id="${esc(message.id)}" title="复制" aria-label="复制">${icon('copy',15)}</button>
    <button data-action="${pinned ? 'unpin' : 'pin'}" data-kind="event" data-id="${esc(message.id)}" title="${pinned ? '取消置顶' : '置顶'}" aria-label="${pinned ? '取消置顶' : '置顶'}">${icon('pin',16)}</button>
  </div>`;
  const promptHtml = !own ? renderMessagePrompt(message, timeline) : '';
  return `<article data-message-id="${esc(message.id)}" data-motion-key="message:${esc(message.clientId || message.id)}"
      class="chat-message ${own ? 'outgoing' : 'incoming'} ${isGroup ? 'in-group' : 'direct-message'} ${grouped ? 'continuation' : ''} ${platform ? 'system-message' : ''}"
      style="--member-color:${own || platform ? 'var(--accent)' : esc(botAvatar(sender).color)}">
    ${avatarSlot}
    <div class="bubble-column">${identity}<div class="message-bubble" tabindex="0">${reply}
      ${mentions.length ? `<div class="bubble-target">${mentions.map(id => id === 'user' ? `<span>@${esc(ownerName())}</span>` : botMention(id)).join('')}</div>` : ''}
      ${message.content ? `<div class="message-content">${richText(message.content)}</div>` : ''}
      ${promptHtml}
      ${renderMessageAttachments(message.attachments)}
      ${message.references?.length ? `<div class="reference-list">${message.references.map(ref => renderReference(ref)).join('')}</div>` : ''}
      ${renderMessageAcks(message, timeline)}
      ${ownTime}
    </div>${renderDelivery(message)}${actions}</div></article>`;
}

function renderNewGroupDraft() {
  const egg = eggBotMember();
  const eggAppearance = egg ? botAvatar(egg) : window.SummonAvatars.defaults('bot-default-eggbot-local');
  const accent = eggAppearance.color || '#7D824B';
  const modelBanner = ui.protocolReady && state.modelSettings && !state.modelSettings.activeId
    ? `<div class="message-delivery" role="status" style="margin:8px 16px"><span>尚未配置默认聊天模型，配置后 Bot 即可开始响应。</span>
        <button type="button" class="text-button" data-action="open-settings" data-tab="models">配置模型</button></div>`
    : '';
  const writableWorkspaces = (state.workspaces || []).filter(item => item.write !== false);
  const selectedWs = writableWorkspaces.find(item => item.id === ui.draftWorkspaceId) || null;
  const wsMenu = ui.menu === 'draft-workspace' && writableWorkspaces.length
    ? `<div class="context-menu draft-workspace-menu" aria-label="选择群项目目录">
        ${writableWorkspaces.map(ws => `<button type="button" class="draft-ws-option ${ws.id === ui.draftWorkspaceId ? 'selected' : ''}" data-action="select-draft-workspace" data-id="${esc(ws.id)}">
          <span class="draft-ws-copy"><strong>${esc(ws.name)}</strong><small>${esc(ws.path)}</small></span>
          ${ws.id === ui.draftWorkspaceId ? icon('check', 15) : ''}
        </button>`).join('')}
        ${selectedWs ? `<button type="button" class="draft-ws-option clear" data-action="select-draft-workspace" data-id="">${icon('close', 14)}<span>暂不绑定目录</span></button>` : ''}
      </div>`
    : '';
  const hubOnlineNodes = window.SummonHub?.onlineNodes?.() || [];
  const draftNodePicker = hubOnlineNodes.length > 1
    ? `<label class="draft-ws-pill has-value" style="gap:6px"><span>电脑：</span><select data-hub-select="active-node" aria-label="选择建群电脑" style="border:0;background:transparent;color:inherit;font:inherit;outline:none">${hubOnlineNodes.map(n => `<option value="${esc(n.id)}" ${n.id === window.SummonHub.state.activeNodeId ? 'selected' : ''}>${esc(n.name)}${n.isLocal ? '（本机）' : ''}</option>`).join('')}</select></label>`
    : '';
  const wsPicker = (writableWorkspaces.length || draftNodePicker)
    ? `<div class="draft-composer-bar">${draftNodePicker}${writableWorkspaces.length ? `<div class="menu-anchor">
        <button type="button" class="draft-ws-pill ${selectedWs ? 'has-value' : ''}" data-action="toggle-draft-workspace" aria-expanded="${ui.menu === 'draft-workspace'}" ${ui.creatingRoomBusy ? 'disabled' : ''}>
          ${icon('folder', 15)}<span>${selectedWs ? `目录：${esc(selectedWs.name)}` : '绑定项目目录（可选）'}</span>
        </button>${wsMenu}</div>
        ${selectedWs ? `<button type="button" class="draft-ws-clear" data-action="clear-draft-workspace" aria-label="取消绑定目录" title="取消绑定目录">${icon('close', 14)}</button>` : ''}` : ''}
      </div>`
    : '';
  const draftText = ui.drafts[DRAFT_ROOM_ID] || '';
  const header = `<div class="floating-header"><div class="header-left"><button class="mobile-back icon-button" data-action="room-back" aria-label="返回群聊列表">${icon('chevronBack',23)}</button>
    <button type="button" class="sidebar-toggle-btn" data-action="toggle-sidebar" title="收起 / 展开侧栏" aria-label="收起 / 展开侧栏">${icon('panel',18)}</button></div>
    <div class="chat-header-actions"></div></div>`;
  const suggestions = NEW_GROUP_SUGGESTIONS.map(item => `
    <button type="button" class="draft-suggestion-card" data-action="draft-suggestion" data-id="${esc(item.id)}" ${!ui.protocolReady || ui.creatingRoomBusy ? 'disabled' : ''}>
      <strong>${esc(item.title)}</strong>
      <small>${esc(item.desc)}</small>
    </button>`).join('');
  return `<div data-room-id="${DRAFT_ROOM_ID}" data-ready="true" class="chat-layout draft-group-layout" style="--accent:${esc(accent)}">
    <section class="conversation">
      ${header}
      <div class="messages draft-group-stage" role="region" aria-label="开启新群聊">
        ${modelBanner}
        <div class="draft-group-hero">
          <div class="draft-group-avatar" aria-hidden="true">
            ${face(eggAppearance, 116, { key: 'draft-group:eggbot', identity: egg ? `bot:${egg.id}` : 'draft:eggbot', preview: true, intro: true, followPointer: true, state: ui.creatingRoomBusy ? 'work' : 'idle' })}
          </div>
          <div class="draft-group-bubble">
            <span class="draft-group-sender">${esc(egg?.name || 'EggBot')} · 团队孵化</span>
            <h1>${ui.creatingRoomBusy ? '正在为你建群并安排伙伴…' : '你想要建一个什么群呢？'}</h1>
            <p>${ui.creatingRoomBusy ? '群主控与 EggBot 正在就位，马上进入对话。' : '直接告诉我你想推进的项目、长期事务或想要的专员，我会立刻建群、命名并为你配齐团队。'}</p>
          </div>
          <div class="draft-group-suggestions" role="group" aria-label="默认建群建议">
            ${suggestions}
          </div>
        </div>
      </div>
      <div class="composer-wrap draft-composer-wrap">
        ${wsPicker}
        <form id="message-form" class="composer" data-room-id="${DRAFT_ROOM_ID}">
          <textarea id="message-input" name="content" rows="1" maxlength="16000" aria-label="描述你想建的群" placeholder="说说想建什么群、要做什么事，或点上方建议直接开始…" ${ui.creatingRoomBusy ? 'disabled' : ''}>${esc(draftText)}</textarea>
          <button type="submit" class="composer-send" ${!ui.protocolReady || ui.creatingRoomBusy || !draftText.trim() ? 'disabled' : ''} aria-label="创建并发送">${icon('send',22)}</button>
        </form>
      </div>
    </section>
  </div>`;
}

function renderChat() {
  if (window.SummonHub?.state?.initialized && !window.SummonHub.onlineNodes().length) {
    return window.SummonHub.renderNoOnlineNodesEmpty();
  }
  if (ui.creatingRoom) return renderNewGroupDraft();
  const room = roomById(ui.roomId), bot = currentBot(), isGroup = !directRoom(room);
  if (!room) return renderNewGroupDraft();
  const members = (room?.members || []).filter(id => id !== 'user').map(botById).filter(Boolean);
  const title = room?.name || '消息';
  const timeline = mergedRoomMessages(ui.roomId, ui.messages);
  const visibleTimeline = timeline.filter(message => !message.promptResponse);
  let previousDay = '';
  const messages = visibleTimeline.map((message, index) => {
    const previous = visibleTimeline[index - 1];
    const elapsed = Date.parse(message.createdAt) - Date.parse(previous?.createdAt);
    const day = formatDay(message.createdAt);
    const divider = day !== previousDay ? `<div class="date-divider">${esc(day)}</div>` : '';
    const grouped = day === previousDay && previous?.senderId === message.senderId && !previous?.prompt && elapsed >= 0 && elapsed <= 120000;
    previousDay = day;
    return divider + renderChatMessage(message, timeline, grouped, isGroup, previous);
  }).join('');
  const archived = isArchivedRoom(room);
  const liveWorkItems = archived ? [] : collectRoomActivityItems(room, members);
  const liveWork = archived ? null : summarizeRoomWork(room, liveWorkItems);
  const subtitleHtml = archived
    ? `<small>${esc(`已归档 · ${members.length} 位伙伴`)}</small>`
    : liveWork
      ? `<small class="chat-title-live ${liveWork.hasWaitingInput ? 'is-waiting' : liveWork.isQuiet ? 'is-quiet' : ''}">
          <i class="chat-title-live-dot" aria-hidden="true"></i>
          <span>${esc(liveWork.headerText)}</span>
          <span class="chat-title-live-timer" data-live-timer data-started-at="${liveWork.startedAt}">${esc(formatElapsedClock(liveWork.elapsedMs))}</span>
        </small>`
      : (isGroup ? `<small>${esc(`${members.length} 位伙伴`)}</small>` : bot ? `<small>${esc(botActivity(bot).text)}</small>` : '');
  const header = `<div class="floating-header"><div class="header-left"><button class="mobile-back icon-button" data-action="room-back" aria-label="返回会话">${icon('chevronBack',23)}</button>
    <button type="button" class="sidebar-toggle-btn" data-action="toggle-sidebar" title="收起 / 展开侧栏" aria-label="收起 / 展开侧栏">${icon('panel',18)}</button></div>
    ${room ? `<button type="button" class="chat-title-pill ${liveWork ? 'is-working' : ''}" data-action="toggle-details" aria-expanded="${!!ui.detailOpen}" title="展开右侧会话详情侧栏">${bot ? avatar(bot.id,30,'slot:title') : groupAvatar(room,30,'slot:title-group')}
      <span class="chat-title-copy"><strong>${esc(title)}</strong>${subtitleHtml}</span></button>` : ''}
    <div class="chat-header-actions">${room && archived
        ? `<button type="button" class="secondary-button small-button" data-action="restore-room" data-id="${esc(room.id)}">移出归档</button>`
        : ''}</div></div>`;
  const pins = room?.pins?.length ? `<div class="room-pins"><strong>置顶</strong>${room.pins.map(ref => renderReference(ref)).join('')}</div>` : '';
  const modelBanner = ui.protocolReady && state.modelSettings && !state.modelSettings.activeId
    ? `<div class="message-delivery" role="status" style="margin:8px 16px"><span>尚未配置默认聊天模型，配置后 Bot 即可开始响应。</span>
        <button type="button" class="text-button" data-action="open-settings" data-tab="models">配置模型</button></div>`
    : '';
  const body = `<div class="messages ${isGroup ? 'group-messages' : ''}" role="log" aria-label="聊天记录">${modelBanner}${pins}
      ${ui.historyCursor ? '<button class="text-button room-history" data-action="older-messages">更早的消息</button>' : ''}
      ${messages || `<div class="conversation-empty">${groupAvatar(room,86)}<p>${ui.messagesRoomId === room.id ? '还没有消息' : '正在读取消息…'}</p></div>`}</div>
      ${archived ? '' : renderRoomPendingPrompts()}
      ${renderChatComposer(room, members, liveWorkItems, liveWork)}`;
  return `<div data-room-id="${esc(ui.roomId)}" data-ready="${ui.messagesRoomId === ui.roomId}" class="chat-layout ${ui.detailOpen ? 'detail-open' : ''}"
    style="--accent:${esc(currentAccent())}"><section class="conversation">${header}${body}</section>${ui.detailOpen && room ? renderDetailPanel(room, ui.profileBotId ? profileBot() : null) : ''}</div>`;
}

function selectedMentions(room) {
  const value = ui.draftTargets[room.id];
  return (Array.isArray(value) ? value : value ? [value] : []).filter(id => room.members.includes(id));
}

const LIVE_EXEC_STATUSES = new Set(['opening', 'running', 'submitted', 'waiting', 'queued', 'needs_input', 'awaiting_input']);

function formatLiveStatusText(raw) {
  const cleaned = String(raw || '').replace(/\s+/g, ' ').trim().replace(/[。！？!?,，；;…\.]+$/u, '');
  if (!cleaned) return '正在处理中';
  if (/^(正在|等待|准备|已)/.test(cleaned)) return cleaned;
  const sep = /^[A-Za-z0-9]/.test(cleaned) ? ' ' : '';
  return `正在${sep}${cleaned}`;
}

const WORK_QUIET_THRESHOLD_MS = 75000;
const WORK_PHASE_RANK = { waiting_input: 5, session: 4, tool: 3, thinking: 2, planned: 1, fast_read: 0 };

function parseTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatElapsedClock(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatQuietDuration(ms) {
  const totalSec = Math.max(1, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs ? `${mins} 分 ${secs} 秒` : `${mins} 分钟`;
}

function collectRoomActivityItems(room, members) {
  const seen = new Set(), items = [];
  for (const act of ui.roomActivities || []) {
    const botId = act.bot_id;
    if (!botId || !botById(botId) || seen.has(botId)) continue;
    seen.add(botId);
    items.push({
      botId,
      name: nameOf(botId),
      text: act.text || '正在处理中',
      workSummary: act.work_summary || null,
      phase: act.phase || 'thinking',
      ref: act.execution_ref || null,
      startedAt: parseTimestampMs(act.started_at),
      updatedAt: parseTimestampMs(act.updated_at || act.started_at),
    });
  }
  for (const exec of ui.roomExecutions || []) {
    if (!LIVE_EXEC_STATUSES.has(exec.status)) continue;
    const botId = exec.execution_actor?.id || exec.bot_id;
    if (!botId || !botById(botId) || seen.has(botId)) continue;
    seen.add(botId);
    const needsInput = ['needs_input', 'awaiting_input'].includes(exec.status);
    const text = needsInput
      ? (exec.pending_requests?.[0]?.question ? `等待输入：${exec.pending_requests[0].question}` : '等待你的输入')
      : formatLiveStatusText(exec.live_progress || exec.work_summary || '正在执行任务');
    items.push({
      botId,
      name: nameOf(botId),
      text,
      workSummary: exec.work_summary || null,
      phase: needsInput ? 'waiting_input' : 'session',
      ref: exec.execution_ref,
      startedAt: parseTimestampMs(exec.created_at),
      updatedAt: parseTimestampMs(exec.updated_at || exec.created_at),
    });
  }
  if (directRoom(room)) {
    for (const member of members) {
      if (seen.has(member.id)) continue;
      const act = botActivity(member);
      if (act.kind === 'running') {
        seen.add(member.id);
        items.push({
          botId: member.id,
          name: member.name,
          text: act.text === '等待输入' ? '等待你的输入' : '正在处理中',
          workSummary: null,
          phase: 'thinking',
          ref: null,
          startedAt: 0,
          updatedAt: 0,
        });
      }
    }
  }
  if (!items.length && room?.id) {
    const opt = ui.optimisticRoomWork?.[room.id];
    if (opt && Date.now() - opt.startedAt <= 12000 && botById(opt.botId)) {
      items.push({
        botId: opt.botId,
        name: nameOf(opt.botId),
        text: room.auto_title_pending ? '正在理解需求并命名群聊' : '正在工作',
        workSummary: null,
        phase: 'thinking',
        ref: null,
        startedAt: opt.startedAt,
        updatedAt: opt.startedAt,
      });
    }
  }
  return items;
}

function summarizeRoomWork(room, items) {
  if (!room?.id) return null;
  if (!items.length) {
    delete ui.roomWorkEpoch[room.id];
    return null;
  }
  const nowMs = Date.now();
  const prev = ui.roomWorkEpoch[room.id];
  const liveExecutions = (ui.roomExecutions || []).filter(e => LIVE_EXEC_STATUSES.has(e.status));
  const candidateStarts = [
    prev?.startedAt || 0,
    ...items.map(it => it.startedAt),
    ...liveExecutions.map(e => parseTimestampMs(e.created_at)),
  ].filter(ts => ts > 0 && ts <= nowMs + 60000);
  const startedAt = candidateStarts.length ? Math.min(...candidateStarts) : nowMs;

  const signatureText = items.map(it => `${it.botId}:${it.phase}:${it.text}:${it.workSummary || ''}`).join('|');
  const candidateUpdates = [
    prev?.lastUpdateAt || 0,
    ...items.map(it => it.updatedAt),
    ...liveExecutions.map(e => parseTimestampMs(e.updated_at || e.created_at)),
  ].filter(ts => ts > 0 && ts <= nowMs + 60000);
  let lastUpdateAt = candidateUpdates.length ? Math.max(...candidateUpdates) : startedAt;
  if (!prev || prev.signatureText !== signatureText) {
    lastUpdateAt = Math.max(lastUpdateAt, nowMs);
  }

  const burstExecs = (ui.roomExecutions || []).filter(e => {
    if (LIVE_EXEC_STATUSES.has(e.status)) return true;
    const created = parseTimestampMs(e.created_at);
    const updated = parseTimestampMs(e.updated_at || e.created_at);
    return (created >= startedAt - 10000) || (updated >= startedAt);
  });
  const liveCount = burstExecs.filter(e => LIVE_EXEC_STATUSES.has(e.status)).length;
  const doneCount = burstExecs.filter(e => ['completed', 'failed', 'cancelled', 'stopped'].includes(e.status)).length;
  const totalCount = liveCount + doneCount;
  const prevTotal = prev?.totalCount || 0;
  const prevDone = prev?.doneCount || 0;
  if (totalCount !== prevTotal || doneCount !== prevDone) {
    lastUpdateAt = Math.max(lastUpdateAt, nowMs);
  }

  const hasWaitingInput = items.some(it => it.phase === 'waiting_input');
  const elapsedMs = Math.max(0, nowMs - startedAt);
  const quietMs = Math.max(0, nowMs - lastUpdateAt);
  const isQuiet = !hasWaitingInput && quietMs >= WORK_QUIET_THRESHOLD_MS;

  ui.roomWorkEpoch[room.id] = {
    startedAt,
    lastUpdateAt,
    signatureText,
    totalCount,
    doneCount,
    wasQuiet: isQuiet,
  };

  const ranked = [...items].sort((a, b) => (WORK_PHASE_RANK[b.phase] ?? 1) - (WORK_PHASE_RANK[a.phase] ?? 1));
  const primary = ranked[0];
  const substantive = ranked.filter(it => it.phase !== 'fast_read');
  const displayItems = substantive.length ? substantive : ranked;
  const actorLabel = displayItems.length > 1 ? `${primary.name} 等 ${displayItems.length} 位` : primary.name;
  const headerText = hasWaitingInput
    ? '等待你的输入'
    : isQuiet
      ? `${primary.name} 等待响应`
      : displayItems.length > 1
        ? `${displayItems.length} 位伙伴工作中`
        : `${primary.name} 工作中`;
  const batchText = totalCount >= 2
    ? (doneCount > 0 ? `${doneCount} / ${totalCount}` : `${liveCount} 项并行`)
    : '';
  const progressPct = totalCount >= 3 && doneCount > 0
    ? Math.max(6, Math.min(96, Math.round((doneCount / totalCount) * 100)))
    : null;

  return {
    primary,
    items: displayItems,
    startedAt,
    lastUpdateAt,
    elapsedMs,
    quietMs,
    hasWaitingInput,
    isQuiet,
    actorLabel,
    headerText,
    batchText,
    progressPct,
    liveCount,
    doneCount,
    totalCount,
  };
}

function currentRoomGoal(room) {
  if (!room?.id) return null;
  if (ui.roomGoal && ui.roomGoal.room_id === room.id) return ui.roomGoal;
  return room.goal || null;
}

function goalStepSnapshot(goal) {
  if (!goal) return null;
  const steps = Array.isArray(goal.steps) ? goal.steps : [];
  const total = steps.length;
  const done = steps.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const active = steps.find(s => s.status === 'in_progress')
    || steps.find(s => s.status === 'awaiting_user')
    || steps.find(s => s.status === 'blocked')
    || steps.find(s => s.status === 'pending')
    || steps.at(-1)
    || null;
  const activeIdx = active ? steps.findIndex(s => s.id === active.id) + 1 : total;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return { steps, total, done, active, activeIdx, pct };
}

function renderGoalStepMarker(step, index) {
  if (step.status === 'done') return '<span class="goal-step-marker is-done" aria-label="已完成">✓</span>';
  if (step.status === 'in_progress') return '<span class="goal-step-marker is-progress" aria-label="进行中"><span class="goal-step-pulse"></span></span>';
  if (step.status === 'awaiting_user') return '<span class="goal-step-marker is-waiting" aria-label="等待确认">?</span>';
  if (step.status === 'blocked') return '<span class="goal-step-marker is-blocked" aria-label="受阻">!</span>';
  if (step.status === 'skipped') return '<span class="goal-step-marker is-skipped" aria-label="已跳过">—</span>';
  return `<span class="goal-step-marker is-pending" aria-label="待执行">${index + 1}</span>`;
}

function renderRoomExecutionDrawer(room, liveItems) {
  if (ui.openRoomExecution !== room.id) return '';
  const goal = currentRoomGoal(room);
  const allExecutions = [...(ui.roomExecutions || [])].sort((a, b) => {
    const aLive = LIVE_EXEC_STATUSES.has(a.status) ? 0 : 1;
    const bLive = LIVE_EXEC_STATUSES.has(b.status) ? 0 : 1;
    if (aLive !== bLive) return aLive - bLive;
    return String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || ''));
  });
  const liveExecutions = allExecutions.filter(e => LIVE_EXEC_STATUSES.has(e.status));
  const recentFinished = allExecutions.filter(e => !LIVE_EXEC_STATUSES.has(e.status)).slice(0, 3);
  const executions = [...liveExecutions, ...recentFinished];
  const liveBotsInExec = new Set(liveExecutions.map(e => e.execution_actor?.id || e.bot_id));
  const activeCount = liveExecutions.length + liveItems.filter(item => !liveBotsInExec.has(item.botId)).length;

  if (goal && ui.roomDrawerMode !== 'executions') {
    const snap = goalStepSnapshot(goal);
    const statusMap = {
      active: goal.stalled ? { text: '已暂停', cls: 'warn' } : { text: '进行中', cls: 'live' },
      awaiting_user: { text: '等待确认', cls: 'warn' },
      completed: { text: '已完成', cls: 'done' },
      stopped: { text: '已停止', cls: '' },
    };
    const badge = statusMap[goal.status] || { text: '进行中', cls: 'live' };
    const canStop = goal.status === 'active' || activeCount > 0;
    const canResume = Boolean(goal.stalled || goal.status === 'stopped');
    const canClear = Boolean(goal.status === 'completed' || goal.status === 'stopped' || goal.stalled);
    const stepRows = snap.steps.map((step, idx) => {
      const ownerId = step.owner || null;
      const ownerLabel = ownerId === 'user' ? '宿主' : (ownerId ? nameOf(ownerId) : '');
      const ownerIsBot = Boolean(ownerId && ownerId !== 'user' && botById(ownerId));
      const matchedLive = step.status === 'in_progress'
        ? (liveItems.find(it => it.botId === ownerId) || (snap.active?.id === step.id ? liveItems[0] : null))
        : null;
      const liveExec = matchedLive?.ref?.kind === 'session'
        ? liveExecutions.find(e => e.execution_ref?.id === matchedLive.ref.id)
        : (step.status === 'in_progress' && ownerId ? liveExecutions.find(e => (e.execution_actor?.id || e.bot_id) === ownerId) : null);
      const liveRef = liveExec?.execution_ref || matchedLive?.ref || null;
      const liveLabel = liveExec
        ? `${executionLabel(liveExec)} · ${liveExec.live_progress || liveExec.work_summary || '执行中'}`
        : (matchedLive ? matchedLive.text : '');
      return `<div class="goal-step-item is-${esc(step.status)}">
        ${renderGoalStepMarker(step, idx)}
        <div class="goal-step-body">
          <div class="goal-step-top">
            <span class="goal-step-title">${esc(step.title)}</span>
            ${ownerLabel ? `<span class="goal-step-owner">${ownerIsBot ? avatar(ownerId, 16, '') : ''}${esc(ownerLabel)}</span>` : ''}
          </div>
          ${step.note ? `<div class="goal-step-note">${esc(step.note)}</div>` : ''}
          ${liveLabel ? (liveRef
            ? `<button type="button" class="goal-step-live" data-action="open-execution" data-kind="${esc(liveRef.kind)}" data-id="${esc(liveRef.id)}"><span class="goal-step-live-dot"></span><span>${esc(liveLabel)}</span></button>`
            : `<div class="goal-step-live"><span class="goal-step-live-dot"></span><span>${esc(liveLabel)}</span></div>`) : ''}
        </div>
      </div>`;
    }).join('');
    return `<section class="bot-execution-drawer goal-plan-drawer" role="region" aria-label="当前执行计划">
      <div class="bot-execution-drawer-head">
        <div class="goal-drawer-heading">
          <span class="bot-execution-status ${esc(badge.cls)}">${esc(badge.text)}</span>
          <strong class="goal-drawer-title">${esc(goal.title)}</strong>
          <span class="goal-drawer-count">${snap.done}/${snap.total} 步</span>
        </div>
        <div class="bot-execution-drawer-actions">
          ${canResume ? '<button type="button" class="drawer-resume-btn" data-action="resume-room-goal">继续推进</button>' : ''}
          ${canStop ? '<button type="button" class="drawer-stop-btn" data-action="stop-room" title="停止本群在途工作与计划">停止工作</button>' : ''}
          ${canClear ? '<button type="button" class="text-button" data-action="clear-room-goal">清除</button>' : ''}
          ${executions.length || activeCount ? `<button type="button" class="text-button" data-action="toggle-drawer-mode">执行明细${activeCount ? ` (${activeCount})` : ''}</button>` : ''}
          <button type="button" class="icon-button" data-action="close-room-executions" aria-label="收起计划">${icon('close', 15)}</button>
        </div>
      </div>
      ${goal.done_criteria ? `<div class="goal-criteria">验收：${esc(goal.done_criteria)}</div>` : ''}
      ${goal.stalled && goal.stall_reason ? `<div class="goal-stall-banner">${esc(goal.stall_reason)}</div>` : ''}
      <div class="goal-plan-list">${stepRows}</div>
    </section>`;
  }

  const syntheticLiveRows = liveItems.filter(item => !liveBotsInExec.has(item.botId)).map(item => `
    <div class="bot-execution-item is-live">
      ${face(botAvatar(item.botId), 24, { key: `drawer-live:${room.id}:${item.botId}`, identity: `bot:${item.botId}`, state: 'work' })}
      <div class="bot-execution-copy">
        <div class="bot-execution-top"><strong>${esc(item.name)}</strong><span class="bot-execution-status live">进行中</span></div>
        <div class="bot-execution-summary">${esc(item.text)}</div>
      </div>
    </div>`).join('');
  const execRows = executions.map(item => {
    const ref = item.execution_ref;
    const botId = item.execution_actor?.id || item.bot_id;
    const isLive = LIVE_EXEC_STATUSES.has(item.status);
    const needsInput = ['needs_input', 'awaiting_input'].includes(item.status);
    const statusLabel = needsInput ? '等待输入' : isLive ? '进行中' : (labels[item.status] || item.status || '未知');
    const summary = needsInput
      ? (item.pending_requests?.[0]?.question || '等待确认或输入')
      : (item.live_progress || item.work_summary || '');
    const error = executionError(item);
    return `<button type="button" class="bot-execution-item ${isLive ? 'is-live' : ''}" data-action="open-execution" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">
      ${botId && botById(botId) ? avatar(botId, 24, '') : `<span class="bot-execution-dot ${isLive ? 'live' : ''}"></span>`}
      <div class="bot-execution-copy">
        <div class="bot-execution-top">
          <strong>${esc(botId ? nameOf(botId) : executionLabel(item))}</strong>
          <span class="bot-execution-engine">${esc(executionLabel(item))}</span>
          <span class="bot-execution-status ${needsInput ? 'warn' : isLive ? 'live' : item.status === 'failed' ? 'error' : ''}">${esc(statusLabel)}</span>
        </div>
        ${summary ? `<div class="bot-execution-summary">${esc(summary)}</div>` : ''}
        ${error ? `<div class="bot-execution-error">${esc(error)}</div>` : ''}
      </div>
    </button>`;
  }).join('');
  return `<section class="bot-execution-drawer" role="region" aria-label="执行过程">
    <div class="bot-execution-drawer-head">
      <strong>${activeCount ? `执行明细 · 进行中（${activeCount}）` : '最近执行明细'}</strong>
      <div class="bot-execution-drawer-actions">
        ${goal ? '<button type="button" class="text-button" data-action="toggle-drawer-mode">返回计划</button>' : ''}
        ${activeCount ? '<button type="button" class="drawer-stop-btn" data-action="stop-room" title="停止本群在途工作">停止工作</button>' : ''}
        <button type="button" class="text-button" data-action="open-panel-room" data-room="${esc(room.id)}">全部记录</button>
        <button type="button" class="icon-button" data-action="close-room-executions" aria-label="收起执行过程">${icon('close', 15)}</button>
      </div>
    </div>
    <div class="bot-execution-list">${syntheticLiveRows}${execRows || '<p class="bot-execution-empty">当前暂无执行记录</p>'}</div>
  </section>`;
}

function renderUnifiedWorkBand(room, items, work, drawerOpen) {
  const goal = currentRoomGoal(room);
  if (goal) {
    const snap = goalStepSnapshot(goal);
    const active = snap.active;
    const isRunning = Boolean(work && items.length);
    const displayItems = work?.items || items || [];
    const ownerBotId = active?.owner && active.owner !== 'user' && botById(active.owner)
      ? active.owner
      : (goal.owner_bot_id && botById(goal.owner_bot_id) ? goal.owner_bot_id : null);
    const avatarHtml = displayItems.length
      ? `<div class="cwb-avatars ${displayItems.length > 1 ? 'is-multi' : ''}">${displayItems.slice(0, 2).map(item => face(botAvatar(item.botId), 24, { key: `composer-work:${room.id}:${item.botId}`, identity: `bot:${item.botId}`, state: 'work' })).join('')}</div>`
      : ownerBotId
        ? `<div class="cwb-avatars">${face(botAvatar(ownerBotId), 24, { key: `composer-goal:${room.id}:${ownerBotId}`, identity: `bot:${ownerBotId}`, state: goal.status === 'active' && !goal.stalled ? 'work' : 'idle' })}</div>`
        : `<span class="goal-band-dot is-${esc(goal.stalled ? 'warn' : goal.status)}"></span>`;

    let labelText = '';
    let stepHtml = '';
    if (goal.status === 'completed') {
      labelText = '已完成';
      stepHtml = `<span class="cwb-step is-done">${esc(goal.title)}</span>`;
    } else if (goal.status === 'stopped') {
      labelText = '计划已停止';
      stepHtml = `<span class="cwb-step is-muted">${esc(goal.title)}</span>`;
    } else if (goal.stalled) {
      labelText = `已暂停 · 第 ${snap.activeIdx}/${snap.total} 步`;
      stepHtml = `<span class="cwb-quiet">${esc(active?.title || goal.title)}（点击查看或继续）</span>`;
    } else if (goal.status === 'awaiting_user') {
      labelText = `等待确认 · 第 ${snap.activeIdx}/${snap.total} 步`;
      stepHtml = `<span class="cwb-waiting">${esc(active?.title || goal.title)}</span>`;
    } else {
      labelText = `第 ${snap.activeIdx}/${snap.total} 步`;
      const stepTitle = active?.title || goal.title;
      const liveHint = isRunning && work?.primary?.text && !['正在处理中', '正在查看消息', '正在工作'].includes(work.primary.text)
        ? ` · ${work.primary.text}`
        : '';
      stepHtml = `<span class="shimmer-status cwb-step">${esc(stepTitle + liveHint)}</span>`;
    }

    const startedMs = work?.startedAt || parseTimestampMs(goal.created_at);
    const showTimer = goal.status === 'active' && !goal.stalled && startedMs > 0;
    const elapsedLabel = showTimer ? formatElapsedClock(Date.now() - startedMs) : '';
    const railDeterminate = goal.status === 'completed' || goal.status === 'stopped' || goal.status === 'awaiting_user' || goal.stalled || snap.done > 0;
    const railPct = goal.status === 'completed' ? 100 : (snap.total > 0 ? Math.max(snap.done > 0 ? Math.round((snap.done / snap.total) * 100) : 8, 8) : 0);

    return `<button type="button" class="composer-work-band ${drawerOpen ? 'drawer-open' : ''}"
        data-action="toggle-room-executions" aria-expanded="${drawerOpen}"
        title="${esc(goal.title)}（点击${drawerOpen ? '收起' : '展开'}当前计划）">
      <div class="cwb-row">
        ${avatarHtml}
        <span class="cwb-name">${esc(labelText)}</span>
        <span class="cwb-sep">·</span>
        ${stepHtml}
        <span class="cwb-batch">${snap.done}/${snap.total} 步</span>
        ${showTimer ? `<span class="cwb-timer" data-live-timer data-started-at="${startedMs}">${esc(elapsedLabel)}</span>` : ''}
        <span class="cwb-chevron" aria-hidden="true">${drawerOpen ? '▴' : '▾'}</span>
      </div>
      <div class="cwb-rail ${railDeterminate ? 'is-determinate' : ''}" aria-hidden="true">
        <span class="cwb-rail-fill" ${railDeterminate ? `style="width:${railPct}%"` : ''}></span>
      </div>
    </button>`;
  }

  if (!work || !items.length) return '';
  const { primary } = work;
  const displayItems = work.items || items;
  const stepHtml = work.isQuiet
    ? `<span class="cwb-quiet">等待响应（已静默 <span data-live-quiet-duration data-updated-at="${work.lastUpdateAt}">${esc(formatQuietDuration(work.quietMs))}</span>）</span>`
    : `<span class="${work.hasWaitingInput ? 'cwb-waiting' : 'shimmer-status'} cwb-step">${esc(primary.text)}</span>`;
  const elapsedLabel = formatElapsedClock(work.elapsedMs);

  return `<button type="button" class="composer-work-band ${drawerOpen ? 'drawer-open' : ''}"
      data-action="toggle-room-executions" aria-expanded="${drawerOpen}"
      title="${esc(work.actorLabel + ' · ' + primary.text)}（点击${drawerOpen ? '收起' : '查看'}执行过程）">
    <div class="cwb-row">
      <div class="cwb-avatars ${displayItems.length > 1 ? 'is-multi' : ''}">
        ${displayItems.slice(0, 2).map(item => face(botAvatar(item.botId), 24, { key: `composer-work:${room.id}:${item.botId}`, identity: `bot:${item.botId}`, state: 'work' })).join('')}
      </div>
      <span class="cwb-name">${esc(work.actorLabel)}</span>
      <span class="cwb-sep">·</span>
      ${stepHtml}
      ${work.batchText ? `<span class="cwb-batch">${esc(work.batchText)}</span>` : ''}
      <span class="cwb-timer" data-live-timer data-started-at="${work.startedAt}">${esc(elapsedLabel)}</span>
      <span class="cwb-chevron" aria-hidden="true">${drawerOpen ? '▴' : '▾'}</span>
    </div>
    <div class="cwb-rail ${work.progressPct != null ? 'is-determinate' : ''}" aria-hidden="true">
      <span class="cwb-rail-fill" ${work.progressPct != null ? `style="width:${work.progressPct}%"` : ''}></span>
    </div>
  </button>`;
}

let liveWorkClockTimer = null;
function stopLiveWorkClock() {
  if (liveWorkClockTimer) { clearInterval(liveWorkClockTimer); liveWorkClockTimer = null; }
}
function tickLiveWorkTimers() {
  const nowMs = Date.now();
  for (const el of $$('[data-live-timer]')) {
    const startedAt = Number(el.dataset.startedAt || 0);
    if (startedAt > 0) el.textContent = formatElapsedClock(nowMs - startedAt);
  }
  for (const el of $$('[data-live-quiet-duration]')) {
    const updatedAt = Number(el.dataset.updatedAt || 0);
    if (updatedAt > 0) el.textContent = formatQuietDuration(nowMs - updatedAt);
  }
  if (ui.view !== 'chat' || !ui.roomId) return;
  const epoch = ui.roomWorkEpoch[ui.roomId];
  if (!epoch) { stopLiveWorkClock(); return; }
  const shouldBeQuiet = (nowMs - epoch.lastUpdateAt) >= WORK_QUIET_THRESHOLD_MS;
  if (!epoch.wasQuiet && shouldBeQuiet) {
    render();
  }
}
function ensureLiveWorkClock() {
  const hasTimers = Boolean($('[data-live-timer]'));
  if (!hasTimers) { stopLiveWorkClock(); return; }
  tickLiveWorkTimers();
  if (!liveWorkClockTimer) {
    liveWorkClockTimer = setInterval(() => {
      if (document.hidden) return;
      if (!$('[data-live-timer]')) { stopLiveWorkClock(); return; }
      tickLiveWorkTimers();
    }, 1000);
  }
}
function syncBotActivityDock() {
  ensureLiveWorkClock();
}

function renderChatComposer(room, members, liveWorkItems, liveWork) {
  if (isArchivedRoom(room)) {
    return `<div class="composer-wrap"><div class="archived-room-bar" role="status">
      <div class="archived-room-bar-copy">${icon('archive', 18)}<span>该群聊已归档到群助手，Bot 自动唤醒已暂停，历史记录与资料均已保留。</span></div>
      <button type="button" class="primary-button small-button" data-action="restore-room" data-id="${esc(room.id)}">移出归档继续聊天</button>
    </div></div>`;
  }
  const items = liveWorkItems ?? collectRoomActivityItems(room, members);
  const work = liveWork !== undefined ? liveWork : summarizeRoomWork(room, items);
  const drawerOpen = ui.openRoomExecution === room.id;
  const drawer = drawerOpen ? renderRoomExecutionDrawer(room, items) : '';
  const workBand = renderUnifiedWorkBand(room, items, work, drawerOpen);
  const hasWorkShell = Boolean(workBand || drawer);
  const goal = currentRoomGoal(room);
  const workStateClass = (work?.hasWaitingInput || goal?.status === 'awaiting_user') ? 'is-waiting'
    : (work?.isQuiet || goal?.stalled) ? 'is-quiet'
    : goal?.status === 'completed' ? 'is-completed'
    : '';

  const mentions = selectedMentions(room), references = ui.draftReferences[room.id] || [];
  const menu = ui.menu === 'mentions' ? `<div class="mention-menu context-menu" aria-label="@ 成员">${members.map(member => `<button type="button"
      class="mention-choice" data-action="toggle-mention" data-id="${esc(member.id)}" aria-pressed="${mentions.includes(member.id)}">
      ${avatar(member.id,32,'')}<span>${esc(member.name)}</span>${mentions.includes(member.id) ? icon('check',16) : ''}</button>`).join('')}</div>` : '';
  const selectedReply = ui.draftReplies[room.id];
  const reply = selectedReply ? `<div class="reply-preview">${avatar(selectedReply.senderId,25,'')}<span>回复 ${esc(nameOf(selectedReply.senderId))}
    · ${esc(messagePreview(selectedReply))}</span><button type="button" class="icon-button" data-action="cancel-reply" aria-label="取消回复">${icon('close',16)}</button></div>` : '';
  const suspendedBanner = renderRoomSuspendedBanner();
  return `<div class="composer-wrap">${suspendedBanner}${reply}${renderAttachmentDrafts()}
    ${references.length ? `<div class="reference-list draft-references">${references.map(ref => `<span>${renderReference(ref)}
      <button type="button" class="icon-button" aria-label="移除引用" data-action="remove-reference" data-kind="${esc(ref.kind)}" ${ref.kind === 'workspace_file' ? `data-workspace-id="${esc(ref.workspace_id)}" data-path="${esc(ref.path)}"` : `data-id="${esc(ref.id)}"`}>${icon('close',14)}</button></span>`).join('')}</div>` : ''}
    <div class="composer-shell ${hasWorkShell ? 'has-work' : ''} ${drawerOpen ? 'drawer-open' : ''} ${workStateClass}" data-composer-shell aria-live="polite">
      ${drawer}${workBand}
      <form id="message-form" class="composer" data-room-id="${esc(room.id)}">
        <button class="composer-plus" type="button" data-action="attach-file" aria-label="添加附件" ${ui.sendingRooms.has(room.id) ? 'disabled' : ''}>${icon('plus',22)}</button>
        <textarea id="message-input" name="content" rows="1" maxlength="16000" aria-label="消息内容" placeholder="给 ${esc(room.name)} 发消息">${esc(ui.drafts[room.id] || '')}</textarea>
        <div class="composer-tools"><div class="menu-anchor">${members.length ? `<button class="composer-mention ${mentions.length ? 'has-target' : ''}" type="button"
          data-action="toggle-mention-menu" aria-label="@ 成员" aria-expanded="${ui.menu === 'mentions'}">${mentions.length ? esc(mentions.map(id => '@' + nameOf(id)).join(' ')) : '@'}</button>${menu}` : ''}</div>
          <button class="icon-button composer-secret-btn" type="button" data-action="open-secret-input" title="隐私输入" aria-label="隐私输入">${icon('shield',18)}</button>
          <button class="icon-button" type="button" data-action="add-reference" title="添加资料引用" aria-label="添加资料引用">${icon('link',18)}</button></div>
        <button type="submit" class="composer-send" ${sendBusy(room.id) ? 'disabled' : ''} aria-label="发送消息">${icon('send',22)}</button>
      </form>
    </div></div>`;
}

function renderDetailPanel(room, bot) {
  const tab = ui.detailTab;
  const tabs = bot ? [{ id:'details', label:'详情' }] :
    [{ id:'members', label:'成员' }, { id:'library', label:'资料' }, { id:'pins', label:'置顶' }, { id:'details', label:'订阅' }];
  let body;
  if (bot && ui.avatarEditing) body = renderAvatarPicker('edit');
  else if (tab === 'members') {
    body = `<div class="profile-members">${room.members.map(id => {
      const memberBot = botById(id);
      const badge = room.lead_bot_id === id || memberBot?.role_id === 'group-lead' ? '主控'
        : memberBot?.role_id === 'eggbot' ? '孵化' : '';
      return `<button ${id === 'user' ? 'disabled' : 'data-action="open-bot-details"'} data-id="${esc(id)}">${avatar(id,44)}<span>${esc(nameOf(id))}${badge ? ` <em class="member-role-badge">${esc(badge)}</em>` : ''}</span></button>`;
    }).join('')}
      ${isArchivedRoom(room) ? '' : `<button data-action="edit-room" class="add-member">${icon('edit',22)}<span>编辑成员</span></button>`}</div>`;
  } else if (tab === 'library') {
    const space = roomRef(room.id);
    const filesList = (ui.roomFiles && ui.roomFiles.length) ? ui.roomFiles : (room.room_files || []);
    body = `<div class="profile-section-heading"><span>本群共享资料与约定</span><button class="icon-button" data-action="edit-file" data-kind="${space.kind}" data-space="${esc(space.id)}" aria-label="新增资料">${icon('plus',20)}</button></div>
      ${filesList.map(file => {
        const pinned = room.pins.some(ref => sameRef(ref,file.ref));
        return `<div class="pin-row"><button class="profile-record record-button" data-action="open-file" data-id="${esc(file.id)}"><strong>${esc(file.name || file.path)}</strong><small>v${esc(file.revision ?? 1)}</small></button>
          <button class="text-button" data-action="${pinned ? 'unpin' : 'pin'}" data-kind="file" data-id="${esc(file.id)}">${pinned ? '取消置顶' : '置顶'}</button></div>`;
      }).join('') || '<p class="panel-empty">没有资料</p>'}`;
  } else if (tab === 'pins') {
    body = room.pins.map(ref => `<div class="pin-row">${renderReference(ref)}<button class="text-button" data-action="unpin" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">取消置顶</button></div>`).join('') || '<p class="panel-empty">没有置顶</p>';
  } else if (bot) {
    body = `<p class="subtle" style="margin:0 0 10px;font-size:var(--text-caption)">${esc(formatBotModelSummary(bot))}</p><div class="profile-prompt">${esc(bot.instructions || '')}</div>${renderBotFolderSection(bot)}${renderBotMemorySection(bot)}<div class="profile-more-actions">
      <button data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot</button>${renderBotControls(bot)}</div>`;
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
  const archived = isArchivedRoom(room);
  const footer = bot
    ? `<div class="detail-panel-footer"><button type="button" class="secondary-button" data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot</button>${renderBotControls(bot)}</div>`
    : archived
      ? `<div class="detail-panel-footer"><button type="button" class="primary-button" data-action="restore-room" data-id="${esc(room.id)}">移出归档</button><button type="button" class="secondary-button" data-action="copy-conversation">复制文字</button>${room.deletable ? '<button type="button" class="text-button" data-action="delete-group">删除群聊</button>' : ''}</div>`
      : `<div class="detail-panel-footer"><button type="button" class="secondary-button" data-action="edit-room">编辑会话</button><button type="button" class="secondary-button" data-action="copy-conversation">复制文字</button>${room.archivable ? `<button type="button" class="secondary-button" data-action="archive-room" data-id="${esc(room.id)}">归档</button>` : ''}${room.deletable ? '<button type="button" class="text-button" data-action="delete-group">删除群聊</button>' : ''}</div>`;
  return `<aside class="detail-panel" data-section="${esc(tab + ':' + (bot?.id || room.id))}"><div class="detail-panel-inner">
    <div class="detail-panel-toolbar">${toolbarLeft}<button class="round-button" data-action="close-details" aria-label="关闭详情">${icon('close',20)}</button></div>
    <div class="profile-identity">${bot ? `<button class="profile-avatar" data-action="edit-avatar" aria-label="编辑头像" title="点击实时编辑头像">${face(ui.avatarEditing ? ui.avatarDraft : botAvatar(bot),104,{ key:'slot:profile',preview:true,followPointer:true })}</button>` : groupAvatar(room,92)}
      <h2>${esc(bot?.name || room.name)}</h2></div><nav class="profile-tabs" aria-label="详情分类">${tabs.map(item => `<button class="${tab === item.id ? 'active' : ''}" data-action="detail-tab" data-tab="${item.id}">${item.label}</button>`).join('')}</nav>
    <div class="detail-panel-body">${body}</div>${footer}</div></aside>`;
}

const inputActions = { reply:'回答', steer:'追加输入', next:'继续输入' };
const stopLabels = { pending:'打断中', unknown:'结果未知', stopped:'已确认停止', unsupported:'不支持取消' };
const ENGINE_DISPLAY_NAMES = { pi: 'Pi 会话', exec: '本机命令', codex: 'Codex', 'claude-code': 'Claude Code', 'grok-build': 'Grok Build' };
const executionLabel = item => item.kind === 'conversation'
  ? '内部对话'
  : (ENGINE_DISPLAY_NAMES[item.engine] || (state.engines || []).find(e => e.id === item.engine)?.name || item.engine || '执行会话');
const executionTitle = item => [executionLabel(item), item.space?.kind === 'room' ? roomById(item.space.id)?.name : null].filter(Boolean).join(' · ');
const executionError = item => [item.last_error?.exit_code != null ? `退出码 ${item.last_error.exit_code}` : null, item.last_error?.code, item.last_error?.message].filter(Boolean).join(' · ');

function renderExecutionRow(item) {
  const ref = item.execution_ref;
  const status = item.status || 'unknown';
  const error = executionError(item);
  const progress = item.live_progress || item.work_summary || item.pending_requests?.[0]?.question || '';
  const selected = sameRef(ui.executionRef, ref);
  return `<button class="profile-record record-button execution-row ${selected ? 'selected' : ''}" data-action="open-execution" data-kind="${esc(ref.kind)}" data-id="${esc(ref.id)}">
    <strong>${esc(executionTitle(item))}</strong>
    <small>${esc([item.bot_id && nameOf(item.bot_id), labels[status] || status, item.control?.state === 'paused' && '控制已暂停'].filter(Boolean).join(' · '))}</small>
    ${progress ? `<small class="subtle">${esc(progress)}</small>` : ''}
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
  const options = [];
  for (const req of detail.pending_requests || []) {
    options.push({
      kind: 'reply',
      request_id: req.request_id,
      question: req.question,
      choices: req.choices || [],
      key: JSON.stringify([detail.execution_ref, detail.control_version, 'reply', req.request_id]),
    });
  }
  if (detail.can_steer) {
    options.push({ kind: 'steer', key: JSON.stringify([detail.execution_ref, detail.control_version, 'steer']) });
  }
  if (detail.can_continue) {
    options.push({ kind: 'next', key: JSON.stringify([detail.execution_ref, detail.control_version, 'next']) });
  }
  return options;
}

function renderInputOption(option, index) {
  const pending = ui.executionInputs.get(option.key);
  const id = 'execution-input-' + index;
  const question = option.question;
  const choices = option.choices || [];
  return `<form class="execution-input-form" data-input="${esc(option.key)}"><label for="${id}">${inputActions[option.kind]}</label>
    ${option.request_id ? `<small>请求 ${esc(option.request_id)}</small>` : ''}
    ${question ? `<p class="execution-input-question">${esc(question)}</p>` : ''}
    ${choices.length ? `<select name="input" id="${id}" required><option value="">选择回答</option>${choices.map(choice => `<option value="${esc(choice.id)}" ${pending?.text === choice.id ? 'selected' : ''}>${esc(choice.label || choice.id)}</option>`).join('')}</select>`
      : `<textarea id="${id}" name="input" rows="2" required>${esc(pending?.text || '')}</textarea>`}
    ${pending?.receipt?.status ? `<small>回执 · ${esc(labels[pending.receipt.status] || pending.receipt.status)}</small>` : ''}
    <button class="primary-button" type="submit" ${!ui.protocolReady || pending?.busy || pending?.submitted ? 'disabled' : ''}>${pending?.submitted ? '已提交' : inputActions[option.kind]}</button></form>`;
}

function renderExecutionDetail(detail) {
  if (!detail) return '<p class="panel-empty">选择会话查看输入、输出和控制</p>';
  const error = executionError(detail);
  const stop = detail.can_stop;
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
    ${detail.origin_message_id ? `<dt>来源消息</dt><dd>${renderReference({ kind:'event',id:detail.origin_message_id })}</dd>` : ''}
    </dl>${native}</div>
    <div class="execution-actions">${stop ? '<button class="secondary-button" data-action="stop-execution">打断当前运行</button>' : ''}
      ${detail.status === 'suspended' ? `<button class="primary-button" data-action="retry-suspended" data-conversation="${esc(detail.execution_ref?.id || detail.id)}">重试运行</button>` : ''}</div>
    ${ui.stopResults ? `<ul class="execution-stop-results">${ui.stopResults.map(item => `<li>${esc(refLabel(item.target))} · ${esc(stopLabels[item.status || item.control?.stop_status] || item.status || '')}${item.partial_snapshot?.touched_files?.length ? ` · 已触及 ${item.partial_snapshot.touched_files.length} 个文件` : ''}</li>`).join('')}</ul>` : ''}
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
  if (bot.archived_at) {
    return `<button class="secondary-button" data-action="restore-bot" data-id="${esc(bot.id)}">恢复归档</button>
      ${bot.deletable ? `<button class="text-button" data-action="delete-bot" data-id="${esc(bot.id)}">彻底删除</button>` : ''}`;
  }
  return `<button class="secondary-button" data-action="toggle-bot" data-id="${esc(bot.id)}">${bot.enabled ? '暂停 Bot' : '恢复 Bot'}</button>
    ${bot.archivable ? `<button class="text-button" data-action="archive-bot" data-id="${esc(bot.id)}">归档</button>` : ''}
    ${bot.deletable ? `<button class="text-button" data-action="delete-bot" data-id="${esc(bot.id)}">删除</button>` : ''}`;
}

function renderMembers() {
  const bot = botById(ui.botId) || (state.archivedBots || []).find(item => item.id === ui.botId);
  const rows = state.bots.map(item => `<button class="profile-record record-button member-row ${item.id === ui.botId ? 'selected' : ''}" data-action="select-bot" data-id="${esc(item.id)}">
    ${avatar(item.id,40)}<span><strong>${esc(item.name)}</strong><small>${esc(botActivity(item).text)}</small></span></button>`).join('');
  const archived = (state.archivedBots || []).length ? `<details class="models-advanced" style="margin-top:12px"><summary>已归档 Bot（${state.archivedBots.length}）</summary>${state.archivedBots.map(item =>
    `<button class="profile-record record-button member-row ${item.id === ui.botId ? 'selected' : ''}" data-action="select-bot" data-id="${esc(item.id)}">
      ${avatar(item.id,36)}<span><strong>${esc(item.name)}</strong><small>已归档</small></span></button>`).join('')}</details>` : '';
  const roleEntry = bot?.role_id && (state.roles || []).find(r => r.id === bot.role_id);
  const botGroups = bot ? groupRooms().filter(room => room.members.includes(bot.id)) : [];
  const groupsHtml = botGroups.length
    ? `<div class="member-groups-section"><span class="subtle" style="font-size:var(--text-caption)">所在群聊</span><div class="member-groups-list">${botGroups.map(room => `<button type="button" class="member-group-chip" data-action="select-room" data-id="${esc(room.id)}">${groupAvatar(room, 22, '')}<span>${esc(room.name)}</span></button>`).join('')}</div></div>`
    : '';
  const controls = bot ? `<h2>${esc(bot.name)}${bot.archived_at ? '（已归档）' : ''}</h2>
    <p class="subtle" style="margin:6px 0 4px;font-size:var(--text-caption)">修订 r${esc(bot.revision ?? 1)} · 角色：${esc(roleEntry ? `${roleEntry.name} (${roleEntry.id})` : (bot.role_id || '未指定'))}</p>
    <p class="subtle" style="margin:0 0 12px;font-size:var(--text-caption)">${esc(formatBotModelSummary(bot))}</p>
    ${bot.public_duty ? `<p class="subtle" style="margin:0 0 10px;font-size:var(--text-meta);color:var(--ink-2)">${esc(bot.public_duty)}</p>` : ''}
    ${groupsHtml}
    <p class="profile-prompt">${esc(bot.instructions || '')}</p>${renderBotFolderSection(bot)}${renderBotMemorySection(bot)}<div class="execution-actions">
    ${!bot.archived_at ? `<button class="primary-button" data-action="edit-bot" data-id="${esc(bot.id)}">编辑 Bot</button>` : ''}${renderBotControls(bot)}</div>` : '';
  return `<div class="page">${pageHeader('<button class="primary-button" data-action="new-bot">创建 Bot</button>')}
    <div class="object-layout"><section class="object-list">${rows || '<p class="panel-empty">暂无 Bot</p>'}${archived}</section><section class="object-detail">${controls}</section></div></div>`;
}

async function loadFile(id, cursor, revision) {
  const qs = new URLSearchParams();
  if (cursor) qs.set('cursor', cursor);
  if (Number.isSafeInteger(revision) && revision > 0) qs.set('revision', String(revision));
  const query = qs.toString();
  const detail = await api(filePath(id) + (query ? '?' + query : ''));
  if (ui.fileId === id) ui.fileDetail = cursor ? { ...detail, content:(ui.fileDetail.content || '') + (detail.content || '') } : detail;
}

function renderFiles() {
  const item = ui.fileDetail;
  const rows = trackedList('files','/api/files', file => `<button class="profile-record record-button ${file.id === ui.fileId ? 'selected' : ''}" data-action="open-file" data-id="${esc(file.id)}">
    <strong>${esc(file.name || file.path)}</strong><small>${file.deleted_room ? '已删群归档 · ' : ''}${esc(file.space ? refLabel(file.space) : '')} · 修订 v${esc(file.revision)}</small></button>`);
  const baseDownload = item ? filePath(item.id) + '/download' : '';
  const rawLink = typeof item?.url === 'string' && (item.url === baseDownload || item.url.startsWith(baseDownload + '?revision=')) ? item.url : '';
  const link = rawLink ? (window.SummonHub?.apiPath?.(rawLink) || rawLink) : attachmentUrl(item);
  const latestRev = item?.latest_revision ?? item?.revision;
  const isHistorical = item && latestRev && item.revision !== latestRev;
  const revHistory = Array.isArray(item?.revisions) && item.revisions.length > 1
    ? `<div class="reference-list" style="margin:8px 0;align-items:center"><small class="subtle">版本历史：</small>${item.revisions.map(rev =>
        `<button type="button" class="${rev.revision === item.revision ? 'primary-button' : 'secondary-button'}" style="padding:3px 10px;font-size:12px" data-action="open-file-revision" data-id="${esc(item.id)}" data-revision="${esc(rev.revision)}">v${esc(rev.revision)}${rev.revision === latestRev ? ' (当前正式版)' : ''}</button>`).join('')}</div>`
    : '';
  const scopeDesc = item?.space
    ? (item.space.kind === 'bot' ? `私有记忆/资料（仅 ${nameOf(item.space.id)} 与宿主可读）` : item.space.kind === 'room' ? `群共享资料（${refLabel(item.space)}）` : refLabel(item.space))
    : '';
  const detail = item ? `<h2>${esc(item.path || item.name)}</h2>
    <p class="subtle">当前查看修订 v${esc(item.revision)}${isHistorical ? `（历史快照 · 最新正式版为 v${esc(latestRev)}）` : '（当前正式版）'}${scopeDesc ? ` · 适用范围：${esc(scopeDesc)}` : ''}</p>
    ${revHistory}
    <div class="execution-actions">
    ${link ? `<a href="${esc(link)}" download>下载</a>` : ''}${!isHistorical && item.path && typeof item.content === 'string' && !item.next_cursor ? `<button class="secondary-button" data-action="edit-file" data-id="${esc(item.id)}">编辑</button>` : ''}</div>
    ${typeof item.content === 'string' ? `<pre class="execution-output">${esc(item.content)}</pre>` :
      item.content_status === 'unavailable' ? '<p>文件内容不可用</p>' : ''}
    ${item.next_cursor ? '<button class="text-button" data-action="more-file">读取后续内容</button>' : ''}
    ${item.sources?.length ? `<div style="margin-top:10px"><small class="subtle">修订来源凭据：</small><div class="reference-list">${item.sources.map(ref => renderReference(ref)).join('')}</div></div>` : ''}` : '<p class="panel-empty">选择文件查看内容</p>';
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

function formatPreciseTime(value) {
  if (!value) return '—';
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(time);
}

function describeWakeupRun(run) {
  const outcomeLabels = {
    pending: '待处理',
    sent_message: '已发群报',
    opened_session: '已开任务',
    quiet_no_action: '静默无动作',
    failed: '处理失败',
  };
  const label = outcomeLabels[run.outcome] || run.outcome;
  const parts = [];
  if (run.scheduled_at) parts.push(`触发 ${formatPreciseTime(run.scheduled_at)}`);
  if (run.enqueued_at) parts.push(`入队 ${formatPreciseTime(run.enqueued_at)}`);
  parts.push(`消费 ${run.consumed_at ? formatPreciseTime(run.consumed_at) : '待消费'}`);
  parts.push(`结果 ${label}${run.misfired ? '（迟到补发）' : ''}${run.error ? ' · ' + run.error : ''}`);
  return parts.join(' · ');
}

function renderWakeupRow(item) {
  const latestRun = Array.isArray(item.recent_runs) && item.recent_runs[0];
  return `<div class="wakeup-row"><div class="wakeup-copy"><strong>${esc(nameOf(item.bot_id))}</strong><span>${esc(describeWakeup(item.rule))}</span>
    ${item.rule.room && ui.view !== 'chat' ? `<small>${esc(roomById(item.rule.room)?.name || item.rule.room)}</small>` : ''}
    ${item.archived ? '<small>单次已归档</small>' : ''}
    ${item.disabled_reason === 'scope_unavailable' ? '<small>范围失权已自动停用</small>' : ''}
    ${item.skipped_count ? `<small>停机跳过 ${esc(item.skipped_count)} 次</small>` : ''}
    ${latestRun ? `<small class="wakeup-run">最近回执：${esc(describeWakeupRun(latestRun))}</small>` : ''}
    ${botById(item.bot_id)?.enabled === false ? '<small>Bot 已暂停</small>' : ''}</div>
    ${item.archived ? '' : `<button class="text-button" data-action="edit-wakeup" data-id="${esc(item.id)}">编辑</button>
    <button class="text-button" data-action="toggle-wakeup" data-id="${esc(item.id)}">${item.enabled ? '停用' : '启用'}</button>`}
    ${item.rule.kind !== 'room_base' ? `<button class="text-button" data-action="delete-wakeup" data-id="${esc(item.id)}">删除</button>` : ''}</div>`;
}

function renderWakeups() {
  const custom = state.wakeups.filter(item => item.rule.kind !== 'room_base');
  const basic = state.wakeups.filter(item => item.rule.kind === 'room_base');
  return `<div class="page">${pageHeader('<button class="primary-button" data-action="add-wakeup">新增订阅</button>')}
    <div class="object-layout"><section class="object-list"><h2>基础关注</h2>${basic.map(renderWakeupRow).join('') || '<p class="panel-empty">暂无基础关注</p>'}</section>
    <section class="object-detail"><h2>自定义订阅与提醒</h2>${custom.map(renderWakeupRow).join('') || '<p class="panel-empty">暂无自定义订阅与提醒</p>'}
    ${ui.listPages?.wakeups?.next_cursor ? '<button class="text-button" data-action="more-list" data-kind="wakeups" data-endpoint="/api/wakeups">加载更多</button>' : ''}</section></div></div>`;
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
  const modal = $('#modal'); captureMotion($('#modal-content')); modal.classList.remove('settings-modal'); modal.classList.add('create-bot-modal');
  $('#modal-content').innerHTML = `<div class="modal-header"><h2>创建新 Bot</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 24)}</button></div><form id="modal-form" class="create-bot-form"><div class="create-bot-body"><button type="button" id="create-avatar-preview" class="create-avatar-preview" data-action="avatar-greet" aria-label="和 Bot 打招呼">${face(ui.avatarDraft, 144, { key: 'slot:create-preview', identity: 'create-preview', preview: true, intro: true, followPointer: true })}</button><input id="create-bot-name" name="name" placeholder="给你的 Bot 起个名字" aria-label="Bot 名字" required maxlength="100" autocomplete="off"><div class="create-picker-scroll"><div id="create-avatar-picker">${renderAvatarPicker('create')}</div><div class="form-error" role="alert"></div></div></div><div class="modal-footer"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button id="create-bot-submit" class="primary-button" type="submit" disabled>创建</button></div></form>`;
  $('#modal-form').onsubmit = async event => {
    event.preventDefault(); const form = event.target, button = $('#create-bot-submit', form), name = $('#create-bot-name', form).value.trim(), avatar = { ...ui.avatarDraft }; if (!name) return;
    button.disabled = true; $('.form-error', event.target).textContent = '';
    try { const bot = await api('/api/bots', 'POST', { name, instructions:'', avatar }); const ownsDialog = modal.open && $('#modal-form') === form; if (ownsDialog) await closeModal(modal); const stillOwns = $('#modal-form') === form; if (ownsDialog && stillOwns) ui.avatarDraft = null; ui.botId = bot.id; await refresh(); toast(`${bot.name} 已创建`); }
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
  if (event.target.dataset.action === 'upload-owner-avatar') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const source = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('无法读取图片。')); reader.readAsDataURL(file); });
      const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('无法打开这张图片。')); image.src = source; });
      const canvas = document.createElement('canvas'), side = Math.min(160, Math.max(img.width, img.height));
      const ratio = side / Math.max(img.width, img.height);
      canvas.width = Math.max(1, Math.round(img.width * ratio)); canvas.height = Math.max(1, Math.round(img.height * ratio));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      if (dataUrl.length > 260000) throw new Error('图片过大，请选择较小的图片。');
      saveLocalProfile({ avatar: dataUrl, localAccepted: true });
      ui.lastSidebarHtml = null;
      refreshOpenSettingsBody();
      render();
      toast('头像已更新');
    } catch (error) { toast(error.message, true); }
    return;
  }
  if (event.target.dataset.hubSelect === 'active-node') {
    const nextId = event.target.value;
    if (nextId && window.SummonHub) await window.SummonHub.switchNode(nextId);
    return;
  }
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
window.addEventListener('resize', () => { markWindowResizing(); queueViewportSync(); syncBotActivityDock(); }, { passive: true });
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

const initialView = location.hash.slice(1);
if (tabs.some(tab => tab.id === initialView)) ui.view = initialView;
applyDisplayPreferences();
renderTopbar();
(async () => {
  if (window.SummonHub) {
    const initResult = await window.SummonHub.init({
      toast,
      onNodesUpdated: () => {
        ui.lastSidebarHtml = null;
        closeFloatingMenus();
        renderTopbar();
        refreshOpenSettingsBody();
        if (!window.SummonHub.onlineNodes().length) render();
      },
      onActiveNodeChanged: nextNodeId => {
        ui.stateSnapshot = null;
        ui.stateCursor = null;
        ui.messagesRoomId = null;
        ui.messages = [];
        ui.historyCursor = null;
        ui.draftWorkspaceId = '';
        if (nextNodeId) {
          const snap = window.SummonHub.state.nodeSnapshots.get(nextNodeId);
          if (snap) {
            state.rooms = snap.rooms || [];
            state.archivedRooms = snap.archivedRooms || [];
            state.bots = snap.bots || [];
          }
          void refresh(true);
        } else {
          render();
        }
      },
      onActiveNodeEvent: () => scheduleRefresh(),
      onStreamState: connected => {
        ui.streamConnected = connected;
        renderTopbar();
        if (connected) scheduleRefresh();
      },
      onAuthSuccess: () => {
        ui.stateSnapshot = null;
        ui.stateCursor = null;
        ui.lastSidebarHtml = null;
        refreshOpenSettingsBody();
        void refresh(true);
      },
      onChooseLocal: () => {
        saveLocalProfile({ localAccepted: true });
        ui.lastSidebarHtml = null;
        renderTopbar();
        toast('已切换为本地账户，随时可点左下角头像登录云端');
      },
    });
    if (initResult?.requiresAuth) {
      ui.loading = false;
      render();
      return;
    }
  }
  window.SummonSecretInput?.configure?.({
    api,
    toast,
    onAfterChange: () => void refresh(),
  });
  window.SummonOnboarding?.bind?.({
    api,
    toast,
    refresh,
    onRender: render,
    onEnterNewGroup: async ({ preview = false } = {}) => {
      if (preview) return;
      await refresh(true);
      await openNewGroupDraft();
    },
  });
  window.SummonDesktop?.onPreviewOnboarding?.(() => {
    window.SummonOnboarding?.startPreview?.();
  });
  if (window.SummonDesktop?.isOnboardingWindow) {
    window.SummonOnboarding?.preopen?.(window.SummonDesktop.initialOnboardingStage || 'model');
  }
  await restoreCachedState();
  await refresh();
  if (new URLSearchParams(location.search).get('onboarding') === 'preview') {
    window.SummonOnboarding?.startPreview?.();
  }
})();
setInterval(() => { if (!ui.streamConnected && navigator.onLine && !document.hidden) scheduleRefresh(); }, 3000);
window.addEventListener('offline', () => { setProtocol(false, '当前离线。草稿和待确认的发送已保留。'); persistClientSession(); });
window.addEventListener('online', scheduleRefresh);
let desktopWindowActive = true;
function syncWindowActivity() {
  const active = desktopWindowActive && !document.hidden && (typeof document.hasFocus === 'function' ? document.hasFocus() : true);
  document.documentElement.classList.toggle('summon-inactive', !active);
  window.SummonAvatars?.setActive?.(!document.hidden);
}
window.addEventListener('blur', syncWindowActivity);
window.addEventListener('focus', syncWindowActivity);
document.addEventListener('visibilitychange', syncWindowActivity);
window.SummonDesktop?.onWindowActive?.(active => { desktopWindowActive = Boolean(active); syncWindowActivity(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleRefresh(); else persistClientSession(); });
