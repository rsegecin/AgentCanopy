import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LineAppender,
  readJsonLines,
  redact,
  secretsEqual,
  writeFileAtomic,
  writeNewPrivateFile,
} from './index';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'agc-util-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('file utilities', () => {
  it('writes atomically and leaves no temp files', async () => {
    const file = join(dir, 'sub', 'a.json');
    await writeFileAtomic(file, '{"a":1}');
    await writeFileAtomic(file, '{"a":2}');
    expect(await fs.readFile(file, 'utf8')).toBe('{"a":2}');
    expect(await fs.readdir(join(dir, 'sub'))).toEqual(['a.json']);
  });

  it('creates private files exclusively', async () => {
    const file = join(dir, 'secret');
    await writeNewPrivateFile(file, 'x');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    await expect(writeNewPrivateFile(file, 'y')).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('x');
  });

  it('appends lines in order and drops a torn final line on read', async () => {
    const file = join(dir, 'log.jsonl');
    const appender = new LineAppender(file);
    await Promise.all([1, 2, 3, 4, 5].map((n) => appender.append(JSON.stringify({ n }))));
    await fs.appendFile(file, '{"n":6');
    const { values, badLines } = await readJsonLines(file);
    expect(values).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
    expect(badLines).toBe(1);
    await expect(appender.append('a\nb')).rejects.toThrow();
    expect((await readJsonLines(join(dir, 'missing.jsonl'))).values).toEqual([]);
  });

  it('redacts tokens and addresses, and compares secrets', () => {
    const text = redact(
      'key sk-ant-abc123456789 mail someone@example.com auth Bearer abcdefghijkl',
    );
    expect(text).not.toMatch(/sk-ant-abc|someone@|abcdefghijkl/);
    expect(secretsEqual('a', 'a')).toBe(true);
    expect(secretsEqual('a', 'b')).toBe(false);
  });
});
