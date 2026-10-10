// The page: holds view state, renders what the daemon pushes, sends what you type.
const { el, markdown, mediaPreview, mediaKind, basename, toolSummary, fmtCost, kb, icon, hydrateIcons, graphRows, graphSvg, laneContinuation, refBadges, relTime, statusBadge, pathParts, diffView, LANE_W } = window.R;
const $ = (id) => document.getElementById(id);

const state = {
  sessions: new Map(), // id → meta
  runners: [],
  keys: [],
  providers: [],
  current: null,
  tools: new Map(), // tool id → card, for the open session
  files: new Map(), // path → card, for the open session
  lastTurn: null,   // the agent block text gets appended to
  tab: 'chat',      // chat | git, for repo sessions
  git: { selected: null, openCommit: null, timer: null },
};

// View preferences, remembered per machine. Storage can be unavailable; defaults then apply.
const prefs = (() => {
  const defaults = { filesMin: false, mediaCollapsed: false, showClosed: false };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('stando.prefs') || '{}') }; }
  catch { return defaults; }
})();
function setPref(k, v) {
  prefs[k] = v;
  try { localStorage.setItem('stando.prefs', JSON.stringify(prefs)); } catch {}
  applyPrefs();
}
function applyPrefs() {
  document.body.classList.toggle('files-min', prefs.filesMin);
  $('files-min').dataset.icon = prefs.filesMin ? 'expand' : 'minimize';
  $('files-min').title = prefs.filesMin ? 'Expand files' : 'Minimize files';
  $('s-files').classList.toggle('on', !prefs.filesMin);
  $('s-media').classList.toggle('on', !prefs.mediaCollapsed);
  hydrateIcons($('files'));
}

// ---------- attachments ----------

// Images waiting to be sent from one form. Read as data URLs so pasted screenshots work
// too; the daemon writes them into the session's uploads/ folder.
function attacher(listEl, inputEl) {
  const items = [];
  const render = () => listEl.replaceChildren(...items.map((it, i) => el('div', { class: 'att', title: it.name },
    el('img', { src: it.url, alt: it.name }),
    el('button', { type: 'button', class: 'icon att-x', title: 'Remove', onclick: () => { items.splice(i, 1); render(); } }, icon('x', 12)))));
  const read = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const add = async (files) => {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      items.push({ name: f.name || `pasted-${Date.now()}.png`, url: await read(f) });
    }
    render();
  };
  inputEl.onchange = () => { add(inputEl.files); inputEl.value = ''; };
  return {
    add,
    get count() { return items.length; },
    payload: () => items.map((it) => ({ name: it.name, data: it.url.slice(it.url.indexOf(',') + 1) })),
    clear() { items.length = 0; render(); },
  };
}

function acceptDrops(zone, att) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dropping'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dropping'); });
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('dropping'); att.add(e.dataTransfer.files); });
}

function acceptPaste(textarea, att) {
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); att.add(files); }
  });
}

const composerAtt = attacher($('attach-list'), $('attach-input'));
const newAtt = attacher($('new-attach-list'), $('new-attach-input'));

// ---------- views ----------

function show(view) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + view;
  $('files').hidden = view !== 'session';
  if (view !== 'session') state.current = null;
  renderSidebar();
}

// ---------- sidebar ----------

