const { app, BrowserWindow, dialog, ipcMain, Menu, screen, session, shell, protocol, nativeTheme } = require('electron');
const { join } = require('node:path');
const { readFile, writeFile } = require('node:fs/promises');
const { autoUpdater } = require('electron-updater');
const release = require('./release.json');
const { runtime, setupUrl, isFreshInstallSync, prepareLocalConnection } = require('./connection.cjs');

// Keep the existing profile directory while changing the product's visible name.
app.setPath('userData', join(app.getPath('appData'), 'Relay'));
app.setName('Summon Bot');
protocol.registerSchemesAsPrivileged([{ scheme: 'summon-setup', privileges: { standard: true, secure: true } }]);

const profile = app.getPath('userData');
const fromInstaller = process.argv.includes('--from-installer');
const installerHandoffFile = join(app.getPath('temp'), 'summon-installer-handoff.ready');
const localUpdateFeed = new URL(release.updatePath, 'http://127.0.0.1:8787').href;
const [releasePlatform, releaseArch] = release.updatePath.split('/').filter(Boolean).slice(-2);
const remoteUpdateFeed = `https://github.com/${release.githubRepository}/releases/download/client-${releasePlatform}-${releaseArch}/`;

const stageProgress = {
  extract: { percent: 64, stage: '正在准备核心运行组件…' },
  prepare: { percent: 74, stage: '正在准备本机环境…' },
  upgrade: { percent: 78, stage: '正在平滑升级本机运行时…' },
  gateway: { percent: 84, stage: '正在启动核心服务…' },
  web: { percent: 92, stage: '正在启动本机工作台…' },
  connect: { percent: 97, stage: '正在唤醒 Summon Bot…' },
};

let mainWindow = null;
let introWindow = null;
let introDisplayBounds = null;
let resolveIntroAnim = null;
let installerHandedOff = false;
let timer, checking, booting = false;
let connection = null;
let bootState = {
  status: 'booting',
  percent: fromInstaller ? 56 : 14,
  stage: fromInstaller ? stageProgress.extract.stage : stageProgress.prepare.stage,
  error: '',
};
let update = { status: 'idle', currentVersion: app.getVersion() };

function signalInstallerHandoff() {
  if (!fromInstaller || installerHandedOff) return;
  installerHandedOff = true;
  void writeFile(installerHandoffFile, 'ready').catch(() => {});
}

function revealIntroAndHandoff() {
  if (introWindow && !introWindow.isDestroyed()) {
    try { introWindow.setOpacity(1); } catch {}
    introWindow.show();
    introWindow.focus();
  }
  if (fromInstaller && !installerHandedOff) {
    setTimeout(() => signalInstallerHandoff(), 120);
  }
}

function broadcastUpdate(value) {
  for (const target of [mainWindow, introWindow]) {
    if (target && !target.isDestroyed()) target.webContents.send('summon:update-state', value);
  }
}

function setUpdate(value) {
  update = { ...update, ...value };
  broadcastUpdate(update);
}

function setBootState(next) {
  bootState = { ...bootState, ...next };
  if (!introWindow || introWindow.isDestroyed()) return;
  if (introWindow.webContents.getURL().startsWith(setupUrl)) {
    introWindow.webContents.send('summon:boot-state', bootState);
  } else {
    introWindow.loadURL(`${setupUrl}?from_installer=0`).catch(() => {});
  }
}

const webOrigin = url => { try { return new URL(url).origin; } catch { return null; } };
const isWeb = url => connection?.origin && webOrigin(url) === connection.origin;

function isKnownSender(event, { allowBoot = false, allowIntroWeb = false, allowMainWeb = true } = {}) {
  const frame = event.senderFrame;
  if (!frame) return false;
  if (allowBoot && introWindow && !introWindow.isDestroyed() && event.sender === introWindow.webContents && frame === introWindow.webContents.mainFrame && frame.url.startsWith(setupUrl)) {
    return true;
  }
  if (allowIntroWeb && introWindow && !introWindow.isDestroyed() && event.sender === introWindow.webContents && frame === introWindow.webContents.mainFrame && isWeb(frame.url) && new URL(frame.url).pathname === '/') {
    return true;
  }
  if (allowMainWeb && mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && frame === mainWindow.webContents.mainFrame && isWeb(frame.url) && new URL(frame.url).pathname === '/') {
    return true;
  }
  return false;
}

function trusted(event, options) {
  if (!isKnownSender(event, options)) throw new Error('Untrusted desktop request');
}

