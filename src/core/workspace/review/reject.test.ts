import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileState } from '../../../shared';
import { sha } from '../tracker/test-support';
import { readDisk, readToState } from './disk';
import {
  BUSY_MESSAGE,
  MIXED_MESSAGE,
  NOT_PENDING_MESSAGE,
  OUT_OF_DATE_MESSAGE,
  OVERLAP_MESSAGE,
} from './engine';
import {
  CHANGED_DURING_MESSAGE,
  CHANGED_WHILE_WRITING_MESSAGE,
  FOLDER_IN_THE_WAY_MESSAGE,
  LINK_PARENT_MESSAGE,
  NO_SPACE_MESSAGE,
} from './executor';
import { statesEqual } from './states';
import { makeHarness, p, rejectRecords, type Harness } from './test-helpers';
import { Turn } from '../tracker/test-support';

const posix = process.platform !== 'win32';
const text = (...lines: string[]): string => `${lines.join('\n')}\n`;

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

async function diskState(path: string): Promise<FileState> {
  const state = readToState(await readDisk(h.env.root, path), true);
  if (state === undefined) throw new Error('unexpected item on disk');
  return state;
}

/**
 * What must hold after a reject that wrote `path`: the log has a reject operation whose "after"
 * matches the disk, the tracker's next sync finds nothing foreign, and a new engine derives the same entries.
 */
async function expectCleanAftermath(path: string, before?: FileState): Promise<void> {
  const record = rejectRecords(h.ws).at(-1)!;
  const change = record.changes.find((c) => c.path === path)!;
  expect(change, 'a reject change for the path').toBeDefined();
  expect(statesEqual(change.after, await diskState(path))).toBe(true);
  if (before !== undefined) expect(statesEqual(change.before, before)).toBe(true);
  if (change.before.kind === 'file') expect(await h.ws.blobs.has(change.before.hash!)).toBe(true);
  expect(change.attribution).toBe('agent-tool');
  expect(record.status).toBe('complete');
  expect(record.notes).toEqual([]);

  const count = h.ws.log.records().length;
  await h.sync();
  expect(
    h.ws.log
      .records()
      .slice(count)
      .filter((r) => r.type === 'foreign-delta'),
  ).toEqual([]);
  expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
}

describe('reject a file', () => {
  it('puts a modified file back', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'other.txt': 'o\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    const agentState = await diskState('a.txt');
    const result = await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    expect(result).toEqual({ status: 'done' });
    expect(await h.read('a.txt')).toBe('a0\n');
    expect(await h.entries()).toEqual([]);
    await expectCleanAftermath('a.txt', agentState);
    // The agent's version was kept, so the rejection itself can be undone.
    expect((await h.ws.blobs.get(sha('a1\n'))).toString()).toBe('a1\n');
    // Rejecting again finds nothing pending.
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({
      status: 'refused',
      message: NOT_PENDING_MESSAGE,
    });
  });

  it('deletes a created file and leaves its directory', async () => {
    await h.env.write({ 'keep.txt': 'k\n' });
    await h.sync();
    await h.turn((t) => t.edit('dir/sub/new.txt', 'made by the agent\n', 'Write'));
    expect(await h.engine.rejectFile(h.key, p('dir/sub/new.txt'), 'strict')).toEqual({
      status: 'done',
    });
    const tree = await h.listing();
    expect(tree['dir/sub/new.txt']).toBeUndefined();
    expect(tree['dir/sub/']).toBe('dir');
    await expectCleanAftermath('dir/sub/new.txt');
    expect(await h.entries()).toEqual([]);
  });

  it('refuses to delete a created file that is not what the agent left, and leaves everything', async () => {
    await h.turn((t) => t.edit('new.txt', 'agent\n', 'Write'));
    await h.env.write({ 'new.txt': 'agent\nand the user\n' });
    const before = await h.listing();
    expect(await h.engine.rejectFile(h.key, p('new.txt'), 'strict')).toEqual({
      status: 'conflict',
      reason: 'changed-since',
      // The earlier content is "absent", so there is nothing to merge towards.
      canRevertAgentOnly: false,
    });
    expect(await h.listing()).toEqual(before);
    // The user's file is also not removed by agent-only, and an overwrite removes it only on request.
    expect((await h.engine.rejectFile(h.key, p('new.txt'), 'agent-only')).status).toBe('refused');
    expect(await h.listing()).toEqual(before);
    expect(await h.engine.rejectFile(h.key, p('new.txt'), 'overwrite')).toEqual({ status: 'done' });
    expect((await h.listing())['new.txt']).toBeUndefined();
  });

  it('recreates a deleted file with its content and mode', async () => {
    await h.env.write({ 'bin/run.sh': '#!/bin/sh\necho hi\n' });
    if (posix) await fs.chmod(h.env.abs('bin/run.sh'), 0o755);
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('bin/run.sh'));
      }),
    );
    expect((await h.entry('bin/run.sh'))?.changeType).toBe('deleted');
    expect(await h.engine.rejectFile(h.key, p('bin/run.sh'), 'strict')).toEqual({ status: 'done' });
    expect(await h.read('bin/run.sh')).toBe('#!/bin/sh\necho hi\n');
    if (posix) expect((await fs.stat(h.env.abs('bin/run.sh'))).mode & 0o777).toBe(0o755);
    await expectCleanAftermath('bin/run.sh', { kind: 'absent' });
  });

  it('recreates a file in a directory that is gone too', async () => {
    await h.env.write({ 'd/e/f.txt': 'deep\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d'), { recursive: true });
      }),
    );
    expect(await h.engine.rejectFile(h.key, p('d/e/f.txt'), 'strict')).toEqual({ status: 'done' });
    expect(await h.read('d/e/f.txt')).toBe('deep\n');
  });

  it('restores a mode change', async () => {
    if (!posix) return;
    await h.env.write({ 'run.sh': 'x\n' });
    await fs.chmod(h.env.abs('run.sh'), 0o644);
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.chmod(h.env.abs('run.sh'), 0o755);
      }),
    );
    expect(await h.engine.rejectFile(h.key, p('run.sh'), 'strict')).toEqual({ status: 'done' });
    expect((await fs.stat(h.env.abs('run.sh'))).mode & 0o777).toBe(0o644);
    expect(await h.read('run.sh')).toBe('x\n');
  });

  it('puts a symlink back, and a file back over a symlink', async () => {
    if (!posix) return;
    await h.env.write({ 'target.txt': 'target\n', 'file.txt': 'was a file\n' });
    await fs.symlink('target.txt', h.env.abs('link'));
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('link'));
        await fs.writeFile(h.env.abs('link'), 'now a file\n');
        await fs.rm(h.env.abs('file.txt'));
        await fs.symlink('target.txt', h.env.abs('file.txt'));
      }),
    );
    expect((await h.entry('link'))?.changeType).toBe('type');
    expect((await h.entry('file.txt'))?.changeType).toBe('type');
    expect(await h.engine.rejectFile(h.key, p('link'), 'strict')).toEqual({ status: 'done' });
    expect(await fs.readlink(h.env.abs('link'))).toBe('target.txt');
    await expectCleanAftermath('link');
    expect(await h.engine.rejectFile(h.key, p('file.txt'), 'strict')).toEqual({ status: 'done' });
    expect((await fs.lstat(h.env.abs('file.txt'))).isFile()).toBe(true);
    expect(await h.read('file.txt')).toBe('was a file\n');
    // The target the link pointed at was never written through.
    expect(await h.read('target.txt')).toBe('target\n');
    await expectCleanAftermath('file.txt');
  });

  it('is done without writing when the file is already as it was before the agent', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    // The user put it back by hand; the tracker has not looked yet.
    await h.env.write({ 'a.txt': 'a0\n' });
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({ status: 'done' });
    expect(await h.read('a.txt')).toBe('a0\n');
    expect(await h.entries()).toEqual([]);
  });
});

