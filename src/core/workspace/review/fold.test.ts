import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationId } from '../../../shared';
import { newId } from '../../util/ids';
import { sha } from '../tracker/test-support';
import { makeHarness, operations, p, type Harness } from './test-helpers';

const posix = process.platform !== 'win32';
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

describe('fold: what an agent did', () => {
  it('turns one agent edit into one pending entry', async () => {
    await h.env.write({ 'a.ts': text('one', 'two', 'three'), 'quiet.ts': 'q' });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', text('one', 'TWO', 'three', 'four')));

    const entries = await h.entries();
    expect(entries.map((e) => e.path)).toEqual(['a.ts']);
    const entry = entries[0]!;
    expect(entry).toMatchObject({
      changeType: 'modified',
      attribution: 'agent-tool',
      status: 'pending',
      restorable: true,
      includesUserEdits: false,
      linesAdded: 2,
      linesRemoved: 1,
    });
    expect(entry.baseline).toMatchObject({ kind: 'file', hash: sha(text('one', 'two', 'three')) });
    expect(entry.current).toMatchObject({
      kind: 'file',
      hash: sha(text('one', 'TWO', 'three', 'four')),
    });
    expect(entry.operationIds).toEqual([operations(h.ws)[0]!.id]);
    expect(entry.note).toBeUndefined();
  });

  it('keeps the original as the baseline over two turns on one file', async () => {
    await h.env.write({ 'a.ts': 'v0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', 'v1\n'));
    await h.turn((t) => t.edit('a.ts', 'v2\n'));
    const entry = (await h.entries())[0]!;
    expect(entry.baseline).toMatchObject({ hash: sha('v0\n') });
    expect(entry.current).toMatchObject({ hash: sha('v2\n') });
    expect(entry.operationIds).toEqual(operations(h.ws).map((op) => op.id));
    expect(entry.includesUserEdits).toBe(false);
  });

  it('shows created, deleted, renamed and mode changes', async () => {
    await h.env.write({
      'gone.txt': 'to be deleted\n',
      'old-name.txt': 'moves along\n',
      'run.sh': '#!/bin/sh\n',
    });
    await fs.chmod(h.env.abs('run.sh'), 0o644);
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('new.txt', 'brand new\n', 'Write');
      await t.command(async () => {
        await fs.rm(h.env.abs('gone.txt'));
        await fs.rename(h.env.abs('old-name.txt'), h.env.abs('new-name.txt'));
        if (posix) await fs.chmod(h.env.abs('run.sh'), 0o755);
      });
    });
    const byPath = new Map((await h.entries()).map((e) => [e.path, e]));
    expect(byPath.get(p('new.txt'))).toMatchObject({
      changeType: 'created',
      attribution: 'agent-tool',
    });
    expect(byPath.get(p('new.txt'))?.baseline).toEqual({ kind: 'absent' });
    expect(byPath.get(p('gone.txt'))).toMatchObject({
      changeType: 'deleted',
      attribution: 'agent-command',
      restorable: true,
    });
    expect(byPath.get(p('gone.txt'))?.current).toEqual({ kind: 'absent' });
    expect(byPath.get(p('gone.txt'))?.linesRemoved).toBe(1);
    expect(byPath.get(p('old-name.txt'))?.changeType).toBe('deleted');
    expect(byPath.get(p('new-name.txt'))).toMatchObject({
      changeType: 'created',
      renamedFrom: 'old-name.txt',
    });
    // A new file with unrelated content is not a rename.
    expect(byPath.get(p('new.txt'))?.renamedFrom).toBeUndefined();
    if (posix) {
      expect(byPath.get(p('run.sh'))).toMatchObject({ changeType: 'mode' });
      expect(byPath.get(p('run.sh'))?.baseline).toMatchObject({ mode: 0o644 });
      expect(byPath.get(p('run.sh'))?.current).toMatchObject({ mode: 0o755 });
    }
  });

  it('does not call a copy of an empty file or an ambiguous match a rename', async () => {
    await h.env.write({ 'empty-1.txt': '', 'same-1.txt': 'same\n', 'same-2.txt': 'same\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.command(async () => {
        await fs.rm(h.env.abs('empty-1.txt'));
        await fs.rm(h.env.abs('same-1.txt'));
        await fs.rm(h.env.abs('same-2.txt'));
        await h.env.write({ 'empty-2.txt': '', 'same-3.txt': 'same\n' });
      });
    });
    const byPath = new Map((await h.entries()).map((e) => [e.path, e]));
    expect(byPath.get(p('empty-2.txt'))?.renamedFrom).toBeUndefined();
    // Two deleted files had that content: not exactly one.
    expect(byPath.get(p('same-3.txt'))?.renamedFrom).toBeUndefined();
  });

  it('combines attributions by taking the less certain one', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    expect((await h.entry('a.txt'))?.attribution).toBe('agent-tool');
    await h.turn(async (t) => {
      await t.shellWrite({ 'a.txt': 'a2\n' });
    });
    expect((await h.entry('a.txt'))?.attribution).toBe('agent-command');
    // A change made outside any tool is "unattributed", which is less certain still.
    await h.turn(async () => {
      await h.env.write({ 'a.txt': 'a3\n', 'b.txt': 'b1\n' });
    });
    expect((await h.entry('a.txt'))?.attribution).toBe('unattributed');
    expect((await h.entry('b.txt'))?.attribution).toBe('unattributed');
    // And a later certain one does not make it more certain again.
    await h.turn((t) => t.edit('a.txt', 'a4\n'));
    expect((await h.entry('a.txt'))?.attribution).toBe('unattributed');
    expect((await h.entry('a.txt'))?.baseline).toMatchObject({ hash: sha('a0\n') });
  });

  it('shows a file the user saved during a turn as mixed, and a plain user save not at all', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'u.txt': 'u0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'agent\n');
      await t.userSave('a.txt', 'user over agent\n');
      await t.userSave('u.txt', 'user only\n');
    });
    const entries = await h.entries();
    expect(entries.map((e) => e.path)).toEqual(['a.txt']);
    expect(entries[0]).toMatchObject({ attribution: 'mixed' });
    // The user's own save, in a turn or out of it, is no entry.
    expect(await h.entry('u.txt')).toBeUndefined();
  });

  it('marks a path an interrupted turn changed as pending with its own attribution', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    const first = operations(h.ws)[0]!;
    // A recovery operation as a crashed turn leaves it.
    await h.ws.log.append({
      type: 'operation',
      id: newId<OperationId>(),
      kind: 'recovery',
      at: Date.now(),
      status: 'interrupted',
      changes: [
        {
          path: p('a.txt'),
          before: first.changes[0]!.after,
          after: { kind: 'absent' },
          attribution: 'after-interruption',
        },
      ],
      preserved: [],
      notes: [],
    });
    const entry = (await h.entries())[0]!;
    expect(entry.attribution).toBe('after-interruption');
    expect(entry.changeType).toBe('deleted');
    expect(entry.baseline).toMatchObject({ hash: sha('a0\n') });
  });
});

