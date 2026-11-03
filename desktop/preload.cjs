const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SummonDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('summon:desktop-info'),
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
}));
