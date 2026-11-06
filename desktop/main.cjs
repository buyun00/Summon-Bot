const { app, BrowserWindow, ipcMain, Menu, shell, dialog, protocol, clipboard } = require('electron');
const { join } = require('node:path');
const { readFile } = require('node:fs/promises');
const { autoUpdater } = require('electron-updater');
const release = require('./release.json');
const { setupUrl, workspaceCommand, workspaceToken, login, codexConsent, authorizationUrl } = require('./workspace.cjs');
// Keep the existing profile directory while changing the product's visible name.
app.setPath('userData', join(app.getPath('appData'), 'Relay'));
app.setName('Summon Bot');
protocol.registerSchemesAsPrivileged([{ scheme: 'summon-setup', privileges: { standard: true, secure: true } }]);
const profile = app.getPath('userData');
const localUpdateFeed = new URL(release.updatePath, 'http://127.0.0.1:8787').href;
const [releasePlatform, releaseArch] = release.updatePath.split('/').filter(Boolean).slice(-2);
const remoteUpdateFeed = `https://github.com/${release.githubRepository}/releases/download/client-${releasePlatform}-${releaseArch}/`;
let window, timer, checking;
let workspace = { mode: 'unselected' }, setup = { section: 'workspace', error: '' }, busy = false;
let update = { status: 'idle', currentVersion: app.getVersion() };

function setUpdate(value) {
  update = { ...update, ...value };
  if (window && !window.isDestroyed()) window.webContents.send('summon:update-state', update);
}
const webOrigin = url => { try { return new URL(url).origin; } catch { return null; } };
const isWeb = url => workspace.origin && webOrigin(url) === workspace.origin;
function trusted(event, local = false) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || !(local ? event.senderFrame.url === setupUrl : isWeb(event.senderFrame.url))) throw new Error('Untrusted desktop request');
}

function showSetup(section = 'workspace', error = '') {
  setup = { section, error };
  if (window?.webContents.getURL() === setupUrl) window.webContents.send('summon:workspace-setup-state', setup);
  else window?.loadURL(setupUrl).catch(() => {});
}

async function showWorkspace(token) {
  if (!window || !workspace.origin) return showSetup();
  try {
    if (workspace.mode === 'local') token = await workspaceToken(workspace);
    if (token) await login(window.webContents.session, workspace.origin, token);
    await window.loadURL(workspace.origin);
  } catch (error) {
    showSetup('workspace', workspace.mode === 'local' && workspace.local?.state === 'stopped'
      ? '本机工作区已停止。可以在这里重新启动。' : '暂时无法打开工作区。请检查地址、令牌和服务状态后重试。');
  }
}

async function restoreWorkspace() {
  try {
    workspace = await workspaceCommand(profile, 'status');
    if (workspace.mode === 'local') workspace = await workspaceCommand(profile, 'resume');
    await showWorkspace();
  } catch (error) { showSetup('workspace', error.message); }
}

function installSetupProtocol() {
  const assets = new Map([['/index.html', ['setup.html', 'text/html']], ['/setup.js', ['setup.js', 'text/javascript']],
    ['/setup.css', ['setup.css', 'text/css']], ['/icon.png', ['setup-icon.png', 'image/png']]]);
  protocol.handle('summon-setup', async request => {
    const url = new URL(request.url), asset = url.host === 'workspace' && assets.get(url.pathname);
    if (!asset || request.method !== 'GET') return new Response(null, { status: 404 });
    return new Response(await readFile(join(__dirname, asset[0])), { headers: {
      'Content-Type': asset[1], 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    } });
  });
}
async function checkForUpdates() {
  if (checking || ['downloading', 'downloaded'].includes(update.status)) return update;
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
  if (update.status === 'downloaded') window.webContents.send('summon:request-install');
}
function createWindow() {
  window = new BrowserWindow({
    title: 'Summon Bot', width: 1280, height: 900, minWidth: 680, minHeight: 560,
    backgroundColor: '#fdfdfc', show: false, autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#4b5045', height: 44 },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame ? !isWeb(event.url) : webOrigin(event.url) !== workspace.origin) event.preventDefault();
  });
  window.webContents.on('will-redirect', event => { if (!isWeb(event.url)) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  window.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isWeb(url)) return;
    showSetup('workspace', '暂时无法连接工作区。可以重试或更改地址。');
  });
  void restoreWorkspace();
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
ipcMain.handle('summon:desktop-info', event => { trusted(event); return { version: app.getVersion(), platform: process.platform, arch: process.arch, windowControlsOverlay: true, localWorkspace: workspace.mode === 'local', update }; });
ipcMain.handle('summon:open-workspace-setup', (event, section) => {
  trusted(event);
  showSetup(workspace.mode === 'local' && ['codex', 'cloudflare', 'tailscale'].includes(section) ? section : 'workspace');
});
ipcMain.handle('summon:workspace-info', event => { trusted(event, true); return { ...setup, workspace }; });
ipcMain.handle('summon:workspace-action', async (event, command, input = {}) => {
  trusted(event, true);
  if (busy) throw new Error('另一个设置操作正在进行。');
  busy = true;
  try {
    if (command === 'continue') { void showWorkspace(); return workspace; }
    if (command === 'copy-access-token') {
      clipboard.writeText(await workspaceToken(workspace));
      return { copied: true };
    }
    if (command === 'authorize') {
      const url = await authorizationUrl(workspace, input.provider);
      if (url) await shell.openExternal(url);
      return { opened: Boolean(url) };
    }
    if (command === 'codex-consent') return await codexConsent(workspace, input.enabled === true);
    if (['access', 'codex'].includes(command)) {
      if (workspace.mode !== 'local') throw new Error('请在部署机配置本机能力。');
      const { dataRoot, ...options } = input;
      return await workspaceCommand(profile, command, options);
    }
    if (!['local', 'remote', 'start', 'stop'].includes(command)) throw new Error('未知的工作区操作。');
    workspace = await workspaceCommand(profile, command, input);
    if (command === 'stop') showSetup('workspace', '本机工作区已停止。');
    else void showWorkspace(command === 'remote' ? input.token : undefined);
    return workspace;
  } finally { busy = false; }
});
ipcMain.handle('summon:check-update', event => { trusted(event); return checkForUpdates(); });
ipcMain.handle('summon:install-update', event => {
  trusted(event);
  if (update.status === 'manual' && [localUpdateFeed, remoteUpdateFeed].some(feed => update.downloadUrl?.startsWith(feed))) { shell.openExternal(update.downloadUrl); return true; }
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
      { label: '切换工作区…', click: () => showSetup() },
      { label: '停止本机工作区…', click: async () => {
        if (!window || workspace.mode !== 'local' || workspace.local?.owner !== 'summon') return;
        const { response } = await dialog.showMessageBox(window, { type: 'question', message: '停止本机工作区？', buttons: ['停止', '取消'], cancelId: 1 });
        if (response === 0) {
          try { workspace = await workspaceCommand(profile, 'stop'); showSetup('workspace', '本机工作区已停止。'); }
          catch (error) { showSetup('workspace', error.message); }
        }
      } },
      { type: 'separator' },
      { label: '检查更新', click: () => window?.webContents.send('summon:open-updates') },
      { label: '重启并更新', click: requestInstall }, { type: 'separator' }, { role: 'quit' },
    ] };
    Menu.setApplicationMenu(Menu.buildFromTemplate([clientMenu, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    timer = setInterval(checkForUpdates, 4 * 60 * 60 * 1000); timer.unref();
    setTimeout(checkForUpdates, 15000).unref();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => clearInterval(timer));
}
