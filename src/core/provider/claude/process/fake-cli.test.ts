import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeClaude, initEvent, type FakeClaude } from '../../../../../test/fake-cli';
import { prepareInvocation } from './invocation';
import { runClaude } from './runner';

const run = promisify(execFile);
const SESSION = '11111111-1111-4111-8111-111111111111';

interface Seen {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

let server: Server;
let seen: Seen[];
let respond: (seen: Seen) => { contentType: string; body: string };
let cwd: string;
let runDir: string;
let fake: FakeClaude | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'fakecli-cwd-'));
  runDir = await mkdtemp(join(tmpdir(), 'fakecli-run-'));
  seen = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const entry: Seen = {
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      };
      seen.push(entry);
      const reply = respond(entry);
      res.writeHead(200, { 'content-type': reply.contentType });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fake?.dispose();
  fake = undefined;
  await rm(cwd, { recursive: true, force: true });
  await rm(runDir, { recursive: true, force: true });
});

function baseUrl(): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function rpc(id: unknown, text: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
}

async function play(
  scenario: object,
  withHooks = false,
): Promise<{ lines: string[]; exit: number | null }> {
  fake = await fakeClaude(scenario);
  const prepared = await prepareInvocation({
    cwd,
    prompt: 'p',
    mode: 'agent',
    model: 'default',
    session: { kind: 'new', sessionId: SESSION },
    profile: { kind: 'agent', allowRules: [], alwaysAskCommands: false, sandbox: false },
    host: {
      serverName: 'agentcanopy',
      url: `${baseUrl()}/mcp`,
      bearerToken: 'secret-token',
      permissionToolName: 'permission_prompt',
      ...(withHooks ? { hookUrl: `${baseUrl()}/hooks` } : {}),
    },
    systemPromptAppend: '',
    runDir,
  });
  const proc = runClaude({
    launch: fake.launch,
    args: prepared.args,
    cwd,
    env: fake.env,
    stdin: prepared.stdin,
  });
  const lines: string[] = [];
  for await (const line of proc.lines) lines.push(line);
  const done = await proc.done;
  return { lines, exit: done.exitCode };
}

const permissionStep = (extra: object = {}) => ({
  permission: {
    toolName: 'Write',
    input: { file_path: 'a.txt', content: 'original' },
    toolUseId: 'toolu_1',
    onAllow: [
      { writeFile: { path: 'a.txt', content: '$UPDATED.content' } },
      { emit: { type: 'allowed', session: '$SESSION' } },
    ],
    onDeny: [{ emit: { type: 'denied' } }],
    ...extra,
  },
});

describe('fake CLI', () => {
  it('prints its version and auth status', async () => {
    const f = await fakeClaude({ steps: [] }, { auth: { loggedIn: false } });
    fake = f;
    const args = [...f.launch.prefixArgs];
    const version = await run(f.launch.command, [...args, '--version']);
    expect(version.stdout.trim()).toBe('2.1.322 (Claude Code)');
    await expect(
      run(f.launch.command, [...args, 'auth', 'status'], { env: f.env }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"loggedIn":false') as string,
    });
    const ok = await run(f.launch.command, [...args, 'auth', 'status'], {
      env: { ...process.env, FAKE_CLAUDE_AUTH: undefined },
    });
    expect(JSON.parse(ok.stdout)).toMatchObject({ loggedIn: true });
  });

  it('performs a permission call (JSON reply) and runs onAllow with updatedInput', async () => {
    respond = (s) => ({
      contentType: 'application/json',
      body: rpc(
        s.body.id,
        JSON.stringify({
          behavior: 'allow',
          updatedInput: { file_path: 'a.txt', content: 'edited' },
        }),
      ),
    });
    const { lines, exit } = await play({ steps: [initEvent(), permissionStep()] });
    expect(exit).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('/mcp');
    expect(seen[0]?.headers.authorization).toBe('Bearer secret-token');
    expect(seen[0]?.headers.accept).toBe('application/json, text/event-stream');
    expect(seen[0]?.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'permission_prompt',
        arguments: {
          tool_name: 'Write',
          input: { file_path: 'a.txt', content: 'original' },
          tool_use_id: 'toolu_1',
        },
        _meta: { 'claudecode/toolUseId': 'toolu_1', progressToken: 2 },
      },
    });
    expect(await readFile(join(cwd, 'a.txt'), 'utf8')).toBe('edited');
    expect(JSON.parse(lines.at(-1) ?? '')).toEqual({ type: 'allowed', session: SESSION });
  });

  it('handles an SSE reply and picks the response with the matching id', async () => {
    respond = (s) => ({
      contentType: 'text/event-stream',
      body:
        `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n` +
        `data: ${rpc(999, JSON.stringify({ behavior: 'deny', message: 'wrong' }))}\n\n` +
        `data: ${rpc(s.body.id, JSON.stringify({ behavior: 'deny', message: 'no' }))}\n\n`,
    });
    const { lines, exit } = await play({ steps: [permissionStep()] });
    expect(exit).toBe(0);
    expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ type: 'denied' }]);
  });

  it('calls a tool and saves the result; deleteFile removes a file', async () => {
    await writeFile(join(cwd, 'gone.txt'), 'x');
    respond = (s) => ({ contentType: 'application/json', body: rpc(s.body.id, 'plan accepted') });
    const { lines, exit } = await play({
      steps: [
        { callTool: { name: 'submit_plan', arguments: { plan: 'do it' }, saveAs: 'r' } },
        { emit: { type: 'saved', text: '$SAVED.r' } },
        { deleteFile: 'gone.txt' },
      ],
    });
    expect(exit).toBe(0);
    expect(seen[0]?.body).toMatchObject({
      params: { name: 'submit_plan', arguments: { plan: 'do it' } },
    });
    expect(JSON.parse(lines[0] ?? '')).toEqual({ type: 'saved', text: 'plan accepted' });
    await expect(readFile(join(cwd, 'gone.txt'))).rejects.toThrow();
  });

  it('posts hooks to the URLs from the settings file', async () => {
    respond = () => ({ contentType: 'application/json', body: '{}' });
    const { exit } = await play(
      {
        steps: [
          { hook: { phase: 'pre', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 't1' } },
          { hook: { phase: 'post', toolName: 'Bash', input: { command: 'ls' }, toolUseId: 't1' } },
        ],
      },
      true,
    );
    expect(exit).toBe(0);
    expect(seen.map((s) => s.url)).toEqual(['/hooks/pre', '/hooks/post']);
    expect(seen[0]?.body).toMatchObject({
      session_id: SESSION,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_use_id: 't1',
    });
    expect(seen[1]?.body).toMatchObject({ hook_event_name: 'PostToolUse' });
    for (const key of ['transcript_path', 'cwd', 'prompt_id', 'permission_mode', 'effort']) {
      expect(seen[0]?.body).toHaveProperty(key);
    }
  });

  it('exits 2 with a message on stderr when a step fails', async () => {
    respond = () => ({ contentType: 'application/json', body: '{}' });
    const { exit } = await play({
      steps: [{ hook: { phase: 'pre', toolName: 'x', input: {}, toolUseId: 't' } }],
    });
    expect(exit).toBe(2);
  });
});
