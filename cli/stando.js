#!/usr/bin/env node
// stando CLI: a terminal client of the daemon. Starts the daemon if it isn't running.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from '../shared/client.js';
import { SOCKET } from '../shared/protocol.js';

const HELP = `stando — run agent CLIs as sessions you can watch and steer from the app or here

  stando run [-r runner] [-k key] [-m model] [-i image] [-d] "prompt"
        fresh session in its own spike folder; attaches unless -d (detach)
  stando run --repo <dir> [--base branch] [--here] "prompt"
        repo session: new branch stando/<id> in its own worktree, from --base (default: current branch);
        --here works in the repo's own working copy instead
  stando attach <ref>      follow a session and chat from the terminal (ctrl-c detaches)
  stando send <ref> "text" [-i image]   queue a message without attaching; -i attaches an image (repeatable)
  stando ls [-a]           sessions (-a includes closed)
  stando pause <ref>       end the running turn and hold the queue
  stando resume <ref>
  stando close <ref>       pause and hide from the list (folder stays)
  stando reopen <ref>
  stando keys              key profiles and today's spend
  stando keys add <name> <provider>   value is read hidden from the prompt or stdin
  stando keys rm <name>
  stando commit <ref> "message"   commit in the session's worktree (stages everything if nothing is staged)
  stando merge <ref>       merge the session's branch into its base, in your working copy (must be on base, clean)
  stando push <ref>        push the session's branch to origin
  stando finish <ref> [--keep-branch] [--force]
        remove the session's worktree and delete its branch (only if merged, unless --force)
  stando clean [-n] [--all] [--force]
        clean up closed sessions that are merged and clean; -n shows what would happen
  stando name [new name]   show or rename your stando
  stando app               open the desktop app
  stando daemon            run the daemon in the foreground (logs to the terminal)

<ref> is the number from ls, the session id, or any unique part of it.`;

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c('90', s);
const link = (target, text = target) => {
  if (!tty) return text;
  const url = /^\w+:\/\//.test(target) ? target : 'file://' + path.resolve(target);
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
};
const linkify = (s) => s.replace(/(https?:\/\/[^\s)\]>"'`]+)|(\/(?:Users|tmp|private|var)\/[\w.\-/~]+)/g, (m) => link(m));

function parseFlags(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = spec[a];
    if (name === true) out[a.replace(/^-+/, '')] = true;
    else if (name?.endsWith('[]')) (out[name.slice(0, -2)] ||= []).push(argv[++i]);
    else if (name) out[name] = argv[++i];
    else out._.push(a);
  }
  return out;
}

// Local image paths go to the daemon as {path}; it copies them into the session's uploads/.
function imageArgs(paths = []) {
  return paths.map((p) => {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) throw new Error(`no such file: ${p}`);
    return { path: abs };
  });
}

function printEvent(ev, { seenTools = new Map() } = {}) {
  switch (ev.t) {
    case 'user':
      console.log(`\n${c('36', 'you›')} ${ev.text}` + (ev.source && ev.source !== 'terminal' ? dim(`  (${ev.source})`) : ''));
      for (const img of ev.images || []) console.log(dim('  ▣ ') + link(img, path.basename(img)));
      break;
    case 'turn_start':
      console.log(dim(`● ${ev.runner}${ev.key ? ' · ' + ev.key : ' · own login'}${ev.model ? ' · ' + ev.model : ''}`));
      break;
    case 'text':
      console.log(`${c('35', 'agent›')} ${linkify(ev.text)}`);
      break;
    case 'tool': {
      const i = ev.input || {};
      const detail = i.command || i.file_path || i.path || i.url || i.pattern || i.description || '';
      seenTools.set(ev.id, ev.name);
      console.log(dim(`  ▸ ${ev.name} `) + linkify(String(detail).split('\n')[0].slice(0, 160)));
      break;
    }
    case 'tool_result':
      if (ev.error) console.log(c('31', `    ✗ ${ev.text.split('\n')[0].slice(0, 160)}`));
      break;
    case 'file':
      console.log(c('32', '  ＋ ') + link(ev.path, path.basename(ev.path)) + dim(` ${(ev.size / 1024).toFixed(1)} KB`));
      break;
    case 'turn_end':
      console.log(dim(`  ─ ${ev.error ? c('31', ev.error) + ' · ' : ''}${ev.cost != null ? '$' + ev.cost.toFixed(2) + ' · ' : ''}${(ev.ms / 1000).toFixed(0)}s`));
      break;
    case 'stderr':
      console.log(dim(`  ! ${ev.text}`));
      break;
    case 'note':
      console.log(c('33', `  · ${ev.text}`));
      break;
  }
}

