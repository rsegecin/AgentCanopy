import type {
  FileState,
  FolderKey,
  Hunk,
  OperationId,
  RelPath,
  ReviewEntry,
  Settings,
} from '../../../shared';
import {
  noEditor,
  silentLogger,
  systemClock,
  type BaselineContent,
  type Clock,
  type EditorPort,
  type LogRecord,
  type Logger,
  type RejectAllPreview,
  type RejectAllResult,
  type RejectMode,
  type RejectResult,
  type ReviewService,
  type TurnObserver,
} from '../../contracts';
import { newId } from '../../util/ids';
import { resolveInside } from '../store';
import type { FolderWorkspace, WorkspaceTracker } from '../tracker';
import { captureReadState, readDisk, readToState, type DiskRead } from './disk';
import {
  FOLDER_IN_THE_WAY_MESSAGE,
  OTHER_IN_THE_WAY_MESSAGE,
  TOO_LARGE_MESSAGE,
  applyWrite,
  planWrite,
  type ExecutorContext,
  type ExecutorHooks,
  type WriteRequest,
  type WriteTarget,
} from './executor';
import { foldLog, type Fold } from './fold';
import {
  ABSENT_HASH,
  MAX_TEXT_BYTES,
  StaleHunkError,
  applyHunkToBaseline,
  computeHunksFromLines,
  decodeText,
  joinLines,
  revertHunkInCurrent,
  splitLines,
} from './hunks';
import { merge3 } from './merge';
import {
  NOT_RESTORABLE_NOTE,
  hashOf,
  mergeMode,
  readStoredBytes,
  readStoredText,
  statesEqual,
} from './states';

export const BUSY_MESSAGE = 'An agent turn is running in this folder. Wait for it to finish.';
export const NOT_OPEN_MESSAGE = 'The folder is not open.';
export const NOT_PENDING_MESSAGE = 'That change is no longer pending.';
export const OUT_OF_DATE_MESSAGE = 'This change is out of date. Reload the changes and try again.';
export const FAILED_MESSAGE = 'AgentCanopy could not complete this. Nothing was changed.';
export const OVERLAP_MESSAGE =
  "Your later edits overlap the agent's changes, so they cannot be separated automatically. Review the file in the diff editor.";
export const NOT_TEXT_MESSAGE =
  "This file cannot be compared line by line, so your later edits cannot be separated from the agent's changes.";
export const BASELINE_GONE_MESSAGE =
  'The earlier content of this file is no longer available, so it cannot be put back.';
export const LINK_IN_THE_WAY_MESSAGE = 'A link now exists at this path, so it was left alone.';
export const UNSAVED_MESSAGE =
  'This file has unsaved changes in the editor. Save or discard them first.';
export const RECONSTRUCTED_MESSAGE =
  'This change was reconstructed after an interrupted turn. Reject it on its own to choose what happens.';
export const MIXED_MESSAGE =
  'Both you and the agent changed this file. Reject it on its own to choose what happens.';
export const CHANGED_SINCE_MESSAGE =
  'This file was changed after the agent left it, so it was not reverted. Review it on its own.';

export interface ReviewEngineOptions {
  tracker: WorkspaceTracker;
  editor?: EditorPort;
  settings: () => Settings;
  logger?: Logger;
  clock?: Clock;
  /** Seams in the write executor, for tests. */
  executorHooks?: ExecutorHooks;
}

export type ReviewEngine = ReviewService & {
  observer: TurnObserver;
  /** Every blob that review state, the log or the index points at: the root set for garbage collection. */
  referencedHashes(folderKey: FolderKey): Promise<Set<string>>;
  /** The caller tells the engine that review state changed behind its back (a restore, a recovery). */
  changed(folderKey: FolderKey): void;
};

interface Change {
  path: RelPath;
  before: FileState;
  after: FileState;
  /** Why the change is in the log although the write failed. */
  note?: string;
}

/** What one reject attempt comes to, before anything is written. */
type Prepared =
  | { kind: 'result'; result: RejectResult }
  | { kind: 'noop'; rebase: boolean }
  | { kind: 'write'; request: WriteRequest; rebase: boolean };

interface RunHandlers<T> {
  missing(): T;
  busy(folder: FolderWorkspace, fold: Fold): T | Promise<T>;
  failed(written: RelPath[]): T;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function refused(message: string): RejectResult {
  return { status: 'refused', message };
}

function failedAfterWriting(written: readonly RelPath[]): string {
  return `AgentCanopy changed ${written.join(', ')} but could not finish recording it. Reload the changes to see where things stand.`;
}

function appendRecord(folder: FolderWorkspace, record: LogRecord): Promise<void> {
  return folder.appendRecord(record);
}

class Engine implements ReviewService {
  readonly observer: TurnObserver;