describe('reject a file the user changed since', () => {
  const original = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6');
  const agent = original.replace('l5', 'AGENT5');

  async function setup(): Promise<void> {
    await h.env.write({ 'a.txt': original });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', agent));
  }

  it('strict refuses, writes nothing and says agent-only is possible', async () => {
    await setup();
    await h.env.write({ 'a.txt': agent.replace('l1', 'USER1') });
    const before = await h.listing();
    const records = h.ws.log.records().length;
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({
      status: 'conflict',
      reason: 'changed-since',
      canRevertAgentOnly: true,
    });
    expect(await h.listing()).toEqual(before);
    expect(h.ws.log.records().length).toBe(records);
  });

  it('agent-only keeps the later edit and removes the agent change', async () => {
    await setup();
    const user = agent.replace('l1', 'USER1');
    await h.env.write({ 'a.txt': user });
    const userState = await diskState('a.txt');
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'agent-only')).toEqual({ status: 'done' });
    expect(await h.read('a.txt')).toBe(original.replace('l1', 'USER1'));
    // What the user had was kept in the store, and the entry is gone: what is left is the user's own work.
    await expectCleanAftermath('a.txt', userState);
    expect(await h.ws.blobs.has(sha(user))).toBe(true);
    expect(await h.entries()).toEqual([]);
    // Rejecting again must find nothing to take away from the user.
    expect((await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).status).toBe('refused');
    expect(await h.read('a.txt')).toBe(original.replace('l1', 'USER1'));
  });

  it('agent-only refuses when the later edit overlaps the agent change', async () => {
    await setup();
    await h.env.write({ 'a.txt': agent.replace('AGENT5', 'USER5') });
    const before = await h.listing();
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'agent-only')).toEqual({
      status: 'refused',
      message: OVERLAP_MESSAGE,
    });
    expect(await h.listing()).toEqual(before);
    expect(rejectRecords(h.ws)).toHaveLength(0);
  });

  it('overwrite puts the earlier version back whatever is there, keeping what was there', async () => {
    await setup();
    const user = agent.replace('AGENT5', 'USER5');
    await h.env.write({ 'a.txt': user });
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'overwrite')).toEqual({ status: 'done' });
    expect(await h.read('a.txt')).toBe(original);
    await expectCleanAftermath('a.txt');
    expect((await h.ws.blobs.get(sha(user))).toString()).toBe(user);
    expect(await h.entries()).toEqual([]);
  });

  it('says agent-only is not possible when the file is binary', async () => {
    await h.env.write({ 'x.bin': Buffer.from([0, 1]) });
    await h.sync();
    await h.turn((t) => t.edit('x.bin', Buffer.from([0, 2])));
    await h.env.write({ 'x.bin': Buffer.from([0, 3]) });
    expect(await h.engine.rejectFile(h.key, p('x.bin'), 'strict')).toEqual({
      status: 'conflict',
      reason: 'changed-since',
      canRevertAgentOnly: false,
    });
    expect((await h.engine.rejectFile(h.key, p('x.bin'), 'agent-only')).status).toBe('refused');
  });

  it('treats a deleted file the user recreated as changed since, and a folder there as refused', async () => {
    await h.env.write({ 'd.txt': 'was here\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d.txt'));
      }),
    );
    await h.env.write({ 'd.txt': 'the user wrote this\n' });
    expect(await h.engine.rejectFile(h.key, p('d.txt'), 'strict')).toEqual({
      status: 'conflict',
      reason: 'changed-since',
      canRevertAgentOnly: false,
    });
    expect(await h.read('d.txt')).toBe('the user wrote this\n');
    expect(await h.engine.rejectFile(h.key, p('d.txt'), 'overwrite')).toEqual({ status: 'done' });
    expect(await h.read('d.txt')).toBe('was here\n');
  });

  it('refuses a folder at the path of a deleted file, in every mode', async () => {
    await h.env.write({ 'd.txt': 'was here\n' });
    await h.sync();
    await h.turn((t) =>
      t.command(async () => {
        await fs.rm(h.env.abs('d.txt'));
      }),
    );
    await h.env.write({ 'd.txt/inner.txt': 'precious\n' });
    const before = await h.listing();
    expect((await h.engine.rejectFile(h.key, p('d.txt'), 'strict')).status).toBe('conflict');
    expect(await h.engine.rejectFile(h.key, p('d.txt'), 'overwrite')).toEqual({
      status: 'refused',
      message: FOLDER_IN_THE_WAY_MESSAGE,
    });
    expect((await h.engine.rejectFile(h.key, p('d.txt'), 'agent-only')).status).toBe('refused');
    expect(await h.listing()).toEqual(before);
  });
});