async function attach(client, ref, pushes) {
  const { meta, events } = await client.call('history', { session: ref });
  console.log(dim(`attached to ${meta.id} — `) + link(meta.dir, 'folder') + dim(' — ctrl-c detaches, the session keeps running'));
  for (const ev of events.slice(-60)) printEvent(ev);
  pushes.on = (msg) => { if (msg.push === 'event' && msg.session === meta.id) printEvent(msg.event); };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    process.stdout.moveCursor?.(0, -1);
    process.stdout.clearLine?.(0);
    try { await client.call('send', { session: meta.id, text: line, source: 'terminal' }); }
    catch (e) { console.log(c('31', e.message)); }
  });
  await new Promise((resolve) => rl.on('close', resolve));
}

function readHidden(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = '';
      process.stdin.on('data', (d) => (data += d)).on('end', () => resolve(data.trim()));
    });
  }
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString()) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') process.exit(1);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return console.log(HELP);

  if (cmd === 'daemon') {
    await import('../daemon/main.js');
    return;
  }
  if (cmd === 'app') {
    const root = fileURLToPath(new URL('..', import.meta.url));
    spawn('npx', ['electron', root], { cwd: root, detached: true, stdio: 'ignore' }).unref();
    return;
  }

  const pushes = { on: null };
  const client = await connect({ onPush: (m) => pushes.on?.(m), onClose: () => { if (pushes.on) { console.log(dim('\ndaemon went away')); process.exit(1); } } });
  await client.call('subscribe');

  try {
    switch (cmd) {
      case 'run': {
        const f = parseFlags(rest, { '-r': 'runner', '-k': 'key', '-m': 'model', '--in': 'cwd', '-t': 'title', '-d': true, '-i': 'images[]', '--repo': 'repo', '--here': true, '--base': 'base' });
        const prompt = f._.join(' ');
        if (!prompt && !f.images) throw new Error('give the session a first prompt: stando run "…"');
        const meta = await client.call('create', {
          runner: f.runner, key: f.key, model: f.model, cwd: f.cwd, title: f.title, prompt, images: imageArgs(f.images),
          repo: f.repo && path.resolve(f.repo), worktree: !f.here, base: f.base,
        });
        console.log(`${meta.runner} session ${link(meta.dir, meta.id)}`);
        if (meta.mode === 'repo') console.log(dim(`  repo ${meta.repo} · branch ${meta.branch}${meta.worktree ? ' (worktree ' + meta.worktree + ')' : ''}`));
        if (!f.d) await attach(client, meta.id, pushes);
        break;
      }
      case 'attach':
        await attach(client, rest[0] || '', pushes);
        break;
      case 'send': {
        const f = parseFlags(rest.slice(1), { '-i': 'images[]' });
        await client.call('send', { session: rest[0], text: f._.join(' '), source: 'terminal', images: imageArgs(f.images) });
        break;
      }
      case 'ls': {
        const { sessions } = await client.call('state');
        if (!sessions.length) console.log(dim('no sessions yet — stando run "…"'));
        if (sessions.some((m) => m.closed) && rest[0] !== '-a') console.log(dim('  (closed sessions hidden; ls -a shows them)'));
        const color = { running: '33', idle: '32', paused: '90' };
        const all = rest[0] === '-a';
        sessions.forEach((m, i) => {
          if (m.closed && !all) return;
          console.log(`${String(i + 1).padStart(3)}  ${c(color[m.status] || '0', m.status.padEnd(8))} ${m.runner.padEnd(7)} ${(m.key || 'login').padEnd(12)} ${(m.mode === 'repo' ? m.branch : 'fresh').slice(0, 28).padEnd(28)} ${m.cost ? ('$' + m.cost.toFixed(2)).padStart(7) : ''.padStart(7)}  ${link(m.dir, m.id)}`);
        });
        break;
      }
      case 'commit': {
        const hash = await client.call('git.commitChanges', { session: rest[0], message: rest.slice(1).join(' ') });
        console.log(`committed ${hash}`);
        break;
      }
      case 'merge': {
        const hash = await client.call('git.merge', { session: rest[0] });
        console.log(`merged (${hash})`);
        break;
      }
      case 'push':
        await client.call('git.push', { session: rest[0] });
        console.log('pushed');
        break;
      case 'finish': {
        const f = parseFlags(rest, { '--keep-branch': true, '--force': true });
        const r = await client.call('cleanup', { session: f._[0], deleteBranch: !f['keep-branch'], force: !!f.force });
        console.log(`worktree removed; branch ${r.branchDeleted ? 'deleted' : 'kept'}${r.merged ? '' : dim(' (it was not merged)')}`);
        break;
      }
      case 'clean': {
        const f = parseFlags(rest, { '-n': true, '--dry-run': true, '--force': true, '--all': true });
        const report = await client.call('clean', { dryRun: !!(f.n || f['dry-run']), force: !!f.force, all: !!f.all });
        if (!report.length) console.log(dim('nothing to clean: no closed sessions with a worktree'));
        for (const r of report) {
          const col = r.action === 'removed' ? '32' : r.action === 'skip' ? '90' : r.action === 'failed' ? '31' : '33';
          console.log(`  ${c(col, r.action.padEnd(12))} ${r.id}${r.branch ? dim(`  branch ${r.branch}`) : ''}${r.reason ? dim(`  ${r.reason}`) : ''}`);
        }
        break;
      }
      case 'name': {
        if (rest.length) console.log((await client.call('settings.set', { name: rest.join(' ') })).name);
        else console.log((await client.call('state')).settings.name);
        break;
      }
      case 'pause':
      case 'stop':
      case 'resume':
      case 'close':
      case 'reopen':
        await client.call(cmd === 'stop' ? 'pause' : cmd, { session: rest[0] });
        break;
      case 'keys': {
        const [sub, name, provider] = rest;
        if (sub === 'add') {
          if (!name || !provider) throw new Error('stando keys add <name> <provider>');
          const value = await readHidden(`value for ${name} (hidden): `);
          await client.call('keys.add', { name, provider, value });
          console.log(`saved ${name}`);
        } else if (sub === 'rm') {
          await client.call('keys.remove', { name });
          console.log(`removed ${name}`);
        } else {
          const { keys, providers } = await client.call('state');
          if (!keys.length) console.log(dim(`no keys yet — stando keys add <name> <${providers.join('|')}>`));
          for (const k of keys) {
            console.log(`  ${k.name.padEnd(14)} ${k.provider.padEnd(11)} ${k.hint.padEnd(7)} ${dim(k.today ? '$' + k.today.toFixed(2) + ' today' : '')}`);
          }
        }
        break;
      }
      default:
        console.log(HELP);
    }
  } catch (e) {
    console.error(c('31', e.message));
    process.exitCode = 1;
  }
  client.close();
  process.exit();
}

main().catch((e) => {
  console.error(e.message + (e.code === 'ENOENT' ? ` (socket ${SOCKET})` : ''));
  process.exit(1);
});