function applyWindowTheme(target, dark) {
  if (!target || target.isDestroyed()) return;
  target.setBackgroundColor(dark ? '#0b0c10' : '#f8f6f1');
  if (typeof target.setTitleBarOverlay === 'function') {
    try { target.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#e6eaf4' : '#3a3832', height: 44 }); } catch {}
  }
}

function targetDisplayForMain() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return screen.getDisplayMatching(mainWindow.getBounds());
  }
  return screen.getPrimaryDisplay();
}

function computeCenteredMainBounds(display) {
  const area = display.workArea;
  const width = Math.min(1280, Math.max(840, area.width - 64));
  const height = Math.min(900, Math.max(620, area.height - 64));
  const x = Math.round(area.x + (area.width - width) / 2);
  const y = Math.round(area.y + (area.height - height) / 2);
  return { x, y, width, height };
}

function attachWebGuards(target) {
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
}

function createIntroOverlayWindow(display = targetDisplayForMain()) {
  const bounds = { ...display.bounds };
  // On Windows DWM, a transparent frameless window matching exact monitor bounds
  // can trigger fullscreen swapchain optimization and become invisible.
  const winHeight = process.platform === 'win32' ? bounds.height + 1 : bounds.height;
  if (introWindow && !introWindow.isDestroyed()) {
    introDisplayBounds = bounds;
    introWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: winHeight });
    introWindow.show();
    introWindow.focus();
    return introWindow;
  }
  introDisplayBounds = bounds;
  const deferReveal = fromInstaller && !installerHandedOff;
  const target = introWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: winHeight,
    title: 'Summon Bot',
    frame: false,
    transparent: true,
    thickFrame: false,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    fullscreenable: false,
    hasShadow: false,
    alwaysOnTop: true,
    opacity: deferReveal ? 0 : 1,
    show: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  try { target.setAlwaysOnTop(true, 'screen-saver'); } catch {}
  try { target.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  target.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: winHeight });
  target.webContents.once('did-finish-load', () => {
    if (target === introWindow && !target.isDestroyed() && !deferReveal) {
      target.show();
      target.focus();
    }
  });
  target.on('closed', () => { if (target === introWindow) introWindow = null; });
  attachWebGuards(target);
  return target;
}

function createMainWindow({ showImmediately = true, display = targetDisplayForMain() } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (showImmediately) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    return mainWindow;
  }
  const initialDark = nativeTheme.shouldUseDarkColors;
  const bounds = computeCenteredMainBounds(display);
  const target = mainWindow = new BrowserWindow({
    title: 'Summon Bot',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: 440,
    minHeight: 560,
    show: false,
    backgroundColor: initialDark ? '#0b0c10' : '#f8f6f1',
    autoHideMenuBar: process.platform !== 'darwin',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: initialDark ? '#e6eaf4' : '#3a3832', height: 44 },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  target.on('closed', () => { if (target === mainWindow) mainWindow = null; });
  target.on('focus', () => { if (!target.isDestroyed()) target.webContents.send('summon:window-active', true); });
  target.on('blur', () => { if (!target.isDestroyed()) target.webContents.send('summon:window-active', false); });
  attachWebGuards(target);
  target.webContents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (target !== mainWindow || !isMainFrame || code === -3 || !isWeb(url)) return;
    const overlay = createIntroOverlayWindow();
    setBootState({ status: 'booting', percent: 72, stage: '本机服务正在恢复，正在重新连接…', error: '' });
    overlay.loadURL(`${setupUrl}?from_installer=0`).catch(() => {});
    setTimeout(() => { void bootLocalInstance({ retryCount: 1 }); }, 1600);
  });
  target.webContents.on('did-navigate', (_event, url, status) => {
    if (target !== mainWindow || !isWeb(url) || new URL(url).pathname !== '/' || status < 400) return;
    const overlay = createIntroOverlayWindow();
    setBootState({
      status: 'booting',
      percent: 76,
      stage: status === 503 ? '本机服务正在更新，请稍候…' : '正在重新连接本机工作台…',
      error: '',
    });
    overlay.loadURL(`${setupUrl}?from_installer=0`).catch(() => {});
    setTimeout(() => { void bootLocalInstance({ retryCount: 1 }); }, 1600);
  });
  if (showImmediately) {
    target.once('ready-to-show', () => {
      if (target === mainWindow && !target.isDestroyed()) {
        target.show();
        target.focus();
      }
    });
  }
  return target;
}

