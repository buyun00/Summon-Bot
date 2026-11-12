const { app, BrowserWindow, ipcMain, Menu, shell, protocol } = require('electron');
const { join } = require('node:path');
const { readFile } = require('node:fs/promises');
const { autoUpdater } = require('electron-updater');
const release = require('./release.json');
const { runtime, setupUrl, desktopSettings, localAccess, prepareWorkspace, workspaceProfiles, authorizationUrl } = require('./workspace.cjs');
// Keep the existing profile directory while changing the product's visible name.
app.setPath('userData', join(app.getPath('appData'), 'Relay'));
app.setName('Summon Bot');
protocol.registerSchemesAsPrivileged([{ scheme: 'summon-setup', privileges: { standard: true, secure: true } }]);
const profile = app.getPath('userData');
const localUpdateFeed = new URL(release.updatePath, 'http://127.0.0.1:8787').href;
const [releasePlatform, releaseArch] = release.updatePath.split('/').filter(Boolean).slice(-2);
const remoteUpdateFeed = `https://github.com/${release.githubRepository}/releases/download/client-${releasePlatform}-${releaseArch}/`;
let window, timer, checking;
let workspace = null, candidate = null, setup = { section: 'unpacking', error: '' }, busy = false;
let update = { status: 'idle', currentVersion: app.getVersion() };

function setUpdate(value) {
  update = { ...update, ...value };
  if (window && !window.isDestroyed()) window.webContents.send('summon:update-state', update);
}
const webOrigin = url => { try { return new URL(url).origin; } catch { return null; } };
const isWeb = url => workspace?.origin && webOrigin(url) === workspace.origin;
function trusted(event, local = false) {
  if (!window || event.sender !== window.webContents || !event.senderFrame || event.senderFrame !== window.webContents.mainFrame
    || !(local ? event.senderFrame.url === setupUrl : isWeb(event.senderFrame.url))) throw new Error('Untrusted desktop request');
}

function showSetup(section = 'unpacking', error = '') {
  if (section === 'unpacking') candidate = null;
  setup = { section, error };
  if (!window || window.isDestroyed()) return;
  if (window.webContents.getURL() === setupUrl) window.webContents.send('summon:workspace-setup-state');
  else window.loadURL(setupUrl).catch(() => {});
}

async function showWorkspace(target, selection) {
  if (target !== window || target.isDestroyed()) return;
  const url = new URL('/', selection.origin);
  if (selection.workspaceId) url.searchParams.set('workspace', selection.workspaceId);
  const previousSetup = setup;
  await target.loadURL(url.href).catch(() => {
    if (target === window && !target.isDestroyed() && setup === previousSetup) {
      showSetup('instances', '暂时无法打开工作区。请重试或选择其他实例。');
    }
  });
}

async function continueWorkspace(target) {
  const selection = workspace;
  if (!selection) return showSetup();
  const previousSetup = setup;
  const profiles = await prepareWorkspace(target.webContents.session, selection);
  if (target !== window || setup !== previousSetup) return;
  if (selection.workspaceId && !profiles.some(item => item.id === selection.workspaceId)) {
    candidate = { mode: selection.mode, origin: selection.origin, profiles };
    return showSetup('workspaces', '上次选择的工作区已不可用，请重新选择。');
  }
  await showWorkspace(target, selection);
}

function connectionError(error, selection) {
  const section = selection?.mode === 'remote' && error.code === 'WORKSPACE_LOGIN_REQUIRED' ? 'remote' : 'instances';
  showSetup(section, error.message);
}

async function restoreWorkspace(target) {
  const previousSetup = setup;
  try {
    const { readWorkspaceSelection } = await desktopSettings();
    const selection = await readWorkspaceSelection(profile);
    if (target !== window) return;
    workspace = selection;
    if (setup === previousSetup) await continueWorkspace(target);
  } catch (error) {
    if (target === window && setup === previousSetup) connectionError(error, workspace);
  }
}

async function rememberWorkspace(target, { mode, origin }, workspaceId) {
  const selection = { mode, origin, workspaceId };
  const { saveWorkspaceSelection } = await desktopSettings();
  await saveWorkspaceSelection(profile, selection);
  if (target !== window) return;
  workspace = selection;
  await showWorkspace(target, selection);
}