describe('reject refuses when it must', () => {
  it('refuses a file with unsaved editor changes, in every mode', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    h.editor.dirty.add(h.env.abs('a.txt'));
    const before = await h.listing();
    for (const mode of ['strict', 'agent-only', 'overwrite'] as const) {
      expect(await h.engine.rejectFile(h.key, p('a.txt'), mode)).toEqual({
        status: 'conflict',
        reason: 'unsaved-editor',
        canRevertAgentOnly: false,
      });
    }
    expect(await h.listing()).toEqual(before);
    h.editor.dirty.clear();
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({ status: 'done' });
  });

  it('refuses a file whose earlier content was not kept', async () => {
    const small = await makeHarness({ settings: { snapshotMaxFileBytes: 100 } });
    try {
      const big = 'x'.repeat(2000);
      await small.env.write({ 'big.txt': big });
      await small.sync();
      await small.turn(async (t) => {
        await t.shellWrite({ 'big.txt': `${big}y` });
      });
      const before = await small.listing();
      const entry = (await small.entries())[0]!;
      for (const mode of ['strict', 'agent-only', 'overwrite'] as const) {
        expect(await small.engine.rejectFile(small.key, p('big.txt'), mode)).toEqual({
          status: 'refused',
          message: entry.note,
        });
      }
      expect(await small.listing()).toEqual(before);
      expect(await small.engine.previewRejectAll(small.key, [])).toEqual({
        willReject: [],
        cannot: [{ path: 'big.txt', message: entry.note }],
      });
    } finally {
      await small.cleanup();
    }
  });

  it('will not write through a symlinked parent folder', async () => {
    if (!posix) return;
    await h.env.write({ 'sub/a.txt': 'a0\n', 'outside/placeholder.txt': 'p\n' });
    await h.sync();
    await h.turn((t) => t.edit('sub/a.txt', 'a1\n'));
    // The folder is replaced by a link to another folder holding the same file.
    await fs.rename(h.env.abs('sub'), h.env.abs('moved'));
    await fs.symlink('moved', h.env.abs('sub'));
    const before = await h.listing();
    const result = await h.engine.rejectFile(h.key, p('sub/a.txt'), 'strict');
    expect(result).toEqual({ status: 'refused', message: LINK_PARENT_MESSAGE });
    expect((await h.engine.rejectFile(h.key, p('sub/a.txt'), 'overwrite')).status).toBe('refused');
    expect(await h.listing()).toEqual(before);
    expect(await h.read('moved/a.txt')).toBe('a1\n');
  });

  it('leaves a file that does not read back as written exactly as it is, and keeps a copy of it', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    // Something else is what ends up in the file.
    h.hooks.filterWrite = () => Buffer.from('somebody else wrote this\n');
    const result = await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    expect(result).toEqual({ status: 'refused', message: CHANGED_WHILE_WRITING_MESSAGE });
    // Not written over: it is as found, no stray temporary file, and it is kept in the store.
    expect(await h.read('a.txt')).toBe('somebody else wrote this\n');
    expect(Object.keys(await h.listing())).toEqual(['a.txt']);
    expect(await h.ws.blobs.has(sha('somebody else wrote this\n'))).toBe(true);
    // The log says what is there, with a note, so that the entry does not claim otherwise.
    const record = rejectRecords(h.ws).at(-1)!;
    expect(record.notes).toHaveLength(1);
    expect(record.changes[0]!.before).toMatchObject({ hash: sha('a1\n') });
    expect(record.changes[0]!.after).toMatchObject({ hash: sha('somebody else wrote this\n') });
    const count = h.ws.log.records().length;
    await h.sync();
    expect(
      h.ws.log
        .records()
        .slice(count)
        .filter((r) => r.type === 'foreign-delta'),
    ).toEqual([]);
  });

  it('refuses when the file changes between the check and the rename', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    h.hooks.beforeRename = async () => {
      await fs.writeFile(h.env.abs('a.txt'), 'the user typed this just now\n');
    };
    const result = await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    expect(result).toEqual({ status: 'refused', message: CHANGED_DURING_MESSAGE });
    expect(await h.read('a.txt')).toBe('the user typed this just now\n');
    expect(Object.keys(await h.listing())).toEqual(['a.txt']);
    expect(rejectRecords(h.ws)).toHaveLength(0);
  });

  it('refuses when there is not enough free space', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    h.hooks.freeBytes = () => Promise.resolve(10);
    const before = await h.listing();
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({
      status: 'refused',
      message: NO_SPACE_MESSAGE,
    });
    expect(await h.listing()).toEqual(before);
  });

  it('refuses while an agent turn is running, in every writing method', async () => {
    await h.env.write({ 'a.txt': base, 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', edited);
      await t.edit('b.txt', 'b1\n');
    });
    const hunks = await h.engine.hunks(h.key, p('a.txt'));
    const turn = new Turn(h.tracker, h.env);
    await turn.begin();
    try {
      const busy = { status: 'refused', message: BUSY_MESSAGE };
      const before = await h.listing();
      const records = h.ws.log.records().length;
      expect(await h.engine.rejectFile(h.key, p('b.txt'), 'strict')).toEqual(busy);
      expect(await h.engine.rejectHunk(h.key, p('a.txt'), hunks[0]!.id)).toEqual(busy);
      expect(await h.engine.acceptHunk(h.key, p('a.txt'), hunks[0]!.id)).toEqual(busy);
      expect(await h.engine.rejectAll(h.key, [])).toEqual({
        rejected: [],
        failed: [
          { path: 'a.txt', message: BUSY_MESSAGE },
          { path: 'b.txt', message: BUSY_MESSAGE },
        ],
      });
      expect((await h.engine.previewRejectAll(h.key, [])).willReject).toEqual([]);
      await h.engine.acceptFile(h.key, p('b.txt'));
      await h.engine.acceptAll(h.key);
      expect(await h.listing()).toEqual(before);
      expect(h.ws.log.records().length).toBe(records);
    } finally {
      await turn.end();
    }
    // Afterwards it works.
    expect(await h.engine.rejectFile(h.key, p('b.txt'), 'strict')).toEqual({ status: 'done' });
  });
});

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

