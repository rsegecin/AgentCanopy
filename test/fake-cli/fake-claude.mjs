// A dependency-free stand-in for the Claude Code CLI, used by the process-layer tests.
//
// `--version`            prints the version line.
// `auth status`          prints $FAKE_CLAUDE_AUTH (JSON); exit 1 when it says loggedIn: false.
// `--resume-session-at`  alone: prints the "argument missing" error and exits 1, like the real CLI.
// anything else          reads all of stdin, then plays the scenario in $FAKE_CLAUDE_SCENARIO.
//
// Scenario: { steps: [...], recordEnv?: string[], onSigint?: 'result'|'ignore'|'exit',
//             onSigterm?: 'exit'|'ignore' }
// Steps: emit, emitRaw, emitBig, sleep, stderr, exit, crash, hang, writeFile, deleteFile,
//        permission, callTool, hook. Inside any emitted object or written file content,
//        $SESSION, $CWD, $UPDATED.<key> (the updatedInput of the last allowed permission) and
//        $SAVED.<name> (text saved by callTool/hook with saveAs) are substituted.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setInterval, setTimeout } from 'node:timers';

const argv = process.argv.slice(2);

function flushThenExit(code) {
  process.stdout.write('', () => process.exit(code));
}

if (argv.length === 1 && argv[0] === '--resume-session-at') {
  // The capability probe: the real CLI rejects the flag when its value is missing.
  process.stderr.write("error: option '--resume-session-at <id>' argument missing\n");
  process.exit(1);
}
if (argv.includes('--version')) {
  process.stdout.write('2.1.322 (Claude Code)\n');
  flushThenExit(0);
} else if (argv[0] === 'auth' && argv[1] === 'status') {
  const text =
    process.env.FAKE_CLAUDE_AUTH ??
    '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}';
  process.stdout.write(`${text}\n`);
  let loggedIn;
  try {
    loggedIn = JSON.parse(text).loggedIn !== false;
  } catch {
    loggedIn = false;
  }
  flushThenExit(loggedIn ? 0 : 1);
} else {
  await main();
}

