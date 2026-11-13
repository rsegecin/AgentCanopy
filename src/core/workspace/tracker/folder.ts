import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  RelPathSchema,
  type BaselineStatus,
  type FileState,
  type OperationId,
  type RelPath,
  type Settings,
} from '../../../shared';
import type { LogRecord } from '../../contracts';
import type { Clock, FolderInfo, Logger } from '../../contracts';
import { ensurePrivateDir, writeFileAtomic } from '../../util/files';
import { newId } from '../../util/ids';
import {
  AbortError,
  createBlobStore,
  isManifestOrLockfile,
  loadIgnoreRules,
  loadIndex,
  openWorkspaceLog,
  refreshIndex,
  saveIndex,
  scanWorkspace,
  toFileState,
  toStatEntry,
  type BlobStore,
  type IgnoreRules,
  type RefreshResult,
  type ScanResult,
  type WorkspaceIndex,
  type WorkspaceLog,
} from '../store';
import { ExclusiveQueue } from './exclusive';
import { errorCode } from './fs-util';
import { readJournal } from './journal';
import { acquireLock } from './lock';
import { PresenceChecker, captureCurrentState } from './presence';
import type { TurnState } from './turn-state';
import type { FolderWorkspace } from './types';

export interface FolderDeps {
  storageDir: string;
  logger: Logger;
  clock: Clock;
  isProcessAlive: (pid: number) => boolean;
  /** Where lock files live, named by the folder's real path. Default: the folder's own storage directory. */
  lockDir?: string;
  lockHeartbeatMs?: number;
  lockStaleMs?: number;
  /** Called whenever the baseline status changes. */
  onStatus(folderKey: string): void;
}

/** The directory name for a folder key: the key itself when it is plain, else a hash of it. */
export function folderDirName(key: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) && !key.includes('..')
    ? key
    : createHash('sha256').update(key).digest('hex');
}

/** What a folder's storage remembers about where the folder is, so that it can be opened again by key. */
export async function readStoredFolderInfo(
  storageDir: string,
  key: string,
): Promise<FolderInfo | undefined> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(join(storageDir, folderDirName(key), 'folder.json'), 'utf8'),
    ) as Partial<FolderInfo>;
    if (parsed.key === key && typeof parsed.path === 'string' && parsed.path !== '') {
      return { key: parsed.key, name: parsed.name ?? '', path: parsed.path };
    }
  } catch {
    // Nothing stored.
  }
  return undefined;
}

async function rememberFolder(storageDir: string, info: FolderInfo): Promise<void> {
  const known = await readStoredFolderInfo(storageDir, info.key);
  if (known?.path === info.path && known.name === info.name) return;
  await writeFileAtomic(
    join(storageDir, folderDirName(info.key), 'folder.json'),
    JSON.stringify({ key: info.key, name: info.name, path: info.path }),
  );
}

export function fileStatesEqual(a: FileState, b: FileState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'absent') return true;
  if (a.kind === 'symlink') return b.kind === 'symlink' && a.target === b.target;
  if (b.kind !== 'file') return false;
  if (a.hash !== undefined && b.hash !== undefined) return a.hash === b.hash && a.mode === b.mode;
  return a.size === b.size && a.mode === b.mode;
}

export interface SyncOptions {
  settings: Settings;
  signal?: AbortSignal;
  recordForeign: boolean;
  forceRehash?: Set<RelPath>;
  /** Paths to store whatever the limits say (on top of manifests and lockfiles). */
  alwaysCapture?: Set<RelPath>;
  /** When false the caller commits the result itself. Default true. */
  commit?: boolean;
}

export interface SyncOutcome {
  scan: ScanResult;
  refresh: RefreshResult;
  rules: IgnoreRules;
  previous: WorkspaceIndex;
}

const BASELINE_IDLE: BaselineStatus = { state: 'idle', filesDone: 0, filesTotal: 0 };

/** One tracked workspace folder: its private directory, blobs, index, log and the turn that may be open. */
export class FolderState implements FolderWorkspace {
  readonly queue = new ExclusiveQueue();
  /** The open agent turn, if any. Set and cleared by the tracker. */
  turn: TurnState | undefined;
  /** True when a journal from a dead run exists and has not been recovered. */
  interrupted: boolean;
  status: BaselineStatus = BASELINE_IDLE;
  /** True while a background sync is queued or running. */
  prewarming = false;
  prewarmAbort: AbortController | undefined;

