import { describe, expect, it } from 'vitest';
import type { Hunk } from '../../../shared';
import {
  StaleHunkError,
  applyHunkToBaseline,
  computeHunks,
  decodeText,
  hunkId,
  joinLines,
  revertHunkInCurrent,
  splitLines,
} from './hunks';
import { merge3 } from './merge';

/** A small deterministic generator, so that a failure can be reproduced from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  '',
  'x',
  'same',
  'same',
  'same',
  'é',
  '  indented',
];

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

interface Style {
  ending: () => string;
  finalNewline: boolean;
  bom: boolean;
}

function makeStyle(random: () => number): Style {
  const kind = Math.floor(random() * 3);
  return {
    ending:
      kind === 0 ? () => '\n' : kind === 1 ? () => '\r\n' : () => (random() < 0.5 ? '\n' : '\r\n'),
    finalNewline: random() < 0.6,
    bom: random() < 0.15,
  };
}

function makeText(random: () => number, style: Style, lineCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i += 1) lines.push(pick(random, POOL));
  let text = '';
  for (let i = 0; i < lines.length; i += 1) {
    const last = i === lines.length - 1;
    text += lines[i] + (last && !style.finalNewline ? '' : style.ending());
  }
  if (lineCount === 0) text = '';
  return style.bom && text.length > 0 ? '\uFEFF' + text : text;
}

/** A second text derived from the first by editing some lines, or an unrelated one. */
function mutate(random: () => number, text: string, style: Style): string {
  if (random() < 0.15) return makeText(random, makeStyle(random), Math.floor(random() * 8));
  const lines = splitLines(text);
  const edits = 1 + Math.floor(random() * 4);
  for (let e = 0; e < edits; e += 1) {
    const at = Math.floor(random() * (lines.length + 1));
    const roll = random();
    if (roll < 0.4 && at < lines.length) {
      lines[at] = `${pick(random, POOL)}${style.ending()}`;
    } else if (roll < 0.7) {
      lines.splice(at, 0, `${pick(random, POOL)}${style.ending()}`);
    } else if (roll < 0.9 && at < lines.length) {
      lines.splice(at, 1 + Math.floor(random() * 2));
    } else if (lines.length > 0) {
      // Change only the terminator of a line.
      const index = Math.min(at, lines.length - 1);
      const line = lines[index] as string;
      lines[index] = line.endsWith('\r\n')
        ? `${line.slice(0, -2)}\n`
        : line.endsWith('\n')
          ? `${line.slice(0, -1)}\r\n`
          : `${line}\n`;
    }
  }
  return joinLines(lines);
}

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');
const h = (text: string): string => `hash-of-${text.length}`;

function hunksOf(baseline: string, current: string): Hunk[] {
  return computeHunks(baseline, current, 'a.txt', h(baseline), h(current));
}

describe('text and lines', () => {
  it('decodes valid UTF-8 and keeps a byte order mark', () => {
    const data = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi\n')]);
    const text = decodeText(data);
    expect(text).toBe('﻿hi\n');
    expect(bytes(text as string).equals(data)).toBe(true);
  });

  it('refuses a NUL, invalid UTF-8 and lone continuation bytes', () => {
    expect(decodeText(Buffer.from([0x61, 0x00, 0x62]))).toBeUndefined();
    expect(decodeText(Buffer.from([0xff, 0xfe, 0x41]))).toBeUndefined();
    expect(decodeText(Buffer.from([0xc3, 0x28]))).toBeUndefined();
    expect(decodeText(Buffer.alloc(0))).toBe('');
  });

  it('splits lines keeping their terminators, and joins them back exactly', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\n')).toEqual(['a\n']);
    expect(splitLines('a\r\nb\nc')).toEqual(['a\r\n', 'b\n', 'c']);
    expect(splitLines('a\rb\n')).toEqual(['a\rb\n']);
    expect(splitLines('\n\n')).toEqual(['\n', '\n']);
    for (const text of ['', 'a', 'a\r\n', '\r\n\r\nx', 'a\rb', '﻿x\ny']) {
      expect(joinLines(splitLines(text))).toBe(text);
    }
  });

  it('builds ids from the path, both hashes and the index', () => {
    expect(hunkId('a', 'b', 'c', 0)).toBe(hunkId('a', 'b', 'c', 0));
    expect(hunkId('a', 'b', 'c', 0)).not.toBe(hunkId('a', 'b', 'c', 1));
    expect(hunkId('a', 'b', 'c', 0)).not.toBe(hunkId('a', 'b', 'd', 0));
    expect(hunkId('a', 'b', 'c', 0)).not.toBe(hunkId('x', 'b', 'c', 0));
    expect(hunkId('a', 'b', 'c', 0)).not.toBe(hunkId('a', 'x', 'c', 0));
  });
});

