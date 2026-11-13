import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isRacy,
  loadIndex,
  saveIndex,
  statChanged,
  toFileState,
  type IndexEntry,
  type WorkspaceIndex,
} from './index-file';
import type { StatEntry } from './scanner';
import { makeTempDir, removeDir } from './test-helpers';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir('agc-index');
});
afterEach(async () => {
  await removeDir(dir);
});

const HASH = 'a'.repeat(64);

function stat(overrides: Partial<StatEntry> = {}): StatEntry {
  return {
    kind: 'file',
    size: 10,
    mtimeNs: 1_700_000_000_123_456_789n,
    ctimeNs: 1_700_000_001_123_456_789n,
    ino: 12345n,
    dev: 16777221n,
    mode: 0o644,
    ...overrides,
  };
}

describe('index file', () => {
  it('round-trips every field, including bigints beyond 2^53', async () => {
    const index: WorkspaceIndex = new Map<string, IndexEntry>([
      [
        'src/a.ts',
        {
          ...stat({ ino: 18446744073709551615n, mtimeNs: 9007199254740993n }),
          hash: HASH,
          stored: true,
          binary: false,
          hashedAtNs: 1_700_000_005_000_000_001n,
        },
      ],
      [
        'link',
        {
          ...stat({ kind: 'symlink', target: '../x y', mtimeNs: -5n }),
          stored: false,
          binary: false,
        },
      ],
      ['plain', { ...stat(), stored: false, binary: true }],
      ['weird "name"\nwith newline', { ...stat(), stored: false, binary: false }],
    ]);
    const file = join(dir, 'state', 'index.json');
    await saveIndex(file, index);
    const loaded = await loadIndex(file);
    expect(loaded).toEqual(index);
    expect(typeof loaded.get('src/a.ts')?.ino).toBe('bigint');
    expect(loaded.get('src/a.ts')?.ino).toBe(18446744073709551615n);
    expect(await fs.readdir(join(dir, 'state'))).toEqual(['index.json']);
  });

  it('returns an empty index for a missing file', async () => {
    expect((await loadIndex(join(dir, 'nope.json'))).size).toBe(0);
  });

  it('returns an empty index for a corrupt file instead of throwing', async () => {
    const file = join(dir, 'index.json');
    const good: WorkspaceIndex = new Map([['a', { ...stat(), stored: false, binary: false }]]);
    await saveIndex(file, good);
    const text = await fs.readFile(file, 'utf8');

    const damaged = [
      '',
      'not json',
      text.slice(0, text.length - 7),
      '[]',
      'null',
      '{"version":1}',
      '{"version":1,"entries":[]}',
      '{"version":99,"entries":{}}',
      text.replace('"mtimeNs":"1700000000123456789"', '"mtimeNs":"12.5"'),
      text.replace('"kind":"file"', '"kind":"dir"'),
      text.replace('"stored":false', '"stored":"no"'),
    ];
    for (const content of damaged) {
      await fs.writeFile(file, content);
      expect((await loadIndex(file)).size, content.slice(0, 40)).toBe(0);
    }
  });

  it('overwrites an existing index atomically', async () => {
    const file = join(dir, 'index.json');
    await saveIndex(file, new Map([['a', { ...stat(), stored: false, binary: false }]]));
    await saveIndex(file, new Map([['b', { ...stat(), stored: false, binary: false }]]));
    expect([...(await loadIndex(file)).keys()]).toEqual(['b']);
    expect(await fs.readdir(dir)).toEqual(['index.json']);
  });
});

describe('statChanged', () => {
  it('is false for identical stats', () => {
    expect(statChanged(stat(), stat())).toBe(false);
    expect(
      statChanged(stat({ kind: 'symlink', target: 'x' }), stat({ kind: 'symlink', target: 'x' })),
    ).toBe(false);
  });

  it.each<[string, Partial<StatEntry>]>([
    ['kind', { kind: 'symlink' }],
    ['size', { size: 11 }],
    ['mtimeNs', { mtimeNs: 1_700_000_000_123_456_790n }],
    ['ctimeNs', { ctimeNs: 1_700_000_001_123_456_790n }],
    ['ino', { ino: 12346n }],
    ['dev', { dev: 1n }],
    ['mode', { mode: 0o755 }],
    ['target', { target: 'elsewhere' }],
  ])('is true when %s differs', (_name, change) => {
    expect(statChanged(stat(), stat(change))).toBe(true);
    expect(statChanged(stat(change), stat())).toBe(true);
  });

  it('is true when a symlink target differs', () => {
    expect(
      statChanged(stat({ kind: 'symlink', target: 'a' }), stat({ kind: 'symlink', target: 'b' })),
    ).toBe(true);
  });
});

describe('isRacy', () => {
  const SECOND = 1_000_000_000n;
  const entry = (hashedAtNs: bigint | undefined, mtime: bigint, ctime: bigint): IndexEntry => ({
    ...stat({ mtimeNs: mtime, ctimeNs: ctime }),
    stored: true,
    binary: false,
    hash: HASH,
    ...(hashedAtNs === undefined ? {} : { hashedAtNs }),
  });
  const T = 1_700_000_000n * SECOND;

  it('is true when hashed within 2 s of mtime', () => {
    expect(isRacy(entry(T + SECOND, T, T - 100n * SECOND))).toBe(true);
    expect(isRacy(entry(T + 2n * SECOND - 1n, T, T - 100n * SECOND))).toBe(true);
  });

  it('is true when hashed within 2 s of ctime', () => {
    expect(isRacy(entry(T + SECOND, T - 100n * SECOND, T))).toBe(true);
  });

  it('is true when the file was modified after it was hashed', () => {
    expect(isRacy(entry(T, T + 5n * SECOND, T - 100n * SECOND))).toBe(true);
  });

  it('is false once the entry is at least 2 s older than its timestamps', () => {
    expect(isRacy(entry(T + 2n * SECOND, T, T))).toBe(false);
    expect(isRacy(entry(T + 60n * SECOND, T, T - SECOND))).toBe(false);
  });

  it('is false for an entry that was never hashed', () => {
    expect(isRacy(entry(undefined, T, T))).toBe(false);
  });
});

describe('toFileState', () => {
  it('maps absent, symlink, hashed file and stat-only file', () => {
    expect(toFileState(undefined)).toEqual({ kind: 'absent' });
    expect(
      toFileState({ ...stat({ kind: 'symlink', target: 't' }), stored: false, binary: false }),
    ).toEqual({
      kind: 'symlink',
      target: 't',
    });
    expect(toFileState({ ...stat(), hash: HASH, stored: true, binary: false })).toEqual({
      kind: 'file',
      hash: HASH,
      size: 10,
      mode: 0o644,
      stored: true,
      binary: false,
    });
    const statOnly = toFileState({ ...stat(), stored: false, binary: false });
    expect(statOnly).toEqual({ kind: 'file', size: 10, mode: 0o644, stored: false, binary: false });
    expect('hash' in statOnly).toBe(false);
  });
});