function settleIntroOverlayWindow(width = 700, height = 760) {
  if (!introWindow || introWindow.isDestroyed()) return null;
  const display = introDisplayBounds
    ? screen.getDisplayMatching(introDisplayBounds)
    : targetDisplayForMain();
  const area = display.workArea;
  const w = Math.min(Math.max(540, Math.round(Number(width) || 700)), area.width - 24);
  const h = Math.min(Math.max(580, Math.round(Number(height) || 760)), area.height - 24);
  const x = Math.round(area.x + (area.width - w) / 2);
  const y = Math.round(area.y + (area.height - h) / 2);
  try { introWindow.setAlwaysOnTop(false); } catch {}
  try { introWindow.setMovable(true); } catch {}
  introWindow.setBounds({ x, y, width: w, height: h });
  introWindow.focus();
  return { x, y, width: w, height: h };
}

async function bootLocalInstance({ retryCount = 0 } = {}) {
  if (booting) return;
  booting = true;
  const fresh = isFreshInstallSync(profile);
  const showSplashNow = fromInstaller || fresh || retryCount > 0;
  const bootUrl = `${setupUrl}?from_installer=${fromInstaller && retryCount === 0 ? '1' : '0'}`;
  let delayedSplashTimer = null;

  const ensureBootSplash = async () => {
    const overlay = createIntroOverlayWindow();
    if (!overlay.webContents.getURL().startsWith(setupUrl)) {
      await overlay.loadURL(bootUrl).catch(() => {});
    }
    if (fromInstaller && !installerHandedOff) {
      // Safety fallback in case boot-ready IPC does not fire promptly
      setTimeout(() => revealIntroAndHandoff(), 900);
    }
    return overlay;
  };

  setBootState({
    status: 'booting',
    percent: fromInstaller && retryCount === 0 ? 54 : 14,
    stage: fromInstaller ? stageProgress.extract.stage : stageProgress.prepare.stage,
    error: '',
  });

  if (showSplashNow) {
    await ensureBootSplash();
  } else {
    delayedSplashTimer = setTimeout(() => {
      delayedSplashTimer = null;
      void ensureBootSplash();
    }, 450);
  }

  let shouldRetry = false;
  try {
    const ready = await prepareLocalConnection(session.defaultSession, profile, progress => {
      const info = stageProgress[progress?.stage] || stageProgress.prepare;
      if (introWindow && !introWindow.isDestroyed()) {
        setBootState({ status: 'booting', percent: info.percent, stage: info.stage, error: '' });
      }
    });
    if (delayedSplashTimer) {
      clearTimeout(delayedSplashTimer);
      delayedSplashTimer = null;
    }
    connection = ready;

    const shouldUnbox = Boolean(ready.needsIntro || (fromInstaller && introWindow && !introWindow.isDestroyed()));
    if (shouldUnbox) {
      const overlay = await ensureBootSplash();
      revealIntroAndHandoff();
      const animDone = new Promise(done => {
        resolveIntroAnim = done;
        setTimeout(() => { resolveIntroAnim = null; done(); }, 3800);
      });
      setBootState({ status: 'ready_to_unbox', percent: 100, stage: '准备就绪，开箱！', error: '' });
      await animDone;
      if (ready.needsIntro) {
        settleIntroOverlayWindow(700, 760);
        await overlay.loadURL(new URL('/?desktop_intro=ready', ready.origin).href);
        return;
      }
    }

    signalInstallerHandoff();
    const main = createMainWindow({ showImmediately: true });
    await main.loadURL(new URL('/', ready.origin).href);
    if (introWindow && !introWindow.isDestroyed()) {
      introWindow.close();
    }
  } catch (error) {
    if (delayedSplashTimer) {
      clearTimeout(delayedSplashTimer);
      delayedSplashTimer = null;
    }
    signalInstallerHandoff();
    await ensureBootSplash();
    if (retryCount < 2) {
      shouldRetry = true;
      setBootState({
        status: 'booting',
        percent: Math.max(bootState.percent || 64, 70),
        stage: '核心服务启动较慢，正在自动重试…',
        error: '',
      });
    } else {
      setBootState({
        status: 'error',
        stage: `本机服务暂时未能就绪：${String(error?.message || '请稍候重新打开 Summon Bot')}`,
        error: '',
      });
    }
  } finally {
    resolveIntroAnim = null;
    booting = false;
  }

  if (shouldRetry) {
    setTimeout(() => { void bootLocalInstance({ retryCount: retryCount + 1 }); }, 1800);
  }
}