  private idx: WorkspaceIndex;
  /** Paths that appear in any operation or foreign-delta record. */
  private readonly history = new Set<string>();
  /** The `after` state of the latest record that mentions each path. */
  private readonly lastLogged = new Map<string, FileState>();

  private constructor(
    readonly info: FolderInfo,
    readonly dir: string,
    readonly realRoot: string,
    readonly blobs: BlobStore,
    readonly log: WorkspaceLog,
    index: WorkspaceIndex,
    interrupted: boolean,
    private readonly deps: FolderDeps,
    private readonly releaseLock: () => Promise<void>,
  ) {
    this.idx = index;
    this.interrupted = interrupted;
    for (const record of log.records()) this.noteRecord(record);
  }

  static async open(info: FolderInfo, deps: FolderDeps): Promise<FolderState> {
    const dir = join(deps.storageDir, folderDirName(info.key));
    await ensurePrivateDir(dir);
    const realRoot = await fs.realpath(info.path).catch(() => resolve(info.path));
    let lockFile = join(dir, 'lock');
    if (deps.lockDir !== undefined) {
      await ensurePrivateDir(deps.lockDir);
      const name = createHash('sha256').update(realRoot).digest('hex').slice(0, 32);
      lockFile = join(deps.lockDir, `${name}.lock`);
    }
    const release = await acquireLock(lockFile, {
      isProcessAlive: deps.isProcessAlive,
      now: () => deps.clock.now(),
      heartbeatMs: deps.lockHeartbeatMs,
      staleMs: deps.lockStaleMs,
    });
    try {
      await ensurePrivateDir(join(dir, 'blobs'));
      await ensurePrivateDir(join(dir, 'config'));
      await rememberFolder(deps.storageDir, info);
      const log = await openWorkspaceLog(join(dir, 'log.jsonl'));
      if (log.skipped > 0)
        deps.logger.warn('workspace log had unreadable lines', { skipped: log.skipped });
      const index = await loadIndex(join(dir, 'index.json'));
      const journal = await readJournal(join(dir, 'journal.json'));
      return new FolderState(
        info,
        dir,
        realRoot,
        createBlobStore(join(dir, 'blobs')),
        log,
        index,
        journal.kind !== 'none',
        deps,
        release,
      );
    } catch (error) {
      await release();
      throw error;
    }
  }

  get indexFile(): string {
    return join(this.dir, 'index.json');
  }
  get journalFile(): string {
    return join(this.dir, 'journal.json');
  }

  index(): WorkspaceIndex {
    return this.idx;
  }

  busy(): boolean {
    return this.turn !== undefined || this.interrupted;
  }

  exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.queue.run(work, signal);
  }

  hasHistory(path: string): boolean {
    return this.history.has(path);
  }

  lastLoggedAfter(path: string): FileState | undefined {
    return this.lastLogged.get(path);
  }

  async release(): Promise<void> {
    await this.releaseLock();
  }

  // --- status ---------------------------------------------------------------------------------

  setStatus(status: BaselineStatus): void {
    this.status = status;
    this.deps.onStatus(this.info.key);
  }

  // --- log ------------------------------------------------------------------------------------

  private noteRecord(record: LogRecord): void {
    if (record.type === 'review') return;
    for (const change of record.changes) {
      this.history.add(change.path);
      this.lastLogged.set(change.path, change.after);
    }
  }

  async appendRecord(record: LogRecord): Promise<void> {
    await this.log.append(record);
    this.noteRecord(record);
  }

  /**
   * Replaces the whole log (retention) and rebuilds what the folder keeps from it. Call inside `exclusive`.
   */
  async rewriteLog(records: readonly LogRecord[]): Promise<void> {
    await this.log.rewrite(records);
    this.history.clear();
    this.lastLogged.clear();
    for (const record of this.log.records()) this.noteRecord(record);
  }

  // --- sync -----------------------------------------------------------------------------------

  async sync(settings: Settings, signal?: AbortSignal): Promise<void> {
    await this.exclusive(() => this.syncUnlocked(settings, signal));
  }

  /** `sync` for code that already holds the exclusive queue. */
  async syncUnlocked(settings: Settings, signal?: AbortSignal): Promise<void> {
    if (this.busy()) {
      this.deps.logger.debug('sync skipped: a turn is open or unrecovered', {
        folder: this.info.key,
      });
      return;
    }
    await this.syncCore({ settings, signal, recordForeign: true });
  }

  /** Scan, refresh and (by default) record foreign deltas and save. Caller holds the exclusive lock. */
  async syncCore(options: SyncOptions): Promise<SyncOutcome> {
    const { settings, signal } = options;
    const before = this.status;
    const startingTotal = this.idx.size;
    this.setStatus({ state: 'capturing', filesDone: 0, filesTotal: startingTotal });
    try {
      const rules = await loadIgnoreRules(this.info.path, settings.snapshotExclude);
      const scan = await scanWorkspace(this.info.path, rules, {
        signal,
        onProgress: (seen) =>
          this.setStatus({
            state: 'capturing',
            filesDone: seen,
            filesTotal: Math.max(seen, startingTotal),
          }),
      });
      const previous = this.idx;
      const extra = options.alwaysCapture;
      const refresh = await refreshIndex({
        root: this.info.path,
        scan,
        previous,
        blobs: this.blobs,
        rules,
        mode: 'content',
        maxFileBytes: settings.snapshotMaxFileBytes,
        maxTotalBytes: settings.snapshotMaxTotalBytes,
        alwaysCapture: (path) => isManifestOrLockfile(path) || (extra?.has(path) ?? false),
        forceRehash: options.forceRehash,
        signal,
        onProgress: (done, total) =>
          this.setStatus({ state: 'capturing', filesDone: done, filesTotal: total }),
      });
      const outcome: SyncOutcome = { scan, refresh, rules, previous };
      if (options.commit !== false) {
        if (options.recordForeign) await this.recordForeignDeltas(outcome);
        await this.commitIndex(refresh.index);
      }
      this.setStatus(this.computeStatus(refresh.index, scan, rules));
      return outcome;
    } catch (error) {
      if (error instanceof AbortError) {
        this.setStatus(before);
      } else {
        this.deps.logger.error('workspace sync failed', {
          folder: this.info.key,
          message: error instanceof Error ? error.message : String(error),
        });
        this.setStatus({
          state: 'degraded',
          filesDone: 0,
          filesTotal: 0,
          note: 'AgentCanopy could not finish reading this folder, so some changes may not be undoable.',
        });
      }
      throw error;
    }
  }

  async commitIndex(index: WorkspaceIndex): Promise<void> {
    await saveIndex(this.indexFile, index);
    this.idx = index;
  }

  /** Refreshes the status after the caller changed the index itself (the end of a turn). */
  refreshStatus(outcome: SyncOutcome): void {
    this.setStatus(this.computeStatus(this.idx, outcome.scan, outcome.rules));
  }

  private computeStatus(
    index: WorkspaceIndex,
    scan: ScanResult,
    rules: IgnoreRules,
  ): BaselineStatus {
    let withoutContent = 0;
    for (const [path, entry] of index) {
      if (entry.kind === 'file' && !entry.stored && !rules.isSensitive(path)) withoutContent += 1;
    }
    const notes: string[] = [];
    if (scan.truncated) {
      notes.push(
        'This folder has more files than AgentCanopy tracks, so changes to some of them will not be seen.',
      );
    }
    if (withoutContent > 0) {
      notes.push(
        `${withoutContent} ${withoutContent === 1 ? 'file is' : 'files are'} tracked without their content, so changes a command makes to ${withoutContent === 1 ? 'it' : 'them'} can be detected but not undone.`,
      );
    }
    const total = index.size;
    return notes.length > 0
      ? { state: 'degraded', filesDone: total, filesTotal: total, note: notes.join(' ') }
      : { state: 'ready', filesDone: total, filesTotal: total };
  }

  /** One foreign-delta record for every path with history that changed since the last sync. */
  private async recordForeignDeltas(outcome: SyncOutcome): Promise<void> {
    const { refresh, previous } = outcome;
    const removed = new Set(refresh.removed);
    const candidates = [...refresh.changed, ...refresh.added, ...refresh.removed].filter((path) =>
      this.history.has(path),
    );
    const presence = new PresenceChecker(this.info.path);
    const changes: { path: RelPath; before: FileState; after: FileState }[] = [];
    for (const path of candidates) {
      if (!RelPathSchema.safeParse(path).success) continue;
      const before = toFileState(previous.get(path));
      let after = toFileState(refresh.index.get(path));
      // Gone from the index is not gone from the disk: it may only have become ignored.
      if (removed.has(path) && (await presence.isPresent(path))) {
        after = await captureCurrentState(this, path);
      }
      if (fileStatesEqual(before, after)) continue;
      changes.push({ path, before, after });
    }
    if (changes.length === 0) return;
    await this.appendRecord({
      type: 'foreign-delta',
      id: newId<OperationId>(),
      at: this.deps.clock.now(),
      changes,
    });
  }

  // --- own writes -----------------------------------------------------------------------------

  async noteOwnWrites(paths: string[], settings: Settings): Promise<void> {
    await this.exclusive(() => this.noteOwnWritesUnlocked(paths, settings));
  }

  /** `noteOwnWrites` for code that already holds the exclusive queue. */
  async noteOwnWritesUnlocked(paths: string[], settings: Settings): Promise<void> {
    {
      if (this.busy()) {
        this.deps.logger.warn('noteOwnWrites ignored: a turn is open or unrecovered', {
          folder: this.info.key,
        });
        return;
      }
      const rules = await loadIgnoreRules(this.info.path, settings.snapshotExclude);
      const entries = new Map<RelPath, ReturnType<typeof toStatEntry>>();
      const gone: RelPath[] = [];
      for (const raw of paths) {
        const rel = this.relativePath(raw);
        if (rel === undefined) continue;
        if (await isIgnoredDeep(rules, rel)) continue;
        try {
          const stats = await fs.lstat(join(this.info.path, ...rel.split('/')), { bigint: true });
          if (stats.isSymbolicLink()) {
            const target = await fs.readlink(join(this.info.path, ...rel.split('/')));
            entries.set(rel, toStatEntry(stats, 'symlink', target));
          } else if (stats.isFile()) {
            entries.set(rel, toStatEntry(stats, 'file'));
          } else {
            gone.push(rel);
          }
        } catch (error) {
          if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') gone.push(rel);
          else throw error;
        }
      }
      const wanted = new Set(entries.keys());
      const refresh = await refreshIndex({
        root: this.info.path,
        // "truncated" tells refresh that everything not listed is unknown rather than removed.
        scan: { entries, unreadable: [], truncated: true },
        previous: this.idx,
        blobs: this.blobs,
        rules,
        mode: 'content',
        maxFileBytes: settings.snapshotMaxFileBytes,
        maxTotalBytes: settings.snapshotMaxTotalBytes,
        alwaysCapture: (path) => wanted.has(path) || isManifestOrLockfile(path),
        forceRehash: wanted,
      });
      const next = new Map(refresh.index);
      for (const path of gone) next.delete(path);
      await this.commitIndex(next);
    }
  }

  /** Accepts a relative path or an absolute one inside the folder; anything else gives undefined. */
  relativePath(raw: string): RelPath | undefined {
    let rel = raw.replace(/\\/g, '/');
    for (const root of [this.info.path, this.realRoot]) {
      const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      if (rel.startsWith(prefix)) {
        rel = rel.slice(prefix.length);
        break;
      }
    }
    return RelPathSchema.safeParse(rel).success && !rel.endsWith('/') ? rel : undefined;
  }
}

/** True when the path, or any directory above it, is excluded. Loads nested ignore files on the way. */
export async function isIgnoredDeep(rules: IgnoreRules, rel: string): Promise<boolean> {
  const parts = rel.split('/');
  let dir = '';
  await rules.enterDirectory('');
  for (let i = 0; i < parts.length - 1; i += 1) {
    dir = dir === '' ? (parts[i] as string) : `${dir}/${parts[i] as string}`;
    if (rules.isIgnored(dir, true)) return true;
    await rules.enterDirectory(dir);
  }
  return rules.isIgnored(rel, false);
}
