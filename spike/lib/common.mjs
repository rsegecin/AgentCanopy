import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude, childEnv } from './run-claude.mjs';
import { startServer } from './mcp-server.mjs';

// Where runs happen and raw outputs go. Never the repository's tracked files.
// Override with AGENTCANOPY_SPIKE_DIR; the default is a folder under the OS temp directory.
export const SCRATCH = process.env.AGENTCANOPY_SPIKE_DIR ?? path.join(os.tmpdir(), 'agentcanopy-spike');
export const OUT = path.join(SCRATCH, 'spike-out');

export const BASE_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--include-hook-events', '--permission-mode', 'default'];
export const ASK_TOOLS = 'Read,Grep,Glob,AskUserQuestion';

export function listTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out.push({ path: path.relative(dir, p) + '/' }); walk(p); }
      else out.push({ path: path.relative(dir, p), size: fs.statSync(p).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

export function makeScenario(id) {
  const dir = path.join(OUT, id);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work, { recursive: true });
  const sc = { id, dir, work };
  /**
   * opts: { prompt, handler, submitPlan, host (default = !!handler), ask, args (array|fn), settings (obj|fn),
   *         model, env, signals, onStart, timeoutMs, seed, survivorCheckDelayMs, survivorMatch }
   */
  sc.step = async (name, opts) => {
    const prefix = path.join(dir, `${name}.`);
    for (const [f, c] of Object.entries(opts.seed ?? {})) {
      const p = path.join(work, f);
      if (!fs.existsSync(p)) fs.writeFileSync(p, c);
    }
    const before = listTree(work);
    const host = opts.host ?? !!opts.handler;
    const srv = host ? await startServer({ dir, prefix: `${name}.`, handler: opts.handler, submitPlan: !!opts.submitPlan }) : null;
    // model: undefined -> haiku; null -> no --model flag (the CLI's own default)
    const args = [...BASE_FLAGS, ...(opts.model === null ? [] : ['--model', opts.model ?? 'haiku'])];
    if (host) args.push('--mcp-config', srv.configFile, '--permission-prompt-tool', 'mcp__agentcanopy__permission_prompt');
    let settings = opts.settings;
    if (opts.ask) {
      args.push('--tools', ASK_TOOLS, '--strict-mcp-config', '--disable-slash-commands', '--no-chrome');
      settings = { disableAllHooks: true };
    }
    if (settings !== undefined) {
      const obj = typeof settings === 'function' ? settings(srv) : settings;
      const f = path.join(dir, `${name}.settings.json`);
      fs.writeFileSync(f, JSON.stringify(obj));
      args.push('--settings', f);
    }
    const extra = typeof opts.args === 'function' ? opts.args(srv) : (opts.args ?? []);
    args.push(...extra);
    const envExtra = { ...(opts.ask ? { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' } : {}), ...(opts.env ?? {}) };
    fs.writeFileSync(`${prefix}prompt.txt`, opts.prompt);
    const run = await runClaude({
      args, prompt: opts.prompt, cwd: work, env: childEnv(envExtra), outPrefix: prefix,
      timeoutMs: opts.timeoutMs, signals: opts.signals, onStart: (h) => opts.onStart?.(h, srv),
      survivorCheckDelayMs: opts.survivorCheckDelayMs, survivorMatch: opts.survivorMatch,
    });
    const after = listTree(work);
    if (srv) await srv.close();
    run.meta.step = name; run.meta.scenario = id; run.meta.prompt = opts.prompt;
    run.meta.envExtra = envExtra; run.meta.host = host; run.meta.workBefore = before; run.meta.workAfter = after;
    fs.writeFileSync(`${prefix}meta.json`, JSON.stringify(run.meta, null, 2));
    console.log(`[${id}/${name}] exit=${run.exitCode} signal=${run.signal} ${Math.round(run.durationMs / 1000)}s events=${run.events.length}`);
    return run;
  };
  return sc;
}

export const resultEvent = (run) => run.events.findLast((e) => e.type === 'result');
export const initEvent = (run) => run.events.find((e) => e.type === 'system' && e.subtype === 'init');
