import type { Attribution, FileState, OperationId, RelPath, ReviewEntry } from '../../../shared';
import type { LogRecord } from '../../contracts';
import type { BlobStore } from '../store';
import { MAX_TEXT_BYTES, diffRuns, splitLines } from './hunks';
import { merge3 } from './merge';
import {
  NOT_RESTORABLE_NOTE,
  changeTypeOf,
  hashOf,
  isRestorable,
  mergeMode,
  readStoredText,
  statesEqual,
} from './states';

/**
 * The review state of one folder: a pure fold over its log. The only side effect is that merged
 * baselines are stored as blobs, which is deterministic: the same log gives the same blobs.
 */
export interface Fold {
  entries: ReviewEntry[];
  byPath: Map<RelPath, ReviewEntry>;
  /** Every blob the entries use, merged baselines included. */
  hashes: Set<string>;
  /**
   * Pending paths whose current content holds someone else's edits that the baseline does not (the
   * merge over them failed). Taking the agent's change out by comparing the two would take those
   * edits out as well, so only an explicit overwrite may put the baseline back.
   */
  unmerged: Set<RelPath>;
  /** Ids of operations that were reconstructed after an interrupted turn. */
  recoveryOperations: Set<OperationId>;
}

interface WorkEntry {
  baseline: FileState;
  current: FileState;
  attribution: Attribution;
  operationIds: OperationId[];
  includesUserEdits: boolean;
  accepted: boolean;
  /** See `Fold.unmerged`. */
  unmerged: boolean;
  /** For an accepted entry: the baseline before it was accepted, so that the change type can still be shown. */
  acceptedFrom?: FileState;
}

/** From the most certain to the least certain. */
const CERTAINTY: Attribution[] = [
  'agent-tool',
  'agent-command',
  'mixed',
  'unattributed',
  'after-interruption',
];

function lessCertain(a: Attribution, b: Attribution): Attribution {
  const ia = CERTAINTY.indexOf(a);
  const ib = CERTAINTY.indexOf(b);
  // An attribution outside the ladder (user, external) never reaches here, but if it did, be careful.
  if (ia < 0 || ib < 0) return 'mixed';
  return ia >= ib ? a : b;
}

/** Whether the state can be compared: everything but a file tracked without its hash. */
function isDefinite(state: FileState): boolean {
  return state.kind !== 'file' || state.hash !== undefined;
}

