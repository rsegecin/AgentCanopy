import type { Attribution, ChangeType, Hunk, ReviewEntry } from '../../../shared';

export const HUNK_MAX_LINES = 80;

export const CHANGE_LABEL: Record<ChangeType, { label: string; icon: string }> = {
  created: { label: 'Added', icon: 'diff-added' },
  modified: { label: 'Modified', icon: 'diff-modified' },
  deleted: { label: 'Deleted', icon: 'diff-removed' },
  mode: { label: 'Permissions', icon: 'key' },
  type: { label: 'Type changed', icon: 'symbol-misc' },
};

/** One line of explanation for entries whose source is not certain. */
export const ATTRIBUTION_NOTE: Record<Attribution, string> = {
  'agent-tool': 'Changed by one of the agent’s tools',
  'agent-command': 'Changed by a command the agent ran',
  mixed: 'Both you and the agent changed this file',
  unattributed: 'Changed while the agent was working, but not by one of its tool calls',
  'after-interruption': 'Changed around an interrupted turn',
  user: 'Changed by you',
  external: 'Changed by something other than the agent',
};

export function isAgentAttribution(attribution: Attribution): boolean {
  return attribution === 'agent-tool' || attribution === 'agent-command';
}

export interface ReviewGroups {
  /** Pending, changed by the agent's tools or commands. */
  agent: ReviewEntry[];
  /** Pending, changed during a turn but not certainly by the agent. */
  uncertain: ReviewEntry[];
  accepted: ReviewEntry[];
}

export function groupEntries(entries: readonly ReviewEntry[]): ReviewGroups {
  const groups: ReviewGroups = { agent: [], uncertain: [], accepted: [] };
  for (const entry of entries) {
    if (entry.status === 'accepted') groups.accepted.push(entry);
    else if (isAgentAttribution(entry.attribution)) groups.agent.push(entry);
    else groups.uncertain.push(entry);
  }
  return groups;
}

/** How many files the pending entries touch: a rename touches its old path too. */
export function countFiles(entries: readonly ReviewEntry[]): number {
  const paths = new Set<string>();
  for (const entry of entries) {
    paths.add(entry.path);
    if (entry.renamedFrom !== undefined) paths.add(entry.renamedFrom);
  }
  return paths.size;
}

export interface DisplayLine {
  sign: '-' | '+';
  /** The line without its terminator. */
  text: string;
  /** True when the line had no terminator: the file ends without a newline here. */
  noEol: boolean;
}

function toLine(sign: '-' | '+', raw: string): DisplayLine {
  const text = raw.replace(/(?:\r\n|\n|\r)$/, '');
  return { sign, text, noEol: text === raw && raw !== '' };
}

/** The lines of a hunk to show: removed lines, then added lines, cut at `HUNK_MAX_LINES`. */
export function hunkLines(hunk: Hunk): { lines: DisplayLine[]; hidden: number } {
  const all = [
    ...hunk.baselineLines.map((l) => toLine('-', l)),
    ...hunk.currentLines.map((l) => toLine('+', l)),
  ];
  return {
    lines: all.slice(0, HUNK_MAX_LINES),
    hidden: Math.max(all.length - HUNK_MAX_LINES, 0),
  };
}
