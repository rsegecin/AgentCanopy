import { createHash } from 'node:crypto';
import { diffArrays } from 'diff';
import type { Hunk } from '../../../shared';

/** Files above this size are reviewed as a whole: no hunks, no line counts, no merges. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** A diff needing more added plus removed lines than this is not offered as hunks. */
const MAX_EDIT_LENGTH = 3000;

/** Thrown when a hunk does not match the lines it is applied to. Nothing is returned in that case. */
export class StaleHunkError extends Error {
  override name = 'StaleHunkError';
  constructor() {
    super('The hunk does not match the lines it was applied to');
  }
}

/**
 * The text of valid UTF-8 without a NUL, or undefined. A byte order mark is kept as part of the text,
 * so that encoding the text again gives the same bytes.
 */
export function decodeText(data: Uint8Array): string | undefined {
  if (data.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    return undefined;
  }
}

/**
 * Splits text into lines that keep their terminators (`\n` or `\r\n`). A last line without a
 * terminator is a line too. A lone `\r` is not a terminator. Joining the lines gives the text back.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('');
}

/** One run of removed and/or added lines, with zero-based line indexes. */
export interface HunkRun {
  baselineStart: number;
  baselineLines: string[];
  currentStart: number;
  currentLines: string[];
}

/**
 * The maximal runs of differing lines between two line arrays, or undefined when the files differ
 * too much to be reviewed hunk by hunk.
 */
export function diffRuns(
  baselineLines: readonly string[],
  currentLines: readonly string[],
): HunkRun[] | undefined {
  const changes = diffArrays([...baselineLines], [...currentLines], {
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (changes === undefined) return undefined;
  const runs: HunkRun[] = [];
  let bi = 0;
  let ci = 0;
  let open: HunkRun | undefined;
  for (const change of changes) {
    if (change.count === 0) continue;
    if (change.added) {
      open ??= { baselineStart: bi, baselineLines: [], currentStart: ci, currentLines: [] };
      for (let k = 0; k < change.count; k += 1)
        open.currentLines.push(currentLines[ci + k] as string);
      ci += change.count;
    } else if (change.removed) {
      open ??= { baselineStart: bi, baselineLines: [], currentStart: ci, currentLines: [] };
      for (let k = 0; k < change.count; k += 1)
        open.baselineLines.push(baselineLines[bi + k] as string);
      bi += change.count;
    } else {
      if (open) runs.push(open);
      open = undefined;
      bi += change.count;
      ci += change.count;
    }
  }
  if (open) runs.push(open);
  // The diff must account for every line of both sides, or something went wrong and we say nothing.
  if (bi !== baselineLines.length || ci !== currentLines.length) return undefined;
  return runs;
}

/** Where a path sits in a hunk id when a side is absent. */
export const ABSENT_HASH = 'absent';

export function hunkId(
  path: string,
  baselineHash: string,
  currentHash: string,
  index: number,
): string {
  return createHash('sha256')
    .update(`${path}\0${baselineHash}\0${currentHash}\0${index}`)
    .digest('hex');
}

export function computeHunksFromLines(
  baselineLines: readonly string[],
  currentLines: readonly string[],
  path: string,
  baselineHash: string,
  currentHash: string,
): Hunk[] {
  const runs = diffRuns(baselineLines, currentLines);
  if (runs === undefined) return [];
  return runs.map((run, index) => ({
    id: hunkId(path, baselineHash, currentHash, index),
    index,
    ...run,
  }));
}

/**
 * Hunks between the baseline text and the current text. Each maximal run of removed and/or added
 * lines is one hunk. `"absent"` is no text at all: pass an empty string for it.
 */
export function computeHunks(
  baselineText: string,
  currentText: string,
  path: string,
  baselineHash: string,
  currentHash: string,
): Hunk[] {
  return computeHunksFromLines(
    splitLines(baselineText),
    splitLines(currentText),
    path,
    baselineHash,
    currentHash,
  );
}

function sameLines(lines: readonly string[], start: number, expected: readonly string[]): boolean {
  if (start < 0 || start + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (lines[start + i] !== expected[i]) return false;
  }
  return true;
}

/** Accepting one hunk: the baseline takes the current lines. Throws `StaleHunkError` on a mismatch. */
export function applyHunkToBaseline(baselineLines: readonly string[], hunk: Hunk): string[] {
  if (!sameLines(baselineLines, hunk.baselineStart, hunk.baselineLines)) throw new StaleHunkError();
  return [
    ...baselineLines.slice(0, hunk.baselineStart),
    ...hunk.currentLines,
    ...baselineLines.slice(hunk.baselineStart + hunk.baselineLines.length),
  ];
}

/** Rejecting one hunk: the file takes the baseline lines. Throws `StaleHunkError` on a mismatch. */
export function revertHunkInCurrent(currentLines: readonly string[], hunk: Hunk): string[] {
  if (!sameLines(currentLines, hunk.currentStart, hunk.currentLines)) throw new StaleHunkError();
  return [
    ...currentLines.slice(0, hunk.currentStart),
    ...hunk.baselineLines,
    ...currentLines.slice(hunk.currentStart + hunk.currentLines.length),
  ];
}
