const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('RelayDesktop', Object.freeze({
  getInfo: () => ipcRenderer.invoke('relay:desktop-info'),
  checkForUpdates: () => ipcRenderer.invoke('relay:check-update'),
  installUpdate: () => ipcRenderer.invoke('relay:install-update'),
  onOpenUpdates: callback => {
    const listener = () => callback();
    ipcRenderer.on('relay:open-updates', listener);
    return () => ipcRenderer.removeListener('relay:open-updates', listener);
  },
  onInstallRequested: callback => {
    const listener = () => callback();
    ipcRenderer.on('relay:request-install', listener);
    return () => ipcRenderer.removeListener('relay:request-install', listener);
  },
  onUpdate: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('relay:update-state', listener);
    return () => ipcRenderer.removeListener('relay:update-state', listener);
  },
}));
