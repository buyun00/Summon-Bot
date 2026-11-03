const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const { join } = require('node:path');
const { autoUpdater } = require('electron-updater');
const release = require('./release.json');
const origin = new URL(release.appUrl).origin;
const localUpdateFeed = new URL(release.updatePath, 'http://127.0.0.1:8787').href;
const remoteUpdateFeed = new URL(release.updatePath, release.appUrl).href;
let window, timer, checking;
let update = { status: 'idle', currentVersion: app.getVersion() };

function setUpdate(value) {
  update = { ...update, ...value };
  if (window && !window.isDestroyed()) window.webContents.send('relay:update-state', update);
}
const trusted = event => {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || new URL(event.senderFrame.url).origin !== origin) throw new Error('Untrusted desktop request');
};
async function checkForUpdates() {
  if (checking || ['downloading', 'downloaded'].includes(update.status)) return update;
  if (!app.isPackaged) return update;
  checking = true;
  setUpdate({ status: 'checking', message: '', percent: 0 });
  try {
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
  if (update.status === 'downloaded') window.webContents.send('relay:request-install');
}
function createWindow() {
  window = new BrowserWindow({
    title: 'Relay', width: 1280, height: 900, minWidth: 680, minHeight: 560,
    backgroundColor: '#f9f9fa', show: false, autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url).catch(() => {}); }
  });
  window.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    dialog.showMessageBox(window, { type: 'error', message: '暂时无法连接 Relay', detail: '请确认网络和 Relay 服务已启动。', buttons: ['重试', '退出'] })
      .then(({ response }) => response === 0 ? window?.loadURL(release.appUrl) : app.quit());
  });
  window.loadURL(release.appUrl);
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
ipcMain.handle('relay:desktop-info', event => { trusted(event); return { version: app.getVersion(), platform: process.platform, arch: process.arch, update }; });
ipcMain.handle('relay:check-update', event => { trusted(event); return checkForUpdates(); });
ipcMain.handle('relay:install-update', event => { trusted(event); if (update.status !== 'downloaded') return false; setImmediate(() => autoUpdater.quitAndInstall(true, true)); return true; });
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(() => {
    createWindow();
    const clientMenu = { label: 'Relay', submenu: [
      { label: '检查更新', click: () => window?.webContents.send('relay:open-updates') },
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