describe('reject a hunk', () => {
  it('rejects one of three hunks, then the others, until the file is as it was', async () => {
    await h.env.write({ 'a.ts': base });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', edited));

    let hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(hunks).toHaveLength(3);
    const first = await diskState('a.ts');
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), hunks[1]!.id)).toEqual({ status: 'done' });
    expect(await h.read('a.ts')).toBe(edited.replace('A6', 'a6'));
    await expectCleanAftermath('a.ts', first);
    expect((await h.entry('a.ts'))?.status).toBe('pending');

    hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(hunks).toHaveLength(2);
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), hunks[1]!.id)).toEqual({ status: 'done' });
    expect(await h.read('a.ts')).toBe(
      edited.replace('A6', 'a6').replace('A12', 'a12').replace('a13\n', ''),
    );
    expect((await h.entry('a.ts'))?.status).toBe('pending');

    hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(hunks).toHaveLength(1);
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), hunks[0]!.id)).toEqual({ status: 'done' });
    expect(await h.read('a.ts')).toBe(base);
    expect(await h.entries()).toEqual([]);
    expect(rejectRecords(h.ws)).toHaveLength(3);
    await expectCleanAftermath('a.ts');
  });

  it('keeps CRLF endings and a missing final newline', async () => {
    const crlf = 'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix';
    const changed = 'one\r\nTWO\r\nthree\r\nfour\r\nfive\r\nSIX';
    await h.env.write({ 'w.txt': crlf });
    await h.sync();
    await h.turn((t) => t.edit('w.txt', changed));
    const hunks = await h.engine.hunks(h.key, p('w.txt'));
    expect(hunks).toHaveLength(2);
    expect(await h.engine.rejectHunk(h.key, p('w.txt'), hunks[0]!.id)).toEqual({ status: 'done' });
    expect(await fs.readFile(h.env.abs('w.txt'), 'utf8')).toBe(
      'one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nSIX',
    );
    const rest = await h.engine.hunks(h.key, p('w.txt'));
    expect(await h.engine.rejectHunk(h.key, p('w.txt'), rest[0]!.id)).toEqual({ status: 'done' });
    expect((await fs.readFile(h.env.abs('w.txt'))).equals(Buffer.from(crlf))).toBe(true);
    expect(await h.entries()).toEqual([]);
  });

  it('keeps the mode of the file it writes', async () => {
    if (!posix) return;
    await h.env.write({ 'a.ts': base });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', edited));
    await fs.chmod(h.env.abs('a.ts'), 0o600);
    const hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), hunks[0]!.id)).toEqual({ status: 'done' });
    expect((await fs.stat(h.env.abs('a.ts'))).mode & 0o777).toBe(0o600);
  });

  it('refuses a stale or unknown hunk id and writes nothing', async () => {
    await h.env.write({ 'a.ts': base });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', edited));
    const hunks = await h.engine.hunks(h.key, p('a.ts'));
    const before = await h.listing();
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), 'unknown')).toEqual({
      status: 'refused',
      message: OUT_OF_DATE_MESSAGE,
    });
    // The user edits the file after the hunks were listed.
    await h.env.write({ 'a.ts': edited.replace('a3', 'user3') });
    const edit = await h.listing();
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), hunks[0]!.id)).toEqual({
      status: 'refused',
      message: OUT_OF_DATE_MESSAGE,
    });
    expect(await h.listing()).toEqual(edit);
    expect(edit).not.toEqual(before);
  });

  it('refuses a file with unsaved editor changes', async () => {
    await h.env.write({ 'a.ts': base });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', edited));
    const hunks = await h.engine.hunks(h.key, p('a.ts'));
    h.editor.dirty.add(h.env.abs('a.ts'));
    const before = await h.listing();
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), hunks[0]!.id)).toEqual({
      status: 'conflict',
      reason: 'unsaved-editor',
      canRevertAgentOnly: false,
    });
    expect(await h.listing()).toEqual(before);
  });

  it('removes a created file when its last hunk is rejected, and recreates a deleted one', async () => {
    await h.env.write({ 'gone.txt': 'was here\nreally\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('new.txt', 'hello\nworld\n', 'Write');
      await t.command(async () => {
        await fs.rm(h.env.abs('gone.txt'));
      });
    });
    const created = await h.engine.hunks(h.key, p('new.txt'));
    expect(await h.engine.rejectHunk(h.key, p('new.txt'), created[0]!.id)).toEqual({
      status: 'done',
    });
    expect((await h.listing())['new.txt']).toBeUndefined();
    const deleted = await h.engine.hunks(h.key, p('gone.txt'));
    expect(deleted).toHaveLength(1);
    expect(await h.engine.rejectHunk(h.key, p('gone.txt'), deleted[0]!.id)).toEqual({
      status: 'done',
    });
    expect(await h.read('gone.txt')).toBe('was here\nreally\n');
    expect(await h.entries()).toEqual([]);
  });

  it('refuses a hunk of a file the user edited since, until the tracker has separated the edit', async () => {
    await h.env.write({ 'a.ts': base });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', edited));
    const user = edited.replace('a9', 'USER9');
    await h.env.write({ 'a.ts': user });
    // Against the baseline, the user's line is a hunk of its own, and a hunk might swallow it.
    const hunks = await h.engine.hunks(h.key, p('a.ts'));
    expect(hunks.length).toBe(4);
    const agentHunk = hunks.find((x) => x.currentLines.includes('A6\n'))!;
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), agentHunk.id)).toEqual({
      status: 'conflict',
      reason: 'changed-since',
      canRevertAgentOnly: true,
    });
    expect(await h.read('a.ts')).toBe(user);

    // Once the tracker has seen the edit, the baseline holds it and only the agent's hunks are left.
    await h.sync();
    const rest = await h.engine.hunks(h.key, p('a.ts'));
    expect(rest).toHaveLength(3);
    const again = rest.find((x) => x.currentLines.includes('A6\n'))!;
    expect(await h.engine.rejectHunk(h.key, p('a.ts'), again.id)).toEqual({ status: 'done' });
    expect(await h.read('a.ts')).toBe(user.replace('A6', 'a6'));
  });
});

