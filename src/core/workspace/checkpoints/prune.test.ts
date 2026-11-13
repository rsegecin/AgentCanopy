import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RestorePreview, Settings } from '../../../shared';
import { DEFAULT_SETTINGS } from '../../../shared';
import { createReviewEngine } from '../review/engine';
import { p } from '../review/test-helpers';
import { openWorkspaceLog } from '../store';
import { FakeClock, openWorkspace } from '../tracker/test-support';
import { makeCheckpointHarness, type CheckpointHarness } from './test-helpers';
import { createCheckpointService } from './service';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

let clock: FakeClock;
let h: CheckpointHarness;
beforeEach(async () => {
  clock = new FakeClock(T0);
  h = await makeCheckpointHarness({ clock });
});
afterEach(async () => {
  await h.cleanup();
});

const settings = (over: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...over });

const FILES = ['f0.txt', 'f1.txt', 'f2.txt'];

/** Content of file `n` as the nth turn leaves it. */
const content = (turn: number): string => `version ${turn}\n`;

/**
 * Runs `count` turns, turn i editing file i % 3 and leaving it as `content(i)`, with the clock one day
 * apart. `states[i]` is what every file was before turn i. Everything is accepted after each turn
 * except the files named in `keep`.
 */
async function runTurns(
  count: number,
  options: { keep?: string[]; spacing?: number } = {},
): Promise<Record<string, string>[]> {
  const states: Record<string, string>[] = [];
  const current: Record<string, string> = {};
  for (const file of FILES) {
    current[file] = 'original\n';
    await h.env.write({ [file]: 'original\n' });
  }
  await h.sync();
  for (let i = 1; i <= count; i += 1) {
    clock.advance(options.spacing ?? DAY);
    states[i] = { ...current };
    const file = FILES[i % 3]!;
    await h.turn((t) => t.edit(file, content(i)));
    current[file] = content(i);
    for (const entry of await h.entries()) {
      if (entry.status === 'pending' && !(options.keep ?? []).includes(entry.path)) {
        await h.engine.acceptFile(h.key, entry.path);
      }
    }
  }
  return states;
}

function recordCount(): number {
  return h.ws.log.records().length;
}

