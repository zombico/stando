// The contract every part of stando shares.
//
// On disk, one folder per session under ~/spikes/<id>/:
//   session.json   meta (runner, key, model, cwd, status, cliSession)
//   events.jsonl   everything that happened, one event per line (see EVENT TYPES)
//   inbox.jsonl    messages waiting to be sent: {text, source, ts}. Anything may append here.
//   ...            whatever the agent makes
//
// Over the socket (~/.stando/stando.sock), newline-delimited JSON:
//   client → daemon   {id, op, ...args}
//   daemon → client   {re: id, ok: true, data} | {re: id, ok: false, error}
//   daemon → client   {push: 'event', session, event} | {push: 'meta', meta}   (after op 'subscribe')
//
// EVENT TYPES (field `t`, plus `ts` in ms):
//   user        {text, source}               a message entered the session
//   turn_start  {runner, key, model}
//   text        {text}                       assistant prose
//   tool        {id, name, input}            a tool call
//   tool_result {id, text, error}
//   file        {path, size}                 a file appeared or changed in the spike folder
//   turn_end    {cost, ms, error, exit}
//   stderr      {text}
//   note        {text}                       stando's own remarks

import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.STANDO_HOME || path.join(os.homedir(), '.stando');
export const SPIKES = process.env.STANDO_SPIKES || path.join(os.homedir(), 'spikes');
export const SOCKET = path.join(HOME, 'stando.sock');

// Files stando itself writes into a spike; never reported as `file` events.
export const OWN_FILES = new Set(['session.json', 'events.jsonl', 'inbox.jsonl']);

// Splits a stream into lines and hands each parsed JSON object to `onObject`.
// Non-JSON lines go to `onText` when given.
export function lineReader(onObject, onText) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { onText?.(line); continue; }
      onObject(obj);
    }
  };
}

export const MEDIA = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'],
  video: ['mp4', 'webm', 'mov', 'm4v'],
  audio: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac'],
  model: ['glb', 'gltf', 'stl', 'obj', '3mf', 'usdz'],
};

export function mediaKind(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  for (const [kind, exts] of Object.entries(MEDIA)) if (exts.includes(ext)) return kind;
  return 'file';
}