function cloneEntry(entry: WorkEntry): WorkEntry {
  return { ...entry, operationIds: [...entry.operationIds] };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function foldLog(records: readonly LogRecord[], blobs: BlobStore): Promise<Fold> {
  const entries = new Map<RelPath, WorkEntry>();
  const operationOrder = new Map<OperationId, number>();
  const recoveryOperations = new Set<OperationId>();
  const textCache = new Map<string, Promise<string | undefined>>();
  /**
   * For every operation and every path it changes: the review entry of that path as it was just
   * before the operation was applied (`undefined`: none, or only an accepted one, which is cosmetic).
   * A restore puts entries back to such a snapshot.
   */
  const snapshots = new Map<OperationId, Map<RelPath, WorkEntry | undefined>>();
  /** The operations that changed each path, in log order. */
  const pathOperations = new Map<RelPath, { id: OperationId; order: number }[]>();

  const textOf = (state: FileState): Promise<string | undefined> => {
    if (state.kind !== 'file' || state.hash === undefined) return Promise.resolve(undefined);
    const key = `${state.hash}:${state.stored}:${state.binary}:${state.size}`;
    let cached = textCache.get(key);
    if (cached === undefined) {
      cached = readStoredText(blobs, state).catch(() => undefined);
      textCache.set(key, cached);
    }
    return cached;
  };

  /** The user or another program changed a path: rebase the baseline of its pending entry over it. */
  async function foreignChange(path: RelPath, after: FileState): Promise<void> {
    const entry = entries.get(path);
    if (entry === undefined || entry.accepted) return;
    const base = await textOf(entry.current);
    const ours = await textOf(entry.baseline);
    const theirs = await textOf(after);
    let merged: string | undefined;
    if (
      base !== undefined &&
      ours !== undefined &&
      theirs !== undefined &&
      entry.current.kind === 'file' &&
      entry.baseline.kind === 'file' &&
      after.kind === 'file'
    ) {
      merged = merge3(base, ours, theirs);
      if (merged !== undefined) {
        const data = Buffer.from(merged, 'utf8');
        const hash = await blobs.put(data);
        entry.baseline = {
          kind: 'file',
          hash,
          size: data.length,
          mode: mergeMode(entry.current.mode, entry.baseline.mode, after.mode),
          stored: true,
          binary: false,
        };
        entry.current = after;
        entry.includesUserEdits = true;
      }
    }
    if (merged === undefined) {
      entry.current = after;
      entry.attribution = 'mixed';
      entry.includesUserEdits = true;
      entry.unmerged = true;
    }
    if (statesEqual(entry.baseline, entry.current)) entries.delete(path);
  }

  async function agentChange(
    path: RelPath,
    change: { before: FileState; after: FileState; attribution: Attribution },
    operationId: OperationId,
  ): Promise<void> {
    let entry = entries.get(path);
    // A user's change that was never logged: the operation started from a state that is not the one
    // we last saw. Treat it as a foreign change first, so it is not swallowed by the agent's.
    if (
      entry !== undefined &&
      !entry.accepted &&
      isDefinite(entry.current) &&
      isDefinite(change.before) &&
      !statesEqual(entry.current, change.before)
    ) {
      await foreignChange(path, change.before);
      entry = entries.get(path);
    }
    if (entry === undefined || entry.accepted) {
      entries.set(path, {
        baseline: change.before,
        current: change.after,
        attribution: change.attribution,
        operationIds: [operationId],
        includesUserEdits: false,
        accepted: false,
        unmerged: false,
      });
    } else {
      entry.current = change.after;
      if (!entry.operationIds.includes(operationId)) entry.operationIds.push(operationId);
      entry.attribution = lessCertain(entry.attribution, change.attribution);
    }
    const now = entries.get(path);
    if (now !== undefined && statesEqual(now.baseline, now.current)) entries.delete(path);
  }

  for (const [position, record] of records.entries()) {
    if (record.type === 'operation') {
      operationOrder.set(record.id, position);
      if (record.kind === 'recovery') recoveryOperations.add(record.id);
      const snapshot = new Map<RelPath, WorkEntry | undefined>();
      for (const change of record.changes) {
        const entry = entries.get(change.path);
        snapshot.set(
          change.path,
          entry === undefined || entry.accepted ? undefined : cloneEntry(entry),
        );
        const known = pathOperations.get(change.path);
        if (known === undefined)
          pathOperations.set(change.path, [{ id: record.id, order: position }]);
        else if (known.at(-1)?.id !== record.id) known.push({ id: record.id, order: position });
      }
      snapshots.set(record.id, snapshot);
      if (record.kind === 'agent-turn') {
        // Accepted entries are shown only until the next turn.
        for (const [path, entry] of [...entries]) if (entry.accepted) entries.delete(path);
      }
      if (record.kind === 'agent-turn' || record.kind === 'recovery') {
        for (const change of record.changes) {
          if (change.attribution === 'user' || change.attribution === 'external') {
            await foreignChange(change.path, change.after);
          } else {
            await agentChange(change.path, change, record.id);
          }
        }
      } else if (record.kind === 'reject') {
        for (const change of record.changes) {
          const entry = entries.get(change.path);
          if (entry === undefined || entry.accepted) continue;
          entry.current = change.after;
          if (statesEqual(entry.baseline, entry.current)) entries.delete(change.path);
        }
      } else {
        // A restore puts each path's review entry back to what it was just before the first operation
        // at or after the checkpoint that changed the path, with the file as the restore left it.
        // (A checkpoint that is no longer in the log is older than everything that is.)
        const targetOrder =
          record.restoredTo === undefined
            ? undefined
            : (operationOrder.get(record.restoredTo) ?? -1);
        for (const change of record.changes) {
          const first =
            targetOrder === undefined
              ? undefined
              : pathOperations
                  .get(change.path)
                  ?.find((op) => op.order >= targetOrder && op.order < position);
          if (first === undefined) {
            const entry = entries.get(change.path);
            if (entry === undefined || entry.accepted) continue;
            entry.current = change.after;
            if (statesEqual(entry.baseline, entry.current)) entries.delete(change.path);
            continue;
          }
          const before = snapshots.get(first.id)?.get(change.path);
          if (before === undefined) {
            entries.delete(change.path);
            continue;
          }
          const restored = cloneEntry(before);
          restored.current = change.after;
          if (statesEqual(restored.baseline, restored.current)) entries.delete(change.path);
          else entries.set(change.path, restored);
        }
      }
    } else if (record.type === 'foreign-delta') {
      for (const change of record.changes) await foreignChange(change.path, change.after);
    } else {
      for (const item of record.accepted) {
        const entry = entries.get(item.path);
        if (entry === undefined || entry.accepted) continue;
        if (item.whole) {
          entry.acceptedFrom = entry.baseline;
          entry.baseline = item.baseline;
          entry.current = item.baseline;
          entry.accepted = true;
        } else {
          entry.baseline = item.baseline;
          if (statesEqual(entry.baseline, entry.current)) entries.delete(item.path);
        }
      }
    }
  }

  return assemble(entries, textOf, recoveryOperations);
}

async function assemble(
  entries: Map<RelPath, WorkEntry>,
  textOf: (state: FileState) => Promise<string | undefined>,
  recoveryOperations: Set<OperationId>,
): Promise<Fold> {
  const paths = [...entries.keys()].sort(compare);
  const result: ReviewEntry[] = [];
  const hashes = new Set<string>();
  const unmerged = new Set<RelPath>();
  for (const path of paths) {
    const entry = entries.get(path) as WorkEntry;
    for (const state of [entry.baseline, entry.current, entry.acceptedFrom]) {
      const hash = state === undefined ? undefined : hashOf(state);
      if (hash !== undefined) hashes.add(hash);
    }
    if (entry.unmerged && !entry.accepted) unmerged.add(path);
    const shownBaseline = entry.accepted ? (entry.acceptedFrom ?? entry.baseline) : entry.baseline;
    const restorable = !entry.accepted && isRestorable(entry.baseline);
    const review: ReviewEntry = {
      path,
      changeType: changeTypeOf(shownBaseline, entry.current),
      attribution: entry.attribution,
      status: entry.accepted ? 'accepted' : 'pending',
      baseline: entry.baseline,
      current: entry.current,
      restorable,
      ...(!entry.accepted && !restorable ? { note: NOT_RESTORABLE_NOTE } : {}),
      includesUserEdits: entry.includesUserEdits,
      operationIds: [...entry.operationIds],
    };
    if (!entry.accepted) {
      const lines = await lineCounts(entry.baseline, entry.current, textOf);
      if (lines !== undefined) {
        review.linesAdded = lines.added;
        review.linesRemoved = lines.removed;
      }
    }
    result.push(review);
  }
  markRenames(result);
  return {
    entries: result,
    byPath: new Map(result.map((e) => [e.path, e])),
    hashes,
    unmerged,
    recoveryOperations,
  };
}

async function lineCounts(
  baseline: FileState,
  current: FileState,
  textOf: (state: FileState) => Promise<string | undefined>,
): Promise<{ added: number; removed: number } | undefined> {
  const side = async (state: FileState): Promise<string[] | undefined> => {
    if (state.kind === 'absent') return [];
    if (state.kind !== 'file' || state.size > MAX_TEXT_BYTES) return undefined;
    const text = await textOf(state);
    return text === undefined ? undefined : splitLines(text);
  };
  const a = await side(baseline);
  if (a === undefined) return undefined;
  const b = await side(current);
  if (b === undefined) return undefined;
  const runs = diffRuns(a, b);
  if (runs === undefined) return undefined;
  let added = 0;
  let removed = 0;
  for (const run of runs) {
    added += run.currentLines.length;
    removed += run.baselineLines.length;
  }
  return { added, removed };
}

/** A created entry with the content of exactly one entry deleted in the same operation is a rename. */
function markRenames(entries: ReviewEntry[]): void {
  const deleted = entries.filter(
    (e) =>
      e.status === 'pending' &&
      e.changeType === 'deleted' &&
      e.baseline.kind === 'file' &&
      e.baseline.hash !== undefined &&
      e.baseline.size > 0,
  );
  for (const created of entries) {
    if (
      created.status !== 'pending' ||
      created.changeType !== 'created' ||
      created.current.kind !== 'file' ||
      created.current.hash === undefined
    ) {
      continue;
    }
    const hash = created.current.hash;
    const sources = deleted.filter(
      (d) =>
        hashOf(d.baseline) === hash &&
        d.operationIds.some((id) => created.operationIds.includes(id)),
    );
    if (sources.length === 1) created.renamedFrom = (sources[0] as ReviewEntry).path;
  }
}
