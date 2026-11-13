import { promises as fs } from 'node:fs';
import type {
  Attribution,
  CheckpointSummary,
  FileState,
  FolderKey,
  OperationId,
  RelPath,
  RestoreOutcome,
  RestorePreview,
  Settings,
} from '../../../shared';
import {
  silentLogger,
  systemClock,
  noEditor,
  type CheckpointService,
  type Clock,
  type EditorPort,
  type Logger,
  type LogRecord,
} from '../../contracts';
import { newId } from '../../util/ids';
import { captureReadState, readDisk, type DiskRead } from '../review/disk';
import {
  FOLDER_IN_THE_WAY_MESSAGE,
  applyWrite,
  parentProblem,
  planWrite,
  type ExecutorContext,
  type ExecutorHooks,
  type WriteRequest,
  type WriteTarget,
} from '../review/executor';
import { foldLog, type Fold } from '../review/fold';
import { MAX_TEXT_BYTES, decodeText } from '../review/hunks';
import { readStoredBytes, statesEqual } from '../review/states';
import { resolveInside } from '../store';
import type { FolderWorkspace, WorkspaceTracker } from '../tracker';
import {
  NOT_CAPTURED_NOTE,
  buildPlan,
  listedOperations,
  summarize,
  type Plan,
  type PlanContext,
  type PlanItem,
} from './plan';
import { recordsToDrop } from './prune';

export const BUSY_MESSAGE = 'An agent turn is running in this folder. Wait for it to finish.';
export const NO_CHECKPOINT_MESSAGE = 'That checkpoint no longer exists.';
export const OUT_OF_DATE_MESSAGE = 'The preview is out of date. Open it again.';
export const NOT_SELECTABLE_MESSAGE =
  'One of the chosen files cannot be restored from this preview.';
export const FAILED_MESSAGE = 'AgentCanopy could not complete this. Nothing was changed.';

export interface CheckpointServiceOptions {
  tracker: WorkspaceTracker;
  editor?: EditorPort;
  settings: () => Settings;
  logger?: Logger;
  clock?: Clock;
  /** Called after a restore wrote something, so that the review list can refresh. */
  onDidRestore?: (folderKey: FolderKey) => void;
  /** Seams in the write executor, for tests. */
  executorHooks?: ExecutorHooks;
}

export type CheckpointServiceWithChanges = CheckpointService & {
  /** The caller tells the service that the log may have grown (after a turn, a reject). */
  changed(folderKey: FolderKey): void;
};

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function depth(path: string): number {
  return path.split('/').length;
}

function failureDetail(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'AgentCanopy could not write this file (permission denied).';
  }
  if (code === 'ENOSPC') return 'AgentCanopy could not write this file (the disk is full).';
  return 'AgentCanopy could not write this file.';
}

class Service {
  private readonly editor: EditorPort;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly listeners = new Set<(folderKey: FolderKey) => void>();

  constructor(private readonly options: CheckpointServiceOptions) {
    this.editor = options.editor ?? noEditor;
    this.logger = options.logger ?? silentLogger;
    this.clock = options.clock ?? systemClock;
  }

  private folder(key: FolderKey): FolderWorkspace | undefined {
    return this.options.tracker.folder(key);
  }

