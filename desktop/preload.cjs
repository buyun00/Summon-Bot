const { contextBridge, ipcRenderer, webUtils } = require('electron');

if (location.protocol === 'summon-setup:' && location.host === 'boot') {
  const params = new URLSearchParams(location.search);
  const fromInstaller = params.get('from_installer') === '1';
  contextBridge.exposeInMainWorld('SummonBoot', Object.freeze({
    fromInstaller,
    ready: () => ipcRenderer.invoke('summon:boot-ready'),
    info: () => ipcRenderer.invoke('summon:boot-info'),
    introDone: () => ipcRenderer.invoke('summon:boot-intro-done'),
    checkForUpdates: () => ipcRenderer.invoke('summon:check-update'),
    installUpdate: () => ipcRenderer.invoke('summon:install-update'),
    onState: callback => { ipcRenderer.on('summon:boot-state', (_event, state) => callback(state)); },
    onUpdate: callback => { ipcRenderer.on('summon:update-state', (_event, state) => callback(state)); },
  }));
} else if (location.pathname === '/') {
  const params = new URLSearchParams(location.search);
  const onboardingWindow = params.get('onboarding_window');
  contextBridge.exposeInMainWorld('SummonDesktop', Object.freeze({
    isOnboardingWindow: Boolean(onboardingWindow),
    initialOnboardingStage: onboardingWindow || null,
    getInfo: () => ipcRenderer.invoke('summon:desktop-info'),
    getPathForFile: file => {
      try { return webUtils?.getPathForFile ? (webUtils.getPathForFile(file) || '') : ''; }
      catch { return ''; }
    },
    pickDirectory: () => ipcRenderer.invoke('summon:pick-directory'),
    openAttachment: options => ipcRenderer.invoke('summon:open-attachment', options || {}),
    morphWindow: (stage, options) => ipcRenderer.invoke('summon:morph-window', { stage, ...(options || {}) }),
    previewDesktopIntro: () => ipcRenderer.invoke('summon:preview-desktop-intro'),
    setTheme: dark => ipcRenderer.invoke('summon:set-theme', Boolean(dark)),
    checkForUpdates: () => ipcRenderer.invoke('summon:check-update'),
    installUpdate: () => ipcRenderer.invoke('summon:install-update'),
    onOpenUpdates: callback => {
      const listener = () => callback();
      ipcRenderer.on('summon:open-updates', listener);
      return () => ipcRenderer.removeListener('summon:open-updates', listener);
    },
    onInstallRequested: callback => {
      const listener = () => callback();
      ipcRenderer.on('summon:request-install', listener);
      return () => ipcRenderer.removeListener('summon:request-install', listener);
    },
    onUpdate: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('summon:update-state', listener);
      return () => ipcRenderer.removeListener('summon:update-state', listener);
    },
    onWindowActive: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, active) => callback(Boolean(active));
      ipcRenderer.on('summon:window-active', listener);
      return () => ipcRenderer.removeListener('summon:window-active', listener);
    },
    onPreviewOnboarding: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = () => callback();
      ipcRenderer.on('summon:preview-onboarding', listener);
      return () => ipcRenderer.removeListener('summon:preview-onboarding', listener);
    },
  }));
}
