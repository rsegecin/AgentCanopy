// Re-reads recorded outputs and prints one line per step with the observations.
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './lib/common.mjs';

const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { __bad: l.slice(0, 100) }; } }) : []);
const cut = (s, n = 160) => { s = typeof s === 'string' ? s : JSON.stringify(s); return s == null ? '' : s.length > n ? s.slice(0, n) + `...(${s.length})` : s; };

export function summarizeStep(dir, step) {
  const p = (x) => path.join(dir, `${step}.${x}`);
  const meta = JSON.parse(fs.readFileSync(p('meta.json'), 'utf8'));
  if (meta.aliveAfter10s) meta.exitCode = `(parent killed) child ${meta.childPid} alive-after-10s=${meta.aliveAfter10s.claudeAndGroup.length > 0} ppid=${meta.orphanPpidOfChild} sleep-alive=${meta.aliveAfter10s.sleepByCommand.length > 0}`;
  const ev = readJsonl(p('stdout.ndjson'));
  const mcp = readJsonl(p('mcp.jsonl'));
  const hook = readJsonl(p('hook.jsonl'));
  const init = ev.find((e) => e.type === 'system' && e.subtype === 'init');
  const result = ev.findLast((e) => e.type === 'result');
  const toolUses = ev.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use').map((c) => c.name));
  const rpc = mcp.filter((x) => x.kind === 'mcp');
  const methods = rpc.map((x) => (x.method === 'POST' ? x.body?.method ?? '?' : x.method));
  const ppCalls = rpc.filter((x) => x.body?.method === 'tools/call').map((x) => ({ name: x.body.params?.name, args: x.body.params?.arguments, meta: x.body.params?._meta }));
  const o = {
    step, exit: meta.exitCode, sig: meta.signal, sec: Math.round(meta.durationMs / 100) / 10, timedOut: meta.timedOut || undefined,
    events: ev.length,
    types: ev.map((e) => (e.type === 'stream_event' ? 'se' : `${e.type}${e.subtype ? '/' + e.subtype : ''}`)).reduce((a, t) => { if (a.at(-1)?.[0] === t) a.at(-1)[1]++; else a.push([t, 1]); return a; }, []).map(([t, n]) => (n > 1 ? `${t}*${n}` : t)).join(' '),
    initTools: init?.tools, mcpServers: init?.mcp_servers, session: init?.session_id,
    toolUses,
    mcpMethods: methods.join(','),
    toolCalls: ppCalls.map((c) => ({ name: c.name, args: cut(c.args, 300), progressToken: c.meta?.progressToken !== undefined })),
    hookCalls: hook.length,
    result: result && { subtype: result.subtype, is_error: result.is_error, text: cut(result.result, 120), denials: result.permission_denials?.length, stop: result.stop_reason, terminal: result.terminal_reason },
    files: (meta.workAfter ?? []).filter((f) => !(meta.workBefore ?? []).some((b) => b.path === f.path)).map((f) => f.path),
    signalsSent: meta.signalsSent?.length ? meta.signalsSent : undefined,
    stderr: cut(fs.existsSync(p('stderr.txt')) ? fs.readFileSync(p('stderr.txt'), 'utf8') : '', 200) || undefined,
  };
  return o;
}

export function check(only, verbose) {
  const ids = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((d) => !only || d === only) : [];
  for (const id of ids.sort()) {
    const dir = path.join(OUT, id);
    const steps = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')).map((f) => f.replace(/\.meta\.json$/, ''));
    if (!steps.length) { console.log(`${id}: no recorded steps`); continue; }
    for (const s of steps) {
      try {
        const o = summarizeStep(dir, s);
        console.log(`${id}/${s}: ` + (verbose ? JSON.stringify(o, null, 1) : JSON.stringify(o)));
      } catch (e) { console.log(`${id}/${s}: check error ${e.message}`); }
    }
  }
}
