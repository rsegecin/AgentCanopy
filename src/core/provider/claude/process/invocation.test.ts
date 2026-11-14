import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionProfile, TurnRequest } from '../../../contracts/provider';
import { prepareInvocation } from './invocation';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const PROMPT = 'PROMPT-SENTINEL do the thing --dangerous';

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), 'invocation-'));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

const readOnly: ExecutionProfile = { kind: 'read-only', webTools: false, planTool: false };

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    cwd: process.platform === 'win32' ? 'C:\\work' : '/work',
    prompt: PROMPT,
    mode: 'ask',
    model: 'sonnet',
    session: { kind: 'new', sessionId: U1 },
    profile: readOnly,
    host: {
      serverName: 'agentcanopy',
      url: 'http://127.0.0.1:4000/mcp/abc',
      bearerToken: 'tok-123',
      permissionToolName: 'permission_prompt',
    },
    systemPromptAppend: 'Be brief.',
    runDir,
    ...overrides,
  };
}

function baseArgs(): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--include-hook-events',
    '--permission-mode',
    'default',
    '--permission-prompt-tool',
    'mcp__agentcanopy__permission_prompt',
    '--mcp-config',
    join(runDir, 'mcp.json'),
    '--settings',
    join(runDir, 'settings.json'),
    '--append-system-prompt-file',
    join(runDir, 'system-prompt.txt'),
  ];
}

const readOnlyFlags = ['--strict-mcp-config', '--disable-slash-commands', '--no-chrome'];
const userSettingsOnly = ['--setting-sources', 'user'];
const RO_ASK = ['Read', 'Grep', 'Glob'];
const RO_WEB_ASK = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'];
const AGENT_ASK = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'PowerShell',
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
];

async function json(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(runDir, name), 'utf8')) as unknown;
}

