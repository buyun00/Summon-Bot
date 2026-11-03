(() => {
  'use strict';
  const platformNames = { windows: 'Windows', macos: 'macOS', android: 'Android' };
  let catalog = null, desktop = null, desktopUpdate = null, failure = '', requestId = 0;
  function syncWindowChrome() {
    const root = document.documentElement;
    if (!desktop?.windowControlsOverlay) return;
    root.classList.add('desktop-overlay');
    const overlay = navigator.windowControlsOverlay;
    const area = overlay?.getTitlebarAreaRect();
    const left = area?.width > 0 ? area.x : desktop.platform === 'darwin' ? 80 : 0;
    const right = area?.width > 0 ? Math.max(0, innerWidth - area.right) : desktop.platform === 'win32' ? 150 : 0;
    root.style.setProperty('--window-controls-left', `${overlay && !overlay.visible ? 0 : left}px`);
    root.style.setProperty('--window-controls-right', `${overlay && !overlay.visible ? 0 : right}px`);
  }
  function setDesktopInfo(value) { desktop = value; desktopUpdate = value.update; syncWindowChrome(); }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const size = bytes => bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '';
  function statusText() {
    const current = desktopUpdate || desktop?.update;
    if (!current) return '正在读取桌面版本…';
    if (current.status === 'checking') return '正在检查更新…';
    if (current.status === 'downloading') return `正在下载 ${current.version || ''} · ${current.percent || 0}%`;
    if (current.status === 'downloaded') return `${current.version} 已下载，重启即可更新。`;
    if (current.status === 'current') return '已是最新版本。';
    if (current.status === 'error') return '暂时无法检查更新，请稍后重试。';
    return '可检查并下载最新桌面版本。';
  }
  function render() {
    const content = document.querySelector('#client-release-content');
    if (!content) return;
    const releases = catalog?.releases || [];
    content.innerHTML = `${desktop ? `<section class="client-update-card"><div><strong>当前桌面客户端 ${escape(desktop.version)}</strong><p role="status">${escape(statusText())}</p></div><button type="button" class="primary-button" data-client-action="${desktopUpdate?.status === 'downloaded' ? 'install' : 'check'}" ${['checking', 'downloading'].includes(desktopUpdate?.status) ? 'disabled' : ''}>${desktopUpdate?.status === 'downloaded' ? '重启并更新' : '检查更新'}</button></section>` : ''}
      <p class="client-web-version">网页${catalog?.web?.version ? ` ${escape(catalog.web.version)}` : ''} · 部署后刷新即可更新</p>
      ${failure ? `<p class="form-error" role="alert">${escape(failure)}</p><button class="secondary-button" data-client-action="reload">重新获取</button>` : ''}
      ${!catalog && !failure ? '<p role="status">正在获取客户端版本…</p>' : ''}
      <div class="client-release-list">${['windows', 'macos', 'android'].map(platform => {
        const records = releases.filter(item => item.platform === platform);
        return `<section class="client-release-row"><div class="client-release-heading"><strong>${platformNames[platform]}</strong><small>${platform === 'android' ? '原生应用 · APK' : '桌面客户端'}</small></div><div class="client-release-actions">${records.length ? records.map(item => {
          const main = item.files.find(file => item.downloadUrl === file.url);
          const url = typeof item.downloadUrl === 'string' && item.downloadUrl.startsWith('/api/releases/') ? item.downloadUrl : '';
          return `<div><span>${escape(item.version)}${platform !== 'android' ? ` · ${escape(item.arch)}` : ''}${main ? ` · ${size(main.size)}` : ''}</span>${url ? `<a class="secondary-button" href="${escape(url)}" download>下载${platform === 'android' ? ' APK' : ''}</a>` : ''}</div>`;
        }).join('') : '<span class="subtle">尚未发布</span>'}</div></section>`;
      }).join('')}<section class="client-release-row"><div class="client-release-heading"><strong>iOS</strong><small>原生应用</small></div><span class="subtle">由 Mac 打包安装</span></section></div>`;
  }
  async function load() {
    const id = ++requestId;
    failure = ''; render();
    try {
      const response = await fetch('/api/releases', { cache: 'no-store' });
      if (!response.ok) throw new Error('下载信息暂时不可用，请稍后重试。');
      const value = await response.json();
      if (id !== requestId) return;
      catalog = value;
    } catch (error) { if (id === requestId) failure = error.message; }
    if (id === requestId) render();
  }
  async function check() {
    try { desktopUpdate = await window.RelayDesktop.checkForUpdates(); }
    catch { desktopUpdate = { status: 'error' }; }
    render();
  }
  async function install() {
    if (!preserveUpdateDrafts(true)) return;
    try { if (!await window.RelayDesktop.installUpdate()) toast('请先完成更新包下载。'); }
    catch { toast('更新未能启动，请稍后重试。', true); }
  }
  async function open() {
    ui.menu = null; renderTopbar();
    const modal = document.querySelector('#modal');
    modal.classList.remove('create-bot-modal');
    document.querySelector('#modal-content').innerHTML = `<div class="modal-header"><div><h2>客户端下载与更新</h2><p>选择设备，下载最新客户端。</p></div><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close', 17)}</button></div><div class="client-release-content" id="client-release-content"></div>`;
    render(); showModal(modal); load();
    if (window.RelayDesktop) {
      try { setDesktopInfo(await window.RelayDesktop.getInfo()); render(); await check(); }
      catch { failure = '无法读取桌面更新状态，请重新打开客户端。'; render(); }
    }
  }
  window.RelayClients = Object.freeze({ open });
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-client-action]')?.dataset.clientAction;
    if (action === 'reload') load();
    if (action === 'check') check();
    if (action === 'install') install();
  });
  if (window.RelayDesktop) {
    window.RelayDesktop.getInfo().then(value => { setDesktopInfo(value); render(); }).catch(() => {});
    window.addEventListener('resize', syncWindowChrome);
    navigator.windowControlsOverlay?.addEventListener('geometrychange', syncWindowChrome);
    window.RelayDesktop.onUpdate(value => { desktopUpdate = value; render(); });
    window.RelayDesktop.onOpenUpdates(open);
    window.RelayDesktop.onInstallRequested(install);
  }
  // Remove the former offline shell without deleting chat records or drafts.
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(registrations => Promise.all(registrations.map(registration => {
    const worker = registration.active || registration.waiting || registration.installing;
    return worker && new URL(worker.scriptURL).pathname === '/sw.js' ? registration.unregister() : undefined;
  }))).catch(() => {});
  if ('caches' in window) caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('relay-shell-')).map(name => caches.delete(name)))).catch(() => {});
})();
