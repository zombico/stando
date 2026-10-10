// One session = one spike folder + a queue of turns. Each turn spawns the runner's CLI
// fresh, with the session's current key, so switching keys takes effect on the next turn.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SPIKES, OWN_FILES, lineReader } from '../shared/protocol.js';
import { HOME } from '../shared/protocol.js';
import { runners, keyEnv, recordSpend, PROVIDERS } from './config.js';
import { repoRoot, currentBranch, addWorktree, isDirty, isMerged, removeWorktree, restoreWorktree, deleteBranch, branchExists } from './git.js';

function spikeNote(meta) {
  const base = 'You are running inside stando, unattended, with approvals off. Refer to files by absolute path. ';
  if (meta.mode !== 'repo') {
    return base + `Your spike folder is ${meta.dir}. Write every file you create (scripts, images, audio, ` +
      'video, models, notes) into that folder unless the task names another place.';
  }
  return base + `You are working in the git repository at ${meta.cwd}` +
    (meta.worktree ? `, a worktree on your own branch ${meta.branch} (branched from ${meta.base}). Commit there when a step is done.` : ` on branch ${meta.branch}.`) +
    ` Do not push, and do not switch or edit other branches. Put scratch output that isn't part of the code (renders, notes, experiments) in ${meta.dir}.`;
}

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'spike';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// The CLI gets the operator's environment minus every credential stando manages and
// minus Claude Code's own session markers, plus the chosen key. No key = the CLI's own login.
function childEnv(key) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_') || name === 'ELECTRON_RUN_AS_NODE') delete env[name];
  }
  for (const v of Object.values(PROVIDERS)) delete env[v];
  delete env.ANTHROPIC_AUTH_TOKEN;
  return { ...env, ...keyEnv(key) };
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? (c.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

export class Session {
  constructor(dir, meta, emit) {
    this.dir = dir;
    this.meta = meta;
    this.emit = emit; // (kind, payload) → pushes to subscribed clients
    this.proc = null;
    this.seen = new Map(); // file → size, so `file` events fire on new or changed files only
  }

  get id() { return this.meta.id; }

  // mode "fresh": the agent works in its own spike folder.
  // mode "repo": the agent works in a git repository, by default on a new branch in its own worktree
  // (~/.stando/worktrees/<id>) so parallel sessions never share a working copy.
  static async create({ runner, key, model, cwd, title, prompt, repo, worktree = true, base }, emit) {
    if (!runners()[runner]) throw new Error(`unknown runner ${runner}; have ${Object.keys(runners()).join(', ')}`);
    const repoPath = repo || cwd;
    const root = repoPath ? await repoRoot(path.resolve(repoPath.replace(/^~(?=$|\/)/, process.env.HOME))).catch((e) => { if (repo) throw e; return null; }) : null;

    let id = `${stamp()}-${slugify(title || prompt || runner)}`;
    for (let i = 2; fs.existsSync(path.join(SPIKES, id)); i++) id = id.replace(/~\d+$/, '') + `~${i}`;
    const dir = path.join(SPIKES, id);
    fs.mkdirSync(dir, { recursive: true });
    const meta = {
      id, dir, runner, key: key || null, model: model || null,
      mode: root ? 'repo' : 'fresh',
      cwd: cwd && !root ? path.resolve(cwd) : dir,
      title: title || (prompt ? prompt.slice(0, 60) : id),
      status: 'idle', created: Date.now(), cliSession: null, inboxRead: 0, cost: 0,
    };
    if (root) {
      meta.repo = root;
      meta.base = base || await currentBranch(root);
      if (worktree) {
        meta.branch = `stando/${id}`;
        meta.worktree = path.join(HOME, 'worktrees', id);
        try { await addWorktree({ root, worktree: meta.worktree, branch: meta.branch, base: meta.base }); }
        catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(`couldn't create a worktree: ${e.message}`); }
        meta.cwd = meta.worktree;
      } else {
        meta.branch = meta.base;
        meta.cwd = root;
      }
    }
    const s = new Session(dir, meta, emit);
    s.saveMeta();
    s.watch();
    return s;
  }

  static load(dir, emit) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
    const s = new Session(dir, meta, emit);
    if (meta.status === 'running') {
      meta.status = 'idle';
      s.append({ t: 'note', text: 'stando restarted; the turn in progress was interrupted.' });
    }
    s.saveMeta();
    for (const f of s.listFiles()) s.seen.set(f.path, f.size);
    s.watch();
    s.pump();
    return s;
  }

  // ---------- state ----------

  saveMeta() {
    const file = path.join(this.dir, 'session.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.meta, null, 2));
    fs.renameSync(file + '.tmp', file);
    this.emit('meta', { meta: this.meta });
  }

  update(patch) {
    const allowed = ['key', 'model', 'title', 'runner'];
    for (const k of allowed) if (k in patch) this.meta[k] = patch[k] || null;
    if ('runner' in patch) this.meta.cliSession = null; // a different CLI can't resume the old one
    this.saveMeta();
  }

  append(ev) {
    ev.ts ??= Date.now();
    fs.appendFileSync(path.join(this.dir, 'events.jsonl'), JSON.stringify(ev) + '\n');
    this.emit('event', { session: this.id, event: ev });
  }

  history() {
    try {
      return fs.readFileSync(path.join(this.dir, 'events.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch { return []; }
  }

  listFiles() {
    const out = [];
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && !(d === this.dir && OWN_FILES.has(e.name))) out.push({ path: p, size: fs.statSync(p).size });
      }
    };
    try { walk(this.dir, 0); } catch {}
    return out;
  }

  // ---------- inbox ----------

  // Anything may append to inbox.jsonl (this daemon, a script, another tool); pump() drains it in order.
  // `images` are absolute paths, or uploads ({name, data: base64} or {path}) saved into uploads/ first.
  send(text, source = 'app', images = []) {
    const paths = this.saveImages(images);
    const line = { text: text || '', source, ts: Date.now() };
    if (paths.length) line.images = paths;
    fs.appendFileSync(path.join(this.dir, 'inbox.jsonl'), JSON.stringify(line) + '\n');
    this.pump();
  }

  saveImages(images) {
    if (!images?.length) return [];
    const dir = path.join(this.dir, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    return images.map((img, i) => {
      if (typeof img === 'string') return img;
      const name = path.basename(img.name || img.path || `image-${i}.png`).replace(/[^\w.\-]+/g, '_').slice(-80);
      const dest = path.join(dir, `${Date.now()}-${i}-${name}`);
      if (img.path) fs.copyFileSync(img.path, dest);
      else fs.writeFileSync(dest, Buffer.from(img.data, 'base64'));
      return dest;
    });
  }

  pump() {
    if (this.proc || this.meta.status === 'paused' || this.meta.worktreeGone) return;
    let lines = [];
    try { lines = fs.readFileSync(path.join(this.dir, 'inbox.jsonl'), 'utf8').split('\n').filter(Boolean); } catch {}
    if (lines.length <= this.meta.inboxRead) return;
    let msg;
    try { msg = JSON.parse(lines[this.meta.inboxRead]); } catch { msg = { text: lines[this.meta.inboxRead], source: 'inbox' }; }
    this.meta.inboxRead++;
    this.runTurn(msg);
  }

  // ---------- turns ----------

  runTurn({ text, source, images = [] }) {
    const runner = runners()[this.meta.runner];
    // CLIs take images as files: the agent reads the paths with its own file tools.
    const prompt = images.length
      ? `${text}\n\nAttached image${images.length > 1 ? 's' : ''} (open and look at ${images.length > 1 ? 'them' : 'it'}):\n${images.join('\n')}`.trim()
      : text;
    const fill = (a) => a.replace('{prompt}', prompt).replace('{session}', this.meta.cliSession || '');
    const argv = runner.argv.map(fill);
    if (this.meta.cliSession && runner.resume) argv.push(...runner.resume.map(fill));
    if (this.meta.model && runner.modelFlag) argv.push(runner.modelFlag, this.meta.model);
    if (this.meta.runner === 'claude') {
      argv.push('--append-system-prompt', spikeNote(this.meta));
      if (this.meta.cwd !== this.dir) argv.push('--add-dir', this.dir); // so it can read uploads and write scratch
    }

    this.append(images.length ? { t: 'user', text, source, images } : { t: 'user', text, source });
    this.append({ t: 'turn_start', runner: this.meta.runner, key: this.meta.key, model: this.meta.model });
    this.meta.status = 'running';
    this.saveMeta();

    const started = Date.now();
    let cost = null;
    let error = null;
    let proc;
    try {
      proc = spawn(argv[0], argv.slice(1), {
        cwd: this.meta.cwd, env: childEnv(this.meta.key), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      });
    } catch (e) {
      return this.finish({ error: e.message, exit: -1, started, cost });
    }
    this.proc = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    if (runner.kind === 'stream-json') {
      proc.stdout.on('data', lineReader(
        (m) => { const r = this.onStreamEvent(m); if (r) ({ cost, error } = { cost: r.cost ?? cost, error: r.error ?? error }); },
        (line) => this.append({ t: 'text', text: line }),
      ));
    } else {
      let buf = '';
      let timer = null;
      const flush = () => { if (buf) this.append({ t: 'text', text: buf }); buf = ''; timer = null; };
      proc.stdout.on('data', (d) => { buf += d; timer ??= setTimeout(flush, 400); });
      proc.on('close', flush);
    }
    proc.stderr.on('data', lineReader(() => {}, (line) => this.append({ t: 'stderr', text: line })));
    proc.on('error', (e) => { error = e.code === 'ENOENT' ? `${argv[0]} is not installed or not on PATH` : e.message; });
    proc.on('close', (code) => this.finish({ error, exit: code, started, cost }));
  }

  onStreamEvent(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (m.session_id && m.session_id !== this.meta.cliSession) { this.meta.cliSession = m.session_id; this.saveMeta(); }
      return null;
    }
    if (m.type === 'assistant') {
      for (const b of m.message?.content || []) {
        if (b.type === 'text' && b.text) this.append({ t: 'text', text: b.text });
        else if (b.type === 'tool_use') this.append({ t: 'tool', id: b.id, name: b.name, input: b.input });
      }
      return null;
    }
    if (m.type === 'user') {
      for (const b of m.message?.content || []) {
        if (b.type === 'tool_result') {
          this.append({ t: 'tool_result', id: b.tool_use_id, text: resultText(b.content).slice(0, 8000), error: !!b.is_error });
        }
      }
      return null;
    }
    if (m.type === 'result') {
      return { cost: m.total_cost_usd ?? null, error: m.is_error ? (m.result || m.subtype || 'error') : null };
    }
    return null;
  }

  finish({ error, exit, started, cost }) {
    this.proc = null;
    if (cost) {
      recordSpend(this.meta.key, cost);
      this.meta.cost = (this.meta.cost || 0) + cost;
    }
    const paused = this.meta.status === 'paused';
    this.append({ t: 'turn_end', cost, ms: Date.now() - started, exit, error: paused ? 'paused' : (error || (exit ? `exited with ${exit}` : null)) });
    if (!paused) this.meta.status = 'idle';
    this.saveMeta();
    if (!paused) this.pump();
  }

  stop() {
    this.meta.status = 'paused';
    this.saveMeta();
    if (this.proc) {
      try { process.kill(-this.proc.pid, 'SIGTERM'); } catch {}
    }
  }

  resume() {
    if (this.meta.closed) this.meta.closed = false;
    if (this.meta.status === 'paused') this.meta.status = 'idle';
    this.saveMeta();
    this.pump();
  }

  // ---------- worktree lifecycle ----------

  // Removes this session's worktree and, if asked, its branch. Refuses to lose work unless forced:
  // uncommitted changes, or deleting a branch that isn't merged into its base.
  async cleanUp({ deleteBranch: dropBranch = false, force = false } = {}) {
    const m = this.meta;
    if (m.mode !== 'repo' || !m.worktree) throw new Error('only sessions with their own worktree can be cleaned up');
    if (this.proc) throw new Error('pause the session first');
    if (!m.worktreeGone && fs.existsSync(m.worktree) && !force && await isDirty(m.worktree)) {
      throw new Error('the worktree has uncommitted changes; commit or discard them, or force');
    }
    const merged = await isMerged(m.repo, m.branch, m.base);
    if (dropBranch && !merged && !force) throw new Error(`${m.branch} isn't merged into ${m.base}; merge it, keep the branch, or force`);

    if (!m.worktreeGone) await removeWorktree(m.repo, m.worktree, { force });
    m.worktreeGone = true;
    if (dropBranch && await branchExists(m.repo, m.branch)) {
      await deleteBranch(m.repo, m.branch, { force: !merged });
      m.branchDeleted = true;
    }
    m.closed = true;
    if (m.status !== 'paused') m.status = 'paused';
    this.append({ t: 'note', text: `Worktree removed${m.branchDeleted ? ` and branch ${m.branch} deleted` : `; branch ${m.branch} kept`}.` });
    this.saveMeta();
    return { merged, branchDeleted: !!m.branchDeleted };
  }

  // Brings a cleaned-up session back to life if its branch still exists.
  async ensureWorktree() {
    const m = this.meta;
    if (!m.worktreeGone) return;
    if (m.branchDeleted || !await branchExists(m.repo, m.branch)) {
      throw new Error(`branch ${m.branch} no longer exists; start a new session instead`);
    }
    await restoreWorktree(m.repo, m.worktree, m.branch);
    m.worktreeGone = false;
    this.append({ t: 'note', text: `Worktree restored from ${m.branch}.` });
    this.saveMeta();
  }

  setClosed(closed) {
    if (closed) {
      if (this.meta.status !== 'paused') this.stop();
      this.meta.closed = true;
      this.saveMeta();
    } else {
      this.meta.closed = false;
      this.resume();
    }
  }

  // ---------- files ----------

  watch() {
    const timers = new Map();
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_type, rel) => {
        if (!rel) return;
        if (rel === 'inbox.jsonl') return this.pump();
        if (rel.startsWith('uploads' + path.sep)) return; // shown with the message that sent them
        if (OWN_FILES.has(rel) || rel.split(path.sep).some((p) => p.startsWith('.') || p === 'node_modules')) return;
        clearTimeout(timers.get(rel));
        timers.set(rel, setTimeout(() => this.noticeFile(path.join(this.dir, rel)), 500));
      });
    } catch (e) {
      this.append({ t: 'note', text: `can't watch the spike folder: ${e.message}` });
    }
  }

  noticeFile(p) {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (!st.isFile() || this.seen.get(p) === st.size) return;
    this.seen.set(p, st.size);
    this.append({ t: 'file', path: p, size: st.size });
  }

  close() {
    this.watcher?.close();
  }
}

export function loadAll(emit) {
  if (!fs.existsSync(SPIKES)) return [];
  return fs.readdirSync(SPIKES)
    .map((name) => path.join(SPIKES, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'session.json')))
    .map((dir) => { try { return Session.load(dir, emit); } catch { return null; } })
    .filter(Boolean);
}
