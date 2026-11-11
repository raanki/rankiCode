const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: cfg => ipcRenderer.invoke('config:save', cfg),
  status: id => ipcRenderer.invoke('machine:status', id),
  start: id => ipcRenderer.invoke('machine:start', id),
  stop: id => ipcRenderer.invoke('machine:stop', id),
  metrics: id => ipcRenderer.invoke('machine:metrics', id),
  listConvs: () => ipcRenderer.invoke('conv:list'),
  loadConv: id => ipcRenderer.invoke('conv:load', id),
  saveConv: conv => ipcRenderer.invoke('conv:save', conv),
  deleteConv: id => ipcRenderer.invoke('conv:delete', id),
  chat: payload => ipcRenderer.invoke('chat', payload),
  exec: command => ipcRenderer.invoke('exec', command),
  browser: (name, args) => ipcRenderer.invoke('browser', { name, args }),
  sysinfo: () => ipcRenderer.invoke('sysinfo'),
  pickFiles: () => ipcRenderer.invoke('file:pick'),
  readFile: file => ipcRenderer.invoke('file:read', file),
  pathOf: file => webUtils.getPathForFile(file),
  onProgress: cb => ipcRenderer.on('machine:progress', (_, text) => cb(text)),
  onChatStatus: cb => ipcRenderer.on('chat:status', (_, text) => cb(text)),
  onChunk: cb => ipcRenderer.on('chat:chunk', (_, c) => cb(c))
});