function argAfter(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function writeLine(text) {
  process.stdout.write(`${text}\n`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function main() {
  const scenarioPath = process.env.FAKE_CLAUDE_SCENARIO;
  if (!scenarioPath) {
    process.stderr.write('fake-claude: FAKE_CLAUDE_SCENARIO is not set\n');
    process.exit(64);
  }
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  const sessionId = argAfter('--session-id') ?? argAfter('--resume') ?? '';
  const cwd = process.cwd();

  const state = { updated: {}, saved: {} };

  const substitute = (value) => {
    if (typeof value === 'string') {
      return value
        .replaceAll('$SESSION', sessionId)
        .replaceAll('$CWD', cwd)
        .replace(/\$UPDATED\.(\w+)/g, (_m, key) => {
          const v = state.updated?.[key];
          return typeof v === 'string' ? v : JSON.stringify(v ?? '');
        })
        .replace(/\$SAVED\.(\w+)/g, (_m, key) => state.saved[key] ?? '');
    }
    if (Array.isArray(value)) return value.map(substitute);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
    }
    return value;
  };

  // Signal handling is installed before anything else so a cancel never races the scenario.
  process.on('SIGINT', () => {
    const mode = scenario.onSigint ?? 'result';
    if (mode === 'ignore') return;
    if (mode === 'exit') process.exit(130);
    writeLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
        session_id: sessionId,
      }),
    );
    flushThenExit(0);
  });
  process.on('SIGTERM', () => {
    if (scenario.onSigterm === 'ignore') return;
    process.exit(143);
  });

  const stdin = await readStdin();

  if (process.env.FAKE_CLAUDE_RECORD) {
    const env = {};
    for (const key of scenario.recordEnv ?? []) env[key] = process.env[key];
    writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv, stdin, env, cwd }));
  }

  const mcpServer = () => {
    const configPath = argAfter('--mcp-config');
    if (!configPath) throw new Error('no --mcp-config');
    const servers = JSON.parse(readFileSync(configPath, 'utf8')).mcpServers;
    const [name, config] = Object.entries(servers)[0];
    return { name, config };
  };

  let requestId = 2;
  const callMcp = async (toolName, args, meta) => {
    const { config } = mcpServer();
    const id = requestId++;
    const response = await globalThis.fetch(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...config.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: toolName, arguments: args, _meta: meta },
      }),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`MCP call failed with HTTP ${response.status}: ${body}`);
    let message;
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.id === id) message = parsed;
        } catch {
          // Not JSON: ignore like a client would.
        }
      }
    } else {
      message = JSON.parse(body);
    }
    if (!message) throw new Error('no JSON-RPC response with a matching id');
    if (message.error) throw new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`);
    const text = (message.result?.content ?? []).find((b) => b.type === 'text')?.text ?? '';
    return { text, isError: message.result?.isError === true };
  };

  const hookUrl = (phase) => {
    const settings = JSON.parse(readFileSync(argAfter('--settings'), 'utf8'));
    const key =
      phase === 'pre'
        ? 'PreToolUse'
        : phase === 'post-failure'
          ? 'PostToolUseFailure'
          : 'PostToolUse';
    return settings.hooks?.[key]?.[0]?.hooks?.[0]?.url;
  };

  async function runSteps(steps) {
    for (const raw of steps) {
      // Nested step lists are substituted when they run, so they can see values set before then.
      const step =
        'permission' in raw
          ? {
              permission: {
                ...substitute({ ...raw.permission, onAllow: [], onDeny: [] }),
                onAllow: raw.permission.onAllow,
                onDeny: raw.permission.onDeny,
              },
            }
          : substitute(raw);
      if ('emit' in step) {
        writeLine(JSON.stringify(step.emit));
      } else if ('emitRaw' in step) {
        process.stdout.write(step.emitRaw);
      } else if ('emitBig' in step) {
        const total = Number(step.emitBig);
        const head = '{"type":"big","pad":"';
        const tailText = '"}';
        const pad = Math.max(0, total - head.length - tailText.length);
        process.stdout.write(
          Buffer.concat([
            Buffer.from(head),
            Buffer.alloc(pad, 0x78),
            Buffer.from(tailText),
            Buffer.from('\n'),
          ]),
        );
      } else if ('sleep' in step) {
        await sleep(step.sleep);
      } else if ('stderr' in step) {
        process.stderr.write(step.stderr);
      } else if ('exit' in step) {
        flushThenExit(step.exit);
        await new Promise(() => undefined);
      } else if ('crash' in step) {
        process.exit(137);
      } else if ('hang' in step) {
        setInterval(() => undefined, 1000);
        await new Promise(() => undefined);
      } else if ('writeFile' in step) {
        const target = resolve(cwd, step.writeFile.path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, step.writeFile.content);
      } else if ('deleteFile' in step) {
        rmSync(resolve(cwd, step.deleteFile), { force: true });
      } else if ('permission' in step) {
        const p = step.permission;
        const { name } = mcpServer();
        const fullTool = argAfter('--permission-prompt-tool') ?? '';
        const toolName = fullTool.replace(`mcp__${name}__`, '');
        const reply = await callMcp(
          toolName,
          { tool_name: p.toolName, input: p.input, tool_use_id: p.toolUseId },
          { 'claudecode/toolUseId': p.toolUseId, progressToken: 2 },
        );
        const decision = JSON.parse(reply.text);
        if (decision.behavior === 'allow') {
          state.updated = decision.updatedInput ?? p.input;
          await runSteps(p.onAllow ?? []);
        } else {
          await runSteps(p.onDeny ?? []);
        }
      } else if ('callTool' in step) {
        const c = step.callTool;
        const reply = await callMcp(c.name, c.arguments ?? {}, { progressToken: 2 });
        if (c.saveAs) state.saved[c.saveAs] = reply.text;
      } else if ('hook' in step) {
        const h = step.hook;
        const url = hookUrl(h.phase);
        if (!url) throw new Error(`no ${h.phase} hook in the settings file`);
        const body = {
          session_id: sessionId,
          transcript_path: `${cwd}/.fake-transcript.jsonl`,
          cwd,
          prompt_id: 'fake-prompt',
          permission_mode: 'default',
          effort: 'medium',
          hook_event_name:
            h.phase === 'pre'
              ? 'PreToolUse'
              : h.phase === 'post-failure'
                ? 'PostToolUseFailure'
                : 'PostToolUse',
          tool_name: h.toolName,
          tool_input: h.input,
          tool_use_id: h.toolUseId,
        };
        // A scenario may set what the hook reports about the working directory and the subagent.
        if ('cwd' in h) body.cwd = h.cwd;
        if ('agentId' in h) body.agent_id = h.agentId;
        if (h.phase === 'post') body.tool_response = {};
        if (h.phase === 'post-failure')
          Object.assign(body, { error: 'failed', is_interrupt: false, duration_ms: 1 });
        const response = await globalThis.fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`hook failed with HTTP ${response.status}: ${text}`);
        if (h.saveAs) state.saved[h.saveAs] = text;
      } else {
        throw new Error(`unknown step: ${JSON.stringify(Object.keys(step))}`);
      }
    }
  }

  try {
    await runSteps(scenario.steps ?? []);
  } catch (error) {
    process.stderr.write(
      `fake-claude: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    flushThenExit(2);
    await new Promise(() => undefined);
  }
  flushThenExit(0);
}
