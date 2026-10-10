// Electron main process: a thin client. It connects to the daemon's socket and relays
// calls and pushes to the window over IPC; closing the app never stops a session.
import { app, BrowserWindow, ipcMain, shell, Notification, dialog } from 'electron';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../shared/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let client = null;
let reconnecting = null;

async function link() {
  client = await connect({
    nodePath: process.execPath, // Electron's binary, run as plain Node via ELECTRON_RUN_AS_NODE
    onPush: (msg) => {
      win?.webContents.send('push', msg);
      if (msg.push === 'event' && msg.event.t === 'turn_end' && !win?.isFocused()) notifyDone(msg);
    },
    onClose: () => {
      client = null;
      win?.webContents.send('push', { push: 'disconnected' });
      reconnect();
    },
  });
  await client.call('subscribe');
  win?.webContents.send('push', { push: 'connected' });
}

function reconnect() {
  if (reconnecting) return;
  reconnecting = setTimeout(async () => {
    reconnecting = null;
    try { await link(); } catch { reconnect(); }
  }, 1500);
}

function notifyDone({ session, event }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: event.error ? `${session} stopped` : `${session} finished`,
    body: event.error || (event.cost != null ? `$${event.cost.toFixed(2)}` : 'turn done'),
    silent: false,
  });
  n.on('click', () => { win?.show(); win?.webContents.send('push', { push: 'focus', session }); });
  n.show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    title: 'stando',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#07090c',
    icon: path.join(here, 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(here, 'index.html'));
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

ipcMain.handle('call', async (_e, op, args) => {
  if (!client) throw new Error('not connected to the stando daemon');
  return client.call(op, args);
});
ipcMain.handle('open', (_e, target) => {
  if (/^https?:\/\//.test(target)) return shell.openExternal(target);
  return shell.openPath(target);
});
ipcMain.handle('reveal', (_e, target) => shell.showItemInFolder(target));
ipcMain.handle('pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], message: 'Choose a git repository' });
  return r.canceled ? null : r.filePaths[0];
});
// VS Code's own CLI if it's on PATH, otherwise the app by name.
ipcMain.handle('openInEditor', (_e, dir) => new Promise((resolve) => {
  execFile('code', [dir], (err) => {
    if (!err) return resolve(true);
    execFile('open', ['-a', 'Visual Studio Code', dir], (err2) => resolve(!err2 || shell.openPath(dir)));
  });
}));

app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock.setIcon(path.join(here, 'icon.png'));
  createWindow();
  try { await link(); } catch (e) {
    win.webContents.once('did-finish-load', () => win.webContents.send('push', { push: 'error', error: e.message }));
    reconnect();
  }
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