describe('prepareInvocation args', () => {
  it('new read-only turn', async () => {
    const prepared = await prepareInvocation(request());
    expect(prepared.args).toEqual([
      ...baseArgs(),
      '--model',
      'sonnet',
      '--session-id',
      U1,
      '--tools',
      'Read,Grep,Glob,AskUserQuestion',
      ...readOnlyFlags,
      ...userSettingsOnly,
    ]);
    expect(prepared.readOnly).toBe(true);
    expect(prepared.stdin).toBe(PROMPT);
    expect(prepared.files).toEqual([
      join(runDir, 'mcp.json'),
      join(runDir, 'settings.json'),
      join(runDir, 'system-prompt.txt'),
    ]);
  });

  it('read-only with web tools', async () => {
    const prepared = await prepareInvocation(
      request({ profile: { kind: 'read-only', webTools: true, planTool: false } }),
    );
    expect(prepared.args).toContain('Read,Grep,Glob,AskUserQuestion,WebSearch,WebFetch');
  });

  it('plan turn allows the plan tool', async () => {
    const base = request();
    const prepared = await prepareInvocation(
      request({
        mode: 'plan',
        profile: { kind: 'read-only', webTools: true, planTool: true },
        host: { ...base.host, planToolName: 'submit_plan' },
      }),
    );
    expect(prepared.args).toEqual([
      ...baseArgs(),
      '--model',
      'sonnet',
      '--session-id',
      U1,
      '--tools',
      'Read,Grep,Glob,AskUserQuestion,WebSearch,WebFetch',
      ...readOnlyFlags,
      '--allowedTools',
      'mcp__agentcanopy__submit_plan',
      ...userSettingsOnly,
    ]);
  });

  it('plan tool is omitted when the host exposes none', async () => {
    const prepared = await prepareInvocation(
      request({ profile: { kind: 'read-only', webTools: false, planTool: true } }),
    );
    expect(prepared.args).not.toContain('--allowedTools');
  });

  it('agent turn with rules, hooks and sandbox', async () => {
    const base = request();
    const prepared = await prepareInvocation(
      request({
        mode: 'agent',
        model: 'default',
        profile: {
          kind: 'agent',
          allowRules: ['Bash(npm test)', 'Read(src/**)'],
          alwaysAskCommands: false,
          sandbox: true,
          sandboxLocked: false,
        },
        host: { ...base.host, hookUrl: 'http://127.0.0.1:4000/hooks/xyz' },
      }),
    );
    expect(prepared.args).toEqual([
      ...baseArgs(),
      '--session-id',
      U1,
      '--strict-mcp-config',
      ...userSettingsOnly,
    ]);
    expect(prepared.readOnly).toBe(false);
    const hook = (path: string) => [
      {
        matcher: '*',
        hooks: [{ type: 'http', url: `http://127.0.0.1:4000/hooks/xyz${path}`, timeout: 60 }],
      },
    ];
    expect(await json('settings.json')).toEqual({
      permissions: {
        ask: AGENT_ASK,
        allow: ['Bash(npm test)', 'Read(src/**)'],
      },
      hooks: {
        PreToolUse: hook('/pre'),
        PostToolUse: hook('/post'),
        PostToolUseFailure: hook('/post-failure'),
      },
      sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
    });
  });

  it('agent turn: always ask drops the allow rules; empty rules omit the key', async () => {
    const asking = request({
      profile: {
        kind: 'agent',
        allowRules: ['Bash(ls)'],
        alwaysAskCommands: true,
        sandbox: false,
        sandboxLocked: false,
      },
    });
    await prepareInvocation(asking);
    expect(await json('settings.json')).toEqual({
      permissions: { ask: AGENT_ASK },
    });
    await rm(runDir, { recursive: true });
    runDir = await mkdtemp(join(tmpdir(), 'invocation-'));
    await prepareInvocation(
      request({
        profile: {
          kind: 'agent',
          allowRules: [],
          alwaysAskCommands: false,
          sandbox: false,
          sandboxLocked: false,
        },
      }),
    );
    const settings = (await json('settings.json')) as { permissions: Record<string, unknown> };
    expect(settings.permissions).toEqual({ ask: AGENT_ASK });
  });

  it('resume', async () => {
    const prepared = await prepareInvocation(
      request({ session: { kind: 'resume', sessionId: U2 } }),
    );
    expect(prepared.args).toEqual([
      ...baseArgs(),
      '--model',
      'sonnet',
      '--resume',
      U2,
      '--tools',
      'Read,Grep,Glob,AskUserQuestion',
      ...readOnlyFlags,
      ...userSettingsOnly,
    ]);
  });

  it('fork without and with the cut', async () => {
    const plain = await prepareInvocation(
      request({ session: { kind: 'fork', fromSessionId: U1, newSessionId: U2 } }),
    );
    expect(plain.args.slice(baseArgs().length + 2, baseArgs().length + 7)).toEqual([
      '--resume',
      U1,
      '--fork-session',
      '--session-id',
      U2,
    ]);
    expect(plain.args).not.toContain('--resume-session-at');
    await rm(runDir, { recursive: true });
    runDir = await mkdtemp(join(tmpdir(), 'invocation-'));
    const cut = await prepareInvocation(
      request({
        session: { kind: 'fork', fromSessionId: U1, newSessionId: U2, atProviderEventId: U3 },
      }),
    );
    expect(cut.args).toEqual([
      ...baseArgs(),
      '--model',
      'sonnet',
      '--resume',
      U1,
      '--fork-session',
      '--session-id',
      U2,
      '--resume-session-at',
      U3,
      '--tools',
      'Read,Grep,Glob,AskUserQuestion',
      ...readOnlyFlags,
      ...userSettingsOnly,
    ]);
  });

  it('keeps the prompt and other request values out of args', async () => {
    const prepared = await prepareInvocation(
      request({
        profile: {
          kind: 'agent',
          allowRules: ['Bash(secret-rule)'],
          alwaysAskCommands: false,
          sandbox: false,
          sandboxLocked: false,
        },
      }),
    );
    const joined = prepared.args.join('\n');
    expect(joined).not.toContain('PROMPT-SENTINEL');
    expect(joined).not.toContain('tok-123');
    expect(joined).not.toContain('127.0.0.1');
    expect(joined).not.toContain('secret-rule');
    expect(joined).not.toContain('Be brief.');
    expect(prepared.stdin).toBe(PROMPT);
  });
});

