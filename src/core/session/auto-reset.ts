import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { silentLogger, systemClock, type Clock, type Logger } from '../contracts';
import { isNotFound, redact, writeFileAtomic } from '../util';

/** The file in the global storage directory that holds the machine-wide reset of Auto. */
export const AUTO_RESET_FILE = 'auto-reset.json';

const Time = z.number().int().nonnegative();
/** An older file has only `lastSeenOff`; its highest stamp is then taken to be the same. */
const FileSchema = z.object({ lastSeenOff: Time, highestStamp: Time.optional() });

function parseFile(text: string) {
  try {
    return FileSchema.safeParse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** What a read of the file found. */
type Read =
  | { kind: 'ok'; lastSeenOff: number; highestStamp: number }
  /** No file (ENOENT): Auto was never reset on this machine. */
  | { kind: 'missing' }
  /** The file holds something that does not parse or validate. It may be written over. */
  | { kind: 'unusable' }
  /** The file could not be read. It is never written over, since what it holds is not known. */
  | { kind: 'unreadable' };

/**
 * When the setting that offers Auto (`agentCanopy.agent.auto.enabled`) was last seen off on this
 * machine, and the highest time ever given to an Auto turned on, shared by every window through the
 * global storage directory. A conversation's Auto counts as on only while its `agentAutoSince` is
 * later than the last reset, so turning the setting off and on again arms no conversation, also in a
 * workspace that was closed meanwhile.
 *
 * Every doubt fails closed: a file that cannot be read or used counts as a reset now. Only a missing
 * file means "never reset". A reset is later than every stamp recorded in the file, whatever the
 * clocks say, and a stamp is later than every reset.
 */
export interface AutoReset {
  /** The last reset known to this window, 0 when never. */
  lastSeenOff(): number;
  /**
   * Reads the file again and keeps the later values of it and memory; memory that is ahead of the
   * file, or unsaved, is written to it (never over a file that could not be read). Never throws.
   */
  refresh(): Promise<void>;
  /**
   * Whether memory holds a reset or a stamp that the file is not known to hold: a write that failed,
   * a file that could not be read, or a write still to come. Always false without a directory.
   */
  unsaved(): boolean;
  /**
   * The setting is seen off now. In memory at once (every stamp known here is out of date from this
   * call on); then the file is read again and the reset, later than every stamp it records, written.
   * Never throws.
   */
  seenOff(): Promise<void>;
  /**
   * The time to store as `agentAutoSince` for an Auto turned on now: later than every reset known.
   * Recorded in the file before it is returned, so a later reset in any window is later than it.
   * Rejects when it cannot be recorded; Auto must then not be turned on.
   */
  stamp(): Promise<number>;
  /** Resolves when every read and write asked for so far has finished. Never rejects. */
  idle(): Promise<void>;
}

export function createAutoReset(options: {
  /** The global storage directory; without it everything lives in memory only. */
  dir: string | undefined;
  clock?: Clock;
  logger?: Logger;
}): AutoReset {
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? silentLogger;
  const file = options.dir === undefined ? undefined : join(options.dir, AUTO_RESET_FILE);
  let lastSeenOff = 0;
  let highestStamp = 0;
  let queue: Promise<unknown> = Promise.resolve();
  /** Memory holds something that the file is not known to hold. */
  let notInFile = false;

  /** A reset now: later than the clock and than everything known so far. */
  function resetNow(): void {
    lastSeenOff = Math.max(clock.now(), lastSeenOff, highestStamp) + 1;
    notInFile = true;
  }

  async function read(path: string): Promise<Read> {
    let text: string;
    try {
      text = await fs.readFile(path, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return { kind: 'missing' };
      logger.warn('the stored reset of Auto could not be read; Auto counts as reset now', {
        error: redact(String(error)),
      });
      return { kind: 'unreadable' };
    }
    const parsed = parseFile(text);
    if (!parsed?.success) {
      logger.warn('the stored reset of Auto could not be used; Auto counts as reset now');
      return { kind: 'unusable' };
    }
    const { lastSeenOff: stored, highestStamp: stamped } = parsed.data;
    return { kind: 'ok', lastSeenOff: stored, highestStamp: stamped ?? stored };
  }

  /**
   * Reads the file and takes it into memory: the later values win, and a file that cannot be read
   * or used is a reset now. Returns whether the file may be written.
   */
  async function merge(path: string): Promise<boolean> {
    const found = await read(path);
    if (found.kind === 'ok') {
      lastSeenOff = Math.max(lastSeenOff, found.lastSeenOff);
      highestStamp = Math.max(highestStamp, found.highestStamp);
    } else if (found.kind === 'unusable' || found.kind === 'unreadable') {
      resetNow();
    }
    return found.kind !== 'unreadable';
  }

  async function write(path: string): Promise<void> {
    const values = { lastSeenOff, highestStamp };
    try {
      await writeFileAtomic(path, `${JSON.stringify(values)}\n`);
    } catch (error) {
      notInFile = true;
      throw error;
    }
    // Memory may have moved on while the file was written: then it is still not all in the file.
    if (lastSeenOff === values.lastSeenOff && highestStamp === values.highestStamp) {
      notInFile = false;
    }
  }

  /** One read and write of the file at a time, in order. */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  }

  /** Runs a task that must never reject: a failure is logged. */
  function quietly(task: (path: string) => Promise<void>): Promise<void> {
    if (file === undefined) return Promise.resolve();
    return enqueue(() => task(file)).catch((error: unknown) => {
      logger.warn('the reset of Auto could not be stored', { error: redact(String(error)) });
    });
  }

  return {
    lastSeenOff: () => lastSeenOff,
    unsaved: () => file !== undefined && notInFile,
    idle: () => queue.then(() => undefined),
    refresh() {
      return quietly(async (path) => {
        const found = await read(path);
        if (found.kind === 'ok') {
          lastSeenOff = Math.max(lastSeenOff, found.lastSeenOff);
          highestStamp = Math.max(highestStamp, found.highestStamp);
          // A reset kept only in memory (its write failed earlier) is written now that it can be.
          if (lastSeenOff > found.lastSeenOff || highestStamp > found.highestStamp) {
            await write(path);
          } else {
            // The file holds all of memory.
            notInFile = false;
          }
          return;
        }
        if (found.kind !== 'missing') resetNow();
        // Memory where there was no file, the reset now over an unusable one; a file that could not
        // be read is never written over.
        if (found.kind !== 'unreadable') await write(path);
      });
    },
    seenOff() {
      resetNow();
      return quietly(async (path) => {
        const writable = await merge(path);
        // Later than every stamp the file records, whatever the clock says.
        resetNow();
        if (writable) await write(path);
      });
    },
    stamp() {
      if (file === undefined) {
        highestStamp = Math.max(clock.now(), lastSeenOff + 1, highestStamp + 1);
        return Promise.resolve(highestStamp);
      }
      const path = file;
      return enqueue(async () => {
        if (!(await merge(path))) {
          throw new Error('the stored reset of Auto could not be read');
        }
        const stamp = Math.max(clock.now(), lastSeenOff + 1, highestStamp + 1);
        highestStamp = stamp;
        notInFile = true;
        // Recorded before Auto is turned on with it; a failure rejects, and Auto stays off.
        await write(path);
        return stamp;
      });
    },
  };
}