describe('fold: the user changes a file between operations', () => {
  const original = text(
    'import x',
    'const teh = 1',
    'function f() {',
    '  return 1',
    '}',
    'export {}',
  );

  it('rebases the baseline over a user fix elsewhere in the file (the blocker scenario)', async () => {
    await h.env.write({ 'a.ts': original });
    await h.sync();
    // Turn 1: the agent changes the body of f.
    const afterTurn1 = original.replace('return 1', 'return 2');
    await h.turn((t) => t.edit('a.ts', afterTurn1));
    // Between turns the user fixes a typo near the top.
    const withFix = afterTurn1.replace('teh', 'the');
    await h.env.write({ 'a.ts': withFix });
    // Turn 2: the agent edits the last line.
    const afterTurn2 = withFix.replace('export {}', 'export { f }');
    await h.turn((t) => t.edit('a.ts', afterTurn2));

    const entries = await h.entries();
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.includesUserEdits).toBe(true);
    expect(entry.attribution).toBe('agent-tool');
    const userVersionWithoutAgent = original.replace('teh', 'the');
    expect(entry.baseline).toMatchObject({
      kind: 'file',
      hash: sha(userVersionWithoutAgent),
      stored: true,
    });
    expect(entry.current).toMatchObject({ hash: sha(afterTurn2) });
    expect(entry.operationIds).toHaveLength(2);
    // The merged baseline has a blob.
    expect((await h.ws.blobs.get(sha(userVersionWithoutAgent))).toString()).toBe(
      userVersionWithoutAgent,
    );

    // Rejecting gives the user's version without the agent's changes.
    expect(await h.engine.rejectFile(h.key, p('a.ts'), 'strict')).toEqual({ status: 'done' });
    expect(await h.read('a.ts')).toBe(userVersionWithoutAgent);
    expect(await h.entries()).toEqual([]);
  });

  it('records a foreign change found by a sync outside a turn, and rebases over it', async () => {
    await h.env.write({ 'a.ts': original });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', original.replace('return 1', 'return 2')));
    await h.userEdit({ 'a.ts': original.replace('return 1', 'return 2').replace('teh', 'the') });
    const entry = (await h.entries())[0]!;
    expect(entry.includesUserEdits).toBe(true);
    expect(entry.baseline).toMatchObject({ hash: sha(original.replace('teh', 'the')) });
    expect(entry.attribution).toBe('agent-tool');
  });

  it('makes the entry mixed and leaves the baseline alone when the edits overlap', async () => {
    await h.env.write({ 'a.ts': original });
    await h.sync();
    const afterTurn1 = original.replace('return 1', 'return 2');
    await h.turn((t) => t.edit('a.ts', afterTurn1));
    // The user edits the very line the agent changed.
    const userVersion = afterTurn1.replace('return 2', 'return 3');
    await h.env.write({ 'a.ts': userVersion });
    await h.turn((t) => t.edit('a.ts', userVersion.replace('export {}', 'export { f }')));

    const entry = (await h.entries())[0]!;
    expect(entry.attribution).toBe('mixed');
    expect(entry.includesUserEdits).toBe(true);
    expect(entry.baseline).toMatchObject({ hash: sha(original) });
  });

  it('does not let a strict or agent-only reject drop edits the baseline could not absorb', async () => {
    await h.env.write({ 'a.ts': original });
    await h.sync();
    const afterTurn1 = original.replace('return 1', 'return 2');
    await h.turn((t) => t.edit('a.ts', afterTurn1));
    const userVersion = afterTurn1.replace('return 2', 'return 3');
    await h.userEdit({ 'a.ts': userVersion });
    // A created file the user then edited: its baseline cannot absorb the edit either.
    await h.turn((t) => t.edit('new.txt', 'agent\n', 'Write'));
    await h.userEdit({ 'new.txt': 'agent\nuser line\n' });

    const before = await h.listing();
    for (const path of ['a.ts', 'new.txt']) {
      expect((await h.entry(path))?.attribution).toBe('mixed');
      expect(await h.engine.rejectFile(h.key, p(path), 'strict')).toEqual({
        status: 'conflict',
        reason: 'uncertain-source',
        canRevertAgentOnly: false,
      });
      expect((await h.engine.rejectFile(h.key, p(path), 'agent-only')).status).toBe('refused');
    }
    const result = await h.engine.rejectAll(h.key, [p('a.ts'), p('new.txt')]);
    expect(result.rejected).toEqual([]);
    expect(result.failed.map((f) => f.path)).toEqual(['new.txt', 'a.ts']);
    expect(await h.listing()).toEqual(before);
    // Only an explicit overwrite puts the baseline back.
    expect(await h.engine.rejectFile(h.key, p('a.ts'), 'overwrite')).toEqual({ status: 'done' });
    expect(await h.read('a.ts')).toBe(original);
  });

  it('makes the entry mixed when the content is not text', async () => {
    const bin = (n: number) => Buffer.from([0, 1, 2, n]);
    await h.env.write({ 'x.bin': bin(0) });
    await h.sync();
    await h.turn((t) => t.edit('x.bin', bin(1)));
    await h.userEdit({ 'x.bin': bin(2) });
    const entry = (await h.entry('x.bin'))!;
    expect(entry).toMatchObject({ attribution: 'mixed', includesUserEdits: true });
    expect(entry.baseline).toMatchObject({ hash: sha(bin(0)) });
    expect(entry.current).toMatchObject({ hash: sha(bin(2)) });
  });

  it('drops the entry when the user puts the file back to the baseline by hand', async () => {
    await h.env.write({ 'a.ts': original });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', original.replace('return 1', 'return 2')));
    expect(await h.entries()).toHaveLength(1);
    await h.userEdit({ 'a.ts': original });
    expect(await h.entries()).toEqual([]);
    // A later turn starts from what is on disk.
    await h.turn((t) => t.edit('a.ts', original.replace('import x', 'import y')));
    const entry = (await h.entries())[0]!;
    expect(entry.baseline).toMatchObject({ hash: sha(original) });
    expect(entry.operationIds).toHaveLength(1);
  });

  it('drops a created entry when the user deletes the file', async () => {
    await h.env.write({ 'keep.txt': 'k' });
    await h.sync();
    await h.turn((t) => t.edit('new.txt', 'agent made me\n', 'Write'));
    expect((await h.entry('new.txt'))?.changeType).toBe('created');
    await fs.rm(h.env.abs('new.txt'));
    await h.sync();
    expect(await h.entry('new.txt')).toBeUndefined();
  });

  it('rebases a user mode change into the baseline', async () => {
    if (!posix) return;
    await h.env.write({ 'a.txt': 'one\ntwo\n' });
    await fs.chmod(h.env.abs('a.txt'), 0o644);
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'one\nTWO\n'));
    await fs.chmod(h.env.abs('a.txt'), 0o755);
    await h.sync();
    const entry = (await h.entries())[0]!;
    expect(entry.baseline).toMatchObject({ hash: sha('one\ntwo\n'), mode: 0o755 });
    expect(entry.current).toMatchObject({ mode: 0o755 });
    expect(entry.includesUserEdits).toBe(true);
  });
});

