// Runs one `claude` CLI invocation, records raw outputs, supports signal-on-predicate.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDECODE') || k.startsWith('CLAUDE_CODE_') || k === 'ELECTRON_RUN_AS_NODE') delete env[k];
  }
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = '1';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  Object.assign(env, extra);
  return env;
}

export function psList() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    return m ? { pid: +m[1], ppid: +m[2], pgid: +m[3], command: m[4].slice(0, 200) } : null;
  }).filter(Boolean);
}
export const groupMembers = (pgid) => psList().filter((p) => p.pgid === pgid);
export function killGroup(pgid, sig = 'SIGKILL') { try { process.kill(-pgid, sig); } catch {} }

/**
 * opts: { args, prompt, cwd, env, outPrefix (path prefix for files), timeoutMs, signals, onStart,
 *         survivorCheckDelayMs, survivorMatch }
 * signals: [{ id, when(ev, handle) -> bool, afterMs, signal }]  (signal sent to the claude pid only)
 */
export async function runClaude(opts) {
  const { args, prompt, cwd, env, outPrefix, timeoutMs = 240000, signals = [], onStart, survivorCheckDelayMs = 0, survivorMatch } = opts;
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const child = spawn('claude', args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pgid = child.pid;
  const bus = new EventEmitter();
  const handle = { pid: child.pid, pgid, bus, on: (e, f) => bus.on(e, f), signalSent: [], t0,
    send(sig, reason = '') { handle.signalSent.push({ signal: sig, atMs: Date.now() - t0, reason }); try { process.kill(child.pid, sig); } catch (e) { handle.signalSent.at(-1).error = e.message; } } };
  const events = [];
  const timeline = [];
  const rawOut = fs.createWriteStream(`${outPrefix}stdout.ndjson`);
  const rawErr = fs.createWriteStream(`${outPrefix}stderr.txt`);
  let stderr = '';
  let buf = '';
  let spawnError = null;
  const fired = new Set();
  const handleLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { ev = { type: '__unparsed', raw: line.slice(0, 300) }; }
    const t = Date.now() - t0;
    events.push(ev);
    timeline.push({ t, type: ev.type, subtype: ev.subtype, uuid: ev.uuid });
    bus.emit('event', ev);
    for (const s of signals) {
      if (fired.has(s.id)) continue;
      let ok = false;
      try { ok = s.when(ev, handle); } catch {}
      if (ok) {
        fired.add(s.id);
        setTimeout(() => handle.send(s.signal, `${s.id}: ${s.afterMs}ms after trigger`), s.afterMs ?? 0);
      }
    }
  };
  child.stdout.on('data', (d) => {
    rawOut.write(d);
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handleLine(line); }
  });
  child.stderr.on('data', (d) => { rawErr.write(d); stderr += d.toString('utf8'); });
  child.stdin.on('error', () => {});
  child.on('error', (e) => { spawnError = e.message; });
  if (onStart) onStart(handle);
  child.stdin.write(prompt);
  child.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(pgid, 'SIGTERM');
    setTimeout(() => killGroup(pgid, 'SIGKILL'), 5000);
  }, timeoutMs);

  const { exitCode, signal } = await new Promise((resolve) => child.on('close', (c, s) => resolve({ exitCode: c, signal: s })));
  clearTimeout(timer);
  const exitedAtMs = Date.now() - t0;
  if (buf.trim()) handleLine(buf);
  rawOut.end(); rawErr.end();

  // survivors in the process group (and optionally by command match), then clean up
  if (survivorCheckDelayMs) await new Promise((r) => setTimeout(r, survivorCheckDelayMs));
  const survivors = groupMembers(pgid);
  const matched = survivorMatch ? psList().filter((p) => p.command.includes(survivorMatch) && p.pid !== process.pid) : [];
  killGroup(pgid, 'SIGKILL');
  for (const p of matched) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }

  const durationMs = Date.now() - t0;
  const meta = { startedAt, args, cwd, pid: child.pid, exitCode, signal, durationMs, exitedAtMs, timedOut, spawnError,
    signalsSent: handle.signalSent, survivorsInGroupAfterExit: survivors, survivorsByCommandMatch: matched,
    survivorCheckDelayMs, eventCount: events.length, apiKeyPresent: process.env.ANTHROPIC_API_KEY ? 'yes' : 'no' };
  fs.writeFileSync(`${outPrefix}timeline.jsonl`, timeline.map((x) => JSON.stringify(x)).join('\n') + '\n');
  return { events, stderr, exitCode, signal, durationMs, meta, timeline, handle };
}
