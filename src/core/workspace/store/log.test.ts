import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LogRecord } from '../../contracts';
import { LogRecordSchema } from '../../contracts';
import { openWorkspaceLog } from './log';
import { makeTempDir, removeDir } from './test-helpers';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await makeTempDir('agc-log');
  file = join(dir, 'nested', 'workspace.jsonl');
});
afterEach(async () => {
  await removeDir(dir);
});

function operation(id: string): LogRecord {
  return LogRecordSchema.parse({
    type: 'operation',
    id,
    kind: 'agent-turn',
    at: 1_700_000_000_000,
    status: 'complete',
    changes: [
      {
        path: 'a.txt',
        before: { kind: 'absent' },
        after: {
          kind: 'file',
          size: 1,
          mode: 0o644,
          stored: true,
          binary: false,
          hash: 'f'.repeat(64),
        },
        attribution: 'agent-tool',
      },
    ],
    notes: ['a note with "quotes" and a\nnewline'],
  });
}

function review(id: string): LogRecord {
  return LogRecordSchema.parse({ type: 'review', id, at: 1, accepted: [] });
}

describe('workspace log', () => {
  it('starts empty when the file does not exist', async () => {
    const log = await openWorkspaceLog(file);
    expect(log.records()).toEqual([]);
    expect(log.skipped).toBe(0);
  });

  it('appends and reloads records in order', async () => {
    const log = await openWorkspaceLog(file);
    const records = [operation('op-1'), review('r-1'), operation('op-2')];
    for (const record of records) await log.append(record);
    expect(log.records()).toEqual(records);

    const reloaded = await openWorkspaceLog(file);
    expect(reloaded.records()).toEqual(records);
    expect(reloaded.skipped).toBe(0);
    expect((await fs.readFile(file, 'utf8')).split('\n').length).toBe(4);
  });

  it('drops a torn final line, counts it, and does not glue the next record to it', async () => {
    const log = await openWorkspaceLog(file);
    await log.append(operation('op-1'));
    const full = JSON.stringify(operation('op-2'));
    await fs.appendFile(file, full.slice(0, full.length - 15));

    const reopened = await openWorkspaceLog(file);
    expect(reopened.records().map((r) => r.id)).toEqual(['op-1']);
    expect(reopened.skipped).toBe(1);

    await reopened.append(review('r-1'));
    const again = await openWorkspaceLog(file);
    expect(again.records().map((r) => r.id)).toEqual(['op-1', 'r-1']);
    expect(again.skipped).toBe(0);
  });

  it('drops complete lines that are not valid records and keeps the rest', async () => {
    const log = await openWorkspaceLog(file);
    await log.append(operation('op-1'));
    await fs.appendFile(file, 'garbage\n{"type":"operation","id":"x"}\n{"type":"nope"}\n');
    await log.append(operation('op-2'));

    const reopened = await openWorkspaceLog(file);
    expect(reopened.records().map((r) => r.id)).toEqual(['op-1', 'op-2']);
    expect(reopened.skipped).toBe(3);
  });

  it('rejects an invalid record without writing it or keeping it', async () => {
    const log = await openWorkspaceLog(file);
    await log.append(operation('op-1'));
    const before = await fs.readFile(file, 'utf8');
    const bad = { type: 'operation', id: 'op-2' } as unknown as LogRecord;
    await expect(log.append(bad)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect(log.records().map((r) => r.id)).toEqual(['op-1']);
  });

  it('keeps order under concurrent appends', async () => {
    const log = await openWorkspaceLog(file);
    const ids = Array.from({ length: 50 }, (_, i) => `op-${i}`);
    await Promise.all(ids.map((id) => log.append(operation(id))));
    expect(log.records().map((r) => r.id)).toEqual(ids);
    expect((await openWorkspaceLog(file)).records().map((r) => r.id)).toEqual(ids);
  });

  it('does not add a record to memory when the write fails', async () => {
    const log = await openWorkspaceLog(file);
    await log.append(operation('op-1'));
    // Replace the log file with a directory so the next write cannot succeed.
    await fs.rm(file);
    await fs.mkdir(file);
    await expect(log.append(operation('op-2'))).rejects.toThrow();
    expect(log.records().map((r) => r.id)).toEqual(['op-1']);
  });

  describe('rewrite', () => {
    it('replaces the file and the in-memory list, and the result reloads', async () => {
      const log = await openWorkspaceLog(file);
      for (const id of ['op-1', 'op-2', 'op-3']) await log.append(operation(id));
      await log.rewrite([operation('op-3'), review('r-1')]);
      expect(log.records().map((r) => r.id)).toEqual(['op-3', 'r-1']);
      const reloaded = await openWorkspaceLog(file);
      expect(reloaded.records()).toEqual(log.records());
      expect(reloaded.skipped).toBe(0);
      // The log goes on: appends after a rewrite land in the new file.
      await log.append(operation('op-4'));
      expect((await openWorkspaceLog(file)).records().map((r) => r.id)).toEqual([
        'op-3',
        'r-1',
        'op-4',
      ]);
      // No temporary file is left behind.
      expect(await fs.readdir(join(dir, 'nested'))).toEqual(['workspace.jsonl']);
    });

    it('can empty the log', async () => {
      const log = await openWorkspaceLog(file);
      await log.append(operation('op-1'));
      await log.rewrite([]);
      expect(log.records()).toEqual([]);
      expect((await openWorkspaceLog(file)).records()).toEqual([]);
    });

    it('waits for appends in flight and keeps their order', async () => {
      const log = await openWorkspaceLog(file);
      const pending = [log.append(operation('op-1')), log.append(operation('op-2'))];
      const done = log.rewrite([operation('op-9')]);
      await Promise.all([...pending, done]);
      expect((await openWorkspaceLog(file)).records().map((r) => r.id)).toEqual(['op-9']);
    });

    it('changes nothing when a record is invalid or the write fails', async () => {
      const log = await openWorkspaceLog(file);
      await log.append(operation('op-1'));
      const before = await fs.readFile(file, 'utf8');
      const bad = { type: 'operation', id: 'x' } as unknown as LogRecord;
      await expect(log.rewrite([operation('op-2'), bad])).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(before);
      expect(log.records().map((r) => r.id)).toEqual(['op-1']);

      await fs.rm(file);
      await fs.mkdir(file);
      await expect(log.rewrite([operation('op-2')])).rejects.toThrow();
      expect(log.records().map((r) => r.id)).toEqual(['op-1']);
    });
  });
});
