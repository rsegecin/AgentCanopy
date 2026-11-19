import type {
  Attribution,
  ChangesPart,
  ChangeType,
  Message,
  OperationId,
  RelPath,
  ReviewEntry,
  ViewState,
} from '../../../shared';

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

/** The operation that owns an entry: the last one that touched the path. It decides where the entry has its actions. */
export function ownerOf(entry: ReviewEntry): OperationId | undefined {
  return entry.operationIds[entry.operationIds.length - 1];
}

export interface RecordRow {
  path: RelPath;
  changeType: ChangeType;
  /** `later`: a later operation owns the entry now. `settled`: it is no longer pending (or never was in the view). */
  state: 'later' | 'settled';
}

export interface CardRows {
  /** The entries this card acts on: pending and accepted ones owned by one of its operations. */
  live: ReviewEntry[];
  /** The files the card lists that it no longer acts on. */
  record: RecordRow[];
  /** Files beyond the cap of the part's list that are not live either: counted, not listed. */
  moreSettled: number;
}

/** What one `changes` part shows, worked out from the review entries of the folder. */
export function cardRows(part: ChangesPart, entries: readonly ReviewEntry[]): CardRows {
  const own = new Set<string>(part.operationIds);
  const byPath = new Map<string, ReviewEntry>();
  const live: ReviewEntry[] = [];
  for (const entry of entries) {
    byPath.set(entry.path, entry);
    const owner = ownerOf(entry);
    if (owner !== undefined && own.has(owner)) live.push(entry);
  }
  const livePaths = new Set<string>(live.map((entry) => entry.path));
  const listed = new Set<string>(part.files.map((file) => file.path));
  const record: RecordRow[] = [];
  for (const file of part.files) {
    if (livePaths.has(file.path)) continue;
    const entry = byPath.get(file.path);
    const later = entry !== undefined && entry.operationIds.some((id) => own.has(id));
    record.push({
      path: file.path,
      changeType: file.changeType,
      state: later ? 'later' : 'settled',
    });
  }
  const liveBeyondList = live.filter((entry) => !listed.has(entry.path)).length;
  return { live, record, moreSettled: Math.max(0, part.more - liveBeyondList) };
}

/** The entries no card of the open conversation acts on. */
export function elsewhere(
  entries: readonly ReviewEntry[],
  cardOperations: ReadonlySet<string>,
): ReviewEntry[] {
  return entries.filter((entry) => {
    const owner = ownerOf(entry);
    return owner === undefined || !cardOperations.has(owner);
  });
}

/**
 * A selector for the operations of every `changes` part of the open conversation. It returns the
 * same set while the operations are unchanged, so text streaming into the last message does not
 * re-render what depends on it. The operations found in a message are kept per message object:
 * messages that did not change keep their identity between patches.
 */
export function cardOperationsSelector(): (state: ViewState) => ReadonlySet<string> {
  const perMessage = new WeakMap<Message, readonly OperationId[]>();
  let last: ReadonlySet<string> = new Set();
  return (state) => {
    const next = new Set<string>();
    for (const message of state.active?.messages ?? []) {
      if (message.role !== 'assistant') continue;
      let ids = perMessage.get(message);
      if (ids === undefined) {
        ids = message.parts.flatMap((part) => (part.kind === 'changes' ? part.operationIds : []));
        perMessage.set(message, ids);
      }
      for (const id of ids) next.add(id);
    }
    if (next.size === last.size && [...next].every((id) => last.has(id))) return last;
    last = next;
    return next;
  };
}
