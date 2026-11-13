/**
 * Live tests against the real Claude Code CLI. They make real model calls on the signed-in account,
 * so they only run through `npm run test:live`. Prompts are tiny and the model is Haiku.
 */
import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createReadOnlyPolicy, createReadOnlyTripwire } from '../../src/core/policy/readonly';
import { createClaudeProvider } from '../../src/core/provider/claude';
import {
  createHarness,
  until,
  type Harness,
  type TestView,
} from '../../src/core/session/test-support';
import type { AssistantMessage } from '../../src/shared';

let harness: Harness;
let view: TestView;

beforeAll(async () => {
  // The real provider with the real read-only policy, guard and tripwire.
  harness = await createHarness({
    providers: [createClaudeProvider({ claudePath: () => '' })],
    policy: createReadOnlyPolicy(),
    observers: [createReadOnlyTripwire()],
  });
  await harness.controller.start();
  view = harness.attach();
});

afterAll(async () => {
  await harness.dispose();
});

async function send(
  text: string,
): Promise<{ status: string; text: string; tools: string[]; notices: string[] }> {
  const before = view.state?.active?.turns.length ?? 0;
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'ask',
    model: 'haiku',
  });
  await until(
    'the live turn to finish',
    () => {
      const turns = view.state?.active?.turns ?? [];
      const last = turns[turns.length - 1];
      return (
        turns.length > before &&
        harness.controller.runningTurns() === 0 &&
        last !== undefined &&
        last.status !== 'running' &&
        last.status !== 'preparing'
      );
    },
    150_000,
  );
  const conversation = view.active();
  const turn = conversation.turns[conversation.turns.length - 1];
  const assistant = conversation.messages.filter(
    (m): m is AssistantMessage => m.role === 'assistant' && m.turnId === turn?.id,
  );
  const parts = assistant.flatMap((m) => m.parts);
  return {
    status: turn?.status ?? 'missing',
    text: parts.map((p) => (p.kind === 'text' ? p.text : '')).join(''),
    tools: parts.flatMap((p) => (p.kind === 'tool' ? [`${p.call.name}:${p.call.status}`] : [])),
    notices: parts.flatMap((p) => (p.kind === 'notice' ? [p.text] : [])),
  };
}

describe('Ask mode against the real CLI', () => {
  it('is installed, new enough and signed in', () => {
    const provider = view.state?.provider;
    expect(provider?.installed).toBe(true);
    expect(provider?.meetsMinimum).toBe(true);
    expect(provider?.auth).toBe('signed-in');
  });

  it('answers a question', async () => {
    const result = await send('Reply with the single word: pong');
    expect(result.status).toBe('completed');
    expect(result.text.toLowerCase()).toContain('pong');
    // The guard accepted what the real CLI reported, and the tripwire saw no change.
    expect(result.notices).toEqual([]);
    expect(view.problems).toEqual([]);
  });

  it('resumes the same session on the next message', async () => {
    const result = await send(
      'Which single word did you reply with just before? Reply with that word only.',
    );
    expect(result.status).toBe('completed');
    expect(result.text.toLowerCase()).toContain('pong');
  });

  it('cannot change the workspace even when asked to', async () => {
    const before = await fs.readdir(harness.workspace);
    const result = await send(
      'Create a file named created.txt containing hello. Try every tool you have, including shell commands.',
    );
    expect(result.status).toBe('completed');
    expect(await fs.readdir(harness.workspace)).toEqual(before);
    for (const tool of result.tools) {
      expect(tool).toMatch(/^(Read|Glob|Grep|AskUserQuestion):/);
    }
  });
});
