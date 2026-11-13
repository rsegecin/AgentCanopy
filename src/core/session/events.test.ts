import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import type { AssistantMessage, MessagePart, ToolCallView } from '../../shared';
import {
  assistantToolUse,
  block,
  createHarness,
  delta,
  resultStep,
  sendAndFinish,
  stateEvent,
  userToolResult,
  until,
  type Harness,
  type Step,
} from './test-support';

const harnesses: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

function assistant(messages: readonly { role: string }[]): AssistantMessage {
  const message = messages.find((m): m is AssistantMessage => m.role === 'assistant');
  if (!message) throw new Error('no assistant message');
  return message;
}

function tools(message: AssistantMessage): ToolCallView[] {
  return message.parts.flatMap((part) => (part.kind === 'tool' ? [part.call] : []));
}

const config = { decision: 'accept', source: 'config' } as const;

describe('assistant output', () => {
  it('builds parts in order, trusts the block over the deltas and ignores subagent text', async () => {
    const finalId = randomUUID();
    const steps: Step[] = [
      stateEvent('running'),
      initEvent(),
      delta('thinking', 'hm'),
      block('thinking', 'hmm, let me look'),
      delta('text', 'Helo'),
      block('text', 'Hello'),
      assistantToolUse('toolu_1', 'Read', { file_path: 'a.ts' }),
      // Subagent output: its text is ignored, its tool call is shown under the parent.
      delta('text', 'subagent text', 'toolu_1'),
      block('text', 'subagent block', { parent: 'toolu_1' }),
      assistantToolUse('toolu_2', 'Grep', { pattern: 'x' }, 'toolu_1'),
      userToolResult('toolu_2', 'match', { decision: config }),
      userToolResult('toolu_1', 'contents', { decision: config }),
      // A tool that never reports back, and a result with no decision at all.
      assistantToolUse('toolu_3', 'Glob', { pattern: '*' }),
      assistantToolUse('toolu_4', 'Read', { file_path: 'b.ts' }),
      {
        emit: {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_4', content: 'b' }],
          },
          session_id: '$SESSION',
          parent_tool_use_id: null,
          uuid: randomUUID(),
        },
      },
      // A block with no deltas before it is added as it is.
      block('text', 'Final answer', { uuid: finalId }),
      ...resultStep('Final answer', {
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 6,
        },
        total_cost_usd: 0.01,
      }),
    ];
    const h = await harness({ scenario: { steps } });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'look around');
    expect(turn.status).toBe('completed');

    const message = assistant(view.active().messages);
    const kinds = message.parts.map((part: MessagePart) => part.kind);
    expect(kinds).toEqual(['thinking', 'text', 'tool', 'tool', 'tool', 'tool', 'text']);
    expect(message.parts[0]).toEqual({ kind: 'thinking', text: 'hmm, let me look' });
    expect(message.parts[1]).toEqual({ kind: 'text', text: 'Hello' });
    expect(message.parts[6]).toEqual({ kind: 'text', text: 'Final answer' });
    expect(JSON.stringify(message)).not.toContain('subagent');

    const [read, grep, glob, bare] = tools(message);
    expect(read?.status).toBe('done');
    expect(read?.approval).toBe('provider');
    expect(grep?.parentId).toBe('toolu_1');
    expect(grep?.status).toBe('done');
    // Never reported back: not run, with an end time.
    expect(glob?.status).toBe('not-run');
    expect(glob?.endedAt).toBeDefined();
    // Ran with no decision on record: unverified.
    expect(bare?.status).toBe('done');
    expect(bare?.approval).toBe('unverified');

    expect(turn.forkPointEventId).toBe(finalId);
    expect(turn.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4,
      cacheReadTokens: 5,
      cacheCreationTokens: 6,
      costUsd: 0.01,
    });
    view.expectMirror();
  });

  it('shows what the turn is doing and clears it at the end', async () => {
    const steps: Step[] = [
      stateEvent('running'),
      initEvent(),
      {
        emit: {
          type: 'system',
          subtype: 'status',
          status: 'compacting',
          session_id: '$SESSION',
          uuid: randomUUID(),
        },
      },
      { sleep: 20 },
      {
        emit: {
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 5,
          retry_delay_ms: 100,
          error: 'overloaded',
          session_id: '$SESSION',
          uuid: randomUUID(),
        },
      },
      { sleep: 20 },
      block('text', 'ok'),
      ...resultStep('ok'),
    ];
    const h = await harness({ scenario: { steps } });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('completed');
    const activities = view
      .patches()
      .flatMap((patch) => patch.ops)
      .flatMap((op) =>
        op.op === 'set' && op.path.join('/') === 'active/activity'
          ? [op.value as string | null]
          : [],
      );
    expect(activities).toEqual(
      expect.arrayContaining(['Compacting the conversation…', 'Retrying (2 of 5)…', null]),
    );
    expect(view.active().activity).toBeNull();
    view.expectMirror();
  });
});

