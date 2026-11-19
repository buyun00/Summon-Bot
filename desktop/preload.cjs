const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'summon-setup:' && location.host === 'connection') {
  contextBridge.exposeInMainWorld('SummonSetup', Object.freeze({
    info: () => ipcRenderer.invoke('summon:connection-info'),
    checkForUpdates: () => ipcRenderer.invoke('summon:check-update'),
    installUpdate: () => ipcRenderer.invoke('summon:install-update'),
    onUpdate: callback => { ipcRenderer.on('summon:update-state', (_event, state) => callback(state)); },
    action: (command, input) => ipcRenderer.invoke('summon:connection-action', command, input),
    onSetup: callback => { ipcRenderer.on('summon:connection-setup-state', () => callback()); },
  }));
} else if (location.pathname === '/') contextBridge.exposeInMainWorld('SummonDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('summon:desktop-info'),
  setTheme: dark => ipcRenderer.invoke('summon:set-theme', Boolean(dark)),
  checkForUpdates: () => ipcRenderer.invoke('summon:check-update'),
  installUpdate: () => ipcRenderer.invoke('summon:install-update'),
  openConnectionSettings: section => ipcRenderer.invoke('summon:open-connection-setup', section),
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
}));
