import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OperationId, RestoreItem, RestorePreview } from '../../../shared';
import { newId } from '../../util/ids';
import { statesEqual } from '../review/states';
import { readDisk, readToState } from '../review/disk';
import { Turn, sha } from '../tracker/test-support';
import { p, rejectRecords } from '../review/test-helpers';
import { makeCheckpointHarness, type CheckpointHarness } from './test-helpers';
import {
  NOT_SELECTABLE_MESSAGE,
  OUT_OF_DATE_MESSAGE,
  NO_CHECKPOINT_MESSAGE,
  BUSY_MESSAGE,
} from './service';

const posix = process.platform !== 'win32';
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

let h: CheckpointHarness;
beforeEach(async () => {
  h = await makeCheckpointHarness();
});
afterEach(async () => {
  await h.cleanup();
});

function isPreview(value: RestorePreview | { refused: string }): value is RestorePreview {
  return 'token' in value;
}

async function preview(opId: OperationId): Promise<RestorePreview> {
  const result = await h.svc.preview(h.key, opId);
  if (!isPreview(result)) throw new Error(`refused: ${result.refused}`);
  return result;
}

async function restore(prev: RestorePreview, paths: string[]) {
  const result = await h.svc.restore(h.key, prev.targetOperationId, prev.token, paths.map(p));
  if ('refused' in result) throw new Error(`refused: ${result.refused}`);
  return result;
}

const defaults = (prev: RestorePreview): string[] =>
  prev.items.filter((i) => i.selectedByDefault).map((i) => i.path);

const itemOf = (prev: RestorePreview, path: string): RestoreItem => {
  const found = prev.items.find((i) => i.path === path);
  if (!found) throw new Error(`no item for ${path}: ${prev.items.map((i) => i.path).join(', ')}`);
  return found;
};

async function ops(): Promise<OperationId[]> {
  return (await h.svc.list(h.key)).map((s) => s.operationId);
}

async function diskState(path: string) {
  const state = readToState(await readDisk(h.env.root, path), true);
  if (!state) throw new Error('unexpected item');
  return state;
}

describe('list', () => {
  it('gives one summary per operation with changes, newest first, with counts and flags', async () => {
    expect(await h.svc.list(h.key)).toEqual([]);
    expect(await h.svc.list('nope' as never)).toEqual([]);
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
    });
    await h.turn((t) => t.edit('a.txt', 'a2\n'));
    await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    // An interrupted turn leaves a recovery operation.
    await fs.writeFile(
      join(h.env.storage, h.env.folder.key, 'journal.json'),
      JSON.stringify({
        turnId: 'dead',
        conversationId: 'conv-1',
        startedAt: Date.now() - 100_000,
        lastActivityAt: Date.now() - 50_000,
        pid: null,
      }),
    );
    await h.env.write({ 'b.txt': 'b-after-crash\n' });
    await h.tracker.recover(h.env.folder, h.env.settings);
    // An operation without changes is no checkpoint.
    await h.ws.appendRecord({
      type: 'operation',
      id: newId<OperationId>(),
      kind: 'agent-turn',
      at: Date.now(),
      status: 'complete',
      changes: [],
      preserved: [],
      notes: [],
    });

    const list = await h.svc.list(h.key);
    expect(list.map((s) => [s.kind, s.filesChanged, s.interrupted])).toEqual([
      ['recovery', 1, true],
      ['reject', 1, false],
      ['agent-turn', 1, false],
      ['agent-turn', 2, false],
    ]);
    expect(list[3]!.conversationId).toBe('conv-1');
    expect(list[3]!.turnId).toBeDefined();
    expect(list[0]!.at).toBeGreaterThanOrEqual(list[3]!.at);
  });
});