describe('reject all', () => {
  async function makeMixedTurn(): Promise<void> {
    await h.env.write({
      'tool.txt': 'tool0\n',
      'cmd.txt': 'cmd0\n',
      'loose.txt': 'loose0\n',
      'mixed.txt': 'mixed0\n',
      'untouched.txt': 'u0\n',
    });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('tool.txt', 'tool1\n');
      await t.edit('created.txt', 'created\n', 'Write');
      await t.shellWrite({ 'cmd.txt': 'cmd1\n' });
      // Changed with no tool behind it: unattributed.
      await h.env.write({ 'loose.txt': 'loose1\n' });
      await t.edit('mixed.txt', 'mixed-agent\n');
      await t.userSave('mixed.txt', 'mixed-user\n');
    });
  }

  it('rejects only what was surely the agent, and what was ticked on top of it', async () => {
    await makeMixedTurn();
    const attributions = Object.fromEntries(
      (await h.entries()).map((e) => [e.path, e.attribution]),
    );
    expect(attributions).toEqual({
      'tool.txt': 'agent-tool',
      'created.txt': 'agent-tool',
      'cmd.txt': 'agent-command',
      'loose.txt': 'unattributed',
      'mixed.txt': 'mixed',
    });

    const before = await h.listing();
    const preview = await h.engine.previewRejectAll(h.key, []);
    expect(preview).toEqual({ willReject: ['cmd.txt', 'created.txt', 'tool.txt'], cannot: [] });
    expect(await h.listing()).toEqual(before);

    const ops = h.ws.log.records().length;
    const result = await h.engine.rejectAll(h.key, []);
    expect([...result.rejected].sort()).toEqual(preview.willReject);
    expect(result.failed).toEqual([]);
    // One record for the call; deletions of created files come first.
    expect(h.ws.log.records().length).toBe(ops + 1);
    expect(rejectRecords(h.ws)[0]!.changes.map((c) => c.path)).toEqual([
      'created.txt',
      'cmd.txt',
      'tool.txt',
    ]);

    const after = await h.listing();
    expect(after['created.txt']).toBeUndefined();
    expect(await h.read('tool.txt')).toBe('tool0\n');
    expect(await h.read('cmd.txt')).toBe('cmd0\n');
    // Not in the set: untouched.
    expect(after['loose.txt']).toBe(before['loose.txt']);
    expect(after['mixed.txt']).toBe(before['mixed.txt']);
    expect(after['untouched.txt']).toBe(before['untouched.txt']);
    expect((await h.entries()).map((e) => e.path)).toEqual(['loose.txt', 'mixed.txt']);

    // Ticking an unattributed entry takes it in. A mixed one holds the user's own work: it is refused.
    const include = ['loose.txt', 'mixed.txt', 'nothing.txt'].map(p);
    expect(await h.engine.previewRejectAll(h.key, include)).toEqual({
      willReject: ['loose.txt'],
      cannot: [{ path: 'mixed.txt', message: MIXED_MESSAGE }],
    });
    const mixedBefore = (await h.listing())['mixed.txt'];
    const records = h.ws.log.records().length;
    const result2 = await h.engine.rejectAll(h.key, include);
    expect(result2.rejected).toEqual(['loose.txt']);
    expect(result2.failed).toEqual([{ path: 'mixed.txt', message: MIXED_MESSAGE }]);
    expect(h.ws.log.records().length).toBe(records + 1);
    expect(await h.read('loose.txt')).toBe('loose0\n');
    expect(await h.read('mixed.txt')).toBe('mixed-user\n');
    expect((await h.listing())['mixed.txt']).toBe(mixedBefore);
    expect((await h.entries()).map((e) => e.path)).toEqual(['mixed.txt']);
    expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
  });

  it('rejects what it can, writes one record for those, reports the rest and never falls back', async () => {
    await h.env.write({
      'ok1.txt': 'ok1-0\n',
      'ok2.txt': 'ok2-0\n',
      'edited.txt': 'e0\nmiddle\nend\n',
      'dirty.txt': 'd0\n',
      'folder.txt': 'f0\n',
      'bystander.txt': 'b0\n',
    });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('ok1.txt', 'ok1-1\n');
      await t.edit('ok2.txt', 'ok2-1\n');
      await t.edit('edited.txt', 'e1\nmiddle\nend\n');
      await t.edit('dirty.txt', 'd1\n');
      await t.edit('folder.txt', 'f1\n');
      await t.edit('new.txt', 'brand new\n', 'Write');
    });
    // After the agent: the user edits one file, has another open and dirty, and swaps a folder in.
    await h.env.write({ 'edited.txt': 'e1\nmiddle\nend\nuser line\n' });
    h.editor.dirty.add(h.env.abs('dirty.txt'));
    await fs.rm(h.env.abs('folder.txt'));
    await fs.mkdir(h.env.abs('folder.txt'));
    await h.env.write({ 'bystander.txt': 'b0 edited by the user\n' });
    const before = await h.listing();

    const preview = await h.engine.previewRejectAll(h.key, []);
    const records = h.ws.log.records().length;
    const result = await h.engine.rejectAll(h.key, []);
    expect([...result.rejected].sort()).toEqual(preview.willReject);
    expect(result.failed.map((f) => f.path).sort()).toEqual(
      preview.cannot.map((c) => c.path).sort(),
    );
    expect(result.rejected.sort()).toEqual(['new.txt', 'ok1.txt', 'ok2.txt']);
    const failures = new Map(result.failed.map((f) => [f.path, f.message]));
    expect(failures.get('edited.txt')).toContain('changed after the agent');
    expect(failures.get('dirty.txt')).toContain('unsaved changes');
    expect(failures.get('folder.txt')).toContain('changed after the agent');
    expect(h.ws.log.records().length).toBe(records + 1);
    expect(
      rejectRecords(h.ws)[0]!
        .changes.map((c) => c.path)
        .sort(),
    ).toEqual(['new.txt', 'ok1.txt', 'ok2.txt']);

    const after = await h.listing();
    const changed = Object.keys({ ...before, ...after })
      .filter((k) => before[k] !== after[k])
      .sort();
    expect(changed).toEqual(['new.txt', 'ok1.txt', 'ok2.txt']);
    expect(await h.read('edited.txt')).toBe('e1\nmiddle\nend\nuser line\n');
    expect(await h.read('bystander.txt')).toBe('b0 edited by the user\n');
    expect((await h.entries()).map((e) => e.path)).toEqual([
      'dirty.txt',
      'edited.txt',
      'folder.txt',
    ]);

    // The tracker finds the user's own changes, but nothing at a path that was rejected.
    const count = h.ws.log.records().length;
    await h.sync();
    const foreign = h.ws.log
      .records()
      .slice(count)
      .flatMap((r) => (r.type === 'foreign-delta' ? r.changes.map((c) => c.path) : []));
    for (const path of ['new.txt', 'ok1.txt', 'ok2.txt']) expect(foreign).not.toContain(path);
  });

  it('keeps an unattributed or mixed entry out unless it is ticked, in the preview as well', async () => {
    await makeMixedTurn();
    const preview = await h.engine.previewRejectAll(h.key, []);
    expect(preview.willReject).not.toContain('loose.txt');
    expect(preview.willReject).not.toContain('mixed.txt');
    expect(preview.cannot).toEqual([]);
  });

  it('shows what cannot be rejected, with a plain message', async () => {
    await h.env.write({ 'a.txt': 'a0\n', 'b.txt': 'b0\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.edit('b.txt', 'b1\n');
    });
    h.editor.dirty.add(h.env.abs('a.txt'));
    await h.env.write({ 'b.txt': 'b1 and more\n' });
    const preview = await h.engine.previewRejectAll(h.key, []);
    expect(preview.willReject).toEqual([]);
    expect(preview.cannot.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
    expect(preview.cannot.every((c) => c.message.length > 10)).toBe(true);
  });
});

