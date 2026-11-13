import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  ErrorEvent,
  ResultEvent,
  SessionEvent,
  ToolCallEvent,
  ToolResultEvent,
} from '../../../../shared';
import { createClaudeEventMapper } from './index';
import type { ClaudeProcessExit } from './index';

const FIXTURES = join(__dirname, '../../../../../test/fixtures/cli');

function lines(name: string): string[] {
  return readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

function mapFixture(name: string, resuming = false): AgentEvent[] {
  const mapper = createClaudeEventMapper({ resuming });
  return lines(name).flatMap((l) => mapper.push(l));
}

function ofType<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T,
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

function only<T>(items: T[]): T {
  expect(items).toHaveLength(1);
  return items[0] as T;
}

const ALL = ['T1', 'T2', 'P1', 'P2', 'Q1', 'C1', 'E1', 'L1', 'S1'];

const exitBase: ClaudeProcessExit = {
  exitCode: 0,
  signal: null,
  stderrTail: '',
  cancelled: false,
  droppedLines: 0,
};

describe('fixtures', () => {
  it('T1: plain text turn', () => {
    const events = mapFixture('T1');
    const session: SessionEvent = only(ofType(events, 'session'));
    expect(session.tools).toHaveLength(25);
    expect(session.credential).toBe('subscription');
    expect(session.model).toBe('claude-haiku-5-5');
    expect(session.cliVersion).toBe('2.1.322');
    expect(session.cwd).toBe('/work');

    const deltas = ofType(events, 'text-delta').filter((d) => d.kind === 'text');
    expect(deltas.map((d) => d.text).join('')).toBe('pong');
    const blocks = ofType(events, 'assistant-block');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'text', text: 'pong', parentToolCallId: null });
    expect(blocks[0]?.providerEventId).not.toBe('');

    const rate = only(ofType(events, 'rate-limit'));
    expect(rate).toEqual({
      type: 'rate-limit',
      status: 'allowed',
      resetsAt: 1794445200 * 1000,
      limitKind: 'five_hour',
    });

    const result = only(ofType(events, 'result'));
    expect(result.outcome).toBe('completed');
    expect(result.isError).toBe(false);
    expect(result.text).toBe('pong');
    expect(result.category).toBeUndefined();
    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cacheReadTokens: 10971,
      cacheCreationTokens: 10173,
      costUsd: 0.00214651,
      contextWindow: 1000000,
      contextTokens: 2 + 10971 + 10173,
    });
    expect(events.at(-1)).toEqual({ type: 'status', state: 'idle' });
    expect(events[0]).toEqual({ type: 'status', state: 'running' });
  });

  it('T2: a Read call decided by the provider', () => {
    const events = mapFixture('T2');
    const call: ToolCallEvent = only(ofType(events, 'tool-call'));
    expect(call.name).toBe('Read');
    expect(call.input).toEqual({ file_path: '/work/notes.txt' });
    const res: ToolResultEvent = only(ofType(events, 'tool-result'));
    expect(res.toolCallId).toBe(call.toolCallId);
    expect(res.decision).toEqual({ outcome: 'accept', source: 'provider' });
    expect(res.isError).toBe(false);
    expect(res.notExecuted).toBe(false);
    expect(res.truncated).toBe(false);
    expect(res.text).toBe('1\talpha beta');
  });

  it('P1: a host decision', () => {
    const res = only(ofType(mapFixture('P1'), 'tool-result'));
    expect(res.decision).toEqual({ outcome: 'accept', source: 'host' });
    expect(res.notExecuted).toBe(false);
  });

  it('P2: a denied call', () => {
    const events = mapFixture('P2');
    const res = only(ofType(events, 'tool-result'));
    expect(res.isError).toBe(true);
    expect(res.notExecuted).toBe(true);
    expect(res.decision).toEqual({ outcome: 'reject', source: 'host' });
    const result = only(ofType(events, 'result'));
    expect(result.permissionDenials).toEqual([{ toolName: 'Write', toolCallId: res.toolCallId }]);
    // The empty thinking deltas are not emitted.
    expect(ofType(events, 'text-delta').every((d) => d.text !== '')).toBe(true);
  });

  it('Q1: the AskUserQuestion call and its answer', () => {
    const events = mapFixture('Q1');
    const call = only(ofType(events, 'tool-call'));
    expect(call.name).toBe('AskUserQuestion');
    expect(call.input).toMatchObject({ questions: [{ question: 'Which colour do you prefer?' }] });
    const res = only(ofType(events, 'tool-result'));
    expect(res.toolCallId).toBe(call.toolCallId);
    expect(res.text).toContain('"Blue"');
    expect(res.decision).toEqual({ outcome: 'accept', source: 'host' });
    expect(only(ofType(events, 'session')).tools).toContain('AskUserQuestion');
  });

  it('C1: an interrupted turn', () => {
    const events = mapFixture('C1');
    const result = only(ofType(events, 'result'));
    expect(result.outcome).toBe('interrupted');
    expect(result.terminalReason).toBe('aborted_streaming');
    expect(result.category).toBeUndefined();
    // The "[Request interrupted by user]" text event yields nothing.
    expect(ofType(events, 'tool-result')).toHaveLength(0);
  });

  it('E1: an unknown model', () => {
    const events = mapFixture('E1');
    const result: ResultEvent = only(ofType(events, 'result'));
    expect(result.outcome).toBe('error');
    expect(result.category).toBe('model-not-found');
    expect(result.isError).toBe(true);
    expect(result.usage?.contextWindow).toBeUndefined();
    const errors = ofType(events, 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.category).toBe('model-not-found');
    // The synthetic assistant message still maps to a text block.
    expect(ofType(events, 'assistant-block')).toHaveLength(1);
    // Synthetic zero usage is not reported as the context size.
    expect(result.usage?.contextTokens).toBeUndefined();
  });

  it('L1: the plan tool call', () => {
    const events = mapFixture('L1');
    const call = only(ofType(events, 'tool-call'));
    expect(call.name).toBe('mcp__agentcanopy__submit_plan');
    const res = only(ofType(events, 'tool-result'));
    expect(res.text).toBe('Plan saved.');
    expect(res.decision).toEqual({ outcome: 'accept', source: 'provider' });
  });

  it('S1: the session id and plugins', () => {
    const events = mapFixture('S1');
    const session = only(ofType(events, 'session'));
    const first = JSON.parse(lines('S1')[0] as string) as { session_id: string };
    expect(session.sessionId).toBe(first.session_id);
    expect(session.plugins.length).toBeGreaterThan(0);
    expect(session.plugins.every((p) => p.builtin)).toBe(true);
  });

  it('never produces a protocol error and always exactly one result', () => {
    for (const name of ALL) {
      const events = mapFixture(name);
      expect(ofType(events, 'error').filter((e) => e.category === 'protocol')).toEqual([]);
      expect(ofType(events, 'result')).toHaveLength(1);
    }
  });

  it('reports each unknown kind once', () => {
    const events = mapFixture('P2');
    const unknown = ofType(events, 'unknown');
    expect(unknown).toEqual([{ type: 'unknown', rawType: 'system/thinking_tokens' }]);
  });

  it('never emits the fields that must not be logged', () => {
    for (const name of ALL) {
      const json = JSON.stringify(mapFixture(name));
      expect(json).not.toContain('credential_expires_at');
      expect(json).not.toContain('memory_paths');
      expect(json).not.toContain('messaging_socket_path');
    }
  });

  it('the fixtures really contain the fields the test above looks for', () => {
    const all = ALL.flatMap(lines).join('\n');
    expect(all).toContain('credential_expires_at');
  });

  it('never copies paths other than cwd from init', () => {
    const raw = {
      type: 'system',
      subtype: 'init',
      session_id: 's',
      cwd: '/work',
      memory_paths: ['/Users/x/memory'],
      messaging_socket_path: '/tmp/sock',
      plugins: [{ name: 'p', path: '/Users/x/plugin' }],
    };
    const events = createClaudeEventMapper({ resuming: false }).push(JSON.stringify(raw));
    const json = JSON.stringify(events);
    expect(json).not.toContain('/Users/x');
    expect(json).not.toContain('/tmp/sock');
    expect(only(ofType(events, 'session')).plugins).toEqual([{ name: 'p', builtin: false }]);
  });
});

