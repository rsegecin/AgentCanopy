import { describe, expect, it } from 'vitest';
import { computeHunks } from './hunks';
import { merge3 } from './merge';

const lines = (prefix: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join('');

describe('cost limits', () => {
  it('offers no hunks for a rewrite too large to diff quickly, instead of hanging', () => {
    const started = Date.now();
    expect(computeHunks(lines('line', 30_000), lines('other', 30_000), 'x', '1', '2')).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 20_000);

  it('still gives hunks for a few changes in a large file', () => {
    const base = lines('line', 30_000);
    const changed = base.replace('line 15000\n', 'changed\n');
    expect(computeHunks(base, changed, 'x', '1', '2')).toHaveLength(1);
  });

  it('does not try to merge files with too many lines', () => {
    const base = lines('line', 25_000);
    expect(
      merge3(base, base.replace('line 1\n', 'a\n'), base.replace('line 9\n', 'b\n')),
    ).toBeUndefined();
  });
});