function rowAction(name, title, fn) {
  return el('button', { class: 'icon ghost row-act', title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(name, 14));
}

const act = (op, id) => stando.call(op, { session: id }).catch((err) => alert(err.message));

function renderSidebar() {
  const q = $('filter').value.toLowerCase();
  const all = [...state.sessions.values()];
  const closedCount = all.filter((m) => m.closed).length;
  const list = all
    .filter((m) => prefs.showClosed || !m.closed || m.id === state.current)
    .filter((m) => !q || (m.title + m.id + m.runner + (m.key || '')).toLowerCase().includes(q))
    .sort((a, b) => b.created - a.created);
  $('sessions').replaceChildren(...list.map((m) => el('li', {
    class: [m.id === state.current && 'active', m.closed && 'closed'].filter(Boolean).join(' '),
    onclick: () => openSession(m.id),
  },
  el('span', { class: 'dot ' + (m.closed ? 'closed' : m.status) }),
  el('div', { class: 'meta' },
    el('div', { class: 'name', text: m.title }),
    el('div', { class: 'sub' },
      m.mode === 'repo' ? el('span', { class: 'repo-tag', title: m.branch }, icon('branch', 11), m.repo.split('/').pop()) : null,
      `${m.runner} · ${m.key || 'own login'}${m.cost ? ' · ' + fmtCost(m.cost) : ''}`)),
  el('div', { class: 'row-acts' },
    m.closed
      ? rowAction('reopen', 'Reopen', () => act('reopen', m.id))
      : [
        m.status === 'paused'
          ? rowAction('play', 'Resume', () => act('resume', m.id))
          : rowAction('pause', 'Pause', () => act('pause', m.id)),
        rowAction('x', 'Close', () => act('close', m.id)),
      ]))));
  if (all.length) {
    $('empty-title').textContent = 'Pick a session';
    $('empty-body').textContent = 'Choose one on the left, or start a new one. Sessions keep running when you close this window.';
  }
  const sc = $('show-closed');
  sc.hidden = !closedCount;
  sc.textContent = prefs.showClosed ? 'Hide closed' : `Show closed (${closedCount})`;
  hydrateIcons($('side'));
}

function fillSelect(select, values, current, { none } = {}) {
  const opts = none ? [el('option', { value: '', text: none })] : [];
  for (const v of values) opts.push(el('option', { value: v.value ?? v, text: v.label ?? v }));
  select.replaceChildren(...opts);
  select.value = current ?? '';
}

const keyOptions = () => state.keys.map((k) => ({ value: k.name, label: `${k.name} (${k.provider} ${k.hint})` }));

function applyName(name) {
  state.name = name || 'stando';
  $('brand-name').textContent = state.name;
  document.title = state.name;
}

function startRename() {
  const input = $('brand-input');
  input.value = state.name;
  $('brand-name').hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
}

async function finishRename(save) {
  const input = $('brand-input');
  if (input.hidden) return;
  input.hidden = true;
  $('brand-name').hidden = false;
  const name = input.value.trim();
  if (!save || !name || name === state.name) return;
  applyName(name);
  try { applyName((await stando.call('settings.set', { name })).name); }
  catch (err) { alert(err.message); }
}

async function refreshState() {
  const s = await stando.call('state');
  if (s.settings) applyName(s.settings.name);
  state.runners = s.runners;
  state.keys = s.keys;
  state.providers = s.providers;
  state.sessions = new Map(s.sessions.map((m) => [m.id, m]));
  renderSidebar();
  const f = $('new-form');
  fillSelect(f.runner, state.runners, f.runner.value || 'claude');
  fillSelect(f.key, keyOptions(), f.key.value, { none: 'Own login (no key)' });
  fillSelect($('key-form').provider, state.providers, $('key-form').provider.value || 'anthropic');
  renderKeys();
  if (state.current) renderHeader();
  else if (!state.sessions.size && $('view-session').hidden && $('view-new').hidden && $('view-keys').hidden) show('empty');
}

// ---------- session view ----------

async function openSession(id) {
  const { meta, events, files } = await stando.call('history', { session: id });
  state.current = id;
  state.sessions.set(id, meta);
  state.tools.clear();
  state.files.clear();
  state.lastTurn = null;
  state.git.selected = null;
  state.git.openCommit = null;
  $('finish-panel').hidden = true;
  gitError('');
  $('commit-msg').value = '';
  $('git-changes').replaceChildren();
  $('git-graph').replaceChildren();
  $('diff-body').replaceChildren();
  $('diff-head').textContent = 'Pick a file to see its diff';
  $('git-count').textContent = '';
  $('transcript').replaceChildren();
  $('file-grid').replaceChildren();
  $('file-count').textContent = '';
  show('session');
  state.current = id;
  renderSidebar();
  renderHeader();
  for (const f of files) addFile(f, false);
  for (const ev of events) addEvent(ev, false);
  updateWorking();
  scrollDown(true);
  $('input').focus();
  if (meta.mode === 'repo') loadGit();
  else setTab('chat');
}

// ---------- git view ----------

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('#s-tabs .tab')) b.classList.toggle('on', b.dataset.tab === tab);
  $('transcript').hidden = tab !== 'chat';
  $('gitview').hidden = tab !== 'git';
  $('files').hidden = tab === 'git' || !state.current;
  if (tab === 'git') loadGit();
}