  private emit(key: FolderKey): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(key);
      } catch (error) {
        this.logger.warn('a checkpoint listener threw', { message: String(error) });
      }
    }
  }

  private planContext(folder: FolderWorkspace): PlanContext {
    return {
      folderKey: folder.info.key,
      folder,
      editor: this.editor,
      executor: this.executorContext(folder),
    };
  }

  private executorContext(folder: FolderWorkspace): ExecutorContext {
    return { root: folder.info.path, blobs: folder.blobs, hooks: this.options.executorHooks };
  }

  // --- reading --------------------------------------------------------------------------------

  changed(folderKey: FolderKey): void {
    this.emit(folderKey);
  }

  onDidChange(listener: (folderKey: FolderKey) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(folderKey: FolderKey): Promise<CheckpointSummary[]> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return Promise.resolve([]);
    return Promise.resolve(listedOperations(folder.log.records()).map(summarize).reverse());
  }

  async preview(
    folderKey: FolderKey,
    operationId: OperationId,
  ): Promise<RestorePreview | { refused: string }> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return { refused: NO_CHECKPOINT_MESSAGE };
    try {
      return await folder.exclusive(async () => {
        if (folder.busy()) return { refused: BUSY_MESSAGE };
        const plan = await buildPlan(this.planContext(folder), operationId);
        if (plan === undefined) return { refused: NO_CHECKPOINT_MESSAGE };
        return {
          token: plan.token,
          targetOperationId: operationId,
          affectedOperations: plan.affected,
          items: plan.items.map((entry) => entry.item),
          bytesNeeded: plan.bytesNeeded,
        };
      });
    } catch (error) {
      this.logger.error('checkpoint preview failed', { message: String(error) });
      return { refused: FAILED_MESSAGE };
    }
  }

  async itemTexts(
    folderKey: FolderKey,
    operationId: OperationId,
    token: string,
    path: RelPath,
  ): Promise<{ current: string; target: string } | undefined> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return undefined;
    try {
      return await folder.exclusive(async () => {
        if (folder.busy()) return undefined;
        const plan = await buildPlan(this.planContext(folder), operationId);
        if (plan === undefined || plan.token !== token) return undefined;
        const found = plan.items.find((entry) => entry.item.path === path);
        if (found === undefined) return undefined;
        const current = this.textOfDisk(found.disk);
        const target = await this.textOfTarget(folder, found.target);
        return current === undefined || target === undefined ? undefined : { current, target };
      });
    } catch (error) {
      this.logger.warn('checkpoint item texts failed', { message: String(error) });
      return undefined;
    }
  }

  private textOfDisk(disk: DiskRead): string | undefined {
    if (disk.kind === 'absent') return '';
    if (disk.kind !== 'file' || disk.size > MAX_TEXT_BYTES) return undefined;
    return decodeText(disk.data);
  }

  private async textOfTarget(
    folder: FolderWorkspace,
    target: FileState,
  ): Promise<string | undefined> {
    if (target.kind === 'absent') return '';
    if (target.kind !== 'file' || target.size > MAX_TEXT_BYTES) return undefined;
    const data = await readStoredBytes(folder.blobs, target);
    return data === undefined ? undefined : decodeText(data);
  }

  // --- restoring ------------------------------------------------------------------------------

  /** What to write to put `item` back, or the reason it cannot be done. */
  private async writeFor(
    folder: FolderWorkspace,
    entry: PlanItem,
    disk: DiskRead,
  ): Promise<WriteRequest | { failure: string }> {
    const { target } = entry;
    let what: WriteTarget;
    if (target.kind === 'absent') {
      what = { kind: 'delete' };
    } else if (target.kind === 'symlink') {
      what = { kind: 'symlink', target: target.target };
    } else {
      let data = await readStoredBytes(folder.blobs, target);
      // A change of permissions only: the content is what the file already holds.
      if (data === undefined && disk.kind === 'file' && disk.hash === target.hash) data = disk.data;
      if (data === undefined) return { failure: NOT_CAPTURED_NOTE };
      what = { kind: 'file', data, mode: target.mode };
    }
    return { path: entry.item.path, target: what, observed: disk };
  }

  async restore(
    folderKey: FolderKey,
    operationId: OperationId,
    token: string,
    paths: readonly RelPath[],
  ): Promise<RestoreOutcome | { refused: string }> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return { refused: OUT_OF_DATE_MESSAGE };
    const written: RelPath[] = [];
    try {
      return await folder.exclusive(async () => {
        if (folder.busy()) return { refused: BUSY_MESSAGE };
        // The log or the disk may have moved on since the preview was shown. Nothing is kept from
        // it: the plan is built again and must give the token the caller holds.
        const plan = await buildPlan(this.planContext(folder), operationId);
        if (plan === undefined || plan.token !== token) return { refused: OUT_OF_DATE_MESSAGE };
        return await this.apply(folder, plan, [...new Set(paths)], written);
      });
    } catch (error) {
      this.logger.error('checkpoint restore failed', {
        folder: folderKey,
        message: error instanceof Error ? error.message : String(error),
      });
      return {
        refused:
          written.length > 0
            ? `AgentCanopy restored ${written.join(', ')} but could not finish recording it. Reload the changes to see where things stand.`
            : FAILED_MESSAGE,
      };
    }
  }

  private async apply(
    folder: FolderWorkspace,
    plan: Plan,
    paths: RelPath[],
    written: RelPath[],
  ): Promise<RestoreOutcome | { refused: string }> {
    const byPath = new Map(plan.items.map((entry) => [entry.item.path, entry]));
    const chosen: PlanItem[] = [];
    for (const path of paths) {
      const entry = byPath.get(path);
      if (entry === undefined || !entry.item.selectable) return { refused: NOT_SELECTABLE_MESSAGE };
      chosen.push(entry);
    }
    // Items that wait for each other are restored together or not at all.
    const picked = new Set<string>(paths);
    for (const entry of chosen) {
      const missing = entry.ties.find((other) => !picked.has(other));
      if (missing !== undefined) {
        return { refused: `${entry.item.path} and ${missing} have to be restored together.` };
      }
    }
    // Deletions first, deepest paths first; then writes and permission changes.
    const deletions = chosen
      .filter((entry) => entry.item.action === 'delete')
      .sort((a, b) => depth(b.item.path) - depth(a.item.path) || compare(a.item.path, b.item.path));
    const others = chosen
      .filter((entry) => entry.item.action !== 'delete')
      .sort((a, b) => compare(a.item.path, b.item.path));

    const results = new Map<RelPath, { achieved: boolean; detail?: string }>();
    const changes: {
      path: RelPath;
      before: FileState;
      after: FileState;
      attribution: Attribution;
    }[] = [];
    const failures: string[] = [];
    const context = this.executorContext(folder);

    // What this restore is about to replace, and that is not what the log last recorded, is put in
    // the store and in the log first. If anything fails after the first write, it is still referenced.
    const preserved: { path: RelPath; state: FileState }[] = [];
    for (const entry of chosen) {
      if (entry.item.conflict === undefined || entry.disk.kind !== 'file') continue;
      const state = await captureReadState(folder.blobs, entry.disk);
      if (state !== undefined) preserved.push({ path: entry.item.path, state });
    }
    if (preserved.length > 0) {
      await folder.appendRecord({
        type: 'operation',
        id: newId<OperationId>(),
        kind: 'restore',
        at: this.clock.now(),
        status: 'complete',
        restoredTo: plan.operationId,
        changes: [],
        preserved,
        notes: [],
      });
    }

    for (const entry of [...deletions, ...others]) {
      const path = entry.item.path;
      const fail = (detail: string): void => {
        results.set(path, { achieved: false, detail });
        failures.push(`${path}: ${detail}`);
      };
      try {
        let observed = entry.disk;
        if (entry.reread) {
          // The deletions of this restore have been made: what is there now is what counts.
          observed = await readDisk(folder.info.path, path);
          if (observed.kind === 'other' && observed.directory) {
            const removed = await this.removeEmptyDirectory(folder, path);
            if (removed !== undefined) {
              fail(removed);
              continue;
            }
            observed = await readDisk(folder.info.path, path);
          }
        }
        const request = await this.writeFor(folder, entry, observed);
        if ('failure' in request) {
          fail(request.failure);
          continue;
        }
        const planned = await planWrite(context, request);
        if (!planned.ok) {
          fail(planned.message);
          continue;
        }
        const outcome = await applyWrite(context, planned.plan);
        if (outcome.ok) {
          results.set(path, { achieved: true });
          if (!statesEqual(outcome.before, outcome.after)) {
            changes.push({
              path,
              before: outcome.before,
              after: outcome.after,
              attribution: 'agent-tool',
            });
            written.push(path);
          }
        } else {
          if (outcome.changed) {
            // Something else wrote the file as we did: those bytes are not the agent's.
            changes.push({
              path,
              before: outcome.before,
              after: outcome.after,
              attribution: 'external',
            });
            written.push(path);
          }
          fail(outcome.message);
        }
      } catch (error) {
        this.logger.warn('a path could not be restored', { path, message: String(error) });
        fail(failureDetail(error));
      }
    }

    let operationId: OperationId | undefined;
    if (changes.length > 0) {
      operationId = newId<OperationId>();
      await folder.appendRecord({
        type: 'operation',
        id: operationId,
        kind: 'restore',
        at: this.clock.now(),
        status: 'complete',
        restoredTo: plan.operationId,
        changes,
        preserved: [],
        notes: failures,
      });
      try {
        await folder.noteOwnWritesUnlocked(
          changes.map((change) => change.path),
          this.options.settings(),
        );
      } catch (error) {
        // The next sync finds the difference and logs it; nothing is lost.
        this.logger.warn('could not tell the tracker about a restore', { message: String(error) });
      }
      this.emit(folder.info.key);
      this.options.onDidRestore?.(folder.info.key);
    }
    return {
      ...(operationId === undefined ? {} : { operationId }),
      items: paths.map((path) => ({ path, ...(results.get(path) ?? { achieved: false }) })),
    };
  }

  /**
   * A folder where a file has to be written, left empty by this restore's own deletions: remove it,
   * never recursively, so that a folder that holds anything is left alone. Returns the reason when not.
   */
  private async removeEmptyDirectory(
    folder: FolderWorkspace,
    path: RelPath,
  ): Promise<string | undefined> {
    const problem = await parentProblem(folder.info.path, path);
    if (problem !== undefined) return problem;
    try {
      await fs.rmdir(resolveInside(folder.info.path, path));
      return undefined;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') return FOLDER_IN_THE_WAY_MESSAGE;
      if (code === 'ENOENT') return undefined;
      return failureDetail(error);
    }
  }

  // --- retention ------------------------------------------------------------------------------

  async prune(folderKey: FolderKey, settings: Settings): Promise<{ removedRecords: number }> {
    const folder = this.folder(folderKey);
    if (folder === undefined) return { removedRecords: 0 };
    return await folder.exclusive(async () => {
      if (folder.busy()) return { removedRecords: 0 };
      const records = [...folder.log.records()];
      const before = await foldLog(records, folder.blobs);
      const wanted = recordsToDrop(records, before.entries, settings, this.clock.now());
      if (wanted <= 0) return { removedRecords: 0 };
      // The review state must come out exactly the same from what is kept. When it does not (a
      // change that was undone in a later turn, say), cut one operation earlier and try again.
      // Nothing is written until a cut matches.
      const cuts = [
        ...new Set(
          records.flatMap((record, index) =>
            record.type === 'operation' && index <= wanted ? [index] : [],
          ),
        ),
      ].sort((a, b) => b - a);
      let drop = 0;
      let kept: LogRecord[] = records;
      for (const cut of cuts) {
        if (cut <= 0) break;
        const candidate = records.slice(cut);
        const after = await foldLog(candidate, folder.blobs);
        if (sameReviewState(before, after)) {
          drop = cut;
          kept = candidate;
          break;
        }
      }
      if (drop <= 0) return { removedRecords: 0 };
      await folder.rewriteLog(kept);
      this.emit(folderKey);
      return { removedRecords: drop };
    });
  }
}

function sameReviewState(a: Fold, b: Fold): boolean {
  return (
    JSON.stringify(a.entries) === JSON.stringify(b.entries) &&
    JSON.stringify([...a.unmerged].sort()) === JSON.stringify([...b.unmerged].sort())
  );
}

export function createCheckpointService(
  options: CheckpointServiceOptions,
): CheckpointServiceWithChanges {
  const service = new Service(options);
  // Plain functions, so that a caller can pass any of them around without losing `this`.
  return {
    list: (folderKey) => service.list(folderKey),
    onDidChange: (listener) => service.onDidChange(listener),
    preview: (folderKey, operationId) => service.preview(folderKey, operationId),
    itemTexts: (folderKey, operationId, token, path) =>
      service.itemTexts(folderKey, operationId, token, path),
    restore: (folderKey, operationId, token, paths) =>
      service.restore(folderKey, operationId, token, paths),
    prune: (folderKey, settings) => service.prune(folderKey, settings),
    changed: (folderKey) => service.changed(folderKey),
  };
}