describe('prepareInvocation files', () => {
  it('writes the three files, private, with the expected content', async () => {
    await prepareInvocation(request());
    expect((await readdir(runDir)).sort()).toEqual([
      'mcp.json',
      'settings.json',
      'system-prompt.txt',
    ]);
    if (process.platform !== 'win32') {
      for (const name of ['mcp.json', 'settings.json', 'system-prompt.txt']) {
        expect((await stat(join(runDir, name))).mode & 0o777).toBe(0o600);
      }
    }
    expect(await json('mcp.json')).toEqual({
      mcpServers: {
        agentcanopy: {
          type: 'http',
          url: 'http://127.0.0.1:4000/mcp/abc',
          headers: { Authorization: 'Bearer tok-123' },
          timeout: 43200000,
        },
      },
    });
    expect(await json('settings.json')).toEqual({
      disableAllHooks: true,
      permissions: { ask: RO_ASK },
    });
    expect(await readFile(join(runDir, 'system-prompt.txt'), 'utf8')).toBe('Be brief.');
  });

  it('refuses a second call into the same directory', async () => {
    await prepareInvocation(request());
    await expect(prepareInvocation(request())).rejects.toThrow();
  });
});

describe('prepareInvocation validation', () => {
  async function rejects(req: TurnRequest, message: RegExp): Promise<void> {
    await expect(prepareInvocation(req)).rejects.toThrow(message);
    expect(await readdir(runDir)).toEqual([]);
  }

  it('rejects session ids that are not UUIDs', async () => {
    await rejects(request({ session: { kind: 'new', sessionId: '--evil' } }), /session id/);
    await rejects(request({ session: { kind: 'resume', sessionId: 'abc' } }), /session id/);
    await rejects(
      request({ session: { kind: 'fork', fromSessionId: 'x', newSessionId: U2 } }),
      /source session id/,
    );
    await rejects(
      request({ session: { kind: 'fork', fromSessionId: U1, newSessionId: 'x' } }),
      /fork session id/,
    );
    await rejects(
      request({
        session: { kind: 'fork', fromSessionId: U1, newSessionId: U2, atProviderEventId: 'nope' },
      }),
      /cut event id/,
    );
  });

  it('rejects bad model names', async () => {
    for (const model of ['', 'a b', 'x;rm', '-x\n', 'a'.repeat(101), '$(x)', "it's"]) {
      await rejects(request({ model }), /model/);
    }
  });

  it('accepts model names with the allowed punctuation', async () => {
    await prepareInvocation(request({ model: 'claude-opus-4.1:beta[1m]/x@y_z' }));
  });

  it('rejects bad server and tool names', async () => {
    const base = request().host;
    await rejects(request({ host: { ...base, serverName: 'bad name' } }), /server name/);
    await rejects(request({ host: { ...base, serverName: '' } }), /server name/);
    await rejects(request({ host: { ...base, serverName: 'a'.repeat(65) } }), /server name/);
    await rejects(
      request({ host: { ...base, permissionToolName: 'x__y!' } }),
      /permission tool name/,
    );
    await rejects(request({ host: { ...base, planToolName: 'plan tool' } }), /plan tool name/);
  });

  it('rejects bad allow rules', async () => {
    const withRules = (allowRules: string[]) =>
      request({
        profile: {
          kind: 'agent',
          allowRules,
          alwaysAskCommands: false,
          sandbox: false,
          sandboxLocked: false,
        },
      });
    await rejects(withRules(['']), /allow rule/);
    await rejects(withRules(['   ']), /allow rule/);
    await rejects(withRules(['a\nb']), /allow rule/);
    await rejects(withRules(['a\rb']), /allow rule/);
    await rejects(withRules(['x'.repeat(501)]), /allow rule/);
    await rejects(withRules([42 as unknown as string]), /allow rule/);
  });

  it('accepts a rule of exactly 500 characters', async () => {
    await prepareInvocation(
      request({
        profile: {
          kind: 'agent',
          allowRules: ['x'.repeat(500)],
          alwaysAskCommands: false,
          sandbox: false,
          sandboxLocked: false,
        },
      }),
    );
  });

  it('rejects relative runDir and cwd', async () => {
    await rejects(request({ cwd: 'relative/dir' }), /cwd/);
    await expect(prepareInvocation(request({ runDir: 'relative' }))).rejects.toThrow(/runDir/);
  });
});

