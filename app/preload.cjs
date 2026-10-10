// The only bridge between the page and the system. The page can call daemon ops and
// open files or links; it has no Node, no network and never sees key values.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('stando', {
  call: (op, args) => ipcRenderer.invoke('call', op, args),
  open: (target) => ipcRenderer.invoke('open', target),
  reveal: (target) => ipcRenderer.invoke('reveal', target),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  openInEditor: (dir) => ipcRenderer.invoke('openInEditor', dir),
  onPush: (fn) => ipcRenderer.on('push', (_e, msg) => fn(msg)),
});
