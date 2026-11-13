// Writes scrubbed copies of selected stdout NDJSON files to test/fixtures/cli/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { OUT, SCRATCH } from './lib/common.mjs';

const USERNAME = os.userInfo().username;

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = { T1: ['T1', 'run'], T2: ['T2', 'run'], P1: ['P1', 'a-no-updatedInput'], P2: ['P2', 'run'], Q1: ['Q1', 'a-single'], S1: ['S1', 't1'], C1: ['C1', 'sigint'], E1: ['E1', 'a-bad-model'], L1: ['L1', 'a-basic'] };
const KEY = /email|org|account|token|secret|password|credential/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const SECRETISH = /sk-ant-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+/;

function scrubString(s, scenario) {
  const work = path.join(OUT, scenario, 'work');
  s = s.replace(/-private-tmp-claude-\d+-[^/"\s]*/g, '-work');
  return s.split(work).join('/work').split(SCRATCH).join('/scratch')
    .replace(/\/private\/tmp\/claude-\d+\/[^\s"']*/g, '/scratch')
    .replace(/\/Users\/[^/\s"']+/g, '/home/user').replace(/-Users-[A-Za-z0-9_.]+/g, '-home-user')
    .split(USERNAME).join('user');
}
function walk(v, key, scenario) {
  if (typeof v === 'string') {
    if (EMAIL.test(v) || SECRETISH.test(v) || /^org/i.test(v)) return "";
    if (key && KEY.test(key)) return '';
    return scrubString(v, scenario);
  }
  if (Array.isArray(v)) return v.map((x) => walk(x, key, scenario));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (KEY.test(k) && typeof x !== 'number' && typeof x !== 'boolean') o[k] = typeof x === 'string' ? '' : x == null ? x : (Array.isArray(x) ? [] : {});
      else o[k] = walk(x, k, scenario);
    }
    return o;
  }
  return v;
}
// Text/JSON deltas can split a path across chunks; scrub the joined text and re-split it into the same number of chunks.
function rechunkDeltas(events, scenario) {
  const groups = new Map();
  for (const e of events) {
    const d = e.type === 'stream_event' && e.event?.type === 'content_block_delta' ? e.event.delta : null;
    const field = d?.type === 'input_json_delta' ? 'partial_json' : d?.type === 'text_delta' ? 'text' : null;
    if (!field || typeof d[field] !== 'string') continue;
    const key = `${e.api_message_id ?? ''}:${e.event.index}:${field}`;
    if (!groups.has(key)) groups.set(key, { field, deltas: [] });
    groups.get(key).deltas.push(d);
  }
  for (const { field, deltas } of groups.values()) {
    const joined = scrubString(deltas.map((d) => d[field]).join(''), scenario);
    const size = Math.ceil(joined.length / deltas.length);
    deltas.forEach((d, i) => { d[field] = joined.slice(i * size, (i + 1) * size); });
  }
}
export function writeFixtures() {
  const dest = path.join(REPO, 'test', 'fixtures', 'cli');
  fs.mkdirSync(dest, { recursive: true });
  for (const [name, [scenario, step]] of Object.entries(FIXTURES)) {
    const src = path.join(OUT, scenario, `${step}.stdout.ndjson`);
    if (!fs.existsSync(src)) { console.log(`fixture ${name}: source missing`); continue; }
    const parsed = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { unparsed: l }; } });
    rechunkDeltas(parsed, scenario);
    const lines = parsed.map((o) => JSON.stringify(o.unparsed !== undefined ? { unparsed: scrubString(o.unparsed, scenario) } : walk(o, null, scenario)));
    fs.writeFileSync(path.join(dest, `${name}.ndjson`), lines.join('\n') + '\n');
    console.log(`fixture ${name}: ${lines.length} lines`);
  }
}
