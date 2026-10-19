const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // State: the whole picture on load, then every change pushed by the main process
  getState: () => ipcRenderer.invoke('state:get'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state)),

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // Inventory
  refreshInventory: () => ipcRenderer.send('inventory:refresh'),
  toggleLock: (typeId) => ipcRenderer.send('furni:lock', typeId),

  // Recycling queue
  toggleQueue: (typeId) => ipcRenderer.send('queue:toggle', typeId),
  addManyToQueue: (typeIds) => ipcRenderer.send('queue:addMany', typeIds),
  setKeep: (typeId, keep) => ipcRenderer.send('queue:keep', typeId, keep),
  toggleAllowed: (typeId) => ipcRenderer.send('queue:allow', typeId),
  allowMany: (typeIds) => ipcRenderer.send('queue:allowMany', typeIds),
  removeFromQueue: (typeId) => ipcRenderer.send('queue:remove', typeId),
  clearQueue: () => ipcRenderer.send('queue:clear'),

  // Furni-Matic
  start: () => ipcRenderer.send('recycler:start'),
  recycleOnce: () => ipcRenderer.send('recycler:once'),
  stop: () => ipcRenderer.send('recycler:stop'),

  // Prize boxes: placed on a tile of a room you own, opened, prize picked back up
  openBoxes: () => ipcRenderer.send('boxes:open'),
  stopBoxes: () => ipcRenderer.send('boxes:stop'),
  pickSpot: (picking) => ipcRenderer.send('boxes:pickSpot', picking),

  updateSettings: (patch) => ipcRenderer.send('settings:update', patch),
});
