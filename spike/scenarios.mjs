import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeScenario, resultEvent, initEvent, BASE_FLAGS } from './lib/common.mjs';
import { allow, deny, textResult } from './lib/mcp-server.mjs';
import { childEnv, psList, killGroup } from './lib/run-claude.mjs';

const PP = 'permission_prompt';
const isPP = (c) => c.name === PP;
const allowOrig = (c) => ({ result: allow(c.args?.input) });
const handlerAllow = (c) => (isPP(c) ? allowOrig(c) : { result: textResult('ok') });
const handlerDeny = (msg) => (c) => (isPP(c) ? { result: deny(msg) } : { result: textResult('ok') });
const T1_PROMPT = 'Reply with the single word: pong';
const makeFile = (f) => `Create a file named ${f} containing exactly: hello`;
const uuid = () => crypto.randomUUID();
const firstTextDelta = (ev) => ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event?.delta?.type === 'text_delta';
const toolUseEvent = (ev) => ev.type === 'assistant' && ev.message?.content?.some?.((c) => c.type === 'tool_use');
const lastOf = (run, pred) => run.events.findLast(pred);
const text = (run) => resultEvent(run)?.result;

export const scenarios = {};
const def = (id, fn) => { scenarios[id] = fn; };

def('T1', async () => {
  const sc = makeScenario('T1');
  await sc.step('run', { prompt: T1_PROMPT });
});

def('T2', async () => {
  const sc = makeScenario('T2');
  await sc.step('run', { prompt: 'Read notes.txt and reply with its first word.', ask: true, handler: handlerAllow, seed: { 'notes.txt': 'alpha beta' } });
});

def('T3', async () => {
  const sc = makeScenario('T3');
  await sc.step('run', { prompt: 'Create a file named created.txt containing hello. Try every tool you have, including shell commands.', ask: true, handler: handlerDeny('Denied by spike test (T3)') });
});

def('P1', async () => {
  const sc = makeScenario('P1');
  const a = await sc.step('a-no-updatedInput', { prompt: makeFile('a.txt'), handler: (c) => (isPP(c) ? { result: allow() } : { result: textResult('ok') }) });
  if (!fs.existsSync(path.join(sc.work, 'a.txt'))) {
    console.log('[P1] a.txt missing; running variant b with updatedInput');
    await sc.step('b-with-updatedInput', { prompt: makeFile('a.txt'), handler: handlerAllow });
  }
});

def('P2', async () => {
  const sc = makeScenario('P2');
  await sc.step('run', { prompt: makeFile('b.txt'), handler: handlerDeny('Denied by spike test') });
});

def('P3', async () => {
  const sc = makeScenario('P3');
  await sc.step('run', {
    prompt: makeFile('c.txt'),
    handler: (c) => {
      if (!isPP(c)) return { result: textResult('ok') };
      const input = { ...(c.args?.input ?? {}) };
      if ('content' in input) input.content = 'changed by host';
      return { result: allow(input) };
    },
  });
});

def('P4', async () => {
  const sc = makeScenario('P4');
  await sc.step('a-echo', { prompt: 'Run exactly this shell command and nothing else: echo spike-ok > d.txt', handler: handlerAllow });
  await sc.step('b-ls', { prompt: 'Run exactly this shell command and nothing else: ls', handler: handlerAllow });
});

def('P5', async () => {
  const sc = makeScenario('P5');
  await sc.step('run', {
    prompt: 'Call the tool named mcp__agentcanopy__permission_prompt with arguments {"tool_name":"Bash","input":{"command":"ls"}} and tell me what it returned.',
    handler: (c) => ({ result: deny('Denied by spike test (P5)') }),
  });
});

def('P6', async () => {
  const sc = makeScenario('P6');
  await sc.step('run', { prompt: makeFile('e.txt'), handler: handlerAllow, args: ['--disallowedTools', 'mcp__agentcanopy__permission_prompt'] });
});

