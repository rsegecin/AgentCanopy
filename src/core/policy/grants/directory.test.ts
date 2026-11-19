import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, useHome, writeTree } from '../readonly/test-support';
import { checkDirectoryToGrant, coversEdit, coversRead } from './directory';
import { resolveSensitiveEnv, type SensitiveEnv } from './sensitive';
import type { FolderGrants, Grant } from './store';

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
    // The tests get a home of their own, so that what is sensitive is under their control: the
    // temporary directory lies under the real home, whose credential locations must not be in play
    // (and, before Phase 18, on Windows the temporary directory itself was sensitive).
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

  describe.runIf(process.platform === 'win32')('the temp folder of Windows', () => {
    const checkAccess = (path: string, access: 'read' | 'edit') =>
      checkDirectoryToGrant({
        path,
        folderPath: folder,
        granted: none,
        sensitiveRoots: () => [storage],
        access,
      });

    it('may be saved for reads and for edits, with a folder in it, but not the rest of AppData', async () => {
      const temp = join(root, 'home', 'AppData', 'Local', 'Temp');
      const work = join(temp, 'work');
      const roaming = join(root, 'home', 'AppData', 'Roaming', 'x');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(roaming, { recursive: true });
      for (const access of ['read', 'edit'] as const) {
        expect(await checkAccess(work, access)).toEqual({ dir: await fs.realpath(work) });
        expect(await checkAccess(temp, access)).toEqual({ dir: await fs.realpath(temp) });
        expect(await checkAccess(roaming, access)).toEqual({ refused: 'sensitive' });
      }
    });
  });

  describe('for edits', () => {
    const checkEdit = (path: string, granted: FolderGrants = none) =>
      checkDirectoryToGrant({
        path,
        folderPath: folder,
        granted,
        sensitiveRoots: () => [storage],
        access: 'edit',
      });

    it('accepts an ordinary sibling directory, as its real path', async () => {
      expect(await checkEdit(sibling)).toEqual({ dir: sibling });
    });

    it('still refuses the folder, the storage and a directory that is too broad', async () => {
      expect(await checkEdit(folder)).toEqual({ refused: 'inside-folder' });
      expect(await checkEdit(storage)).toEqual({ refused: 'sensitive' });
      expect(await checkEdit(parse(root).root)).toEqual({ refused: 'too-broad' });
      expect(await checkEdit(join(root, 'missing'))).toEqual({ refused: 'not-a-directory' });
    });

    it('refuses a protected directory, and a directory below one', async () => {
      await writeTree(sibling, {
        '.git/config': 'c',
        'x/.vscode/tasks.json': '{}',
        '.claude/a/b': 'b',
      });
      expect(await checkEdit(join(sibling, '.git'))).toEqual({ refused: 'protected' });
      expect(await checkEdit(join(sibling, 'x', '.vscode'))).toEqual({ refused: 'protected' });
      expect(await checkEdit(join(sibling, '.claude', 'a'))).toEqual({ refused: 'protected' });
      // Reads have no such limit.
      expect(await check(join(sibling, '.git'))).toEqual({ dir: join(sibling, '.git') });
    });

    it('is covered by an edit directory that holds it, but not by a read directory', async () => {
      const edit: FolderGrants = {
        switches: [],
        grants: [{ kind: 'edit-directory', path: join(root, 'libs') }],
      };
      expect(await checkEdit(sibling, edit)).toEqual({ refused: 'covered' });
      expect(await checkEdit(join(root, 'libs'), edit)).toEqual({ refused: 'covered' });
      const read: FolderGrants = {
        switches: [],
        grants: [{ kind: 'read-directory', path: join(root, 'libs') }],
      };
      expect(await checkEdit(sibling, read)).toEqual({ dir: sibling });
      // A saved directory that may not be granted covers nothing.
      const broad: FolderGrants = {
        switches: [],
        grants: [{ kind: 'edit-directory', path: root }],
      };
      expect(await checkEdit(sibling, broad)).toEqual({ dir: sibling });
    });

    it('a directory saved for edits also covers a directory to read from', async () => {
      const edit: FolderGrants = {
        switches: [],
        grants: [{ kind: 'edit-directory', path: join(root, 'libs') }],
      };
      expect(await check(sibling, edit)).toEqual({ refused: 'covered' });
      expect(
        await checkDirectoryToGrant({
          path: sibling,
          folderPath: folder,
          granted: edit,
          sensitiveRoots: () => [storage],
          access: 'read',
        }),
      ).toEqual({ refused: 'covered' });
    });
  });
});

describe('coversRead and coversEdit', () => {
  let root: string;
  let storage: string;
  let restoreHome: () => void;
  let env: SensitiveEnv;
  const dir = () => join(root, 'libs');
  const inside = () => join(root, 'libs', 'shared', 'x.txt');

  beforeEach(async () => {
    root = await makeTempDir('covers');
    storage = join(root, 'ext', 'storage');
    await fs.mkdir(storage, { recursive: true });
    await fs.mkdir(join(root, 'home'));
    restoreHome = useHome(join(root, 'home'));
    env = await resolveSensitiveEnv(() => [storage]);
  });
  afterEach(async () => {
    restoreHome();
    await removeDir(root);
  });

  it('a read directory covers reads below it and no edit', () => {
    const grant: Grant = { kind: 'read-directory', path: dir() };
    expect(coversRead(grant, inside(), env)).toBe(true);
    expect(coversRead(grant, dir(), env)).toBe(true);
    expect(coversRead(grant, join(root, 'other', 'x.txt'), env)).toBe(false);
    expect(coversEdit(grant, inside(), env)).toBe(false);
  });

  it('an edit directory covers reads and edits below it, and nothing beside it', () => {
    const grant: Grant = { kind: 'edit-directory', path: dir() };
    expect(coversRead(grant, inside(), env)).toBe(true);
    expect(coversEdit(grant, inside(), env)).toBe(true);
    expect(coversEdit(grant, join(root, 'libs-other', 'x.txt'), env)).toBe(false);
    expect(coversRead(grant, join(root, 'libs-other', 'x.txt'), env)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'a directory saved in the temp folder of Windows covers what lies below it',
    async () => {
      const work = join(root, 'home', 'AppData', 'Local', 'Temp', 'work');
      await fs.mkdir(work, { recursive: true });
      const file = join(await fs.realpath(work), 'out.txt');
      const edit: Grant = { kind: 'edit-directory', path: await fs.realpath(work) };
      expect(coversEdit(edit, file, env)).toBe(true);
      expect(coversRead(edit, file, env)).toBe(true);
      const read: Grant = { kind: 'read-directory', path: await fs.realpath(work) };
      expect(coversRead(read, file, env)).toBe(true);
      expect(coversEdit(read, file, env)).toBe(false);
    },
  );

  it('a directory that may not be granted covers nothing', () => {
    for (const kind of ['read-directory', 'edit-directory'] as const) {
      const broad: Grant = { kind, path: root };
      expect(coversRead(broad, inside(), env)).toBe(false);
      expect(coversEdit(broad, inside(), env)).toBe(false);
    }
  });

  it('other kinds of grant cover nothing', () => {
    for (const grant of [
      { kind: 'web-site', host: 'docs.example.com' },
      { kind: 'powershell-command', command: 'ls' },
    ] as const) {
      expect(coversRead(grant, inside(), env)).toBe(false);
      expect(coversEdit(grant, inside(), env)).toBe(false);
    }
  });
});
