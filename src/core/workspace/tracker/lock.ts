import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { errorCode } from './fs-util';

export const LOCK_HELD_MESSAGE = 'Another VS Code window is tracking changes in this folder.';

/** The owner rewrites the lock's mtime this often. */
export const DEFAULT_HEARTBEAT_MS = 20_000;
/** A lock whose mtime is older than this is stale, whatever its pid says. */
export const DEFAULT_STALE_MS = 90_000;
/** After taking over a stale lock, wait this long and check that we still hold it. */
const TAKEOVER_SETTLE_MS = 50;
/** A lock file that does not parse is given this long to be written by its owner before it counts as stale. */
const CORRUPT_LOCK_GRACE_MS = 10_000;

/** Lock files held by this process, so two trackers in one process exclude each other too. */
const heldHere = new Set<string>();

interface LockContent {
  pid: number;
  startedAt: number;
  owner: string;
}

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return errorCode(error) === 'EPERM';
  }
}

async function readLock(file: string): Promise<{ lock?: LockContent; ageMs: number } | undefined> {
  try {
    const [text, stats] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    const ageMs = Date.now() - stats.mtimeMs;
    try {
      const parsed = JSON.parse(text) as Partial<LockContent>;
      if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid)) {
        return {
          lock: {
            pid: parsed.pid,
            startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
            owner: typeof parsed.owner === 'string' ? parsed.owner : '',
          },
          ageMs,
        };
      }
    } catch {
      // Falls through: an unreadable lock.
    }
    return { ageMs };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

export interface LockOptions {
  isProcessAlive: (pid: number) => boolean;
  now: () => number;
  heartbeatMs?: number;
  staleMs?: number;
}

/**
 * Takes the lock file, or throws `Error(LOCK_HELD_MESSAGE)` when a live holder has it. The holder
 * proves it is alive by rewriting the file's mtime every `heartbeatMs`; a lock is stale when its
 * process is gone or its mtime is older than `staleMs`. A stale lock is taken over by renaming our
 * own lock over it, then waiting a moment and reading it back: if another host did the same at the
 * same time, only the last rename survives, and the other sees it and gives up.
 * Returns a function that releases the lock.
 */
export async function acquireLock(
  file: string,
  options: LockOptions,
): Promise<() => Promise<void>> {
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const owner = randomBytes(8).toString('hex');
  const content: LockContent = { pid: process.pid, startedAt: options.now(), owner };
  const text = JSON.stringify(content);

  const held = (): (() => Promise<void>) => {
    heldHere.add(file);
    const timer = setInterval(() => {
      void (async () => {
        const current = await readLock(file).catch(() => undefined);
        if (current?.lock?.owner !== owner) {
          clearInterval(timer); // Someone else holds it now: stop pretending.
          return;
        }
        const now = new Date();
        await fs.utimes(file, now, now);
      })().catch(() => undefined);
    }, heartbeatMs);
    timer.unref();
    return async () => {
      clearInterval(timer);
      if (!heldHere.delete(file)) return;
      const current = await readLock(file).catch(() => undefined);
      if (current?.lock?.owner === owner) await fs.rm(file, { force: true });
    };
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await fs.open(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await handle.writeFile(text);
      } finally {
        await handle.close();
      }
      return held();
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }

    const existing = await readLock(file);
    if (existing === undefined) continue; // Released between our attempt and our read.
    const { lock, ageMs } = existing;
    let stale: boolean;
    if (lock === undefined) {
      stale = ageMs >= CORRUPT_LOCK_GRACE_MS;
    } else if (lock.pid === process.pid && heldHere.has(file)) {
      stale = false;
    } else {
      stale = lock.pid === process.pid || !options.isProcessAlive(lock.pid) || ageMs > staleMs;
    }
    if (!stale) throw new Error(LOCK_HELD_MESSAGE);

    const temp = join(dirname(file), `.lock-${owner}.tmp`);
    await fs.writeFile(temp, text, { mode: 0o600 });
    try {
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, TAKEOVER_SETTLE_MS));
    const after = await readLock(file);
    if (after?.lock?.owner === owner) return held();
    throw new Error(LOCK_HELD_MESSAGE);
  }
  throw new Error(LOCK_HELD_MESSAGE);
}