function installSetupProtocol() {
  const assets = new Map([
    ['/index.html', [join(__dirname, 'setup.html'), 'text/html']],
    ['/setup.js', [join(__dirname, 'setup.js'), 'text/javascript']],
    ['/setup.css', [join(__dirname, 'setup.css'), 'text/css']],
    ['/icon.png', [join(runtime, 'web/frontend/icons/icon-192.png'), 'image/png']],
  ]);
  protocol.handle('summon-setup', async request => {
    const url = new URL(request.url), asset = url.host === 'boot' && assets.get(url.pathname);
    if (!asset || request.method !== 'GET') return new Response(null, { status: 404 });
    return new Response(await readFile(asset[0]), {
      headers: {
        'Content-Type': asset[1],
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      },
    });
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
          const channel = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
          const response = await fetch(new URL(channel, feed), {
            method: 'HEAD', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(1200),
          });
          if (!response.ok) throw new Error(`Local update unavailable (HTTP ${response.status})`);
        }
        autoUpdater.setFeedURL({ provider: 'generic', url: feed, useMultipleRangeRequest: false });
        const result = await autoUpdater.checkForUpdates();
        if (result?.isUpdateAvailable) await autoUpdater.downloadUpdate(result.cancellationToken);
        return update;
      } catch (error) {
        if (feed === remoteUpdateFeed) throw error;
        setUpdate({ status: 'checking', message: '', percent: 0 });
      }
    }
  } catch (error) {
    setUpdate({ status: 'error', message: error.message });
  } finally {
    checking = false;
  }
  return update;
}

function requestInstall() {
  const active = mainWindow || introWindow;
  if (!active) return;
  if (update.status === 'manual') return openUpdateDownload();
  if (update.status !== 'downloaded') return;
  if (active.webContents.getURL() === setupUrl) autoUpdater.quitAndInstall(false, true);
  else active.webContents.send('summon:request-install');
}

