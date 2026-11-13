import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fakeClaude,
  resultEvent,
  textTurn,
  type FakeClaude,
  type FakeClaudeRecord,
} from '../../../../test/fake-cli';
import type { AgentEvent } from '../../../shared';
import type { HostEndpoint, PermissionRequest, TurnRequest } from '../../contracts';
import { createHostToolServer } from '../../mcp-host';
import { ensurePrivateDir, newId } from '../../util';
import { createClaudeProvider } from './provider';

let dir: string;
let fakes: FakeClaude[] = [];
const server = createHostToolServer();

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agc-provider-')));
  await server.start();
});
afterEach(async () => {
  await server.stop();
  for (const fake of fakes) await fake.dispose();
  fakes = [];
  await fs.rm(dir, { recursive: true, force: true });
});

const unusedEndpoint: HostEndpoint = {
  serverName: 'agentcanopy',
  url: 'http://127.0.0.1:9/mcp/none',
  bearerToken: 'none',
  permissionToolName: 'permission_prompt',
};

async function request(overrides: Partial<TurnRequest> = {}): Promise<TurnRequest> {
  const runDir = join(dir, `run-${newId()}`);
  await ensurePrivateDir(runDir);
  const cwd = join(dir, 'work');
  await fs.mkdir(cwd, { recursive: true });
  return {
    cwd,
    prompt: 'hello there',
    mode: 'ask',
    model: 'default',
    session: { kind: 'new', sessionId: newId() },
    profile: { kind: 'read-only', webTools: false, planTool: false },
    host: unusedEndpoint,
    systemPromptAppend: 'constant text',
    runDir,
    ...overrides,
  };
}

