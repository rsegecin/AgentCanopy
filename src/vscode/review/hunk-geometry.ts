import type { Hunk } from '../../shared';

/** Where a hunk shows in the file as it is on disk now. All line numbers are zero-based. */

type Positioned = Pick<Hunk, 'currentStart' | 'currentLines' | 'baselineLines'>;

/** The line a hunk's lenses sit on: its first current line, or where the removed lines were. */
export function lensLine(hunk: Positioned, lineCount: number): number {
  const last = Math.max(lineCount - 1, 0);
  return Math.min(Math.max(hunk.currentStart, 0), last);
}

export type MarkKind = 'added' | 'modified' | 'removed';

export interface Mark {
  kind: MarkKind;
  /** First and last line of the range, inclusive. */
  startLine: number;
  endLine: number;
  /** For `removed` only: the removed lines sat after the last line of the file. */
  atEnd: boolean;
}

/** The decoration ranges for a file's hunks. */
export function marksFor(hunks: readonly Positioned[], lineCount: number): Mark[] {
  const last = Math.max(lineCount - 1, 0);
  return hunks.map((hunk) => {
    if (hunk.currentLines.length === 0) {
      const line = lensLine(hunk, lineCount);
      return { kind: 'removed', startLine: line, endLine: line, atEnd: hunk.currentStart > last };
    }
    const startLine = Math.min(hunk.currentStart, last);
    const endLine = Math.min(hunk.currentStart + hunk.currentLines.length - 1, last);
    return {
      kind: hunk.baselineLines.length === 0 ? 'added' : 'modified',
      startLine,
      endLine,
      atEnd: false,
    };
  });
}

/** The hunk that contains `line`, or else the nearest one above it. */
export function hunkAt<T extends Positioned>(
  hunks: readonly T[],
  line: number,
  lineCount: number,
): T | undefined {
  let found: T | undefined;
  let foundLine = -1;
  for (const hunk of hunks) {
    const start = lensLine(hunk, lineCount);
    if (start <= line && start >= foundLine) {
      found = hunk;
      foundLine = start;
    }
  }
  return found;
}

/** The next (direction 1) or previous (-1) hunk line relative to `line`, wrapping around. */
export function neighbourLine(
  lines: readonly number[],
  line: number,
  direction: 1 | -1,
): number | undefined {
  if (lines.length === 0) return undefined;
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  if (direction === 1) return sorted.find((l) => l > line) ?? sorted[0];
  return [...sorted].reverse().find((l) => l < line) ?? sorted[sorted.length - 1];
}
