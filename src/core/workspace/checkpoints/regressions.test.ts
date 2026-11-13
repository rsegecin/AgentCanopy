import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationId, RestorePreview } from '../../../shared';
import { DEFAULT_SETTINGS } from '../../../shared';
import { collectGarbage } from '../store';
import { FakeClock, recordsOf, sha } from '../tracker/test-support';
import { p } from '../review/test-helpers';
import { makeCheckpointHarness, type CheckpointHarness } from './test-helpers';

/**
 * Sequences that independent reviewers proved could lose or mislabel the user's work. Each asserts
 * the correct behaviour.
 */

const DAY = 24 * 60 * 60 * 1000;
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

let clock: FakeClock;
let h: CheckpointHarness;
beforeEach(async () => {
  clock = new FakeClock(Date.now());
  h = await makeCheckpointHarness({ clock });
});
afterEach(async () => {
  await h.cleanup();
});

async function preview(opId: OperationId): Promise<RestorePreview> {
  const result = await h.svc.preview(h.key, opId);
  if (!('token' in result)) throw new Error(`refused: ${result.refused}`);
  return result;
}
const defaults = (prev: RestorePreview): string[] =>
  prev.items.filter((i) => i.selectedByDefault).map((i) => i.path);
const newest = async (): Promise<OperationId> => (await h.svc.list(h.key))[0]!.operationId;
const restoreOf = (prev: RestorePreview, paths: string[]) =>
  h.svc.restore(h.key, prev.targetOperationId, prev.token, paths.map(p));
async function restoreDefaults(prev: RestorePreview) {
  const result = await restoreOf(prev, defaults(prev));
  if ('refused' in result) throw new Error(`refused: ${result.refused}`);
  return result;
}
async function gc(): Promise<void> {
  await h.ws.exclusive(async () => {
    await collectGarbage(h.ws.blobs, await h.engine.referencedHashes(h.key));
  });
}

/** Makes the next appends that change something fail, like a full disk. */
function failAppends(
  match: (record: Parameters<typeof h.ws.appendRecord>[0]) => boolean,
): () => void {
  const real = h.ws.appendRecord.bind(h.ws);
  h.ws.appendRecord = async (record) => {
    if (match(record)) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
    await real(record);
  };
  return () => {
    h.ws.appendRecord = real;
  };
}

