import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderKey } from '../../../shared';
import { makeTempDir, removeDir } from '../readonly/test-support';
import { createProjectConfigDecisions } from './index';

const KEY = 'folder-1' as FolderKey;
const FP = 'a'.repeat(64);

describe('project configuration decisions', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await makeTempDir('decisions'), 'decisions');
  });
  afterEach(() => removeDir(join(dir, '..')));

  async function open(logger?: Parameters<typeof createProjectConfigDecisions>[0]['logger']) {
    const store = createProjectConfigDecisions(logger ? { dir, logger } : { dir });
    await store.init();
    return store;
  }

  it('has no decision at first', async () => {
    expect((await open()).get(KEY, FP)).toBeUndefined();
  });

  it('round trip, across instances', async () => {
    const store = await open();
    await store.set(KEY, FP, 'use');
    expect(store.get(KEY, FP)).toBe('use');
    expect((await open()).get(KEY, FP)).toBe('use');
    expect(JSON.parse(await fs.readFile(join(dir, `${KEY}.json`), 'utf8'))).toEqual({
      fingerprint: FP,
      decision: 'use',
    });
    await store.set(KEY, FP, 'ignore');
    expect((await open()).get(KEY, FP)).toBe('ignore');
  });

  it('a decision for another fingerprint is no decision', async () => {
    const store = await open();
    await store.set(KEY, FP, 'use');
    expect(store.get(KEY, 'b'.repeat(64))).toBeUndefined();
    expect((await open()).get(KEY, 'b'.repeat(64))).toBeUndefined();
  });

  it('a new decision replaces the old one for the folder', async () => {
    const store = await open();
    await store.set(KEY, FP, 'use');
    await store.set(KEY, 'b'.repeat(64), 'ignore');
    expect(store.get(KEY, FP)).toBeUndefined();
    expect(store.get(KEY, 'b'.repeat(64))).toBe('ignore');
  });

  it('folders are separate', async () => {
    const store = await open();
    await store.set(KEY, FP, 'use');
    expect(store.get('folder-2' as FolderKey, FP)).toBeUndefined();
  });

  it('reset removes the decision, in memory and on disk', async () => {
    const store = await open();
    await store.set(KEY, FP, 'use');
    await store.reset(KEY);
    expect(store.get(KEY, FP)).toBeUndefined();
    expect(await fs.readdir(dir)).toEqual([]);
    expect((await open()).get(KEY, FP)).toBeUndefined();
    // Resetting a folder with nothing stored is fine.
    await store.reset(KEY);
  });

  it.each([
    ['not JSON', '{ nope'],
    ['the wrong shape', JSON.stringify({ decision: 'use' })],
    ['an unknown decision', JSON.stringify({ fingerprint: FP, decision: 'maybe' })],
    ['an empty fingerprint', JSON.stringify({ fingerprint: '', decision: 'use' })],
    ['an array', '[]'],
  ])('an invalid file (%s) is no decision and is logged', async (_name, content) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${KEY}.json`), content);
    const warnings: string[] = [];
    const store = await open({
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => void warnings.push(message),
      error: () => undefined,
    });
    expect(store.get(KEY, FP)).toBeUndefined();
    expect(warnings).toHaveLength(1);
    // It can be replaced afterwards.
    await store.set(KEY, FP, 'ignore');
    expect((await open()).get(KEY, FP)).toBe('ignore');
  });

  it('ignores files that are not decision files', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'notes.txt'), 'x');
    await fs.writeFile(
      join(dir, 'bad key.json'),
      JSON.stringify({ fingerprint: FP, decision: 'use' }),
    );
    const store = await open();
    expect(store.get('bad key' as FolderKey, FP)).toBeUndefined();
  });

  it.each(['', 'a/b', '..', 'a b', 'x'.repeat(65)])('rejects the folder key %j', async (key) => {
    const store = await open();
    await expect(store.set(key as FolderKey, FP, 'use')).rejects.toThrow();
    await expect(store.reset(key as FolderKey)).rejects.toThrow();
    expect(store.get(key as FolderKey, FP)).toBeUndefined();
  });

  it('rejects an invalid decision or fingerprint', async () => {
    const store = await open();
    await expect(store.set(KEY, FP, 'maybe' as 'use')).rejects.toThrow();
    await expect(store.set(KEY, '', 'use')).rejects.toThrow();
    expect(store.get(KEY, FP)).toBeUndefined();
  });

  it('refuses to write before init', async () => {
    const store = createProjectConfigDecisions({ dir });
    await expect(store.set(KEY, FP, 'use')).rejects.toThrow('not been opened');
  });

  it('leaves no temporary file, and keeps the old state when a write fails', async () => {
    const store = await open();
    await store.set(KEY, FP, 'use');
    expect(await fs.readdir(dir)).toEqual([`${KEY}.json`]);
    await fs.rm(dir, { recursive: true, force: true });
    await expect(store.set(KEY, FP, 'ignore')).rejects.toThrow();
    expect(store.get(KEY, FP)).toBe('use');
  });
});