describe('push: system events', () => {
  const push = (obj: unknown) =>
    createClaudeEventMapper({ resuming: false }).push(JSON.stringify(obj));

  it('maps status values', () => {
    expect(push({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual([
      { type: 'status', state: 'running', detail: 'requesting' },
    ]);
    expect(push({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([
      { type: 'status', state: 'compacting', detail: 'compacting' },
    ]);
    expect(push({ type: 'system', subtype: 'status', status: null })).toEqual([
      { type: 'status', state: 'running' },
    ]);
    expect(push({ type: 'system', subtype: 'compact_boundary' })).toMatchObject([
      { type: 'status', state: 'compacting' },
    ]);
  });

  it('maps session state changes and ignores other states', () => {
    expect(push({ type: 'system', subtype: 'session_state_changed', state: 'idle' })).toEqual([
      { type: 'status', state: 'idle' },
    ]);
    expect(
      push({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' }),
    ).toEqual([]);
  });

  it('maps api_retry with the category table', () => {
    expect(
      push({
        type: 'system',
        subtype: 'api_retry',
        attempt: 2,
        max_retries: 10,
        retry_delay_ms: 1500,
        error: 'rate_limit',
      }),
    ).toEqual([
      { type: 'retry', attempt: 2, maxRetries: 10, delayMs: 1500, category: 'rate-limit' },
    ]);
  });

  it('maps hook events', () => {
    expect(
      push({ type: 'system', subtype: 'hook_started', hook_name: 'PreToolUse:Write' }),
    ).toEqual([{ type: 'hook', phase: 'started', name: 'PreToolUse:Write' }]);
    expect(
      push({
        type: 'system',
        subtype: 'hook_response',
        hook_name: 'PreToolUse:Write',
        outcome: 'success',
        exit_code: 0,
      }),
    ).toEqual([{ type: 'hook', phase: 'response', name: 'PreToolUse:Write', outcome: 'success' }]);
  });

  it('maps every credential source', () => {
    const credential = (apiKeySource?: string) =>
      only(
        ofType(push({ type: 'system', subtype: 'init', session_id: 's', apiKeySource }), 'session'),
      ).credential;
    expect(credential('none')).toBe('subscription');
    expect(credential('ANTHROPIC_API_KEY')).toBe('api-key');
    expect(credential('apiKeyHelper')).toBe('api-key');
    expect(credential('/login managed key')).toBe('unknown');
    expect(credential(undefined)).toBe('unknown');
  });
});

describe('push: stream and assistant events', () => {
  const map = () => createClaudeEventMapper({ resuming: false });
  const delta = (d: unknown, parent: string | null = null) =>
    JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: d },
      parent_tool_use_id: parent,
    });

  it('maps text and thinking deltas with the parent tool call', () => {
    const m = map();
    expect(m.push(delta({ type: 'text_delta', text: 'a' }, 'toolu_1'))).toEqual([
      { type: 'text-delta', kind: 'text', text: 'a', parentToolCallId: 'toolu_1' },
    ]);
    expect(m.push(delta({ type: 'thinking_delta', thinking: 'hm' }))).toEqual([
      { type: 'text-delta', kind: 'thinking', text: 'hm', parentToolCallId: null },
    ]);
  });

  it('ignores other deltas and stream event types', () => {
    const m = map();
    expect(m.push(delta({ type: 'input_json_delta', partial_json: '{' }))).toEqual([]);
    expect(m.push(delta({ type: 'signature_delta', signature: 'x' }))).toEqual([]);
    expect(
      m.push(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } })),
    ).toEqual([]);
  });

  it('maps assistant blocks in order', () => {
    const events = map().push(
      JSON.stringify({
        type: 'assistant',
        uuid: 'u1',
        parent_tool_use_id: 'toolu_p',
        message: {
          model: 'm',
          content: [
            { type: 'thinking', thinking: 'ponder' },
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'hello' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { a: 1 } },
          ],
        },
      }),
    );
    expect(events).toEqual([
      {
        type: 'assistant-block',
        kind: 'thinking',
        text: 'ponder',
        providerEventId: 'u1',
        parentToolCallId: 'toolu_p',
      },
      {
        type: 'assistant-block',
        kind: 'text',
        text: 'hello',
        providerEventId: 'u1',
        parentToolCallId: 'toolu_p',
      },
      {
        type: 'tool-call',
        toolCallId: 't1',
        name: 'Read',
        input: { a: 1 },
        providerEventId: 'u1',
        parentToolCallId: 'toolu_p',
      },
    ]);
  });

  it('truncates an oversized tool input', () => {
    const m = createClaudeEventMapper({ resuming: false, maxToolInputChars: 20 });
    const input = { content: 'x'.repeat(100) };
    const [call] = m.push(
      JSON.stringify({
        type: 'assistant',
        uuid: 'u',
        message: { content: [{ type: 'tool_use', id: 't', name: 'Write', input }] },
      }),
    ) as [ToolCallEvent];
    expect(call.input).toEqual({ truncated: true, preview: JSON.stringify(input).slice(0, 20) });
  });

  it('keeps an input exactly at the limit', () => {
    const input = { a: 'b' };
    const limit = JSON.stringify(input).length;
    const m = createClaudeEventMapper({ resuming: false, maxToolInputChars: limit });
    const [call] = m.push(
      JSON.stringify({
        type: 'assistant',
        uuid: 'u',
        message: { content: [{ type: 'tool_use', id: 't', name: 'W', input }] },
      }),
    ) as [ToolCallEvent];
    expect(call.input).toEqual(input);
  });

  it('adds an error event when the assistant event has an error field', () => {
    const events = map().push(
      JSON.stringify({
        type: 'assistant',
        uuid: 'u',
        error: 'authentication_failed',
        message: { model: '<synthetic>', content: [{ type: 'text', text: 'Please log in' }] },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['assistant-block', 'error']);
    expect(events[1]).toEqual({
      type: 'error',
      category: 'authentication',
      message: 'Please log in',
    });
  });

  it('maps the whole error category table', () => {
    const category = (error: string) =>
      (
        createClaudeEventMapper({ resuming: false }).push(
          JSON.stringify({
            type: 'assistant',
            uuid: 'u',
            error,
            message: { content: [] },
          }),
        )[0] as ErrorEvent
      ).category;
    expect(category('authentication_failed')).toBe('authentication');
    expect(category('oauth_org_not_allowed')).toBe('authentication');
    expect(category('billing_error')).toBe('billing');
    expect(category('account_on_hold')).toBe('billing');
    expect(category('rate_limit')).toBe('rate-limit');
    expect(category('overloaded')).toBe('overloaded');
    expect(category('server_error')).toBe('overloaded');
    expect(category('invalid_request')).toBe('invalid-request');
    expect(category('max_output_tokens')).toBe('invalid-request');
    expect(category('model_not_found')).toBe('model-not-found');
    expect(category('something_else')).toBe('unknown');
  });
});

describe('push: user events', () => {
  const user = (content: unknown, meta?: unknown) =>
    JSON.stringify({
      type: 'user',
      parent_tool_use_id: null,
      message: { content },
      tool_result_meta: meta,
    });
  const map = (max?: number) =>
    createClaudeEventMapper({
      resuming: false,
      ...(max !== undefined ? { maxToolResultChars: max } : {}),
    });

  it('yields nothing for text-only content', () => {
    expect(map().push(user([{ type: 'text', text: '[Request interrupted by user]' }]))).toEqual([]);
    expect(map().push(user('plain'))).toEqual([]);
  });

  it('joins text blocks and replaces other blocks with placeholders', () => {
    const [res] = map().push(
      user([
        {
          type: 'tool_result',
          tool_use_id: 't',
          content: [
            { type: 'text', text: 'one' },
            { type: 'image', source: {} },
            { type: 'document' },
            { type: 'text', text: 'two' },
          ],
        },
      ]),
    ) as [ToolResultEvent];
    expect(res.text).toBe('one\n[image]\n[document]\ntwo');
  });

  it('truncates an oversized result', () => {
    const [res] = map(10).push(
      user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(50), is_error: true }]),
    ) as [ToolResultEvent];
    expect(res.text).toBe('x'.repeat(10));
    expect(res.truncated).toBe(true);
    expect(res.isError).toBe(true);
  });

  it('does not truncate a result at the limit', () => {
    const [res] = map(10).push(
      user([{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(10) }]),
    ) as [ToolResultEvent];
    expect(res.truncated).toBe(false);
  });

  it('maps decision sources', () => {
    const source = (s: string | undefined) => {
      const [res] = map().push(
        user(
          [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
          [{ id: 't', permission_decision: { decision: 'accept', source: s } }],
        ),
      ) as [ToolResultEvent];
      return res.decision?.source;
    };
    expect(source('config')).toBe('provider');
    expect(source('user_temporary')).toBe('host');
    expect(source('user_reject')).toBe('host');
    expect(source('user_anything')).toBe('host');
    expect(source('classifier')).toBe('unknown');
    expect(source(undefined)).toBe('unknown');
  });

  it('leaves the decision off when no meta entry matches', () => {
    const [res] = map().push(
      user(
        [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
        [{ id: 'other', permission_decision: { decision: 'accept', source: 'config' } }],
      ),
    ) as [ToolResultEvent];
    expect(res.decision).toBeUndefined();
    expect(res.notExecuted).toBe(false);
  });
});

describe('push: rate limits', () => {
  const rate = (status: string) =>
    createClaudeEventMapper({ resuming: false }).push(
      JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status } }),
    );

  it('maps the three statuses', () => {
    expect(rate('allowed')).toEqual([{ type: 'rate-limit', status: 'allowed' }]);
    expect(rate('allowed_warning')).toEqual([{ type: 'rate-limit', status: 'warning' }]);
    expect(rate('rejected')).toEqual([{ type: 'rate-limit', status: 'rejected' }]);
  });

  it('reports an unrecognised status once as unknown', () => {
    const m = createClaudeEventMapper({ resuming: false });
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'weird' } });
    expect(m.push(line)).toEqual([{ type: 'unknown', rawType: 'rate_limit_event:weird' }]);
    expect(m.push(line)).toEqual([]);
  });
});

