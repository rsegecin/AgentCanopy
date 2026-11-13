import { describe, expect, it } from 'vitest';
import { hunkAt, lensLine, marksFor, neighbourLine } from './hunk-geometry';

const hunk = (currentStart: number, current: number, baseline: number) => ({
  currentStart,
  currentLines: Array.from({ length: current }, () => 'x\n'),
  baselineLines: Array.from({ length: baseline }, () => 'y\n'),
});

describe('lensLine', () => {
  it('is the first current line, clamped into the file', () => {
    expect(lensLine(hunk(3, 2, 1), 10)).toBe(3);
    expect(lensLine(hunk(10, 0, 2), 10)).toBe(9);
    expect(lensLine(hunk(0, 0, 2), 0)).toBe(0);
  });
});

describe('marksFor', () => {
  it('tells added, modified and removed apart', () => {
    const marks = marksFor([hunk(0, 2, 0), hunk(5, 1, 1), hunk(8, 0, 3)], 20);
    expect(marks.map((m) => [m.kind, m.startLine, m.endLine])).toEqual([
      ['added', 0, 1],
      ['modified', 5, 5],
      ['removed', 8, 8],
    ]);
  });

  it('marks a removal at the end of the file on the last line', () => {
    const [mark] = marksFor([hunk(4, 0, 1)], 4);
    expect(mark).toMatchObject({ kind: 'removed', startLine: 3, atEnd: true });
  });
});

describe('hunkAt', () => {
  const hunks = [hunk(2, 2, 1), hunk(10, 1, 1)];
  it('finds the containing hunk or the nearest one above', () => {
    expect(hunkAt(hunks, 3, 20)).toBe(hunks[0]);
    expect(hunkAt(hunks, 6, 20)).toBe(hunks[0]);
    expect(hunkAt(hunks, 15, 20)).toBe(hunks[1]);
  });
  it('finds nothing above the first hunk', () => {
    expect(hunkAt(hunks, 1, 20)).toBeUndefined();
  });
});

describe('neighbourLine', () => {
  it('moves forward and backward and wraps', () => {
    expect(neighbourLine([2, 10], 2, 1)).toBe(10);
    expect(neighbourLine([2, 10], 10, 1)).toBe(2);
    expect(neighbourLine([2, 10], 10, -1)).toBe(2);
    expect(neighbourLine([2, 10], 2, -1)).toBe(10);
    expect(neighbourLine([], 0, 1)).toBeUndefined();
  });
});
