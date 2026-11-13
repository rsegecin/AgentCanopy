import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationId } from '../../../shared';
import { DEFAULT_SETTINGS } from '../../../shared';
import { p } from '../review/test-helpers';
import { FakeClock } from '../tracker/test-support';
import { makeCheckpointHarness, type CheckpointHarness } from './test-helpers';

/** Seeded generator, so that a failing run can be repeated from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 24 * 60 * 60 * 1000;
const FILES = ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt'];
const MARKER = '// USER-MARKER-';
const isMarker = (line: string): boolean => line.startsWith(MARKER);
const original = (file: string): string =>
  `${Array.from({ length: 10 }, (_, i) => `${file} line ${i + 1}`).join('\n')}\n`;

let clock: FakeClock;
let h: CheckpointHarness;
beforeEach(async () => {
  clock = new FakeClock(1_700_000_000_000);
  h = await makeCheckpointHarness({ clock });
});
afterEach(async () => {
  await h.cleanup();
});

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The entries a restore can bring back: pending ones (accepted ones are only shown). */
function pendingOf<T extends { status: string }>(entries: T[]): T[] {
  return entries.filter((e) => e.status === 'pending');
}

async function runSteps(seed: number, steps: number): Promise<Record<string, number>> {
  const random = rng(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const pickOf = <T>(items: readonly T[]): T => items[int(items.length)] as T;
  const counts: Record<string, number> = {};
  const count = (what: string): void => {
    counts[what] = (counts[what] ?? 0) + 1;
  };

  for (const file of FILES) await h.env.write({ [file]: original(file) });
  await h.sync();

  const markers = new Map<string, Set<string>>(FILES.map((f) => [f, new Set()]));
  /** The files as they were just before the action that made each operation. */
  const snapshots = new Map<OperationId, Record<string, string>>();
  const read = (file: string): Promise<string> => fs.readFile(h.env.abs(file), 'utf8');
  const readAll = async (): Promise<Record<string, string>> => {
    const all: Record<string, string> = {};
    for (const file of FILES) all[file] = await read(file);
    return all;
  };
  const log: string[] = [];
  let counter = 0;

  /** After an action that may have made an operation: remember what the files were before it. */
  async function noteOperation(pre: Record<string, string>): Promise<void> {
    const newest = (await h.svc.list(h.key))[0];
    if (newest !== undefined && !snapshots.has(newest.operationId)) {
      snapshots.set(newest.operationId, pre);
    }
  }

  /** Makes the nth log append from now on fail, like a full disk, until the returned function is called. */
  function failNthAppend(nth: number): () => void {
    const real = h.ws.appendRecord.bind(h.ws);
    let calls = 0;
    h.ws.appendRecord = async (record) => {
      const mine = calls;
      calls += 1;
      if (mine === nth) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      await real(record);
    };
    return () => {
      h.ws.appendRecord = real;
    };
  }

  for (let step = 1; step <= steps; step += 1) {
    clock.advance(DAY);
    const roll = random();
    const pre = await readAll();
    const before = await h.listing();
    const where = (what: string): string =>
      `seed ${seed}, step ${step} (${what}); so far: ${log.join(' | ')}`;
    let what: string;
    /** Paths this step may legitimately change. `undefined`: any. */
    let mayChange: string[] | undefined = [];

    if (roll < 0.26) {
      const chosen = new Set<string>();
      const n = 1 + int(3);
      while (chosen.size < n) chosen.add(pickOf(FILES));
      what = `turn ${[...chosen].join(',')}`;
      const edits: Record<string, string> = {};
      for (const file of chosen) {
        const lines = pre[file]!.split('\n');
        counter += 1;
        const candidates = lines
          .map((_line, i) => i)
          .filter((i) => i < lines.length - 1 && !isMarker(lines[i]!));
        const kind = int(3);
        if (kind === 0 && candidates.length > 0)
          lines[pickOf(candidates)] = `AGENT-${counter} replaced`;
        else if (kind === 1) lines.splice(int(lines.length), 0, `AGENT-${counter} inserted`);
        else lines.splice(lines.length - 1, 0, `AGENT-${counter} appended`);
        edits[file] = lines.join('\n');
      }
      const useCommand = random() < 0.4;
      await h.turn(async (t) => {
        if (useCommand) await t.shellWrite(edits);
        else for (const [file, content] of Object.entries(edits)) await t.edit(file, content);
      });
      mayChange = undefined;
      count('turn');
      await noteOperation(pre);
    } else if (roll < 0.38) {
      const file = pickOf(FILES);
      const lines = pre[file]!.split('\n');
      counter += 1;
      const marker = `${MARKER}${counter}`;
      lines.splice(int(lines.length), 0, marker);
      await fs.writeFile(h.env.abs(file), lines.join('\n'));
      markers.get(file)!.add(marker);
      const synced = random() < 0.7;
      if (synced) await h.sync();
      what = `user marker in ${file}${synced ? ' (synced)' : ''}`;
      mayChange = undefined;
      count('user edit');
    } else if (roll < 0.45) {
      const pending = (await h.entries()).filter((e) => e.status === 'pending');
      if (pending.length === 0) continue;
      const entry = pickOf(pending);
      what = `accept ${entry.path}`;
      await h.engine.acceptFile(h.key, entry.path);
      count('accept');
    } else if (roll < 0.52) {
      const pending = (await h.entries()).filter((e) => e.status === 'pending');
      if (pending.length === 0) continue;
      const entry = pickOf(pending);
      what = `reject ${entry.path}`;
      const result = await h.engine.rejectFile(h.key, entry.path, 'strict');
      if (result.status === 'done') mayChange = [entry.path];
      count(`reject ${result.status}`);
      await noteOperation(pre);
    } else if (roll < 0.78) {
      // Sometimes the user first takes only the agent's change out of a file (agent-only), which
      // keeps their own edits; then a default restore must still leave those alone.
      let first = '';
      if (roll < 0.58) {
        const pending = (await h.entries()).filter((e) => e.status === 'pending');
        if (pending.length > 0) {
          const entry = pickOf(pending);
          const result = await h.engine.rejectFile(h.key, entry.path, 'agent-only');
          first = `agent-only ${entry.path} ${result.status}, then `;
          count(`agent-only ${result.status}`);
          await noteOperation(pre);
        }
      }
      const list = await h.svc.list(h.key);
      if (list.length === 0) continue;
      const target = pickOf(list);
      const preview = await h.svc.preview(h.key, target.operationId);
      if (!('token' in preview)) throw new Error(`preview refused: ${preview.refused}`);
      const chosen = preview.items.filter((i) => i.selectedByDefault).map((i) => i.path);
      const conflicted = preview.items.filter((i) => !i.selectedByDefault).map((i) => i.path);
      what = `${first}restore to before ${target.kind} (${chosen.length} chosen, ${conflicted.length} conflicted)`;
      const preRestore = await readAll();
      const entriesBeforeRestore = await h.entries();
      const outcome = await h.svc.restore(
        h.key,
        preview.targetOperationId,
        preview.token,
        chosen.map(p),
      );
      if ('refused' in outcome) throw new Error(`restore refused: ${outcome.refused}`);
      expect(
        outcome.items.every((i) => i.achieved),
        `all achieved: ${where(what)}`,
      ).toBe(true);
      mayChange = undefined;
      count(`restore ${conflicted.length > 0 ? 'with conflicts' : 'clean'}`);
      // (1) A restore changes only what its items chose.
      const afterRestore = await readAll();
      for (const file of FILES) {
        if (afterRestore[file] !== preRestore[file]) {
          expect(chosen, `${file} changed but was not chosen: ${where(what)}`).toContain(file);
        }
      }
      // (2) A restored file is what it was when the first operation at or after the checkpoint that
      // touched it started. (For a file the checkpoint itself changed, that is the checkpoint.)
      const operations = preview.affectedOperations.map((s) => s.operationId).reverse();
      for (const path of chosen) {
        const firstOp = operations.find((id) =>
          h.ws.log
            .records()
            .some(
              (r) =>
                r.type === 'operation' && r.id === id && r.changes.some((c) => c.path === path),
            ),
        );
        const snapshot = firstOp === undefined ? undefined : snapshots.get(firstOp);
        if (snapshot !== undefined) {
          expect(await read(path), `${path} as before its first operation: ${where(what)}`).toBe(
            snapshot[path],
          );
        }
      }
      await noteOperation(preRestore);

      // Undoing that restore (restoring to before it) brings the review entries back as they were.
      if (outcome.operationId !== undefined && random() < 0.5) {
        const pendingBefore = pendingOf(entriesBeforeRestore);
        const undo = await h.svc.preview(h.key, outcome.operationId);
        if (!('token' in undo)) throw new Error(`undo preview refused: ${undo.refused}`);
        const undoChosen = undo.items.filter((i) => i.selectedByDefault).map((i) => i.path);
        const undone = await h.svc.restore(
          h.key,
          undo.targetOperationId,
          undo.token,
          undoChosen.map(p),
        );
        if ('refused' in undone) throw new Error(`undo refused: ${undone.refused}`);
        what += ' + undo';
        expect(
          pendingOf(await h.entries()),
          `entries after undoing the restore: ${where(what)}`,
        ).toEqual(pendingBefore);
        await noteOperation(afterRestore);
        count('restore undone');
      }
    } else if (roll < 0.9) {
      // A log append fails at a random point of an action that replaces content that may be the
      // user's: nothing the user wrote may become unretrievable. (Here the user opts in to the
      // conflicts, as in the dialog, so their lines may legitimately go.)
      const nth = int(3);
      const stop = failNthAppend(nth);
      let optedIn: string[];
      try {
        if (random() < 0.5) {
          const pending = (await h.entries()).filter((e) => e.status === 'pending');
          if (pending.length === 0) continue;
          const entry = pickOf(pending);
          what = `agent-only ${entry.path} with failing append ${nth}`;
          optedIn = [];
          await h.engine.rejectFile(h.key, entry.path, 'agent-only');
        } else {
          const list = await h.svc.list(h.key);
          if (list.length === 0) continue;
          const target = pickOf(list);
          const preview = await h.svc.preview(h.key, target.operationId);
          if (!('token' in preview)) throw new Error(`preview refused: ${preview.refused}`);
          const chosen = preview.items.filter((i) => i.selectable).map((i) => i.path);
          optedIn = preview.items
            .filter((i) => i.selectable && !i.selectedByDefault)
            .map((i) => i.path);
          what = `restore (opted in ${optedIn.length}) with failing append ${nth}`;
          await h.svc.restore(h.key, preview.targetOperationId, preview.token, chosen.map(p));
        }
      } finally {
        stop();
      }
      mayChange = undefined;
      const roots = await h.engine.referencedHashes(h.key);
      for (const file of FILES) {
        const now = await read(file);
        if (now !== pre[file]) {
          expect(
            roots.has(sha256(pre[file]!)),
            `${file} as it was is still referenced: ${where(what)}`,
          ).toBe(true);
          if (optedIn.includes(file)) markers.get(file)!.clear();
        }
      }
      count('failing append');
      await noteOperation(pre);
    } else {
      what = 'prune';
      const listBefore = await h.svc.list(h.key);
      const entries = await h.entries();
      await h.svc.prune(h.key, { ...DEFAULT_SETTINGS, retentionOperations: 6, retentionDays: 5 });
      const listAfter = await h.svc.list(h.key);
      expect(listAfter.length, `never fewer than 5: ${where(what)}`).toBeGreaterThanOrEqual(
        Math.min(5, listBefore.length),
      );
      expect(await h.entries(), `entries unchanged by prune: ${where(what)}`).toEqual(entries);
      count('prune');
    }
    log.push(what);

    // (1) Only what the step may change, changes.
    const after = await h.listing();
    const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]);
    if (mayChange !== undefined) {
      for (const path of changed)
        expect(mayChange, `${path} changed: ${where(what)}`).toContain(path);
    }
    expect(
      Object.keys(after).filter((k) => !FILES.includes(k)),
      'no stray files',
    ).toEqual([]);

    // (3) The user's marker lines are all still there.
    for (const file of FILES) {
      const lines = (await read(file)).split('\n');
      for (const marker of markers.get(file)!) {
        expect(lines, `marker ${marker} in ${file}: ${where(what)}`).toContain(marker);
      }
    }

    // (4) A fresh engine and service agree with the live ones.
    expect(await h.newEngine().entries(h.key), `entries: ${where(what)}`).toEqual(
      await h.entries(),
    );
    expect(await h.newService().list(h.key), `list: ${where(what)}`).toEqual(
      await h.svc.list(h.key),
    );
  }
  return counts;
}

describe('checkpoints: random sequences', () => {
  it('never changes a conflicted file, restores what the operation started from, and keeps the user lines', async () => {
    const counts = await runSteps(20260512, 120);
    expect(counts['turn']).toBeGreaterThan(10);
    expect(counts['user edit']).toBeGreaterThan(3);
    expect(counts['restore clean']).toBeGreaterThan(0);
    expect(counts['restore with conflicts']).toBeGreaterThan(0);
    expect(counts['prune']).toBeGreaterThan(0);
    expect(counts['failing append']).toBeGreaterThan(0);
    expect(counts['restore undone']).toBeGreaterThan(0);
    expect(Object.keys(counts).filter((k) => k.startsWith('agent-only')).length).toBeGreaterThan(0);
  }, 240_000);

  it('holds for another seed', async () => {
    await runSteps(11, 120);
  }, 240_000);

  const extra = Number(process.env['CHECKPOINT_PROP_SEEDS'] ?? 0);
  for (let seed = 1; seed <= extra; seed += 1) {
    it(`holds for seed ${seed}`, async () => {
      await runSteps(seed, 120);
    }, 240_000);
  }
});