describe('push: results', () => {
  const result = (
    raw: Record<string, unknown>,
    opts: { init?: boolean; resuming?: boolean } = {},
  ) => {
    const m = createClaudeEventMapper({ resuming: opts.resuming ?? false });
    if (opts.init) {
      m.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm1' }));
    }
    return only(ofType(m.push(JSON.stringify({ type: 'result', ...raw })), 'result'));
  };

  it('maps outcomes', () => {
    expect(result({ is_error: false, subtype: 'success' }).outcome).toBe('completed');
    expect(
      result({
        is_error: true,
        terminal_reason: 'aborted_tools',
        subtype: 'error_during_execution',
      }).outcome,
    ).toBe('interrupted');
    const limit = result({ is_error: true, subtype: 'error_max_turns' }, { init: true });
    expect(limit.outcome).toBe('limit');
    expect(limit.isError).toBe(true);
    expect(result({ is_error: true, subtype: 'success' }).outcome).toBe('error');
    expect(result({}).outcome).toBe('error');
  });

  it('maps api statuses to categories', () => {
    const cat = (status: number) => result({ is_error: true, api_error_status: status }).category;
    expect(cat(401)).toBe('authentication');
    expect(cat(403)).toBe('authentication');
    expect(cat(402)).toBe('billing');
    expect(cat(404)).toBe('model-not-found');
    expect(cat(429)).toBe('rate-limit');
    expect(cat(500)).toBe('overloaded');
    expect(cat(529)).toBe('overloaded');
    expect(cat(599)).toBe('overloaded');
    expect(cat(400)).toBe('invalid-request');
  });

  it('uses unknown, startup or session-not-found without an api status', () => {
    expect(result({ is_error: true }, { init: true }).category).toBe('unknown');
    expect(result({ is_error: true, api_error_status: 418 }, { init: true }).category).toBe(
      'unknown',
    );
    expect(result({ is_error: true }).category).toBe('startup');
    expect(result({ is_error: true }, { resuming: true }).category).toBe('session-not-found');
  });

  it('maps the resume-of-a-missing-session shape (protocol doc section 8)', () => {
    const r = result(
      {
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No conversation found with session ID: 00000000-0000-0000-0000-000000000000'],
        total_cost_usd: 0,
      },
      { resuming: true },
    );
    expect(r.outcome).toBe('error');
    expect(r.category).toBe('session-not-found');
    expect(r.text).toContain('No conversation found');
    expect(r.isError).toBe(true);
  });

  it('prefers the result string over errors, and falls back to empty', () => {
    expect(result({ is_error: false, result: 'done', errors: ['e'] }).text).toBe('done');
    expect(result({ is_error: true, errors: ['first', 'second'] }).text).toBe('first');
    expect(result({ is_error: true }).text).toBe('');
  });

  it('picks the context window from the init model, else the largest', () => {
    const usage = { input_tokens: 1, output_tokens: 2 };
    const own = result(
      {
        is_error: false,
        usage,
        modelUsage: { m1: { contextWindow: 200 }, other: { contextWindow: 1000 } },
      },
      { init: true },
    );
    expect(own.usage?.contextWindow).toBe(200);
    const largest = result(
      {
        is_error: false,
        usage,
        modelUsage: { a: { contextWindow: 200 }, b: { contextWindow: 1000 } },
      },
      { init: true },
    );
    expect(largest.usage?.contextWindow).toBe(1000);
    expect(result({ is_error: false }).usage).toBeUndefined();
  });

  it('derives context tokens from the last top-level assistant event only', () => {
    const m = createClaudeEventMapper({ resuming: false });
    const assistant = (parent: string | null, usage: Record<string, number>) =>
      m.push(
        JSON.stringify({
          type: 'assistant',
          uuid: 'u',
          parent_tool_use_id: parent,
          message: { model: 'm', content: [], usage },
        }),
      );
    assistant(null, {
      input_tokens: 1,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 100,
    });
    assistant('toolu_x', { input_tokens: 5000 });
    const r = only(
      ofType(
        m.push(JSON.stringify({ type: 'result', is_error: false, usage: { input_tokens: 1 } })),
        'result',
      ),
    );
    expect(r.usage?.contextTokens).toBe(111);
  });

  it('never copies credential_expires_at', () => {
    const m = createClaudeEventMapper({ resuming: false });
    const json = JSON.stringify(
      m.push(JSON.stringify({ type: 'result', is_error: false, credential_expires_at: 'SECRET' })),
    );
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('credential_expires_at');
  });
});