def('A1', async () => {
  const sc = makeScenario('A1');
  await sc.step('a-allowedTools-only', { prompt: 'Create a file named f.txt containing exactly: hello', handler: handlerAllow, args: ['--allowedTools', 'Write', 'Edit'] });
  await sc.step('b-with-ask-rule', {
    prompt: 'Create a file named g.txt containing exactly: hello', handler: handlerAllow,
    settings: { permissions: { ask: ['Edit', 'Write', 'NotebookEdit'] } }, args: ['--allowedTools', 'Write', 'Edit'],
  });
});

def('A2', async () => {
  const sc = makeScenario('A2');
  await sc.step('run', {
    prompt: makeFile('h.txt'), handler: handlerAllow, args: ['--allowedTools', 'Write', 'Edit'],
    settings: (srv) => ({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: srv.hookUrl, timeout: 30 }] }] } }),
  });
});

const askHandler = (answer) => (c) => {
  if (!isPP(c)) return { result: textResult('ok') };
  const input = c.args?.input ?? {};
  if (c.args?.tool_name === 'AskUserQuestion') {
    const answers = {};
    for (const q of input.questions ?? []) answers[q.question] = answer;
    return { result: allow({ ...input, answers }) };
  }
  return { result: allow(input) };
};
def('Q1', async () => {
  const sc = makeScenario('Q1');
  await sc.step('a-single', { prompt: 'Use the AskUserQuestion tool to ask me which colour I prefer, with the options Red and Blue. Then reply with only my answer.', ask: true, handler: askHandler('Blue') });
  await sc.step('b-multiselect', { prompt: 'Use the AskUserQuestion tool to ask me which colours I like, as a multi-select question (multiSelect true) with the options Red and Blue. Then reply with only my answer.', ask: true, handler: askHandler('Red, Blue') });
  await sc.step('c-freetext', { prompt: 'Use the AskUserQuestion tool to ask me which colour I prefer, with the options Red and Blue. Then reply with only my answer.', ask: true, handler: askHandler('Chartreuse') });
});

def('S1', async () => {
  const sc = makeScenario('S1');
  const U1 = uuid(), U2 = uuid(), U3 = uuid();
  const t1 = await sc.step('t1', { prompt: 'Remember the codeword AZURE-17. Reply with OK.', args: ['--session-id', U1] });
  const t2 = await sc.step('t2', { prompt: 'Remember a second codeword BRICK-42. Reply with OK.', args: ['--resume', U1] });
  const P = 'List every codeword you were told, comma separated.';
  await sc.step('fork-latest', { prompt: P, args: ['--resume', U1, '--fork-session', '--session-id', U2] });
  const asst = lastOf(t1, (e) => e.type === 'assistant')?.uuid;
  const res1 = lastOf(t1, (e) => e.type === 'result')?.uuid;
  const user2 = t2.events.find((e) => e.type === 'user')?.uuid;
  const ok = (r) => /AZURE-17/.test(text(r) ?? '') && !/BRICK-42/.test(text(r) ?? '');
  const tries = [['fork-earlier-asst', asst], ['fork-earlier-result', res1], ['fork-earlier-user2', user2]];
  for (const [n, at] of tries) {
    if (!at) { console.log(`[S1] no uuid for ${n}`); continue; }
    const r = await sc.step(n, { prompt: P, args: ['--resume', U1, '--fork-session', '--session-id', n === 'fork-earlier-asst' ? U3 : uuid(), '--resume-session-at', at] });
    if (n === 'fork-earlier-asst' && ok(r)) break;
    // continue trying others only when the first did not give the expected cut
    if (ok(r)) break;
  }
  await sc.step('t3-original', { prompt: 'List every codeword you were told.', args: ['--resume', U1] });
  await sc.step('resume-missing', { prompt: 'Reply with OK.', args: ['--resume', uuid()] });
  fs.writeFileSync(path.join(sc.dir, 'ids.json'), JSON.stringify({ U1, U2, U3, asst, res1, user2 }, null, 2));
});

def('S2', async () => {
  const sc = makeScenario('S2');
  const U = uuid();
  await sc.step('t1-ask', { prompt: 'Reply with OK.', ask: true, handler: handlerAllow, args: ['--session-id', U] });
  await sc.step('t2-default', { prompt: 'Create a file named m.txt containing exactly: hello', handler: handlerAllow, args: ['--resume', U] });
  await sc.step('t3-ask', { prompt: 'Which file did you create? Reply with its name.', ask: true, handler: handlerAllow, args: ['--resume', U] });
});

