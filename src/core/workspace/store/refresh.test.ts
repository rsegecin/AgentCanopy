import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlobStore, type BlobStore } from './blob-store';
import { loadIgnoreRules, type IgnoreRules } from './ignore-rules';
import type { WorkspaceIndex } from './index-file';
import { AbortError } from './internal';
import { isManifestOrLockfile, refreshIndex, type RefreshInput } from './refresh';
import { scanWorkspace, type ScanResult } from './scanner';
import { makeTempDir, removeDir, writeTree } from './test-helpers';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const posix = process.platform !== 'win32';
const MB = 1024 * 1024;

let dir: string;
let root: string;
let blobs: BlobStore;
let rules: IgnoreRules;
/** Paths handed to captureFile, in order. */
let captured: string[];
let countingBlobs: BlobStore;

beforeEach(async () => {
  dir = await makeTempDir('agc-refresh');
  root = join(dir, 'ws');
  await fs.mkdir(root);
  blobs = createBlobStore(join(dir, 'blobs'));
  captured = [];
  countingBlobs = {
    ...blobs,
    captureFile(path, maxBytes, options) {
      captured.push(path.slice(root.length + 1));
      return blobs.captureFile(path, maxBytes, options);
    },
  };
  rules = await loadIgnoreRules(root, []);
});
afterEach(async () => {
  await removeDir(dir);
});

async function scan(): Promise<ScanResult> {
  return scanWorkspace(root, rules);
}

async function refresh(
  previous: WorkspaceIndex,
  overrides: Partial<RefreshInput> = {},
  scanResult?: ScanResult,
) {
  return refreshIndex({
    root,
    scan: scanResult ?? (await scan()),
    previous,
    blobs: countingBlobs,
    rules,
    mode: 'content',
    maxFileBytes: 10 * MB,
    maxTotalBytes: 512 * MB,
    ...overrides,
  });
}

/** Pretends the previous run happened an hour ago, so nothing is racy. */
function aged(index: WorkspaceIndex): WorkspaceIndex {
  const out: WorkspaceIndex = new Map();
  for (const [path, entry] of index) {
    out.set(
      path,
      entry.hashedAtNs === undefined
        ? entry
        : { ...entry, hashedAtNs: entry.hashedAtNs + 3_600_000_000_000n },
    );
  }
  return out;
}

async function setMtime(path: string, seconds: number): Promise<void> {
  await fs.utimes(join(root, path), seconds, seconds);
}

