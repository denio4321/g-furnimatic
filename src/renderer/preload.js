const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window controls
  minimize: () => ipcRenderer.send('minimize'),
  maximize: () => ipcRenderer.send('maximize'),
  close: () => ipcRenderer.send('close'),

  // Window behavior
  alwaysOntop: (checked) => ipcRenderer.send('alwaysOnTop', checked),

  // Inventory refresh
  refresh: () => ipcRenderer.send('refresh'),

  // Cards & furnidata
  onLoadCards: (callback) =>
    ipcRenderer.on('load-cards', (_event, data) => callback(data)),

  furniDataLoaded: (callback) =>
    ipcRenderer.on('furni-data-loaded', (_event, status) => callback(status)),

  // Recycling queue
  addToRecycleQueue: (card) => ipcRenderer.invoke('recycle:add', card),
  removeFromRecycleQueue: (name) => ipcRenderer.invoke('recycle:remove', name),
  clearRecycleQueue: () => ipcRenderer.invoke('recycle:clear'),
  onRecycleListUpdate: (callback) =>
    ipcRenderer.on('recycle-list:update', (_event, list) => callback(list)),
});
