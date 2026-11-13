import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { RelPath } from '../../../shared';
import type { BlobStore } from './blob-store';
import { isRacy, statChanged, type IndexEntry, type WorkspaceIndex } from './index-file';
import type { IgnoreRules } from './ignore-rules';
import { throwIfAborted } from './internal';
import { toStatEntry, type ScanResult, type StatEntry } from './scanner';

export type NotCapturedReason = 'too-large' | 'budget' | 'sensitive' | 'gone' | 'unreadable';

export interface RefreshInput {
  root: string;
  scan: ScanResult;
  previous: WorkspaceIndex;
  blobs: BlobStore;
  rules: IgnoreRules;
  /** `stat-only` never reads file content. `content` hashes and stores. */
  mode: 'stat-only' | 'content';
  maxFileBytes: number;
  maxTotalBytes: number;
  /**
   * Paths that are stored whatever the size and the budget. A sensitive path is still never stored:
   * it is hashed only, so the after-state of an edit to a `.env` file is not restorable.
   */
  alwaysCapture?: (relPath: string) => boolean;
  /** Paths to read again even if their stat is unchanged. */
  forceRehash?: Set<RelPath>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface RefreshResult {
  index: WorkspaceIndex;
  changed: RelPath[];
  added: RelPath[];
  removed: RelPath[];
  notCaptured: { path: RelPath; reason: NotCapturedReason }[];
}

const CAPTURE_CONCURRENCY = 8;
/** Even a path in `alwaysCapture` is not read into memory beyond this size. */
export const ALWAYS_CAPTURE_LIMIT = 256 * 1024 * 1024;

const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
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
]);

/** True for dependency manifests and lockfiles, which callers pass as `alwaysCapture`. */
export function isManifestOrLockfile(relPath: string): boolean {
  return MANIFEST_NAMES.has(basename(relPath));
}

function fresh(stat: StatEntry): IndexEntry {
  return { ...stat, stored: false, binary: false };
}

/** Did the path change between two index entries? By hash when both have one, otherwise by stat. */
function entryChanged(before: IndexEntry, after: IndexEntry): boolean {
  if (before.kind !== after.kind) return true;
  if (after.kind === 'symlink') return before.target !== after.target;
  if (before.hash !== undefined && after.hash !== undefined) {
    return before.hash !== after.hash || before.mode !== after.mode;
  }
  return statChanged(before, after);
}

interface ReadTask {
  path: RelPath;
  stat: StatEntry;
  /** The previous entry, when its stat equals the scan's (so it still describes this file). */
  same: IndexEntry | undefined;
  previous: IndexEntry | undefined;
}

export async function refreshIndex(input: RefreshInput): Promise<RefreshResult> {
  const { scan, previous, mode, signal } = input;
  throwIfAborted(signal);

  const index: WorkspaceIndex = new Map();
  const notCaptured: RefreshResult['notCaptured'] = [];
  const tasks: ReadTask[] = [];

  for (const [path, stat] of scan.entries) {
    const before = previous.get(path);
    const same = before !== undefined && !statChanged(before, stat) ? before : undefined;
    if (stat.kind === 'symlink') {
      index.set(path, same ?? fresh(stat));
    } else if (mode === 'stat-only') {
      // Content is not read: keep what we know when nothing moved, otherwise forget the hash.
      index.set(path, same ?? fresh(stat));
    } else if (
      same !== undefined &&
      same.hash !== undefined &&
      !isRacy(same) &&
      !input.forceRehash?.has(path)
    ) {
      index.set(path, same);
    } else {
      tasks.push({ path, stat, same, previous: before });
    }
  }

  if (tasks.length > 0) {
    await captureAll(tasks, index, notCaptured, input);
  } else {
    input.onProgress?.(0, 0);
  }

  // A directory we could not list, or a truncated scan, says nothing about what is below it.
  if (scan.truncated || scan.unreadable.length > 0) {
    const prefixes = scan.unreadable.map((dir) => `${dir}/`);
    for (const [path, entry] of previous) {
      if (scan.entries.has(path)) continue;
      if (scan.truncated || prefixes.some((prefix) => path.startsWith(prefix))) {
        index.set(path, entry);
      }
    }
  }

  const added: RelPath[] = [];
  const changed: RelPath[] = [];
  const removed: RelPath[] = [];
  for (const [path, entry] of index) {
    const before = previous.get(path);
    if (before === undefined) added.push(path);
    else if (entryChanged(before, entry)) changed.push(path);
  }
  for (const path of previous.keys()) if (!index.has(path)) removed.push(path);

  added.sort();
  changed.sort();
  removed.sort();
  notCaptured.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { index, changed, added, removed, notCaptured };
}

