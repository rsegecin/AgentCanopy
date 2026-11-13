/** A run of this many blank lines or more is marked, because it can push a second command out of sight. */
export const BLANK_RUN_MIN = 3;

/**
 * The lines of a command, as typed. Nothing is collapsed or trimmed. A single trailing line break
 * is not a line of its own: it hides nothing.
 */
export function commandLines(text: string): string[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** For every line that starts a run of `BLANK_RUN_MIN` or more blank lines: how long the run is. */
export function blankRuns(lines: readonly string[]): Map<number, number> {
  const runs = new Map<number, number>();
  let start = -1;
  const close = (end: number) => {
    if (start >= 0 && end - start >= BLANK_RUN_MIN) runs.set(start, end - start);
    start = -1;
  };
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      if (start < 0) start = index;
    } else close(index);
  });
  close(lines.length);
  return runs;
}
