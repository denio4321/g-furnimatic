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

  // Recycle
  recycle: () => ipcRenderer.send('recycle'),

  // Cards & furnidata
  onLoadCards: (callback) =>
    ipcRenderer.on('load-cards', (_event, data) => callback(data)),

  furniDataLoaded: (callback) =>
    ipcRenderer.on('furni-data-loaded', (_event, status) => callback(status)),

  onRecycleOn: (callback) => ipcRenderer.on('on-recycle-on', callback),
  onRecycleOff: (callback) => ipcRenderer.on('on-recycle-off', callback),

  // Recycling queue
  addToRecycleQueue: (card) => ipcRenderer.invoke('recycle:add', card),
  removeFromRecycleQueue: (typeId, name) => ipcRenderer.invoke('recycle:remove', typeId, name),
  clearRecycleQueue: () => ipcRenderer.invoke('recycle:clear'),
  onRecycleListUpdate: (callback) =>
    ipcRenderer.on('recycle-list:update', (_event, list) => callback(list)),
updateRecycleQuantity: (typeId, qty) => ipcRenderer.invoke('recycle:update', typeId, qty),

});