function openUpdateDownload() {
  if (update.status !== 'manual' || ![localUpdateFeed, remoteUpdateFeed].some(feed => update.downloadUrl?.startsWith(feed))) return false;
  void shell.openExternal(update.downloadUrl).catch(() => {});
  return true;
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

ipcMain.handle('summon:desktop-info', event => {
  trusted(event, { allowMainWeb: true, allowIntroWeb: true });
  return { version: app.getVersion(), platform: process.platform, arch: process.arch, windowControlsOverlay: true, localInstance: true, update };
});

ipcMain.handle('summon:set-theme', (event, dark) => {
  trusted(event, { allowMainWeb: true, allowIntroWeb: true });
  if (mainWindow && !mainWindow.isDestroyed()) applyWindowTheme(mainWindow, Boolean(dark));
  return true;
});

ipcMain.handle('summon:pick-directory', async event => {
  trusted(event, { allowMainWeb: true, allowIntroWeb: true });
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  if (!owner || owner.isDestroyed()) return '';
  const result = await dialog.showOpenDialog(owner, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? '' : (result.filePaths?.[0] || '');
});

ipcMain.handle('summon:preview-desktop-intro', async event => {
  trusted(event, { allowMainWeb: true });
  if (!connection?.origin) return false;
  const display = targetDisplayForMain();
  const overlay = createIntroOverlayWindow(display);
  await overlay.loadURL(new URL('/?desktop_intro=preview', connection.origin).href);
  return true;
});

ipcMain.handle('summon:intro-settle-window', (event, { width = 700, height = 760 } = {}) => {
  trusted(event, { allowIntroWeb: true, allowMainWeb: false });
  return settleIntroOverlayWindow(width, height) || false;
});

ipcMain.handle('summon:boot-ready', event => {
  trusted(event, { allowBoot: true, allowMainWeb: false });
  revealIntroAndHandoff();
  return true;
});

ipcMain.handle('summon:boot-intro-done', event => {
  trusted(event, { allowBoot: true, allowMainWeb: false });
  if (resolveIntroAnim) {
    const fn = resolveIntroAnim;
    resolveIntroAnim = null;
    fn();
  }
  return true;
});

ipcMain.handle('summon:intro-prepare-handoff', async (event, { preview = false } = {}) => {
  trusted(event, { allowIntroWeb: true, allowMainWeb: false });
  if (!connection?.origin) return null;
  const display = introDisplayBounds
    ? screen.getDisplayMatching(introDisplayBounds)
    : targetDisplayForMain();
  const existed = Boolean(mainWindow && !mainWindow.isDestroyed());
  const main = createMainWindow({ showImmediately: false, display });
  const targetUrl = new URL('/', connection.origin).href;
  if (!existed || !isWeb(main.webContents.getURL())) {
    await main.loadURL(targetUrl);
  }
  main.webContents.send('summon:start-onboarding-focus', { preview: Boolean(preview) });
  // Keep mainWindow hidden while pre-rendered so introWindow can smoothly morph-expand into it!
  await new Promise(resolve => setTimeout(resolve, 140));
  return { ready: true, targetBounds: main.getBounds() };
});

ipcMain.handle('summon:intro-expand-handoff', async event => {
  trusted(event, { allowIntroWeb: true, allowMainWeb: false });
  if (!introWindow || introWindow.isDestroyed()) return false;
  const display = introDisplayBounds
    ? screen.getDisplayMatching(introDisplayBounds)
    : targetDisplayForMain();
  const target = (mainWindow && !mainWindow.isDestroyed())
    ? mainWindow.getBounds()
    : computeCenteredMainBounds(display);
  const start = introWindow.getBounds();
  try { introWindow.setResizable(true); } catch {}
  try { introWindow.setAlwaysOnTop(true, 'floating'); } catch {}

  const duration = 420;
  const startedAt = Date.now();
  const easeOutCubic = t => 1 - Math.pow(1 - t, 3);
  await new Promise(resolve => {
    const tick = () => {
      if (!introWindow || introWindow.isDestroyed()) return resolve();
      const raw = Math.min(1, (Date.now() - startedAt) / duration);
      const p = easeOutCubic(raw);
      introWindow.setBounds({
        x: Math.round(start.x + (target.x - start.x) * p),
        y: Math.round(start.y + (target.y - start.y) * p),
        width: Math.round(start.width + (target.width - start.width) * p),
        height: Math.round(start.height + (target.height - start.height) * p),
      });
      if (raw >= 1) return resolve();
      setTimeout(tick, 14);
    };
    tick();
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBounds(target);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
  }
  await new Promise(resolve => setTimeout(resolve, 40));
  if (introWindow && !introWindow.isDestroyed()) {
    const fadeStart = Date.now();
    const fadeDur = 190;
    await new Promise(resolve => {
      const fade = () => {
        if (!introWindow || introWindow.isDestroyed()) return resolve();
        const raw = Math.min(1, (Date.now() - fadeStart) / fadeDur);
        try { introWindow.setOpacity(Math.max(0, 1 - raw)); } catch {}
        if (raw >= 1) return resolve();
        setTimeout(fade, 14);
      };
      fade();
    });
    if (introWindow && !introWindow.isDestroyed()) introWindow.close();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
  }
  return true;
});

ipcMain.handle('summon:intro-finish-handoff', event => {
  trusted(event, { allowIntroWeb: true, allowMainWeb: false });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  if (introWindow && !introWindow.isDestroyed()) {
    introWindow.close();
  }
  return true;
});

ipcMain.handle('summon:intro-close', event => {
  trusted(event, { allowBoot: true, allowIntroWeb: true, allowMainWeb: false });
  if (introWindow && !introWindow.isDestroyed()) {
    introWindow.close();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  } else if (process.platform !== 'darwin') {
    app.quit();
  }
  return true;
});

ipcMain.handle('summon:boot-info', event => {
  trusted(event, { allowBoot: true, allowMainWeb: false });
  return { ...bootState, version: app.getVersion(), update };
});

ipcMain.handle('summon:check-update', event => {
  trusted(event, { allowBoot: true, allowIntroWeb: true, allowMainWeb: true });
  return checkForUpdates({ force: true });
});

ipcMain.handle('summon:install-update', event => {
  trusted(event, { allowBoot: true, allowIntroWeb: true, allowMainWeb: true });
  if (update.status === 'manual') return openUpdateDownload();
  if (update.status !== 'downloaded') return false;
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    const active = (introWindow && !introWindow.isDestroyed()) ? introWindow : mainWindow;
    if (active) {
      if (active.isMinimized()) active.restore();
      active.show();
      active.focus();
    }
  });
  app.whenReady().then(() => {
    installSetupProtocol();
    void bootLocalInstance();
    const clientMenu = {
      label: 'Summon Bot',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('summon:open-updates');
            else void checkForUpdates({ force: true });
          },
        },
        { label: release.updateMode === 'manual' ? '下载更新' : '重启并更新', click: requestInstall },
        { type: 'separator' },
        { role: 'quit' },
      ],
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate([clientMenu, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    timer = setInterval(checkForUpdates, 4 * 60 * 60 * 1000);
    timer.unref();
    setTimeout(checkForUpdates, 15000).unref();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) void bootLocalInstance(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => clearInterval(timer));
}