describe('prune', () => {
  it('shrinks the log to the newest operations, and every kept checkpoint still restores', async () => {
    const states = await runTurns(12, { spacing: 2 * DAY });
    const entriesBefore = await h.entries();
    const listBefore = await h.svc.list(h.key);
    expect(listBefore).toHaveLength(12);
    const recordsBefore = recordCount();

    const result = await h.svc.prune(h.key, settings({ retentionOperations: 6, retentionDays: 3 }));
    expect(result.removedRecords).toBeGreaterThan(0);
    expect(recordCount()).toBe(recordsBefore - result.removedRecords);
    const list = await h.svc.list(h.key);
    expect(list.map((s) => s.operationId)).toEqual(
      listBefore.slice(0, 6).map((s) => s.operationId),
    );
    expect(await h.entries()).toEqual(entriesBefore);
    expect(await h.newEngine().entries(h.key)).toEqual(entriesBefore);

    // The oldest kept checkpoint is turn 7: restoring to before it gives the files as they were then.
    const oldest = list.at(-1)!.operationId;
    const preview = await h.svc.preview(h.key, oldest);
    if (!('token' in preview)) throw new Error('refused');
    const outcome = await h.svc.restore(
      h.key,
      preview.targetOperationId,
      preview.token,
      defaultsOf(preview).map(p),
    );
    expect('refused' in outcome).toBe(false);
    for (const file of FILES) expect(await h.read(file)).toBe(states[7]![file]);

    // A second prune finds nothing more to remove.
    expect(
      (await h.svc.prune(h.key, settings({ retentionOperations: 6, retentionDays: 3 })))
        .removedRecords,
    ).toBe(0);
  });

  it('writes a valid log, and a fresh tracker, review engine and service give the same list and entries', async () => {
    await runTurns(10, { spacing: 2 * DAY });
    const result = await h.svc.prune(h.key, settings({ retentionOperations: 6, retentionDays: 3 }));
    expect(result.removedRecords).toBeGreaterThan(0);
    const listBefore = await h.svc.list(h.key);
    const entriesBefore = await h.entries();
    const live = h.ws.log.records().length;

    // The file itself: every line a record, none lost, nothing left over.
    const file = join(h.env.storage, h.env.folder.key, 'log.jsonl');
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(live);
    const reopened = await openWorkspaceLog(file);
    expect(reopened.skipped).toBe(0);
    expect(reopened.records()).toEqual([...h.ws.log.records()]);
    expect(
      (await fs.readdir(join(h.env.storage, h.env.folder.key))).filter((n) => n.startsWith('.tmp')),
    ).toEqual([]);

    // A restart.
    await h.tracker.dispose();
    const tracker = h.env.tracker({ clock });
    const ws = await openWorkspace(tracker, h.env);
    const engine = createReviewEngine({
      tracker,
      editor: h.editor,
      settings: () => h.env.settings,
    });
    const svc = createCheckpointService({
      tracker,
      editor: h.editor,
      settings: () => h.env.settings,
      clock,
    });
    expect(await svc.list(h.key)).toEqual(listBefore);
    expect(await engine.entries(h.key)).toEqual(entriesBefore);
    expect(ws.log.records().length).toBe(live);
  });

  it('keeps everything a never-accepted first turn needs, then lets it go once it is rejected', async () => {
    await h.env.write({ 'keep.txt': 'keep0\n', 'f0.txt': 'o\n' });
    await h.sync();
    clock.advance(DAY);
    await h.turn((t) => t.edit('keep.txt', 'keep1\n'));
    for (let i = 2; i <= 10; i += 1) {
      clock.advance(2 * DAY);
      await h.turn((t) => t.edit('f0.txt', content(i)));
      await h.engine.acceptFile(h.key, p('f0.txt'));
    }
    const policy = settings({ retentionOperations: 6, retentionDays: 3 });
    expect((await h.svc.prune(h.key, policy)).removedRecords).toBe(0);
    expect(await h.svc.list(h.key)).toHaveLength(10);
    const pending = await h.entries();
    expect(pending.find((e) => e.path === 'keep.txt')?.status).toBe('pending');

    // Once the entry is gone nothing holds the old records.
    expect(await h.engine.rejectFile(h.key, p('keep.txt'), 'strict')).toEqual({ status: 'done' });
    const entries = await h.entries();
    const result = await h.svc.prune(h.key, policy);
    expect(result.removedRecords).toBeGreaterThan(0);
    expect(await h.entries()).toEqual(entries);
    expect(await h.newEngine().entries(h.key)).toEqual(entries);
  });

  it('keeps what is within retentionDays', async () => {
    await runTurns(8);
    // Now is half a day after the last turn; 6 days back reaches the turn from day 3.
    clock.advance(DAY / 2);
    const before = await h.svc.list(h.key);
    const result = await h.svc.prune(h.key, settings({ retentionOperations: 1, retentionDays: 6 }));
    expect(result.removedRecords).toBeGreaterThan(0);
    const after = await h.svc.list(h.key);
    expect(after).toHaveLength(6);
    expect(after.map((s) => s.operationId)).toEqual(before.slice(0, 6).map((s) => s.operationId));
  });

  it('never keeps fewer than the newest 5 operations', async () => {
    await runTurns(9);
    clock.advance(10 * DAY);
    const before = await h.svc.list(h.key);
    await h.svc.prune(h.key, settings({ retentionOperations: 1, retentionDays: 1 }));
    const after = await h.svc.list(h.key);
    expect(after).toHaveLength(5);
    expect(after.map((s) => s.operationId)).toEqual(before.slice(0, 5).map((s) => s.operationId));
    // With fewer than that, nothing goes.
    const small = await makeCheckpointHarness({ clock });
    try {
      await small.env.write({ 'a.txt': 'a0\n' });
      await small.sync();
      for (let i = 1; i <= 4; i += 1) await small.turn((t) => t.edit('a.txt', `a${i}\n`));
      clock.advance(100 * DAY);
      expect(
        (await small.svc.prune(small.key, settings({ retentionOperations: 1, retentionDays: 1 })))
          .removedRecords,
      ).toBe(0);
    } finally {
      await small.cleanup();
    }
  });

  it('keeps an operation that a kept restore went back to', async () => {
    await runTurns(8);
    const list = await h.svc.list(h.key);
    const first = list.at(-1)!.operationId;
    const preview = await h.svc.preview(h.key, first);
    if (!('token' in preview)) throw new Error('refused');
    await h.svc.restore(
      h.key,
      preview.targetOperationId,
      preview.token,
      defaultsOf(preview).map(p),
    );
    clock.advance(30 * DAY);
    const records = recordCount();
    const entries = await h.entries();
    const result = await h.svc.prune(h.key, settings({ retentionOperations: 6, retentionDays: 3 }));
    // The restore is kept, so the operation it went back to is kept with it: nothing can go.
    expect(result.removedRecords).toBe(0);
    expect(recordCount()).toBe(records);
    expect(await h.newEngine().entries(h.key)).toEqual(entries);
    expect((await h.svc.list(h.key)).map((s) => s.operationId)).toContain(first);
  });

  it('does nothing without a folder, and tells listeners when it removed something', async () => {
    expect(await h.svc.prune('nope' as never, DEFAULT_SETTINGS)).toEqual({ removedRecords: 0 });
    await runTurns(9, { spacing: 2 * DAY });
    let calls = 0;
    h.svc.onDidChange(() => {
      calls += 1;
    });
    await h.svc.prune(h.key, settings({ retentionOperations: 6, retentionDays: 3 }));
    expect(calls).toBe(1);
    await h.svc.prune(h.key, settings({ retentionOperations: 6, retentionDays: 3 }));
    expect(calls).toBe(1);
  });
});

function defaultsOf(prev: RestorePreview): string[] {
  return prev.items.filter((i) => i.selectedByDefault).map((i) => i.path);
}
