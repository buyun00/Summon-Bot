(() => {
  'use strict';
  const platformNames = { windows: 'Windows', macos: 'macOS', android: 'Android' };
  let catalog = null, desktop = null, desktopUpdate = null, failure = '', requestId = 0;
  function syncWindowChrome() {
    const root = document.documentElement;
    if (!desktop?.windowControlsOverlay) return;
    root.classList.add('desktop-overlay');
    root.dataset.desktopPlatform = desktop.platform;
    const overlay = navigator.windowControlsOverlay;
    const area = overlay?.getTitlebarAreaRect();
    const left = area?.width > 0 ? area.x : desktop.platform === 'darwin' ? 80 : 0;
    const right = area?.width > 0 ? Math.max(0, innerWidth - area.right) : desktop.platform === 'win32' ? 150 : 0;
    root.style.setProperty('--window-controls-left', `${overlay && !overlay.visible ? 0 : left}px`);
    root.style.setProperty('--window-controls-right', `${overlay && !overlay.visible ? 0 : right}px`);
  }
  function setDesktopInfo(value) {
    if (value.selectionWarning && value.selectionWarning !== desktop?.selectionWarning) {
      document.dispatchEvent(new CustomEvent('summon-selection-warning', { detail:value.selectionWarning }));
    }
    desktop = value; desktopUpdate = value.update; syncWindowChrome();
    document.documentElement.dataset.localInstance = String(value.localInstance === true);
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const size = bytes => bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : '';
  function statusText() {
    const current = desktopUpdate || desktop?.update;
    if (!current) return '正在读取桌面版本…';
    if (current.status === 'checking') return '正在检查更新…';
    if (current.status === 'downloading') return `正在下载 ${current.version || ''} · ${current.percent || 0}%`;
    if (current.status === 'downloaded') return `${current.version} 已下载，重启即可更新。`;
    if (current.status === 'manual') return `发现 ${current.version}，下载后覆盖安装。`;
    if (current.status === 'unpublished') return '此平台尚未发布新版。';
    if (current.status === 'current') return '已是最新版本。';
    if (current.status === 'error') return '暂时无法检查更新，请稍后重试。';
    return '可检查并下载最新桌面版本。';
  }
  function render() {
    const content = document.querySelector('#client-release-content');
    if (!content) return;
    const releases = catalog?.releases || [];
    const installable = ['downloaded', 'manual'].includes(desktopUpdate?.status);
    content.innerHTML = `${desktop ? `<section class="client-update-card"><div><strong>当前桌面客户端 ${escape(desktop.version)}</strong><p role="status">${escape(statusText())}</p></div><div class="client-update-actions"><button type="button" class="primary-button small-button" data-client-action="${installable ? 'install' : 'check'}" ${['checking', 'downloading'].includes(desktopUpdate?.status) ? 'disabled' : ''}>${desktopUpdate?.status === 'manual' ? '下载更新' : desktopUpdate?.status === 'downloaded' ? '重启并更新' : '检查更新'}</button>${installable ? '<button type="button" class="secondary-button small-button" data-client-action="check">重新检查</button>' : ''}</div></section>` : ''}
      ${failure ? `<div class="client-release-error"><p class="form-error" role="alert">${escape(failure)}</p><button type="button" class="secondary-button small-button" data-client-action="reload">重新获取</button></div>` : ''}
      ${!catalog && !failure ? '<p class="client-release-loading" role="status">正在获取客户端版本…</p>' : ''}
      <div class="client-release-list">${['windows', 'macos', 'android'].map(platform => {
        const records = releases.filter(item => item.platform === platform);
        return `<section class="client-release-row"><div class="client-release-heading"><strong>${platformNames[platform]}</strong><small>${platform === 'android' ? '原生应用 · APK' : '桌面客户端'}</small></div><div class="client-release-actions">${records.length ? records.map(item => {
          const main = item.files.find(file => item.downloadUrl === file.url);
          const url = downloadUrl(item);
          return `<div><span>${escape(item.version)}${platform !== 'android' ? ` · ${escape(platform === 'macos' ? 'Apple Silicon' : item.arch)}` : ''}${main ? ` · ${size(main.size)}` : ''}</span>${url ? `<a class="secondary-button small-button" href="${escape(url)}" download>下载${platform === 'android' ? ' APK' : ''}</a>` : ''}</div>`;
        }).join('') : '<span class="subtle">尚未发布</span>'}</div></section>`;
      }).join('')}<section class="client-release-row"><div class="client-release-heading"><strong>iOS</strong><small>SwiftUI 原生 · org.lin0.summon</small></div><span class="subtle">TestFlight 内部测试</span></section></div>`;
  }
  function downloadUrl(item) {
    try {
      const url = new URL(item.downloadUrl, location.origin);
      const local = url.origin === 'http://127.0.0.1:8787' && url.pathname.startsWith('/api/releases/');
      const github = url.origin === 'https://github.com' && url.pathname.startsWith(`/${catalog.githubRepository}/releases/download/`);
      return local || github ? url.href : '';
    } catch { return ''; }
  }
  async function localReleases() {
    try {
      const response = await fetch('http://127.0.0.1:8787/api/releases?local=1', { cache: 'no-store', signal: AbortSignal.timeout(1200) });
      if (!response.ok) return [];
      const value = await response.json();
      return value.releases.map(item => ({ ...item, downloadUrl: new URL(item.downloadUrl, response.url).href,
        files: item.files.map(file => ({ ...file, url: new URL(file.url, response.url).href })) }));
    } catch { return []; }
  }
  let releaseEndpoint = '/api/releases';
  async function load() {
    const id = ++requestId;
    failure = ''; render();
    const local = await localReleases();
    try {
      const endpoint = new URL(releaseEndpoint, location.origin);
      if (endpoint.origin !== location.origin || endpoint.pathname !== '/api/releases') throw new Error('发行目录地址无效');
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (!response.ok) throw new Error('下载信息暂时不可用，请稍后重试。');
      const value = await response.json();
      if (id !== requestId) return;
      catalog = { ...value, releases: [...local, ...value.releases.filter(item => !local.some(record => record.platform === item.platform && record.arch === item.arch))] };
      failure = [value.localError, value.githubError].filter(Boolean).join(' · ');
    } catch (error) {
      if (id === requestId) { catalog = { releases: local }; failure = error.message; }
    }
    if (id === requestId) render();
  }
  async function check() {
    try { desktopUpdate = await window.SummonDesktop.checkForUpdates(); }
    catch { desktopUpdate = { status: 'error' }; }
    render();
  }
  async function install() {
    await persistClientSession();
    try { if (!await window.SummonDesktop.installUpdate()) toast('请先完成更新包下载。'); }
    catch { toast('更新未能启动，请稍后重试。', true); }
  }
  async function mount(releasesUrl = '/api/releases') {
    releaseEndpoint = releasesUrl;
    render();
    load();
    if (window.SummonDesktop) {
      try { setDesktopInfo(await window.SummonDesktop.getInfo()); render(); await check(); }
      catch { failure = '无法读取桌面更新状态，请重新打开客户端。'; render(); }
    }
  }
  async function open(releasesUrl = '/api/releases') {
    if (window.SummonOpenSettings) return window.SummonOpenSettings('updates', releasesUrl);
    return mount(releasesUrl);
  }
  window.SummonClients = Object.freeze({ open, mount });
  document.addEventListener('click', event => {
    const action = event.target.closest('[data-client-action]')?.dataset.clientAction;
    if (action === 'reload') load();
    if (action === 'check') check();
    if (action === 'install') install();
  });
  if (window.SummonDesktop) {
    window.SummonDesktop.getInfo().then(value => { setDesktopInfo(value); render(); }).catch(() => {});
    window.addEventListener('resize', syncWindowChrome);
    navigator.windowControlsOverlay?.addEventListener('geometrychange', syncWindowChrome);
    window.SummonDesktop.onUpdate(value => { desktopUpdate = value; render(); });
    window.SummonDesktop.onOpenUpdates(open);
    window.SummonDesktop.onInstallRequested(install);
  }
  // Remove the former offline shell without deleting chat records or drafts.
  if ('serviceWorker' in navigator) navigator.serviceWorker.getRegistrations().then(registrations => Promise.all(registrations.map(registration => {
    const worker = registration.active || registration.waiting || registration.installing;
    return worker && new URL(worker.scriptURL).pathname === '/sw.js' ? registration.unregister() : undefined;
  }))).catch(() => {});
  if ('caches' in window) caches.keys().then(names => Promise.all(names.filter(name => name.startsWith('relay-shell-')).map(name => caches.delete(name)))).catch(() => {});
})();
