// `stando install`: builds Stando.app on this Mac from Electron's release zip and this package's own
// files, then removes everything it downloaded. Files fetched here are never quarantined, so the
// ad-hoc signed app opens without Gatekeeper's unidentified-developer prompt.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP_NAME = 'Stando.app';
const BUNDLE_ID = 'com.github.zombico.stando';
// What goes inside the app. No node_modules: stando has no runtime dependencies besides Electron.
const PAYLOAD = ['app', 'cli', 'daemon', 'shared', 'package.json', 'LICENSE'];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const ELECTRON_VERSION = pkg.devDependencies.electron.replace(/^[^\d]*/, '');

const say = (msg) => console.log(msg);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function defaultDir() {
  try { fs.accessSync('/Applications', fs.constants.W_OK); return '/Applications'; }
  catch { return path.join(os.homedir(), 'Applications'); }
}

// Electron's own npm installer leaves zips in ~/Library/Caches/electron/<hash>/; reuse one if it's there.
function cachedZip(name) {
  const base = path.join(os.homedir(), 'Library', 'Caches', 'electron');
  try {
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, name);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  let shown = -1;
  for await (const chunk of res.body) {
    out.write(chunk);
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : -1;
    if (process.stdout.isTTY && pct !== shown && pct % 5 === 0) {
      process.stdout.write(`\r  ${(got / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`);
      shown = pct;
    }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  if (process.stdout.isTTY) process.stdout.write('\n');
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Checked against the SHASUMS256.txt published with the same Electron release.
async function verify(zip, name, release) {
  const res = await fetch(`${release}/SHASUMS256.txt`);
  if (!res.ok) throw new Error(`couldn't fetch Electron's checksums (${res.status})`);
  const line = (await res.text()).split('\n').find((l) => l.trim().endsWith(' *' + name) || l.trim().endsWith(' ' + name));
  if (!line) throw new Error(`no checksum listed for ${name}`);
  const want = line.trim().split(/\s+/)[0];
  if (sha256(zip) !== want) throw new Error(`${name} failed its checksum; not installing it`);
}

function plistSet(plist, key, value) {
  try { run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]); }
  catch { run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]); }
}

// The Finder and Dock icon, built from app/icon.png with macOS's own sips and iconutil.
function makeIcns(png, dest, tmp) {
  const set = path.join(tmp, 'stando.iconset');
  fs.mkdirSync(set);
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), png, '--out', path.join(set, `icon_${size}x${size}.png`)]);
    run('sips', ['-z', String(size * 2), String(size * 2), png, '--out', path.join(set, `icon_${size}x${size}@2x.png`)]);
  }
  run('iconutil', ['-c', 'icns', set, '-o', dest]);
}

export async function install({ dir = defaultDir(), fresh = false } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error('stando install builds a macOS app. Elsewhere, run the app from a clone: npm install && npm run app');
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const name = `electron-v${ELECTRON_VERSION}-darwin-${arch}.zip`;
  const release = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stando-install-'));
  try {
    say(`Building ${APP_NAME} (stando ${pkg.version}, Electron ${ELECTRON_VERSION}, ${arch})`);
    let zip = fresh ? null : cachedZip(name);
    if (zip) {
      say(`  using Electron from ${zip}`);
    } else {
      zip = path.join(tmp, name);
      say(`  downloading Electron (about 130 MB)`);
      await download(`${release}/${name}`, zip);
    }
    say('  checking its checksum');
    await verify(zip, name, release);

    say('  assembling the app');
    const unpacked = path.join(tmp, 'unpacked');
    run('ditto', ['-x', '-k', zip, unpacked]); // ditto keeps the frameworks' symlinks intact
    const app = path.join(tmp, APP_NAME);
    fs.renameSync(path.join(unpacked, 'Electron.app'), app);
    const resources = path.join(app, 'Contents', 'Resources');
    fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
    const dest = path.join(resources, 'app');
    for (const item of PAYLOAD) {
      if (fs.existsSync(path.join(ROOT, item))) fs.cpSync(path.join(ROOT, item), path.join(dest, item), { recursive: true });
    }
    makeIcns(path.join(ROOT, 'app', 'icon.png'), path.join(resources, 'electron.icns'), tmp);
    const plist = path.join(app, 'Contents', 'Info.plist');
    plistSet(plist, 'CFBundleName', 'Stando');
    plistSet(plist, 'CFBundleDisplayName', 'Stando');
    plistSet(plist, 'CFBundleIdentifier', BUNDLE_ID);
    plistSet(plist, 'CFBundleShortVersionString', pkg.version);
    plistSet(plist, 'CFBundleVersion', pkg.version);

    say('  signing it for this Mac (ad-hoc)');
    run('codesign', ['--force', '--deep', '--sign', '-', app]);

    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, APP_NAME);
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    run('ditto', [app, target]); // works across volumes, unlike rename
    say(`Installed ${target}`);
    return target;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function uninstall({ dir } = {}) {
  const dirs = dir ? [dir] : ['/Applications', path.join(os.homedir(), 'Applications')];
  const removed = [];
  for (const d of dirs) {
    const target = path.join(d, APP_NAME);
    if (fs.existsSync(target)) { fs.rmSync(target, { recursive: true, force: true }); removed.push(target); }
  }
  return removed;
}

export function installedApp() {
  for (const d of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    const p = path.join(d, APP_NAME);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
