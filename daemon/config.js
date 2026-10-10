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
// Approvals are off on purpose: the operator chose to trust these runs.
// Override or add runners in ~/.stando/runners.json.
export const DEFAULT_RUNNERS = {
  claude: {
    kind: 'stream-json',
    argv: ['claude', '-p', '{prompt}', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions'],
    resume: ['--resume', '{session}'],
    modelFlag: '--model',
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

export const settings = () => ({ name: 'stando', ...read('settings.json', {}) });

export function saveSettings(patch) {
  const next = { ...settings() };
  if ('name' in patch) {
    const name = String(patch.name || '').trim().slice(0, 32);
    next.name = name || 'stando';
  }
  write('settings.json', next);
  return next;
}

export const runners = () => ({ ...DEFAULT_RUNNERS, ...read('runners.json', {}) });

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
