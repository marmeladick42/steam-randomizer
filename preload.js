const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  getConfig: () => invoke('config:get'),
  saveKey: (key) => invoke('config:saveKey', key),
  removeKey: () => invoke('config:removeKey'),
  saveProfile: (input) => invoke('config:saveProfile', input),
  saveRegion: (region) => invoke('config:saveRegion', region),
  getProfile: () => invoke('steam:profile'),
  getTags: () => invoke('steam:tags'),
  getOwned: (force) => invoke('steam:owned', force),
  roll: (payload) => invoke('steam:roll', payload),
  open: (url) => invoke('shell:open', url),
  openApp: (appid) => invoke('shell:openApp', appid),
  window: (action) => ipcRenderer.send('window:action', action),
  onRollProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('roll:progress', listener);
    return () => ipcRenderer.removeListener('roll:progress', listener);
  },
  onWindowState: (cb) => ipcRenderer.on('window:state', (_e, maximized) => cb(maximized)),
});
