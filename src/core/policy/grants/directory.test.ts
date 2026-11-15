import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, useHome, writeTree } from '../readonly/test-support';
import { checkDirectoryToGrant } from './directory';
import type { FolderGrants } from './store';

describe('checkDirectoryToGrant', () => {
  let root: string;
  let folder: string;
  let sibling: string;
  let storage: string;
  let restoreHome: () => void;
  const none: FolderGrants = { switches: [], grants: [] };

  beforeEach(async () => {
    root = await makeTempDir('grant-dir');
    folder = join(root, 'folder');
    sibling = join(root, 'libs', 'shared');
    storage = join(root, 'ext', 'storage');
    await writeTree(folder, { 'src/a.ts': 'a' });
    await writeTree(sibling, { 'x.txt': 'x', 'inner/y.txt': 'y' });
    await fs.mkdir(join(storage, 'deeper'), { recursive: true });
    // The temporary directory lies under the real home (under AppData on Windows, which is
    // sensitive), so the test gets a home of its own.
    await fs.mkdir(join(root, 'home'));
    restoreHome = useHome(join(root, 'home'));
  });
  afterEach(async () => {
    restoreHome();
    await removeDir(root);
  });

  const check = (path: string, granted: FolderGrants = none) =>
    checkDirectoryToGrant({ path, folderPath: folder, granted, sensitiveRoots: () => [storage] });

  it('accepts an ordinary sibling directory, as its real path', async () => {
    expect(await check(sibling)).toEqual({ dir: sibling });
    const link = join(root, 'link-to-shared');
    await fs.symlink(sibling, link);
    expect(await check(link)).toEqual({ dir: sibling });
  });

  it('accepts it when only the read-outside switch is on', async () => {
    expect(await check(sibling, { switches: ['read-outside'], grants: [] })).toEqual({
      dir: sibling,
    });
  });

  it('refuses a file, and a path that does not exist, as not a directory', async () => {
    expect(await check(join(sibling, 'x.txt'))).toEqual({ refused: 'not-a-directory' });
    expect(await check(join(root, 'missing'))).toEqual({ refused: 'not-a-directory' });
    expect(await check('')).toEqual({ refused: 'not-a-directory' });
  });

  it('refuses the workspace folder, a directory in it and a link to one, as inside the folder', async () => {
    expect(await check(folder)).toEqual({ refused: 'inside-folder' });
    expect(await check(join(folder, 'src'))).toEqual({ refused: 'inside-folder' });
    const link = join(root, 'link-to-src');
    await fs.symlink(join(folder, 'src'), link);
    expect(await check(link)).toEqual({ refused: 'inside-folder' });
  });

  it('refuses the storage and a directory below it as sensitive', async () => {
    expect(await check(storage)).toEqual({ refused: 'sensitive' });
    expect(await check(join(storage, 'deeper'))).toEqual({ refused: 'sensitive' });
  });

  it('refuses the home directory, a filesystem root and a directory holding the storage as too broad', async () => {
    expect(await check(await fs.realpath(homedir()))).toEqual({ refused: 'too-broad' });
    expect(await check(parse(root).root)).toEqual({ refused: 'too-broad' });
    expect(await check(join(root, 'ext'))).toEqual({ refused: 'too-broad' });
  });

  it('refuses a directory inside one that is already saved, as covered', async () => {
    const granted: FolderGrants = {
      switches: [],
      grants: [{ kind: 'read-directory', path: join(root, 'libs') }],
    };
    expect(await check(sibling, granted)).toEqual({ refused: 'covered' });
    expect(await check(join(root, 'libs'), granted)).toEqual({ refused: 'covered' });
    // A saved directory that may not be granted covers nothing.
    const broad: FolderGrants = { switches: [], grants: [{ kind: 'read-directory', path: root }] };
    expect(await check(sibling, broad)).toEqual({ dir: sibling });
    // A directory that holds a saved one is not covered by it.
    const narrow: FolderGrants = {
      switches: [],
      grants: [{ kind: 'read-directory', path: join(sibling, 'inner') }],
    };
    expect(await check(sibling, narrow)).toEqual({ dir: sibling });
  });

  it.runIf(process.platform === 'win32')('refuses a network share as sensitive', async () => {
    const result = await check('\\\\localhost\\C$');
    expect(['not-a-directory', 'sensitive']).toContain('refused' in result ? result.refused : '');
  });
});
