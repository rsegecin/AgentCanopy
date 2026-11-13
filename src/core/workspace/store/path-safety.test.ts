import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkParents,
  isCaseInsensitiveVolume,
  PathEscapeError,
  resolveInside,
  sameFile,
} from './path-safety';
import { listFilesRecursive, makeTempDir, removeDir, writeTree } from './test-helpers';

let root: string;
beforeEach(async () => {
  root = await makeTempDir('agc-paths');
});
afterEach(async () => {
  await removeDir(root);
});

describe('resolveInside', () => {
  it('returns the absolute path for plain relative paths', () => {
    expect(resolveInside(root, 'a.txt')).toBe(join(root, 'a.txt'));
    expect(resolveInside(root, 'a/b/c.txt')).toBe(join(root, 'a', 'b', 'c.txt'));
    expect(resolveInside(root, '-dash/with space/.hidden')).toBe(
      join(root, '-dash', 'with space', '.hidden'),
    );
    expect(resolveInside(root, '..foo/bar..')).toBe(join(root, '..foo', 'bar..'));
  });

  it.each<[string, string]>([
    ['an absolute path', '/etc/passwd'],
    ['a Windows drive path', 'C:/Windows'],
    ['a parent segment first', '../x'],
    ['a parent segment in the middle', 'a/../b'],
    ['a parent segment that stays inside', 'a/b/../c'],
    ['a parent segment last', 'a/..'],
    ['only a parent segment', '..'],
    ['an empty path', ''],
    ['a doubled slash', 'a//b'],
    ['a trailing slash', 'a/'],
    ['a NUL', 'a\0b'],
    ['a NUL at the end', 'file.txt\0'],
  ])('rejects %s', (_name, relPath) => {
    expect(() => resolveInside(root, relPath)).toThrow(PathEscapeError);
  });

  it('carries the offending path on the error', () => {
    try {
      resolveInside(root, '../x');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PathEscapeError);
      expect((error as PathEscapeError).relPath).toBe('../x');
    }
  });

  it('never returns a path outside the root', () => {
    const base = resolve(root);
    for (const rel of ['a', 'a/b', '.hidden', 'x..y']) {
      expect(resolveInside(root, rel).startsWith(base)).toBe(true);
    }
  });
});

describe('checkParents', () => {
  it('is ok for existing directories and for a path directly in the root', async () => {
    await writeTree(root, { 'a/b/file.txt': 'x' });
    expect(await checkParents(root, 'a/b/file.txt')).toEqual({ ok: true });
    expect(await checkParents(root, 'top.txt')).toEqual({ ok: true });
  });

  it('is ok when parents are missing, wholly or partly', async () => {
    await writeTree(root, { 'a/file.txt': 'x' });
    expect(await checkParents(root, 'new/deep/er/file.txt')).toEqual({ ok: true });
    expect(await checkParents(root, 'a/new/file.txt')).toEqual({ ok: true });
  });

  it('is ok when the target itself is a symlink or missing: only parents are examined', async () => {
    await fs.symlink('nowhere', join(root, 'link'));
    expect(await checkParents(root, 'link')).toEqual({ ok: true });
    expect(await checkParents(root, 'missing')).toEqual({ ok: true });
  });

  it('fails for a symlinked parent and says which one', async () => {
    await writeTree(root, { 'real/file.txt': 'x' });
    await fs.symlink('real', join(root, 'alias'));
    expect(await checkParents(root, 'alias/file.txt')).toEqual({
      ok: false,
      at: 'alias',
      reason: 'symlink',
    });
    await fs.mkdir(join(root, 'real', 'in'));
    await fs.symlink('..', join(root, 'real', 'in', 'up'));
    expect(await checkParents(root, 'real/in/up/file.txt')).toEqual({
      ok: false,
      at: 'real/in/up',
      reason: 'symlink',
    });
  });

  it('fails for a dangling symlink as a parent', async () => {
    await fs.symlink('missing', join(root, 'dangling'));
    expect(await checkParents(root, 'dangling/file.txt')).toEqual({
      ok: false,
      at: 'dangling',
      reason: 'symlink',
    });
  });

  it('fails for a file where a directory is expected', async () => {
    await writeTree(root, { 'a/b': 'i am a file' });
    expect(await checkParents(root, 'a/b/c.txt')).toEqual({
      ok: false,
      at: 'a/b',
      reason: 'not-directory',
    });
    expect(await checkParents(root, 'a/b/c/d.txt')).toEqual({
      ok: false,
      at: 'a/b',
      reason: 'not-directory',
    });
  });

  it('rejects an escaping path', async () => {
    await expect(checkParents(root, '../x/y')).rejects.toBeInstanceOf(PathEscapeError);
  });

  it('does not create anything', async () => {
    await checkParents(root, 'a/b/c/d.txt');
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe('isCaseInsensitiveVolume', () => {
  it('returns a boolean, creates nothing, and agrees with an independent probe', async () => {
    await writeTree(root, { 'probe-file': 'x' });
    const before = await listFilesRecursive(root);
    const beforeEntries = (await fs.readdir(root)).sort();

    const result = await isCaseInsensitiveVolume(root);

    expect(typeof result).toBe('boolean');
    expect(await listFilesRecursive(root)).toEqual(before);
    expect((await fs.readdir(root)).sort()).toEqual(beforeEntries);

    // Independent check in this test's own temp directory: does a differently cased name reach the file?
    const insensitive = await fs
      .access(join(root, 'PROBE-FILE'))
      .then(() => true)
      .catch(() => false);
    expect(result).toBe(insensitive);
  });

  it('decides from a parent when the directory name has no letters', async () => {
    await fs.mkdir(join(root, '123'));
    const direct = await isCaseInsensitiveVolume(root);
    expect(await isCaseInsensitiveVolume(join(root, '123'))).toBe(direct);
  });

  it('returns false when nothing can be decided', async () => {
    expect(await isCaseInsensitiveVolume('/')).toBe(false);
  });

  it('works for a directory that does not exist (decides from an existing parent)', async () => {
    const direct = await isCaseInsensitiveVolume(root);
    expect(await isCaseInsensitiveVolume(join(root, 'not', 'there'))).toBe(direct);
  });
});

describe('sameFile', () => {
  it('is true for the same path and for a hard link, false for different files', async () => {
    await writeTree(root, { a: 'x', b: 'x' });
    await fs.link(join(root, 'a'), join(root, 'a-link'));
    expect(await sameFile(join(root, 'a'), join(root, 'a'))).toBe(true);
    expect(await sameFile(join(root, 'a'), join(root, 'a-link'))).toBe(true);
    expect(await sameFile(join(root, 'a'), join(root, 'b'))).toBe(false);
  });

  it('is false when either is missing', async () => {
    await writeTree(root, { a: 'x' });
    expect(await sameFile(join(root, 'a'), join(root, 'missing'))).toBe(false);
    expect(await sameFile(join(root, 'missing'), join(root, 'a'))).toBe(false);
    expect(await sameFile(join(root, 'm1'), join(root, 'm2'))).toBe(false);
    expect(await sameFile(join(root, 'a', 'under-a-file'), join(root, 'a'))).toBe(false);
  });

  it('detects a case-only alias exactly when the volume is case-insensitive', async () => {
    await writeTree(root, { 'Case.txt': 'x' });
    const insensitive = await isCaseInsensitiveVolume(root);
    expect(await sameFile(join(root, 'Case.txt'), join(root, 'case.txt'))).toBe(insensitive);
  });
});
