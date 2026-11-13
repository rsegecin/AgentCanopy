import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, Settings } from '../../../shared';
import type { PolicyContext, PolicyFinding, TurnPolicy } from '../../contracts';
import { createClaudeEventMapper } from '../../provider/claude/events';
import { createReadOnlyPolicy } from './index';
import { makeContext, sessionEvent } from './test-support';

const FIXTURES = join(__dirname, '../../../../test/fixtures/cli');

function mapFixture(name: string): AgentEvent[] {
  const mapper = createClaudeEventMapper({ resuming: false });
  return readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => mapper.push(line));
}

function contextFor(settings: Partial<Settings> = {}, conversationId = 'c1', folder = '/work') {
  return makeContext({ folderPath: folder, settings, conversationId }).context;
}

/** Feeds events in order and returns the findings that are not undefined. */
function feed(policy: TurnPolicy, events: AgentEvent[], context: PolicyContext): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const event of events) {
    const finding = policy.inspect?.(event, context);
    if (finding !== undefined) findings.push(finding);
  }
  return findings;
}

const toolCall = (name: string, parentToolCallId: string | null = null): AgentEvent => ({
  type: 'tool-call',
  toolCallId: 't1',
  name,
  input: {},
  providerEventId: 'e1',
  parentToolCallId,
});
const text: AgentEvent = { type: 'text-delta', kind: 'text', text: 'hi', parentToolCallId: null };
const hook = (name = 'PreToolUse:Write'): AgentEvent => ({ type: 'hook', phase: 'started', name });

describe('guard against the real recordings', () => {
  it('T2 (the Ask invocation) produces no finding', () => {
    const events = mapFixture('T2');
    expect(events.some((e) => e.type === 'session')).toBe(true);
    expect(feed(createReadOnlyPolicy(), events, contextFor())).toEqual([]);
  });

  it('T1 (25 default tools, no MCP server) is stopped, naming tools', () => {
    const events = mapFixture('T1');
    const findings = feed(createReadOnlyPolicy(), events, contextFor());
    expect(findings).toHaveLength(1);
    const stop = findings[0]?.stop ?? '';
    expect(stop).toMatch(
      /^Claude Code offered tools that are not allowed in a read-only mode \(.+\), so the turn was stopped\.$/,
    );
    expect(stop).toMatch(/and \d+ more\)/);
  });
});