function gitRefreshSoon() {
  clearTimeout(state.git.timer);
  state.git.timer = setTimeout(loadGit, 700);
}

const cleanErr = (err) => err.message.replace(/^Error invoking remote method 'call': Error: /, '');

function gitError(msg) {
  $('git-error').textContent = msg || '';
  $('git-error').hidden = !msg;
}

// Runs a git action for the open session, shows any error in the git view, then refreshes.
async function gitAct(op, args = {}) {
  gitError('');
  try { return await stando.call(op, { session: state.current, ...args }); }
  catch (err) { gitError(cleanErr(err)); return undefined; }
  finally {
    // These change the session itself (worktree gone or back), not just the repo.
    if (op === 'cleanup' || op === 'reopen') await refreshState();
    loadGit();
  }
}

async function loadGit() {
  const id = state.current;
  const m = state.sessions.get(id);
  if (!m || m.mode !== 'repo') return;
  const gone = !!m.worktreeGone;
  $('git-gone').hidden = !gone;
  $('git-work').hidden = gone;
  $('git-merge').hidden = !m.worktree || gone;
  $('git-push').hidden = gone;
  $('git-finish').hidden = !m.worktree || gone;
  $('git-graph').closest('.git-sec').hidden = gone;
  $('git-restore').hidden = !!m.branchDeleted;
  $('git-gone').querySelector('p').textContent = m.branchDeleted
    ? 'This session is finished: its worktree was removed and its branch deleted.'
    : `This session's worktree was removed. Its branch ${m.branch} is kept.`;
  $('git-merge').replaceChildren(icon('merge', 14), `Merge into ${m.base}`);
  if (gone) {
    $('git-branch').replaceChildren(icon('branch', 12), m.branch);
    $('git-ab').textContent = m.branchDeleted ? 'branch deleted' : 'worktree removed';
    $('git-count').textContent = '';
    $('git-graph').replaceChildren();
    return;
  }
  let st;
  let log;
  try {
    [st, log] = await Promise.all([stando.call('git.status', { session: id }), stando.call('git.log', { session: id })]);
  } catch (err) {
    gitError(cleanErr(err));
    return;
  }
  if (id !== state.current) return;
  state.git.status = st;
  $('git-count').textContent = st.files.length || '';
  if (state.tab !== 'git') return;
  $('git-branch').replaceChildren(icon('branch', 12), st.branch || '(detached)');
  $('git-ab').textContent = [m.worktree ? `from ${m.base}` : null, st.ahead ? `↑${st.ahead}` : null, st.behind ? `↓${st.behind}` : null].filter(Boolean).join(' · ');
  renderChanges(st.files);
  renderGraph(log);
}

function fileRow(f, letter, key, actions) {
  return el('div', {
    class: 'gfile' + (state.git.selected === key ? ' sel' : ''),
    title: f.path,
    onclick: (e) => showDiff(e.currentTarget, key, { file: f.path, untracked: !!f.untracked }, f.path, 'working tree'),
  }, ...pathParts(f.path),
  el('span', { class: 'file-acts' }, ...actions.map(([name, title, fn]) => el('button', {
    type: 'button', class: 'icon ghost row-act', title,
    onclick: (e) => { e.stopPropagation(); fn(); },
  }, icon(name, 14)))),
  statusBadge(letter));
}

function renderChanges(files) {
  const staged = files.filter((f) => f.staged && !f.untracked);
  const unstaged = files.filter((f) => f.unstaged || f.untracked);
  $('staged-sec').hidden = !staged.length;
  $('git-staged-count').textContent = staged.length || '';
  $('git-changes-count').textContent = unstaged.length || '';
  $('commit-btn').replaceChildren(icon('check', 14), staged.length ? 'Commit' : files.length ? `Commit all (${files.length})` : 'Commit');
  $('git-staged').replaceChildren(...staged.map((f) => fileRow(f, f.staged, 's:' + f.path, [
    ['minus', 'Unstage', () => gitAct('git.unstage', { files: [f.path] })],
  ])));
  $('git-changes').replaceChildren(...(unstaged.length ? unstaged.map((f) => fileRow(f, f.untracked ? 'U' : f.conflict ? '!' : f.unstaged, 'w:' + f.path, [
    ['undo', f.untracked ? 'Delete this new file' : 'Discard changes', () => {
      if (confirm(f.untracked ? `Delete ${f.path}? It was never committed, so it can't be recovered.` : `Discard your changes to ${f.path}?`)) {
        gitAct('git.discard', { file: f.path, untracked: !!f.untracked });
      }
    }],
    ['plus', 'Stage', () => gitAct('git.stage', { files: [f.path] })],
  ])) : [el('div', { class: 'muted pad', text: staged.length ? 'Everything is staged.' : 'Working tree clean.' })]));
}

