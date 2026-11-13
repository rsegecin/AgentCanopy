import { diff3Merge } from 'node-diff3';
import { MAX_TEXT_BYTES, joinLines, splitLines } from './hunks';

/** Above this many lines a merge is not attempted, because the cost of finding the overlap is unbounded. */
const MAX_MERGE_LINES = 20_000;

/**
 * Three-way merge by lines, keeping line terminators. `ours` and `theirs` are both derived from
 * `base`. Returns the merged text, or undefined when the changes overlap, the files are too large to
 * merge, or the merge cannot be trusted. Identical changes on both sides are not a conflict.
 */
export function merge3(base: string, ours: string, theirs: string): string | undefined {
  if (
    base.length > MAX_TEXT_BYTES ||
    ours.length > MAX_TEXT_BYTES ||
    theirs.length > MAX_TEXT_BYTES
  ) {
    return undefined;
  }
  const baseLines = splitLines(base);
  const ourLines = splitLines(ours);
  const theirLines = splitLines(theirs);
  if (
    baseLines.length > MAX_MERGE_LINES ||
    ourLines.length > MAX_MERGE_LINES ||
    theirLines.length > MAX_MERGE_LINES
  ) {
    return undefined;
  }
  // Trivial cases first: no library needed and no way to get them wrong.
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  if (ours === theirs) return ours;

  const regions = diff3Merge<string>(ourLines, baseLines, theirLines, {
    excludeFalseConflicts: true,
  });
  const merged: string[] = [];
  for (const region of regions) {
    if (region.conflict !== undefined) return undefined;
    if (region.ok === undefined) return undefined;
    for (const line of region.ok) merged.push(line);
  }
  return joinLines(merged);
}
