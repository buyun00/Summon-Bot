const { app, BrowserWindow, ipcMain, Menu, shell, protocol, nativeTheme } = require('electron');
const { join } = require('node:path');
const { readFile } = require('node:fs/promises');
const { autoUpdater } = require('electron-updater');
const release = require('./release.json');
const { runtime, setupUrl, desktopSettings, localAccess, prepareConnection, authorizationUrl } = require('./connection.cjs');
// Keep the existing profile directory while changing the product's visible name.
app.setPath('userData', join(app.getPath('appData'), 'Relay'));
app.setName('Summon Bot');
protocol.registerSchemesAsPrivileged([{ scheme: 'summon-setup', privileges: { standard: true, secure: true } }]);
const profile = app.getPath('userData');
const localUpdateFeed = new URL(release.updatePath, 'http://127.0.0.1:8787').href;
const [releasePlatform, releaseArch] = release.updatePath.split('/').filter(Boolean).slice(-2);
const remoteUpdateFeed = `https://github.com/${release.githubRepository}/releases/download/client-${releasePlatform}-${releaseArch}/`;
let window, timer, checking;
let connection = null, setup = { section: 'instances', error: '' }, selectionWarning = '';
const connectionOperations = new Set();
let update = { status: 'idle', currentVersion: app.getVersion() };

function setUpdate(value) {
  update = { ...update, ...value };
  if (window && !window.isDestroyed()) window.webContents.send('summon:update-state', update);
}
const webOrigin = url => { try { return new URL(url).origin; } catch { return null; } };
const isWeb = url => connection?.origin && webOrigin(url) === connection.origin;
function trusted(event, local = false) {
  if (!window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame
    || !(local ? event.senderFrame.url === setupUrl : isWeb(event.senderFrame.url) && new URL(event.senderFrame.url).pathname === '/')) {
    throw new Error('Untrusted desktop request');
  }
}

function showSetup(section = 'instances', error = '') {
  setup = { section, error };
  if (!window || window.isDestroyed()) return;
  if (window.webContents.getURL() === setupUrl) window.webContents.send('summon:connection-setup-state');
  else window.loadURL(setupUrl).catch(() => {});
}

async function showConnection(target, selection) {
  if (target !== window || target.isDestroyed()) return;
  const url = new URL('/', selection.origin);
  const previousSetup = setup;
  await target.loadURL(url.href).catch(() => {
    if (target === window && !target.isDestroyed() && setup === previousSetup) {
      showSetup('retry', '暂时无法打开实例。');
    }
  });
}

async function continueConnection(target) {
  const selection = connection;
  if (!selection) return showSetup();
  const previousSetup = setup;
  await prepareConnection(target.webContents.session, selection);
  if (target !== window || setup !== previousSetup) return;
  await showConnection(target, selection);
}

function connectionError(error, selection) {
  const section = selection?.mode === 'remote' && error.code === 'INSTANCE_LOGIN_REQUIRED' ? 'remote' : selection ? 'retry' : 'instances';
  showSetup(section, error.message);
}

async function restoreConnection(target) {
  const previousSetup = setup;
  try {
    const { readDesktopConnection, formalOrigin, saveDesktopConnection } = await desktopSettings();
    let selection = await readDesktopConnection(profile);
    if (target !== window || setup !== previousSetup) return;
    // All-in-one desktop always boots with its local backend directly (no cloud roundtrip for self).
    if (!selection || selection.mode !== 'local') {
      selection = { mode: 'local', origin: formalOrigin };
      await saveDesktopConnection(profile, selection).catch(() => {});
    }
    connection = selection;
    showSetup('retry', '正在启动本机 Summon Bot 服务…');
    const connecting = setup;
    try { await continueConnection(target); }
    catch (error) { if (target === window && setup === connecting) connectionError(error, selection); }
  } catch (error) {
    if (target === window && setup === previousSetup) connectionError(error, connection);
  }
}

async function rememberConnection(target, selection) {
  const { saveDesktopConnection } = await desktopSettings();
  selectionWarning = '';
  try { await saveDesktopConnection(profile, selection); }
  catch (error) {
    selectionWarning = '已打开实例，无法保存本次选择。';
    console.warn(selectionWarning, error.code || error.message);
  }
  if (target !== window) return;
  connection = selection;
  await showConnection(target, selection);
}

