import { execFile } from 'node:child_process';
import { promises as fs, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIgnoreRules, type IgnoreRules } from './ignore-rules';
import { AbortError } from './internal';
import { scanWorkspace } from './scanner';
import { makeTempDir, removeDir, writeTree } from './test-helpers';

const run = promisify(execFile);
const posix = process.platform !== 'win32';

let root: string;
beforeEach(async () => {
  root = await makeTempDir('agc-scan');
});
afterEach(async () => {
  await removeDir(root);
});

async function scanKeys(rules?: IgnoreRules): Promise<string[]> {
  const result = await scanWorkspace(root, rules ?? (await loadIgnoreRules(root, [])));
  return [...result.entries.keys()].sort();
}

describe('scanWorkspace', () => {
  it('records files in nested directories with their stat', async () => {
    await writeTree(root, { 'a.txt': 'hello', 'src/b.ts': 'x', 'src/deep/er/c.md': '' });
    const result = await scanWorkspace(root, await loadIgnoreRules(root, []));
    expect([...result.entries.keys()].sort()).toEqual(['a.txt', 'src/b.ts', 'src/deep/er/c.md']);
    expect(result.truncated).toBe(false);
    expect(result.unreadable).toEqual([]);
    const entry = result.entries.get('a.txt')!;
    const real = await fs.lstat(join(root, 'a.txt'), { bigint: true });
    expect(entry).toMatchObject({ kind: 'file', size: 5 });
    expect(entry.mtimeNs).toBe(real.mtimeNs);
    expect(entry.ctimeNs).toBe(real.ctimeNs);
    expect(entry.ino).toBe(real.ino);
    expect(entry.dev).toBe(real.dev);
    expect(typeof entry.mtimeNs).toBe('bigint');
    if (posix) expect(entry.mode).toBe(Number(real.mode & 0o7777n));
    expect(entry.target).toBeUndefined();
  });

  it('does not track empty directories and skips built-in exclusions and gitignored paths', async () => {
    await writeTree(root, {
      '.gitignore': 'ignored/\n*.log\n',
      'keep.txt': 'k',
      'ignored/x.txt': 'x',
      'a.log': 'l',
      '.git/HEAD': 'ref',
      'node_modules/m/index.js': 'm',
      '.DS_Store': '',
      'sub/.gitignore': '!a.log\n',
      'sub/a.log': 'allowed here',
    });
    await fs.mkdir(join(root, 'empty-dir'));
    expect(await scanKeys()).toEqual(['.gitignore', 'keep.txt', 'sub/.gitignore', 'sub/a.log']);
  });

  it.skipIf(!posix)('does not enter an ignored directory', async () => {
    await writeTree(root, { '.gitignore': 'vendor/\n', 'ok.txt': 'x' });
    await writeTree(root, { 'vendor/inner/file.txt': 'x', 'node_modules/pkg/index.js': 'x' });
    // If either directory were entered, the unreadable marker would show up in the result.
    await fs.chmod(join(root, 'vendor', 'inner'), 0o000);
    await fs.chmod(join(root, 'node_modules', 'pkg'), 0o000);
    try {
      const result = await scanWorkspace(root, await loadIgnoreRules(root, []));
      expect(result.unreadable).toEqual([]);
      expect([...result.entries.keys()].sort()).toEqual(['.gitignore', 'ok.txt']);
    } finally {
      await fs.chmod(join(root, 'vendor', 'inner'), 0o700);
      await fs.chmod(join(root, 'node_modules', 'pkg'), 0o700);
    }
  });

  it('records symlinks to files and directories without following them', async () => {
    await writeTree(root, { 'real/file.txt': 'x', 'target.txt': 'x' });
    await fs.symlink('target.txt', join(root, 'link-file'));
    await fs.symlink('real', join(root, 'link-dir'));
    await fs.symlink('does-not-exist', join(root, 'dangling'));
    const result = await scanWorkspace(root, await loadIgnoreRules(root, []));
    expect([...result.entries.keys()].sort()).toEqual([
      'dangling',
      'link-dir',
      'link-file',
      'real/file.txt',
      'target.txt',
    ]);
    expect(result.entries.get('link-file')).toMatchObject({
      kind: 'symlink',
      target: 'target.txt',
    });
    expect(result.entries.get('link-dir')).toMatchObject({ kind: 'symlink', target: 'real' });
    expect(result.entries.get('dangling')).toMatchObject({
      kind: 'symlink',
      target: 'does-not-exist',
    });
    expect(result.entries.has('link-dir/file.txt')).toBe(false);
  });

  it('survives a symlink loop', async () => {
    await fs.mkdir(join(root, 'loop'));
    await fs.symlink('..', join(root, 'loop', 'up'));
    await fs.symlink('self', join(root, 'self'));
    await writeTree(root, { 'loop/f.txt': 'x' });
    expect(await scanKeys()).toEqual(['loop/f.txt', 'loop/up', 'self']);
  });

  it.skipIf(!posix)('skips FIFOs', async () => {
    await writeTree(root, { 'f.txt': 'x' });
    await run('mkfifo', [join(root, 'pipe')]);
    expect(await scanKeys()).toEqual(['f.txt']);
  });

  it('skips an entry that vanishes during the walk', async () => {
    await writeTree(root, { 'stay.txt': 'x', 'vanish.txt': 'x', 'd/vanish-too.txt': 'x' });
    const base = await loadIgnoreRules(root, []);
    let deleted = false;
    const rules: IgnoreRules = {
      ...base,
      isIgnored(path, isDirectory) {
        // Called after readdir listed the directory and before the entries are statted.
        if (!deleted && path === 'vanish.txt') {
          deleted = true;
          rmSync(join(root, 'vanish.txt'));
          rmSync(join(root, 'd'), { recursive: true });
        }
        return base.isIgnored(path, isDirectory);
      },
    };
    const keys = await scanKeys(rules);
    expect(keys).toContain('stay.txt');
    expect(keys).not.toContain('vanish.txt');
    expect(keys).not.toContain('d/vanish-too.txt');
    expect(deleted).toBe(true);
  });

  it.skipIf(!posix)('records an unreadable directory and carries on', async () => {
    await writeTree(root, { 'ok/a.txt': 'x', 'locked/b.txt': 'x', 'top.txt': 'x' });
    await fs.chmod(join(root, 'locked'), 0o000);
    const result = await scanWorkspace(root, await loadIgnoreRules(root, [])).finally(() =>
      fs.chmod(join(root, 'locked'), 0o700),
    );
    expect(result.unreadable).toEqual(['locked']);
    expect([...result.entries.keys()].sort()).toEqual(['ok/a.txt', 'top.txt']);
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    await writeTree(root, { 'a.txt': 'x' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      scanWorkspace(root, await loadIgnoreRules(root, []), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('rejects with AbortError when the signal fires mid-scan', async () => {
    const files: Record<string, string> = {};
    for (let d = 0; d < 20; d += 1) for (let f = 0; f < 20; f += 1) files[`d${d}/f${f}`] = 'x';
    await writeTree(root, files);
    const controller = new AbortController();
    const promise = scanWorkspace(root, await loadIgnoreRules(root, []), {
      signal: controller.signal,
      onProgress: (seen) => {
        if (seen > 50) controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops at maxEntries and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) files[`d${i % 3}/f${i}.txt`] = 'x';
    await writeTree(root, files);
    const rules = await loadIgnoreRules(root, []);

    const limited = await scanWorkspace(root, rules, { maxEntries: 10 });
    expect(limited.truncated).toBe(true);
    expect(limited.entries.size).toBe(10);

    const exact = await scanWorkspace(root, rules, { maxEntries: 30 });
    expect(exact.truncated).toBe(false);
    expect(exact.entries.size).toBe(30);
  });

  it('reports progress', async () => {
    await writeTree(root, { a: 'x', b: 'x' });
    const seen: number[] = [];
    await scanWorkspace(root, await loadIgnoreRules(root, []), { onProgress: (n) => seen.push(n) });
    expect(seen.at(-1)).toBe(2);
  });

  it('keeps names exactly: spaces, a leading dash, and both Unicode spellings', async () => {
    const nfc = 'café.txt';
    const nfd = 'café.txt';
    await writeTree(root, { 'with space/a b.txt': 'x', '-dash.txt': 'x', '--flag': 'x' });
    await fs.writeFile(join(root, nfc), 'nfc content');
    await fs.writeFile(join(root, nfd), 'nfd content');
    const onDisk = (await fs.readdir(root)).sort();
    const keys = await scanKeys();
    // Whatever the filesystem kept, we report the names exactly as readdir returned them.
    expect(keys.filter((k) => k.includes('caf'))).toEqual(onDisk.filter((n) => n.includes('caf')));
    if (onDisk.filter((n) => n.includes('caf')).length === 2) {
      expect(keys).toContain(nfc);
      expect(keys).toContain(nfd);
    }
    expect(keys).toContain('with space/a b.txt');
    expect(keys).toContain('-dash.txt');
    expect(keys).toContain('--flag');
  });

  it('keeps case-different names distinct where the filesystem does', async () => {
    await fs.writeFile(join(root, 'Readme.md'), 'upper');
    await fs.writeFile(join(root, 'readme.md'), 'lower');
    const onDisk = (await fs.readdir(root)).sort();
    expect(await scanKeys()).toEqual(onDisk);
  });

  it('rejects when the root cannot be read', async () => {
    await expect(
      scanWorkspace(join(root, 'missing'), await loadIgnoreRules(root, [])),
    ).rejects.toThrow();
  });
});