describe('push: bad input', () => {
  const map = () => createClaudeEventMapper({ resuming: false });

  it('turns garbage into one protocol error and carries on', () => {
    const m = map();
    const garbage = m.push('this is not json SECRET-CONTENT');
    expect(garbage).toHaveLength(1);
    expect(garbage[0]).toMatchObject({ type: 'error', category: 'protocol' });
    expect(JSON.stringify(garbage)).not.toContain('SECRET-CONTENT');
    expect(
      m.push(JSON.stringify({ type: 'system', subtype: 'session_state_changed', state: 'idle' })),
    ).toEqual([{ type: 'status', state: 'idle' }]);
  });

  it('handles truncated lines', () => {
    const line = lines('T1')[1] as string;
    const events = map().push(line.slice(0, line.length / 2));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', category: 'protocol' });
  });

  it('rejects JSON that is not an event object', () => {
    for (const text of ['42', 'null', '[]', '"x"', '{}', '{"type":5}']) {
      const events = map().push(text);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'error', category: 'protocol' });
    }
  });

  it('names the event type for a failed validation, without its content', () => {
    const events = map().push(
      JSON.stringify({ type: 'assistant', message: { content: 'SECRET-CONTENT' } }),
    );
    expect(events).toHaveLength(1);
    const error = events[0] as ErrorEvent;
    expect(error.category).toBe('protocol');
    expect(error.message).toContain('assistant');
    expect(error.message).not.toContain('SECRET-CONTENT');
  });

  it('reports a malformed block inside a valid event', () => {
    const events = map().push(
      JSON.stringify({
        type: 'assistant',
        uuid: 'u',
        message: { content: [{ type: 'text' }, { type: 'text', text: 'ok' }] },
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['error', 'assistant-block']);
  });

  it('ignores blank lines', () => {
    expect(map().push('')).toEqual([]);
    expect(map().push('   ')).toEqual([]);
  });

  it('reports an unknown type once and keeps the name plain', () => {
    const m = map();
    const line = JSON.stringify({ type: 'brand_new' });
    expect(m.push(line)).toEqual([{ type: 'unknown', rawType: 'brand_new' }]);
    expect(m.push(line)).toEqual([]);
    expect(m.push(JSON.stringify({ type: 'system', subtype: 'new_thing' }))).toEqual([
      { type: 'unknown', rawType: 'system/new_thing' },
    ]);
    expect(m.push(JSON.stringify({ type: 'system', subtype: 'new_thing' }))).toEqual([]);
    expect(m.push(JSON.stringify({ type: 'system' }))).toEqual([
      { type: 'unknown', rawType: 'system' },
    ]);
    expect(m.push(JSON.stringify({ type: 'we ird\n<x>' }))).toEqual([
      { type: 'unknown', rawType: 'weirdx' },
    ]);
  });
});

