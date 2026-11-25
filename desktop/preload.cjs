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
  const introMode = params.get('desktop_intro');
  contextBridge.exposeInMainWorld('SummonDesktop', Object.freeze({
    isIntroWindow: Boolean(introMode),
    introMode: introMode || null,
    getInfo: () => ipcRenderer.invoke('summon:desktop-info'),
    getPathForFile: file => {
      try { return webUtils?.getPathForFile ? (webUtils.getPathForFile(file) || '') : ''; }
      catch { return ''; }
    },
    pickDirectory: () => ipcRenderer.invoke('summon:pick-directory'),
    previewDesktopIntro: () => ipcRenderer.invoke('summon:preview-desktop-intro'),
    settleIntroWindow: size => ipcRenderer.invoke('summon:intro-settle-window', size || {}),
    prepareIntroHandoff: options => ipcRenderer.invoke('summon:intro-prepare-handoff', options || {}),
    expandIntroHandoff: () => ipcRenderer.invoke('summon:intro-expand-handoff'),
    finishIntroHandoff: () => ipcRenderer.invoke('summon:intro-finish-handoff'),
    closeIntroWindow: () => ipcRenderer.invoke('summon:intro-close'),
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
    onStartOnboardingFocus: callback => {
      if (typeof callback !== 'function') return () => {};
      const listener = (_event, detail) => callback(detail);
      ipcRenderer.on('summon:start-onboarding-focus', listener);
      return () => ipcRenderer.removeListener('summon:start-onboarding-focus', listener);
    },
  }));
}
