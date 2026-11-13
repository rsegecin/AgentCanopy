import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationId, PlanDoc, PlanId, TurnId } from '../../shared';
import { createPlanStore } from './index';
import type { PlanStore } from './index';
import { silentLogger, type Logger } from '../contracts/ports';
import { CONVERSATION, fakeClock, makeTempDir, maximalInput, minimalInput } from './test-support';

let dir: string;
let clock: ReturnType<typeof fakeClock>;
let store: PlanStore;
beforeEach(async () => {
  dir = await makeTempDir();
  clock = fakeClock();
  store = createPlanStore({ dir, clock });
  await store.init();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function create(raw: unknown = minimalInput()): Promise<PlanDoc> {
  const result = await store.submit({ conversationId: CONVERSATION, raw });
  if (!result.ok) throw new Error(result.message);
  return result.plan;
}

const MISSING = 'missing' as PlanId;

describe('storage', () => {
  it('persists across instances', async () => {
    const plan = await create(maximalInput());
    const other = createPlanStore({ dir, clock });
    await other.init();
    expect(await other.get(plan.id)).toEqual(plan);
  });

  it('writes one file per plan', async () => {
    const a = await create();
    const b = await create();
    expect((await fs.readdir(dir)).sort()).toEqual([`${a.id}.json`, `${b.id}.json`].sort());
  });

  it('returns undefined for a missing plan', async () => {
    expect(await store.get(MISSING)).toBeUndefined();
  });

  it('ignores an invalid file and logs it', async () => {
    const warnings: string[] = [];
    const logger: Logger = { ...silentLogger, warn: (message) => warnings.push(message) };
    const logged = createPlanStore({ dir, logger });
    await fs.writeFile(join(dir, 'bad.json'), '{"id":"bad"}');
    await fs.writeFile(join(dir, 'garbage.json'), 'not json');
    expect(await logged.get('bad' as PlanId)).toBeUndefined();
    expect(await logged.get('garbage' as PlanId)).toBeUndefined();
    expect(warnings).toHaveLength(2);
  });

  it('ignores a file whose id differs from its name', async () => {
    const plan = await create();
    await fs.copyFile(join(dir, `${plan.id}.json`), join(dir, 'other.json'));
    expect(await store.get('other' as PlanId)).toBeUndefined();
  });

  it('does not read outside its directory', async () => {
    expect(await store.get('../x' as PlanId)).toBeUndefined();
    await expect(store.revert('../x' as PlanId, 1)).rejects.toThrow(/Unknown plan/);
    await store.delete('../x' as PlanId);
  });

  it('keeps every update from 30 concurrent submissions', async () => {
    const first = await create(minimalInput('first'));
    const results = await Promise.all(
      Array.from({ length: 29 }, (_, i) =>
        store.submit({
          conversationId: CONVERSATION,
          planId: first.id,
          raw: minimalInput(`plan ${i}`),
        }),
      ),
    );
    expect(results.every((r) => r.ok && !r.unchanged)).toBe(true);
    const plan = await store.get(first.id);
    expect(plan?.versions.map((v) => v.version)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
    expect(new Set(plan?.versions.map((v) => v.contentHash)).size).toBe(30);
    const versions = results.map((r) => (r.ok ? r.version : 0)).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 29 }, (_, i) => i + 2));
  });

  it('serialises mixed concurrent writes to one plan', async () => {
    const plan = await create(maximalInput());
    await Promise.all([
      store.decide(plan.id, { targetId: 'dp1', kind: 'decision-point', values: ['lru'] }),
      store.submit({
        conversationId: CONVERSATION,
        planId: plan.id,
        raw: { ...maximalInput(), title: 'B' },
      }),
      store.decide(plan.id, { targetId: 'q3', kind: 'open-question', values: ['x'] }),
      store.revert(plan.id, 1),
    ]);
    const after = await store.get(plan.id);
    expect(after?.versions).toHaveLength(3);
    expect(after?.decisions).toHaveLength(2);
  });
});

