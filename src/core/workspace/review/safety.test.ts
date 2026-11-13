import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectGarbage } from '../store';
import { sha, sleep } from '../tracker/test-support';
import {
  FAILED_MESSAGE,
  MIXED_MESSAGE,
  OUT_OF_DATE_MESSAGE,
  OVERLAP_MESSAGE,
  RECONSTRUCTED_MESSAGE,
} from './engine';
import { CHANGED_DURING_MESSAGE, CHANGED_WHILE_WRITING_MESSAGE } from './executor';
import { makeHarness, p, rejectRecords, type Harness } from './test-helpers';

const text = (...lines: string[]): string => `${lines.join('\n')}\n`;
const BASE = text('l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10');

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

/** What the controller does after a turn: collect garbage from inside the folder's queue. */
async function gc(): Promise<void> {
  await h.ws.exclusive(async () => {
    await collectGarbage(h.ws.blobs, await h.engine.referencedHashes(h.key));
  });
}

describe('garbage-collection roots', () => {
  it('keeps both copies of a pending configuration change, so that it can still be reverted', async () => {
    const before = '{"permissions":{}}\n';
    await h.env.write({
      '.gitignore': '.claude/settings.local.json\n',
      '.claude/settings.local.json': before,
      'a.txt': 'a0\n',
    });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('a.txt', 'a1\n');
      await t.shellWrite({
        '.claude/settings.local.json': '{"permissions":{"allow":["Bash(*)"]}}\n',
      });
    });
    const changes = h.tracker.configChanges(h.key);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.revertible).toBe(true);
    expect(await h.ws.blobs.has(sha(before))).toBe(true);

    await gc();
    expect(await h.ws.blobs.has(sha(before))).toBe(true);
    await h.tracker.resolveConfigChange(h.key, changes[0]!.id, 'revert');
    expect(await h.read('.claude/settings.local.json')).toBe(before);
  });

  it('throws for a folder it cannot see, instead of returning an empty set', async () => {
    await expect(h.engine.referencedHashes('nope' as never)).rejects.toThrow(
      'The folder is not open.',
    );
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    expect((await h.engine.referencedHashes(h.key)).size).toBeGreaterThan(0);
    // The tracker was disposed (the window is closing): nothing may be collected from it.
    await h.tracker.dispose();
    await expect(h.engine.referencedHashes(h.key)).rejects.toThrow('The folder is not open.');
  });
});

/** The directory a crashed turn leaves its journal in. */
function journalFile(): string {
  return join(h.env.storage, h.env.folder.key, 'journal.json');
}

async function crashedTurn(lastActivityAgoMs: number): Promise<void> {
  await fs.writeFile(
    journalFile(),
    JSON.stringify({
      turnId: 'turn-dead',
      conversationId: 'conv-1',
      startedAt: Date.now() - 120_000,
      lastActivityAt: Date.now() - lastActivityAgoMs,
      pid: null,
    }),
  );
}

type Kind = 'after-interruption' | 'recovery-born' | 'unattributed';

/** Makes one pending entry of the given kind, with the user's own work in it. */
async function uncertainEntry(kind: Kind): Promise<{ baseline: string; current: string }> {
  const baseline = text('l1', 'l2', 'l3');
  await h.env.write({ 'work.txt': baseline });
  await h.sync();
  if (kind === 'unattributed') {
    const current = text('l1', 'l2', 'l3', 'changed outside any tool');
    await h.turn(async () => {
      await h.env.write({ 'work.txt': current });
    });
    expect((await h.entry('work.txt'))?.attribution).toBe('unattributed');
    return { baseline, current };
  }
  // A turn was open when the window died. After-interruption: the file changed after its last sign
  // of life. Recovery-born: it changed before that, so it is only "unattributed" by its own label.
  await crashedTurn(kind === 'after-interruption' ? 60_000 : -60_000);
  const current = text('l1', 'l2', 'l3', 'hours of my own work after the crash');
  await h.env.write({ 'work.txt': current });
  expect((await h.tracker.recover(h.env.folder, h.env.settings)).recovered).toBe(true);
  const entry = await h.entry('work.txt');
  expect(entry?.attribution).toBe(
    kind === 'after-interruption' ? 'after-interruption' : 'unattributed',
  );
  return { baseline, current };
}