function installSetupProtocol() {
  const assets = new Map([
    ['/index.html', [join(__dirname, 'setup.html'), 'text/html']],
    ['/setup.js', [join(__dirname, 'setup.js'), 'text/javascript']],
    ['/setup.css', [join(__dirname, 'setup.css'), 'text/css']],
    ['/icon.png', [join(runtime, 'web/frontend/icons/icon-192.png'), 'image/png']],
  ]);
  protocol.handle('summon-setup', async request => {
    const url = new URL(request.url), asset = url.host === 'connection' && assets.get(url.pathname);
    if (!asset || request.method !== 'GET') return new Response(null, { status: 404 });
    return new Response(await readFile(asset[0]), { headers: {
      'Content-Type': asset[1], 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    } });
  });
}
async function checkForUpdates({ force = false } = {}) {
  if (checking || update.status === 'downloading' || !force && update.status === 'downloaded') return update;
  if (!app.isPackaged) return update;
  checking = true;
  setUpdate({ status: 'checking', message: '', percent: 0 });
  try {
    if (release.updateMode === 'manual') {
      for (const feed of [localUpdateFeed, remoteUpdateFeed]) {
        try {
          const response = await fetch(new URL('latest.json', feed), { cache: 'no-store', signal: AbortSignal.timeout(feed === localUpdateFeed ? 1200 : 15000) });
          if (response.status === 404 && feed === remoteUpdateFeed) { setUpdate({ status: 'unpublished' }); return update; }
          if (!response.ok) throw new Error(`Update unavailable (HTTP ${response.status})`);
          const latest = await response.json();
          const downloadUrl = new URL(latest.downloadUrl, feed).href;
          if (!downloadUrl.startsWith(feed)) throw new Error('Invalid client download URL');
          setUpdate({ status: latest.buildNumber > release.buildNumber ? 'manual' : 'current', version: latest.version, downloadUrl });
          return update;
        } catch (error) { if (feed === remoteUpdateFeed) throw error; }
      }
    }
    for (const feed of [localUpdateFeed, remoteUpdateFeed]) {
      try {
        if (feed === localUpdateFeed) {
          // A short probe avoids the updater's connection retries on other PCs.
          const channel = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
          const response = await fetch(new URL(channel, feed), {
            method: 'HEAD', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(1200),
          });
          if (!response.ok) throw new Error(`Local update unavailable (HTTP ${response.status})`);
        }
        autoUpdater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
        const result = await autoUpdater.checkForUpdates();
        // Await the download too, so a missing local package also falls back.
        if (result?.isUpdateAvailable) await autoUpdater.downloadUpdate(result.cancellationToken);
        return update;
      } catch (error) {
        if (feed === remoteUpdateFeed) throw error;
        setUpdate({ status: 'checking', message: '', percent: 0 });
      }
    }
  }
  catch (error) { setUpdate({ status: 'error', message: error.message }); }
  finally { checking = false; }
  return update;
}
function requestInstall() {
  if (!window) return;
  if (update.status === 'manual') return openUpdateDownload();
  if (update.status !== 'downloaded') return;
  if (window.webContents.getURL() === setupUrl) autoUpdater.quitAndInstall(false, true);
  else window.webContents.send('summon:request-install');
}
function openUpdateDownload() {
  if (update.status !== 'manual' || ![localUpdateFeed, remoteUpdateFeed].some(feed => update.downloadUrl?.startsWith(feed))) return false;
  void shell.openExternal(update.downloadUrl).catch(() => {});
  return true;
}
function applyWindowTheme(target, dark) {
  if (!target || target.isDestroyed()) return;
  target.setBackgroundColor(dark ? '#0b0c10' : '#f8f6f1');
  if (typeof target.setTitleBarOverlay === 'function') {
    try { target.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#e6eaf4' : '#3a3832', height: 44 }); } catch {}
  }
}
function createWindow() {
  const initialDark = nativeTheme.shouldUseDarkColors;
  const target = window = new BrowserWindow({
    title: 'Summon Bot', width: 1280, height: 900, minWidth: 440, minHeight: 560,
    backgroundColor: initialDark ? '#0b0c10' : '#f8f6f1', autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: initialDark ? '#e6eaf4' : '#3a3832', height: 44 },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  target.on('closed', () => { if (target === window) window = null; });
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      if (connection?.origin && webOrigin(url) === connection.origin) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 1120,
            height: 800,
            minWidth: 420,
            minHeight: 420,
            autoHideMenuBar: process.platform !== 'darwin',
            backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0c10' : '#f8f6f1',
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
              session: target.webContents.session,
            },
          },
        };
      }
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  target.webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame ? !isWeb(event.url) : webOrigin(event.url) !== connection?.origin) event.preventDefault();
  });
  target.webContents.on('will-redirect', event => { if (!isWeb(event.url)) event.preventDefault(); });
  target.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  target.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (target !== window || !isMainFrame || code === -3 || !isWeb(url)) return;
    showSetup('retry', '暂时无法连接实例。');
  });
  target.webContents.on('did-navigate', (_event, url, status) => {
    if (target !== window || !isWeb(url) || new URL(url).pathname !== '/' || status < 400) return;
    if (status === 401 && connection.mode === 'remote') showSetup('remote', '实例登录已失效，请重新连接该实例。');
    else showSetup('retry', status === 503 ? '实例当前无法响应（HTTP 503）。' : '实例页面暂不可用（HTTP ' + status + '）。');
  });
  showSetup();
  void restoreConnection(target);
}
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.disableDifferentialDownload = true;
autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking', message: '' }));
autoUpdater.on('update-available', info => setUpdate({ status: 'downloading', version: info.version, percent: 0 }));
autoUpdater.on('update-not-available', () => setUpdate({ status: 'current', message: '' }));
autoUpdater.on('download-progress', progress => setUpdate({ status: 'downloading', percent: Math.round(progress.percent) }));
autoUpdater.on('update-downloaded', info => setUpdate({ status: 'downloaded', version: info.version, percent: 100 }));
autoUpdater.on('error', error => {
  if (!checking) setUpdate({ status: 'error', message: error.message });
});
ipcMain.handle('summon:desktop-info', event => { trusted(event); return { version: app.getVersion(), platform: process.platform, arch: process.arch, windowControlsOverlay: true, localInstance: connection?.mode === 'local', selectionWarning, update }; });
ipcMain.handle('summon:set-theme', (event, dark) => { trusted(event); applyWindowTheme(window, Boolean(dark)); return true; });
ipcMain.handle('summon:open-connection-setup', (event, section) => {
  trusted(event);
  if (!connectionOperations.has('connection')) showSetup(connection?.mode === 'local' && ['cloudflare', 'tailscale'].includes(section) ? section : 'instances');
});
ipcMain.handle('summon:connection-info', event => {
  trusted(event, true);
  return { ...setup, connection, update, selectionWarning, localAvailable: true };
});
ipcMain.handle('summon:connection-action', async (event, command, input = {}) => {
  trusted(event, true);
  const operation = command === 'access' ? input.action === 'status' ? null : 'access'
    : command === 'authorize' || command === 'choose-instance' ? null : 'connection';
  if (operation && connectionOperations.has(operation)) throw new Error('该项设置正在更新，请稍后重试。');
  if (operation) connectionOperations.add(operation);
  const target = window;
  try {
    if (command === 'choose-instance') return showSetup();
    if (command === 'continue') {
      try { await continueConnection(target); }
      catch (error) { if (target === window) connectionError(error, connection); }
      return;
    }
    if (command === 'connect-local' || command === 'connect-remote') {
      const { formalOrigin, remoteInstanceOrigin } = await desktopSettings();
      let selection = connection;
      if (command === 'connect-local') {
        selection = { mode: 'local', origin: formalOrigin };
      } else if (command === 'connect-remote') {
        selection = { mode: 'remote', origin: remoteInstanceOrigin(input.address) };
      }
      if (!selection) throw new Error('请先选择一个实例。');
      const token = command === 'connect-remote' ? input.token : undefined;
      const previousSetup = setup;
      try { await prepareConnection(target.webContents.session, selection, token); }
      catch (error) {
        if (command === 'connect-remote' && !token && error.code === 'INSTANCE_LOGIN_REQUIRED')
          throw new Error('请输入该实例的访问令牌。');
        throw error;
      }
      if (target === window && setup === previousSetup) return rememberConnection(target, selection);
      return;
    }
    if (command === 'access' || command === 'authorize') {
      if (connection?.mode !== 'local') throw new Error('请在部署机配置本机远程访问。');
      if (command === 'access') {
        return await localAccess(profile, { ...input, dataRoot: undefined });
      }
      const url = await authorizationUrl(input.provider);
      if (url) await shell.openExternal(url);
      return { opened: Boolean(url) };
    }
    throw new Error('未知的实例操作。');
  } finally { if (operation) connectionOperations.delete(operation); }
});
ipcMain.handle('summon:check-update', event => { trusted(event, event.senderFrame?.url === setupUrl); return checkForUpdates({ force:true }); });
ipcMain.handle('summon:install-update', event => {
  trusted(event, event.senderFrame?.url === setupUrl);
  if (update.status === 'manual') return openUpdateDownload();
  if (update.status !== 'downloaded') return false;
  setImmediate(() => autoUpdater.quitAndInstall(true, true)); return true;
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(() => {
    installSetupProtocol();
    createWindow();
    const clientMenu = { label: 'Summon Bot', submenu: [
      { label: '实例连接…', click: () => { if (!connectionOperations.has('connection')) showSetup(); } },
      { type: 'separator' },
      { label: '检查更新', click: () => {
        if (window?.webContents.getURL() === setupUrl) void checkForUpdates({ force:true });
        else window?.webContents.send('summon:open-updates');
      } },
      { label: release.updateMode === 'manual' ? '下载更新' : '重启并更新', click: requestInstall }, { type: 'separator' }, { role: 'quit' },
    ] };
    Menu.setApplicationMenu(Menu.buildFromTemplate([clientMenu, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    timer = setInterval(checkForUpdates, 4 * 60 * 60 * 1000); timer.unref();
    setTimeout(checkForUpdates, 15000).unref();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => clearInterval(timer));
}