describe('prepareInvocation images', () => {
  const MIB = 1024 * 1024;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

  async function stdinFor(req: TurnRequest): Promise<string> {
    return (await prepareInvocation(req)).stdin;
  }

  it('adds only the stream-json input format at the end of the arguments', async () => {
    const textDir = runDir;
    const text = await prepareInvocation(request());
    runDir = await mkdtemp(join(tmpdir(), 'invocation-'));
    const withImage = await prepareInvocation(
      request({ images: [{ mediaType: 'image/png', data: png }] }),
    );
    // The two turns differ in their run directory only; compare with that normalised.
    const sameDir = text.args.map((arg) => arg.replace(textDir, runDir));
    expect(withImage.args).toEqual([...sameDir, '--input-format', 'stream-json']);
    await rm(textDir, { recursive: true, force: true });
  });

  it('sends one stream-json user line with the images before the prompt', async () => {
    const stdin = await stdinFor(request({ images: [{ mediaType: 'image/png', data: png }] }));
    expect(stdin.endsWith('\n')).toBe(true);
    expect(stdin.endsWith('\n\n')).toBe(false);
    expect(stdin.indexOf('\n')).toBe(stdin.length - 1);
    expect(JSON.parse(stdin) as unknown).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: Buffer.from(png).toString('base64'),
            },
          },
          { type: 'text', text: PROMPT },
        ],
      },
      parent_tool_use_id: null,
    });
  });

  it('keeps several images in order', async () => {
    const stdin = await stdinFor(
      request({
        images: [
          { mediaType: 'image/png', data: png },
          { mediaType: 'image/jpeg', data: jpeg },
        ],
      }),
    );
    const parsed = JSON.parse(stdin) as {
      message: { content: { type: string; source?: { media_type: string; data: string } }[] };
    };
    expect(parsed.message.content.map((block) => block.type)).toEqual(['image', 'image', 'text']);
    expect(parsed.message.content[0]?.source).toEqual({
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(png).toString('base64'),
    });
    expect(parsed.message.content[1]?.source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: Buffer.from(jpeg).toString('base64'),
    });
  });

  it('keeps a text-only turn exactly as it was', async () => {
    const prepared = await prepareInvocation(request());
    expect(prepared.args).not.toContain('--input-format');
    expect(prepared.stdin).toBe(PROMPT);
  });

  describe('validation', () => {
    async function rejectsImages(req: TurnRequest): Promise<void> {
      let message = '';
      try {
        await prepareInvocation(req);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toBe('');
      // Neither the bytes nor their base64 text may leak into the message.
      expect(message).not.toContain('QUFB');
      expect(message).not.toContain('AAAA');
      expect(message.length).toBeLessThan(100);
      expect(await readdir(runDir)).toEqual([]);
    }

    it('rejects an empty list', async () => {
      await rejectsImages(request({ images: [] }));
    });

    it('rejects a media type that is not allowed', async () => {
      await rejectsImages(
        request({
          images: [{ mediaType: 'image/svg+xml' as unknown as 'image/png', data: png }],
        }),
      );
    });

    it('rejects empty data', async () => {
      await rejectsImages(
        request({ images: [{ mediaType: 'image/png', data: new Uint8Array(0) }] }),
      );
    });

    it('rejects data that is not bytes', async () => {
      await rejectsImages(
        request({
          images: [{ mediaType: 'image/png', data: 'QUFB' as unknown as Uint8Array }],
        }),
      );
    });

    it('rejects an image over the size limit', async () => {
      await rejectsImages(
        request({
          images: [{ mediaType: 'image/png', data: new Uint8Array(5 * MIB + 1).fill(0x41) }],
        }),
      );
    });

    it('accepts an image of exactly the size limit', async () => {
      const prepared = await prepareInvocation(
        request({ images: [{ mediaType: 'image/png', data: new Uint8Array(5 * MIB) }] }),
      );
      expect(prepared.args.slice(-2)).toEqual(['--input-format', 'stream-json']);
    });

    it('rejects more than five images', async () => {
      await rejectsImages(
        request({
          images: Array.from({ length: 6 }, () => ({
            mediaType: 'image/png' as const,
            data: new Uint8Array([0x41]),
          })),
        }),
      );
    });

    it('accepts five images', async () => {
      await prepareInvocation(
        request({
          images: Array.from({ length: 5 }, () => ({
            mediaType: 'image/png' as const,
            data: new Uint8Array([0x41]),
          })),
        }),
      );
    });

    it('rejects images that are too large together', async () => {
      await rejectsImages(
        request({
          images: [
            { mediaType: 'image/png', data: new Uint8Array(3 * MIB).fill(0x41) },
            { mediaType: 'image/jpeg', data: new Uint8Array(3 * MIB).fill(0x41) },
          ],
        }),
      );
    });
  });
});

