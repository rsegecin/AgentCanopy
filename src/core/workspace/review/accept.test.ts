import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha } from '../tracker/test-support';
import { OUT_OF_DATE_MESSAGE, NOT_PENDING_MESSAGE } from './engine';
import { makeHarness, p, type Harness } from './test-helpers';

const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

/** Three separate regions of a file, so that an edit gives three hunks. */
const base = text('a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12');
const edited = text(
  'a1',
  'A2',
  'a3',
  'a4',
  'a5',
  'A6',
  'a7',
  'a8',
  'a9',
  'a10',
  'a11',
  'A12',
  'a13',
);

describe('accept', () => {
  it('accepts one file and writes nothing to the workspace', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
    });
    const before = await h.listing();
    await h.engine.acceptFile(h.key, p('a.txt'));
    expect(await h.listing()).toEqual(before);

    const entries = await h.entries();
    expect(entries.map((e) => [e.path, e.status])).toEqual([
      ['a.txt', 'accepted'],
      ['b.txt', 'pending'],
    ]);
    expect(entries[0]!.baseline).toMatchObject({ hash: sha('a1\n') });
    // Nothing more to accept for the accepted one, and nothing to reject.
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({
      status: 'refused',
      message: NOT_PENDING_MESSAGE,
    });
    expect(await h.listing()).toEqual(before);
  });

  it('accepts all pending entries in one record', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n', 'c.txt': 'c0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
      await t.edit('d.txt', 'new\n', 'Write');
    });
    const before = await h.listing();
    const records = h.ws.log.records().length;
    await h.engine.acceptAll(h.key);
    expect(h.ws.log.records().length).toBe(records + 1);
    const last = h.ws.log.records().at(-1)!;
    expect(last.type).toBe('review');
    if (last.type === 'review') {
      expect(last.accepted.map((a) => a.path)).toEqual(['a.txt', 'b.txt', 'd.txt']);
      expect(last.accepted.every((a) => a.whole)).toBe(true);
    }
    expect((await h.entries()).every((e) => e.status === 'accepted')).toBe(true);
    expect(await h.listing()).toEqual(before);
  });

  it('records what is on disk now when the file changed since the agent left it', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    // The user edits; the tracker has not looked yet.
    await h.env.write({ 'a.txt': 'a1 and the user\n' });
    await h.engine.acceptFile(h.key, p('a.txt'));
    const entry = (await h.entries())[0]!;
    expect(entry.status).toBe('accepted');
    expect(entry.baseline).toMatchObject({ hash: sha('a1 and the user\n'), stored: true });
    expect(await h.ws.blobs.has(sha('a1 and the user\n'))).toBe(true);
    expect(await h.read('a.txt')).toBe('a1 and the user\n');
  });

  it('ignores a path that is not pending', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    const records = h.ws.log.records().length;
    await h.engine.acceptFile(h.key, p('a.txt'));
    await h.engine.acceptAll(h.key);
    expect(h.ws.log.records().length).toBe(records);
  });

  it('accepts hunk by hunk until nothing is pending, never touching the file', async () => {
    await h.env.write({ 'a.ts': base });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', edited));
    const before = await h.listing();

    let hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(hunks).toHaveLength(3);
    // Accept the middle one first.
    expect(await h.engine.acceptHunk(h.key, p('a.ts'), hunks[1]!.id)).toEqual({ status: 'done' });
    let entry = (await h.entries())[0]!;
    expect(entry.status).toBe('pending');
    expect(entry.baseline).toMatchObject({
      stored: true,
      hash: sha(base.replace('a6', 'A6')),
    });
    expect(entry.linesAdded).toBe(3);
    hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(hunks).toHaveLength(2);

    expect(await h.engine.acceptHunk(h.key, p('a.ts'), hunks[0]!.id)).toEqual({ status: 'done' });
    hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(hunks).toHaveLength(1);
    expect(await h.listing()).toEqual(before);

    expect(await h.engine.acceptHunk(h.key, p('a.ts'), hunks[0]!.id)).toEqual({ status: 'done' });
    entry = (await h.entries())[0]!;
    expect(entry.status).toBe('accepted');
    expect(entry.baseline).toMatchObject({ hash: sha(edited) });
    expect(await h.engine.hunks(h.key, p('a.ts'))).toEqual([]);
    expect(await h.listing()).toEqual(before);

    // The same sequence is what a new engine derives from the log.
    expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
  });

  it('accepts the only hunk of a created file as a whole, and of a deleted file as an absent baseline', async () => {
    await h.env.write({ 'gone.txt': 'bye\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('new.txt', 'hello\n', 'Write');
      await t.command(async () => {
        const { promises: fs } = await import('node:fs');
        await fs.rm(h.env.abs('gone.txt'));
      });
    });
    for (const path of ['new.txt', 'gone.txt']) {
      const hunks = await h.engine.hunks(h.key, p(path));
      expect(hunks).toHaveLength(1);
      expect(await h.engine.acceptHunk(h.key, p(path), hunks[0]!.id)).toEqual({ status: 'done' });
    }
    const entries = await h.entries();
    expect(entries.map((e) => [e.path, e.status])).toEqual([
      ['gone.txt', 'accepted'],
      ['new.txt', 'accepted'],
    ]);
    expect(entries[0]!.baseline).toEqual({ kind: 'absent' });
  });

  it('refuses a stale hunk id and an unknown one', async () => {
    await h.env.write({ 'a.ts': base });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', edited));
    const stale = await h.engine.hunks(h.key, p('a.ts'));
    const before = await h.listing();

    const unknown = await h.engine.acceptHunk(h.key, p('a.ts'), 'nope');
    expect(unknown).toEqual({ status: 'refused', message: OUT_OF_DATE_MESSAGE });

    // After one is accepted, the ids of the others are out of date.
    expect(await h.engine.acceptHunk(h.key, p('a.ts'), stale[0]!.id)).toEqual({ status: 'done' });
    expect(await h.engine.acceptHunk(h.key, p('a.ts'), stale[1]!.id)).toEqual({
      status: 'refused',
      message: OUT_OF_DATE_MESSAGE,
    });
    // So is every id once the file has changed.
    const fresh = await h.engine.hunks(h.key, p('a.ts'));
    await h.env.write({ 'a.ts': `${edited}more\n` });
    expect(await h.engine.acceptHunk(h.key, p('a.ts'), fresh[0]!.id)).toEqual({
      status: 'refused',
      message: OUT_OF_DATE_MESSAGE,
    });
    expect(await h.read('a.ts')).toBe(`${edited}more\n`);
    expect(Object.keys(await h.listing())).toEqual(Object.keys(before));
  });

  it('gives no hunks for a binary file, and refuses to accept by hunk', async () => {
    await h.env.write({ 'x.bin': Buffer.from([0, 1, 2]) });
    await h.sync();
    await h.turn((t) => t.edit('x.bin', Buffer.from([0, 1, 3])));
    expect(await h.engine.hunks(h.key, p('x.bin'))).toEqual([]);
    expect((await h.engine.acceptHunk(h.key, p('x.bin'), 'x')).status).toBe('refused');
  });
});

