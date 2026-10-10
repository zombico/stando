// Read-only git for the app's git view, plus worktree setup for repo sessions.
// Every call goes through execFile with an argument list; nothing is passed to a shell.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX = 32 * 1024 * 1024;

function git(cwd, args, { okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: MAX, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (!okCodes.includes(code)) return reject(new Error((stderr || err?.message || 'git failed').trim()));
      resolve(stdout);
    });
  });
}

export async function repoRoot(dir) {
  try { return (await git(dir, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { throw new Error(`${dir} is not inside a git repository`); }
}

export async function currentBranch(dir) {
  const b = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  return b === 'HEAD' ? (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim() : b;
}

// A new branch checked out in its own folder, so this session's agent never touches
// the operator's working copy or another session's files.
export async function addWorktree({ root, worktree, branch, base }) {
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  await git(root, ['worktree', 'add', '-b', branch, worktree, base || 'HEAD']);
}

// ---------- the view ----------

export async function status(dir) {
  const out = await git(dir, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']);
  const info = { branch: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) info.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) info.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const [, a, b] = line.match(/\+(\d+) -(\d+)/) || [];
      info.ahead = Number(a) || 0;
      info.behind = Number(b) || 0;
    } else if (line[0] === '1' || line[0] === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const file = line[0] === '1' ? f.slice(8).join(' ') : f.slice(9).join(' ');
      const from = line[0] === '2' ? parts[++i] : null;
      info.files.push({ path: file, from, staged: xy[0] !== '.' ? xy[0] : null, unstaged: xy[1] !== '.' ? xy[1] : null });
    } else if (line[0] === 'u') {
      info.files.push({ path: line.split(' ').slice(10).join(' '), staged: 'U', unstaged: 'U', conflict: true });
    } else if (line[0] === '?') {
      info.files.push({ path: line.slice(2), untracked: true, unstaged: 'U' });
    }
  }
  return info;
}

const SEP = '\x1f';

// Commits newest first in topological order; the app draws the lanes. `refs` limits the graph to
// those branches (and their history); without it, every branch is included.
export async function log(dir, { limit = 300, refs } = {}) {
  const fmt = ['%H', '%P', '%an', '%ae', '%at', '%D', '%s'].join(SEP);
  const which = refs?.length ? refs.filter((r) => /^[\w./-]+$/.test(r) && !r.startsWith('-')) : ['--all'];
  if (!which.length) throw new Error('no valid branch names to show');
  const out = await git(dir, ['log', ...which, '--topo-order', `--max-count=${limit}`, `--format=${fmt}`, '--no-show-signature', '--']);
  const head = (await git(dir, ['rev-parse', 'HEAD'], { okCodes: [0, 128] })).trim();
  return {
    head,
    commits: out.split('\n').filter(Boolean).map((l) => {
      const [hash, parents, author, email, at, refs, subject] = l.split(SEP);
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        at: Number(at) * 1000,
        refs: refs ? refs.split(', ').filter((r) => r !== 'refs/stash') : [],
        subject,
      };
    }),
  };
}

export async function commitFiles(dir, hash) {
  const body = (await git(dir, ['show', '-s', '--format=%B', hash])).trim();
  const short = (await git(dir, ['show', '--shortstat', '--format=', '--first-parent', hash])).trim();
  const num = (re) => Number(short.match(re)?.[1] || 0);
  const stat = { files: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?/), deletions: num(/(\d+) deletions?/) };
  const out = await git(dir, ['diff-tree', '--no-commit-id', '-r', '--root', '--name-status', '-z', '-m', '--first-parent', hash]);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (st[0] === 'R' || st[0] === 'C') files.push({ status: st[0], from: parts[++i], path: parts[++i] });
    else files.push({ status: st[0], path: parts[++i] });
  }
  return { body, files, stat };
}

