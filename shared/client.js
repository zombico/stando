// Socket client for the daemon. Used by the CLI and by Electron's main process.
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SOCKET, lineReader } from './protocol.js';

const DAEMON = fileURLToPath(new URL('../daemon/main.js', import.meta.url));

function connectOnce() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// Starts the daemon in the background if nothing answers on the socket.
// `nodePath` lets Electron pass its own binary (run with ELECTRON_RUN_AS_NODE).
async function ensureDaemon(nodePath = process.execPath) {
  try { return await connectOnce(); } catch {}
  const child = spawn(nodePath, [DAEMON], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (!fs.existsSync(SOCKET)) continue;
    try { return await connectOnce(); } catch {}
  }
  throw new Error('stando daemon did not start; try `node daemon/main.js` to see why');
}

export async function connect({ onPush, onClose, nodePath } = {}) {
  const sock = await ensureDaemon(nodePath);
  sock.setEncoding('utf8');
  const pending = new Map();
  let next = 1;

  sock.on('data', lineReader((msg) => {
    if (msg.push) return onPush?.(msg);
    const p = pending.get(msg.re);
    if (!p) return;
    pending.delete(msg.re);
    msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
  }));
  sock.on('close', () => {
    for (const p of pending.values()) p.reject(new Error('daemon connection closed'));
    pending.clear();
    onClose?.();
  });

  return {
    call(op, args = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        sock.write(JSON.stringify({ id, op, ...args }) + '\n');
      });
    },
    close: () => sock.end(),
  };
}
