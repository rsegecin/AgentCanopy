import { promises as fs, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import type { RelPath } from '../../../shared';
import type { IgnoreRules } from './ignore-rules';
import { isVanished, Semaphore, throwIfAborted, yieldToEventLoop } from './internal';

export interface StatEntry {
  kind: 'file' | 'symlink';
  size: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  dev: bigint;
  /** POSIX permission bits (including setuid, setgid and sticky); 0 on Windows. */
  mode: number;
  /** For a symlink: where it points, as `readlink` returned it. */
  target?: string;
}

export interface ScanResult {
  entries: Map<RelPath, StatEntry>;
  /** Directories that could not be listed (or whose entries could not be statted). Their content is unknown. */
  unreadable: RelPath[];
  /** True when the walk stopped at `maxEntries`; the entries are then incomplete. */
  truncated: boolean;
}

export interface ScanOptions {
  signal?: AbortSignal;
  maxEntries?: number;
  onProgress?: (seen: number) => void;
}

const STAT_CONCURRENCY = 32;
const DIRECTORY_WORKERS = 8;
const BATCH_SIZE = 256;

/** Builds a `StatEntry` from bigint stats. */
export function toStatEntry(
  stats: BigIntStats,
  kind: 'file' | 'symlink',
  target?: string,
): StatEntry {
  const entry: StatEntry = {
    kind,
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
    ino: stats.ino,
    dev: stats.dev,
    mode: process.platform === 'win32' ? 0 : Number(stats.mode & 0o7777n),
  };
  if (target !== undefined) entry.target = target;
  return entry;
}

/**
 * Walks `root` and records every regular file and symlink that the rules do not exclude. Symlinks are
 * recorded and never followed; sockets, devices and FIFOs are skipped. Keys are the names exactly as
 * `readdir` returned them, joined with `/`.
 */
export async function scanWorkspace(
  root: string,
  rules: IgnoreRules,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const { signal, maxEntries = 500_000, onProgress } = options;
  throwIfAborted(signal);

  const entries = new Map<RelPath, StatEntry>();
  const unreadable = new Set<RelPath>();
  let truncated = false;
  let failure: unknown;
  let failed = false;

  const statSlots = new Semaphore(STAT_CONCURRENCY);
  const queue: string[] = [''];
  let inFlight = 0;
  let wake: (() => void)[] = [];
  const notify = (): void => {
    const waiting = wake;
    wake = [];
    for (const resolve of waiting) resolve();
  };

  const shouldStop = (): boolean => failed || truncated;

  const record = (path: RelPath, entry: StatEntry): void => {
    if (entries.size >= maxEntries) {
      truncated = true;
      return;
    }
    entries.set(path, entry);
  };

  const statOne = async (relDir: string, name: string): Promise<void> => {
    const rel = relDir === '' ? name : `${relDir}/${name}`;
    const abs = join(root, ...rel.split('/'));
    try {
      const stats = await fs.lstat(abs, { bigint: true });
      if (stats.isSymbolicLink()) {
        const target = await fs.readlink(abs);
        record(rel, toStatEntry(stats, 'symlink', target));
      } else if (stats.isFile()) {
        record(rel, toStatEntry(stats, 'file'));
      }
      // Anything else (a directory that replaced the file, a FIFO, a socket) is skipped.
    } catch (error) {
      if (isVanished(error)) return;
      // The directory lists but its entries cannot be examined: its content is unknown.
      unreadable.add(relDir);
    }
  };

  const walkDirectory = async (relDir: string): Promise<void> => {
    const abs = relDir === '' ? root : join(root, ...relDir.split('/'));
    await rules.enterDirectory(relDir);
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      if (relDir === '') throw error;
      if (isVanished(error)) return;
      unreadable.add(relDir);
      return;
    }

    const files: string[] = [];
    for (const dirent of dirents) {
      const rel = relDir === '' ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (rules.isIgnored(rel, true)) continue;
        queue.push(rel);
        notify();
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        if (rules.isIgnored(rel, false)) continue;
        files.push(dirent.name);
      }
    }

    for (let start = 0; start < files.length; start += BATCH_SIZE) {
      if (shouldStop()) return;
      throwIfAborted(signal);
      const batch = files.slice(start, start + BATCH_SIZE);
      await Promise.all(batch.map((name) => statSlots.run(() => statOne(relDir, name))));
      onProgress?.(entries.size);
      await yieldToEventLoop();
    }
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (shouldStop()) return;
      try {
        throwIfAborted(signal);
      } catch (error) {
        failed = true;
        failure = error;
        notify();
        return;
      }
      const next = queue.pop();
      if (next === undefined) {
        if (inFlight === 0) {
          notify();
          return;
        }
        await new Promise<void>((resolve) => wake.push(resolve));
        continue;
      }
      inFlight += 1;
      try {
        await walkDirectory(next);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      } finally {
        inFlight -= 1;
        notify();
      }
    }
  };

  await Promise.all(Array.from({ length: DIRECTORY_WORKERS }, () => worker()));
  if (failed) throw failure as Error;
  throwIfAborted(signal);
  onProgress?.(entries.size);
  return { entries, unreadable: [...unreadable].sort(), truncated };
}
