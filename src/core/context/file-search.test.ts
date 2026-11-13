import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanWorkspace } from '../workspace/store';
import type { IgnoreRules, ScanOptions } from '../workspace/store';
import { createFileSearch } from './file-search';
import type { FileSearchOptions } from './file-search';

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agc-file-search-')));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/** A search over the real scanner that counts how often it scans. */
function counted(options: FileSearchOptions = {}) {
  const state = { scans: 0 };
  const search = createFileSearch({
    ...options,
    scan: (folder: string, rules: IgnoreRules, scanOptions?: ScanOptions) => {
      state.scans += 1;
      return scanWorkspace(folder, rules, scanOptions);
    },
  });
  return { search, state };
}

const paths = (results: { path: string }[]): string[] => results.map((result) => result.path);

describe('the file search', () => {
  it('ranks by basename prefix, basename, path, then subsequence; shorter then alphabetical', async () => {
    await write({
      'src/parser.ts': '',
      'src/app/parse-utils.ts': '',
      'src/app/parse.ts': '',
      'docs/reparse/readme.md': '',
      'lib/parser-notes/x.txt': '',
      'src/p/a/r/s/e.ts': '',
      'src/zebra/xx.ts': '',
    });
    const { search } = counted();
    const results = await search.search(root, [], 'pars');
    expect(paths(results)).toEqual([
      // basename starts with the query: shorter paths first, equal lengths alphabetical
      'src/parser.ts',
      'lib/parser-notes',
      'src/app/parse.ts',
      'src/app/parse-utils.ts',
      // basename contains it
      'docs/reparse',
      // path contains it
      'docs/reparse/readme.md',
      'lib/parser-notes/x.txt',
      // the characters appear in order in the path
      'src/p/a/r/s',
      'src/p/a/r/s/e.ts',
    ]);
  });

  it('matches case-insensitively and keeps the original case in the result', async () => {
    await write({ 'Src/ReadMe.MD': '' });
    const { search } = counted();
    expect(await search.search(root, [], 'README')).toEqual([
      { path: 'Src/ReadMe.MD', kind: 'file' },
    ]);
    expect(await search.search(root, [], 'src/readme')).toEqual([
      { path: 'Src/ReadMe.MD', kind: 'file' },
    ]);
  });

  it('breaks ties alphabetically', async () => {
    await write({ 'b/note.txt': '', 'a/note.txt': '', 'c/note.txt': '' });
    const { search } = counted();
    expect(paths(await search.search(root, [], 'note.txt'))).toEqual([
      'a/note.txt',
      'b/note.txt',
      'c/note.txt',
    ]);
  });

  it('offers folders that hold files, once each, and marks the kind', async () => {
    await write({ 'src/core/a.ts': '', 'src/core/b.ts': '', 'src/ui/c.ts': '' });
    const { search } = counted();
    expect(await search.search(root, [], 'core')).toEqual([
      { path: 'src/core', kind: 'folder' },
      { path: 'src/core/a.ts', kind: 'file' },
      { path: 'src/core/b.ts', kind: 'file' },
    ]);
    expect(paths(await search.search(root, [], 'src'))).toEqual([
      'src',
      'src/ui',
      'src/core',
      'src/ui/c.ts',
      'src/core/a.ts',
      'src/core/b.ts',
    ]);
  });

  it('never offers ignored, excluded or node_modules paths', async () => {
    await write({
      '.gitignore': 'secret.txt\nbuild/\n',
      'secret.txt': '',
      'build/out.js': '',
      'node_modules/pkg/index.js': '',
      'src/index.js': '',
      'src/debug.log': '',
      '.git/config': '',
    });
    const { search } = counted();
    expect(paths(await search.search(root, ['*.log'], 'index'))).toEqual(['src/index.js']);
    expect(paths(await search.search(root, ['*.log'], 'secret'))).toEqual([]);
    expect(paths(await search.search(root, ['*.log'], 'build'))).toEqual([]);
    expect(paths(await search.search(root, ['*.log'], 'node_modules'))).toEqual([]);
    expect(paths(await search.search(root, ['*.log'], 'debug'))).toEqual([]);
    expect(paths(await search.search(root, ['*.log'], 'config'))).toEqual([]);
  });

  it('does not offer symbolic links', async () => {
    await write({ 'real/file.txt': '', 'target.txt': '' });
    await fs.symlink(join(root, 'target.txt'), join(root, 'link-to-file.txt'));
    await fs.symlink(join(root, 'real'), join(root, 'link-to-dir'));
    const { search } = counted();
    expect(paths(await search.search(root, [], 'link'))).toEqual([]);
    expect(paths(await search.search(root, [], 'file'))).toEqual(['real/file.txt']);
  });

  it('stops at the limit and defaults to 30', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 45; index += 1)
      files[`item${String(index).padStart(2, '0')}.ts`] = '';
    await write(files);
    const { search } = counted();
    const limited = await search.search(root, [], 'item', 5);
    expect(paths(limited)).toEqual([
      'item00.ts',
      'item01.ts',
      'item02.ts',
      'item03.ts',
      'item04.ts',
    ]);
    expect(await search.search(root, [], 'item')).toHaveLength(30);
  });

  it('returns nothing for an empty or blank query without scanning', async () => {
    await write({ 'a.txt': '' });
    const { search, state } = counted();
    expect(await search.search(root, [], '')).toEqual([]);
    expect(await search.search(root, [], '   ')).toEqual([]);
    expect(state.scans).toBe(0);
  });

  it('reuses the listing until it expires', async () => {
    await write({ 'a.txt': '' });
    let time = 1000;
    const { search, state } = counted({ cacheMs: 500, now: () => time });
    expect(paths(await search.search(root, [], 'txt'))).toEqual(['a.txt']);
    await write({ 'b.txt': '' });
    time += 499;
    expect(paths(await search.search(root, [], 'txt'))).toEqual(['a.txt']);
    expect(state.scans).toBe(1);
    time += 2;
    expect(paths(await search.search(root, [], 'txt'))).toEqual(['a.txt', 'b.txt']);
    expect(state.scans).toBe(2);
  });

  it('scans again after invalidate, for one folder or for all', async () => {
    await write({ 'a.txt': '' });
    const { search, state } = counted();
    await search.search(root, [], 'txt');
    await write({ 'b.txt': '' });
    search.invalidate(join(root, 'elsewhere'));
    expect(paths(await search.search(root, [], 'txt'))).toEqual(['a.txt']);
    expect(state.scans).toBe(1);
    search.invalidate(root);
    expect(paths(await search.search(root, [], 'txt'))).toEqual(['a.txt', 'b.txt']);
    expect(state.scans).toBe(2);
    await write({ 'c.txt': '' });
    search.invalidate();
    expect(paths(await search.search(root, [], 'txt'))).toHaveLength(3);
    expect(state.scans).toBe(3);
  });

  it('scans again when the excludes change', async () => {
    await write({ 'a.txt': '', 'b.log': '' });
    const { search, state } = counted();
    expect(paths(await search.search(root, [], '.'))).toEqual(['a.txt', 'b.log']);
    expect(paths(await search.search(root, ['*.log'], '.'))).toEqual(['a.txt']);
    expect(state.scans).toBe(2);
  });

  it('lets concurrent searches of one folder share one scan', async () => {
    await write({ 'a.txt': '', 'b.md': '' });
    const { search, state } = counted();
    const [one, two, three] = await Promise.all([
      search.search(root, [], 'a'),
      search.search(root, [], 'b'),
      search.search(root, [], 'txt'),
    ]);
    expect(state.scans).toBe(1);
    expect(paths(one)).toEqual(['a.txt']);
    expect(paths(two)).toEqual(['b.md']);
    expect(paths(three)).toEqual(['a.txt']);
  });

  it('does not keep a failed scan', async () => {
    await write({ 'a.txt': '' });
    let fail = true;
    const search = createFileSearch({
      scan: (folder, rules, options) =>
        fail ? Promise.reject(new Error('disk gone')) : scanWorkspace(folder, rules, options),
    });
    await expect(search.search(root, [], 'a')).rejects.toThrow('disk gone');
    fail = false;
    expect(paths(await search.search(root, [], 'a'))).toEqual(['a.txt']);
  });

  it('hands maxEntries to the scan and keeps what it found when the folder is too big', async () => {
    await write({ 'a.txt': '', 'b.txt': '', 'c.txt': '' });
    const search = createFileSearch({ maxEntries: 2 });
    expect(await search.search(root, [], 'txt')).toHaveLength(2);
  });
});
