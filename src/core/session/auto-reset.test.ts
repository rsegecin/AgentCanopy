import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../contracts';
import { AUTO_RESET_FILE, createAutoReset } from './auto-reset';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'agc-auto-reset-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

/** A clock that stands still unless set. */
function settableClock(at = 1_000) {
  let now = at;
  return {
    now: () => now,
    set: (value: number) => {
      now = value;
    },
  };
}

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
  return join(dir, AUTO_RESET_FILE);
}

async function stored(): Promise<unknown> {
  return JSON.parse(await fs.readFile(file(), 'utf8')) as unknown;
}

describe('the reset of Auto', () => {
  it('orders stamps and resets strictly, also when the clock does not move', async () => {
    const reset = createAutoReset({ dir, clock: settableClock() });
    await reset.refresh();
    expect(reset.lastSeenOff()).toBe(0);
    const before = await reset.stamp();
    expect(before).toBeGreaterThan(0);
    expect(await stored()).toEqual({ lastSeenOff: 0, highestStamp: before });
    await reset.seenOff();
    expect(reset.lastSeenOff()).toBeGreaterThan(before);
    const after = await reset.stamp();
    expect(after).toBeGreaterThan(reset.lastSeenOff());
    expect(await stored()).toEqual({ lastSeenOff: reset.lastSeenOff(), highestStamp: after });
  });

  it('is seen off in memory at once, before the file is written', async () => {
    const reset = createAutoReset({ dir, clock: settableClock() });
    const stamp = await reset.stamp();
    const written = reset.seenOff();
    expect(reset.lastSeenOff()).toBeGreaterThan(stamp);
    await written;
  });

  it('a stamp is always later than the reset in the file at that moment, whatever the clock', async () => {
    const reset = createAutoReset({ dir, clock: settableClock(1_000) });
    await reset.refresh();
    await fs.writeFile(file(), JSON.stringify({ lastSeenOff: 5_000, highestStamp: 4_000 }));
    expect(await reset.stamp()).toBe(5_001);
    await fs.writeFile(file(), JSON.stringify({ lastSeenOff: 9_000, highestStamp: 9_500 }));
    expect(await reset.stamp()).toBe(9_501);
    expect(reset.lastSeenOff()).toBe(9_000);
  });

  it('a reset in another window is later than a stamp issued before it, with the clock set back', async () => {
    const clock = settableClock(10_000);
    const one = createAutoReset({ dir, clock });
    const two = createAutoReset({ dir, clock });
    await one.refresh();
    await two.refresh();
    const stamp = await one.stamp();
    // The clock goes back before the other window sees the setting off.
    clock.set(2_000);
    await two.seenOff();
    expect(two.lastSeenOff()).toBeGreaterThan(stamp);
    await one.refresh();
    expect(one.lastSeenOff()).toBeGreaterThan(stamp);
    // A stamp issued afterwards, in either window, is later than the reset.
    expect(await one.stamp()).toBeGreaterThan(two.lastSeenOff());
  });

  it('reads a file of the older shape with its highest stamp equal to the reset', async () => {
    await fs.writeFile(file(), JSON.stringify({ lastSeenOff: 5_000 }));
    const reset = createAutoReset({ dir, clock: settableClock(1_000) });
    await reset.refresh();
    expect(reset.lastSeenOff()).toBe(5_000);
    expect(await reset.stamp()).toBe(5_001);
    await reset.seenOff();
    expect(reset.lastSeenOff()).toBeGreaterThan(5_001);
  });

  it('keeps the later of memory and the file, and never writes a lower value', async () => {
    await fs.writeFile(file(), JSON.stringify({ lastSeenOff: 5_000, highestStamp: 5_000 }));
    const reset = createAutoReset({ dir, clock: settableClock(1_000) });
    await reset.refresh();
    expect(reset.lastSeenOff()).toBe(5_000);
    // Another window resets later still.
    await fs.writeFile(file(), JSON.stringify({ lastSeenOff: 9_000, highestStamp: 9_000 }));
    await reset.seenOff();
    expect(reset.lastSeenOff()).toBe(9_001);
    expect(await stored()).toEqual({ lastSeenOff: 9_001, highestStamp: 9_000 });
  });

  it('writes a missing file, which means never reset', async () => {
    const reset = createAutoReset({ dir: join(dir, 'not-yet'), clock: settableClock() });
    await reset.refresh();
    expect(reset.lastSeenOff()).toBe(0);
    expect(
      JSON.parse(await fs.readFile(join(dir, 'not-yet', AUTO_RESET_FILE), 'utf8')) as unknown,
    ).toEqual({ lastSeenOff: 0, highestStamp: 0 });
  });

  it.each([
    ['that does not parse', 'not json'],
    ['of the wrong shape', JSON.stringify({ lastSeenOff: -1 })],
  ])('fails closed on a file %s: a reset now, written over it', async (_name, content) => {
    await fs.writeFile(file(), content);
    const logger = recordingLogger();
    const reset = createAutoReset({ dir, clock: settableClock(7_000), logger });
    await reset.refresh();
    expect(reset.lastSeenOff()).toBe(7_001);
    expect(await stored()).toEqual({ lastSeenOff: 7_001, highestStamp: 0 });
    expect(logger.warnings).toContain(
      'the stored reset of Auto could not be used; Auto counts as reset now',
    );
  });

  it('fails closed on a file that cannot be read: a reset now, never written over it, and no stamp', async () => {
    await fs.mkdir(file());
    const reset = createAutoReset({ dir, clock: settableClock(7_000) });
    await reset.refresh();
    expect(reset.lastSeenOff()).toBe(7_001);
    await reset.seenOff();
    expect(reset.lastSeenOff()).toBeGreaterThan(7_001);
    await expect(reset.stamp()).rejects.toThrow();
    expect((await fs.stat(file())).isDirectory()).toBe(true);
  });

  it('a reset after a failed read makes every earlier stamp stale, here and in another window', async () => {
    const clock = settableClock(10_000);
    const one = createAutoReset({ dir, clock });
    const two = createAutoReset({ dir, clock });
    await one.refresh();
    await two.refresh();
    const first = await one.stamp();
    const second = await two.stamp();
    await fs.writeFile(file(), 'garbage');
    await one.seenOff();
    expect(one.lastSeenOff()).toBeGreaterThan(first);
    expect(one.lastSeenOff()).toBeGreaterThan(second);
    // Written over the unusable file; the other window reads it.
    await two.refresh();
    expect(two.lastSeenOff()).toBe(one.lastSeenOff());
    expect(two.lastSeenOff()).toBeGreaterThan(second);
  });

  it('without a directory lives in memory only and never throws', async () => {
    const reset = createAutoReset({ dir: undefined, clock: settableClock() });
    await reset.refresh();
    const stamp = await reset.stamp();
    await reset.seenOff();
    expect(reset.lastSeenOff()).toBeGreaterThan(stamp);
    expect(await reset.stamp()).toBeGreaterThan(reset.lastSeenOff());
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('a write that fails is logged, memory keeps the reset, and a stamp is refused', async () => {
    // A file where the directory should be: nothing can be written there.
    const blocked = join(dir, 'blocked');
    await fs.writeFile(blocked, 'x');
    const logger = recordingLogger();
    const reset = createAutoReset({ dir: blocked, clock: settableClock(), logger });
    await expect(reset.seenOff()).resolves.toBeUndefined();
    expect(reset.lastSeenOff()).toBeGreaterThan(0);
    expect(logger.warnings.length).toBeGreaterThan(0);
    await expect(reset.stamp()).rejects.toThrow();
  });

  it('a reset whose write failed is unsaved, and written by the next refresh, so another workspace reads it', async () => {
    const clock = settableClock(10_000);
    const one = createAutoReset({ dir, clock });
    await one.refresh();
    const earlier = await one.stamp();
    expect(one.unsaved()).toBe(false);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk full'));
    await expect(one.seenOff()).resolves.toBeUndefined();
    expect(one.unsaved()).toBe(true);
    // The file still holds the older values: a window that opens now would arm that stamp again.
    expect(await stored()).toEqual({ lastSeenOff: 0, highestStamp: earlier });
    // A retry that fails too leaves it unsaved.
    await one.refresh();
    expect(one.unsaved()).toBe(true);
    rename.mockRestore();
    await one.refresh();
    expect(one.unsaved()).toBe(false);
    const two = createAutoReset({ dir, clock });
    await two.refresh();
    expect(two.lastSeenOff()).toBe(one.lastSeenOff());
    expect(two.lastSeenOff()).toBeGreaterThan(earlier);
  });

  it('a reset that could not be written because the file could not be read is saved once it can be read', async () => {
    await fs.mkdir(file());
    const reset = createAutoReset({ dir, clock: settableClock(7_000) });
    await reset.seenOff();
    expect(reset.unsaved()).toBe(true);
    await reset.refresh();
    expect(reset.unsaved()).toBe(true);
    // Still never written over, while it cannot be read.
    expect((await fs.stat(file())).isDirectory()).toBe(true);
    await fs.rm(file(), { recursive: true });
    await reset.refresh();
    expect(reset.unsaved()).toBe(false);
    expect(await stored()).toEqual({ lastSeenOff: reset.lastSeenOff(), highestStamp: 0 });
  });

  it('is not unsaved after the file holds everything, and never without a directory', async () => {
    const reset = createAutoReset({ dir, clock: settableClock() });
    expect(reset.unsaved()).toBe(false);
    await reset.seenOff();
    expect(reset.unsaved()).toBe(false);
    await reset.stamp();
    expect(reset.unsaved()).toBe(false);
    const memory = createAutoReset({ dir: undefined, clock: settableClock() });
    await memory.seenOff();
    expect(memory.unsaved()).toBe(false);
  });

  it('a stamp whose write failed is unsaved and refused, and saved later', async () => {
    const reset = createAutoReset({ dir, clock: settableClock(1_000) });
    await reset.refresh();
    const rename = vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk full'));
    await expect(reset.stamp()).rejects.toThrow('disk full');
    expect(reset.unsaved()).toBe(true);
    rename.mockRestore();
    await reset.refresh();
    expect(reset.unsaved()).toBe(false);
    expect(await stored()).toMatchObject({ highestStamp: expect.any(Number) as number });
  });
});