async function commitNow() {
  const message = $('commit-msg').value.trim();
  if (!message) { gitError('Write a commit message first.'); $('commit-msg').focus(); return; }
  const hash = await gitAct('git.commitChanges', { message });
  if (hash) $('commit-msg').value = '';
}

async function openFinish() {
  const m = state.sessions.get(state.current);
  const merged = await stando.call('git.merged', { session: m.id }).catch(() => null);
  const dirty = !!state.git.status?.files.length;
  $('finish-state').textContent = [
    merged ? `${m.branch} is merged into ${m.base}.` : `${m.branch} is not merged into ${m.base} yet.`,
    dirty ? 'The worktree has uncommitted changes.' : 'The worktree is clean.',
  ].join(' ');
  $('finish-delete').checked = !!merged;
  $('finish-force').checked = false;
  $('finish-force-row').hidden = !dirty && merged;
  $('finish-panel').hidden = false;
}

function renderGraph({ commits, head }) {
  const rows = graphRows(commits);
  const width = Math.max(1, ...rows.map((r) => Math.max(r.before.length, r.after.length, r.idx + 1))) * LANE_W + 4;
  state.git.rows = new Map(rows.map((r) => [r.commit.hash, r]));
  state.git.width = width;
  $('git-graph').replaceChildren(...rows.map((r) => {
    const c = r.commit;
    const row = el('div', {
      class: 'gcommit' + (c.hash === head ? ' is-head' : '') + (state.git.openCommit === c.hash ? ' open' : ''),
      title: `${c.hash.slice(0, 8)} · ${c.author} · ${new Date(c.at).toLocaleString()}`,
      onclick: () => toggleCommit(c, row),
    }, graphSvg(r, width),
    el('span', { class: 'subj', text: c.subject }),
    ...refBadges(c.refs),
    el('span', { class: 'who-time', text: `${c.author.split(' ')[0]} · ${relTime(c.at)}` }));
    return row;
  }));
  if (state.git.openCommit) {
    const c = commits.find((x) => x.hash === state.git.openCommit);
    const row = [...$('git-graph').children].find((r) => r.classList.contains('open'));
    if (c && row) expandCommit(c, row);
  }
}

async function toggleCommit(c, row) {
  const next = row.nextElementSibling;
  if (next?.classList.contains('gcommit-files')) {
    next.remove();
    row.classList.remove('open');
    state.git.openCommit = null;
    return;
  }
  for (const o of $('git-graph').querySelectorAll('.gcommit-files')) o.remove();
  for (const o of $('git-graph').querySelectorAll('.gcommit.open')) o.classList.remove('open');
  state.git.openCommit = c.hash;
  row.classList.add('open');
  expandCommit(c, row);
}

async function expandCommit(c, row) {
  const info = await stando.call('git.commit', { session: state.current, hash: c.hash });
  const r = state.git.rows?.get(c.hash);
  const box = el('div', { class: 'gcommit-files', style: `--lanes-w:${state.git.width + 6}px` },
    r ? laneContinuation(r, state.git.width) : null,
    info.body !== c.subject ? el('pre', { class: 'cbody', text: info.body }) : null,
    ...info.files.map((f) => {
      const key = c.hash + ':' + f.path;
      return el('div', {
        class: 'gfile' + (state.git.selected === key ? ' sel' : ''),
        onclick: (e) => showDiff(e.currentTarget, key, { file: f.path, hash: c.hash }, f.path, c.hash.slice(0, 8) + ' ' + c.subject),
      }, ...pathParts(f.path), statusBadge(f.status));
    }));
  row.after(box);
}