async function providerFor(scenario: object, record = false) {
  const fake = await fakeClaude(scenario, { record });
  fakes.push(fake);
  const provider = createClaudeProvider({
    claudePath: () => '',
    env: () => fake.env,
    launchOverride: fake.launch,
    interruptGraceMs: 300,
    terminateGraceMs: 300,
  });
  return { provider, fake };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const all: AgentEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

describe('Claude provider', () => {
  it('detects the fake CLI as installed and signed in', async () => {
    const { provider } = await providerFor({ steps: [] });
    const status = await provider.detect();
    expect(status.installed).toBe(true);
    expect(status.meetsMinimum).toBe(true);
    expect(status.auth).toBe('signed-in');
    expect(status.capabilities.readOnlyEnforcement).toBe('tool-layer');
  });

  it('runs a text turn: prompt on stdin, events in order, clean exit', async () => {
    const { provider, fake } = await providerFor(
      {
        steps: [...textTurn('pong'), ...resultEvent('pong')],
        recordEnv: ['ENABLE_CLAUDEAI_MCP_SERVERS', 'ELECTRON_RUN_AS_NODE'],
      },
      true,
    );
    const turnRequest = await request();
    const handle = provider.startTurn(turnRequest);
    const events = await collect(handle.events);
    const exit = await handle.done;

    expect(exit.exitCode).toBe(0);
    expect(exit.sawResult).toBe(true);
    const types = events.map((e) => e.type);
    expect(types).toContain('session');
    expect(types.filter((t) => t === 'result')).toHaveLength(1);
    const text = events
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e.type === 'text-delta' ? e.text : ''));
    expect(text.join('')).toBe('pong');
    const result = events.find((e) => e.type === 'result');
    expect(result?.type === 'result' && result.outcome).toBe('completed');

    const record = JSON.parse(
      await fs.readFile(fake.recordPath as string, 'utf8'),
    ) as FakeClaudeRecord;
    expect(record.stdin).toBe('hello there');
    expect(record.argv.join(' ')).not.toContain('hello there');
    expect(record.argv).toContain('--strict-mcp-config');
    expect(record.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(record.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(await fs.realpath(record.cwd)).toBe(turnRequest.cwd);
  });

  it('sends an image turn as one stream-json line on stdin', async () => {
    const { provider, fake } = await providerFor(
      { steps: [...textTurn('seen'), ...resultEvent('seen')] },
      true,
    );
    const data = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const handle = provider.startTurn(
      await request({ images: [{ mediaType: 'image/png', data }] }),
    );
    await collect(handle.events);
    const exit = await handle.done;
    expect(exit.exitCode).toBe(0);

    const record = JSON.parse(
      await fs.readFile(fake.recordPath as string, 'utf8'),
    ) as FakeClaudeRecord;
    expect(record.argv.slice(-2)).toEqual(['--input-format', 'stream-json']);
    expect(record.argv.join(' ')).not.toContain(Buffer.from(data).toString('base64'));
    expect(record.stdin.endsWith('\n')).toBe(true);
    expect(JSON.parse(record.stdin) as unknown).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from(data).toString('base64'),
            },
          },
          { type: 'text', text: 'hello there' },
        ],
      },
      parent_tool_use_id: null,
    });
  });

  it('routes a permission request through the host server and acts on the answer', async () => {
    const seen: PermissionRequest[] = [];
    const registration = server.registerTurn(
      {
        onPermissionRequest: (req) => {
          seen.push(req);
          return Promise.resolve(
            req.toolName === 'Write'
              ? { behavior: 'allow', updatedInput: { ...req.input, content: 'changed by host' } }
              : { behavior: 'deny', message: 'no' },
          );
        },
      },
      { toolHooks: false },
    );
    const { provider } = await providerFor({
      steps: [
        ...textTurn('working'),
        {
          permission: {
            toolName: 'Write',
            input: { file_path: 'a.txt', content: 'hello' },
            toolUseId: 'toolu_1',
            onAllow: [{ writeFile: { path: 'a.txt', content: '$UPDATED.content' } }],
            onDeny: [],
          },
        },
        {
          permission: {
            toolName: 'Bash',
            input: { command: 'rm -rf x' },
            toolUseId: 'toolu_2',
            onAllow: [{ writeFile: { path: 'b.txt', content: 'should not exist' } }],
            onDeny: [],
          },
        },
        ...resultEvent('done'),
      ],
    });
    const turnRequest = await request({
      mode: 'agent',
      profile: { kind: 'agent', allowRules: [], alwaysAskCommands: false, sandbox: false },
      host: registration.endpoint,
    });
    const handle = provider.startTurn(turnRequest);
    await collect(handle.events);
    await handle.done;
    registration.dispose();

    expect(seen.map((r) => [r.toolName, r.toolCallId])).toEqual([
      ['Write', 'toolu_1'],
      ['Bash', 'toolu_2'],
    ]);
    expect(await fs.readFile(join(turnRequest.cwd, 'a.txt'), 'utf8')).toBe('changed by host');
    await expect(fs.access(join(turnRequest.cwd, 'b.txt'))).rejects.toThrow();
  });

  it('cancels a running turn and reports it as interrupted', async () => {
    const { provider } = await providerFor({ steps: [...textTurn('partial'), { hang: true }] });
    const handle = provider.startTurn(await request());
    const events: AgentEvent[] = [];
    const reading = (async () => {
      for await (const event of handle.events) {
        events.push(event);
        if (event.type === 'assistant-block') void handle.cancel();
      }
    })();
    await reading;
    await handle.done;
    const result = events.find((e) => e.type === 'result');
    expect(result?.type === 'result' && result.outcome).toBe('interrupted');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('reports a crash without a result as an error', async () => {
    const { provider } = await providerFor({
      steps: [...textTurn('half'), { stderr: 'boom' }, { exit: 3 }],
    });
    const handle = provider.startTurn(await request());
    const events = await collect(handle.events);
    const exit = await handle.done;
    expect(exit.sawResult).toBe(false);
    expect(exit.exitCode).toBe(3);
    const error = events.find((e) => e.type === 'error');
    expect(error?.type === 'error' && error.category).toBe('process-crash');
    const result = events.at(-1);
    expect(result?.type === 'result' && result.outcome).toBe('error');
  });

  it('turns an invalid request into an error result without starting a process', async () => {
    const { provider } = await providerFor({ steps: [...textTurn('never')] });
    const handle = provider.startTurn(await request({ model: 'bad model; rm -rf' }));
    const events = await collect(handle.events);
    await handle.done;
    expect(handle.pid).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['error', 'result']);
  });

  it('kills the process at once when asked', async () => {
    const { provider } = await providerFor({
      steps: [...textTurn('x'), { hang: true }],
      onSigint: 'ignore',
      onSigterm: 'ignore',
    });
    const handle = provider.startTurn(await request());
    for await (const event of handle.events) {
      if (event.type === 'session') handle.kill();
    }
    const exit = await handle.done;
    expect(exit.signal).toBe('SIGKILL');
  });
});