describe('F6: the replaced content is referenced before anything is written', () => {
  it('a restore that cannot write its record leaves the user version retrievable', async () => {
    await h.env.write({ 'a.txt': 'x\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'agent\n'));
    const k = await newest();
    const USER = 'agent\nUSER WORK NEVER SYNCED\n';
    await h.env.write({ 'a.txt': USER });
    const prev = await preview(k);
    expect(prev.items.map((i) => [i.path, i.conflict, i.selectedByDefault])).toEqual([
      ['a.txt', 'changed-since', false],
    ]);
    // The log cannot take the restore record (the safety record is a different one).
    const stop = failAppends(
      (r) => r.type === 'operation' && r.kind === 'restore' && r.changes.length > 0,
    );
    const result = await restoreOf(prev, ['a.txt']);
    stop();
    expect('refused' in result && result.refused).toContain('could not finish');
    expect(await h.read('a.txt')).toBe('x\n');

    await h.turn((t) => t.edit('other.txt', 'o\n'));
    await gc();
    expect(await h.ws.blobs.has(sha(USER))).toBe(true);
    expect((await h.engine.referencedHashes(h.key)).has(sha(USER))).toBe(true);
  });

  it('the safety record is no checkpoint and changes nothing in review', async () => {
    await h.env.write({ 'a.txt': 'x\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'agent\n'));
    const k = await newest();
    await h.env.write({ 'a.txt': 'agent\nmine\n' });
    const entries = await h.entries();
    const listed = await h.svc.list(h.key);
    const prev = await preview(k);
    const stop = failAppends((r) => r.type === 'operation' && r.changes.length > 0);
    await restoreOf(prev, ['a.txt']);
    stop();
    const records = recordsOf(h.ws);
    const safety = records.at(-1)!;
    expect(safety).toMatchObject({ type: 'operation', kind: 'restore', changes: [] });
    expect(safety.type === 'operation' && safety.preserved.map((s) => s.path)).toEqual(['a.txt']);
    expect(await h.svc.list(h.key)).toEqual(listed);
    expect(await h.engine.entries(h.key)).toEqual(entries);
    expect(await h.newEngine().entries(h.key)).toEqual(entries);
  });

  it('a rejection in agent-only or overwrite mode preserves what it replaces first', async () => {
    const base = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8');
    await h.env.write({ 'a.txt': base, 'b.txt': base });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', base.replace('l2', 'AGENT2'));
      await t.edit('b.txt', base.replace('l2', 'AGENT2'));
    });
    const mineA = base.replace('l2', 'AGENT2').replace('l7', 'MINE7');
    const mineB = base.replace('l2', 'AGENT2').replace('l6', 'MINE6');
    await h.env.write({ 'a.txt': mineA, 'b.txt': mineB });

    const stop = failAppends(
      (r) => r.type === 'operation' && r.kind === 'reject' && r.changes.length > 0,
    );
    expect((await h.engine.rejectFile(h.key, p('a.txt'), 'agent-only')).status).toBe('refused');
    expect((await h.engine.rejectFile(h.key, p('b.txt'), 'overwrite')).status).toBe('refused');
    stop();
    await gc();
    for (const mine of [mineA, mineB]) expect(await h.ws.blobs.has(sha(mine))).toBe(true);
    expect(await h.read('b.txt')).toBe(base);
  });

  it('a rejection whose preserving record cannot be written writes nothing', async () => {
    const base = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8');
    await h.env.write({ 'a.txt': base });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', base.replace('l2', 'AGENT2')));
    const mine = base.replace('l2', 'AGENT2').replace('l7', 'MINE7');
    await h.env.write({ 'a.txt': mine });
    const stop = failAppends((r) => r.type === 'operation' && r.changes.length === 0);
    const result = await h.engine.rejectFile(h.key, p('a.txt'), 'agent-only');
    stop();
    expect(result.status).toBe('refused');
    expect(await h.read('a.txt')).toBe(mine);
    const records = recordsOf(h.ws);
    expect(records.filter((r) => r.type === 'operation' && r.kind === 'reject')).toEqual([]);
  });
});

describe('F1, F2, F22: a hand edit no record mentions is not restored over by default', () => {
  it('F1: an edit kept by "undo only the agent\'s changes"', async () => {
    const X = text('line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8');
    await h.env.write({ 'a.txt': X, 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', X.replace('line 2', 'line 2 AGENT'));
      await t.edit('b.txt', 'b1\n');
    });
    const k = await newest();
    await h.env.write({
      'a.txt': X.replace('line 2', 'line 2 AGENT').replace('line 7', 'line 7 USER WORK'),
    });
    expect((await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).status).toBe('conflict');
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'agent-only')).toEqual({ status: 'done' });
    const mine = X.replace('line 7', 'line 7 USER WORK');
    expect(await h.read('a.txt')).toBe(mine);

    const prev = await preview(k);
    expect(prev.items.find((i) => i.path === 'a.txt')).toMatchObject({
      conflict: 'user-edit-between',
      selectedByDefault: false,
      selectable: true,
    });
    expect(prev.items.find((i) => i.path === 'b.txt')?.selectedByDefault).toBe(true);
    await restoreDefaults(prev);
    expect(await h.read('a.txt')).toBe(mine);
    expect(await h.read('b.txt')).toBe('b0\n');
  });

  it('F1b: the same content is warned about every time, not just the first', async () => {
    await h.env.write({ 'a.txt': 'x\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'agent\n'));
    const k = await newest();
    await h.env.write({ 'a.txt': 'agent\nUSER WORK\n' });
    const first = await preview(k);
    expect(first.items[0]).toMatchObject({ conflict: 'changed-since', selectedByDefault: false });
    await restoreOf(first, ['a.txt']);
    const undo = await preview(await newest());
    await restoreDefaults(undo);
    expect(await h.read('a.txt')).toBe('agent\nUSER WORK\n');
    const second = await preview(k);
    expect(second.items[0]).toMatchObject({
      conflict: 'user-edit-between',
      selectedByDefault: false,
    });
  });

  it('F2: a hand edit to a file the tracker does not scan, between two agent edits', async () => {
    const X = text('a=1', 'b=2', 'c=3', 'd=4', 'e=5', 'f=6', 'g=7');
    await h.env.write({ '.gitignore': 'local.cfg\n', 'local.cfg': X });
    await h.sync();
    const afterK = X.replace('a=1', 'a=AGENT1');
    await h.turn((t) => t.edit('local.cfg', afterK));
    const k = await newest();
    const withUser = afterK.replace('g=7', 'g=USER WORK');
    await h.env.write({ 'local.cfg': withUser });
    await h.turn((t) => t.edit('local.cfg', withUser.replace('d=4', 'd=AGENT2')));
    expect(recordsOf(h.ws).map((r) => r.type)).toEqual(['operation', 'operation']);
    const prev = await preview(k);
    expect(prev.items.find((i) => i.path === 'local.cfg')).toMatchObject({
      conflict: 'user-edit-between',
      selectedByDefault: false,
    });
    await restoreDefaults(prev);
    expect(await h.read('local.cfg')).toContain('USER WORK');
  });
});

describe("F3: a save that lands while AgentCanopy writes is not the agent's", () => {
  it('a restore records it as external, so the next default restore leaves it alone', async () => {
    await h.env.write({ 'a.txt': 'x\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'agent\n'));
    const k = await newest();
    h.hooks.afterRename = async () => {
      await fs.writeFile(h.env.abs('a.txt'), 'USER SAVED THIS\n');
    };
    const first = await preview(k);
    const result = await restoreOf(first, ['a.txt']);
    h.hooks.afterRename = undefined;
    expect(result).toMatchObject({ items: [{ path: 'a.txt', achieved: false }] });
    expect(await h.read('a.txt')).toBe('USER SAVED THIS\n');
    const last = recordsOf(h.ws).at(-1)!;
    expect(last.type === 'operation' && last.changes.map((c) => c.attribution)).toEqual([
      'external',
    ]);

    const second = await preview(k);
    expect(second.items[0]).toMatchObject({
      conflict: 'user-edit-between',
      selectedByDefault: false,
    });
    await restoreDefaults(second);
    expect(await h.read('a.txt')).toBe('USER SAVED THIS\n');
  });

  it('a reject records it as external too', async () => {
    await h.env.write({ 'a.txt': 'x\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'agent\n'));
    const k = await newest();
    h.hooks.afterRename = async () => {
      await fs.writeFile(h.env.abs('a.txt'), 'USER SAVED THIS\n');
    };
    expect((await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).status).toBe('refused');
    h.hooks.afterRename = undefined;
    const last = recordsOf(h.ws).at(-1)!;
    expect(last).toMatchObject({ kind: 'reject' });
    expect(last.type === 'operation' && last.changes.map((c) => c.attribution)).toEqual([
      'external',
    ]);
    const prev = await preview(k);
    expect(prev.items.find((i) => i.path === 'a.txt')).toMatchObject({
      conflict: 'user-edit-between',
      selectedByDefault: false,
    });
  });
});

describe('F4 and F5: deletions and writes that wait for each other', () => {
  it('F4a: a case-only rename comes back under the original name with one default restore', async () => {
    await h.env.write({ 'README.md': 'the user wrote this\n' });
    await h.sync();
    await h.turn((t) => t.command(() => fs.rename(h.env.abs('README.md'), h.env.abs('Readme.md'))));
    if (!(await fs.readdir(h.env.root)).includes('Readme.md')) return; // a volume that tells cases apart
    const k = await newest();
    const prev = await preview(k);
    expect(
      prev.items.map((i) => [i.path, i.action, i.conflict ?? null, i.selectedByDefault]),
    ).toEqual([
      ['README.md', 'write', null, true],
      ['Readme.md', 'delete', null, true],
    ]);
    // One without the other is refused.
    expect(await restoreOf(prev, ['Readme.md'])).toEqual({
      refused: 'Readme.md and README.md have to be restored together.',
    });
    expect(await restoreOf(prev, ['README.md'])).toEqual({
      refused: 'README.md and Readme.md have to be restored together.',
    });
    expect(await fs.readdir(h.env.root)).toEqual(['Readme.md']);
    await restoreDefaults(prev);
    expect(await fs.readdir(h.env.root)).toEqual(['README.md']);
    expect(await h.read('README.md')).toBe('the user wrote this\n');
  });

  it('F4b: a folder replaced by a file comes back with its files', async () => {
    await h.env.write({ 'd/x.txt': 'x\n', 'd/y.txt': 'y\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d'), { recursive: true });
        await fs.writeFile(h.env.abs('d'), 'now a file\n');
      }),
    );
    const k = await newest();
    const prev = await preview(k);
    expect(
      prev.items.map((i) => [i.path, i.action, i.conflict ?? null, i.selectedByDefault]),
    ).toEqual([
      ['d', 'delete', null, true],
      ['d/x.txt', 'write', null, true],
      ['d/y.txt', 'write', null, true],
    ]);
    expect(
      String(await restoreOf(prev, ['d']).then((r) => ('refused' in r ? r.refused : ''))),
    ).toContain('have to be restored together');
    await restoreDefaults(prev);
    expect(Object.keys(await h.listing()).sort()).toEqual(['d/', 'd/x.txt', 'd/y.txt']);
    expect(await h.read('d/x.txt')).toBe('x\n');
  });

  it('items that wait for each other get the answer of the heaviest of them', async () => {
    await h.env.write({ 'd/x.txt': 'x\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d'), { recursive: true });
        await fs.writeFile(h.env.abs('d'), 'now a file\n');
      }),
    );
    // The user edited the file that took the folder's place, and nothing has recorded it.
    await h.env.write({ d: 'now a file, edited by the user\n' });
    const prev = await preview(await newest());
    expect(prev.items.map((i) => [i.path, i.conflict ?? null, i.selectedByDefault])).toEqual([
      ['d', 'changed-since', false],
      ['d/x.txt', 'changed-since', false],
    ]);
    expect(defaults(prev)).toEqual([]);
  });

  it('F5: a file the agent replaced by a folder comes back, the empty folder removed', async () => {
    await h.env.write({ d: 'a file\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d'));
        await fs.mkdir(h.env.abs('d'));
        await fs.writeFile(h.env.abs('d/x.txt'), 'x\n');
      }),
    );
    const prev = await preview(await newest());
    expect(
      prev.items.map((i) => [i.path, i.action, i.conflict ?? null, i.selectedByDefault]),
    ).toEqual([
      ['d', 'write', null, true],
      ['d/x.txt', 'delete', null, true],
    ]);
    await restoreDefaults(prev);
    expect(Object.keys(await h.listing())).toEqual(['d']);
    expect(await h.read('d')).toBe('a file\n');
    expect(await h.read('d')).toBe('a file\n');
  });

  it('F5: a folder that holds something else stays, and the file is blocked', async () => {
    await h.env.write({ d: 'a file\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d'));
        await fs.mkdir(h.env.abs('d'));
        await fs.writeFile(h.env.abs('d/x.txt'), 'x\n');
      }),
    );
    await h.env.write({ 'd/mine.txt': 'the user put this here\n' });
    const prev = await preview(await newest());
    expect(prev.items.find((i) => i.path === 'd')).toMatchObject({
      conflict: 'blocked-path',
      selectable: false,
    });
    await restoreDefaults(prev);
    expect(await h.read('d/mine.txt')).toBe('the user put this here\n');
  });
});