describe('preview and restore of one turn', () => {
  it('puts modified, created, deleted and mode-changed files back, byte for byte', async () => {
    await h.env.write({
      'mod.txt': text('one', 'two'),
      'gone.txt': 'to be deleted\n',
      'run.sh': '#!/bin/sh\n',
      'bin.dat': Buffer.from([0, 1, 2, 3]),
    });
    if (posix) await fs.chmod(h.env.abs('run.sh'), 0o644);
    if (posix) await fs.chmod(h.env.abs('gone.txt'), 0o640);
    await h.sync();
    const original = await h.listing();
    await h.turn(async (t) => {
      await t.edit('mod.txt', text('one', 'TWO', 'three'));
      await t.edit('dir/new.txt', 'created\n', 'Write');
      await t.edit('bin.dat', Buffer.from([0, 9, 9, 9]));
      await t.command(async () => {
        await fs.rm(h.env.abs('gone.txt'));
        if (posix) await fs.chmod(h.env.abs('run.sh'), 0o755);
      });
    });
    const [k] = await ops();
    const prev = await preview(k!);
    expect(prev.targetOperationId).toBe(k);
    expect(prev.affectedOperations.map((s) => s.operationId)).toEqual([k]);
    expect(
      prev.items.map((i) => [
        i.path,
        i.action,
        i.conflict ?? null,
        i.selectedByDefault,
        i.selectable,
      ]),
    ).toEqual([
      ['bin.dat', 'write', null, true, true],
      ['dir/new.txt', 'delete', null, true, true],
      ['gone.txt', 'write', null, true, true],
      ['mod.txt', 'write', null, true, true],
      ...(posix ? [['run.sh', 'chmod', null, true, true]] : []),
    ]);
    expect(itemOf(prev, 'mod.txt').attribution).toBe('agent-tool');
    expect(itemOf(prev, 'gone.txt').attribution).toBe('agent-command');
    expect(prev.bytesNeeded).toBeGreaterThan(0);

    const result = await restore(prev, defaults(prev));
    expect(result.items.every((i) => i.achieved)).toBe(true);
    expect(result.operationId).toBeDefined();
    const after = await h.listing();
    // Everything is as it was, except that the directory the agent made is still there.
    expect(Object.fromEntries(Object.entries(after).filter(([k]) => k !== 'dir/'))).toEqual(
      original,
    );
    expect(h.restored).toEqual([h.key]);
    expect(await h.entries()).toEqual([]);

    // The log says what was done, and the tracker finds nothing foreign afterwards.
    const record = h.ws.log.records().at(-1)!;
    expect(record).toMatchObject({
      type: 'operation',
      kind: 'restore',
      restoredTo: k,
      status: 'complete',
    });
    if (record.type === 'operation') {
      expect(record.changes.map((c) => c.path).sort()).toEqual(prev.items.map((i) => i.path));
      for (const change of record.changes) {
        expect(statesEqual(change.after, await diskState(change.path))).toBe(true);
        expect(change.attribution).toBe('agent-tool');
      }
      expect(record.notes).toEqual([]);
    }
    const count = h.ws.log.records().length;
    await h.sync();
    expect(
      h.ws.log
        .records()
        .slice(count)
        .filter((r) => r.type === 'foreign-delta'),
    ).toEqual([]);
    expect(await h.newEngine().entries(h.key)).toEqual([]);
  });

  it('refuses an unknown checkpoint', async () => {
    expect(await h.svc.preview(h.key, 'nope' as OperationId)).toEqual({
      refused: NO_CHECKPOINT_MESSAGE,
    });
    expect(await h.svc.preview('nope' as never, 'x' as OperationId)).toEqual({
      refused: NO_CHECKPOINT_MESSAGE,
    });
  });

  it('writes nothing when the previewed state is already there', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    const [k] = await ops();
    // Rejecting the file already took it back.
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({ status: 'done' });
    const prev = await preview(k!);
    expect(prev.items).toEqual([]);
    const before = await h.listing();
    const records = h.ws.log.records().length;
    const result = await restore(prev, []);
    expect(result).toEqual({ items: [] });
    expect(h.ws.log.records().length).toBe(records);
    expect(await h.listing()).toEqual(before);
  });
});