describe('revert', () => {
  it('appends a copy authored by the user', async () => {
    const first = await create(minimalInput('A'));
    await store.submit({ conversationId: CONVERSATION, planId: first.id, raw: minimalInput('B') });
    clock.advance(10);
    const plan = await store.revert(first.id, 1);
    expect(plan.versions).toHaveLength(3);
    const [one, , three] = plan.versions;
    expect(three).toMatchObject({ version: 3, author: 'user', restoredFrom: 1, createdAt: 1_010 });
    expect(three?.content).toEqual(one?.content);
    expect(three?.contentHash).toBe(one?.contentHash);
    expect(await store.get(first.id)).toEqual(plan);
  });

  it('rejects an unknown version or plan', async () => {
    const plan = await create();
    await expect(store.revert(plan.id, 9)).rejects.toThrow(/no version 9/);
    await expect(store.revert(MISSING, 1)).rejects.toThrow(/Unknown plan/);
  });

  it('a later submission of the reverted content is unchanged', async () => {
    const first = await create(minimalInput('A'));
    await store.submit({ conversationId: CONVERSATION, planId: first.id, raw: minimalInput('B') });
    await store.revert(first.id, 1);
    const again = await store.submit({
      conversationId: CONVERSATION,
      planId: first.id,
      raw: minimalInput('A'),
    });
    expect(again.ok && again.unchanged).toBe(true);
  });
});

describe('approve', () => {
  it('records an approval and persists it', async () => {
    const plan = await create();
    const hash = plan.versions[0]!.contentHash;
    clock.advance(5);
    const result = await store.approve(plan.id, 1, hash);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.approvals).toEqual([{ version: 1, contentHash: hash, approvedAt: 1_005 }]);
    const other = createPlanStore({ dir });
    expect((await other.get(plan.id))?.approvals).toEqual(result.plan.approvals);
  });

  it('reports an unknown plan, an unknown version and a hash mismatch', async () => {
    const plan = await create();
    const hash = plan.versions[0]!.contentHash;
    expect(await store.approve(MISSING, 1, hash)).toEqual({ ok: false, reason: 'unknown-plan' });
    expect(await store.approve(plan.id, 2, hash)).toEqual({ ok: false, reason: 'unknown-version' });
    expect(await store.approve(plan.id, 1, 'wrong')).toEqual({
      ok: false,
      reason: 'hash-mismatch',
    });
    expect((await store.get(plan.id))?.approvals).toEqual([]);
  });
});

describe('setExecutionTurn', () => {
  it('links the latest approval of the version', async () => {
    const plan = await create();
    const hash = plan.versions[0]!.contentHash;
    await store.approve(plan.id, 1, hash);
    await store.approve(plan.id, 1, hash);
    const updated = await store.setExecutionTurn(plan.id, 1, 't1' as TurnId);
    expect(updated.approvals[0]?.executionTurnId).toBeUndefined();
    expect(updated.approvals[1]?.executionTurnId).toBe('t1');
    expect((await store.get(plan.id))?.approvals[1]?.executionTurnId).toBe('t1');
  });

  it('rejects a version without approval and an unknown plan', async () => {
    const plan = await create();
    await expect(store.setExecutionTurn(plan.id, 1, 't1' as TurnId)).rejects.toThrow(/no approval/);
    await expect(store.setExecutionTurn(MISSING, 1, 't1' as TurnId)).rejects.toThrow(
      /Unknown plan/,
    );
  });
});

describe('copy', () => {
  it('copies versions and decisions under a new id without approvals', async () => {
    const plan = await create(maximalInput());
    await store.decide(plan.id, { targetId: 'dp1', kind: 'decision-point', values: ['ttl'] });
    await store.approve(plan.id, 1, plan.versions[0]!.contentHash);
    const before = await store.get(plan.id);
    clock.advance(7);
    const target = 'conv-2' as ConversationId;
    const copy = await store.copy(plan.id, target);
    expect(copy).toBeDefined();
    expect(copy!.id).not.toBe(plan.id);
    expect(copy!.conversationId).toBe(target);
    expect(copy!.createdAt).toBe(1_007);
    expect(copy!.approvals).toEqual([]);
    expect(copy!.versions).toEqual(before!.versions);
    expect(copy!.decisions).toEqual(before!.decisions);
    expect(await store.get(copy!.id)).toEqual(copy);
    expect(await store.get(plan.id)).toEqual(before);
  });

  it('returns undefined for an unknown plan', async () => {
    expect(await store.copy(MISSING, CONVERSATION)).toBeUndefined();
  });

  it('can stop at an earlier version, leaving out later versions and their decisions', async () => {
    const plan = await create(maximalInput());
    await store.decide(plan.id, { targetId: 'dp1', kind: 'decision-point', values: ['ttl'] });
    const second = await store.submit({
      conversationId: CONVERSATION,
      planId: plan.id,
      raw: { ...maximalInput(), objective: 'A changed objective' },
    });
    expect(second.ok && second.version).toBe(2);
    await store.decide(plan.id, {
      targetId: 'q1',
      kind: 'interactive-question',
      values: ['later'],
    });

    const copy = await store.copy(plan.id, 'conv-3' as ConversationId, { upToVersion: 1 });
    expect(copy!.versions.map((v) => v.version)).toEqual([1]);
    expect(copy!.decisions.map((d) => d.targetId)).toEqual(['dp1']);
    expect(
      await store.copy(plan.id, 'conv-4' as ConversationId, { upToVersion: 0 }),
    ).toBeUndefined();
  });
});

