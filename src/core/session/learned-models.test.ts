import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../contracts';
import { createLearnedModels, LEARNED_MODELS_FILE } from './learned-models';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'agc-learned-models-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => {
      warnings.push(message);
    },
    error: () => undefined,
  };
}

function file(): string {
  return join(dir, LEARNED_MODELS_FILE);
}

async function stored(): Promise<unknown> {
  return JSON.parse(await fs.readFile(file(), 'utf8')) as unknown;
}

describe('the learned model ids', () => {
  it('starts empty when there is no file, and writes none until something is learned', async () => {
    const logger = recordingLogger();
    const learned = createLearnedModels({ dir, logger });
    await learned.refresh();
    expect(learned.get('claude-code')).toEqual({});
    expect(logger.warnings).toEqual([]);
    await expect(fs.stat(file())).rejects.toThrow();
  });

  it('remembers a recorded id at once, before the file is written', async () => {
    const learned = createLearnedModels({ dir });
    expect(learned.record('claude-code', 'opus', 'claude-opus-6')).toBe(true);
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    expect(learned.get('other')).toEqual({});
    await learned.idle();
    expect(await stored()).toEqual({
      version: 1,
      providers: { 'claude-code': { opus: 'claude-opus-6' } },
    });
  });

  it('returns false for the same value and true for a changed one', async () => {
    const learned = createLearnedModels({ dir });
    expect(learned.record('claude-code', 'opus', 'claude-opus-6')).toBe(true);
    expect(learned.record('claude-code', 'opus', 'claude-opus-6')).toBe(false);
    expect(learned.record('claude-code', 'opus', 'claude-opus-7')).toBe(true);
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-7' });
    await learned.idle();
    expect(await stored()).toEqual({
      version: 1,
      providers: { 'claude-code': { opus: 'claude-opus-7' } },
    });
  });

  it('persists, and a second instance sees it after a refresh', async () => {
    const one = createLearnedModels({ dir });
    one.record('claude-code', 'fable', 'claude-fable-6');
    await one.idle();
    const two = createLearnedModels({ dir });
    expect(two.get('claude-code')).toEqual({});
    await two.refresh();
    expect(two.get('claude-code')).toEqual({ fable: 'claude-fable-6' });
  });

  it('takes what the file holds over memory on a refresh, and keeps what only memory holds', async () => {
    const learned = createLearnedModels({ dir });
    learned.record('claude-code', 'opus', 'claude-opus-5');
    await learned.idle();
    await fs.writeFile(
      file(),
      JSON.stringify({
        version: 1,
        providers: { 'claude-code': { opus: 'claude-opus-6', haiku: 'claude-haiku-5' } },
      }),
    );
    await learned.refresh();
    expect(learned.get('claude-code')).toEqual({
      opus: 'claude-opus-6',
      haiku: 'claude-haiku-5',
    });
    const memoryOnly = createLearnedModels({ dir });
    await fs.rm(file());
    memoryOnly.record('p', 'a', 'm1');
    await memoryOnly.idle();
    await fs.writeFile(file(), JSON.stringify({ version: 1, providers: { q: { b: 'm2' } } }));
    await memoryOnly.refresh();
    expect(memoryOnly.get('p')).toEqual({ a: 'm1' });
    expect(memoryOnly.get('q')).toEqual({ b: 'm2' });
  });

  it('a record of another window is kept when this window records a different alias', async () => {
    const a = createLearnedModels({ dir });
    const b = createLearnedModels({ dir });
    a.record('claude-code', 'opus', 'claude-opus-5');
    await a.idle();
    // B never read the file; its record is later than A's.
    b.record('claude-code', 'opus', 'claude-opus-6');
    await b.idle();
    a.record('claude-code', 'haiku', 'claude-haiku-5');
    await a.idle();
    expect(await stored()).toEqual({
      version: 1,
      providers: { 'claude-code': { opus: 'claude-opus-6', haiku: 'claude-haiku-5' } },
    });
    expect(a.get('claude-code')).toEqual({ opus: 'claude-opus-6', haiku: 'claude-haiku-5' });
  });

  it('a refresh takes a newer value written by another window', async () => {
    const a = createLearnedModels({ dir });
    const b = createLearnedModels({ dir });
    a.record('claude-code', 'opus', 'claude-opus-5');
    await a.idle();
    b.record('claude-code', 'opus', 'claude-opus-6');
    await b.idle();
    expect(a.get('claude-code')).toEqual({ opus: 'claude-opus-5' });
    await a.refresh();
    expect(a.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
  });

  it('two records of one alias in a row end with the later one, in memory and in the file', async () => {
    const learned = createLearnedModels({ dir });
    expect(learned.record('claude-code', 'opus', 'claude-opus-5')).toBe(true);
    expect(learned.record('claude-code', 'opus', 'claude-opus-6')).toBe(true);
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    await learned.idle();
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    expect(await stored()).toEqual({
      version: 1,
      providers: { 'claude-code': { opus: 'claude-opus-6' } },
    });
  });

  it('a record made while an earlier write is in progress is not undone by it', async () => {
    const learned = createLearnedModels({ dir });
    learned.record('claude-code', 'opus', 'claude-opus-5');
    // Let the first write start reading the file, then record again.
    await new Promise((resolve) => setImmediate(resolve));
    learned.record('claude-code', 'opus', 'claude-opus-6');
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    await learned.idle();
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    expect(await stored()).toEqual({
      version: 1,
      providers: { 'claude-code': { opus: 'claude-opus-6' } },
    });
  });

  it('a record that could not be written is written by a later one once the file can be', async () => {
    await fs.mkdir(file());
    const learned = createLearnedModels({ dir });
    learned.record('claude-code', 'opus', 'claude-opus-6');
    await learned.idle();
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    await fs.rm(file(), { recursive: true });
    learned.record('claude-code', 'haiku', 'claude-haiku-5');
    await learned.idle();
    expect(await stored()).toEqual({
      version: 1,
      providers: { 'claude-code': { opus: 'claude-opus-6', haiku: 'claude-haiku-5' } },
    });
  });

  it('an entry whose write failed is tried again by the next write', async () => {
    const learned = createLearnedModels({ dir });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk full'));
    learned.record('claude-code', 'opus', 'claude-opus-6');
    await learned.idle();
    rename.mockRestore();
    learned.record('claude-code', 'haiku', 'claude-haiku-5');
    await learned.idle();
    expect(await stored()).toEqual({
      version: 1,
      providers: { 'claude-code': { opus: 'claude-opus-6', haiku: 'claude-haiku-5' } },
    });
  });

  it('two instances on one directory do not erase each other', async () => {
    const one = createLearnedModels({ dir });
    const two = createLearnedModels({ dir });
    one.record('claude-code', 'opus', 'claude-opus-6');
    await one.idle();
    // The second instance never read the file, so it holds nothing of the first one's.
    two.record('claude-code', 'fable', 'claude-fable-6');
    await two.idle();
    expect(two.get('claude-code')).toEqual({ opus: 'claude-opus-6', fable: 'claude-fable-6' });
    const three = createLearnedModels({ dir });
    await three.refresh();
    expect(three.get('claude-code')).toEqual({ opus: 'claude-opus-6', fable: 'claude-fable-6' });
  });

  it.each([
    ['that is not JSON', 'not json'],
    ['of the wrong shape', JSON.stringify({ version: 2, providers: {} })],
    ['with an invalid id', JSON.stringify({ version: 1, providers: { p: { opus: 'has space' } } })],
    ['with an id that is not a string', JSON.stringify({ version: 1, providers: { p: { a: 1 } } })],
  ])('counts a file %s as empty, warns, and is written over later', async (_name, content) => {
    await fs.writeFile(file(), content);
    const logger = recordingLogger();
    const learned = createLearnedModels({ dir, logger });
    await learned.refresh();
    expect(learned.get('p')).toEqual({});
    expect(logger.warnings).toHaveLength(1);
    expect(learned.record('p', 'opus', 'claude-opus-6')).toBe(true);
    await learned.idle();
    expect(await stored()).toEqual({ version: 1, providers: { p: { opus: 'claude-opus-6' } } });
  });

  it('keeps memory when the file cannot be read or written, logs, and still goes idle', async () => {
    // A directory where the file should be.
    await fs.mkdir(file());
    const logger = recordingLogger();
    const learned = createLearnedModels({ dir, logger });
    await learned.refresh();
    expect(learned.record('claude-code', 'opus', 'claude-opus-6')).toBe(true);
    await expect(learned.idle()).resolves.toBeUndefined();
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect((await fs.stat(file())).isDirectory()).toBe(true);
  });

  it('logs a write that fails and keeps the value in memory', async () => {
    const logger = recordingLogger();
    const learned = createLearnedModels({ dir, logger });
    await learned.refresh();
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk full'));
    expect(learned.record('claude-code', 'opus', 'claude-opus-6')).toBe(true);
    await expect(learned.idle()).resolves.toBeUndefined();
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    expect(logger.warnings).toContain('the learned model ids could not be stored');
  });

  it('refuses invalid input', async () => {
    const learned = createLearnedModels({ dir });
    expect(learned.record('', 'opus', 'claude-opus-6')).toBe(false);
    expect(learned.record('p'.repeat(65), 'opus', 'claude-opus-6')).toBe(false);
    expect(learned.record('p', '', 'claude-opus-6')).toBe(false);
    expect(learned.record('p', 'a'.repeat(65), 'claude-opus-6')).toBe(false);
    expect(learned.record('p', 'opus', '')).toBe(false);
    expect(learned.record('p', 'opus', 'has space')).toBe(false);
    expect(learned.record('p', 'opus', 'a'.repeat(101))).toBe(false);
    expect(learned.record('p', 'opus', 5 as unknown as string)).toBe(false);
    expect(learned.get('p')).toEqual({});
    await learned.idle();
    await expect(fs.stat(file())).rejects.toThrow();
  });

  it('holds at most 50 aliases per provider and 10 providers', async () => {
    const learned = createLearnedModels({ dir });
    for (let i = 0; i < 50; i += 1) {
      expect(learned.record('p', `alias-${i}`, `model-${i}`)).toBe(true);
    }
    expect(learned.record('p', 'one-more', 'model-x')).toBe(false);
    // A known alias may still change.
    expect(learned.record('p', 'alias-0', 'model-changed')).toBe(true);
    expect(Object.keys(learned.get('p'))).toHaveLength(50);
    for (let i = 1; i < 10; i += 1) {
      expect(learned.record(`provider-${i}`, 'a', 'm')).toBe(true);
    }
    expect(learned.record('provider-10', 'a', 'm')).toBe(false);
    expect(learned.get('provider-10')).toEqual({});
    await learned.idle();
    const again = createLearnedModels({ dir });
    await again.refresh();
    expect(Object.keys(again.get('p'))).toHaveLength(50);
  });

  it('does not write an entry that would break the caps of the file, and warns', async () => {
    const providers: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 10; i += 1) providers[`other-${i}`] = { a: 'm' };
    const content = JSON.stringify({ version: 1, providers });
    await fs.writeFile(file(), content);
    const logger = recordingLogger();
    const learned = createLearnedModels({ dir, logger });
    expect(learned.record('mine', 'opus', 'claude-opus-6')).toBe(true);
    await learned.idle();
    expect(await fs.readFile(file(), 'utf8')).toBe(content);
    expect(logger.warnings).toHaveLength(1);
    expect(learned.get('mine')).toEqual({ opus: 'claude-opus-6' });
  });

  it('works in memory without a directory and touches no file', async () => {
    const learned = createLearnedModels({ dir: undefined });
    await learned.refresh();
    expect(learned.record('claude-code', 'opus', 'claude-opus-6')).toBe(true);
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    await learned.idle();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('returns a fresh object from get', () => {
    const learned = createLearnedModels({ dir: undefined });
    learned.record('claude-code', 'opus', 'claude-opus-6');
    const first = learned.get('claude-code');
    first['opus'] = 'changed';
    first['extra'] = 'x';
    expect(learned.get('claude-code')).toEqual({ opus: 'claude-opus-6' });
    expect(learned.get('nobody')).not.toBe(learned.get('nobody'));
  });

  it('cannot be harmed by a key named like a prototype', async () => {
    await fs.writeFile(
      file(),
      '{"version":1,"providers":{"__proto__":{"polluted":"yes"},"constructor":{"__proto__":"claude-opus-6","toString":"x"}}}',
    );
    const learned = createLearnedModels({ dir });
    await learned.refresh();
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(learned.get('toString')).toEqual({});
    expect(learned.get('hasOwnProperty')).toEqual({});
    expect(learned.record('constructor', '__proto__', 'claude-opus-7')).toBe(true);
    expect(Object.hasOwn(learned.get('constructor'), '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    await learned.idle();
    const again = createLearnedModels({ dir });
    await again.refresh();
    // A key named `__proto__` is dropped when the file is read (zod skips it); nothing is polluted.
    expect(Object.hasOwn(again.get('constructor'), '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