describe('restoring over several turns', () => {
  it('goes back to before the second turn, leaving what only the first turn did', async () => {
    await h.env.write({
      'only1.txt': 'o0\n',
      'both12.txt': 'b0\n',
      'both23.txt': 'c0\n',
      'only3.txt': 'd0\n',
    });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('only1.txt', 'o1\n');
      await t.edit('both12.txt', 'b1\n');
    });
    await h.turn(async (t) => {
      await t.edit('both12.txt', 'b2\n');
      await t.edit('both23.txt', 'c2\n');
    });
    await h.turn(async (t) => {
      await t.edit('both23.txt', 'c3\n');
      await t.edit('only3.txt', 'd3\n');
    });
    const list = await ops();
    expect(list).toHaveLength(3);
    const prev = await preview(list[1]!);
    expect(prev.affectedOperations.map((s) => s.operationId)).toEqual([list[0], list[1]]);
    expect(prev.items.map((i) => i.path)).toEqual(['both12.txt', 'both23.txt', 'only3.txt']);
    await restore(prev, defaults(prev));
    expect(await h.read('only1.txt')).toBe('o1\n');
    expect(await h.read('both12.txt')).toBe('b1\n');
    expect(await h.read('both23.txt')).toBe('c0\n');
    expect(await h.read('only3.txt')).toBe('d0\n');
    // Review shows what the first turn still has pending, and nothing of the others.
    const entries = await h.entries();
    expect(entries.map((e) => e.path)).toEqual(['both12.txt', 'only1.txt']);
    expect(entries.every((e) => e.operationIds.length === 1)).toBe(true);
    expect(await h.newEngine().entries(h.key)).toEqual(entries);
  });

  it('undoes a restore by restoring to before it', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
    });
    const [turnOp] = await ops();
    const first = await preview(turnOp!);
    const done = await restore(first, defaults(first));
    expect(await h.read('a.txt')).toBe('a0\n');
    expect(await h.read('b.txt')).toBe('b0\n');

    const list = await h.svc.list(h.key);
    expect(list[0]).toMatchObject({ kind: 'restore', operationId: done.operationId });
    const undo = await preview(done.operationId!);
    expect(undo.items.map((i) => [i.path, i.conflict ?? null])).toEqual([
      ['a.txt', null],
      ['b.txt', null],
    ]);
    await restore(undo, defaults(undo));
    expect(await h.read('a.txt')).toBe('a1\n');
    expect(await h.read('b.txt')).toBe('b1\n');
    // The tracker saw both restores as ours.
    const count = h.ws.log.records().length;
    await h.sync();
    expect(h.ws.log.records().slice(count)).toEqual([]);
    expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
  });
});

