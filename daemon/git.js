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

// Commits across all branches, newest first in topological order; the app draws the lanes.
export async function log(dir, { limit = 300 } = {}) {
  const fmt = ['%H', '%P', '%an', '%at', '%D', '%s'].join(SEP);
  const out = await git(dir, ['log', '--all', '--topo-order', `--max-count=${limit}`, `--format=${fmt}`, '--no-show-signature']);
  const head = (await git(dir, ['rev-parse', 'HEAD'], { okCodes: [0, 128] })).trim();
  return {
    head,
    commits: out.split('\n').filter(Boolean).map((l) => {
      const [hash, parents, author, at, refs, subject] = l.split(SEP);
      return {
        hash,
        parents: parents ? parents.split(' ') : [],
        author,
        at: Number(at) * 1000,
        refs: refs ? refs.split(', ').filter((r) => r !== 'refs/stash') : [],
        subject,
      };
    }),
  };
}

export async function commitFiles(dir, hash) {
  const body = (await git(dir, ['show', '-s', '--format=%B', hash])).trim();
  const out = await git(dir, ['diff-tree', '--no-commit-id', '-r', '--root', '--name-status', '-z', '-m', '--first-parent', hash]);
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (st[0] === 'R' || st[0] === 'C') files.push({ status: st[0], from: parts[++i], path: parts[++i] });
    else files.push({ status: st[0], path: parts[++i] });
  }
  return { body, files };
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