describe("entries that may hold the user's work need an explicit choice", () => {
  for (const kind of ['after-interruption', 'recovery-born', 'unattributed'] as const) {
    it(`${kind}: strict and hunk are conflicts, agent-only is refused, overwrite restores`, async () => {
      const { baseline, current } = await uncertainEntry(kind);
      const hunks = await h.engine.hunks(h.key, p('work.txt'));
      expect(hunks).toHaveLength(1);
      const before = await h.listing();
      const conflict = {
        status: 'conflict',
        reason: 'uncertain-source',
        canRevertAgentOnly: false,
      };

      expect(await h.engine.rejectFile(h.key, p('work.txt'), 'strict')).toEqual(conflict);
      // The stale-id refusal and the unsaved-editor check come first.
      expect(await h.engine.rejectHunk(h.key, p('work.txt'), 'stale')).toEqual({
        status: 'refused',
        message: OUT_OF_DATE_MESSAGE,
      });
      h.editor.dirty.add(h.env.abs('work.txt'));
      expect(await h.engine.rejectHunk(h.key, p('work.txt'), hunks[0]!.id)).toMatchObject({
        status: 'conflict',
        reason: 'unsaved-editor',
      });
      h.editor.dirty.clear();
      expect(await h.engine.rejectHunk(h.key, p('work.txt'), hunks[0]!.id)).toEqual(conflict);
      expect(await h.engine.rejectFile(h.key, p('work.txt'), 'agent-only')).toEqual({
        status: 'refused',
        message: OVERLAP_MESSAGE,
      });
      expect(await h.listing()).toEqual(before);
      expect(await h.read('work.txt')).toBe(current);
      expect(rejectRecords(h.ws)).toHaveLength(0);

      expect(await h.engine.rejectFile(h.key, p('work.txt'), 'overwrite')).toEqual({
        status: 'done',
      });
      expect(await h.read('work.txt')).toBe(baseline);
      // The user's version stays in the store.
      expect((await h.ws.blobs.get(sha(current))).toString()).toBe(current);
    });
  }

  it('Reject all: a ticked unattributed entry is rejected, the other kinds are reported with their message', async () => {
    // An unattributed entry (outside any tool), and entries born of a crash.
    await h.env.write({ 'loose.txt': 'loose0\n', 'late.txt': 'late0\n', 'early.txt': 'early0\n' });
    await h.sync();
    await h.turn(async () => {
      await h.env.write({ 'loose.txt': 'loose1\n' });
    });
    await crashedTurn(60_000);
    await h.env.write({ 'late.txt': 'late1\n' });
    await h.tracker.recover(h.env.folder, h.env.settings);
    expect((await h.entry('late.txt'))?.attribution).toBe('after-interruption');
    await crashedTurn(-60_000);
    await h.env.write({ 'early.txt': 'early1\n' });
    await h.tracker.recover(h.env.folder, h.env.settings);
    expect((await h.entry('early.txt'))?.attribution).toBe('unattributed');

    const include = ['loose.txt', 'late.txt', 'early.txt'].map(p);
    const before = await h.listing();
    const preview = await h.engine.previewRejectAll(h.key, include);
    expect(preview.willReject).toEqual(['loose.txt']);
    expect(preview.cannot).toEqual([
      { path: 'early.txt', message: RECONSTRUCTED_MESSAGE },
      { path: 'late.txt', message: RECONSTRUCTED_MESSAGE },
    ]);
    // Without ticking, none of them is in the set.
    expect(await h.engine.previewRejectAll(h.key, [])).toEqual({ willReject: [], cannot: [] });
    const result = await h.engine.rejectAll(h.key, include);
    expect(result.rejected).toEqual(['loose.txt']);
    expect(result.failed.map((f) => [f.path, f.message])).toEqual([
      ['early.txt', RECONSTRUCTED_MESSAGE],
      ['late.txt', RECONSTRUCTED_MESSAGE],
    ]);
    const after = await h.listing();
    expect(after['late.txt']).toBe(before['late.txt']);
    expect(after['early.txt']).toBe(before['early.txt']);
    expect(await h.read('loose.txt')).toBe('loose0\n');
  });

  it('Reject all names an unmerged entry with the mixed message', async () => {
    await h.env.write({ 'a.ts': BASE });
    await h.sync();
    const agent = BASE.replace('l2', 'AGENT2');
    await h.turn((t) => t.edit('a.ts', agent));
    // The user edits the line next to the agent's: the baseline cannot absorb it.
    await h.userEdit({ 'a.ts': agent.replace('l3', 'USER3') });
    expect((await h.entry('a.ts'))?.attribution).toBe('mixed');
    expect(await h.engine.previewRejectAll(h.key, [p('a.ts')])).toEqual({
      willReject: [],
      cannot: [{ path: 'a.ts', message: MIXED_MESSAGE }],
    });
  });

  it('keeps the reason changed-since for an ordinary file that differs from what the agent left', async () => {
    await h.env.write({ 'a.ts': BASE });
    await h.sync();
    await h.turn((t) => t.edit('a.ts', BASE.replace('l2', 'AGENT2')));
    await h.env.write({ 'a.ts': BASE.replace('l2', 'AGENT2').replace('l8', 'USER8') });
    expect(await h.engine.rejectFile(h.key, p('a.ts'), 'strict')).toEqual({
      status: 'conflict',
      reason: 'changed-since',
      canRevertAgentOnly: true,
    });
  });
});

