// Key profiles, runner definitions and per-key spend, all under ~/.stando.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME } from '../shared/protocol.js';

// Where each provider's CLI looks for its key. A profile may add extra env vars
// (a base URL, an org id) for CLIs that need them.
export const PROVIDERS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
};

// kind "stream-json": the CLI prints Claude-style JSON events and resumes by session id.
// kind "text": plain output; every turn is a fresh one-shot run.
// `models` are suggestions for the pickers; any name the CLI accepts still works.
// `effort` is the thinking level: the flag and the levels the CLI accepts, in order.
// Approvals are off on purpose: the operator chose to trust these runs.
// Override or add runners in ~/.stando/runners.json.
export const DEFAULT_RUNNERS = {
  claude: {
    kind: 'stream-json',
    argv: ['claude', '-p', '{prompt}', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions'],
    resume: ['--resume', '{session}'],
    modelFlag: '--model',
    // Aliases follow the newest model of each family, so they don't go stale; pinned names don't move.
    models: [
      { value: 'fable', label: 'Fable', group: 'Latest' },
      { value: 'opus', label: 'Opus', group: 'Latest' },
      { value: 'sonnet', label: 'Sonnet', group: 'Latest' },
      { value: 'haiku', label: 'Haiku', group: 'Latest' },
      { value: 'claude-fable-5-1', label: 'Fable 5.1', group: 'Pinned' },
      { value: 'claude-opus-5-5', label: 'Opus 5.5', group: 'Pinned' },
      { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'Pinned' },
      { value: 'claude-haiku-5-5', label: 'Haiku 5.5', group: 'Pinned' },
    ],
    effort: { flag: '--effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    // Where the CLI keeps its own default, so "auto" can say what it means.
    defaultModel: { file: '~/.claude/settings.json', key: 'model' },
    provider: 'anthropic',
  },
  qwen: {
    kind: 'stream-json',
    argv: ['qwen', '{prompt}', '--output-format', 'stream-json', '--yolo'],
    resume: ['--resume', '{session}'],
    modelFlag: '--model',
    provider: 'dashscope',
  },
  hermes: {
    kind: 'text',
    argv: ['hermes', '--yolo', '-z', '{prompt}'],
    modelFlag: '-m',
    provider: 'openrouter',
  },
};

function read(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, name), 'utf8')); }
  catch { return fallback; }
}