describe('fold: accepting', () => {
  it('shows an accepted entry until the next turn, then a fresh entry starts from the accepted state', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
    });
    await h.engine.acceptFile(h.key, p('a.txt'));
    const after = await h.entries();
    expect(after.map((e) => [e.path, e.status])).toEqual([
      ['a.txt', 'accepted'],
      ['b.txt', 'pending'],
    ]);
    expect(after[0]).toMatchObject({ changeType: 'modified', restorable: false });
    expect(after[0]!.baseline).toEqual(after[0]!.current);

    await h.turn((t) => t.edit('a.txt', 'a2\n'));
    const next = await h.entries();
    // The accepted entry was dropped by the new turn; a.txt is pending again, with a fresh baseline.
    expect(next.map((e) => [e.path, e.status])).toEqual([
      ['a.txt', 'pending'],
      ['b.txt', 'pending'],
    ]);
    expect(next[0]!.baseline).toMatchObject({ hash: sha('a1\n') });
    expect(next[0]!.operationIds).toHaveLength(1);
    expect(next[0]!.includesUserEdits).toBe(false);
  });

  it('drops accepted entries at the next turn even when it touches other files', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    await h.engine.acceptAll(h.key);
    expect((await h.entries()).map((e) => e.status)).toEqual(['accepted']);
    await h.turn((t) => t.edit('b.txt', 'b1\n'));
    expect((await h.entries()).map((e) => e.path)).toEqual(['b.txt']);
  });
});