async function captureAll(
  tasks: ReadTask[],
  index: WorkspaceIndex,
  notCaptured: RefreshResult['notCaptured'],
  input: RefreshInput,
): Promise<void> {
  const { root, blobs, rules, signal, maxFileBytes, maxTotalBytes } = input;

  // Most recently modified first: those are the files the user is most likely to need back.
  tasks.sort((a, b) =>
    a.stat.mtimeNs < b.stat.mtimeNs ? 1 : a.stat.mtimeNs > b.stat.mtimeNs ? -1 : 0,
  );

  const baseBytes = await blobs.totalBytes();
  /** Compressed bytes this run has written so far. */
  let addedBytes = 0;
  /** Upper bound for captures that have started but not finished. */
  let reservedBytes = 0;
  let next = 0;
  let done = 0;

  const run = async (task: ReadTask): Promise<void> => {
    const { path, stat, same, previous } = task;
    const always = input.alwaysCapture?.(path) ?? false;
    const sensitive = rules.isSensitive(path);
    const limit = always ? Math.max(maxFileBytes, ALWAYS_CAPTURE_LIMIT) : maxFileBytes;

    let store = !sensitive;
    let overBudget = false;
    if (store && !always && baseBytes + addedBytes + reservedBytes >= maxTotalBytes) {
      store = false;
      overBudget = true;
    }
    const reservation = store ? stat.size : 0;
    reservedBytes += reservation;

    // Taken before the read, so "hashed at" never claims to be later than the bytes we saw.
    const hashedAtNs = BigInt(Date.now()) * 1_000_000n;
    const abs = join(root, ...path.split('/'));
    // Where the previous entry still describes this file, keep it when we cannot do better.
    const keepOrFresh = (): IndexEntry => (same?.hash !== undefined ? same : fresh(stat));

    try {
      const result = await blobs.captureFile(abs, limit, { store });
      if (result.kind === 'captured') {
        addedBytes += result.storedBytes ?? (store ? result.size : 0);
        // If the file changed while we read it, the newer stat is the truth about the file; the hash
        // still describes the bytes we stored, and the mismatch makes the next refresh read it again.
        let current = stat;
        try {
          const after = await fs.lstat(abs, { bigint: true });
          if (after.isFile()) current = toStatEntry(after, 'file');
        } catch {
          // Gone again: the next scan will say so.
        }
        // `store` means the blob is in the store now. Otherwise an earlier entry with the same hash may
        // already have put it there.
        const stored = store || (previous?.hash === result.hash && previous.stored);
        index.set(path, {
          ...current,
          size: result.size,
          hash: result.hash,
          stored,
          binary: result.binary,
          hashedAtNs,
        });
        if (sensitive) notCaptured.push({ path, reason: 'sensitive' });
        else if (overBudget) notCaptured.push({ path, reason: 'budget' });
      } else if (result.kind === 'too-large') {
        index.set(path, keepOrFresh());
        notCaptured.push({ path, reason: 'too-large' });
      } else {
        // Gone, or no longer a regular file: what we scanned is not there any more.
        notCaptured.push({ path, reason: 'gone' });
      }
    } catch {
      index.set(path, keepOrFresh());
      notCaptured.push({ path, reason: 'unreadable' });
    } finally {
      reservedBytes -= reservation;
      done += 1;
      input.onProgress?.(done, tasks.length);
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(signal);
      const task = tasks[next];
      if (task === undefined) return;
      next += 1;
      await run(task);
    }
  };

  const results = await Promise.allSettled(
    Array.from({ length: Math.min(CAPTURE_CONCURRENCY, tasks.length) }, () => worker()),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason as Error;
}