// Unified diff of one file: in the working tree (hash empty) or in a commit.
export async function diff(dir, { file, hash, untracked }) {
  if (hash) return git(dir, ['show', '--format=', '--first-parent', '--no-color', hash, '--', file]);
  if (untracked) return git(dir, ['diff', '--no-color', '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] });
  return git(dir, ['diff', '--no-color', 'HEAD', '--', file], { okCodes: [0, 1] });
}

export async function branches(dir, { local = false } = {}) {
  const refs = local ? ['refs/heads'] : ['refs/heads', 'refs/remotes'];
  const out = await git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\x1f%(objectname)\x1f%(HEAD)', ...refs]);
  return out.split('\n').filter(Boolean).map((l) => {
    const [name, hash, head] = l.split(SEP);
    return { name, hash, current: head === '*' };
  }).filter((b) => !b.name.endsWith('/HEAD'));
}

// ---------- changes (the session's own working copy) ----------

export const stage = (dir, files) => git(dir, ['add', '--', ...files]);
export const stageAll = (dir) => git(dir, ['add', '-A']);
export const unstage = (dir, files) => git(dir, ['restore', '--staged', '--', ...files]);
export const unstageAll = (dir) => git(dir, ['reset', '-q']);

// Throws away a file's changes. Untracked files are deleted; the path must stay inside `dir`.
export async function discard(dir, file, untracked) {
  if (untracked) {
    const abs = path.resolve(dir, file);
    if (!abs.startsWith(path.resolve(dir) + path.sep)) throw new Error('path is outside the working copy');
    fs.rmSync(abs, { recursive: true, force: true });
    return;
  }
  await git(dir, ['restore', '--staged', '--worktree', '--source=HEAD', '--', file]);
}

// Commits what's staged; with nothing staged, stages everything first (like VS Code's smart commit).
export async function commit(dir, message) {
  if (!message?.trim()) throw new Error('write a commit message');
  const staged = (await git(dir, ['diff', '--cached', '--name-only'])).trim();
  if (!staged) {
    await stageAll(dir);
    if (!(await git(dir, ['diff', '--cached', '--name-only'])).trim()) throw new Error('nothing to commit');
  }
  await git(dir, ['commit', '-q', '-m', message.trim()]);
  return (await git(dir, ['rev-parse', '--short', 'HEAD'])).trim();
}

export const push = (dir, branch) => git(dir, ['push', '-u', 'origin', branch]);

// ---------- branch and worktree lifecycle (run in the main repository) ----------

export async function isDirty(dir) {
  return (await git(dir, ['status', '--porcelain'])).trim() !== '';
}

export async function isMerged(root, branch, base) {
  try { await git(root, ['merge-base', '--is-ancestor', branch, base]); return true; }
  catch { return false; }
}

export async function branchExists(root, branch) {
  try { await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]); return true; }
  catch { return false; }
}

// Merges `branch` into `base` inside the operator's own working copy, but only when that copy is
// on `base` with no tracked changes, so nothing of theirs is disturbed. Conflicts abort the merge.
export async function mergeInto(root, branch, base) {
  const current = await currentBranch(root);
  if (current !== base) throw new Error(`your working copy at ${root} is on ${current}; check out ${base} there to merge`);
  if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) {
    throw new Error(`your working copy at ${root} has uncommitted changes; commit or stash them first`);
  }
  try {
    await git(root, ['merge', '--no-ff', '--no-edit', branch]);
  } catch (e) {
    await git(root, ['merge', '--abort'], { okCodes: [0, 128] }).catch(() => {});
    throw new Error(`merge stopped on conflicts and was undone; resolve them in the session's branch first (${e.message.split('\n')[0]})`);
  }
  return (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
}

export async function removeWorktree(root, worktree, { force = false } = {}) {
  if (fs.existsSync(worktree)) await git(root, ['worktree', 'remove', ...(force ? ['--force'] : []), worktree]);
  await git(root, ['worktree', 'prune']);
}

export async function restoreWorktree(root, worktree, branch) {
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  await git(root, ['worktree', 'prune']);
  await git(root, ['worktree', 'add', worktree, branch]);
}

export const deleteBranch = (root, branch, { force = false } = {}) => git(root, ['branch', force ? '-D' : '-d', branch]);