describe('first content run', () => {
  it('captures every file within the limits and reports them as added', async () => {
    await writeTree(root, {
      'a.txt': 'alpha\n',
      'src/b.ts': 'export const b = 1;\n',
      'empty.txt': '',
      'bin.dat': Buffer.from([1, 2, 0, 3]),
      'bad-utf8.txt': Buffer.from([0xc3, 0x28]),
    });
    await fs.symlink('a.txt', join(root, 'link'));
    const progress: [number, number][] = [];
    const result = await refresh(new Map(), { onProgress: (d, t) => progress.push([d, t]) });

    expect(result.added).toEqual([
      'a.txt',
      'bad-utf8.txt',
      'bin.dat',
      'empty.txt',
      'link',
      'src/b.ts',
    ]);
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.notCaptured).toEqual([]);

    const entry = result.index.get('a.txt')!;
    expect(entry).toMatchObject({
      kind: 'file',
      hash: sha('alpha\n'),
      stored: true,
      binary: false,
      size: 6,
    });
    expect(entry.hashedAtNs).toBeTypeOf('bigint');
    expect((await blobs.get(entry.hash!)).toString()).toBe('alpha\n');
    expect(result.index.get('empty.txt')).toMatchObject({
      hash: sha(''),
      stored: true,
      binary: false,
    });
    expect(result.index.get('bin.dat')).toMatchObject({ stored: true, binary: true });
    expect(result.index.get('bad-utf8.txt')).toMatchObject({ stored: true, binary: true });
    expect(result.index.get('link')).toMatchObject({
      kind: 'symlink',
      target: 'a.txt',
      stored: false,
    });
    expect(result.index.get('link')!.hash).toBeUndefined();
    expect(captured.sort()).toEqual(['a.txt', 'bad-utf8.txt', 'bin.dat', 'empty.txt', 'src/b.ts']);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it('reads the most recently modified files first', async () => {
    await writeTree(root, { old: 'o', mid: 'm', new: 'n' });
    await setMtime('old', 1_000_000_000);
    await setMtime('mid', 1_200_000_000);
    await setMtime('new', 1_400_000_000);
    await refresh(new Map());
    // All start together, in order.
    expect(captured).toEqual(['new', 'mid', 'old']);
  });
});

describe('second run', () => {
  it('reads nothing when nothing changed (counted)', async () => {
    await writeTree(root, { 'a.txt': 'a', 'd/b.txt': 'b' });
    const first = await refresh(new Map());
    captured.length = 0;
    const second = await refresh(aged(first.index));
    expect(captured).toEqual([]);
    expect(second.added).toEqual([]);
    expect(second.changed).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.index.get('a.txt')).toEqual(aged(first.index).get('a.txt'));
  });

  it.skipIf(!posix)(
    'reads nothing when nothing changed (proved by an unreadable file)',
    async () => {
      await writeTree(root, { 'a.txt': 'a', 'b.txt': 'b' });
      const first = await refresh(new Map());
      const scanned = await scan();
      await fs.chmod(join(root, 'b.txt'), 0o000);
      try {
        const second = await refresh(aged(first.index), {}, scanned);
        expect(second.notCaptured).toEqual([]);
        expect(second.changed).toEqual([]);
        expect(second.index.get('b.txt')).toMatchObject({ hash: sha('b'), stored: true });
      } finally {
        await fs.chmod(join(root, 'b.txt'), 0o600);
      }
    },
  );

  it('re-reads an entry hashed within 2 s of its timestamps (racy) but reports no change', async () => {
    await writeTree(root, { 'a.txt': 'a' });
    const first = await refresh(new Map());
    captured.length = 0;
    const second = await refresh(first.index);
    expect(captured).toEqual(['a.txt']);
    expect(second.changed).toEqual([]);
    expect(second.added).toEqual([]);
  });

  it('detects a content change that keeps size and mtime, through ctime', async () => {
    await writeTree(root, { 'a.txt': 'aaaa' });
    await setMtime('a.txt', 1_600_000_000);
    const first = await refresh(new Map());
    const index = aged(first.index);
    const before = index.get('a.txt')!;

    await fs.writeFile(join(root, 'a.txt'), 'bbbb');
    await setMtime('a.txt', 1_600_000_000);
    const scanned = await scan();
    const now = scanned.entries.get('a.txt')!;
    expect(now.size).toBe(before.size);
    expect(now.mtimeNs).toBe(before.mtimeNs);
    expect(now.ctimeNs).not.toBe(before.ctimeNs);

    const second = await refresh(index, {}, scanned);
    expect(second.changed).toEqual(['a.txt']);
    expect(second.index.get('a.txt')).toMatchObject({ hash: sha('bbbb'), stored: true });
  });

  it('does not report a touch without a content change', async () => {
    await writeTree(root, { 'a.txt': 'same' });
    const first = await refresh(new Map());
    const index = aged(first.index);
    await setMtime('a.txt', 1_500_000_000);
    captured.length = 0;
    const second = await refresh(index);
    expect(captured).toEqual(['a.txt']);
    expect(second.changed).toEqual([]);
    expect(second.index.get('a.txt')!.mtimeNs).toBe(1_500_000_000_000_000_000n);
    expect(second.index.get('a.txt')!.hash).toBe(sha('same'));
  });

  it.skipIf(!posix)('reports a chmod-only change as changed', async () => {
    await writeTree(root, { 'run.sh': '#!/bin/sh\n' });
    await fs.chmod(join(root, 'run.sh'), 0o644);
    const first = await refresh(new Map());
    await fs.chmod(join(root, 'run.sh'), 0o755);
    const second = await refresh(aged(first.index));
    expect(second.changed).toEqual(['run.sh']);
    expect(second.index.get('run.sh')).toMatchObject({ mode: 0o755, hash: sha('#!/bin/sh\n') });
  });

  it('reports added, deleted and modified files', async () => {
    await writeTree(root, { keep: 'k', edit: 'before', gone: 'g' });
    const first = await refresh(new Map());
    await writeTree(root, { edit: 'after!', fresh: 'f' });
    await fs.rm(join(root, 'gone'));
    const second = await refresh(aged(first.index));
    expect(second.added).toEqual(['fresh']);
    expect(second.changed).toEqual(['edit']);
    expect(second.removed).toEqual(['gone']);
    expect([...second.index.keys()].sort()).toEqual(['edit', 'fresh', 'keep']);
  });

  it('reports a file replaced by a symlink as changed, and back again', async () => {
    await writeTree(root, { thing: 'content', other: 'o' });
    const first = await refresh(new Map());
    await fs.rm(join(root, 'thing'));
    await fs.symlink('other', join(root, 'thing'));
    const second = await refresh(aged(first.index));
    expect(second.changed).toEqual(['thing']);
    expect(second.index.get('thing')).toMatchObject({ kind: 'symlink', target: 'other' });
    expect(second.index.get('thing')!.hash).toBeUndefined();

    await fs.rm(join(root, 'thing'));
    await fs.writeFile(join(root, 'thing'), 'content');
    const third = await refresh(aged(second.index));
    expect(third.changed).toEqual(['thing']);
    expect(third.index.get('thing')).toMatchObject({ kind: 'file', hash: sha('content') });
  });

  it('reports a retargeted symlink as changed', async () => {
    await fs.symlink('one', join(root, 'l'));
    const first = await refresh(new Map());
    await fs.rm(join(root, 'l'));
    await fs.symlink('two', join(root, 'l'));
    const second = await refresh(first.index);
    expect(second.changed).toEqual(['l']);
  });

  it('re-reads only forced paths when forceRehash is given', async () => {
    await writeTree(root, { a: 'a', b: 'b' });
    const first = await refresh(new Map());
    captured.length = 0;
    const second = await refresh(aged(first.index), { forceRehash: new Set(['b', 'not-there']) });
    expect(captured).toEqual(['b']);
    expect(second.changed).toEqual([]);
  });

  it('picks up content that was only tracked by stat before', async () => {
    await writeTree(root, { a: 'a' });
    const statOnly = await refresh(new Map(), { mode: 'stat-only' });
    expect(statOnly.index.get('a')!.hash).toBeUndefined();
    captured.length = 0;
    const content = await refresh(statOnly.index);
    expect(captured).toEqual(['a']);
    expect(content.index.get('a')).toMatchObject({ hash: sha('a'), stored: true });
    expect(content.changed).toEqual([]);
    expect(content.added).toEqual([]);
  });
});