describe('what the engine reports', () => {
  it('gives the baseline content of a path', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'x.bin': Buffer.from([0, 9]) });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('x.bin', Buffer.from([0, 8]));
      await t.edit('n.txt', 'n\n', 'Write');
    });
    const a = await h.engine.baselineContent(h.key, p('a.txt'));
    expect(a.kind === 'content' && Buffer.from(a.data).toString()).toBe('a0\n');
    expect(a).toMatchObject({ binary: false });
    expect(await h.engine.baselineContent(h.key, p('x.bin'))).toMatchObject({
      kind: 'content',
      binary: true,
    });
    expect(await h.engine.baselineContent(h.key, p('n.txt'))).toEqual({ kind: 'absent' });
    expect(await h.engine.baselineContent(h.key, p('nothing.txt'))).toEqual({
      kind: 'unavailable',
    });
  });

  it('turns a path into an absolute one, and refuses one that escapes', () => {
    expect(h.engine.absolutePath(h.key, p('a/b.txt'))).toBe(h.env.abs('a/b.txt'));
    expect(h.engine.absolutePath(h.key, '../x')).toBeUndefined();
    expect(h.engine.absolutePath('other' as never, p('a'))).toBeUndefined();
  });

  it('tells listeners when something changes', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    let calls = 0;
    const off = h.engine.onDidChange(() => {
      calls += 1;
    });
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    // The host calls the engine's observer after the tracker's.
    const { context } = await import('../tracker/test-support');
    expect(await h.engine.observer.afterTurn?.(context(h.env), 'completed')).toEqual([]);
    expect(calls).toBe(1);
    await h.engine.acceptAll(h.key);
    expect(calls).toBe(2);
    off();
    await h.turn((t) => t.edit('a.txt', 'a2\n'));
    await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    expect(calls).toBe(2);
  });

  it('knows which paths were reverted since the last turn', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
    });
    expect(await h.engine.revertedSinceLastTurn(h.key)).toEqual([]);
    await h.engine.rejectFile(h.key, p('b.txt'), 'strict');
    expect(await h.engine.revertedSinceLastTurn(h.key)).toEqual(['b.txt']);
    await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    expect(await h.engine.revertedSinceLastTurn(h.key)).toEqual(['a.txt', 'b.txt']);
    await h.turn((t) => t.edit('c.txt', 'c\n', 'Write'));
    expect(await h.engine.revertedSinceLastTurn(h.key)).toEqual([]);
  });

  it('answers for an unknown folder without throwing', async () => {
    const key = 'nope' as never;
    expect(await h.engine.entries(key)).toEqual([]);
    expect(await h.engine.hunks(key, p('a'))).toEqual([]);
    expect(await h.engine.revertedSinceLastTurn(key)).toEqual([]);
    expect(await h.engine.rejectFile(key, p('a'), 'strict')).toEqual({
      status: 'refused',
      message: NOT_PENDING_MESSAGE,
    });
    expect(await h.engine.rejectAll(key, [])).toEqual({ rejected: [], failed: [] });
    expect(await h.engine.previewRejectAll(key, [])).toEqual({ willReject: [], cannot: [] });
    await h.engine.acceptAll(key);
  });
});