async function showDiff(rowEl, key, args, file, where) {
  state.git.selected = key;
  for (const r of $('gitview').querySelectorAll('.gfile.sel')) r.classList.remove('sel');
  rowEl.classList.add('sel');
  $('diff-head').replaceChildren(el('span', { class: 'fn', text: file }), el('span', { class: 'muted', text: '  ' + where }));
  try {
    const text = await stando.call('git.diff', { session: state.current, ...args });
    $('diff-body').replaceChildren(...diffView(text));
  } catch (err) {
    $('diff-body').replaceChildren(el('div', { class: 'muted pad', text: err.message }));
  }
}

function renderHeader() {
  const m = state.sessions.get(state.current);
  if (!m) return;
  $('s-title').textContent = m.title;
  $('s-status').textContent = m.status;
  $('s-status').className = 'pill ' + m.status;
  $('s-cost').textContent = m.cost ? fmtCost(m.cost) : '';
  const repo = m.mode === 'repo';
  $('s-branch').hidden = !repo;
  $('s-code').hidden = !repo;
  $('s-tabs').hidden = !repo;
  if (repo) {
    $('s-branch').replaceChildren(icon('branch', 12), m.branch);
    $('s-branch').title = `${m.repo}${m.worktree ? '\nworktree ' + m.worktree : ''}\nfrom ${m.base}`;
  }
  if (!repo && state.tab !== 'chat') setTab('chat');
  fillSelect($('s-runner'), state.runners, m.runner);
  fillSelect($('s-key'), keyOptions(), m.key, { none: 'Own login' });
  if (document.activeElement !== $('s-model')) $('s-model').value = m.model || '';
  const paused = m.status === 'paused';
  const pb = $('s-pause');
  pb.dataset.icon = paused ? 'play' : 'pause';
  pb.textContent = paused ? 'Resume' : 'Pause';
  pb.title = paused ? 'Resume: run queued messages' : 'Pause: end the running turn and hold the queue';
  const cb = $('s-close');
  cb.dataset.icon = m.closed ? 'reopen' : 'x';
  cb.title = m.closed ? 'Reopen this session' : 'Close: pause and hide from the list. The folder stays.';
  hydrateIcons($('view-session').querySelector('.controls'));
}