describe('how a turn ends', () => {
  it('never shows the provider text for an interruption', async () => {
    const steps: Step[] = [
      stateEvent('running'),
      initEvent(),
      block('text', 'partial'),
      ...resultStep('Request interrupted by user', {
        subtype: 'error_during_execution',
        is_error: true,
        terminal_reason: 'aborted_streaming',
      }),
    ];
    const h = await harness({ scenario: { steps } });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('interrupted');
    expect(turn.error).toBeUndefined();
    expect(JSON.stringify(view.active())).not.toContain('Request interrupted by user');
    expect(view.toasts).toEqual([]);
  });

  it('turns a rejected rate limit into one notice, a toast with the reset time and an error', async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const steps: Step[] = [
      stateEvent('running'),
      initEvent(),
      {
        emit: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt, rateLimitType: 'five_hour' },
          session_id: '$SESSION',
          uuid: randomUUID(),
        },
      },
      ...resultStep('limit reached', {
        subtype: 'success',
        is_error: true,
        api_error_status: 429,
        terminal_reason: 'api_error',
      }),
    ];
    const h = await harness({ scenario: { steps } });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe("Claude Code's usage limit was reached. Try again later.");
    const notices = assistant(view.active().messages).parts.filter((p) => p.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'notice', level: 'warning' });
    expect(notices[0]?.kind === 'notice' && notices[0].text).toMatch(/It resets at /);
    expect(view.toasts).toHaveLength(1);
    expect(view.toasts[0]?.level).toBe('warning');
    expect(view.toasts[0]?.text).toMatch(/^Usage limit reached\. It resets at /);
    view.expectMirror();
  });

  it('shows a rate limit without a reset time as a notice only', async () => {
    const steps: Step[] = [
      stateEvent('running'),
      initEvent(),
      {
        emit: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected' },
          session_id: '$SESSION',
          uuid: randomUUID(),
        },
      },
      ...resultStep('', { is_error: true, api_error_status: 429, terminal_reason: 'api_error' }),
    ];
    const h = await harness({ scenario: { steps } });
    const view = h.attach();
    await sendAndFinish(h, view, 'go');
    const notices = assistant(view.active().messages).parts.filter((p) => p.kind === 'notice');
    expect(notices).toEqual([
      { kind: 'notice', level: 'warning', text: "Claude Code's usage limit was reached." },
    ]);
    expect(view.toasts).toEqual([]);
  });

  it('says so when a turn stops at a limit', async () => {
    const steps: Step[] = [
      stateEvent('running'),
      initEvent(),
      block('text', 'so far'),
      ...resultStep('', {
        subtype: 'error_max_turns',
        is_error: true,
        terminal_reason: 'max_turns',
      }),
    ];
    const h = await harness({ scenario: { steps } });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe(
      'Claude Code stopped because it reached a limit. Send another message to continue.',
    );
    expect(assistant(view.active().messages).parts.at(-1)).toMatchObject({
      kind: 'notice',
      level: 'error',
    });
  });

  it('asks for a new sign-in and checks the provider again when authentication fails', async () => {
    const steps: Step[] = [
      stateEvent('running'),
      initEvent(),
      {
        emit: {
          type: 'assistant',
          message: {
            id: 'msg_x',
            role: 'assistant',
            type: 'message',
            content: [{ type: 'text', text: 'Please run /login' }],
          },
          error: 'authentication_failed',
          session_id: '$SESSION',
          parent_tool_use_id: null,
          uuid: randomUUID(),
        },
      },
      ...resultStep('Please run /login', {
        is_error: true,
        api_error_status: 401,
        terminal_reason: 'api_error',
      }),
    ];
    const h = await harness({ scenario: { steps } });
    const view = h.attach();
    expect(view.current().banners).toEqual([]);
    // From now on the CLI reports that it is signed out.
    const fake = h.fakes[0];
    if (!fake) throw new Error('no fake CLI');
    fake.env.FAKE_CLAUDE_AUTH = JSON.stringify({ loggedIn: false });

    const turn = await sendAndFinish(h, view, 'go');
    const sentence = 'Claude Code is no longer signed in. Sign in and send the message again.';
    expect(turn.status).toBe('error');
    expect(turn.error).toBe(sentence);
    const notices = assistant(view.active().messages).parts.filter((p) => p.kind === 'notice');
    expect(notices).toEqual([{ kind: 'notice', level: 'error', text: sentence }]);
    await until('the sign-in banner', () =>
      view.current().banners.some((b) => b.id === 'provider-problem:signed-out'),
    );
    expect(view.current().provider?.auth).toBe('signed-out');
    view.expectMirror();
  });

  it('keeps the session id Claude Code reports', async () => {
    const reported = randomUUID();
    const steps: Step[] = [
      stateEvent('running'),
      initEvent({ session_id: reported }),
      block('text', 'ok'),
      ...resultStep('ok'),
    ];
    const h = await harness({ scenario: { steps }, record: true });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    expect(view.active().meta.sessionId).toBe(reported);
    await sendAndFinish(h, view, 'two');
    const record = await h.record();
    expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe(reported);
  });
});