describe('garbage collection', () => {
  it('keeps what review needs, including merged baselines, and every action still works', async () => {
    const { collectGarbage } = await import('../store');
    const original = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6');
    await h.env.write({ 'a.ts': original, 'b.ts': 'b0\n' });
    await h.sync();
    const t1 = original.replace('l5', 'AGENT5');
    await h.turn((t) => t.edit('a.ts', t1));
    await h.env.write({ 'a.ts': t1.replace('l1', 'USER1') });
    await h.turn(async (t) => {
      await t.edit('a.ts', t1.replace('l1', 'USER1').replace('l6', 'AGENT6'));
      await t.edit('b.ts', 'b1\n');
    });
    await h.engine.acceptFile(h.key, p('b.ts'));

    const entry = (await h.entries()).find((e) => e.path === 'a.ts')!;
    const merged = original.replace('l1', 'USER1');
    expect(entry.baseline).toMatchObject({ hash: sha(merged) });

    // Something kept only by a `preserved` list and something only by a review decision.
    const preservedHash = await h.ws.blobs.put(Buffer.from('a version the user saved mid-turn\n'));
    const hunkBaseline = await h.ws.blobs.put(Buffer.from('a hunk-accepted baseline\n'));
    const orphan = await h.ws.blobs.put(Buffer.from('nobody refers to me\n'));
    await h.ws.log.append({
      type: 'operation',
      id: 'preserved-op' as never,
      kind: 'agent-turn',
      at: 1,
      status: 'complete',
      changes: [],
      preserved: [
        {
          path: p('zz.txt'),
          state: {
            kind: 'file',
            hash: preservedHash,
            size: 34,
            mode: 0o644,
            stored: true,
            binary: false,
          },
        },
      ],
      notes: [],
    });
    await h.ws.log.append({
      type: 'review',
      id: 'review-x' as never,
      at: 2,
      accepted: [
        {
          path: p('zz.txt'),
          baseline: {
            kind: 'file',
            hash: hunkBaseline,
            size: 25,
            mode: 0o644,
            stored: true,
            binary: false,
          },
          whole: false,
        },
      ],
    });

    const referenced = await h.engine.referencedHashes(h.key);
    expect(referenced.has(sha(merged))).toBe(true);
    expect(referenced.has(preservedHash)).toBe(true);
    expect(referenced.has(hunkBaseline)).toBe(true);
    expect(referenced.has(orphan)).toBe(false);
    for (const entryOfIndex of h.ws.index().values()) {
      if (entryOfIndex.hash !== undefined) expect(referenced.has(entryOfIndex.hash)).toBe(true);
    }

    const result = await collectGarbage(h.ws.blobs, referenced);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await h.ws.blobs.has(orphan)).toBe(false);
    expect(await h.ws.blobs.has(sha(merged))).toBe(true);

    // The same answers, from the cached fold and from a fresh one, and the actions work.
    const fresh = h.newEngine();
    expect(await fresh.entries(h.key)).toEqual(await h.entries());
    expect(await fresh.rejectFile(h.key, p('a.ts'), 'strict')).toEqual({ status: 'done' });
    expect(await h.read('a.ts')).toBe(merged);
  });
});