describe('guard: the session event', () => {
  const run = (event: AgentEvent, settings: Partial<Settings> = {}) =>
    createReadOnlyPolicy().inspect?.(event, contextFor(settings));

  it('a clean session passes', () => {
    expect(run(sessionEvent())).toBeUndefined();
  });

  it('an extra tool stops, naming it', () => {
    expect(run(sessionEvent({ tools: ['Read', 'Glob', 'Bash'] }))?.stop).toBe(
      'Claude Code offered tools that are not allowed in a read-only mode (Bash), so the turn was stopped.',
    );
  });

  it('names are limited to five, cut to 60 characters and escaped', () => {
    const tools = ['Read', 'a‮b', 'x'.repeat(100), 'T3', 'T4', 'T5', 'T6', 'T7'];
    const stop = run(sessionEvent({ tools }))?.stop ?? '';
    expect(stop).toContain('a\\u{202E}b');
    expect(stop).toContain(`${'x'.repeat(60)},`);
    expect(stop).not.toContain('x'.repeat(61));
    expect(stop).toContain('and 2 more');
    expect(stop).not.toContain('T6');
  });

  it('a missing Read stops', () => {
    expect(run(sessionEvent({ tools: ['Grep', 'Glob'] }))?.stop).toMatch(
      /^Claude Code offered tools that are not allowed in a read-only mode \(.*Read.*\)/,
    );
  });

  it('EndConversation is allowed', () => {
    expect(run(sessionEvent({ tools: ['Read', 'EndConversation'] }))).toBeUndefined();
  });

  it('web tools are allowed only with the setting', () => {
    const tools = ['Read', 'WebSearch', 'WebFetch'];
    expect(run(sessionEvent({ tools }))?.stop).toContain('(WebSearch, WebFetch)');
    expect(run(sessionEvent({ tools }), { askWebTools: true })).toBeUndefined();
  });

  const serverStop =
    'Claude Code loaded tool servers that are not allowed in a read-only mode, so the turn was stopped.';
  it.each([
    [
      'an extra server',
      [
        { name: 'agentcanopy', status: 'connected' },
        { name: 'x', status: 'connected' },
      ],
    ],
    ['no server', []],
    ['a server that is not connected', [{ name: 'agentcanopy', status: 'failed' }]],
    ['a server with another name', [{ name: 'other', status: 'connected' }]],
  ])('%s stops', (_name, mcpServers) => {
    expect(run(sessionEvent({ mcpServers }))?.stop).toBe(serverStop);
  });

  it('another permission mode stops', () => {
    expect(run(sessionEvent({ permissionMode: 'bypassPermissions' }))?.stop).toBe(
      'Claude Code did not start in its default permission mode, so the turn was stopped.',
    );
  });

  it('another folder stops', () => {
    expect(run(sessionEvent({ cwd: '/elsewhere' }))?.stop).toBe(
      'Claude Code started in a different folder, so the turn was stopped.',
    );
  });

  it('plugins that are all built in pass', () => {
    const plugins = [
      { name: 'a', builtin: true },
      { name: 'b', builtin: true },
    ];
    expect(run(sessionEvent({ plugins }))).toBeUndefined();
    expect(run(sessionEvent({ plugins }), { strictReadOnly: true })).toBeUndefined();
  });

  const plugins = [
    { name: 'a', builtin: true },
    { name: 'my-plugin', builtin: false },
    { name: 'other‮', builtin: false },
  ];
  it('a plugin that is not built in gives a notice, not a stop, with strict off', () => {
    expect(run(sessionEvent({ plugins }))).toEqual({
      notice:
        "A Claude Code plugin is loaded (my-plugin, other\\u{202E}). Plugins run outside AgentCanopy's read-only guarantee.",
    });
  });

  it('a plugin that is not built in stops with strict on', () => {
    expect(run(sessionEvent({ plugins }), { strictReadOnly: true })).toEqual({
      stop: "A Claude Code plugin is loaded (my-plugin, other\\u{202E}). Plugins run outside AgentCanopy's read-only guarantee, and the strict setting is on.",
    });
  });
});

