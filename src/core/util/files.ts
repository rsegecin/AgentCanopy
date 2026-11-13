import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Writes a file so that readers see either the old content or the new one, never a partial write:
 * a temp file in the same directory, flushed, then renamed over the target.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  const handle = await fs.open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    options.mode ?? 0o600,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

/** Creates a new private file (mode 0600). Fails if the path already exists, so nothing can be pre-planted. */
export async function writeNewPrivateFile(path: string, data: string | Uint8Array): Promise<void> {
  const handle = await fs.open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

/** Creates a directory only the current user can enter (mode 0700). */
export async function ensurePrivateDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
}

export async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Appends lines to one file in order, one write at a time. Each line is flushed to disk before the
 * returned promise resolves, so a crash cannot lose an acknowledged record.
 */
export class LineAppender {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  append(line: string): Promise<void> {
    if (line.includes('\n')) return Promise.reject(new Error('a record must be a single line'));
    const run = this.tail.then(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true });
      const handle = await fs.open(
        this.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
        0o600,
      );
      try {
        await handle.writeFile(`${line}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    // Keep the chain alive after a failure so later appends still run.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Resolves when every append requested so far has finished. */
  idle(): Promise<void> {
    return this.tail;
  }
}

/**
 * Reads a JSONL file. A final line without a newline is a torn write from a crash and is dropped.
 * Returns the parsed values of all complete lines; lines that are not valid JSON are reported.
 */
export async function readJsonLines(
  path: string,
): Promise<{ values: unknown[]; badLines: number }> {
  let text: string;
  try {
    text = await fs.readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return { values: [], badLines: 0 };
    throw error;
  }
  const lines = text.split('\n');
  const torn = lines.pop();
  let badLines = torn !== undefined && torn.length > 0 ? 1 : 0;
  const values: unknown[] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      badLines += 1;
    }
  }
  return { values, badLines };
}
