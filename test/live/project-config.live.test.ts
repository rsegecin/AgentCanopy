/**
 * Live test of the project-settings question against the real Claude Code CLI. A repository that
 * sets environment variables in its own Claude Code settings must not affect a turn unless the user
 * chose to use them. Real model calls on the signed-in account: run only through `npm run test:live`.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  harness = await createHarness({
    providers: [createClaudeProvider({ claudePath: () => '' })],
    realDefaults: true,
  });
  await fs.mkdir(join(harness.workspace, '.claude'), { recursive: true });
  await fs.writeFile(
    join(harness.workspace, '.claude', 'settings.json'),
    JSON.stringify({ env: { AGC_LIVE_PROJECT_ENV: 'from-the-repository' } }),
  );
  await harness.controller.start();
  view = harness.attach();
});

afterAll(async () => {
  await harness.dispose();
});

/** Runs one Agent turn that echoes the variable, allowing the command once. */
async function echoTurn(): Promise<{ output: string; notices: string[] }> {
  const active = view.state?.active;
  const before = active?.turns.length ?? 0;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text: 'Run exactly this shell command and nothing else: echo "[$AGC_LIVE_PROJECT_ENV]"',
    mode: 'agent',
    model: 'haiku',
  });
  await until(
    'the command prompt',
    () => view.state?.active?.prompts.some((p) => p.state === 'pending') ?? false,
    120_000,
  );
  const prompt = view.active().prompts.find((p) => p.state === 'pending');
  if (prompt?.kind !== 'permission') throw new Error('expected a permission prompt');
  view.send({
    type: 'prompt.answer',
    promptId: prompt.id,
    displayHash: prompt.displayHash,
    answer: { kind: 'permission', choice: 'allow-once' },
  });
  await until(
    'the turn to finish',
    () => {
      const turns = view.state?.active?.turns ?? [];
      const last = turns[turns.length - 1];
      return (
        turns.length > before &&
        harness.controller.runningTurns() === 0 &&
        last?.status === 'completed'
      );
    },
    170_000,
  );
  const conversation = view.active();
  const turn = conversation.turns[conversation.turns.length - 1];
  const parts = conversation.messages
    .filter((m): m is AssistantMessage => m.role === 'assistant' && m.turnId === turn?.id)
    .flatMap((m) => m.parts);
  return {
    output: parts
      .map((p) => (p.kind === 'tool' && p.call.name === 'Bash' ? (p.call.resultPreview ?? '') : ''))
      .join(''),
    notices: parts.flatMap((p) => (p.kind === 'notice' ? [p.text] : [])),
  };
}

describe('the project settings question against the real CLI', () => {
  it('asks, and when told to ignore them the repository variable does not reach the command', async () => {
    harness.ui.chooseAnswers = ['ignore'];
    const { output, notices } = await echoTurn();
    const asked = harness.ui.callsOf('choose');
    expect(asked).toHaveLength(1);
    expect(JSON.stringify(asked[0])).toContain('AGC_LIVE_PROJECT_ENV');
    expect(output).toContain('[]');
    expect(output).not.toContain('from-the-repository');
    expect(notices.some((n) => n.includes('ignored'))).toBe(true);
  });

  it('remembers the answer for the folder and does not ask again', async () => {
    const { output } = await echoTurn();
    expect(harness.ui.callsOf('choose')).toHaveLength(1);
    expect(output).toContain('[]');
  });

  it('after asking again and choosing to use them, the variable reaches the command', async () => {
    await harness.controller.resetProjectConfigDecision(view.active().meta.folder);
    harness.ui.chooseAnswers = ['use'];
    const { output } = await echoTurn();
    expect(harness.ui.callsOf('choose')).toHaveLength(2);
    expect(output).toContain('[from-the-repository]');
    expect(view.problems).toEqual([]);
  });
});
