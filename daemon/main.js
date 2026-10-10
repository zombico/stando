// stando daemon: owns sessions, keys and spike folders; serves clients on a Unix socket.
// Web pages can't open Unix sockets, so only local processes (the app, the CLI) can drive it.
import fs from 'node:fs';
import net from 'node:net';
import { HOME, SPIKES, SOCKET, lineReader } from '../shared/protocol.js';
import { runners, keysPublic, addKey, removeKey, hasKey, PROVIDERS, settings, saveSettings } from './config.js';
import { Session, loadAll } from './session.js';
import * as git from './git.js';

const sessions = new Map();
const subscribers = new Set();

function emit(push, payload) {
  const line = JSON.stringify({ push, ...payload }) + '\n';
  for (const sock of subscribers) sock.write(line);
}

function find(ref) {
  if (sessions.has(ref)) return sessions.get(ref);
  const list = [...sessions.values()].sort((a, b) => a.meta.created - b.meta.created);
  if (/^\d+$/.test(ref) && list[Number(ref) - 1]) return list[Number(ref) - 1];
  const matches = list.filter((s) => s.id.includes(ref));
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length ? `${matches.length} sessions match "${ref}"` : `no session matches "${ref}"`);
}

function repoCwd(ref) {
  const s = find(ref);
  if (s.meta.mode !== 'repo') throw new Error('not a repo session');
  return s.meta.cwd;
}

function checkKey(key) {
  if (key && !hasKey(key)) throw new Error(`no key named ${key}; add it with: stando keys add ${key} <provider>`);
}

const ops = {
  state: () => ({
    sessions: [...sessions.values()].map((s) => s.meta).sort((a, b) => a.created - b.created),
    runners: Object.keys(runners()),
    keys: keysPublic(),
    providers: Object.keys(PROVIDERS),
    settings: settings(),
  }),
  'settings.set': (patch) => {
    const next = saveSettings(patch);
    emit('settings', { settings: next });
    return next;
  },
  subscribe: (_args, sock) => { subscribers.add(sock); return true; },
  history: ({ session }) => {
    const s = find(session);
    return { meta: s.meta, events: s.history(), files: s.listFiles() };
  },
  create: async ({ runner = 'claude', key, model, cwd, title, prompt, images, repo, worktree, base }) => {
    checkKey(key);
    const s = await Session.create({ runner, key, model, cwd, title, prompt: prompt || (images?.length ? 'image' : ''), repo, worktree, base }, emit);
    sessions.set(s.id, s);
    if (prompt || images?.length) s.send(prompt, 'new', images);
    return s.meta;
  },
  send: ({ session, text, source, images }) => {
    if (!text?.trim() && !images?.length) throw new Error('empty message');
    const s = find(session);
    s.resume();
    s.send(text, source, images);
    return true;
  },
  update: ({ session, ...patch }) => {
    if ('key' in patch) checkKey(patch.key);
    if ('runner' in patch && !runners()[patch.runner]) throw new Error(`unknown runner ${patch.runner}`);
    find(session).update(patch);
    return true;
  },
  // Pause ends the running turn and holds the queue; sending a message or resume picks it back up.
  pause: ({ session }) => { find(session).stop(); return true; },
  stop: ({ session }) => { find(session).stop(); return true; },
  resume: ({ session }) => { find(session).resume(); return true; },
  // Close pauses the session and hides it from the list; its folder and history stay, and reopen brings it back.
  close: ({ session }) => { find(session).setClosed(true); return true; },
  reopen: ({ session }) => { find(session).setClosed(false); return true; },
  'keys.add': (args) => { addKey(args); return keysPublic(); },
  'keys.remove': ({ name }) => { removeKey(name); return keysPublic(); },
  // Git view, read-only. Runs in the session's working copy.
  'git.status': ({ session }) => git.status(repoCwd(session)),
  'git.log': ({ session, limit }) => git.log(repoCwd(session), { limit }),
  'git.commit': ({ session, hash }) => git.commitFiles(repoCwd(session), hash),
  'git.diff': ({ session, file, hash, untracked }) => git.diff(repoCwd(session), { file, hash, untracked }),
  'git.branches': ({ session }) => git.branches(repoCwd(session)),
  'git.probe': async ({ path: p }) => {
    const root = await git.repoRoot(p.replace(/^~(?=$|\/)/, process.env.HOME));
    return { root, branch: await git.currentBranch(root), branches: (await git.branches(root, { local: true })).map((b) => b.name) };
  },
  ping: () => 'pong',
};

function serve(sock) {
  sock.setEncoding('utf8');
  sock.on('data', lineReader(async (msg) => {
    const reply = (body) => sock.writable && sock.write(JSON.stringify({ re: msg.id, ...body }) + '\n');
    const op = ops[msg.op];
    if (!op) return reply({ ok: false, error: `unknown op ${msg.op}` });
    try { reply({ ok: true, data: await op(msg, sock) }); }
    catch (e) { reply({ ok: false, error: e.message }); }
  }));
  sock.on('close', () => subscribers.delete(sock));
  sock.on('error', () => subscribers.delete(sock));
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(SPIKES, { recursive: true });

  if (fs.existsSync(SOCKET)) {
    const alive = await new Promise((r) => {
      const c = net.connect(SOCKET).once('connect', () => { c.end(); r(true); }).once('error', () => r(false));
    });
    if (alive) { console.error('stando daemon already running'); process.exit(0); }
    fs.rmSync(SOCKET);
  }

  for (const s of loadAll(emit)) sessions.set(s.id, s);

  const server = net.createServer(serve);
  server.listen(SOCKET, () => {
    fs.chmodSync(SOCKET, 0o600);
    console.log(`stando daemon on ${SOCKET} — ${sessions.size} sessions, spikes in ${SPIKES}`);
  });

  const shutdown = () => {
    // Kill running turns but leave their status alone: the next start marks them interrupted.
    for (const s of sessions.values()) if (s.proc) try { process.kill(-s.proc.pid, 'SIGTERM'); } catch {}
    server.close();
    fs.rmSync(SOCKET, { force: true });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