describe('prepareInvocation project configuration', () => {
  const choices = [
    { name: 'absent', value: undefined, settingsIgnored: true, mcpIgnored: true },
    {
      name: 'use/use',
      value: { settings: 'use', mcp: 'use' },
      settingsIgnored: false,
      mcpIgnored: false,
    },
    {
      name: 'ignore/use',
      value: { settings: 'ignore', mcp: 'use' },
      settingsIgnored: true,
      mcpIgnored: false,
    },
    {
      name: 'use/ignore',
      value: { settings: 'use', mcp: 'ignore' },
      settingsIgnored: false,
      mcpIgnored: true,
    },
  ] as const;

  for (const choice of choices) {
    const projectConfig = choice.value === undefined ? {} : { projectConfig: { ...choice.value } };

    it(`read-only turn, ${choice.name}`, async () => {
      const prepared = await prepareInvocation(
        request({
          profile: { kind: 'read-only', webTools: false, planTool: false, ...projectConfig },
        }),
      );
      // Read-only turns always ignore project MCP servers.
      expect(prepared.args).toEqual([
        ...baseArgs(),
        '--model',
        'sonnet',
        '--session-id',
        U1,
        '--tools',
        'Read,Grep,Glob,AskUserQuestion',
        ...readOnlyFlags,
        ...(choice.settingsIgnored ? userSettingsOnly : []),
      ]);
      expect(await json('settings.json')).toEqual({
        disableAllHooks: true,
        permissions: { ask: RO_ASK },
      });
    });

    it(`read-only turn with web tools, ${choice.name}`, async () => {
      const prepared = await prepareInvocation(
        request({
          profile: { kind: 'read-only', webTools: true, planTool: false, ...projectConfig },
        }),
      );
      expect(prepared.args.filter((a) => a === '--strict-mcp-config')).toHaveLength(1);
      expect(prepared.args.includes('--setting-sources')).toBe(choice.settingsIgnored);
      expect(await json('settings.json')).toEqual({
        disableAllHooks: true,
        permissions: { ask: RO_WEB_ASK },
      });
    });

    it(`agent turn, ${choice.name}`, async () => {
      const prepared = await prepareInvocation(
        request({
          profile: {
            kind: 'agent',
            allowRules: ['Bash(npm test)'],
            alwaysAskCommands: false,
            sandbox: false,
            sandboxLocked: false,
            ...projectConfig,
          },
        }),
      );
      expect(prepared.args).toEqual([
        ...baseArgs(),
        '--model',
        'sonnet',
        '--session-id',
        U1,
        ...(choice.mcpIgnored ? ['--strict-mcp-config'] : []),
        ...(choice.settingsIgnored ? userSettingsOnly : []),
      ]);
      expect(await json('settings.json')).toEqual({
        permissions: { ask: AGENT_ASK, allow: ['Bash(npm test)'] },
      });
    });
  }
});
