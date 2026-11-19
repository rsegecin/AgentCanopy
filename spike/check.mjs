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
        if (id === 'G1') console.log(summarizeG1(dir, s));
      } catch (e) { console.log(`${id}/${s}: check error ${e.message}`); }
    }
  }
}

// ---- G1: model and identity of subagents launched in parallel ----
const NP = 'not present';
const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : NP);
const agentLike = (o) => {
  const ks = Object.keys(o ?? {}).filter((k) => /agent/i.test(k));
  return ks.length ? ks.map((k) => `${k}=${JSON.stringify(o[k])}`).join(' ') : `agent-like keys=${NP}`;
};

export function summarizeG1(dir, step) {
  const p = (x) => path.join(dir, `${step}.${x}`);
  const ev = readJsonl(p('stdout.ndjson'));
  const mcp = readJsonl(p('mcp.jsonl'));
  const hook = readJsonl(p('hook.jsonl'));
  const timeline = readJsonl(p('timeline.jsonl'));
  const out = [];
  const say = (s) => out.push(s);
  const parentOf = (e) => e.parent_tool_use_id ?? null;

  // 1. init
  const init = ev.find((e) => e.type === 'system' && e.subtype === 'init');
  say('1. init');
  if (!init) say(`   init event: ${NP}`);
  else {
    const tools = init.tools ?? [];
    say(`   model: ${init.model ?? NP}`);
    say(`   tools: Task listed=${tools.includes('Task')} Agent listed=${tools.includes('Agent')} (${tools.length} tools)`);
    say(`   agents: ${init.agents === undefined ? NP : JSON.stringify(init.agents)}`);
  }

  // Map every tool_use id seen in the stream to the parent_tool_use_id of the event that carried it.
  const toolUseParent = new Map();
  const assistants = ev.filter((e) => e.type === 'assistant');
  for (const e of assistants) for (const c of e.message?.content ?? []) if (c.type === 'tool_use') toolUseParent.set(c.id, parentOf(e));

  // 2. launch tool uses in the main session
  say('2. subagent-launch tool_use in main-session assistant events (parent_tool_use_id null)');
  const isLaunch = (c) => c.type === 'tool_use' && (c.name === 'Task' || c.name === 'Agent' || c.input?.subagent_type !== undefined);
  const launches = assistants.filter((e) => parentOf(e) === null).flatMap((e) => (e.message?.content ?? []).filter(isLaunch));
  if (!launches.length) say('   none');
  for (const c of launches) {
    const st = c.input?.subagent_type === undefined ? NP : JSON.stringify(c.input.subagent_type);
    const md = c.input?.model === undefined ? NP : JSON.stringify(c.input.model);
    say(`   ${c.name} id=${c.id} input keys=[${keysOf(c.input)}] subagent_type=${st} model=${md}`);
  }

  // 3. message.model by parent_tool_use_id
  say('3. distinct message.model on assistant events, by parent_tool_use_id (null = main session)');
  const byParent = new Map();
  for (const e of assistants) {
    const k = String(parentOf(e));
    if (!byParent.has(k)) byParent.set(k, new Set());
    byParent.get(k).add(e.message?.model ?? NP);
  }
  if (!byParent.size) say('   no assistant events');
  for (const [k, s] of byParent) say(`   ${k}: ${[...s].join(', ')}`);

  // 4. modelUsage
  const result = ev.findLast((e) => e.type === 'result');
  say('4. result.modelUsage keys');
  say(`   ${result?.modelUsage ? Object.keys(result.modelUsage).join(', ') : NP}`);

  // 5. permission prompts
  say('5. permission_prompt calls (mcp.jsonl)');
  const calls = mcp.filter((x) => x.kind === 'mcp' && x.body?.method === 'tools/call' && x.body.params?.name === 'permission_prompt');
  if (!calls.length) say('   none');
  else say(`   request top-level keys (first call): [${keysOf(calls[0].body.params.arguments)}]; params._meta keys: [${keysOf(calls[0].body.params._meta)}]`);
  for (const x of calls) {
    const a = x.body.params.arguments ?? {};
    const tuid = a.tool_use_id;
    const par = tuid === undefined ? NP : toolUseParent.has(tuid) ? String(toolUseParent.get(tuid)) : 'tool_use_id not seen in stream';
    say(`   ${x.t} tool_name=${a.tool_name ?? NP} tool_use_id=${tuid ?? NP} parent_tool_use_id(from stream)=${par} ${agentLike(a)}`);
  }

  // 6. hooks
  say('6. PreToolUse hook bodies (hook.jsonl)');
  const pre = hook.filter((h) => h.body?.hook_event_name === 'PreToolUse');
  say(`   entries: ${hook.length} total, ${pre.length} PreToolUse; event names: ${[...new Set(hook.map((h) => h.body?.hook_event_name ?? NP))].join(', ') || NP}`);
  if (pre.length) say(`   top-level keys (first PreToolUse): [${keysOf(pre[0].body)}]`);
  for (const h of pre) {
    const b = h.body;
    say(`   ${h.t} tool_name=${b.tool_name ?? NP} tool_use_id=${b.tool_use_id ?? NP} ${agentLike(b)} cwd=${b.cwd ?? NP}`);
  }

  // 7. overlap
  say('7. overlap of the subagents');
  const hasAgentId = hook.some((h) => h.body?.agent_id !== undefined);
  say(`   hook grouping: ${hasAgentId ? 'body.agent_id' : 'body.tool_use_id mapped to parent_tool_use_id through the stream (no agent_id in the hooks)'}; times: "t" in hook.jsonl (server receive time, ISO)`);
  const groups = new Map();
  for (const h of hook) {
    const b = h.body ?? {};
    const g = hasAgentId ? (b.agent_id ?? 'main') : (b.tool_use_id !== undefined && toolUseParent.has(b.tool_use_id) ? String(toolUseParent.get(b.tool_use_id)) : 'unknown');
    const ms = Date.parse(h.t);
    const cur = groups.get(g) ?? { first: ms, last: ms, n: 0 };
    cur.first = Math.min(cur.first, ms); cur.last = Math.max(cur.last, ms); cur.n++;
    groups.set(g, cur);
  }
  const overlap = (list) => list.some(([, a], i) => list.some(([, b], j) => i < j && a.first <= b.last && b.first <= a.last));
  if (!groups.size) say('   no hook entries');
  for (const [g, v] of groups) say(`   ${g}: first=${new Date(v.first).toISOString()} last=${new Date(v.last).toISOString()} hooks=${v.n}`);
  const sub = [...groups].filter(([g]) => g !== 'main' && g !== 'null' && g !== 'unknown');
  say(sub.length >= 2 ? `   hook-based overlap between subagents: ${overlap(sub) ? 'yes' : 'no'}` : `   hook-based overlap: not determinable (${sub.length} subagent group found)`);

  // Second view from the stream: events carrying a parent_tool_use_id, timed by timeline.jsonl (ms since start).
  if (timeline.length && timeline.length === ev.length) {
    const sg = new Map();
    ev.forEach((e, i) => {
      if (e.type !== 'assistant' && e.type !== 'user') return;
      const k = parentOf(e);
      if (k === null) return;
      const t = timeline[i].t;
      const cur = sg.get(k) ?? { first: t, last: t, n: 0 };
      cur.first = Math.min(cur.first, t); cur.last = Math.max(cur.last, t); cur.n++;
      sg.set(k, cur);
    });
    const sl = [...sg];
    for (const [g, v] of sl) say(`   stream ${g}: first=${v.first}ms last=${v.last}ms events=${v.n} (timeline.jsonl)`);
    say(sl.length >= 2 ? `   stream-based overlap between subagents: ${overlap(sl) ? 'yes' : 'no'}` : `   stream-based overlap: not determinable (${sl.length} group with a parent_tool_use_id)`);
  } else say(`   stream-based view skipped: timeline.jsonl lines (${timeline.length}) do not match stdout events (${ev.length})`);
  return out.join('\n');
}
