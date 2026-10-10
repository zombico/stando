// stando daemon: owns sessions, keys and spike folders; serves clients on a Unix socket.
// Web pages can't open Unix sockets, so only local processes (the app, the CLI) can drive it.
import fs from 'node:fs';
import net from 'node:net';
import { HOME, SPIKES, SOCKET, lineReader } from '../shared/protocol.js';
import { runners, runnersPublic, checkEffort, keysPublic, addKey, removeKey, hasKey, PROVIDERS, settings, saveSettings, themeCss } from './config.js';
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
  if (s.meta.worktreeGone) throw new Error('this session\'s worktree was removed; reopen it to restore');
  return s.meta.cwd;
}

function checkKey(key) {
  if (key && !hasKey(key)) throw new Error(`no key named ${key}; add it with: stando keys add ${key} <provider>`);
}

const ops = {
  state: () => ({
    sessions: [...sessions.values()].map((s) => s.meta).sort((a, b) => a.created - b.created),
    runners: Object.keys(runners()),
    runnerInfo: runnersPublic(),
    keys: keysPublic(),
    providers: Object.keys(PROVIDERS),
    settings: settings(),
  }),
  'settings.set': (patch) => {
    const next = saveSettings(patch);
    emit('settings', { settings: next });
    return next;
  },
  'theme.css': () => themeCss(),
  subscribe: (_args, sock) => { subscribers.add(sock); return true; },
  history: ({ session }) => {
    const s = find(session);
    return { meta: s.meta, events: s.history(), files: s.listFiles() };
  },
  create: async ({ runner = 'claude', key, model, effort, cwd, title, prompt, images, repo, worktree, base }) => {
    checkKey(key);
    if (!runners()[runner]) throw new Error(`unknown runner ${runner}; have ${Object.keys(runners()).join(', ')}`);
    checkEffort(runner, effort);
    const s = await Session.create({ runner, key, model, effort, cwd, title, prompt: prompt || (images?.length ? 'image' : ''), repo, worktree, base }, emit);
    sessions.set(s.id, s);
    if (prompt || images?.length) s.send(prompt, 'new', images);
    return s.meta;
  },
  send: async ({ session, text, source, images }) => {
    if (!text?.trim() && !images?.length) throw new Error('empty message');
    const s = find(session);
    await s.ensureWorktree();
    s.resume();
    s.send(text, source, images);
    return true;
  },
  update: ({ session, ...patch }) => {
    if ('key' in patch) checkKey(patch.key);
    if ('runner' in patch && !runners()[patch.runner]) throw new Error(`unknown runner ${patch.runner}`);
    const s = find(session);
    if (patch.effort) checkEffort(patch.runner || s.meta.runner, patch.effort);
    s.update(patch);
    return true;
  },
  // Pause ends the running turn and holds the queue; sending a message or resume picks it back up.
  pause: ({ session }) => { find(session).stop(); return true; },
  stop: ({ session }) => { find(session).stop(); return true; },
  resume: async ({ session }) => { const s = find(session); await s.ensureWorktree(); s.resume(); return true; },
  // Close pauses the session and hides it from the list; its folder and history stay, and reopen brings it back.
  close: ({ session }) => { find(session).setClosed(true); return true; },
  reopen: async ({ session }) => { const s = find(session); await s.ensureWorktree(); s.setClosed(false); return true; },
  'keys.add': (args) => { addKey(args); return keysPublic(); },
  'keys.remove': ({ name }) => { removeKey(name); return keysPublic(); },
  // Git view, read-only. Runs in the session's working copy.
  'git.status': ({ session }) => git.status(repoCwd(session)),
  'git.log': ({ session, limit, refs }) => git.log(repoCwd(session), { limit, refs }),
  'git.commit': ({ session, hash }) => git.commitFiles(repoCwd(session), hash),
  'git.diff': ({ session, file, hash, untracked }) => git.diff(repoCwd(session), { file, hash, untracked }),
  'git.branches': ({ session }) => git.branches(repoCwd(session)),
  'git.stage': ({ session, files, all }) => (all ? git.stageAll(repoCwd(session)) : git.stage(repoCwd(session), files)),
  'git.unstage': ({ session, files, all }) => (all ? git.unstageAll(repoCwd(session)) : git.unstage(repoCwd(session), files)),
  'git.discard': ({ session, file, untracked }) => git.discard(repoCwd(session), file, untracked),
  'git.commitChanges': async ({ session, message }) => {
    const s = find(session);
    const hash = await git.commit(repoCwd(session), message);
    s.append({ t: 'note', text: `Committed ${hash}: ${message.trim().split('\n')[0]}` });
    return hash;
  },
  'git.merge': async ({ session }) => {
    const s = find(session);
    const m = s.meta;
    if (!m.worktree) throw new Error('this session works on the base branch directly; there is nothing to merge');
    if (s.proc) throw new Error('pause the session first');
    const hash = await git.mergeInto(m.repo, m.branch, m.base);
    s.append({ t: 'note', text: `Merged ${m.branch} into ${m.base} (${hash}).` });
    return hash;
  },
  'git.push': async ({ session }) => {
    const s = find(session);
    await git.push(repoCwd(session), s.meta.branch);
    s.append({ t: 'note', text: `Pushed ${s.meta.branch} to origin.` });
    return true;
  },
  'git.merged': async ({ session }) => {
    const m = find(session).meta;
    return m.worktree ? git.isMerged(m.repo, m.branch, m.base) : null;
  },
  cleanup: ({ session, deleteBranch, force }) => find(session).cleanUp({ deleteBranch, force }),
  // Bulk cleanup for closed sessions. Only sessions that are safe to clean (worktree clean,
  // branch merged) are touched unless forced; dryRun reports without changing anything.
  clean: async ({ dryRun = false, force = false, all = false }) => {
    const report = [];
    for (const s of sessions.values()) {
      const m = s.meta;
      if (m.mode !== 'repo' || !m.worktree || m.worktreeGone) continue;
      if (!m.closed && !all) continue;
      if (s.proc) { report.push({ id: m.id, action: 'skip', reason: 'running' }); continue; }
      let dirty = false;
      try { dirty = fs.existsSync(m.worktree) && await git.isDirty(m.worktree); } catch {}
      const merged = await git.isMerged(m.repo, m.branch, m.base).catch(() => false);
      if (!force && (dirty || !merged)) {
        report.push({ id: m.id, action: 'skip', reason: dirty ? 'uncommitted changes' : `not merged into ${m.base}` });
        continue;
      }
      if (dryRun) { report.push({ id: m.id, action: 'would remove', branch: merged ? 'delete' : 'keep' }); continue; }
      try {
        await s.cleanUp({ deleteBranch: merged, force });
        report.push({ id: m.id, action: 'removed', branch: merged ? 'deleted' : 'kept' });
      } catch (e) { report.push({ id: m.id, action: 'failed', reason: e.message }); }
    }
    return report;
  },
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