describe('agent-only is not two records that can be torn apart', () => {
  it('survives a failure to write the second record: a later strict reject does nothing harmful', async () => {
    await h.env.write({ 'a.txt': BASE });
    await h.sync();
    const agent = BASE.replace('l2', 'AGENT2');
    await h.turn((t) => t.edit('a.txt', agent));
    // The user edits another part; the tracker has not seen it.
    await h.env.write({ 'a.txt': agent.replace('l7', 'USER7') });

    const realAppend = h.ws.appendRecord.bind(h.ws);
    const appended: string[] = [];
    h.ws.appendRecord = async (record) => {
      appended.push(
        record.type === 'operation'
          ? `operation:${record.kind}${record.changes.length === 0 ? ':preserve' : ''}`
          : record.type,
      );
      if (record.type === 'operation' && record.kind === 'reject' && record.changes.length > 0) {
        throw new Error('ENOSPC: no space left on device');
      }
      await realAppend(record);
    };
    let first;
    try {
      first = await h.engine.rejectFile(h.key, p('a.txt'), 'agent-only');
    } finally {
      h.ws.appendRecord = realAppend;
    }
    // What was there is preserved first, then the baseline moves; only the reject record is missing.
    expect(appended).toEqual(['operation:reject:preserve', 'review', 'operation:reject']);
    expect(first).toMatchObject({ status: 'refused' });
    expect((first as { message: string }).message).toContain('a.txt');
    const mine = BASE.replace('l7', 'USER7');
    expect(await h.read('a.txt')).toBe(mine);

    // A plain reject of whatever is still listed leaves the user's edit alone.
    const second = await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    expect(['done', 'refused', 'conflict']).toContain(second.status);
    expect(await h.read('a.txt')).toBe(mine);
    await h.sync();
    expect(await h.newEngine().entries(h.key)).toEqual([]);
    expect(await h.read('a.txt')).toBe(mine);
  });
});

describe('the executor does not write over what it did not see', () => {
  it('leaves a file that something else wrote right after the rename, and records it with a note', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    const userSave = 'a1\nthe user saved this line a moment ago\n';
    h.hooks.afterRename = async () => {
      await fs.writeFile(h.env.abs('a.txt'), userSave);
    };
    const result = await h.engine.rejectFile(h.key, p('a.txt'), 'strict');
    expect(result).toEqual({ status: 'refused', message: CHANGED_WHILE_WRITING_MESSAGE });
    expect(await h.read('a.txt')).toBe(userSave);
    expect(await h.ws.blobs.has(sha(userSave))).toBe(true);
    const record = rejectRecords(h.ws).at(-1)!;
    expect(record.changes[0]).toMatchObject({
      path: 'a.txt',
      before: { hash: sha('a1\n') },
      after: { hash: sha(userSave) },
    });
    expect(record.notes).toHaveLength(1);
    expect(Object.keys(await h.listing())).toEqual(['a.txt']);
    // The log and a fresh engine agree with the disk.
    expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
  });

  it('refuses to delete a file that was saved after the safety copy was taken', async () => {
    await h.turn((t) => t.edit('new.txt', 'agent\n', 'Write'));
    const userSave = 'agent\nmy line, saved while the reject was running\n';
    h.hooks.beforeUnlink = async () => {
      await fs.writeFile(h.env.abs('new.txt'), userSave);
    };
    const before = await h.listing();
    const result = await h.engine.rejectFile(h.key, p('new.txt'), 'strict');
    expect(result).toEqual({ status: 'refused', message: CHANGED_DURING_MESSAGE });
    expect(await h.read('new.txt')).toBe(userSave);
    expect(Object.keys(await h.listing())).toEqual(Object.keys(before));
    expect(rejectRecords(h.ws)).toHaveLength(0);
    expect((await h.entry('new.txt'))?.status).toBe('pending');
  });

  it('reports the generic refusal, naming nothing, when nothing was written and something unexpected failed', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    h.hooks.beforeRename = () => Promise.reject(new Error('boom'));
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toEqual({
      status: 'refused',
      message: FAILED_MESSAGE,
    });
    expect(await h.read('a.txt')).toBe('a1\n');
    expect(Object.keys(await h.listing())).toEqual(['a.txt']);
  });
});