def('C1', async () => {
  const sc = makeScenario('C1');
  const P = 'Count from 1 to 400, one number per line, no other text.';
  const a = await sc.step('sigint', { prompt: P, signals: [{ id: 'first-text-delta', when: firstTextDelta, afterMs: 2000, signal: 'SIGINT' }] });
  const sid = initEvent(a)?.session_id;
  await sc.step('sigint-resume', { prompt: 'What was the last number you wrote? Reply with the number only.', args: ['--resume', sid] });
  await sc.step('sigterm', { prompt: P, signals: [{ id: 'first-text-delta', when: firstTextDelta, afterMs: 2000, signal: 'SIGTERM' }] });
});

def('C2', async () => {
  const sc = makeScenario('C2');
  await sc.step('run', {
    prompt: 'Run exactly this shell command: sleep 45', handler: handlerAllow,
    signals: [{ id: 'tool-use', when: toolUseEvent, afterMs: 5000, signal: 'SIGINT' }],
    survivorCheckDelayMs: 5000, survivorMatch: 'sleep 45',
  });
});

def('C3', async () => {
  const sc = makeScenario('C3');
  await sc.step('run', {
    prompt: makeFile('k.txt'), handler: (c) => (isPP(c) ? { never: true } : { result: textResult('ok') }),
    onStart: (h, srv) => srv.events.on('call', (c) => { if (c.name === PP) setTimeout(() => h.send('SIGINT', 'C3: 5s after permission request'), 5000); }),
    timeoutMs: 120000,
  });
});

