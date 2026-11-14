import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderKey, Mode, Settings, TurnId } from '../../../shared';
import { DEFAULT_SETTINGS } from '../../../shared';
import type { TurnContext } from '../../contracts';
import * as store from '../../workspace/store';
import { createReadOnlyTripwire } from './index';
import { listAll, makeTempDir, meta, removeDir, writeTree } from './test-support';

function contextFor(
  folderPath: string,
  mode: Mode = 'ask',
  settings: Partial<Settings> = {},
  id = 'c1',
): TurnContext {
  return {
    conversation: meta(id, mode),
    turnId: 'turn-1' as TurnId,
    mode,
    folder: { key: 'folder-1' as FolderKey, name: 'f', path: folderPath },
    settings: { ...DEFAULT_SETTINGS, ...settings },
  };
}

vi.mock('../../workspace/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workspace/store')>();
  return { ...actual, scanWorkspace: vi.fn(actual.scanWorkspace) };
});

const signal = (): AbortSignal => new AbortController().signal;

describe('read-only tripwire', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await makeTempDir('readonly-tripwire');
    await writeTree(folder, { 'a.txt': 'a', 'src/b.ts': 'b', 'src/c.ts': 'c' });
  });
  afterEach(() => removeDir(folder));

  /** Runs a turn: scan, let `change` happen, scan again. */
  async function turn(
    change: () => Promise<void>,
    context = contextFor(folder),
    tripwire = createReadOnlyTripwire(),
  ) {
    await tripwire.beforeTurn?.(context, signal());
    await change();
    return tripwire.afterTurn?.(context, 'completed');
  }

  // A rewrite that keeps the size could keep the mtime within the clock's resolution, so every
  // modification here changes the size as well.
  it('reports nothing when nothing changed', async () => {
    expect(await turn(() => Promise.resolve())).toEqual([]);
  });

  it('reports one modified file in the singular', async () => {
    const notices = await turn(() => fs.writeFile(join(folder, 'a.txt'), 'changed content'));
    expect(notices).toEqual([
      {
        level: 'warning',
        text: '1 file changed in the workspace while this read-only turn was running: a.txt. The agent of this turn had no tool that can write, so an Agent turn in this folder, another program or an edit of yours changed it. AgentCanopy reverts nothing here.',
      },
    ]);
  });

  it('reports a modified, an added and a removed file in one notice', async () => {
    const notices = await turn(async () => {
      await fs.writeFile(join(folder, 'a.txt'), 'longer than before');
      await fs.writeFile(join(folder, 'new.txt'), 'n');
      await fs.rm(join(folder, 'src/c.ts'));
    });
    expect(notices).toHaveLength(1);
    expect(notices?.[0]?.level).toBe('warning');
    expect(notices?.[0]?.text).toBe(
      '3 files changed in the workspace while this read-only turn was running: a.txt, new.txt, src/c.ts. The agent of this turn had no tool that can write, so an Agent turn in this folder, another program or an edit of yours changed them. AgentCanopy reverts nothing here.',
    );
  });

  it('lists at most five paths, sorted, and counts the rest', async () => {
    const notices = await turn(async () => {
      for (const name of ['g', 'f', 'e', 'd', 'c', 'b', 'a']) {
        await fs.writeFile(join(folder, `new-${name}.txt`), name);
      }
    });
    expect(notices?.[0]?.text).toContain(
      '7 files changed in the workspace while this read-only turn was running: new-a.txt, new-b.txt, new-c.txt, new-d.txt, new-e.txt and 2 more. ',
    );
  });

  it('escapes odd characters in paths', async () => {
    const notices = await turn(() => fs.writeFile(join(folder, 'x‮y.txt'), 'n'));
    expect(notices?.[0]?.text).toContain('x\\u{202E}y.txt');
  });

  it('ignores changes in ignored paths', async () => {
    await writeTree(folder, {
      'node_modules/p/index.js': 'x',
      '.gitignore': 'build/\n',
      'build/o.js': 'x',
    });
    const notices = await turn(async () => {
      await fs.writeFile(join(folder, 'node_modules/p/index.js'), 'much longer content');
      await fs.writeFile(join(folder, 'node_modules/p/new.js'), 'n');
      await fs.writeFile(join(folder, 'build/o.js'), 'much longer content');
    });
    expect(notices).toEqual([]);
  });

  it('honours the snapshotExclude setting', async () => {
    const context = contextFor(folder, 'ask', { snapshotExclude: ['*.log'] });
    const notices = await turn(() => fs.writeFile(join(folder, 'x.log'), 'n'), context);
    expect(notices).toEqual([]);
  });

  it('works in plan mode too', async () => {
    const notices = await turn(
      () => fs.writeFile(join(folder, 'a.txt'), 'changed content'),
      contextFor(folder, 'plan'),
    );
    expect(notices).toHaveLength(1);
    expect(notices?.[0]?.text).toContain(
      '1 file changed in the workspace while this read-only turn',
    );
    expect(await turn(() => Promise.resolve(), contextFor(folder, 'plan'))).toEqual([]);
  });

  it('does nothing in agent mode, not even a scan', async () => {
    const missing = join(folder, 'does-not-exist');
    const context = contextFor(missing, 'agent');
    const tripwire = createReadOnlyTripwire();
    await expect(tripwire.beforeTurn?.(context, signal())).resolves.toBeUndefined();
    await expect(tripwire.afterTurn?.(context, 'completed')).resolves.toEqual([]);
  });

  it('a baseline that failed gives no notice and does not refuse the turn', async () => {
    const missing = join(folder, 'does-not-exist');
    const messages: string[] = [];
    const tripwire = createReadOnlyTripwire({
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message) => void messages.push(message),
        error: () => undefined,
      },
    });
    const context = contextFor(missing);
    await expect(tripwire.beforeTurn?.(context, signal())).resolves.toBeUndefined();
    await fs.mkdir(missing);
    await fs.writeFile(join(missing, 'x'), 'x');
    await expect(tripwire.afterTurn?.(context, 'completed')).resolves.toEqual([]);
    expect(messages).toHaveLength(1);
  });

  it('a truncated baseline gives no notice', async () => {
    const truncated = { entries: new Map(), unreadable: [], truncated: true };
    vi.mocked(store.scanWorkspace).mockResolvedValueOnce(truncated);
    const notices = await turn(() => fs.writeFile(join(folder, 'a.txt'), 'changed content'));
    expect(notices).toEqual([]);
  });

  it('a truncated scan after the turn gives no notice', async () => {
    const real =
      await vi.importActual<typeof import('../../workspace/store')>('../../workspace/store');
    const tripwire = createReadOnlyTripwire();
    const context = contextFor(folder);
    await tripwire.beforeTurn?.(context, signal());
    await fs.writeFile(join(folder, 'a.txt'), 'changed content');
    vi.mocked(store.scanWorkspace).mockResolvedValueOnce({
      ...(await real.scanWorkspace(folder, await real.loadIgnoreRules(folder, []))),
      truncated: true,
    });
    expect(await tripwire.afterTurn?.(context, 'completed')).toEqual([]);
  });

  it('a scan that fails after the turn gives no notice', async () => {
    const tripwire = createReadOnlyTripwire();
    const context = contextFor(folder);
    await tripwire.beforeTurn?.(context, signal());
    vi.mocked(store.scanWorkspace).mockRejectedValueOnce(new Error('disk gone'));
    expect(await tripwire.afterTurn?.(context, 'completed')).toEqual([]);
  });

  it('an abort during beforeTurn rejects', async () => {
    const controller = new AbortController();
    controller.abort();
    const tripwire = createReadOnlyTripwire();
    await expect(
      tripwire.beforeTurn?.(contextFor(folder), controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('clears what it remembered, so a second afterTurn reports nothing', async () => {
    const tripwire = createReadOnlyTripwire();
    const context = contextFor(folder);
    await tripwire.beforeTurn?.(context, signal());
    await fs.writeFile(join(folder, 'a.txt'), 'changed content');
    expect(await tripwire.afterTurn?.(context, 'completed')).toHaveLength(1);
    expect(await tripwire.afterTurn?.(context, 'completed')).toEqual([]);
  });

  it('keeps one baseline per conversation', async () => {
    const other = await makeTempDir('readonly-tripwire-other');
    try {
      await writeTree(other, { 'o.txt': 'o' });
      const tripwire = createReadOnlyTripwire();
      const one = contextFor(folder, 'ask', {}, 'one');
      const two = contextFor(other, 'ask', {}, 'two');
      await tripwire.beforeTurn?.(one, signal());
      await tripwire.beforeTurn?.(two, signal());
      await fs.writeFile(join(other, 'o.txt'), 'changed content');
      expect(await tripwire.afterTurn?.(one, 'completed')).toEqual([]);
      expect(await tripwire.afterTurn?.(two, 'completed')).toHaveLength(1);
    } finally {
      await removeDir(other);
    }
  });

  it('writes nothing into the folder', async () => {
    const before = await listAll(folder);
    const stats = await Promise.all(before.map((p) => fs.lstat(join(folder, p))));
    await turn(() => Promise.resolve());
    await turn(() => fs.writeFile(join(folder, 'a.txt'), 'changed content'));
    // Only the change the test made; the tripwire added no file or directory.
    expect(await listAll(folder)).toEqual(before);
    const after = await Promise.all(before.map((p) => fs.lstat(join(folder, p))));
    expect(after.map((s) => s.isDirectory())).toEqual(stats.map((s) => s.isDirectory()));
  });
});
