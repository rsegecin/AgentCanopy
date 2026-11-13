/** Oldest Claude Code version AgentCanopy supports. */
export const MINIMUM_CLAUDE_VERSION = '2.1.295';

function parts(version: string): number[] {
  return version
    .trim()
    .split('.')
    .map((p) => {
      const n = Number.parseInt(p, 10);
      return Number.isNaN(n) ? 0 : n;
    });
}

/** Negative when a is older than b, zero when equal, positive when a is newer. Numeric parts only. */
export function compareVersions(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Reads the leading x.y.z from `claude --version` output ("2.1.322 (Claude Code)"). */
export function parseVersion(output: string): string | undefined {
  const match = /^\s*v?(\d+\.\d+\.\d+)/.exec(output);
  return match?.[1];
}
