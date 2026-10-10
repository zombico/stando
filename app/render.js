// Pure rendering helpers: turn events and text into DOM. No state lives here.
(() => {

const MEDIA = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'],
  model: ['glb', 'gltf', 'stl', 'obj', '3mf', 'usdz'],
};

function mediaKind(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  for (const [kind, exts] of Object.entries(MEDIA)) if (exts.includes(ext)) return kind;
  return 'file';
}

const basename = (p) => p.split('/').pop();
const fileUrl = (p) => 'file://' + p.split('/').map(encodeURIComponent).join('/');
const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB');

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// URLs and absolute paths become clickable; app.js handles the click.
function linkifyHtml(html) {
  return html.replace(/(https?:\/\/[^\s<)"'`\]]+)|((?:^|(?<=[\s(>]))\/(?:Users|tmp|private|var|opt|Volumes)\/[^\s<)"'`,;]+)/g,
    (m) => `<a class="ln" data-href="${m}">${m}</a>`);
}

// Small markdown subset: fenced code, inline code, bold, headings, bullet lines, links.
function markdown(text) {
  const parts = text.split(/```(\w*)\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 1) continue;
    if (i % 3 === 2) { html += `<pre><code>${escapeHtml(parts[i])}</code></pre>`; continue; }
    let chunk = escapeHtml(parts[i]);
    chunk = chunk.replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,4} (.+)$/gm, '<strong class="h">$1</strong>')
      .replace(/^[-*] (.+)$/gm, '• $1');
    html += linkifyHtml(chunk).replace(/\n/g, '<br>');
  }
  return html;
}

function mediaPreview(p, { compact = false } = {}) {
  const kind = mediaKind(p);
  const src = fileUrl(p) + '?v=' + Date.now(); // bust the cache when a file is rewritten
  if (kind === 'image') return el('img', { src, loading: 'lazy', class: 'media-img', 'data-path': p });
  if (kind === 'video') return el('video', { src, controls: !compact, muted: compact, loop: compact, preload: 'metadata', class: 'media-video' });
  if (kind === 'audio') return compact ? el('div', { class: 'media-icon', text: '♪' }) : el('audio', { src, controls: true, preload: 'metadata' });
  if (kind === 'model') return el('div', { class: 'media-icon', text: '◆' });
  return el('div', { class: 'media-icon', text: (p.split('.').pop() || '').slice(0, 4) });
}

function toolSummary(name, input = {}) {
  const d = input.command || input.file_path || input.path || input.url || input.pattern || input.description || input.prompt || '';
  return String(d).split('\n')[0].slice(0, 140);
}

function fmtCost(n) { return n == null ? '' : '$' + n.toFixed(n < 0.1 ? 3 : 2); }

// Stroke icons on a 24 grid; they take the text color.
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3M14 9l2 2"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  panel: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M15 4.5v15"/>',
  image: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-9 8.5"/>',
  minimize: '<path d="M6 12h12"/>',
  expand: '<path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6"/>',
  archive: '<path d="M3.5 5h17v4h-17zM5 9v10h14V9M10 13h4"/>',
  reopen: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11.2 8.6"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
    clip: '<path d="M20 11.5l-7.6 7.6a5 5 0 0 1-7.1-7.1l8.3-8.3a3.3 3.3 0 0 1 4.7 4.7l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6"/>',
};

function icon(name, size = 16) {
  const span = document.createElement('span');
  span.className = 'i';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

// Buttons declare `data-icon`; this puts the icon in front of their label.
function hydrateIcons(root = document) {
  for (const b of root.querySelectorAll('[data-icon]')) {
    b.querySelector(':scope > .i')?.remove();
    b.prepend(icon(b.dataset.icon));
  }
}

// ---------- git ----------

const LANE_W = 14;
const ROW_H = 26;
const LANE_COLORS = ['#4f8fe6', '#d9822b', '#3fa66a', '#c45bb8', '#d24d57', '#2fa3a3', '#a68a2a', '#7a6ee0'];
const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];

// Assigns each commit a lane and the line segments around it, the way a graph log does:
// a lane holds the hash it is waiting for; a commit takes the lane waiting for it, merges any
// other lanes waiting for it, then waits for its first parent and opens lanes for the rest.
function graphRows(commits) {
  const lanes = [];
  const rows = [];
  for (const c of commits) {
    let idx = lanes.indexOf(c.hash);
    const hadLane = idx >= 0;
    if (!hadLane) { idx = lanes.indexOf(null); if (idx < 0) idx = lanes.length; lanes[idx] = c.hash; }
    const before = lanes.slice();
    const merging = [];
    before.forEach((h, j) => { if (h === c.hash && j !== idx) { merging.push(j); lanes[j] = null; } });
    lanes[idx] = c.parents[0] || null;
    const branching = [];
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) { k = lanes.indexOf(null); if (k < 0 || k === idx) k = lanes.length; lanes[k] = p; }
      branching.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    rows.push({ commit: c, idx, hadLane, before, after: lanes.slice(), merging, branching });
  }
  return rows;
}

function graphSvg(row, width) {
  const x = (i) => i * LANE_W + LANE_W / 2;
  const mid = ROW_H / 2;
  const parts = [];
  const line = (x1, y1, x2, y2, col) => parts.push(x1 === x2
    ? `<path d="M${x1} ${y1}V${y2}" stroke="${col}"/>`
    : `<path d="M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}" stroke="${col}"/>`);
  row.before.forEach((h, j) => {
    if (h == null || j === row.idx || row.merging.includes(j)) return;
    line(x(j), 0, x(j), ROW_H, laneColor(j)); // passes through
  });
  if (row.hadLane) line(x(row.idx), 0, x(row.idx), mid, laneColor(row.idx));
  for (const j of row.merging) line(x(j), 0, x(row.idx), mid, laneColor(j));
  if (row.after[row.idx] != null) line(x(row.idx), mid, x(row.idx), ROW_H, laneColor(row.idx));
  for (const k of row.branching) line(x(row.idx), mid, x(k), ROW_H, laneColor(k));
  const col = laneColor(row.idx);
  const dot = row.commit.parents.length > 1
    ? `<circle cx="${x(row.idx)}" cy="${mid}" r="4.5" fill="var(--panel)" stroke="${col}" stroke-width="2"/>`
    : `<circle cx="${x(row.idx)}" cy="${mid}" r="4" fill="${col}"/>`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('height', ROW_H);
  svg.setAttribute('class', 'lanes');
  svg.innerHTML = `<g fill="none" stroke-width="2">${parts.join('')}</g>${dot}`;
  return svg;
}

// Lanes that keep going past a row, drawn straight down so an expanded commit doesn't cut the graph.
function laneContinuation(row, width) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', width);
  svg.setAttribute('class', 'lanes-cont');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('viewBox', `0 0 ${width} 10`);
  svg.innerHTML = row.after.map((h, j) => h == null ? '' : `<path d="M${j * LANE_W + LANE_W / 2} 0V10" stroke="${laneColor(j)}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('');
  return svg;
}

function refBadges(refs) {
  return refs.map((r) => {
    if (r.startsWith('HEAD -> ')) return el('span', { class: 'ref is-head', text: r.slice(8) });
    if (r === 'HEAD') return el('span', { class: 'ref is-head', text: 'HEAD' });
    if (r.startsWith('tag: ')) return el('span', { class: 'ref tag', text: r.slice(5) });
    if (r.includes('/') && /^(origin|upstream)\//.test(r)) return el('span', { class: 'ref remote', text: r });
    return el('span', { class: 'ref', text: r });
  });
}

function relTime(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.floor(s / 86400) + 'd';
  return new Date(ms).toLocaleDateString();
}

const STATUS_CLASS = { M: 'mod', A: 'add', U: 'add', D: 'del', R: 'ren', C: 'ren' };

function statusBadge(letter) {
  return el('span', { class: 'st ' + (STATUS_CLASS[letter] || ''), text: letter });
}

function pathParts(p) {
  const i = p.lastIndexOf('/');
  return [el('span', { class: 'fn', text: i < 0 ? p : p.slice(i + 1) }), i < 0 ? null : el('span', { class: 'dir', text: p.slice(0, i) })];
}

// Unified diff → rows with old/new line numbers, like a diff editor's inline view.
function diffView(text) {
  const rows = [];
  let a = 0;
  let b = 0;
  for (const line of text.replace(/\n$/, '').split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) continue;
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (h) { a = +h[1]; b = +h[2]; rows.push(el('div', { class: 'dl hunk' }, el('span', { class: 'ln-a' }), el('span', { class: 'ln-b' }), el('span', { class: 'code', text: line }))); continue; }
    if (line.startsWith('\\')) continue;
    const kind = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx';
    if (!line && kind === 'ctx' && !rows.length) continue;
    rows.push(el('div', { class: 'dl ' + kind },
      el('span', { class: 'ln-a', text: kind === 'add' ? '' : String(a++) }),
      el('span', { class: 'ln-b', text: kind === 'del' ? '' : String(b++) }),
      el('span', { class: 'code', text: line.slice(1) || ' ' })));
  }
  return rows.length ? rows : [el('div', { class: 'muted pad', text: 'No textual changes (binary or mode change).' })];
}

window.R = { el, markdown, mediaPreview, mediaKind, basename, toolSummary, fmtCost, kb, escapeHtml, linkifyHtml, icon, hydrateIcons, graphRows, graphSvg, laneContinuation, refBadges, relTime, statusBadge, pathParts, diffView, LANE_W };
})();
