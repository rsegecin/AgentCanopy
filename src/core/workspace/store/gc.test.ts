import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlobStore } from './blob-store';
import { collectGarbage } from './gc';
import { makeTempDir, removeDir } from './test-helpers';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('agc-gc');
});
afterEach(async () => {
  await removeDir(dir);
});

describe('collectGarbage', () => {
  it('deletes only unreferenced blobs', async () => {
    const store = createBlobStore(join(dir, 'blobs'));
    const hashes: string[] = [];
    for (let i = 0; i < 10; i += 1) hashes.push(await store.put(Buffer.from(`blob ${i}`)));
    const referenced = new Set([hashes[0]!, hashes[3]!, hashes[9]!, 'f'.repeat(64)]);

    const result = await collectGarbage(store, referenced);
    expect(result).toEqual({ deleted: 7, kept: 3 });
    expect(await store.list()).toEqual([hashes[0]!, hashes[3]!, hashes[9]!].sort());
    expect((await store.get(hashes[3]!)).toString()).toBe('blob 3');
  });

  it('does nothing on an empty store, and again on a second run', async () => {
    const store = createBlobStore(join(dir, 'blobs'));
    expect(await collectGarbage(store, new Set())).toEqual({ deleted: 0, kept: 0 });
    const hash = await store.put(Buffer.from('x'));
    expect(await collectGarbage(store, new Set([hash]))).toEqual({ deleted: 0, kept: 1 });
    expect(await collectGarbage(store, new Set())).toEqual({ deleted: 1, kept: 0 });
    expect(await collectGarbage(store, new Set())).toEqual({ deleted: 0, kept: 0 });
  });
});