describe('the fold is computed inside the folder queue', () => {
  it('waits for the queue when it has to compute, and does not when the cache is current', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));

    let release: () => void = () => undefined;
    const held = h.ws.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const pending = h.engine.entries(h.key).then((entries) => {
      settled = true;
      return entries;
    });
    await sleep(80);
    expect(settled).toBe(false);
    release();
    await held;
    expect(await pending).toHaveLength(1);

    // Now the cache is current: reading does not need the queue.
    const held2 = h.ws.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(await h.engine.entries(h.key)).toHaveLength(1);
    release();
    await held2;
  });

  it('is not evicted by the observer, and still tells listeners', async () => {
    await h.env.write({ 'a.txt': 'a0\n' });
    await h.sync();
    await h.turn((t) => t.edit('a.txt', 'a1\n'));
    const first = await h.entries();
    let calls = 0;
    h.engine.onDidChange(() => {
      calls += 1;
    });
    const { context } = await import('../tracker/test-support');
    await h.engine.observer.afterTurn?.(context(h.env), 'completed');
    expect(calls).toBe(1);
    // The same answer as before, from the cache, even with the queue held.
    let release: () => void = () => undefined;
    const held = h.ws.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(await h.engine.entries(h.key)).toEqual(first);
    release();
    await held;
  });
});