  private readonly editor: EditorPort;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly listeners = new Set<(folderKey: FolderKey) => void>();
  private readonly cache = new Map<
    FolderKey,
    {
      count: number;
      first: LogRecord | undefined;
      last: LogRecord | undefined;
      fold: Promise<Fold>;
    }
  >();

  constructor(private readonly options: ReviewEngineOptions) {
    this.editor = options.editor ?? noEditor;
    this.logger = options.logger ?? silentLogger;
    this.clock = options.clock ?? systemClock;
    this.observer = {
      afterTurn: (context) => {
        // The cached fold is keyed by the number of log records, so it needs no eviction here.
        if (context.mode === 'agent') this.emit(context.folder.key);
        return Promise.resolve([]);
      },
    };
  }

  // --- plumbing -------------------------------------------------------------------------------

  private folder(key: FolderKey): FolderWorkspace | undefined {
    return this.options.tracker.folder(key);
  }

  private emit(key: FolderKey): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(key);
      } catch (error) {
        this.logger.warn('a review listener threw', { message: String(error) });
      }
    }
  }

  private invalidate(key: FolderKey): void {
    this.cache.delete(key);
    this.emit(key);
  }

  /**
   * The fold of the folder's log, computed now when the cached one is out of date. Computing it stores
   * blobs, so the caller must hold the folder's queue (or be sure the cache is current).
   */
  private fold(folder: FolderWorkspace): Promise<Fold> {
    const key = folder.info.key;
    const records = folder.log.records();
    const count = records.length;
    const hit = this.cache.get(key);
    if (hit !== undefined && this.isCurrent(hit, records)) return hit.fold;
    const fold = foldLog(records.slice(0, count), folder.blobs);
    this.cache.set(key, { count, first: records[0], last: records[count - 1], fold });
    fold.catch(() => {
      if (this.cache.get(key)?.fold === fold) this.cache.delete(key);
    });
    return fold;
  }

  /**
   * For readers outside the queue: the cached fold when it is current, otherwise one computed inside
   * the folder's queue, so that the blobs it stores are never written beside a garbage collection.
   */
  private readFold(folder: FolderWorkspace): Promise<Fold> {
    const hit = this.cache.get(folder.info.key);
    if (hit !== undefined && this.isCurrent(hit, folder.log.records())) return hit.fold;
    return folder.exclusive(() => this.fold(folder));
  }

  /**
   * The log only grows, except when retention rewrites it, which replaces every record object. So a
   * cached fold is current when the count and the first and last records are the same.
   */
  private isCurrent(
    hit: { count: number; first: LogRecord | undefined; last: LogRecord | undefined },
    records: readonly LogRecord[],
  ): boolean {
    return (
      hit.count === records.length &&
      hit.first === records[0] &&
      hit.last === records[records.length - 1]
    );
  }

  private executorContext(folder: FolderWorkspace): ExecutorContext {
    return { root: folder.info.path, blobs: folder.blobs, hooks: this.options.executorHooks };
  }

  private absolute(folder: FolderWorkspace, path: RelPath): string {
    return resolveInside(folder.info.path, path);
  }

  /**
   * Runs `work` on the folder, alone, and only while no agent turn is running. An unexpected error
   * becomes a plain refusal that names any path that was already written.
   */
  private async run<T>(
    key: FolderKey,
    handlers: RunHandlers<T>,
    work: (folder: FolderWorkspace, fold: Fold, written: RelPath[]) => Promise<T>,
  ): Promise<T> {
    const folder = this.folder(key);
    if (folder === undefined) return handlers.missing();
    const written: RelPath[] = [];
    try {
      return await folder.exclusive(async () => {
        const fold = await this.fold(folder);
        if (folder.busy()) return await handlers.busy(folder, fold);
        return await work(folder, fold, written);
      });
    } catch (error) {
      this.logger.error('review action failed', {
        folder: key,
        message: error instanceof Error ? error.message : String(error),
      });
      return handlers.failed(written);
    }
  }

  private runResult(
    key: FolderKey,
    work: (folder: FolderWorkspace, fold: Fold, written: RelPath[]) => Promise<RejectResult>,
  ): Promise<RejectResult> {
    return this.run<RejectResult>(
      key,
      {
        missing: () => refused(NOT_PENDING_MESSAGE),
        busy: () => refused(BUSY_MESSAGE),
        failed: (written) =>
          refused(written.length > 0 ? failedAfterWriting(written) : FAILED_MESSAGE),
      },
      work,
    );
  }

  private pending(fold: Fold, path: RelPath): ReviewEntry | undefined {
    const entry = fold.byPath.get(path);
    return entry?.status === 'pending' ? entry : undefined;
  }

  // --- reading --------------------------------------------------------------------------------

  changed(folderKey: FolderKey): void {
    this.emit(folderKey);
  }

  onDidChange(listener: (folderKey: FolderKey) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async entries(folderKey: FolderKey): Promise<ReviewEntry[]> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return [];
    try {
      return [...(await this.readFold(folder)).entries];
    } catch (error) {
      this.logger.error('could not work out the review state', {
        folder: folderKey,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  absolutePath(folderKey: FolderKey, path: RelPath): string | undefined {
    const folder = this.folder(folderKey);
    if (folder === undefined) return undefined;
    try {
      return resolveInside(folder.info.path, path);
    } catch {
      return undefined;
    }
  }

  async baselineContent(folderKey: FolderKey, path: RelPath): Promise<BaselineContent> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return { kind: 'unavailable' };
    const entry = (await this.readFold(folder)).byPath.get(path);
    if (entry === undefined) return { kind: 'unavailable' };
    const baseline = entry.baseline;
    if (baseline.kind === 'absent') return { kind: 'absent' };
    if (baseline.kind === 'symlink') {
      return { kind: 'content', data: Buffer.from(baseline.target, 'utf8'), binary: false };
    }
    const data = await readStoredBytes(folder.blobs, baseline);
    return data === undefined
      ? { kind: 'unavailable' }
      : { kind: 'content', data, binary: baseline.binary };
  }

  /** The lines of both sides, and the hunks between them, when the file can be reviewed hunk by hunk. */
  private async hunkView(
    folder: FolderWorkspace,
    entry: ReviewEntry,
    disk: DiskRead,
  ): Promise<
    { hunks: Hunk[]; baselineLines: string[]; currentLines: string[]; disk: DiskRead } | undefined
  > {
    let baselineLines: string[];
    let baselineHash: string;
    if (entry.baseline.kind === 'absent') {
      baselineLines = [];
      baselineHash = ABSENT_HASH;
    } else {
      const text = await readStoredText(folder.blobs, entry.baseline);
      if (
        text === undefined ||
        entry.baseline.kind !== 'file' ||
        entry.baseline.hash === undefined
      ) {
        return undefined;
      }
      baselineLines = splitLines(text);
      baselineHash = entry.baseline.hash;
    }
    let currentLines: string[];
    let currentHash: string;
    if (disk.kind === 'absent') {
      currentLines = [];
      currentHash = ABSENT_HASH;
    } else if (disk.kind === 'file' && disk.size <= MAX_TEXT_BYTES) {
      const text = decodeText(disk.data);
      if (text === undefined) return undefined;
      currentLines = splitLines(text);
      currentHash = disk.hash;
    } else {
      return undefined;
    }
    const hunks = computeHunksFromLines(
      baselineLines,
      currentLines,
      entry.path,
      baselineHash,
      currentHash,
    );
    return { hunks, baselineLines, currentLines, disk };
  }

  async hunks(folderKey: FolderKey, path: RelPath): Promise<Hunk[]> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return [];
    const entry = this.pending(await this.readFold(folder), path);
    if (entry === undefined) return [];
    const view = await this.hunkView(folder, entry, await readDisk(folder.info.path, path));
    return view?.hunks ?? [];
  }

  revertedSinceLastTurn(folderKey: FolderKey): Promise<RelPath[]> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return Promise.resolve([]);
    let paths = new Set<RelPath>();
    for (const record of folder.log.records()) {
      if (record.type !== 'operation') continue;
      if (record.kind === 'agent-turn') {
        paths = new Set();
      } else if (record.kind === 'reject' || record.kind === 'restore') {
        for (const change of record.changes) {
          if (!statesEqual(change.before, change.after)) paths.add(change.path);
        }
      }
    }
    return Promise.resolve([...paths].sort(compare));
  }

  /**
   * Called inside the folder's queue, as garbage collection must be. Throws when the folder is not
   * open: an empty root set would let the caller delete everything.
   */
  async referencedHashes(folderKey: FolderKey): Promise<Set<string>> {
    const folder = this.folder(folderKey);
    if (folder === undefined) throw new Error(NOT_OPEN_MESSAGE);
    const hashes = new Set<string>();
    const add = (state: FileState | undefined): void => {
      const hash = state === undefined ? undefined : hashOf(state);
      if (hash !== undefined) hashes.add(hash);
    };
    for (const record of folder.log.records()) {
      if (record.type === 'operation') {
        for (const change of record.changes) {
          add(change.before);
          add(change.after);
        }
        for (const kept of record.preserved) add(kept.state);
      } else if (record.type === 'foreign-delta') {
        for (const change of record.changes) {
          add(change.before);
          add(change.after);
        }
      } else {
        for (const item of record.accepted) add(item.baseline);
      }
    }
    for (const hash of (await this.fold(folder)).hashes) hashes.add(hash);
    for (const entry of folder.index().values()) {
      if (entry.hash !== undefined) hashes.add(entry.hash);
    }
    // Pending configuration changes keep both of their copies, so that they can still be reverted.
    for (const hash of await this.options.tracker.configBlobHashes(folderKey)) hashes.add(hash);
    // The tracker may have dropped the folder while we were reading: then this answer is partial.
    if (this.folder(folderKey) !== folder) throw new Error(NOT_OPEN_MESSAGE);
    return hashes;
  }

  // --- accepting ------------------------------------------------------------------------------

  async acceptFile(folderKey: FolderKey, path: RelPath): Promise<void> {
    await this.accept(folderKey, new Set([path]));
  }

  async acceptAll(folderKey: FolderKey, only?: readonly RelPath[]): Promise<void> {
    await this.accept(folderKey, only === undefined ? undefined : new Set(only));
  }

  /** Records that the file as it is on the disk now is accepted. Nothing in the workspace is written. */
  private async accept(folderKey: FolderKey, only: Set<RelPath> | undefined): Promise<void> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return;
    try {
      await folder.exclusive(async () => {
        if (folder.busy()) {
          this.logger.info('accept ignored: an agent turn is running', { folder: folderKey });
          return;
        }
        const fold = await this.fold(folder);
        const accepted: { path: RelPath; baseline: FileState; whole: boolean }[] = [];
        for (const entry of fold.entries) {
          if (entry.status !== 'pending') continue;
          if (only !== undefined && !only.has(entry.path)) continue;
          const state = await captureReadState(
            folder.blobs,
            await readDisk(folder.info.path, entry.path),
          );
          if (state === undefined) {
            this.logger.warn('accept skipped: the path is not a file, a link or absent', {
              folder: folderKey,
              path: entry.path,
            });
            continue;
          }
          accepted.push({ path: entry.path, baseline: state, whole: true });
        }
        if (accepted.length === 0) return;
        await appendRecord(folder, {
          type: 'review',
          id: newId<OperationId>(),
          at: this.clock.now(),
          accepted,
        });
        this.invalidate(folderKey);
      });
    } catch (error) {
      this.logger.error('accept failed', {
        folder: folderKey,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  acceptHunk(folderKey: FolderKey, path: RelPath, hunkId: string): Promise<RejectResult> {
    return this.runResult(folderKey, async (folder, fold) => {
      const entry = this.pending(fold, path);
      if (entry === undefined) return refused(NOT_PENDING_MESSAGE);
      const disk = await readDisk(folder.info.path, path);
      const view = await this.hunkView(folder, entry, disk);
      const hunk = view?.hunks.find((candidate) => candidate.id === hunkId);
      if (view === undefined || hunk === undefined) return refused(OUT_OF_DATE_MESSAGE);
      let lines: string[];
      try {
        lines = applyHunkToBaseline(view.baselineLines, hunk);
      } catch (error) {
        if (error instanceof StaleHunkError) return refused(OUT_OF_DATE_MESSAGE);
        throw error;
      }
      const data = Buffer.from(joinLines(lines), 'utf8');
      let baseline: FileState;
      let whole: boolean;
      if (disk.kind === 'absent' && data.length === 0) {
        // Every line the agent removed is accepted: the file stays gone.
        baseline = { kind: 'absent' };
        whole = true;
      } else {
        const hash = await folder.blobs.put(data);
        baseline = {
          kind: 'file',
          hash,
          size: data.length,
          mode:
            entry.baseline.kind === 'file'
              ? entry.baseline.mode
              : disk.kind === 'file'
                ? disk.mode
                : 0o644,
          stored: true,
          binary: false,
        };
        const onDisk = readToState(disk, true);
        whole = onDisk !== undefined && statesEqual(baseline, onDisk);
      }
      await appendRecord(folder, {
        type: 'review',
        id: newId<OperationId>(),
        at: this.clock.now(),
        accepted: [{ path, baseline, whole }],
      });
      this.invalidate(folderKey);
      return { status: 'done' };
    });
  }

  // --- rejecting ------------------------------------------------------------------------------

  /** What to write to put `baseline` back, or why that is not possible. */
  private async baselineTarget(
    folder: FolderWorkspace,
    baseline: FileState,
  ): Promise<WriteTarget | RejectResult> {
    if (baseline.kind === 'absent') return { kind: 'delete' };
    if (baseline.kind === 'symlink') return { kind: 'symlink', target: baseline.target };
    const data = await readStoredBytes(folder.blobs, baseline);
    if (data === undefined) return refused(BASELINE_GONE_MESSAGE);
    return { kind: 'file', data, mode: baseline.mode };
  }

  /** Whether the agent's change could be taken out of the file on disk by a merge. */
  private async canRevertAgentOnly(
    folder: FolderWorkspace,
    entry: ReviewEntry,
    disk: DiskRead,
  ): Promise<boolean> {
    if (disk.kind !== 'file' || disk.size > MAX_TEXT_BYTES || decodeText(disk.data) === undefined) {
      return false;
    }
    return (
      (await readStoredText(folder.blobs, entry.baseline)) !== undefined &&
      (await readStoredText(folder.blobs, entry.current)) !== undefined
    );
  }

  /** Decides one reject without writing anything. */
  private async prepareReject(
    folder: FolderWorkspace,
    entry: ReviewEntry,
    mode: RejectMode,
    disk: DiskRead,
    uncertain: boolean,
  ): Promise<Prepared> {
    const result = (value: RejectResult): Prepared => ({ kind: 'result', result: value });
    if (!entry.restorable) return result(refused(entry.note ?? NOT_RESTORABLE_NOTE));
    if (this.editor.isDirty(this.absolute(folder, entry.path))) {
      return result({ status: 'conflict', reason: 'unsaved-editor', canRevertAgentOnly: false });
    }
    const diskState = readToState(disk, false);
    // Already as it was before the agent: only the record is missing.
    if (diskState !== undefined && statesEqual(diskState, entry.baseline)) {
      return { kind: 'noop', rebase: false };
    }

    const target = await this.baselineTarget(folder, entry.baseline);
    if ('status' in target) return result(target);
    const write = (what: WriteTarget, rebase = false): Prepared => ({
      kind: 'write',
      request: { path: entry.path, target: what, observed: disk },
      rebase,
    });

    // An entry that may hold someone else's work is not "what the agent did": writing the baseline
    // could drop that work, so it needs an explicit choice even when the file is as it was left.
    if (!uncertain && diskState !== undefined && statesEqual(diskState, entry.current)) {
      return write(target);
    }

    if (mode === 'strict') {
      if (uncertain) {
        return result({
          status: 'conflict',
          reason: 'uncertain-source',
          canRevertAgentOnly: false,
        });
      }
      // The file is not what the agent left.
      return result({
        status: 'conflict',
        reason: 'changed-since',
        canRevertAgentOnly: await this.canRevertAgentOnly(folder, entry, disk),
      });
    }
    if (disk.kind === 'other') {
      return result(refused(disk.directory ? FOLDER_IN_THE_WAY_MESSAGE : OTHER_IN_THE_WAY_MESSAGE));
    }
    if (disk.kind === 'too-large') return result(refused(TOO_LARGE_MESSAGE));

    if (mode === 'overwrite') {
      // A deleted file's name may be taken over only if a regular file or nothing is there.
      if (entry.current.kind === 'absent' && disk.kind === 'symlink') {
        return result(refused(LINK_IN_THE_WAY_MESSAGE));
      }
      return write(target);
    }

    // agent-only: take the agent's change out of the file as it is now.
    if (uncertain) return result(refused(OVERLAP_MESSAGE));
    if (entry.baseline.kind !== 'file' || entry.current.kind !== 'file' || disk.kind !== 'file') {
      return result(refused(NOT_TEXT_MESSAGE));
    }
    const baselineText = await readStoredText(folder.blobs, entry.baseline);
    const currentText = await readStoredText(folder.blobs, entry.current);
    const diskText = disk.size <= MAX_TEXT_BYTES ? decodeText(disk.data) : undefined;
    if (baselineText === undefined || currentText === undefined || diskText === undefined) {
      return result(refused(NOT_TEXT_MESSAGE));
    }
    const merged = merge3(currentText, diskText, baselineText);
    if (merged === undefined) return result(refused(OVERLAP_MESSAGE));
    const data = Buffer.from(merged, 'utf8');
    const mergedMode = mergeMode(entry.current.mode, entry.baseline.mode, disk.mode);
    if (data.equals(disk.data) && mergedMode === disk.mode) return { kind: 'noop', rebase: true };
    return write({ kind: 'file', data, mode: mergedMode }, true);
  }

  /** Plans and makes one write. A write that changed the disk but failed is reported with its change. */
  private async execute(
    folder: FolderWorkspace,
    request: WriteRequest,
  ): Promise<{ ok: true; change: Change } | { ok: false; message: string; change?: Change }> {
    const context = this.executorContext(folder);
    const planned = await planWrite(context, request);
    if (!planned.ok) return { ok: false, message: planned.message };
    const outcome = await applyWrite(context, planned.plan);
    if (outcome.ok) {
      return {
        ok: true,
        change: { path: outcome.path, before: outcome.before, after: outcome.after },
      };
    }
    return outcome.changed
      ? {
          ok: false,
          message: outcome.message,
          change: {
            path: outcome.path,
            before: outcome.before,
            after: outcome.after,
            note: outcome.note,
          },
        }
      : { ok: false, message: outcome.message };
  }

  /**
   * Records what was written as one `reject` operation, then tells the tracker, so that its next
   * sync sees no foreign change. `rebase` lists paths whose review baseline must follow the file:
   * after the agent's part was taken out, what remains is the user's own. That record goes first. If
   * only it survives, the baseline equals the file and the entry closes by itself; the other order
   * would leave an entry that a plain reject could use to remove the user's edit.
   */
  private async recordRejection(
    folder: FolderWorkspace,
    changes: readonly Change[],
    rebase: readonly Change[] = [],
  ): Promise<void> {
    if (changes.length === 0) return;
    if (rebase.length > 0) {
      await appendRecord(folder, {
        type: 'review',
        id: newId<OperationId>(),
        at: this.clock.now(),
        accepted: rebase.map((change) => ({
          path: change.path,
          baseline: change.after,
          whole: false,
        })),
      });
    }
    await appendRecord(folder, {
      type: 'operation',
      id: newId<OperationId>(),
      kind: 'reject',
      at: this.clock.now(),
      status: 'complete',
      changes: changes.map(({ path, before, after, note }) => ({
        path,
        before,
        after,
        // Something else wrote the file while we did: those bytes are not the agent's.
        attribution: note === undefined ? ('agent-tool' as const) : ('external' as const),
      })),
      preserved: [],
      notes: [
        ...new Set(changes.flatMap((change) => (change.note === undefined ? [] : [change.note]))),
      ],
    });
    this.invalidate(folder.info.key);
    try {
      await folder.noteOwnWritesUnlocked(
        changes.map((change) => change.path),
        this.options.settings(),
      );
    } catch (error) {
      // The next sync will find the difference and log it; nothing is lost.
      this.logger.warn('could not tell the tracker about a reject', { message: String(error) });
    }
  }

  /**
   * Puts what is on the disk into the store and into the log (as a `preserved` state of an operation
   * that changes nothing), before the file is replaced. Garbage collection keeps preserved states.
   */
  private async preserve(folder: FolderWorkspace, path: RelPath, disk: DiskRead): Promise<void> {
    const state = await captureReadState(folder.blobs, disk);
    if (state === undefined || state.kind !== 'file') return;
    await appendRecord(folder, {
      type: 'operation',
      id: newId<OperationId>(),
      kind: 'reject',
      at: this.clock.now(),
      status: 'complete',
      changes: [],
      preserved: [{ path, state }],
      notes: [],
    });
  }

  /** The disk as it is, as a change that wrote nothing. */
  private async noChange(folder: FolderWorkspace, path: RelPath, disk: DiskRead): Promise<Change> {
    const state = await captureReadState(folder.blobs, disk);
    if (state === undefined) throw new Error('nothing to record');
    return { path, before: state, after: state };
  }

  rejectFile(folderKey: FolderKey, path: RelPath, mode: RejectMode): Promise<RejectResult> {
    return this.runResult(folderKey, async (folder, fold, written) => {
      const entry = this.pending(fold, path);
      if (entry === undefined) return refused(NOT_PENDING_MESSAGE);
      const disk = await readDisk(folder.info.path, path);
      const prepared = await this.prepareReject(
        folder,
        entry,
        mode,
        disk,
        this.holdsOthersEdits(fold, entry),
      );
      if (prepared.kind === 'result') return prepared.result;
      if (prepared.kind === 'noop') {
        const change = await this.noChange(folder, path, disk);
        await this.recordRejection(folder, [change], prepared.rebase ? [change] : []);
        return { status: 'done' };
      }
      // These two modes replace content that is not the agent's. Make sure it is referenced by the
      // log before anything is written, so that a failure after the write cannot orphan it.
      if (mode !== 'strict') await this.preserve(folder, path, disk);
      const run = await this.execute(folder, prepared.request);
      if (!run.ok) {
        if (run.change !== undefined) {
          written.push(path);
          await this.recordRejection(folder, [run.change]);
        }
        return refused(run.message);
      }
      written.push(path);
      await this.recordRejection(folder, [run.change], prepared.rebase ? [run.change] : []);
      return { status: 'done' };
    });
  }

  rejectHunk(folderKey: FolderKey, path: RelPath, hunkId: string): Promise<RejectResult> {
    return this.runResult(folderKey, async (folder, fold, written) => {
      const entry = this.pending(fold, path);
      if (entry === undefined) return refused(NOT_PENDING_MESSAGE);
      if (this.editor.isDirty(this.absolute(folder, path))) {
        return { status: 'conflict', reason: 'unsaved-editor', canRevertAgentOnly: false };
      }
      const disk = await readDisk(folder.info.path, path);
      const view = await this.hunkView(folder, entry, disk);
      const hunk = view?.hunks.find((candidate) => candidate.id === hunkId);
      if (view === undefined || hunk === undefined) return refused(OUT_OF_DATE_MESSAGE);
      // A hunk is the difference between the baseline and the file. If the file holds anything the
      // agent did not leave (an edit of the user's, not yet separated from the baseline), a hunk may
      // contain that edit, and rejecting it would drop it. Only a file as the agent left it is safe.
      // (A changed permission alone does not matter here: a hunk is about content.)
      const uncertain = this.holdsOthersEdits(fold, entry);
      if (uncertain) {
        return { status: 'conflict', reason: 'uncertain-source', canRevertAgentOnly: false };
      }
      const sameContent =
        (disk.kind === 'absent' && entry.current.kind === 'absent') ||
        (disk.kind === 'file' &&
          entry.current.kind === 'file' &&
          entry.current.hash !== undefined &&
          disk.hash === entry.current.hash);
      if (!sameContent) {
        return {
          status: 'conflict',
          reason: 'changed-since',
          canRevertAgentOnly: await this.canRevertAgentOnly(folder, entry, disk),
        };
      }
      let lines: string[];
      try {
        lines = revertHunkInCurrent(view.currentLines, hunk);
      } catch (error) {
        if (error instanceof StaleHunkError) return refused(OUT_OF_DATE_MESSAGE);
        throw error;
      }
      const data = Buffer.from(joinLines(lines), 'utf8');
      let target: WriteTarget;
      if (entry.baseline.kind === 'absent' && data.length === 0) {
        // Nothing of the created file is left once its last hunk is rejected.
        target = { kind: 'delete' };
      } else {
        const mode =
          disk.kind === 'file'
            ? disk.mode
            : entry.baseline.kind === 'file'
              ? entry.baseline.mode
              : 0o644;
        target = { kind: 'file', data, mode };
      }
      const run = await this.execute(folder, { path, target, observed: disk });
      if (!run.ok) {
        if (run.change !== undefined) {
          written.push(path);
          await this.recordRejection(folder, [run.change]);
        }
        return refused(run.message);
      }
      written.push(path);
      await this.recordRejection(folder, [run.change]);
      return { status: 'done' };
    });
  }

  // --- reject all -----------------------------------------------------------------------------

  /** Pending entries the agent made with certainty, plus the ones the user ticked. */
  private candidates(fold: Fold, includePaths: readonly RelPath[]): ReviewEntry[] {
    const include = new Set(includePaths);
    return fold.entries.filter(
      (entry) =>
        entry.status === 'pending' &&
        (entry.attribution === 'agent-tool' ||
          entry.attribution === 'agent-command' ||
          include.has(entry.path)),
    );
  }

  /**
   * How far the entry can be trusted to be the agent's work alone. `mixed` (and an entry whose
   * baseline could not absorb someone's edit) holds the user's work; `reconstructed` was worked out
   * after a crash; `unattributed` was seen outside any tool call. Anything but `sure` is put back only
   * by an explicit choice.
   */
  private sourceOf(
    fold: Fold,
    entry: ReviewEntry,
  ): 'sure' | 'unattributed' | 'mixed' | 'reconstructed' {
    if (fold.unmerged.has(entry.path) || entry.attribution === 'mixed') return 'mixed';
    if (
      entry.attribution === 'after-interruption' ||
      entry.operationIds.some((id) => fold.recoveryOperations.has(id))
    ) {
      return 'reconstructed';
    }
    return entry.attribution === 'unattributed' ? 'unattributed' : 'sure';
  }

  /**
   * Why Reject all leaves an entry alone however it got into the set. A ticked `unattributed` entry
   * is rejected: the user chose it, having seen its diff. The others need a choice of their own.
   */
  private blockedInRejectAll(fold: Fold, entry: ReviewEntry): string | undefined {
    const source = this.sourceOf(fold, entry);
    if (source === 'mixed') return MIXED_MESSAGE;
    if (source === 'reconstructed') return RECONSTRUCTED_MESSAGE;
    return undefined;
  }

  private holdsOthersEdits(fold: Fold, entry: ReviewEntry): boolean {
    return this.sourceOf(fold, entry) !== 'sure';
  }

  private describe(result: RejectResult): string {
    if (result.status === 'refused') return result.message;
    if (result.status === 'conflict') {
      return result.reason === 'unsaved-editor' ? UNSAVED_MESSAGE : CHANGED_SINCE_MESSAGE;
    }
    return '';
  }

  previewRejectAll(
    folderKey: FolderKey,
    includePaths: readonly RelPath[],
  ): Promise<RejectAllPreview> {
    const nothing = (): RejectAllPreview => ({ willReject: [], cannot: [] });
    return this.run<RejectAllPreview>(
      folderKey,
      {
        missing: nothing,
        // A running turn: say so for every candidate instead of an empty answer.
        busy: (_folder, fold) => ({
          willReject: [],
          cannot: this.candidates(fold, includePaths).map((entry) => ({
            path: entry.path,
            message: BUSY_MESSAGE,
          })),
        }),
        failed: nothing,
      },
      async (folder, fold) => {
        const preview = nothing();
        for (const entry of this.candidates(fold, includePaths)) {
          const blocked = this.blockedInRejectAll(fold, entry);
          if (blocked !== undefined) {
            preview.cannot.push({ path: entry.path, message: blocked });
            continue;
          }
          try {
            const prepared = await this.prepareReject(
              folder,
              entry,
              'strict',
              await readDisk(folder.info.path, entry.path),
              false,
            );
            if (prepared.kind === 'result') {
              preview.cannot.push({ path: entry.path, message: this.describe(prepared.result) });
            } else if (prepared.kind === 'noop') {
              preview.willReject.push(entry.path);
            } else {
              const planned = await planWrite(this.executorContext(folder), prepared.request);
              if (planned.ok) preview.willReject.push(entry.path);
              else preview.cannot.push({ path: entry.path, message: planned.message });
            }
          } catch (error) {
            this.logger.error('could not preview a reject', { message: String(error) });
            preview.cannot.push({ path: entry.path, message: FAILED_MESSAGE });
          }
        }
        return preview;
      },
    );
  }

  rejectAll(
    folderKey: FolderKey,
    includePaths: readonly RelPath[],
    only?: readonly RelPath[],
  ): Promise<RejectAllResult> {
    const allowed = only === undefined ? undefined : new Set(only);
    const wanted = (entry: ReviewEntry): boolean =>
      allowed === undefined || allowed.has(entry.path);
    return this.run<RejectAllResult>(
      folderKey,
      {
        missing: () => ({ rejected: [], failed: [] }),
        busy: (_folder, fold) => ({
          rejected: [],
          failed: this.candidates(fold, includePaths)
            .filter(wanted)
            .map((entry) => ({ path: entry.path, message: BUSY_MESSAGE })),
        }),
        failed: (written) => ({
          rejected: [],
          failed: written.map((path) => ({ path, message: failedAfterWriting(written) })),
        }),
      },
      async (folder, fold, written) => {
        const result: RejectAllResult = { rejected: [], failed: [] };
        const changes: Change[] = [];
        // Deletions of created files first, then path order.
        const order = this.candidates(fold, includePaths)
          .filter(wanted)
          .sort(
            (a, b) =>
              Number(b.baseline.kind === 'absent') - Number(a.baseline.kind === 'absent') ||
              compare(a.path, b.path),
          );
        for (const entry of order) {
          const blocked = this.blockedInRejectAll(fold, entry);
          if (blocked !== undefined) {
            result.failed.push({ path: entry.path, message: blocked });
            continue;
          }
          try {
            const disk = await readDisk(folder.info.path, entry.path);
            const prepared = await this.prepareReject(folder, entry, 'strict', disk, false);
            if (prepared.kind === 'result') {
              result.failed.push({ path: entry.path, message: this.describe(prepared.result) });
            } else if (prepared.kind === 'noop') {
              changes.push(await this.noChange(folder, entry.path, disk));
              result.rejected.push(entry.path);
            } else {
              const run = await this.execute(folder, prepared.request);
              if (run.ok) {
                written.push(entry.path);
                changes.push(run.change);
                result.rejected.push(entry.path);
              } else {
                if (run.change !== undefined) {
                  written.push(entry.path);
                  changes.push(run.change);
                }
                result.failed.push({ path: entry.path, message: run.message });
              }
            }
          } catch (error) {
            this.logger.error('could not reject a path', {
              path: entry.path,
              message: String(error),
            });
            result.failed.push({ path: entry.path, message: FAILED_MESSAGE });
          }
        }
        await this.recordRejection(folder, changes);
        return result;
      },
    );
  }
}

export function createReviewEngine(options: ReviewEngineOptions): ReviewEngine {
  const engine = new Engine(options);
  // Plain functions, so that a caller can pass any of them around without losing `this`.
  return {
    observer: engine.observer,
    entries: (folderKey) => engine.entries(folderKey),
    onDidChange: (listener) => engine.onDidChange(listener),
    hunks: (folderKey, path) => engine.hunks(folderKey, path),
    baselineContent: (folderKey, path) => engine.baselineContent(folderKey, path),
    acceptAll: (folderKey, only) => engine.acceptAll(folderKey, only),
    acceptFile: (folderKey, path) => engine.acceptFile(folderKey, path),
    acceptHunk: (folderKey, path, hunkId) => engine.acceptHunk(folderKey, path, hunkId),
    rejectFile: (folderKey, path, mode) => engine.rejectFile(folderKey, path, mode),
    rejectHunk: (folderKey, path, hunkId) => engine.rejectHunk(folderKey, path, hunkId),
    previewRejectAll: (folderKey, includePaths) => engine.previewRejectAll(folderKey, includePaths),
    rejectAll: (folderKey, includePaths, only) => engine.rejectAll(folderKey, includePaths, only),
    revertedSinceLastTurn: (folderKey) => engine.revertedSinceLastTurn(folderKey),
    absolutePath: (folderKey, path) => engine.absolutePath(folderKey, path),
    referencedHashes: (folderKey) => engine.referencedHashes(folderKey),
    changed: (folderKey) => engine.changed(folderKey),
  };
}