describe('finish', () => {
  const resultLine = JSON.stringify({ type: 'result', is_error: false, result: 'ok' });

  it('returns nothing when a result was seen', () => {
    const m = createClaudeEventMapper({ resuming: false });
    m.push(resultLine);
    expect(m.finish(exitBase)).toEqual([]);
    expect(m.finish({ ...exitBase, spawnError: 'x', cancelled: true })).toEqual([]);
  });

  it('adds one protocol error for dropped lines when a result was seen', () => {
    const m = createClaudeEventMapper({ resuming: false });
    m.push(resultLine);
    const events = m.finish({ ...exitBase, droppedLines: 3 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', category: 'protocol' });
  });

  it('reports a spawn error as a startup failure', () => {
    const events = createClaudeEventMapper({ resuming: false }).finish({
      ...exitBase,
      exitCode: null,
      spawnError: 'spawn ENOENT',
    });
    expect(events).toEqual([
      {
        type: 'error',
        category: 'startup',
        message: 'Claude Code could not be started: spawn ENOENT',
      },
      expect.objectContaining({
        type: 'result',
        outcome: 'error',
        isError: true,
        category: 'startup',
        numTurns: 0,
        durationMs: 0,
        permissionDenials: [],
      }),
    ]);
  });

  it('ends a cancelled turn as interrupted without an error event', () => {
    const events = createClaudeEventMapper({ resuming: false }).finish({
      ...exitBase,
      exitCode: null,
      signal: 'SIGTERM',
      cancelled: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'result',
      outcome: 'interrupted',
      isError: false,
      numTurns: 0,
      durationMs: 0,
      permissionDenials: [],
    });
    expect((events[0] as ResultEvent).category).toBeUndefined();
  });

  it('reports a crash with the exit code and stderr', () => {
    const events = createClaudeEventMapper({ resuming: false }).finish({
      ...exitBase,
      exitCode: 1,
      stderrTail: 'boom: it broke',
    });
    expect(events).toHaveLength(2);
    const error = events[0] as ErrorEvent;
    expect(error.category).toBe('process-crash');
    expect(error.message).toContain('code 1');
    expect(error.message).toContain('boom: it broke');
    expect(events[1]).toMatchObject({ type: 'result', outcome: 'error', isError: true });
  });

  it('mentions the signal when there is one', () => {
    const events = createClaudeEventMapper({ resuming: false }).finish({
      ...exitBase,
      exitCode: null,
      signal: 'SIGKILL',
    });
    expect((events[0] as ErrorEvent).message).toContain('SIGKILL');
  });

  it('handles an exit with neither code nor signal', () => {
    const events = createClaudeEventMapper({ resuming: false }).finish({
      ...exitBase,
      exitCode: null,
    });
    expect((events[0] as ErrorEvent).category).toBe('process-crash');
  });

  it('adds the dropped-lines error before a synthesised ending', () => {
    const events = createClaudeEventMapper({ resuming: false }).finish({
      ...exitBase,
      exitCode: 2,
      droppedLines: 1,
    });
    expect(events.map((e) => (e.type === 'error' ? e.category : e.type))).toEqual([
      'protocol',
      'process-crash',
      'result',
    ]);
  });

  it('synthesises only once', () => {
    const m = createClaudeEventMapper({ resuming: false });
    expect(m.finish({ ...exitBase, exitCode: 1 })).toHaveLength(2);
    expect(m.finish({ ...exitBase, exitCode: 1 })).toEqual([]);
  });
});