function write(name, data) {
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const file = path.join(HOME, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

// ---------- settings ----------
// What the operator calls their stando; shown in the app and the CLI.

// The theme is a mode plus per-mode overrides of the app's concept colors (see app/style.css).

export const THEME_MODES = ['system', 'dark', 'light'];
export const THEME_TOKENS = ['void', 'floor', 'bench', 'rail', 'rail-hi', 'ink', 'ink-soft', 'ink-faint',
  'live', 'act', 'think', 'record', 'fault'];

const defaultTheme = () => ({ mode: 'system', dark: {}, light: {} });

export const settings = () => {
  const s = { name: 'stando', ...read('settings.json', {}) };
  s.theme = { ...defaultTheme(), ...(s.theme || {}) };
  return s;
};

function cleanTokens(tokens) {
  const out = {};
  for (const [k, v] of Object.entries(tokens || {})) {
    if (!THEME_TOKENS.includes(k)) throw new Error(`unknown theme color ${k}; have ${THEME_TOKENS.join(', ')}`);
    if (v == null || v === '') continue;
    if (!/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${k}: use a color like #5eead4`);
    out[k] = v.toLowerCase();
  }
  return out;
}

export function saveSettings(patch) {
  const next = { ...settings() };
  if ('name' in patch) {
    const name = String(patch.name || '').trim().slice(0, 32);
    next.name = name || 'stando';
  }
  if ('theme' in patch) {
    const t = patch.theme || {};
    const theme = { ...next.theme };
    if ('mode' in t) {
      if (!THEME_MODES.includes(t.mode)) throw new Error(`theme mode: ${THEME_MODES.join(', ')}`);
      theme.mode = t.mode;
    }
    for (const m of ['dark', 'light']) if (m in t) theme[m] = cleanTokens(t[m]);
    next.theme = theme;
  }
  write('settings.json', next);
  return next;
}

// Anything else, for whoever wants more than colors: ~/.stando/theme.css loads after the app's own.
export function themeCss() {
  try { return fs.readFileSync(path.join(HOME, 'theme.css'), 'utf8'); } catch { return ''; }
}

export const runners = () => ({ ...DEFAULT_RUNNERS, ...read('runners.json', {}) });

// The model a CLI uses when stando passes none, read from the CLI's own settings file; null if unknown.
function cliDefaultModel(r) {
  const d = r.defaultModel;
  if (!d) return null;
  if (typeof d === 'string') return d;
  try {
    const file = d.file.replace(/^~(?=\/)/, process.env.HOME);
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))[d.key];
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}

// What the pickers need to know about each runner. Never argv or env.
export function runnersPublic() {
  return Object.fromEntries(Object.entries(runners()).map(([name, r]) => [name, {
    models: r.modelFlag ? (r.models || []).map((m) => (typeof m === 'string' ? { value: m, label: m } : m)) : null,
    defaultModel: r.modelFlag ? cliDefaultModel(r) : null,
    efforts: r.effort?.flag ? r.effort.levels || [] : null,
    provider: r.provider || null,
  }]));
}

// Throws unless `effort` is a level this runner accepts (or empty).
export function checkEffort(runnerName, effort) {
  if (!effort) return;
  const r = runners()[runnerName];
  if (!r?.effort?.flag) throw new Error(`${runnerName} has no thinking levels`);
  const levels = r.effort.levels || [];
  if (levels.length && !levels.includes(effort)) throw new Error(`thinking level for ${runnerName}: ${levels.join(', ')}`);
}

// ---------- keys ----------
// keys.json maps a short name ("anth-work") to {provider, value, env}.
// Values leave this module only as env vars for a spawned CLI.

const keys = () => read('keys.json', {});

export function keyEnv(name) {
  const k = keys()[name];
  if (!k) return {};
  const env = { ...(k.env || {}) };
  if (PROVIDERS[k.provider] && k.value) env[PROVIDERS[k.provider]] = k.value;
  return env;
}

export function hasKey(name) {
  return name in keys();
}

export function keysPublic() {
  const spent = spendToday();
  return Object.entries(keys()).map(([name, k]) => ({
    name,
    provider: k.provider,
    hint: k.value?.length > 8 ? '…' + k.value.slice(-4) : 'set',
    envNames: Object.keys(k.env || {}),
    today: spent[name] || 0,
  }));
}

export function addKey({ name, provider, value, env }) {
  if (!/^[\w.-]{1,40}$/.test(name || '')) throw new Error('key name: letters, digits, . _ - only');
  if (!PROVIDERS[provider] && !env) throw new Error(`unknown provider ${provider}; have ${Object.keys(PROVIDERS).join(', ')}`);
  if (!value && !env) throw new Error('key value is empty');
  const all = keys();
  all[name] = { provider, value: value || '', env: env || {} };
  write('keys.json', all);
}

export function removeKey(name) {
  const all = keys();
  if (!(name in all)) throw new Error(`no key named ${name}`);
  delete all[name];
  write('keys.json', all);
}

// ---------- spend ----------

const USAGE = () => path.join(HOME, 'usage.jsonl');

export function recordSpend(key, cost) {
  if (!key || !cost) return;
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  fs.appendFileSync(USAGE(), JSON.stringify({ ts: Date.now(), key, cost }) + '\n');
}

function spendToday() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const totals = {};
  let text = '';
  try { text = fs.readFileSync(USAGE(), 'utf8'); } catch { return totals; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    const { ts, key, cost } = JSON.parse(line);
    if (ts >= start.getTime()) totals[key] = (totals[key] || 0) + cost;
  }
  return totals;
}

export const newId = () => crypto.randomBytes(3).toString('hex');