describe('F7, F8 and the fold: a restore puts review entries back exactly', () => {
  const X0 = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8');

  it('F7: restoring to before a later turn undoes a reject of an earlier one, with its entry', async () => {
    await h.env.write({ 'a.txt': 'x\n', 'b.txt': 'b\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'AGENT CODE\n'));
    await h.turn((t) => t.edit('b.txt', 'b1\n'));
    const k = await newest();
    expect((await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).status).toBe('done');
    await restoreDefaults(await preview(k));
    expect(await h.read('a.txt')).toBe('AGENT CODE\n');
    const entry = await h.entry('a.txt');
    expect(entry).toMatchObject({ status: 'pending', attribution: 'agent-tool' });
    expect(entry?.baseline).toMatchObject({ hash: sha('x\n') });
    // The second turn's entry is gone.
    expect(await h.entry('b.txt')).toBeUndefined();
    expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
  });

  it('F8: the baseline goes back to its value before the user edit the restore discarded', async () => {
    await h.env.write({ 'a.txt': X0 });
    await h.sync();
    const X1 = X0.replace('l2', 'l2 AGENT J');
    await h.turn((t) => t.edit('a.txt', X1));
    const X2 = X1.replace('l4', 'l4 AGENT K');
    await h.turn((t) => t.edit('a.txt', X2));
    const k = await newest();
    await h.userEdit({ 'a.txt': X2.replace('l7', 'l7 USER') });
    const prev = await preview(k);
    expect(prev.items[0]).toMatchObject({ conflict: 'user-edit-between' });
    await restoreOf(prev, ['a.txt']);
    expect(await h.read('a.txt')).toBe(X1);
    const entry = await h.entry('a.txt');
    expect(entry).toMatchObject({ includesUserEdits: false, status: 'pending' });
    expect(entry?.baseline).toMatchObject({ hash: sha(X0) });
    expect(entry?.current).toMatchObject({ hash: sha(X1) });
    expect(entry?.operationIds).toHaveLength(1);
    // A reject now puts back exactly what was there before the agent.
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({ status: 'done' });
    expect(await h.read('a.txt')).toBe(X0);
  });

  it('restoring to before a turn leaves earlier pending entries with their earlier baselines', async () => {
    await h.env.write({ 'a.txt': X0, 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', X0.replace('l2', 'J')));
    const afterJ = await h.entry('a.txt');
    await h.turn(async (t) => {
      await t.edit('a.txt', X0.replace('l2', 'J').replace('l5', 'K'));
      await t.edit('b.txt', 'b1\n');
    });
    await restoreDefaults(await preview(await newest()));
    expect(await h.entry('a.txt')).toEqual(afterJ);
    expect(await h.entry('b.txt')).toBeUndefined();
  });

  it('restoring to before a restore re-opens the entries it closed, as they were', async () => {
    await h.env.write({ 'a.txt': X0, 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', X0.replace('l2', 'J'));
      await t.command(async () => {
        await fs.writeFile(h.env.abs('b.txt'), 'b1\n');
      });
    });
    const before = await h.entries();
    expect(before.map((e) => e.attribution)).toEqual(['agent-tool', 'agent-command']);
    const done = await restoreDefaults(await preview(await newest()));
    expect(await h.entries()).toEqual([]);
    await restoreDefaults(await preview(done.operationId!));
    expect(await h.entries()).toEqual(before);
    expect(await h.newEngine().entries(h.key)).toEqual(before);
  });

  it('restoring to before a reject re-opens the rejected entry', async () => {
    await h.env.write({ 'a.txt': 'x\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'agent\n'));
    const before = await h.entries();
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({ status: 'done' });
    expect(await h.entries()).toEqual([]);
    const reject = await newest();
    await restoreDefaults(await preview(reject));
    expect(await h.read('a.txt')).toBe('agent\n');
    expect(await h.entries()).toEqual(before);
  });

  it('a restore never creates an entry for a path that had none', async () => {
    await h.env.write({ 'a.txt': 'x\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'one\n'));
    await h.engine.acceptFile(h.key, p('a.txt'));
    await h.turn((t) => t.edit('a.txt', 'two\n'));
    await h.engine.acceptFile(h.key, p('a.txt'));
    await h.turn((t) => t.edit('other.txt', 'o\n', 'Write'));
    // Restore to before the second turn: a.txt goes back to "one", which was accepted.
    const list = await h.svc.list(h.key);
    await restoreDefaults(await preview(list[1]!.operationId));
    expect(await h.read('a.txt')).toBe('one\n');
    expect(await h.entry('a.txt')).toBeUndefined();
    expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
  });
});

describe('retention: F18 and F19', () => {
  const policy = { ...DEFAULT_SETTINGS, retentionOperations: 6, retentionDays: 3 };

  async function routine(i: number): Promise<void> {
    clock.advance(2 * DAY);
    await h.turn((t) => t.edit('f.txt', `f ${i}\n`));
    await h.engine.acceptFile(h.key, p('f.txt'));
  }

  it('F18: a cut that would change the review state moves back instead of stopping retention', async () => {
    await h.env.write({ 'f.txt': 'f 0\n', 'q.txt': 'q 0\n' });
    await h.sync();
    for (let i = 1; i <= 3; i += 1) await routine(i);
    clock.advance(2 * DAY);
    await h.turn((t) => t.edit('scratch.txt', 'scratch\n', 'Write'));
    clock.advance(2 * DAY);
    await h.turn(async (t) => {
      await t.command(() => fs.rm(h.env.abs('scratch.txt')));
      await t.edit('q.txt', 'q 1\n');
    });
    expect((await h.entries()).map((e) => `${e.path}:${e.status}`)).toEqual(['q.txt:pending']);
    for (let i = 4; i <= 12; i += 1) await routine(i);
    clock.advance(40 * DAY);

    const entries = await h.entries();
    const records = h.ws.log.records().length;
    const result = await h.svc.prune(h.key, policy);
    expect(result.removedRecords).toBeGreaterThan(0);
    expect(h.ws.log.records().length).toBe(records - result.removedRecords);
    expect(await h.entries()).toEqual(entries);
    expect(await h.newEngine().entries(h.key)).toEqual(entries);
    // The turn the pending entry is made of is still there.
    for (const entry of entries) {
      for (const id of entry.operationIds) {
        expect((await h.svc.list(h.key)).map((s) => s.operationId)).toContain(id);
      }
    }
  });

  it('F19: nothing after the last agent turn is dropped, so reverted files are still reported', async () => {
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'g.txt', 'h.txt'];
    for (const file of files) await h.env.write({ [file]: `${file} original\n` });
    await h.sync();
    await h.turn(async (t) => {
      for (const file of files) await t.edit(file, `${file} by the agent\n`);
    });
    for (const file of files) {
      expect(await h.engine.rejectFile(h.key, p(file), 'strict')).toEqual({ status: 'done' });
    }
    expect(await h.engine.revertedSinceLastTurn(h.key)).toEqual(files);
    clock.advance(2 * DAY);
    const pruned = await h.svc.prune(h.key, {
      ...DEFAULT_SETTINGS,
      retentionOperations: 5,
      retentionDays: 1,
    });
    expect(pruned.removedRecords).toBe(0);
    expect(await h.engine.revertedSinceLastTurn(h.key)).toEqual(files);
  });
});

describe('previews belong to the view that made them', () => {
  it('two previews of different operations are both valid until something changes', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    await h.turn((t) => t.edit('b.txt', 'b1\n'));
    const [second, first] = (await h.svc.list(h.key)).map((s) => s.operationId);
    const one = await preview(first!);
    const two = await preview(second!);
    expect(one.token).not.toBe(two.token);
    expect(await h.svc.itemTexts(h.key, first!, one.token, p('a.txt'))).toEqual({
      current: 'a1\n',
      target: 'a0\n',
    });
    expect(await h.svc.itemTexts(h.key, second!, two.token, p('b.txt'))).toEqual({
      current: 'b1\n',
      target: 'b0\n',
    });
    // A token is for its own operation.
    expect(await h.svc.restore(h.key, first!, two.token, [])).toEqual({
      refused: 'The preview is out of date. Open it again.',
    });
    // The first view acts although the second previewed after it.
    const outcome = await restoreOf(one, defaults(one));
    expect('refused' in outcome).toBe(false);
    expect(await h.read('b.txt')).toBe('b0\n');
    // Now the log moved on, so the other preview is out of date.
    expect(await restoreOf(two, defaults(two))).toEqual({
      refused: 'The preview is out of date. Open it again.',
    });
  });
});

describe('review service additions', () => {
  it('rejectAll with `only` leaves every other candidate alone and does not report it', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
      await t.edit('c.txt', 'c1\n');
    });
    const before = await h.listing();
    const result = await h.engine.rejectAll(h.key, [], [p('a.txt'), p('c.txt')]);
    expect(result).toEqual({ rejected: ['a.txt', 'c.txt'], failed: [] });
    const after = await h.listing();
    expect(after['b.txt']).toBe(before['b.txt']);
    expect(await h.read('a.txt')).toBe('a0\n');
    expect((await h.entries()).map((e) => e.path)).toEqual(['b.txt']);
    // Without `only` the rest goes.
    expect((await h.engine.rejectAll(h.key, [])).rejected).toEqual(['b.txt']);
  });

  it('changed() tells review listeners', () => {
    let calls = 0;
    h.engine.onDidChange(() => {
      calls += 1;
    });
    h.engine.changed(h.key);
    expect(calls).toBe(1);
  });
});