describe('computeHunks, fixed cases', () => {
  it('has no hunks for equal texts, including two empty ones', () => {
    expect(hunksOf('', '')).toEqual([]);
    expect(hunksOf('a\nb\n', 'a\nb\n')).toEqual([]);
  });

  it('reports each separate run of changed lines as one hunk, with indexes', () => {
    const result = hunksOf('a\nb\nc\nd\ne\n', 'a\nB\nc\nd\nE\nF\n');
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      index: 0,
      baselineStart: 1,
      baselineLines: ['b\n'],
      currentStart: 1,
      currentLines: ['B\n'],
    });
    expect(result[1]).toMatchObject({
      index: 1,
      baselineStart: 4,
      baselineLines: ['e\n'],
      currentStart: 4,
      currentLines: ['E\n', 'F\n'],
    });
    expect(new Set(result.map((x) => x.id)).size).toBe(2);
  });

  it('treats everything as added against an empty baseline, and removed against an empty file', () => {
    const added = hunksOf('', 'a\nb\n');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ baselineLines: [], currentLines: ['a\n', 'b\n'] });
    const removed = hunksOf('a\nb\n', '');
    expect(removed[0]).toMatchObject({ baselineLines: ['a\n', 'b\n'], currentLines: [] });
  });

  it('sees a changed line ending as a change', () => {
    const result = hunksOf('a\r\nb\r\n', 'a\nb\r\n');
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ baselineLines: ['a\r\n'], currentLines: ['a\n'] });
    const finalOnly = hunksOf('a\nb', 'a\nb\n');
    expect(finalOnly).toHaveLength(1);
    expect(finalOnly[0]).toMatchObject({ baselineLines: ['b'], currentLines: ['b\n'] });
  });

  it('keeps a byte order mark on the first line', () => {
    const result = hunksOf('﻿a\nb\n', 'a\nb\n');
    expect(result).toHaveLength(1);
    expect(result[0]?.baselineLines).toEqual(['﻿a\n']);
  });

  it('applies and reverts a hunk exactly, with CRLF and no final newline', () => {
    const baseline = 'one\r\ntwo\r\nthree\r\nfour';
    const current = 'one\r\nTWO\r\nthree\r\nFOUR!\r\nfive';
    const result = hunksOf(baseline, current);
    expect(result).toHaveLength(2);
    const first = result[0] as Hunk;
    expect(joinLines(applyHunkToBaseline(splitLines(baseline), first))).toBe(
      'one\r\nTWO\r\nthree\r\nfour',
    );
    expect(joinLines(revertHunkInCurrent(splitLines(current), first))).toBe(
      'one\r\ntwo\r\nthree\r\nFOUR!\r\nfive',
    );
  });

  it('refuses a hunk that does not match the lines it is applied to', () => {
    const result = hunksOf('a\nb\nc\n', 'a\nB\nc\n');
    const hunk = result[0] as Hunk;
    expect(() => applyHunkToBaseline(splitLines('a\nX\nc\n'), hunk)).toThrow(StaleHunkError);
    expect(() => revertHunkInCurrent(splitLines('a\nX\nc\n'), hunk)).toThrow(StaleHunkError);
    expect(() => revertHunkInCurrent([], hunk)).toThrow(StaleHunkError);
  });
});