describe('guard: during the turn', () => {
  it('content before the session event stops', () => {
    const message =
      'Claude Code started answering before reporting its configuration, so read-only mode could not be verified.';
    const blocks: AgentEvent[] = [
      text,
      {
        type: 'assistant-block',
        kind: 'text',
        text: 'x',
        providerEventId: 'e',
        parentToolCallId: null,
      },
      toolCall('Read'),
    ];
    for (const event of blocks) {
      expect(createReadOnlyPolicy().inspect?.(event, contextFor())).toEqual({ stop: message });
    }
  });

  it('status and other events before the session event are fine', () => {
    const status: AgentEvent = { type: 'status', state: 'running' };
    expect(createReadOnlyPolicy().inspect?.(status, contextFor())).toBeUndefined();
  });

  it('allowed tool calls pass, including EndConversation', () => {
    const policy = createReadOnlyPolicy();
    const context = contextFor();
    policy.inspect?.(sessionEvent(), context);
    for (const name of ['Read', 'Grep', 'Glob', 'AskUserQuestion', 'EndConversation']) {
      expect(policy.inspect?.(toolCall(name), context)).toBeUndefined();
    }
    expect(policy.inspect?.(text, context)).toBeUndefined();
  });

  it('a tool call outside the set stops, also one from a subagent', () => {
    const policy = createReadOnlyPolicy();
    const context = contextFor();
    policy.inspect?.(sessionEvent(), context);
    const expected = (name: string) => ({
      stop: `Claude Code tried to use a tool that is not allowed in a read-only mode (${name}), so the turn was stopped.`,
    });
    expect(policy.inspect?.(toolCall('Bash'), context)).toEqual(expected('Bash'));
    expect(policy.inspect?.(toolCall('Write', 'parent-1'), context)).toEqual(expected('Write'));
    expect(policy.inspect?.(toolCall('mcp__x__y'), context)).toEqual(expected('mcp__x__y'));
    expect(policy.inspect?.(toolCall('a‮'.padEnd(80, 'z')), context)?.stop).toContain(
      `a\\u{202E}${'z'.repeat(58)}), so`,
    );
  });

  it('web tool calls are allowed only with the setting', () => {
    for (const [settings, blocked] of [
      [{}, true],
      [{ askWebTools: true }, false],
    ] as const) {
      const policy = createReadOnlyPolicy();
      const context = contextFor(settings);
      policy.inspect?.(
        sessionEvent({ tools: ['Read', ...(blocked ? [] : ['WebFetch'])] }),
        context,
      );
      expect(policy.inspect?.(toolCall('WebFetch'), context)?.stop !== undefined).toBe(blocked);
      expect(policy.inspect?.(toolCall('WebSearch'), context)?.stop !== undefined).toBe(blocked);
    }
  });

  it('a hook gives one notice per turn with strict off, a stop each time with strict on', () => {
    const policy = createReadOnlyPolicy();
    const context = contextFor();
    policy.inspect?.(sessionEvent(), context);
    const findings = feed(
      policy,
      [hook('PreToolUse:Read'), hook('PostToolUse:Read'), hook()],
      context,
    );
    expect(findings).toEqual([
      {
        notice:
          "A hook ran during this turn (PreToolUse:Read). Hooks that an administrator configured cannot be turned off and are outside AgentCanopy's read-only guarantee.",
      },
    ]);

    const strict = createReadOnlyPolicy();
    const strictContext = contextFor({ strictReadOnly: true });
    strict.inspect?.(sessionEvent(), strictContext);
    const stops = feed(strict, [hook(), hook()], strictContext);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual({
      stop: "A hook ran during a read-only turn. Hooks are outside AgentCanopy's read-only guarantee, and the strict setting is on.",
    });
  });

  it('a hook response is ignored', () => {
    const policy = createReadOnlyPolicy();
    const context = contextFor();
    policy.inspect?.(sessionEvent(), context);
    expect(
      policy.inspect?.({ type: 'hook', phase: 'response', name: 'x', outcome: 'success' }, context),
    ).toBeUndefined();
  });
});