describe('copy up to a time', () => {
  async function timedPlan(): Promise<PlanDoc> {
    const timed = fakeClock(10);
    const timedStore = createPlanStore({ dir, clock: timed });
    store = timedStore;
    const first = await create(maximalInput());
    timed.advance(5);
    await timedStore.decide(first.id, { targetId: 'dp1', kind: 'decision-point', values: ['ttl'] });
    timed.advance(5);
    await timedStore.submit({
      conversationId: CONVERSATION,
      planId: first.id,
      raw: { ...maximalInput(), objective: 'Second objective' },
    });
    timed.advance(5);
    await timedStore.decide(first.id, { targetId: 'q1', kind: 'open-question', values: ['small'] });
    timed.advance(5);
    await timedStore.submit({
      conversationId: CONVERSATION,
      planId: first.id,
      raw: { ...maximalInput(), objective: 'Third objective' },
    });
    const plan = await timedStore.get(first.id);
    expect(plan!.versions.map((v) => v.createdAt)).toEqual([10, 20, 30]);
    expect(plan!.decisions.map((d) => d.decidedAt)).toEqual([15, 25]);
    return plan!;
  }

  it('keeps the versions and decisions made at or before the time', async () => {
    const plan = await timedPlan();
    const copy = await store.copy(plan.id, 'conv-5' as ConversationId, { upToTime: 22 });
    expect(copy!.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(copy!.decisions.map((d) => d.targetId)).toEqual(['dp1']);
    const exact = await store.copy(plan.id, 'conv-6' as ConversationId, { upToTime: 20 });
    expect(exact!.versions.map((v) => v.version)).toEqual([1, 2]);
    const onDecision = await store.copy(plan.id, 'conv-7' as ConversationId, { upToTime: 25 });
    expect(onDecision!.decisions.map((d) => d.targetId)).toEqual(['dp1', 'q1']);
  });

  it('returns undefined when no version is that old', async () => {
    const plan = await timedPlan();
    expect(await store.copy(plan.id, 'conv-5' as ConversationId, { upToTime: 5 })).toBeUndefined();
  });

  it('copies everything without an option', async () => {
    const plan = await timedPlan();
    const copy = await store.copy(plan.id, 'conv-5' as ConversationId);
    expect(copy!.versions).toEqual(plan.versions);
    expect(copy!.decisions).toEqual(plan.decisions);
  });

  it('applies both limits when both are given', async () => {
    const plan = await timedPlan();
    const copy = await store.copy(plan.id, 'conv-5' as ConversationId, {
      upToVersion: 1,
      upToTime: 22,
    });
    expect(copy!.versions.map((v) => v.version)).toEqual([1]);
    expect(copy!.decisions.map((d) => d.targetId)).toEqual(['dp1']);
    const byTime = await store.copy(plan.id, 'conv-6' as ConversationId, {
      upToVersion: 3,
      upToTime: 12,
    });
    expect(byTime!.versions.map((v) => v.version)).toEqual([1]);
    expect(byTime!.decisions).toEqual([]);
  });
});

describe('delete', () => {
  it('removes the plan and ignores an unknown one', async () => {
    const plan = await create();
    await store.delete(plan.id);
    expect(await store.get(plan.id)).toBeUndefined();
    expect(await fs.readdir(dir)).toEqual([]);
    await store.delete(plan.id);
    await store.delete(MISSING);
  });
});