describe('limits', () => {
  it('does not capture a file over maxFileBytes, and keeps it tracked by stat', async () => {
    await writeTree(root, { 'small.txt': 'ok', 'big.txt': 'x'.repeat(200) });
    const result = await refresh(new Map(), { maxFileBytes: 100 });
    expect(result.notCaptured).toEqual([{ path: 'big.txt', reason: 'too-large' }]);
    expect(result.index.get('big.txt')).toMatchObject({ kind: 'file', size: 200, stored: false });
    expect(result.index.get('big.txt')!.hash).toBeUndefined();
    expect(result.index.get('small.txt')).toMatchObject({ stored: true });
    expect(result.added).toContain('big.txt');
    expect(await blobs.list()).toHaveLength(1);
  });

  it('stops storing at the total budget but keeps hashing', async () => {
    const files: Record<string, Buffer> = {};
    for (const name of ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']) files[name] = randomBytes(1000);
    await writeTree(root, files);
    // f6 is the most recent, f1 the oldest.
    for (let i = 1; i <= 6; i += 1) await setMtime(`f${i}`, 1_000_000_000 + i * 1000);
    const result = await refresh(new Map(), { maxTotalBytes: 2500 });

    const stored = [...result.index]
      .filter(([, e]) => e.stored)
      .map(([p]) => p)
      .sort();
    const skipped = result.notCaptured
      .filter((n) => n.reason === 'budget')
      .map((n) => n.path)
      .sort();
    expect(stored.length).toBeGreaterThan(0);
    expect(skipped.length).toBeGreaterThan(0);
    expect([...stored, ...skipped].sort()).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
    // The most recently modified files get the budget.
    expect(stored).toContain('f6');
    expect(skipped).toContain('f1');
    for (const [path, entry] of result.index) {
      expect(entry.hash, path).toBe(sha(files[path]!));
    }
    expect(await blobs.list()).toHaveLength(stored.length);
  });

  it('counts what is already in the store towards the budget', async () => {
    await blobs.put(randomBytes(5000));
    await writeTree(root, { a: 'a', b: 'b' });
    const result = await refresh(new Map(), { maxTotalBytes: 1000 });
    expect(result.notCaptured).toEqual([
      { path: 'a', reason: 'budget' },
      { path: 'b', reason: 'budget' },
    ]);
    expect(result.index.get('a')).toMatchObject({ hash: sha('a'), stored: false });
    expect(await blobs.has(sha('a'))).toBe(false);
  });

  it('stores sensitive files as a hash only', async () => {
    await writeTree(root, { '.env': 'SECRET=1\n', 'ok.txt': 'fine', 'keys/server.pem': 'pem' });
    const result = await refresh(new Map());
    expect(result.notCaptured).toEqual([
      { path: '.env', reason: 'sensitive' },
      { path: 'keys/server.pem', reason: 'sensitive' },
    ]);
    expect(result.index.get('.env')).toMatchObject({
      hash: sha('SECRET=1\n'),
      stored: false,
      binary: false,
    });
    expect(await blobs.has(sha('SECRET=1\n'))).toBe(false);
    expect(await blobs.has(sha('fine'))).toBe(true);
  });

  it('lets alwaysCapture override the size limit and the budget', async () => {
    await blobs.put(randomBytes(5000));
    const lock = 'lock '.repeat(100);
    await writeTree(root, {
      'package-lock.json': lock,
      'other.json': 'x'.repeat(500),
      'pkg/package.json': '{}',
    });
    const result = await refresh(new Map(), {
      maxFileBytes: 100,
      maxTotalBytes: 1000,
      alwaysCapture: isManifestOrLockfile,
    });
    expect(result.index.get('package-lock.json')).toMatchObject({ hash: sha(lock), stored: true });
    expect(result.index.get('pkg/package.json')).toMatchObject({ hash: sha('{}'), stored: true });
    expect(await blobs.has(sha(lock))).toBe(true);
    expect(result.index.get('other.json')).toMatchObject({ stored: false });
    expect(result.notCaptured).toEqual([{ path: 'other.json', reason: 'too-large' }]);
  });

  it('never stores a sensitive file, even when alwaysCapture asks', async () => {
    await writeTree(root, { '.env': 'S=1' });
    const result = await refresh(new Map(), { alwaysCapture: () => true });
    expect(result.index.get('.env')).toMatchObject({ hash: sha('S=1'), stored: false });
  });

  it.skipIf(!posix)('records an unreadable file and keeps it tracked by stat', async () => {
    await writeTree(root, { 'locked.txt': 'x', 'ok.txt': 'y' });
    await fs.chmod(join(root, 'locked.txt'), 0o000);
    try {
      const result = await refresh(new Map());
      expect(result.notCaptured).toEqual([{ path: 'locked.txt', reason: 'unreadable' }]);
      expect(result.index.get('locked.txt')).toMatchObject({ stored: false });
      expect(result.index.get('locked.txt')!.hash).toBeUndefined();
      expect(result.index.get('ok.txt')).toMatchObject({ stored: true });
    } finally {
      await fs.chmod(join(root, 'locked.txt'), 0o600);
    }
  });
});

describe('stat-only mode', () => {
  it('never reads content', async () => {
    await writeTree(root, { 'a.txt': 'a', '.env': 's', 'big.bin': 'x'.repeat(100) });
    const result = await refresh(new Map(), { mode: 'stat-only', maxFileBytes: 10 });
    expect(captured).toEqual([]);
    expect(await blobs.list()).toEqual([]);
    expect(result.notCaptured).toEqual([]);
    expect(result.added).toEqual(['.env', 'a.txt', 'big.bin']);
    for (const entry of result.index.values()) {
      expect(entry.hash).toBeUndefined();
      expect(entry.stored).toBe(false);
    }
  });

  it('keeps a known hash while the stat is unchanged and forgets it when the stat moves', async () => {
    await writeTree(root, { a: 'a', b: 'b' });
    const first = await refresh(new Map());
    const index = aged(first.index);
    await fs.writeFile(join(root, 'b'), 'bb');
    captured.length = 0;
    const second = await refresh(index, { mode: 'stat-only', forceRehash: new Set(['a']) });
    expect(captured).toEqual([]);
    expect(second.index.get('a')).toEqual(index.get('a'));
    expect(second.index.get('b')!.hash).toBeUndefined();
    expect(second.changed).toEqual(['b']);
  });
});

describe('races and gaps in the scan', () => {
  it('records a file deleted between scan and capture as gone', async () => {
    await writeTree(root, { stay: 's', vanish: 'v', 'was-known': 'w' });
    const first = await refresh(new Map(), {}, await scanOnly(['was-known']));
    const scanned = await scan();
    await fs.rm(join(root, 'vanish'));
    await fs.rm(join(root, 'was-known'));
    const second = await refresh(first.index, {}, scanned);
    expect(second.notCaptured).toEqual([
      { path: 'vanish', reason: 'gone' },
      { path: 'was-known', reason: 'gone' },
    ]);
    expect(second.index.has('vanish')).toBe(false);
    expect(second.added).toEqual(['stay']);
    expect(second.removed).toEqual(['was-known']);
  });

  it('records a file replaced by a symlink between scan and capture as gone, not followed', async () => {
    await writeTree(root, { target: 'secret', swap: 'plain' });
    const scanned = await scan();
    await fs.rm(join(root, 'swap'));
    await fs.symlink('target', join(root, 'swap'));
    const result = await refresh(new Map(), {}, scanned);
    expect(result.notCaptured).toEqual([{ path: 'swap', reason: 'gone' }]);
    expect(result.index.has('swap')).toBe(false);
  });

  it('uses the newer stat when the file changed while being read, and reads it again next time', async () => {
    await writeTree(root, { 'a.txt': 'old' });
    const changing: BlobStore = {
      ...blobs,
      async captureFile(path, maxBytes, options) {
        const result = await blobs.captureFile(path, maxBytes, options);
        await fs.writeFile(path, 'a longer replacement');
        return result;
      },
    };
    const first = await refresh(new Map(), { blobs: changing });
    const entry = first.index.get('a.txt')!;
    // The hash still describes the bytes that were stored.
    expect(entry.hash).toBe(sha('old'));
    expect((await blobs.get(entry.hash!)).toString()).toBe('old');
    const real = await fs.lstat(join(root, 'a.txt'), { bigint: true });
    expect(entry.mtimeNs).toBe(real.mtimeNs);
    expect(entry.ctimeNs).toBe(real.ctimeNs);

    // Even with an old "hashed at" time, the stat (size) no longer matches: it is read again.
    const second = await refresh(first.index);
    expect(second.changed).toEqual(['a.txt']);
    expect(second.index.get('a.txt')!.hash).toBe(sha('a longer replacement'));
  });

  it('keeps entries below an unreadable directory instead of reporting them removed', async () => {
    await writeTree(root, {
      'top.txt': 't',
      'locked/a.txt': 'a',
      'locked/deep/b.txt': 'b',
      'lockedness.txt': 'l',
    });
    const first = await refresh(new Map());
    const partial = await scan();
    partial.entries.delete('locked/a.txt');
    partial.entries.delete('locked/deep/b.txt');
    partial.unreadable.push('locked');
    const second = await refresh(aged(first.index), {}, partial);
    expect(second.removed).toEqual([]);
    expect(second.index.has('locked/a.txt')).toBe(true);
    expect(second.index.has('locked/deep/b.txt')).toBe(true);
  });

  it('does not report anything missing from a truncated scan as removed', async () => {
    await writeTree(root, { a: 'a', b: 'b', c: 'c' });
    const first = await refresh(new Map());
    const partial = await scan();
    partial.entries.delete('b');
    partial.entries.delete('c');
    partial.truncated = true;
    const second = await refresh(aged(first.index), {}, partial);
    expect(second.removed).toEqual([]);
    expect([...second.index.keys()].sort()).toEqual(['a', 'b', 'c']);

    const complete = await refresh(aged(first.index), {}, { ...partial, truncated: false });
    expect(complete.removed).toEqual(['b', 'c']);
  });

  it('rejects with AbortError when the signal fires', async () => {
    await writeTree(root, { a: 'a', b: 'b' });
    const controller = new AbortController();
    controller.abort();
    await expect(refresh(new Map(), { signal: controller.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
  });
});

/** A scan that only contains the given paths (as if the rest did not exist yet). */
async function scanOnly(paths: string[]): Promise<ScanResult> {
  const full = await scan();
  for (const key of [...full.entries.keys()]) if (!paths.includes(key)) full.entries.delete(key);
  return full;
}

describe('isManifestOrLockfile', () => {
  it('matches manifests and lockfiles by basename at any depth', () => {
    const yes = [
      'package.json',
      'a/b/package-lock.json',
      'npm-shrinkwrap.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lockb',
      'Cargo.toml',
      'Cargo.lock',
      'go.mod',
      'go.sum',
      'pyproject.toml',
      'poetry.lock',
      'uv.lock',
      'requirements.txt',
      'Pipfile',
      'Pipfile.lock',
      'Gemfile',
      'Gemfile.lock',
      'composer.json',
      'composer.lock',
    ];
    for (const path of yes) expect(isManifestOrLockfile(path), path).toBe(true);
    for (const path of [
      'package.json.bak',
      'my-package.json',
      'src/index.ts',
      'requirements-dev.txt',
      'cargo.toml',
    ]) {
      expect(isManifestOrLockfile(path), path).toBe(false);
    }
  });
});
