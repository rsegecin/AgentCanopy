import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlobCorruptError, BlobMissingError, createBlobStore, type BlobStore } from './blob-store';
import { listFilesRecursive, makeTempDir, removeDir } from './test-helpers';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const posix = process.platform !== 'win32';

let dir: string;
let blobDir: string;
let workDir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await makeTempDir('agc-blob');
  blobDir = join(dir, 'blobs');
  workDir = join(dir, 'work');
  await fs.mkdir(workDir);
  store = createBlobStore(blobDir);
});
afterEach(async () => {
  await removeDir(dir);
});

function blobFile(hash: string): string {
  return join(blobDir, hash.slice(0, 2), hash.slice(2));
}

describe('blob store', () => {
  it('round-trips content, stored gzip under <2 hex>/<rest>', async () => {
    const data = Buffer.from('hello world\n'.repeat(100));
    const hash = await store.put(data);
    expect(hash).toBe(sha(data));
    expect(await store.has(hash)).toBe(true);
    expect((await store.get(hash)).equals(data)).toBe(true);
    const onDisk = await fs.readFile(blobFile(hash));
    expect(onDisk[0]).toBe(0x1f);
    expect(onDisk[1]).toBe(0x8b);
    expect(onDisk.length).toBeLessThan(data.length);
  });

  it('treats a second put of the same content as a no-op', async () => {
    const data = Buffer.from('same');
    const hash = await store.put(data);
    const before = await fs.stat(blobFile(hash), { bigint: true });
    expect(await store.put(data)).toBe(hash);
    const after = await fs.stat(blobFile(hash), { bigint: true });
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(await store.list()).toEqual([hash]);
  });

  it('stores empty content', async () => {
    const hash = await store.put(Buffer.alloc(0));
    expect(hash).toBe(sha(''));
    expect((await store.get(hash)).length).toBe(0);
  });

  it('throws BlobCorruptError when a byte on disk is flipped', async () => {
    const hash = await store.put(Buffer.from('important data '.repeat(50)));
    const file = blobFile(hash);
    const bytes = await fs.readFile(file);
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = (bytes[middle] as number) ^ 0xff;
    await fs.writeFile(file, bytes);
    await expect(store.get(hash)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it('throws BlobCorruptError for a truncated blob file', async () => {
    const hash = await store.put(Buffer.from('important data '.repeat(50)));
    const file = blobFile(hash);
    const bytes = await fs.readFile(file);
    await fs.writeFile(file, bytes.subarray(0, bytes.length - 6));
    await expect(store.get(hash)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it('throws BlobCorruptError when valid gzip holds the wrong bytes', async () => {
    const hash = await store.put(Buffer.from('original'));
    const other = createBlobStore(join(dir, 'other'));
    const otherHash = await other.put(Buffer.from('different'));
    await fs.copyFile(
      join(dir, 'other', otherHash.slice(0, 2), otherHash.slice(2)),
      blobFile(hash),
    );
    await expect(store.get(hash)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it('throws BlobMissingError for an absent or malformed hash', async () => {
    await expect(store.get(sha('nothing'))).rejects.toBeInstanceOf(BlobMissingError);
    await expect(store.get('../../etc/passwd')).rejects.toBeInstanceOf(BlobMissingError);
    expect(await store.has('../x')).toBe(false);
    expect(await store.has(sha('nothing'))).toBe(false);
  });

  it('deletes, lists and totals compressed bytes', async () => {
    expect(await store.list()).toEqual([]);
    expect(await store.totalBytes()).toBe(0);
    const a = await store.put(Buffer.from('a'.repeat(1000)));
    const b = await store.put(Buffer.from('b'.repeat(1000)));
    expect((await store.list()).sort()).toEqual([a, b].sort());
    const sizes = (await fs.stat(blobFile(a))).size + (await fs.stat(blobFile(b))).size;
    expect(await store.totalBytes()).toBe(sizes);
    expect(sizes).toBeLessThan(2000);
    await store.delete(a);
    await store.delete(a);
    expect(await store.list()).toEqual([b]);
  });

  it('leaves no temp files and ignores stray files in listings', async () => {
    const hashes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.put(Buffer.from(`blob ${i}`))),
    );
    await Promise.all(hashes.map(() => store.put(Buffer.from('blob 0'))));
    await fs.writeFile(join(blobDir, hashes[0]!.slice(0, 2), '.tmp-stray'), 'x');
    const files = await listFilesRecursive(blobDir);
    expect(files.filter((f) => !/^[0-9a-f]{2}\/[0-9a-f]{62}$/.test(f))).toEqual([
      `${hashes[0]!.slice(0, 2)}/.tmp-stray`,
    ]);
    expect((await store.list()).length).toBe(20);
  });

  it.skipIf(!posix)('writes blobs with mode 0600', async () => {
    const hash = await store.put(Buffer.from('secret-ish'));
    expect((await fs.stat(blobFile(hash))).mode & 0o777).toBe(0o600);
  });
});

describe('captureFile', () => {
  async function write(name: string, content: Buffer | string): Promise<string> {
    const file = join(workDir, name);
    await fs.writeFile(file, content);
    return file;
  }

  it('captures text', async () => {
    const file = await write('a.txt', 'line one\nline two\n');
    const result = await store.captureFile(file, 1000);
    expect(result).toMatchObject({ kind: 'captured', size: 18, binary: false });
    if (result.kind !== 'captured') throw new Error('unreachable');
    expect(result.hash).toBe(sha('line one\nline two\n'));
    expect((await store.get(result.hash)).toString()).toBe('line one\nline two\n');
  });

  it('flags a NUL byte as binary', async () => {
    const file = await write('b.bin', Buffer.from([0x61, 0x00, 0x62]));
    expect(await store.captureFile(file, 1000)).toMatchObject({ kind: 'captured', binary: true });
  });

  it('flags invalid UTF-8 as binary', async () => {
    const file = await write('c.txt', Buffer.from([0xc3, 0x28, 0x41]));
    expect(await store.captureFile(file, 1000)).toMatchObject({ kind: 'captured', binary: true });
  });

  it('treats a UTF-8 BOM file as text and keeps the BOM bytes', async () => {
    const content = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo\r\n')]);
    const file = await write('bom.txt', content);
    const result = await store.captureFile(file, 1000);
    expect(result).toMatchObject({ kind: 'captured', binary: false });
    if (result.kind !== 'captured') throw new Error('unreachable');
    expect((await store.get(result.hash)).equals(content)).toBe(true);
  });

  it('captures an empty file', async () => {
    const file = await write('empty', '');
    expect(await store.captureFile(file, 10)).toMatchObject({
      kind: 'captured',
      size: 0,
      binary: false,
      hash: sha(''),
    });
  });

  it('reports a file over the limit and does not store it', async () => {
    const file = await write('big.txt', 'x'.repeat(101));
    expect(await store.captureFile(file, 100)).toEqual({ kind: 'too-large', size: 101 });
    expect(await store.list()).toEqual([]);
    expect(await store.captureFile(file, 101)).toMatchObject({ kind: 'captured', size: 101 });
  });

  it('can hash without storing', async () => {
    const file = await write('s.txt', 'do not keep');
    const result = await store.captureFile(file, 100, { store: false });
    expect(result).toMatchObject({ kind: 'captured', hash: sha('do not keep') });
    expect(await store.list()).toEqual([]);
  });

  it('reports a missing file as gone', async () => {
    expect(await store.captureFile(join(workDir, 'nope'), 100)).toEqual({ kind: 'gone' });
    expect(await store.captureFile(join(workDir, 'nope', 'deeper'), 100)).toEqual({ kind: 'gone' });
  });

  it('reports a directory as not regular', async () => {
    await fs.mkdir(join(workDir, 'd'));
    expect(await store.captureFile(join(workDir, 'd'), 100)).toEqual({ kind: 'not-regular' });
  });

  it('does not follow a symlink at the final component', async () => {
    const target = await write('target.txt', 'secret target');
    await fs.symlink(target, join(workDir, 'link'));
    expect(await store.captureFile(join(workDir, 'link'), 100)).toEqual({ kind: 'not-regular' });
    expect(await store.list()).toEqual([]);
  });

  it('does not follow a dangling symlink either', async () => {
    await fs.symlink(join(workDir, 'missing'), join(workDir, 'dangling'));
    expect(await store.captureFile(join(workDir, 'dangling'), 100)).toEqual({
      kind: 'not-regular',
    });
  });

  it('hashes exactly the bytes it stored', async () => {
    const file = await write('r.txt', 'before');
    const first = await store.captureFile(file, 100);
    await fs.writeFile(file, 'after!');
    const second = await store.captureFile(file, 100);
    if (first.kind !== 'captured' || second.kind !== 'captured') throw new Error('unreachable');
    expect((await store.get(first.hash)).toString()).toBe('before');
    expect((await store.get(second.hash)).toString()).toBe('after!');
  });
});