describe('hunk properties', () => {
  /** Reverts hunks one at a time in a random order, recomputing after each, until none are left. */
  function revertAll(random: () => number, baseline: string, current: string): string {
    let text = current;
    for (let guard = 0; guard < 200; guard += 1) {
      const result = hunksOf(baseline, text);
      if (result.length === 0) return text;
      const hunk = pick(random, result);
      text = joinLines(revertHunkInCurrent(splitLines(text), hunk));
    }
    throw new Error('did not converge');
  }

  function acceptAll(random: () => number, baseline: string, current: string): string {
    let text = baseline;
    for (let guard = 0; guard < 200; guard += 1) {
      const result = hunksOf(text, current);
      if (result.length === 0) return text;
      const hunk = pick(random, result);
      text = joinLines(applyHunkToBaseline(splitLines(text), hunk));
    }
    throw new Error('did not converge');
  }

  it('holds for 400 random cases: revert all gives the baseline, accept all gives the file, and each is the inverse of the other', () => {
    let hunkCount = 0;
    let multi = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const random = rng(seed);
      const style = makeStyle(random);
      const baseline = makeText(random, style, Math.floor(random() * 10));
      const current = mutate(random, baseline, style);

      expect(
        bytes(revertAll(random, baseline, current)).equals(bytes(baseline)),
        `revert, seed ${seed}`,
      ).toBe(true);
      expect(
        bytes(acceptAll(random, baseline, current)).equals(bytes(current)),
        `accept, seed ${seed}`,
      ).toBe(true);

      const all = hunksOf(baseline, current);
      hunkCount += all.length;
      if (all.length > 1) multi += 1;
      for (const hunk of all) {
        const accepted = applyHunkToBaseline(splitLines(baseline), hunk);
        const back = revertHunkInCurrent(accepted, {
          ...hunk,
          currentStart: hunk.baselineStart,
          currentLines: hunk.currentLines,
        });
        expect(joinLines(back), `apply then revert, seed ${seed}`).toBe(baseline);

        const reverted = revertHunkInCurrent(splitLines(current), hunk);
        const forward = applyHunkToBaseline(reverted, {
          ...hunk,
          baselineStart: hunk.currentStart,
          baselineLines: hunk.baselineLines,
        });
        expect(joinLines(forward), `revert then apply, seed ${seed}`).toBe(current);
      }
    }
    // The generator must actually produce changes, and files with several hunks.
    expect(hunkCount).toBeGreaterThan(400);
    expect(multi).toBeGreaterThan(50);
  });

  it('covers files that are empty, one line long, or full of identical lines', () => {
    const cases: [string, string][] = [
      ['', 'x'],
      ['x', ''],
      ['x', 'x\n'],
      ['\n', ''],
      ['same\nsame\nsame\nsame\n', 'same\nsame\n'],
      ['same\nsame\n', 'same\nsame\nsame\nsame\nsame\n'],
      ['a\n\n\n\nb\n', 'a\n\nb\n'],
      ['﻿x', 'x'],
      ['a\rb', 'a\r\nb'],
    ];
    for (const [index, [baseline, current]] of cases.entries()) {
      const random = rng(1000 + index);
      expect(revertAll(random, baseline, current)).toBe(baseline);
      expect(acceptAll(random, baseline, current)).toBe(current);
    }
  });
});

describe('merge3', () => {
  it('merges changes in different places and keeps terminators', () => {
    const base = 'a\r\nb\r\nc\r\nd\r\n';
    expect(merge3(base, 'A\r\nb\r\nc\r\nd\r\n', 'a\r\nb\r\nc\r\nD\r\n')).toBe(
      'A\r\nb\r\nc\r\nD\r\n',
    );
  });

  it('gives no result when the changes overlap, and accepts identical changes', () => {
    expect(merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n')).toBeUndefined();
    expect(merge3('a\nb\nc\n', 'a\nX\nc\n', 'a\nX\nc\n')).toBe('a\nX\nc\n');
  });

  it('returns the other side when one side did not change', () => {
    expect(merge3('a\n', 'a\n', 'b\n')).toBe('b\n');
    expect(merge3('a\n', 'b\n', 'a\n')).toBe('b\n');
  });

  it('keeps a final line without a terminator as it is', () => {
    expect(merge3('a\nb', 'a\nb', 'a\nb\nc')).toBe('a\nb\nc');
  });
});