function nearBottom() {
  const t = $('transcript');
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function scrollDown(force) {
  const t = $('transcript');
  if (force || nearBottom()) t.scrollTop = t.scrollHeight;
}

function agentBlock() {
  if (!state.lastTurn) {
    state.lastTurn = el('div', { class: 'msg agent' });
    $('transcript').append(state.lastTurn);
  }
  return state.lastTurn;
}

function addEvent(ev, live = true) {
  const stick = nearBottom();
  const t = $('transcript');
  switch (ev.t) {
    case 'user':
      state.lastTurn = null;
      t.append(el('div', { class: 'msg user' },
        el('div', { class: 'who', text: ev.source && !['app', 'new'].includes(ev.source) ? `you · ${ev.source}` : 'you' }),
        ev.text ? el('div', { class: 'body', text: ev.text }) : null,
        ev.images?.length ? el('div', { class: 'user-images' }, ev.images.map((p) => mediaPreview(p))) : null));
      break;
    case 'turn_start':
      agentBlock().append(el('div', { class: 'turn-meta', text: `${ev.runner} · ${ev.key || 'own login'}${ev.model ? ' · ' + ev.model : ''}` }));
      break;
    case 'text': {
      const b = agentBlock();
      const last = b.lastElementChild;
      if (last?.classList.contains('prose') && last.dataset.raw != null && !last.nextSibling) {
        last.dataset.raw += '\n' + ev.text;
        last.innerHTML = markdown(last.dataset.raw);
      } else {
        const p = el('div', { class: 'prose' });
        p.dataset.raw = ev.text;
        p.innerHTML = markdown(ev.text);
        b.append(p);
      }
      break;
    }
    case 'tool': {
      const card = el('details', { class: 'tool' },
        el('summary', {},
          el('span', { class: 'tname', text: ev.name }),
          el('span', { class: 'tdetail', text: toolSummary(ev.name, ev.input) }),
          el('span', { class: 'tstate pending', text: '…' })),
        el('pre', { class: 'tinput', text: JSON.stringify(ev.input, null, 2) }));
      state.tools.set(ev.id, card);
      agentBlock().append(card);
      break;
    }
    case 'tool_result': {
      const card = state.tools.get(ev.id);
      if (!card) break;
      const s = card.querySelector('.tstate');
      s.textContent = ev.error ? '✗' : '✓';
      s.className = 'tstate ' + (ev.error ? 'err' : 'ok');
      if (ev.text) card.append(el('pre', { class: 'tresult' + (ev.error ? ' err' : ''), text: ev.text }));
      break;
    }
    case 'file': {
      addFile(ev, live);
      const kind = mediaKind(ev.path);
      const previewable = kind !== 'file' && kind !== 'model';
      const line = el('div', { class: 'file-line' },
        previewable ? el('span', { class: 'chev' }, icon('chevron', 12)) : el('span', { class: 'plus', text: '+' }),
        el('a', { class: 'ln', 'data-href': ev.path, text: basename(ev.path) }),
        el('span', { class: 'muted', text: kb(ev.size) }));
      const card = previewable
        ? el('details', { class: 'file-msg', open: !prefs.mediaCollapsed }, el('summary', {}, line), mediaPreview(ev.path))
        : el('div', { class: 'file-msg' }, line);
      agentBlock().append(card);
      break;
    }
    case 'turn_end':
      agentBlock().append(el('div', { class: 'turn-end' + (ev.error ? ' err' : '') },
        [ev.error, fmtCost(ev.cost), ev.ms != null ? Math.round(ev.ms / 1000) + 's' : ''].filter(Boolean).join(' · ')));
      state.lastTurn = null;
      break;
    case 'stderr': {
      const b = agentBlock();
      let box = b.querySelector(':scope > details.stderr:last-child');
      if (!box) { box = el('details', { class: 'stderr' }, el('summary', { text: 'stderr' }), el('pre')); b.append(box); }
      box.querySelector('pre').textContent += ev.text + '\n';
      break;
    }
    case 'note':
      t.append(el('div', { class: 'note', text: ev.text }));
      break;
  }
  if (live) { updateWorking(); scrollDown(stick); }
}

function updateWorking() {
  $('working')?.remove();
  const m = state.sessions.get(state.current);
  if (m?.status === 'running') $('transcript').append(el('div', { id: 'working', class: 'working', text: 'working' }));
}

function addFile(f, live) {
  const existing = state.files.get(f.path);
  const card = el('div', { class: 'fcard' + (live ? ' fresh' : ''), title: f.path, onclick: () => stando.open(f.path), oncontextmenu: (e) => { e.preventDefault(); stando.reveal(f.path); } },
    el('div', { class: 'thumb' }, mediaPreview(f.path, { compact: true })),
    el('div', { class: 'fname', text: basename(f.path) }));
  if (existing) existing.replaceWith(card);
  else $('file-grid').prepend(card);
  state.files.set(f.path, card);
  $('file-count').textContent = state.files.size || '';
}

// ---------- keys view ----------

function renderKeys() {
  const rows = state.keys.map((k) => el('tr', {},
    el('td', { text: k.name }), el('td', { text: k.provider }), el('td', { class: 'mono', text: k.hint }),
    el('td', { class: 'muted', text: k.today ? fmtCost(k.today) + ' today' : '' }),
    el('td', {}, el('button', {
      class: 'small',
      onclick: async () => {
        if (!confirm(`Remove key ${k.name}? Sessions using it fall back to the CLI's own login.`)) return;
        await stando.call('keys.remove', { name: k.name });
        refreshState();
      },
    }, 'Remove'))));
  $('keys-table').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { class: 'muted', text: 'No keys yet.' }))]));
}

// ---------- wiring ----------

$('new-btn').onclick = () => { show('new'); $('new-form').prompt.focus(); };
$('empty-new').onclick = () => $('new-btn').click();
$('keys-btn').onclick = () => show('keys');
$('brand-name').onclick = startRename;
$('brand-input').onkeydown = (e) => {
  if (e.key === 'Enter') { e.preventDefault(); finishRename(true); }
  if (e.key === 'Escape') { e.preventDefault(); finishRename(false); }
};
$('brand-input').onblur = () => finishRename(true);

