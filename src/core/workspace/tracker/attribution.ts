import type { Attribution, RelPath } from '../../../shared';
import type { IndexEntry } from '../store';
import type { TurnState } from './turn-state';

/** Did the path change between B and the end of the turn? By hash when both have one, else by size, mode and mtime. */
export function entryChanged(b: IndexEntry | undefined, e: IndexEntry | undefined): boolean {
  if (b === undefined && e === undefined) return false;
  if (b === undefined || e === undefined) return true;
  if (b.kind !== e.kind) return true;
  if (e.kind === 'symlink') return b.target !== e.target;
  if (b.hash !== undefined && e.hash !== undefined) return b.hash !== e.hash || b.mode !== e.mode;
  // Without content to compare, a touch counts: the file is tracked by stat only and cannot be undone anyway.
  return b.size !== e.size || b.mode !== e.mode || b.mtimeNs !== e.mtimeNs;
}

export interface AttributionInput {
  path: RelPath;
  /** sha256 of the path at the end of the turn, when it is a file. */
  finalHash: string | undefined;
  /** The path ended the turn with a different stat than at the last scan of the turn (someone touched it after). */
  late: boolean;
  /** No tool hook reached us although tools were asking for permission. */
  hooksMissing: boolean;
}

/**
 * Who gets the blame for a change. The first matching rule wins. Only what happened after the
 * agent's capture of the path counts against the agent: a save, or a change noticed outside any tool
 * window, after that point (or at all, when there was no capture) makes the change `mixed`, which
 * is never reverted without the user's say-so. A save alone is `user` only when the file ended the
 * turn exactly as it was saved.
 */
export function attribute(turn: TurnState, input: AttributionInput): Attribution {
  const { path } = input;
  const captureSeq = turn.preEdit.get(path)?.seq ?? 0;
  const save = turn.userSaves.get(path);
  const gapSeq = turn.gap.get(path);
  const otherHand =
    (save !== undefined && save.seq > captureSeq) ||
    (gapSeq !== undefined && gapSeq > captureSeq) ||
    input.late;
  if (turn.named.has(path)) return otherHand ? 'mixed' : 'agent-tool';
  if (input.hooksMissing) return 'unattributed';
  if (turn.windows.get(path)?.command) return otherHand ? 'mixed' : 'agent-command';
  if (save !== undefined) {
    return save.hash !== undefined && save.hash === input.finalHash ? 'user' : 'mixed';
  }
  return 'unattributed';
}