describe('guard: the plan tool', () => {
  const PLAN = 'mcp__agentcanopy__submit_plan';
  const tools = ['AskUserQuestion', 'Glob', 'Grep', 'Read', PLAN];
  const ctx = (mode: 'ask' | 'plan', planLocked: boolean) =>
    makeContext({ folderPath: '/work', mode, planLocked }).context;
  const expectedSessionStop =
    'Claude Code offered tools that are not allowed in a read-only mode (mcp__agentcanopy__submit_plan), so the turn was stopped.';
  const expectedCallStop =
    'Claude Code tried to use a tool that is not allowed in a read-only mode (mcp__agentcanopy__submit_plan), so the turn was stopped.';

  it('the L1 recording passes in a Plan turn with an unlocked plan', () => {
    const events = mapFixture('L1');
    const session = events.find((e) => e.type === 'session');
    expect(session && 'tools' in session ? session.tools : []).toContain(PLAN);
    expect(events.some((e) => e.type === 'tool-call' && e.name === PLAN)).toBe(true);
    expect(feed(createReadOnlyPolicy(), events, ctx('plan', false))).toEqual([]);
  });

  it('the L1 recording is stopped in a Plan turn with a locked plan, and in an Ask turn', () => {
    for (const context of [ctx('plan', true), ctx('ask', false)]) {
      const findings = feed(createReadOnlyPolicy(), mapFixture('L1'), context);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0]).toEqual({ stop: expectedSessionStop });
    }
  });

  it('the tool in session.tools is a violation in Ask mode and with a locked plan', () => {
    for (const context of [ctx('ask', false), ctx('ask', true), ctx('plan', true)]) {
      expect(createReadOnlyPolicy().inspect?.(sessionEvent({ tools }), context)).toEqual({
        stop: expectedSessionStop,
      });
    }
    expect(
      createReadOnlyPolicy().inspect?.(sessionEvent({ tools }), ctx('plan', false)),
    ).toBeUndefined();
  });

  it('a tool-call of it is a violation in Ask mode and with a locked plan', () => {
    for (const context of [ctx('ask', false), ctx('plan', true)]) {
      const policy = createReadOnlyPolicy();
      policy.inspect?.(sessionEvent(), context);
      expect(policy.inspect?.(toolCall(PLAN), context)).toEqual({ stop: expectedCallStop });
      expect(policy.inspect?.(toolCall(PLAN, 'parent-1'), context)).toEqual({
        stop: expectedCallStop,
      });
    }
    const policy = createReadOnlyPolicy();
    const open = ctx('plan', false);
    policy.inspect?.(sessionEvent({ tools }), open);
    expect(policy.inspect?.(toolCall(PLAN), open)).toBeUndefined();
  });

  it('the server rule is unchanged in a Plan turn, and other tools are still refused', () => {
    const open = ctx('plan', false);
    expect(
      createReadOnlyPolicy().inspect?.(sessionEvent({ tools, mcpServers: [] }), open)?.stop,
    ).toContain('tool servers');
    expect(
      createReadOnlyPolicy().inspect?.(sessionEvent({ tools: [...tools, 'Bash'] }), open)?.stop,
    ).toContain('(Bash)');
    const policy = createReadOnlyPolicy();
    policy.inspect?.(sessionEvent({ tools }), open);
    expect(policy.inspect?.(toolCall('mcp__agentcanopy__other'), open)?.stop).toContain(
      'tried to use',
    );
  });
});

describe('guard: state per turn and per conversation', () => {
  const result: AgentEvent = {
    type: 'result',
    outcome: 'completed',
    isError: false,
    text: '',
    numTurns: 1,
    durationMs: 1,
    permissionDenials: [],
  };

  it('the hook notice is given again in the next turn of the same conversation', () => {
    const policy = createReadOnlyPolicy();
    const context = contextFor();
    const turn = [sessionEvent(), hook(), hook(), result];
    expect(feed(policy, turn, context)).toHaveLength(1);
    expect(feed(policy, turn, context)).toHaveLength(1);
  });

  it('content after a result needs a new session event', () => {
    const policy = createReadOnlyPolicy();
    const context = contextFor();
    feed(policy, [sessionEvent(), result], context);
    expect(policy.inspect?.(text, context)?.stop).toContain('before reporting its configuration');
  });

  it('a session event starts a turn afresh even without a result before it', () => {
    const policy = createReadOnlyPolicy();
    const context = contextFor();
    expect(feed(policy, [sessionEvent(), hook()], context)).toHaveLength(1);
    expect(feed(policy, [sessionEvent(), hook()], context)).toHaveLength(1);
  });

  it('conversations do not share state', () => {
    const policy = createReadOnlyPolicy();
    const one = contextFor({}, 'one');
    const two = contextFor({}, 'two');
    policy.inspect?.(sessionEvent(), one);
    // Conversation two has not reported a session, whatever conversation one did.
    expect(policy.inspect?.(text, two)?.stop).toContain('before reporting its configuration');
    expect(policy.inspect?.(text, one)).toBeUndefined();
    expect(feed(policy, [hook()], one)).toHaveLength(1);
    policy.inspect?.(sessionEvent(), two);
    expect(feed(policy, [hook()], two)).toHaveLength(1);
    expect(feed(policy, [hook()], one)).toHaveLength(0);
  });

  it('two policies do not share state', () => {
    const a = createReadOnlyPolicy();
    const b = createReadOnlyPolicy();
    a.inspect?.(sessionEvent(), contextFor());
    expect(b.inspect?.(text, contextFor())?.stop).toBeDefined();
  });
});
