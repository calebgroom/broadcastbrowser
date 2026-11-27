// The control window's bridge to the app (main.js), and the pop-out windows': commands, status, the two
// monitors' pictures and the picture held on air.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('playout', {
  control: () => ipcRenderer.invoke('control'),
  onControl: (fn) => ipcRenderer.on('control', (_e, urls) => fn(urls)),
  openControl: (url) => ipcRenderer.invoke('open-control', url),
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  command: (name, args) => ipcRenderer.invoke('command', name, args ?? {}),
  onStatus: (fn) => ipcRenderer.on('status', (_e, s) => fn(s)),
  onMonitor: (fn) => ipcRenderer.on('monitor', (_e, m) => fn(m.role, m.jpeg)),
  onHeld: (fn) => ipcRenderer.on('held', (_e, p) => fn(p)),
  onThumb: (fn) => ipcRenderer.on('thumb', (_e, t) => fn(t)),
  onFocusUrl: (fn) => ipcRenderer.on('focus-url', () => fn()),
  popout: (key) => ipcRenderer.invoke('popout', key),
  onFind: (fn) => ipcRenderer.on('find', () => fn()),
});