describe("a mixed entry holds the user's own work", () => {
  const agentLines = text(
    'l1',
    'l2',
    'l3',
    'l4',
    'l5',
    'l6',
    'l7',
    'l8',
    'l9',
    'l10',
    'l11',
    'l12',
  );
  const agentVersion = agentLines.replace('l2', 'AGENT2').replace('l11', 'AGENT11');

  /** The agent edits a file and the user saves over it in the same turn: the tracker cannot tell them apart. */
  async function mixedTurn(): Promise<string> {
    await h.env.write({ 'm.txt': agentLines });
    await h.sync();
    const saved = agentVersion.replace('l6', 'USER6');
    await h.turn(async (t) => {
      await t.edit('m.txt', agentVersion);
      await t.userSave('m.txt', saved);
    });
    expect((await h.entry('m.txt'))?.attribution).toBe('mixed');
    expect(await h.read('m.txt')).toBe(saved);
    return saved;
  }

  it('strict does not write: the file is as the agent and the user left it, yet it is a conflict', async () => {
    const saved = await mixedTurn();
    const before = await h.listing();
    expect(await h.engine.rejectFile(h.key, p('m.txt'), 'strict')).toEqual({
      status: 'conflict',
      reason: 'uncertain-source',
      canRevertAgentOnly: false,
    });
    expect(await h.listing()).toEqual(before);
    expect(rejectRecords(h.ws)).toHaveLength(0);
    expect(await h.read('m.txt')).toBe(saved);
  });

  it('agent-only is refused with the overlap message', async () => {
    const saved = await mixedTurn();
    const before = await h.listing();
    expect(await h.engine.rejectFile(h.key, p('m.txt'), 'agent-only')).toEqual({
      status: 'refused',
      message: OVERLAP_MESSAGE,
    });
    expect(await h.listing()).toEqual(before);
    expect(await h.read('m.txt')).toBe(saved);
  });

  it("overwrite puts the baseline back, keeping the user's version in the store", async () => {
    const saved = await mixedTurn();
    expect(await h.engine.rejectFile(h.key, p('m.txt'), 'overwrite')).toEqual({ status: 'done' });
    expect(await h.read('m.txt')).toBe(agentLines);
    expect((await h.ws.blobs.get(sha(saved))).toString()).toBe(saved);
    expect(await h.entries()).toEqual([]);
  });

  it('rejectHunk is a conflict, after the stale-id check', async () => {
    const saved = await mixedTurn();
    const hunks = await h.engine.hunks(h.key, p('m.txt'));
    expect(hunks.length).toBeGreaterThan(1);
    const before = await h.listing();
    expect(await h.engine.rejectHunk(h.key, p('m.txt'), 'stale')).toEqual({
      status: 'refused',
      message: OUT_OF_DATE_MESSAGE,
    });
    expect(await h.engine.rejectHunk(h.key, p('m.txt'), hunks[0]!.id)).toEqual({
      status: 'conflict',
      reason: 'uncertain-source',
      canRevertAgentOnly: false,
    });
    expect(await h.listing()).toEqual(before);
    expect(await h.read('m.txt')).toBe(saved);
  });

  it('is reported as cannot by the preview and as failed by reject all, which writes nothing for it', async () => {
    await mixedTurn();
    const before = await h.listing();
    const records = h.ws.log.records().length;
    // Not in the default set.
    expect(await h.engine.previewRejectAll(h.key, [])).toEqual({ willReject: [], cannot: [] });
    expect(await h.engine.previewRejectAll(h.key, [p('m.txt')])).toEqual({
      willReject: [],
      cannot: [{ path: 'm.txt', message: MIXED_MESSAGE }],
    });
    expect(await h.engine.rejectAll(h.key, [p('m.txt')])).toEqual({
      rejected: [],
      failed: [{ path: 'm.txt', message: MIXED_MESSAGE }],
    });
    expect(await h.listing()).toEqual(before);
    expect(h.ws.log.records().length).toBe(records);
  });

  it('rejects a ticked unattributed entry in Reject all, but not on its own without a choice', async () => {
    await h.env.write({ 'u.txt': 'u0\n' });
    await h.sync();
    await h.turn(async () => {
      await h.env.write({ 'u.txt': 'u1\n' });
    });
    expect((await h.entry('u.txt'))?.attribution).toBe('unattributed');
    expect(await h.engine.previewRejectAll(h.key, [])).toEqual({ willReject: [], cannot: [] });
    expect(await h.engine.previewRejectAll(h.key, [p('u.txt')])).toEqual({
      willReject: ['u.txt'],
      cannot: [],
    });
    expect(await h.engine.rejectFile(h.key, p('u.txt'), 'strict')).toEqual({
      status: 'conflict',
      reason: 'uncertain-source',
      canRevertAgentOnly: false,
    });
    expect(await h.read('u.txt')).toBe('u1\n');
    expect(await h.engine.rejectAll(h.key, [p('u.txt')])).toEqual({
      rejected: ['u.txt'],
      failed: [],
    });
    expect(await h.read('u.txt')).toBe('u0\n');
  });
});