// New session: fresh folder or a repo.
const MODE_HINTS = {
  fresh: 'A new spike folder. Good for experiments, renders and one-offs.',
  repo: 'Works in a git repository. With its own branch, the agent never touches your working copy or another session.',
};
function syncMode() {
  const f = $('new-form');
  const repo = f.mode.value === 'repo';
  $('repo-fields').hidden = !repo;
  $('mode-hint').textContent = MODE_HINTS[f.mode.value];
  if (repo && !f.repo.value) f.repo.focus();
}
for (const r of $('new-form').querySelectorAll('input[name=mode]')) r.onchange = syncMode;

let probeTimer = null;
async function probeRepo() {
  const f = $('new-form');
  const p = f.repo.value.trim();
  if (!p) { $('repo-info').textContent = ''; fillSelect(f.base, [], ''); return; }
  try {
    const info = await stando.call('git.probe', { path: p });
    $('repo-info').textContent = `${info.root} · on ${info.branch}`;
    $('repo-info').className = 'hint ok';
    fillSelect(f.base, info.branches, info.branch);
  } catch (err) {
    $('repo-info').textContent = err.message.replace(/^Error invoking remote method 'call': Error: /, '');
    $('repo-info').className = 'hint bad';
    fillSelect(f.base, [], '');
  }
}
$('new-form').repo.oninput = () => { clearTimeout(probeTimer); probeTimer = setTimeout(probeRepo, 400); };
$('repo-browse').onclick = async () => {
  const dir = await stando.pickFolder();
  if (dir) { $('new-form').repo.value = dir; probeRepo(); }
};
$('new-form').worktree.onchange = (e) => {
  $('mode-hint').textContent = e.target.checked ? MODE_HINTS.repo : 'Works directly in the repository\'s own working copy, on its current branch.';
};

// Session tabs and git view.
for (const b of document.querySelectorAll('#s-tabs .tab')) b.onclick = () => setTab(b.dataset.tab);
$('git-refresh').onclick = () => { gitError(''); loadGit(); };
$('commit-btn').onclick = commitNow;
$('commit-msg').onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitNow(); } };
$('commit-msg').oninput = () => gitError('');
$('stage-all').append(icon('plus', 14));
$('unstage-all').append(icon('minus', 14));
$('stage-all').onclick = (e) => { e.preventDefault(); gitAct('git.stage', { all: true }); };
$('unstage-all').onclick = (e) => { e.preventDefault(); gitAct('git.unstage', { all: true }); };
$('git-merge').onclick = () => {
  const m = state.sessions.get(state.current);
  if (confirm(`Merge ${m.branch} into ${m.base}?\n\nThis runs in your working copy at ${m.repo}, which must be on ${m.base} with no uncommitted changes.`)) gitAct('git.merge');
};
$('git-push').onclick = () => {
  const m = state.sessions.get(state.current);
  if (confirm(`Push ${m.branch} to origin?`)) gitAct('git.push');
};
$('git-finish').onclick = openFinish;
$('finish-cancel').onclick = () => { $('finish-panel').hidden = true; };
$('finish-go').onclick = async () => {
  const r = await gitAct('cleanup', { deleteBranch: $('finish-delete').checked, force: $('finish-force').checked });
  if (r) $('finish-panel').hidden = true;
};
$('git-restore').onclick = () => gitAct('reopen');
$('s-code').onclick = () => { const m = state.sessions.get(state.current); if (m) stando.openInEditor(m.cwd); };
$('attach-btn').onclick = () => $('attach-input').click();
$('new-attach-btn').onclick = () => $('new-attach-input').click();
acceptDrops($('view-session'), composerAtt);
acceptDrops($('view-new'), newAtt);
acceptPaste($('input'), composerAtt);
acceptPaste($('new-form').prompt, newAtt);
// A file dropped anywhere else must not navigate the window away.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
$('filter').oninput = renderSidebar;