function installSetupProtocol() {
  const assets = new Map([
    ['/index.html', [join(__dirname, 'setup.html'), 'text/html']],
    ['/setup.js', [join(__dirname, 'setup.js'), 'text/javascript']],
    ['/setup.css', [join(__dirname, 'setup.css'), 'text/css']],
    ['/startup-art.png', [join(__dirname, 'startup-art.png'), 'image/png']],
    ['/avatars.js', [join(runtime, 'web/frontend/avatars.js'), 'text/javascript']],
    ['/icon.png', [join(runtime, 'web/frontend/icons/icon-192.png'), 'image/png']],
  ]);
  protocol.handle('summon-setup', async request => {
    const url = new URL(request.url), asset = url.host === 'workspace' && assets.get(url.pathname);
    if (!asset || request.method !== 'GET') return new Response(null, { status: 404 });
    return new Response(await readFile(asset[0]), { headers: {
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
  const target = window = new BrowserWindow({
    title: 'Summon Bot', width: 1280, height: 900, minWidth: 680, minHeight: 560,
    backgroundColor: '#fdfdfc', show: false, autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#4b5045', height: 44 },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  target.once('ready-to-show', () => target.show());
  target.on('closed', () => { if (target === window) window = null; });
  target.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  target.webContents.on('will-frame-navigate', event => {
    if (event.isMainFrame ? !isWeb(event.url) : webOrigin(event.url) !== workspace?.origin) event.preventDefault();
  });
  target.webContents.on('will-redirect', event => { if (!isWeb(event.url)) event.preventDefault(); });
  target.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  target.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (target !== window || !isMainFrame || code === -3 || !isWeb(url)) return;
    showSetup('instances', '暂时无法连接工作区。请重试或选择其他实例。');
  });
  target.webContents.on('did-navigate', (_event, url, status) => {
    if (target !== window || !isWeb(url) || new URL(url).pathname !== '/' || status < 400) return;
    if (status === 401 && workspace.mode === 'remote') showSetup('remote', '工作区登录已失效，请重新连接该实例。');
    else showSetup('instances', '工作区页面暂不可用。请重试或选择其他实例。');
  });
  void restoreWorkspace(target);
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
ipcMain.handle('summon:desktop-info', event => { trusted(event); return { version: app.getVersion(), platform: process.platform, arch: process.arch, windowControlsOverlay: true, localWorkspace: workspace?.mode === 'local', update }; });
ipcMain.handle('summon:open-workspace-setup', (event, section) => {
  trusted(event);
  if (!busy) showSetup(workspace?.mode === 'local' && ['cloudflare', 'tailscale'].includes(section) ? section : 'unpacking');
});
ipcMain.handle('summon:workspace-info', event => {
  trusted(event, true);
  return { ...setup, workspace, candidate, localAvailable: process.platform === 'win32' };
});
ipcMain.handle('summon:workspace-action', async (event, command, input = {}) => {
  trusted(event, true);
  if (busy) throw new Error('另一个设置操作正在进行。');
  busy = true;
  const target = window;
  try {
    if (command === 'continue') {
      try { await continueWorkspace(target); }
      catch (error) { if (target === window) connectionError(error, workspace); }
      return;
    }
    if (command === 'prepare-local' || command === 'prepare-remote' || command === 'prepare-current') {
      const { formalOrigin, remoteWorkspaceOrigin } = await desktopSettings();
      let selection = workspace;
      if (command === 'prepare-local') {
        if (process.platform !== 'win32') throw new Error('请通过 HTTPS 连接已有实例。');
        selection = { mode: 'local', origin: formalOrigin };
      } else if (command === 'prepare-remote') {
        selection = { mode: 'remote', origin: remoteWorkspaceOrigin(input.address) };
      }
      if (!selection) throw new Error('请先选择一个实例。');
      const token = command === 'prepare-remote' ? input.token : undefined;
      let profiles;
      try { profiles = await prepareWorkspace(target.webContents.session, selection, token); }
      catch (error) {
        if (command === 'prepare-remote' && !token && error.code === 'WORKSPACE_LOGIN_REQUIRED') {
          throw new Error('请输入该实例的访问令牌。');
        }
        throw error;
      }
      if (target !== window) return;
      return candidate = { mode: selection.mode, origin: selection.origin, profiles };
    }
    if (command === 'open-workspace' || command === 'create-workspace') {
      const connection = candidate;
      if (!connection) throw new Error('请先连接实例。');
      if (command === 'open-workspace') {
        const workspaceId = input.workspaceId ?? null;
        if (workspaceId !== null && !connection.profiles.some(item => item.id === workspaceId)) throw new Error('请选择列表中的工作区。');
        return await rememberWorkspace(target, connection, workspaceId);
      }
      const { reserveWorkspaceCreation } = await desktopSettings();
      const session = target.webContents.session;
      const id = await reserveWorkspaceCreation(profile, connection);
      let created;
      try { created = await workspaceProfiles(session, connection.origin, id); }
      catch (error) {
        if (error.code !== 'WORKSPACE_LOGIN_REQUIRED') throw error;
        if (connection.mode === 'remote') {
          if (target === window) connectionError(error, connection);
          return;
        }
        await prepareWorkspace(session, connection);
        created = await workspaceProfiles(session, connection.origin, id);
      }
      if (!connection.profiles.some(item => item.id === id)) connection.profiles.unshift(created);
      if (target === window && target.webContents.getURL() === setupUrl) target.webContents.send('summon:workspace-progress', 'ready');
      return await rememberWorkspace(target, connection, id);
    }
    if (command === 'access' || command === 'authorize') {
      if (workspace?.mode !== 'local') throw new Error('请在部署机配置本机远程访问。');
      if (command === 'access') {
        return await localAccess(profile, { ...input, dataRoot: undefined });
      }
      const url = await authorizationUrl(input.provider);
      if (url) await shell.openExternal(url);
      return { opened: Boolean(url) };
    }
    throw new Error('未知的工作区操作。');
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
      { label: '切换工作区…', click: () => { if (!busy) showSetup(); } },
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