describe('fold: restore records', () => {
  it('removes the undone operations and drops an entry with none left', async () => {
    await h.env.write({ 'a.txt': 'v0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'v1\n'));
    await h.turn((t) => t.edit('a.txt', 'v2\n'));
    const [op1, op2] = operations(h.ws);
    const entry = (await h.entries())[0]!;
    expect(entry.operationIds).toEqual([op1!.id, op2!.id]);

    // Restore to before the second operation: the file goes back to v1.
    await h.ws.log.append({
      type: 'operation',
      id: newId<OperationId>(),
      kind: 'restore',
      at: Date.now(),
      status: 'complete',
      restoredTo: op2!.id,
      changes: [
        {
          path: p('a.txt'),
          before: op2!.changes[0]!.after,
          after: op2!.changes[0]!.before,
          attribution: 'agent-tool',
        },
      ],
      preserved: [],
      notes: [],
    });
    const mid = (await h.entries())[0]!;
    expect(mid.operationIds).toEqual([op1!.id]);
    expect(mid.current).toMatchObject({ hash: sha('v1\n') });
    expect(mid.baseline).toMatchObject({ hash: sha('v0\n') });

    // Restore to before the first: nothing is left of the agent's work.
    await h.ws.log.append({
      type: 'operation',
      id: newId<OperationId>(),
      kind: 'restore',
      at: Date.now(),
      status: 'complete',
      restoredTo: op1!.id,
      changes: [
        {
          path: p('a.txt'),
          before: op1!.changes[0]!.after,
          after: op1!.changes[0]!.before,
          attribution: 'agent-tool',
        },
      ],
      preserved: [],
      notes: [],
    });
    expect(await h.entries()).toEqual([]);
  });
});

describe('fold: determinism', () => {
  it('gives the same entries and no further blobs when folded again, or by a new engine', async () => {
    const original = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6');
    await h.env.write({ 'a.ts': original, 'b.ts': 'b\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', original.replace('l5', 'L5')));
    await h.env.write({ 'a.ts': original.replace('l5', 'L5').replace('l1', 'one') });
    await h.turn(async (t) => {
      await t.edit('a.ts', original.replace('l5', 'L5').replace('l1', 'one').replace('l6', 'L6'));
      await t.edit('b.ts', 'b2\n');
    });

    const first = await h.entries();
    const blobs = await h.ws.blobs.list();
    const second = await h.entries();
    const fresh = await h.newEngine().entries(h.key);
    expect(second).toEqual(first);
    expect(fresh).toEqual(first);
    expect(await h.ws.blobs.list()).toEqual(blobs);
    expect(first.find((e) => e.path === 'a.ts')?.includesUserEdits).toBe(true);
  });

  it('recomputes when the log grows and not otherwise', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    const empty = await h.engine.entries(h.key);
    expect(empty).toEqual([]);
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    expect(await h.engine.entries(h.key)).toHaveLength(1);
  });
});

describe('fold: limits', () => {
  it('marks a path whose earlier content was not kept as not restorable, with a note', async () => {
    const big = 'x'.repeat(2000);
    const h2 = await makeHarness({ settings: { snapshotMaxFileBytes: 100 } });
    try {
      await h2.env.write({ 'big.txt': big });
      await h2.sync();
      await h2.turn(async (t) => {
        await t.shellWrite({ 'big.txt': `${big}y` });
      });
      const entry = (await h2.engine.entries(h2.key))[0]!;
      expect(entry.restorable).toBe(false);
      expect(entry.note).toBe(
        'The earlier content of this file was not kept, so it cannot be put back.',
      );
      expect(entry.baseline).toMatchObject({ kind: 'file', stored: false });
    } finally {
      await h2.cleanup();
    }
  });

  it('keeps no lines counts for binary content', async () => {
    await h.env.write({ 'x.bin': Buffer.from([0, 1, 2]) });
    await h.sync();
    await h.turn((t) => t.edit('x.bin', Buffer.from([0, 1, 3])));
    const entry = (await h.entry('x.bin'))!;
    expect(entry.linesAdded).toBeUndefined();
    expect(entry.linesRemoved).toBeUndefined();
    expect(entry.restorable).toBe(true);
  });
});