describe('conflicts', () => {
  const BASE = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8');

  it('flags unsaved editor changes: not selectable, never written', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'ok.txt': 'ok0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('ok.txt', 'ok1\n');
    });
    h.editor.dirty.add(h.env.abs('a.txt'));
    const [k] = await ops();
    const prev = await preview(k!);
    expect(itemOf(prev, 'a.txt')).toMatchObject({
      conflict: 'unsaved-editor',
      selectable: false,
      selectedByDefault: false,
    });
    expect(defaults(prev)).toEqual(['ok.txt']);
    await restore(prev, defaults(prev));
    expect(await h.read('a.txt')).toBe('a1\n');
    expect(await h.read('ok.txt')).toBe('ok0\n');
    const again = await preview(k!);
    expect(await h.svc.restore(h.key, again.targetOperationId, again.token, [p('a.txt')])).toEqual({
      refused: NOT_SELECTABLE_MESSAGE,
    });
  });

  it('flags content that was not kept: not selectable', async () => {
    const small = await makeCheckpointHarness({ settings: { snapshotMaxFileBytes: 100 } });
    try {
      const big = 'x'.repeat(2000);
      await small.env.write({ 'big.txt': big, 'ok.txt': 'ok0\n' });
      await small.sync();
      await small.turn(async (t) => {
        await t.shellWrite({ 'big.txt': `${big}y` });
        await t.edit('ok.txt', 'ok1\n');
      });
      const [k] = (await small.svc.list(small.key)).map((s) => s.operationId);
      const result = await small.svc.preview(small.key, k!);
      if (!isPreview(result)) throw new Error('refused');
      expect(result.items.find((i) => i.path === 'big.txt')).toMatchObject({
        conflict: 'not-captured',
        note: 'The content of this file at that point was not kept.',
        selectable: false,
        selectedByDefault: false,
      });
      const outcome = await small.svc.restore(small.key, result.targetOperationId, result.token, [
        p('ok.txt'),
      ]);
      expect('refused' in outcome).toBe(false);
      expect(await small.read('big.txt')).toBe(`${big}y`);
      expect(await small.read('ok.txt')).toBe('ok0\n');
    } finally {
      await small.cleanup();
    }
  });

  it('flags a parent folder that became a link as blocked', async () => {
    if (!posix) return;
    await h.env.write({ 'sub/a.txt': 'a0\n', 'ok.txt': 'ok0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('sub/a.txt', 'a1\n');
      await t.edit('ok.txt', 'ok1\n');
    });
    await fs.rename(h.env.abs('sub'), h.env.abs('moved'));
    await fs.symlink('moved', h.env.abs('sub'));
    const [k] = await ops();
    const prev = await preview(k!);
    const item = itemOf(prev, 'sub/a.txt');
    expect(item).toMatchObject({
      conflict: 'blocked-path',
      selectable: false,
      selectedByDefault: false,
    });
    expect(item.note).toContain('link');
    await restore(prev, defaults(prev));
    expect(await h.read('moved/a.txt')).toBe('a1\n');
    expect(await h.read('ok.txt')).toBe('ok0\n');
  });

  it('flags a folder where a deleted file was as blocked', async () => {
    await h.env.write({ 'd.txt': 'was a file\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d.txt'));
      }),
    );
    await h.env.write({ 'd.txt/inner.txt': 'precious\n' });
    const [k] = await ops();
    const prev = await preview(k!);
    expect(itemOf(prev, 'd.txt')).toMatchObject({ conflict: 'blocked-path', selectable: false });
    expect(itemOf(prev, 'd.txt').note).toContain('folder');
  });

  it('flags an edit nobody has recorded yet (changed since), and lets the user opt in', async () => {
    await h.env.write({ 'a.txt': BASE, 'ok.txt': 'ok0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', BASE.replace('l2', 'AGENT2'));
      await t.edit('ok.txt', 'ok1\n');
    });
    const mine = BASE.replace('l2', 'AGENT2').replace('l7', 'MINE7');
    await h.env.write({ 'a.txt': mine });
    const [k] = await ops();
    const prev = await preview(k!);
    expect(itemOf(prev, 'a.txt')).toMatchObject({
      conflict: 'changed-since',
      selectable: true,
      selectedByDefault: false,
      note: 'This file changed after the last recorded state. Restoring it discards that change.',
    });
    // The default selection leaves the conflicted file byte-identical.
    await restore(prev, defaults(prev));
    expect(await h.read('a.txt')).toBe(mine);
    expect(await h.read('ok.txt')).toBe('ok0\n');

    // Opting in overwrites it; what it held is kept and retrievable through the record.
    const again = await preview(k!);
    expect(defaults(again)).toEqual([]);
    const done = await restore(again, ['a.txt']);
    expect(await h.read('a.txt')).toBe(BASE);
    const record = h.ws.log.records().at(-1)!;
    expect(record.type === 'operation' && record.id === done.operationId).toBe(true);
    if (record.type === 'operation') {
      const before = record.changes[0]!.before;
      expect(before.kind === 'file' && before.stored && before.hash === sha(mine)).toBe(true);
      expect((await h.ws.blobs.get(sha(mine))).toString()).toBe(mine);
    }
  });

  it('flags a user edit recorded between turns, and the same for a mixed change', async () => {
    await h.env.write({ 'a.txt': BASE, 'm.txt': BASE, 'ok.txt': 'ok0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', BASE.replace('l2', 'AGENT2'));
      await t.edit('ok.txt', 'ok1\n');
    });
    const [k] = await ops();
    // The user edits between the turns and the tracker sees it; then the agent edits again.
    const mine = BASE.replace('l2', 'AGENT2').replace('l7', 'MINE7');
    await h.userEdit({ 'a.txt': mine });
    const second = mine.replace('l4', 'AGENT4');
    await h.turn(async (t) => {
      await t.edit('a.txt', second);
      // The user saves over the agent's edit in the same turn: mixed.
      await t.edit('m.txt', BASE.replace('l3', 'AGENT3'));
      await t.userSave('m.txt', BASE.replace('l3', 'AGENT3').replace('l6', 'MINE6'));
    });
    const prev = await preview(k!);
    expect(itemOf(prev, 'a.txt')).toMatchObject({
      conflict: 'user-edit-between',
      selectable: true,
      selectedByDefault: false,
      note: "This file also contains changes that were not the agent's since that point. Restoring it discards them.",
    });
    expect(itemOf(prev, 'ok.txt').conflict).toBeUndefined();

    const [, second2] = await ops();
    const prev2 = await preview(second2!);
    expect(itemOf(prev2, 'm.txt')).toMatchObject({
      conflict: 'user-edit-between',
      selectedByDefault: false,
    });

    const before = await h.listing();
    await restore(prev, defaults(prev));
    expect(await h.read('a.txt')).toBe(second);
    expect(await h.read('ok.txt')).toBe('ok0\n');
    expect((await h.listing())['m.txt']).toBe(before['m.txt']);

    // Opting in: back to before the first turn, discarding the user's edit, which stays in the store.
    const again = await preview(k!);
    const done = await restore(again, ['a.txt']);
    expect(done.operationId).toBeDefined();
    expect(await h.read('a.txt')).toBe(BASE);
    expect((await h.ws.blobs.get(sha(second))).toString()).toBe(second);
  });
});

