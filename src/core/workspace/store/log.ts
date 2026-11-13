import { promises as fs } from 'node:fs';
import { LogRecordSchema, type LogRecord } from '../../contracts';
import { isNotFound, LineAppender, writeFileAtomic } from '../../util/files';

export interface WorkspaceLog {
  /** Every record that loaded or was appended, in order. */
  records(): readonly LogRecord[];
  /** Validates the record, writes it durably, then adds it to `records()`. */
  append(record: LogRecord): Promise<void>;
  /**
   * Replaces the whole log with these records: the new file is written beside the old one, flushed and
   * renamed over it, so a crash leaves either the old log or the new one. Only then does the in-memory
   * list change. Every record is validated first. Must not run while appends are in flight.
   */
  rewrite(next: readonly LogRecord[]): Promise<void>;
  /** Lines dropped on load: a torn final line, or lines that are not valid records. */
  readonly skipped: number;
}

const NEWLINE = 0x0a;

/**
 * Opens (and creates on first append) the workspace log, a JSONL file. A torn final line from a crash
 * is cut off the file, so the next record starts on a fresh line instead of being glued to it.
 */
export async function openWorkspaceLog(file: string): Promise<WorkspaceLog> {
  const records: LogRecord[] = [];
  let skipped = 0;

  let bytes: Buffer | undefined;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (bytes !== undefined) {
    const lastNewline = bytes.lastIndexOf(NEWLINE);
    const complete = bytes.subarray(0, lastNewline + 1);
    if (complete.length < bytes.length) {
      skipped += 1;
      await fs.truncate(file, complete.length);
    }
    for (const line of complete.toString('utf8').split('\n')) {
      if (line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        skipped += 1;
        continue;
      }
      const parsed = LogRecordSchema.safeParse(value);
      if (parsed.success) records.push(parsed.data);
      else skipped += 1;
    }
  }

  const appender = new LineAppender(file);
  return {
    records: () => records,
    skipped,
    async rewrite(next) {
      const valid = next.map((record) => LogRecordSchema.parse(record));
      await appender.idle();
      const body = valid.map((record) => `${JSON.stringify(record)}\n`).join('');
      await writeFileAtomic(file, body);
      records.splice(0, records.length, ...valid);
    },
    async append(record) {
      const valid = LogRecordSchema.parse(record);
      await appender.append(JSON.stringify(valid));
      records.push(valid);
    },
  };
}