def('C4', async () => {
  const sc = makeScenario('C4');
  const { startServer } = await import('./lib/mcp-server.mjs');
  const { fileURLToPath: f2p } = await import('node:url');
  const prefix = 'run.';
  const srv = await startServer({ dir: sc.dir, prefix, handler: handlerAllow });
  const args = [...BASE_FLAGS, '--model', 'haiku', '--mcp-config', srv.configFile, '--permission-prompt-tool', 'mcp__agentcanopy__permission_prompt'];
  const cfgFile = path.join(sc.dir, 'run.orphan-config.json');
  const prompt = 'Run exactly this shell command: sleep 45';
  fs.writeFileSync(cfgFile, JSON.stringify({ args, cwd: sc.work, env: childEnv(), prompt }), { mode: 0o600 });
  const parentPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'orphan-parent.mjs');
  const t0 = Date.now();
  const parent = spawn(process.execPath, [parentPath, cfgFile], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = fs.createWriteStream(path.join(sc.dir, 'run.stdout.ndjson'));
  const err = fs.createWriteStream(path.join(sc.dir, 'run.stderr.txt'));
  let childPid = null, buf = '', killedAt = null, errBuf = '';
  parent.stderr.on('data', (d) => {
    err.write(d); errBuf += d.toString();
    const m = errBuf.match(/CHILD_PID (\d+)/); if (m) childPid = +m[1];
  });
  parent.stdout.on('data', (d) => {
    out.write(d); buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (!killedAt && toolUseEvent(ev)) {
        killedAt = Date.now() - t0;
        setTimeout(() => { try { process.kill(parent.pid, 'SIGKILL'); } catch {} }, 1000);
      }
    }
  });
  const parentExit = await new Promise((r) => parent.on('close', (c, s) => r({ code: c, signal: s })));
  const afterKill = Date.now();
  await new Promise((r) => setTimeout(r, 10000));
  const ps = psList();
  const claudeAlive = childPid ? ps.filter((p) => p.pid === childPid || p.pgid === childPid) : [];
  const sleepAlive = ps.filter((p) => p.command.includes('sleep 45'));
  const meta = { scenario: 'C4', step: 'run', childPid, parentPid: parent.pid, killedParentAtMs: killedAt, parentExit,
    aliveAfter10s: { claudeAndGroup: claudeAlive, sleepByCommand: sleepAlive },
    parentStillRunning: ps.some((p) => p.pid === parent.pid), orphanPpidOfChild: ps.find((p) => p.pid === childPid)?.ppid ?? null,
    eventsAfterParentKilledNote: 'harness stopped reading stdout when parent died; see mcp.jsonl for CLI activity after kill' };
  // cleanup
  if (childPid) killGroup(childPid, 'SIGKILL');
  for (const p of sleepAlive) { try { process.kill(p.pid, 'SIGKILL'); } catch {} }
  await new Promise((r) => setTimeout(r, 500));
  meta.mcpAfterKill = fs.readFileSync(path.join(sc.dir, 'run.mcp.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.ms > afterKill - 1500).map((x) => ({ t: x.t, method: x.body?.method, event: x.event }));
  meta.cleanedUp = true;
  out.end(); err.end();
  await srv.close();
  fs.writeFileSync(path.join(sc.dir, 'run.meta.json'), JSON.stringify(meta, null, 2));
  console.log('[C4] done', JSON.stringify({ childPid, claudeAlive: claudeAlive.length, sleepAlive: sleepAlive.length }));
});

const D1 = (id, delayMs, opts = {}) => def(id, async () => {
  const sc = makeScenario(id);
  await sc.step('run', {
    prompt: makeFile(`${id.toLowerCase()}.txt`), timeoutMs: 900000, env: opts.env,
    handler: (c) => (isPP(c) ? { ...(opts.sse ? { sse: { everyMs: 25000 } } : {}), delayMs, result: allow(c.args?.input) } : { result: textResult('ok') }),
  });
});
D1('D1a', 75000); D1('D1b', 150000); D1('D1c', 330000);
D1('D1d', 330000, { sse: true });
D1('D1e', 330000, { env: { CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0' } });
def('D1', async () => {
  // run the five as separate processes in parallel
  const here = fileURLToPath(import.meta.url);
  const run = path.join(path.dirname(here), 'run.mjs');
  await Promise.all(['D1a', 'D1b', 'D1c', 'D1d', 'D1e'].map((id) => new Promise((r) => {
    const p = spawn(process.execPath, [run, id], { stdio: 'inherit' }); p.on('close', r);
  })));
});

def('L1', async () => {
  const sc = makeScenario('L1');
  const flags = ['--allowedTools', 'mcp__agentcanopy__submit_plan'];
  const planHandler = (n = { c: 0 }, errFirst = false) => (c) => {
    if (isPP(c)) return { result: allow(c.args?.input) };
    if (c.name === 'submit_plan') { n.c++; return errFirst && n.c === 1 ? { result: textResult('Invalid plan: stages[0].title is required', true) } : { result: textResult('Plan saved.') }; }
    return { result: textResult('ok') };
  };
  await sc.step('a-basic', { prompt: 'Call the submit_plan tool with a plan titled Demo that has two stages. Then reply with DONE.', ask: true, submitPlan: true, args: flags, handler: planHandler() });
  await sc.step('b-error-retry', { prompt: 'Call the submit_plan tool with a plan titled Demo that has two stages. Then reply with DONE.', ask: true, submitPlan: true, args: flags, handler: planHandler({ c: 0 }, true) });
  await sc.step('c-big', { prompt: 'Call submit_plan with a plan titled Big whose notes field contains about 2500 words describing a fictional library migration, and two stages. Then reply with DONE.', ask: true, submitPlan: true, args: flags, handler: planHandler(), timeoutMs: 400000 });
});

def('X1', async () => {
  const sc = makeScenario('X1');
  await sc.step('run', {
    prompt: 'Run exactly this shell command: echo in > inside.txt; echo out > ../outside-probe.txt', handler: handlerAllow,
    settings: { sandbox: { enabled: true, autoAllowBashIfSandboxed: false } },
  });
});

def('E1', async () => {
  const sc = makeScenario('E1');
  await sc.step('a-bad-model', { prompt: T1_PROMPT, model: 'not-a-real-model-xyz' });
  await sc.step('b-bad-settings', { prompt: T1_PROMPT, settings: { permissions: { ask: [42] } } });
});


// ---- extra variants (not in the brief): prompts that name the Write tool, and an earlier SIGTERM ----
const WRITE_PROMPT = (f) => `Use the Write tool to create a file named ${f} containing exactly: hello`;
def('P1x', async () => {
  const sc = makeScenario('P1x');
  await sc.step('write-no-updatedInput', { prompt: WRITE_PROMPT('a2.txt'), handler: (c) => (isPP(c) ? { result: allow() } : { result: textResult('ok') }) });
});
def('A1x', async () => {
  const sc = makeScenario('A1x');
  await sc.step('a-allowedTools-only', { prompt: WRITE_PROMPT('f2.txt'), handler: handlerAllow, args: ['--allowedTools', 'Write', 'Edit'] });
  await sc.step('b-with-ask-rule', { prompt: WRITE_PROMPT('g2.txt'), handler: handlerAllow, settings: { permissions: { ask: ['Edit', 'Write', 'NotebookEdit'] } }, args: ['--allowedTools', 'Write', 'Edit'] });
});
def('A2x', async () => {
  const sc = makeScenario('A2x');
  await sc.step('run', {
    prompt: WRITE_PROMPT('h2.txt'), handler: handlerAllow, args: ['--allowedTools', 'Write', 'Edit'],
    settings: (srv) => ({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'http', url: srv.hookUrl, timeout: 30 }] }] } }),
  });
});
// Hook ordering: does PreToolUse come before the permission request, and which hook (if any)
// follows a denied call, a failing file tool and a failing command?
def('H1', async () => {
  const sc = makeScenario('H1');
  const hooks = (srv) => {
    const entry = [{ matcher: '*', hooks: [{ type: 'http', url: srv.hookUrl, timeout: 30 }] }];
    return {
      permissions: { ask: ['Edit', 'Write', 'NotebookEdit'] },
      hooks: { PreToolUse: entry, PostToolUse: entry, PostToolUseFailure: entry },
    };
  };
  await sc.step('a-denied-write', {
    prompt: 'Use the Write tool to create a file named hk-a.txt containing exactly: hello. If it is refused, stop and say so.',
    handler: handlerDeny('Denied by spike test (H1)'),
    settings: hooks,
  });
  await sc.step('b-failing-edit', {
    prompt: 'Use the Edit tool to replace the text ZZZ with YYY in notes.txt. Do not read the file first. If it fails, stop and say so.',
    handler: handlerAllow,
    settings: hooks,
    seed: { 'notes.txt': 'alpha beta' },
  });
  await sc.step('c-failing-command', {
    prompt: 'Run exactly this shell command and nothing else: ls /definitely-not-a-real-dir-xyz',
    handler: handlerAllow,
    settings: hooks,
  });
});
// Project-supplied Claude Code configuration: does `--setting-sources user` drop a repository's
// .claude/settings.json (allow rules, env) while keeping our --settings file, CLAUDE.md and the
// user's own setup? Does a repository's .mcp.json start a server without --strict-mcp-config? Do
// ask rules beat project allow rules and Claude Code's own read-only command classification?
def('H2', async () => {
  const sc = makeScenario('H2');
  fs.mkdirSync(path.join(sc.work, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(sc.work, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash'] },
    env: { AGC_SPIKE_ENV: 'from-project' },
  }));
  fs.writeFileSync(path.join(sc.work, 'CLAUDE.md'), 'The project codeword is MAPLE-9.\n');
  fs.writeFileSync(path.join(sc.work, 'notes.txt'), 'alpha beta\n');
  const mcp = (marker) => fs.writeFileSync(path.join(sc.work, '.mcp.json'), JSON.stringify({
    mcpServers: { spikeproject: { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x');setInterval(()=>{},1000)`] } },
  }));
  const denyAll = handlerDeny('Denied by spike test (H2)');
  const user = ['--setting-sources', 'user'];
  const runCmd = (cmd) => `Run exactly this shell command and nothing else: ${cmd}`;

  await sc.step('a-baseline-project-allow', { prompt: runCmd('touch spike-a.txt'), handler: denyAll });
  await sc.step('b-sources-user', { prompt: runCmd('touch spike-b.txt'), handler: denyAll, args: user });
  await sc.step('c-our-settings-still-apply', {
    prompt: 'Use the Write tool to create a file named spike-c.txt containing exactly: hello',
    handler: denyAll, args: [...user, '--allowedTools', 'Write'],
    settings: { permissions: { ask: ['Write'] } },
  });
  await sc.step('d-env-baseline', { prompt: runCmd('echo "[$AGC_SPIKE_ENV]"'), handler: handlerAllow });
  await sc.step('e-env-sources-user', { prompt: runCmd('echo "[$AGC_SPIKE_ENV]"'), handler: handlerAllow, args: user });
  await sc.step('f-claude-md-sources-user', {
    prompt: 'Without using any tool, reply with the project codeword from your instructions, or NONE if you have none.',
    args: user,
  });
  mcp('mcp-ran-g.txt');
  await sc.step('g-mcp-default', { prompt: T1_PROMPT });
  mcp('mcp-ran-h.txt');
  await sc.step('h-mcp-sources-user', { prompt: T1_PROMPT, args: user });
  fs.rmSync(path.join(sc.work, '.mcp.json'));
  await sc.step('i-read-ask', {
    prompt: 'Read notes.txt and reply with its first word.',
    handler: denyAll, args: user,
    settings: { permissions: { ask: ['Read', 'Grep', 'Glob'] } },
  });
  await sc.step('j-bash-ask-beats-project-allow', {
    prompt: runCmd('ls'), handler: denyAll,
    settings: { permissions: { ask: ['Bash'] } },
  });
});
def('C1x', async () => {
  const sc = makeScenario('C1x');
  const P = 'Count from 1 to 400, one number per line, no other text.';
  const a = await sc.step('sigterm-800ms', { prompt: P, signals: [{ id: 'first-text-delta', when: firstTextDelta, afterMs: 800, signal: 'SIGTERM' }] });
  await sc.step('sigterm-800ms-resume', { prompt: 'What was the last number you wrote? Reply with the number only.', args: ['--resume', initEvent(a)?.session_id] });
  const b = await sc.step('sigint-800ms', { prompt: P, signals: [{ id: 'first-text-delta', when: firstTextDelta, afterMs: 800, signal: 'SIGINT' }] });
});


def('C2x', async () => {
  const sc = makeScenario('C2x');
  const sample = (name) => (h) => {
    const rows = [];
    const t = setInterval(() => rows.push({ ms: Date.now() - h.t0, procs: psList().filter((p) => p.command.includes('sleep 45') && !p.command.startsWith('ps ')) }), 1000);
    h.bus.on('close', () => clearInterval(t));
    h.samples = rows;
    setTimeout(() => { clearInterval(t); fs.writeFileSync(path.join(sc.dir, `${name}.ps-samples.json`), JSON.stringify(rows, null, 1)); }, 20000);
  };
  // (a) the brief's prompt, with ps sampling
  await sc.step('a-sleep-sampled', {
    prompt: 'Run exactly this shell command: sleep 45', handler: handlerAllow,
    onStart: sample('a-sleep-sampled'),
    signals: [{ id: 'tool-use', when: toolUseEvent, afterMs: 5000, signal: 'SIGINT' }],
    survivorCheckDelayMs: 5000, survivorMatch: 'sleep 45',
  });
  // (b) a command that needs permission
  await sc.step('b-sleep-and-write', {
    prompt: 'Run exactly this shell command: sleep 45; echo done > s.txt', handler: handlerAllow,
    onStart: sample('b-sleep-and-write'),
    signals: [{ id: 'tool-use', when: toolUseEvent, afterMs: 5000, signal: 'SIGINT' }],
    survivorCheckDelayMs: 5000, survivorMatch: 'sleep 45',
  });
});

export const ORDER = ['T1', 'T2', 'T3', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'A1', 'A2', 'Q1', 'S1', 'S2', 'C1', 'C2', 'C3', 'C4', 'L1', 'X1', 'E1'];