describe('tokens and states', () => {
  async function oneTurn(): Promise<OperationId> {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
    });
    return (await ops())[0]!;
  }

  it('refuses a token that is not the current preview, and one that went stale', async () => {
    const k = await oneTurn();
    expect(await h.svc.restore(h.key, k, 'made-up', [])).toEqual({ refused: OUT_OF_DATE_MESSAGE });
    const prev = await preview(k);
    // Any new record makes the preview stale.
    await h.turn((t) => t.edit('c.txt', 'c\n', 'Write'));
    expect(
      await h.svc.restore(h.key, prev.targetOperationId, prev.token, defaults(prev).map(p)),
    ).toEqual({
      refused: OUT_OF_DATE_MESSAGE,
    });
    expect(await h.read('a.txt')).toBe('a1\n');
    // A fresh preview works.
    const fresh = await preview(k);
    expect(fresh.token).not.toBe(prev.token);
    expect(
      'refused' in
        (await h.svc.restore(h.key, fresh.targetOperationId, fresh.token, defaults(fresh).map(p))),
    ).toBe(false);
    // A used token is gone.
    expect(await h.svc.restore(h.key, fresh.targetOperationId, fresh.token, [])).toEqual({
      refused: OUT_OF_DATE_MESSAGE,
    });
  });

  it('refuses a path that is not a selectable item, and writes nothing', async () => {
    const k = await oneTurn();
    const prev = await preview(k);
    const before = await h.listing();
    expect(
      await h.svc.restore(h.key, prev.targetOperationId, prev.token, [
        p('a.txt'),
        p('nothing.txt'),
      ]),
    ).toEqual({
      refused: NOT_SELECTABLE_MESSAGE,
    });
    expect(await h.listing()).toEqual(before);
  });

  it('refuses when the disk changed between the preview and the restore', async () => {
    const k = await oneTurn();
    const prev = await preview(k);
    await h.env.write({ 'a.txt': 'a1 and an edit made after the preview\n' });
    const before = await h.listing();
    expect(
      await h.svc.restore(h.key, prev.targetOperationId, prev.token, defaults(prev).map(p)),
    ).toEqual({
      refused: OUT_OF_DATE_MESSAGE,
    });
    expect(await h.listing()).toEqual(before);
  });

  it('refuses while an agent turn is running', async () => {
    const k = await oneTurn();
    const prev = await preview(k);
    const turn = new Turn(h.tracker, h.env);
    await turn.begin();
    try {
      expect(await h.svc.preview(h.key, k)).toEqual({ refused: BUSY_MESSAGE });
      expect(
        await h.svc.restore(h.key, prev.targetOperationId, prev.token, defaults(prev).map(p)),
      ).toEqual({
        refused: BUSY_MESSAGE,
      });
      expect(await h.svc.prune(h.key, h.env.settings)).toEqual({ removedRecords: 0 });
      expect(
        await h.svc.itemTexts(h.key, prev.targetOperationId, prev.token, p('a.txt')),
      ).toBeUndefined();
    } finally {
      await turn.end();
    }
    expect(await h.read('a.txt')).toBe('a1\n');
  });

  it('reports a path that fails mid-restore, applies the others, and writes one record', async () => {
    if (!posix || process.getuid?.() === 0) return;
    await h.env.write({ 'ok/a.txt': 'a0\n', 'locked/b.txt': 'b0\n', 'z.txt': 'z0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('ok/a.txt', 'a1\n');
      await t.edit('locked/b.txt', 'b1\n');
      await t.edit('z.txt', 'z1\n');
    });
    const [k] = await ops();
    const prev = await preview(k!);
    expect(defaults(prev)).toHaveLength(3);
    const records = h.ws.log.records().length;
    await fs.chmod(h.env.abs('locked'), 0o555);
    let result;
    try {
      result = await restore(prev, defaults(prev));
    } finally {
      await fs.chmod(h.env.abs('locked'), 0o755);
    }
    const byPath = new Map(result.items.map((i) => [i.path, i]));
    expect(byPath.get('ok/a.txt')).toMatchObject({ achieved: true });
    expect(byPath.get('z.txt')).toMatchObject({ achieved: true });
    expect(byPath.get('locked/b.txt')!.achieved).toBe(false);
    expect(byPath.get('locked/b.txt')!.detail).toContain('permission');
    expect(await h.read('ok/a.txt')).toBe('a0\n');
    expect(await h.read('z.txt')).toBe('z0\n');
    expect(await h.read('locked/b.txt')).toBe('b1\n');
    expect(Object.keys(await h.listing()).filter((n) => n.includes('.agentcanopy'))).toEqual([]);
    expect(h.ws.log.records().length).toBe(records + 1);
    const record = h.ws.log.records().at(-1)!;
    if (record.type !== 'operation') throw new Error('not an operation');
    expect(record.changes.map((c) => c.path).sort()).toEqual(['ok/a.txt', 'z.txt']);
    expect(record.notes).toHaveLength(1);
    expect(record.notes[0]).toContain('locked/b.txt');
  });

  it('puts a symlink back where the agent replaced it with a file', async () => {
    if (!posix) return;
    await h.env.write({ 'target.txt': 't\n' });
    await fs.symlink('target.txt', h.env.abs('link'));
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('link'));
        await fs.writeFile(h.env.abs('link'), 'now a file\n');
      }),
    );
    const [k] = await ops();
    const prev = await preview(k!);
    expect(itemOf(prev, 'link')).toMatchObject({ action: 'write' });
    await restore(prev, defaults(prev));
    expect(await fs.readlink(h.env.abs('link'))).toBe('target.txt');
  });
});

