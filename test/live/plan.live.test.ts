/**
 * Live Plan-mode test against the real Claude Code CLI. It makes real model calls on the signed-in
 * account, so it only runs through `npm run test:live`. Prompts are tiny and the model is Haiku.
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

let harness: Harness;
let view: TestView;

beforeAll(async () => {
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

async function sendPlan(text: string): Promise<{ status: string; notices: string[] }> {
  const before = view.state?.active?.turns.length ?? 0;
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'plan',
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
    170_000,
  );
  const conversation = view.active();
  const turn = conversation.turns[conversation.turns.length - 1];
  const notices = conversation.messages.flatMap((m) =>
    m.role === 'assistant' && m.turnId === turn?.id
      ? m.parts.flatMap((p) => (p.kind === 'notice' ? [p.text] : []))
      : [],
  );
  return { status: turn?.status ?? 'missing', notices };
}

describe('Plan mode against the real CLI', () => {
  it('saves a plan through the plan tool and changes no file', async () => {
    const before = await fs.readdir(harness.workspace);
    const result = await sendPlan(
      'Make a very small plan with exactly two stages for adding a README.md to this empty folder. ' +
        'Save it with the submit_plan tool. Keep every field short.',
    );
    expect(result.status).toBe('completed');
    expect(result.notices).toEqual([]);
    const plan = view.active().plan;
    expect(plan?.versions).toHaveLength(1);
    expect(plan?.versions[0]?.content.stages).toHaveLength(2);
    expect(plan?.approvals).toEqual([]);
    expect(await fs.readdir(harness.workspace)).toEqual(before);
    expect(view.problems).toEqual([]);
  });

  it('cannot change a locked plan', async () => {
    const conversationId = view.active().meta.id;
    view.send({ type: 'plan.setLocked', conversationId, locked: true });
    await until('the plan to be locked', () => view.active().meta.planLocked);
    const result = await sendPlan(
      'Rename the first stage to "Something else" and save the plan again with submit_plan.',
    );
    // The tool does not exist in this turn, so whatever the model says, the plan is unchanged.
    expect(result.status).toBe('completed');
    expect(view.active().plan?.versions).toHaveLength(1);
    expect(view.active().plan?.approvals).toEqual([]);
  });
});
