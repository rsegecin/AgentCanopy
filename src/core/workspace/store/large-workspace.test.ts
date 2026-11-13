import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadIgnoreRules } from './ignore-rules';
import { refreshIndex } from './refresh';
import { scanWorkspace } from './scanner';
import { createBlobStore } from './blob-store';
import { makeTempDir, removeDir } from './test-helpers';

const DIRS = 200;
const FILES_PER_DIR = 100;
const TOTAL = DIRS * FILES_PER_DIR;

let dir: string;
let root: string;

beforeAll(async () => {
  dir = await makeTempDir('agc-large');
  root = join(dir, 'ws');
  await fs.mkdir(root);
}, 120_000);
afterAll(async () => {
  await removeDir(dir);
}, 120_000);

describe('large workspace', () => {
  it('scans and refreshes 20,000 files and finds exactly the touched ones', async () => {
    let started = performance.now();
    for (let d = 0; d < DIRS; d += 1) {
      const sub = join(root, `dir-${String(d).padStart(3, '0')}`);
      await fs.mkdir(sub);
      await Promise.all(
        Array.from({ length: FILES_PER_DIR }, (_, f) =>
          fs.writeFile(join(sub, `file-${f}.txt`), `content ${d}/${f}\n`),
        ),
      );
    }
    console.info(
      `large workspace: generated ${TOTAL} files in ${Math.round(performance.now() - started)} ms`,
    );

    const rules = await loadIgnoreRules(root, []);
    const blobs = createBlobStore(join(dir, 'blobs'));
    const common = {
      root,
      rules,
      blobs,
      mode: 'stat-only' as const,
      maxFileBytes: 10 * 1024 * 1024,
      maxTotalBytes: 512 * 1024 * 1024,
    };

    started = performance.now();
    const scan1 = await scanWorkspace(root, rules);
    const scanMs1 = Math.round(performance.now() - started);
    expect(scan1.entries.size).toBe(TOTAL);
    expect(scan1.truncated).toBe(false);
    expect(scan1.unreadable).toEqual([]);

    started = performance.now();
    const refresh1 = await refreshIndex({ ...common, scan: scan1, previous: new Map() });
    const refreshMs1 = Math.round(performance.now() - started);
    expect(refresh1.added).toHaveLength(TOTAL);
    expect(refresh1.changed).toEqual([]);
    expect(refresh1.removed).toEqual([]);
    expect(refresh1.index.size).toBe(TOTAL);

    // Touch ten files spread over the tree.
    const touched: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const rel = `dir-${String(i * 17).padStart(3, '0')}/file-${i * 7}.txt`;
      touched.push(rel);
      await fs.utimes(join(root, rel), 1_500_000_000 + i, 1_500_000_000 + i);
    }

    started = performance.now();
    const scan2 = await scanWorkspace(root, rules);
    const scanMs2 = Math.round(performance.now() - started);
    started = performance.now();
    const refresh2 = await refreshIndex({ ...common, scan: scan2, previous: refresh1.index });
    const refreshMs2 = Math.round(performance.now() - started);

    expect(scan2.entries.size).toBe(TOTAL);
    expect(refresh2.changed).toEqual([...touched].sort());
    expect(refresh2.added).toEqual([]);
    expect(refresh2.removed).toEqual([]);
    expect(refresh2.index.size).toBe(TOTAL);

    console.info(
      `large workspace timings (ms): scan ${scanMs1}, stat-only refresh ${refreshMs1}, ` +
        `rescan ${scanMs2}, second refresh ${refreshMs2}`,
    );
  }, 120_000);
});