describe('item texts', () => {
  it('gives both sides of a text item, the empty text for an absent side, and nothing for binary', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'x.bin': Buffer.from([0, 1]), 'gone.txt': 'gone\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('new.txt', 'new\n', 'Write');
      await t.edit('x.bin', Buffer.from([0, 2]));
      await t.command(async () => {
        await fs.rm(h.env.abs('gone.txt'));
      });
    });
    const [k] = await ops();
    const prev = await preview(k!);
    const texts = (path: string) =>
      h.svc.itemTexts(h.key, prev.targetOperationId, prev.token, p(path));
    expect(await texts('a.txt')).toEqual({ current: 'a1\n', target: 'a0\n' });
    expect(await texts('new.txt')).toEqual({ current: 'new\n', target: '' });
    expect(await texts('gone.txt')).toEqual({ current: '', target: 'gone\n' });
    expect(await texts('x.bin')).toBeUndefined();
    expect(await texts('not-an-item.txt')).toBeUndefined();
    expect(
      await h.svc.itemTexts(h.key, prev.targetOperationId, 'other-token', p('a.txt')),
    ).toBeUndefined();
    expect(
      await h.svc.itemTexts('nope' as never, prev.targetOperationId, prev.token, p('a.txt')),
    ).toBeUndefined();
    // After a change to the disk the preview is stale.
    await h.env.write({ 'a.txt': 'changed\n' });
    expect(await texts('a.txt')).toBeUndefined();
  });
});

describe('events', () => {
  it('tells listeners after a restore and when the caller says the log changed', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    let calls = 0;
    const off = h.svc.onDidChange(() => {
      calls += 1;
    });
    h.svc.changed(h.key);
    expect(calls).toBe(1);
    const [k] = await ops();
    const prev = await preview(k!);
    await restore(prev, defaults(prev));
    expect(calls).toBe(2);
    off();
    h.svc.changed(h.key);
    expect(calls).toBe(2);
    expect(rejectRecords(h.ws)).toHaveLength(0);
  });
});
