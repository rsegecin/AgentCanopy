import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanDoc, PlanId } from '../../shared';
import { createPlanStore } from './index';
import type { PlanStore } from './index';
import { CONVERSATION, fakeClock, makeTempDir, maximalInput, minimalInput } from './test-support';

let dir: string;
let clock: ReturnType<typeof fakeClock>;
let store: PlanStore;
let plan: PlanDoc;
beforeEach(async () => {
  dir = await makeTempDir();
  clock = fakeClock();
  store = createPlanStore({ dir, clock });
  await store.init();
  const result = await store.submit({ conversationId: CONVERSATION, raw: maximalInput() });
  if (!result.ok) throw new Error(result.message);
  plan = result.plan;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

type Kind = 'decision-point' | 'open-question' | 'interactive-question';
const decide = (targetId: string, kind: Kind, values: string[]) =>
  store.decide(plan.id, { targetId, kind, values });

describe('decide: recording', () => {
  it('records a decision point answer with the version and time', async () => {
    clock.advance(3);
    const updated = await decide('dp1', 'decision-point', ['ttl']);
    expect(updated.decisions).toEqual([
      {
        targetId: 'dp1',
        kind: 'decision-point',
        values: ['ttl'],
        decidedAt: 1_003,
        planVersion: 1,
      },
    ]);
    expect((await store.get(plan.id))?.decisions).toEqual(updated.decisions);
  });

  it('trims values and drops empty ones', async () => {
    const updated = await decide('q2', 'open-question', ['  api ', '', '   ', ' free text ']);
    expect(updated.decisions[0]?.values).toEqual(['api', 'free text']);
  });

  it('replaces an earlier answer for the same target and kind', async () => {
    await decide('dp1', 'decision-point', ['lru']);
    await decide('q3', 'open-question', ['a']);
    const updated = await decide('dp1', 'decision-point', ['ttl']);
    expect(updated.decisions).toHaveLength(2);
    expect(updated.decisions.find((d) => d.targetId === 'dp1')?.values).toEqual(['ttl']);
  });

  it('keeps answers for the same target id but another kind apart', async () => {
    await decide('same', 'interactive-question', ['x']);
    await decide('q3', 'open-question', ['y']);
    const updated = await decide('same', 'interactive-question', ['z']);
    expect(updated.decisions.map((d) => d.values)).toEqual([['y'], ['z']]);
  });

  it('survives a new version and records that version afterwards', async () => {
    await decide('dp1', 'decision-point', ['lru']);
    const next = await store.submit({
      conversationId: CONVERSATION,
      planId: plan.id,
      raw: { ...maximalInput(), title: 'Renamed' },
    });
    expect(next.ok && next.plan.decisions).toHaveLength(1);
    const updated = await decide('q3', 'open-question', ['hi']);
    expect(updated.decisions.map((d) => d.planVersion)).toEqual([1, 2]);
  });
});

describe('decide: validation', () => {
  it('rejects an unknown plan', async () => {
    await expect(
      store.decide('missing' as PlanId, {
        targetId: 'a',
        kind: 'interactive-question',
        values: ['x'],
      }),
    ).rejects.toThrow(/Unknown plan/);
  });

  it('requires at least one non-empty value', async () => {
    await expect(decide('q3', 'open-question', [])).rejects.toThrow(/At least one/);
    await expect(decide('q3', 'open-question', ['  ', ''])).rejects.toThrow(/At least one/);
  });

  it('allows at most 20 values of at most 4000 characters', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `v${i}`);
    await expect(decide('x', 'interactive-question', many)).rejects.toThrow(/At most 20/);
    await expect(decide('x', 'interactive-question', 'a'.repeat(4001).split('\n'))).rejects.toThrow(
      /4000/,
    );
    const ok = await decide('x', 'interactive-question', ['a'.repeat(4000)]);
    expect(ok.decisions[0]?.values[0]).toHaveLength(4000);
    const twenty = Array.from({ length: 20 }, (_, i) => `v${i}`);
    expect((await decide('y', 'interactive-question', twenty)).decisions).toHaveLength(2);
  });

  it('requires the target of a decision point or open question to exist', async () => {
    await expect(decide('nope', 'decision-point', ['lru'])).rejects.toThrow(/no decision point/);
    await expect(decide('nope', 'open-question', ['x'])).rejects.toThrow(/no open question/);
    await expect(decide('q1', 'decision-point', ['lru'])).rejects.toThrow(/no decision point/);
    await expect(decide('dp1', 'open-question', ['small'])).rejects.toThrow(/no open question/);
  });

  it('requires exactly one option id for a decision point', async () => {
    await expect(decide('dp1', 'decision-point', ['lru', 'ttl'])).rejects.toThrow(/exactly one/);
    await expect(decide('dp1', 'decision-point', ['other'])).rejects.toThrow(/not an option/);
  });

  it('requires exactly one option id for a single question', async () => {
    await expect(decide('q1', 'open-question', ['small', 'large'])).rejects.toThrow(/exactly one/);
    await expect(decide('q1', 'open-question', ['medium'])).rejects.toThrow(/not an option/);
    expect((await decide('q1', 'open-question', ['large'])).decisions[0]?.values).toEqual([
      'large',
    ]);
  });

  it('accepts option ids and free text for a multi question', async () => {
    const updated = await decide('q2', 'open-question', ['api', 'ui', 'something else']);
    expect(updated.decisions[0]?.values).toEqual(['api', 'ui', 'something else']);
  });

  it('requires exactly one value for a text question', async () => {
    await expect(decide('q3', 'open-question', ['a', 'b'])).rejects.toThrow(/exactly one/);
    expect((await decide('q3', 'open-question', ['anything'])).decisions[0]?.values).toEqual([
      'anything',
    ]);
  });

  it('accepts any target for an interactive question, but not an empty or huge one', async () => {
    const updated = await decide('Which database?', 'interactive-question', ['a', 'b']);
    expect(updated.decisions[0]?.targetId).toBe('Which database?');
    await expect(decide('', 'interactive-question', ['a'])).rejects.toThrow(/1 to 1000/);
    await expect(decide('x'.repeat(1001), 'interactive-question', ['a'])).rejects.toThrow(
      /1 to 1000/,
    );
  });

  it('judges against the latest version', async () => {
    await store.submit({
      conversationId: CONVERSATION,
      planId: plan.id,
      raw: minimalInput('No questions now'),
    });
    await expect(decide('dp1', 'decision-point', ['lru'])).rejects.toThrow(/no decision point/);
  });

  it('leaves the stored plan unchanged on rejection', async () => {
    await expect(decide('dp1', 'decision-point', ['bad'])).rejects.toThrow();
    expect((await store.get(plan.id))?.decisions).toEqual([]);
  });
});