$('new-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const prompt = f.prompt.value.trim();
  if (!prompt && !newAtt.count) { $('new-error').textContent = 'Write a first message or attach an image.'; return; }
  $('new-error').textContent = '';
  try {
    const repoMode = f.mode.value === 'repo';
    if (repoMode && !f.repo.value.trim()) { $('new-error').textContent = 'Choose a repository.'; return; }
    $('new-error').textContent = repoMode && f.worktree.checked ? 'Creating the worktree…' : '';
    const meta = await stando.call('create', {
      runner: f.runner.value, key: f.key.value || null, model: f.model.value.trim() || null,
      prompt, images: newAtt.payload(),
      ...(repoMode ? { repo: f.repo.value.trim(), worktree: f.worktree.checked, base: f.base.value || null } : {}),
    });
    $('new-error').textContent = '';
    f.prompt.value = '';
    newAtt.clear();
    state.sessions.set(meta.id, meta);
    openSession(meta.id);
  } catch (err) { $('new-error').textContent = err.message.replace(/^Error invoking remote method 'call': Error: /, ''); }
};
$('new-form').prompt.oninput = () => { $('new-error').textContent = ''; };

$('key-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await stando.call('keys.add', { name: f.name.value.trim(), provider: f.provider.value, value: f.value.value.trim() });
    f.reset();
    $('key-error').textContent = '';
    refreshState();
  } catch (err) { $('key-error').textContent = err.message.replace(/^Error invoking remote method 'call': Error: /, ''); }
};

$('composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if ((!text && !composerAtt.count) || !state.current) return;
  $('input').value = '';
  try {
    await stando.call('send', { session: state.current, text, source: 'app', images: composerAtt.payload() });
    composerAtt.clear();
  } catch (err) { $('input').value = text; alert(err.message); }
};
$('input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
};

const patch = (fields) => stando.call('update', { session: state.current, ...fields }).catch((err) => alert(err.message));
$('s-key').onchange = (e) => patch({ key: e.target.value || null });
$('s-runner').onchange = (e) => patch({ runner: e.target.value });
$('s-model').onchange = (e) => patch({ model: e.target.value.trim() || null });
$('s-folder').onclick = () => { const m = state.sessions.get(state.current); if (m) stando.open(m.dir); };
$('s-pause').onclick = () => {
  const m = state.sessions.get(state.current);
  if (m) act(m.status === 'paused' ? 'resume' : 'pause', m.id);
};
$('s-close').onclick = () => {
  const m = state.sessions.get(state.current);
  if (m) act(m.closed ? 'reopen' : 'close', m.id);
};
$('s-files').onclick = () => setPref('filesMin', !prefs.filesMin);
$('files-min').onclick = () => setPref('filesMin', !prefs.filesMin);
$('s-media').onclick = () => {
  setPref('mediaCollapsed', !prefs.mediaCollapsed);
  for (const d of $('transcript').querySelectorAll('details.file-msg')) d.open = !prefs.mediaCollapsed;
};
$('show-closed').onclick = () => { setPref('showClosed', !prefs.showClosed); renderSidebar(); };

// Links and paths inside messages open with the system.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.ln');
  if (a) { e.preventDefault(); stando.open(a.dataset.href); return; }
  const img = e.target.closest('img.media-img');
  if (img) stando.open(img.dataset.path);
});

stando.onPush((msg) => {
  switch (msg.push) {
    case 'connected':
      $('conn').textContent = 'daemon connected';
      $('conn').className = 'conn ok';
      refreshState().then(() => state.current && openSession(state.current));
      break;
    case 'disconnected':
      $('conn').textContent = 'daemon offline — reconnecting';
      $('conn').className = 'conn bad';
      break;
    case 'error':
      $('conn').textContent = msg.error;
      $('conn').className = 'conn bad';
      break;
    case 'meta': {
      const isNew = !state.sessions.has(msg.meta.id);
      state.sessions.set(msg.meta.id, msg.meta);
      renderSidebar();
      if (msg.meta.id === state.current) {
        renderHeader();
        updateWorking();
        if (msg.meta.mode === 'repo' && state.tab === 'git') gitRefreshSoon();
      }
      if (isNew && !state.current && !$('view-empty').hidden) openSession(msg.meta.id);
      break;
    }
    case 'event':
      if (msg.session === state.current) {
        addEvent(msg.event);
        const m = state.sessions.get(state.current);
        if (m?.mode === 'repo' && ['tool_result', 'turn_end', 'file'].includes(msg.event.t)) gitRefreshSoon();
      }
      break;
    case 'settings':
      applyName(msg.settings.name);
      break;
    case 'forget':
      state.sessions.delete(msg.session);
      renderSidebar();
      break;
    case 'focus':
      openSession(msg.session);
      break;
  }
});

hydrateIcons();
applyPrefs();
refreshState().catch(() => {});