describe('sequences that must be safe', () => {
  it('S1: the user reverts one agent hunk by hand and edits elsewhere; Reject all keeps the edit', async () => {
    await h.env.write({ 'a.txt': BASE });
    await h.sync();
    const agent = BASE.replace('l2', 'AGENT2').replace('l9', 'AGENT9');
    await h.turn((t) => t.edit('a.txt', agent));
    await h.userEdit({ 'a.txt': agent.replace('AGENT2', 'l2').replace('l5', 'USER5') });
    await gc();
    expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
    expect(await h.engine.rejectAll(h.key, [])).toEqual({ rejected: ['a.txt'], failed: [] });
    expect(await h.read('a.txt')).toBe(BASE.replace('l5', 'USER5'));
    expect(await h.entries()).toEqual([]);
  });

  it('S2: hunk accepted, later unsynced user edit: strict is a conflict, agent-only keeps both', async () => {
    await h.env.write({ 'a.txt': BASE });
    await h.sync();
    const agent = BASE.replace('l2', 'AGENT2').replace('l9', 'AGENT9');
    await h.turn((t) => t.edit('a.txt', agent));
    const hunks = await h.engine.hunks(h.key, p('a.txt'));
    expect(await h.engine.acceptHunk(h.key, p('a.txt'), hunks[0]!.id)).toEqual({ status: 'done' });
    await h.env.write({ 'a.txt': agent.replace('l5', 'USER5') });
    expect((await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).status).toBe('conflict');
    expect(await h.engine.rejectAll(h.key, [])).toMatchObject({ rejected: [] });
    expect(await h.read('a.txt')).toBe(agent.replace('l5', 'USER5'));
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'agent-only')).toEqual({ status: 'done' });
    expect(await h.read('a.txt')).toBe(BASE.replace('l2', 'AGENT2').replace('l5', 'USER5'));
    expect(await h.entries()).toEqual([]);
    expect(await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).toMatchObject({
      status: 'refused',
    });
    await h.sync();
    expect(await h.newEngine().entries(h.key)).toEqual([]);
  });

  it('S3: a created file the user edited and a deleted file the user recreated: nothing without a choice', async () => {
    await h.env.write({ 'gone.txt': 'original\n' });
    await h.sync();
    await h.turn(async (t) => {
      await t.edit('new.txt', 'agent\n', 'Write');
      await t.command(() => fs.rm(h.env.abs('gone.txt')));
    });
    await h.env.write({ 'new.txt': 'agent\nmine\n', 'gone.txt': 'my other content\n' });
    for (const synced of [false, true]) {
      if (synced) await h.sync();
      const before = await h.listing();
      expect((await h.engine.rejectFile(h.key, p('new.txt'), 'strict')).status).toBe('conflict');
      expect((await h.engine.rejectFile(h.key, p('gone.txt'), 'strict')).status).toBe('conflict');
      expect((await h.engine.rejectFile(h.key, p('new.txt'), 'agent-only')).status).toBe('refused');
      expect((await h.engine.rejectFile(h.key, p('gone.txt'), 'agent-only')).status).toBe(
        'refused',
      );
      const all = await h.engine.rejectAll(h.key, [p('new.txt'), p('gone.txt')]);
      expect(all.rejected).toEqual([]);
      expect(await h.listing()).toEqual(before);
    }
  });

  it('S4: synced edit, second turn, unsynced edit, collection, restart: agent-only leaves exactly the user edits', async () => {
    await h.env.write({ 'a.txt': BASE });
    await h.sync();
    const a1 = BASE.replace('l2', 'AGENT2');
    await h.turn((t) => t.edit('a.txt', a1));
    const u1 = a1.replace('l5', 'USER5');
    await h.userEdit({ 'a.txt': u1 });
    const a2 = u1.replace('l9', 'AGENT9');
    await h.turn((t) => t.edit('a.txt', a2));
    await h.env.write({ 'a.txt': a2.replace('l7', 'USER7') });
    await gc();
    const engine = h.newEngine();
    expect(await engine.entries(h.key)).toEqual(await h.entries());
    expect((await engine.rejectFile(h.key, p('a.txt'), 'strict')).status).toBe('conflict');
    expect(await engine.rejectFile(h.key, p('a.txt'), 'agent-only')).toEqual({ status: 'done' });
    expect(await h.read('a.txt')).toBe(BASE.replace('l5', 'USER5').replace('l7', 'USER7'));
    expect(await engine.entries(h.key)).toEqual([]);
  });

  it('S5: a case-only rename by the user of a file the agent created is left alone', async () => {
    await h.turn((t) => t.edit('Readme.md', 'agent\n', 'Write'));
    await fs.rename(h.env.abs('Readme.md'), h.env.abs('README.md'));
    const before = await h.listing();
    expect((await h.engine.rejectFile(h.key, p('Readme.md'), 'strict')).status).not.toBe('done');
    expect((await h.engine.rejectFile(h.key, p('Readme.md'), 'overwrite')).status).not.toBe('done');
    expect(await h.listing()).toEqual(before);
  });

  it('S6: CRLF, a BOM and no final newline come back byte for byte after a synced user edit', async () => {
    const base = '﻿one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix';
    await h.env.write({ 'w.txt': base });
    await h.sync();
    const agent = base.replace('two', 'TWO');
    await h.turn((t) => t.edit('w.txt', agent));
    await h.userEdit({ 'w.txt': agent.replace('five', 'FIVE') });
    expect((await h.entry('w.txt'))?.attribution).toBe('agent-tool');
    expect(await h.engine.rejectAll(h.key, [])).toEqual({ rejected: ['w.txt'], failed: [] });
    expect(await fs.readFile(h.env.abs('w.txt'), 'utf8')).toBe(base.replace('five', 'FIVE'));
  });

  it('S7: a user edit touching the agent hunk is never rejected without a choice', async () => {
    await h.env.write({ 'a.txt': BASE });
    await h.sync();
    const agent = BASE.replace('l2', 'AGENT2');
    await h.turn((t) => t.edit('a.txt', agent));
    await h.userEdit({ 'a.txt': agent.replace('l3', 'USER3') });
    const before = await h.listing();
    expect((await h.engine.rejectFile(h.key, p('a.txt'), 'strict')).status).toBe('conflict');
    expect((await h.engine.rejectAll(h.key, [p('a.txt')])).rejected).toEqual([]);
    expect(await h.listing()).toEqual(before);
  });
});
