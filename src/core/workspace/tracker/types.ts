import type { LogRecord } from '../../contracts';
import type { BaselineStatus, ConfigChange, FolderKey, Settings } from '../../../shared';
import type { Clock, EditorPort, FolderInfo, Logger, TurnObserver } from '../../contracts';
import type { BlobStore, WorkspaceIndex, WorkspaceLog } from '../store';

export interface WorkspaceTrackerOptions {
  /** The extension's private storage. Each folder gets `<storageDir>/<folderKey>/`. */
  storageDir: string;
  editor?: EditorPort;
  logger?: Logger;
  clock?: Clock;
  /** Whether a process exists. Default: `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /**
   * Stops a process (and its commands) left over from an interrupted turn. Resolves true when it did
   * what it could. Without it, recovery never signals anything.
   */
  stopProcess?: (pid: number) => Promise<boolean>;
  /**
   * When the process started, as any stable string. Used to tell the recorded process from an
   * unrelated one that reuses its pid. Default: `ps -o lstart=` on macOS and Linux, nothing on Windows.
   */
  processStartTime?: (pid: number) => Promise<string | undefined>;
  /**
   * Where folder locks live, shared by every window of the user whatever its workspace storage is:
   * each lock is named by the first 32 hex characters of the sha256 of the folder's real path.
   * Without it the lock is kept in the folder's storage directory.
   */
  lockDir?: string;
  /** How often the holder of a lock proves it is alive, in milliseconds. Default 20,000. */
  lockHeartbeatMs?: number;
  /** A lock not refreshed for this long is stale, whatever its pid says. Default 90,000. */
  lockStaleMs?: number;
}

export interface FolderWorkspace {
  readonly info: FolderInfo;
  readonly blobs: BlobStore;
  readonly log: WorkspaceLog;
  index(): WorkspaceIndex;
  /**
   * Brings the index up to date with the disk and records foreign deltas for paths with history.
   * Does nothing while an agent turn is open or an interrupted one has not been recovered.
   */
  sync(settings: Settings, signal?: AbortSignal): Promise<void>;
  /**
   * Runs one piece of work at a time on this folder. Everything that reads-then-writes folder state
   * goes through it. It is not re-entrant: `sync` and `noteOwnWrites` queue like any other call, so
   * work that already holds the queue must use `syncUnlocked` and `noteOwnWritesUnlocked`.
   */
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  /** After AgentCanopy itself wrote these paths: re-read them into the index so they are not seen as foreign. */
  noteOwnWrites(paths: string[], settings: Settings): Promise<void>;
  /** `sync` for code that is already inside `exclusive`. */
  syncUnlocked(settings: Settings, signal?: AbortSignal): Promise<void>;
  /** `noteOwnWrites` for code that is already inside `exclusive`. */
  noteOwnWritesUnlocked(paths: string[], settings: Settings): Promise<void>;
  /**
   * Appends a record to the log and keeps the folder's own bookkeeping in step with it. Callers that
   * write records (the review engine, checkpoints) use this, not `log.append`, and call it inside `exclusive`.
   */
  appendRecord(record: LogRecord): Promise<void>;
  /**
   * Replaces the whole log with `records` (retention: the caller has checked that nothing the review
   * state needs is dropped) and rebuilds the folder's bookkeeping from it. Call inside `exclusive`.
   */
  rewriteLog(records: readonly LogRecord[]): Promise<void>;
  /** True while an agent turn is open, or an interrupted one has not been recovered. */
  busy(): boolean;
}

export interface WorkspaceTracker {
  readonly observer: TurnObserver;
  prewarm(folder: FolderInfo, settings: Settings): void;
  status(folderKey: FolderKey): BaselineStatus;
  onDidChangeStatus(listener: (folderKey: FolderKey) => void): () => void;
  /**
   * Puts right a turn that was cut off. `force` skips the check for a process that may still be
   * running. May be called again at any time for a folder that is still busy.
   */
  recover(
    folder: FolderInfo,
    settings: Settings,
    options?: { force?: boolean },
  ): Promise<{ recovered: boolean; notes: string[] }>;
  configChanges(folderKey: FolderKey): ConfigChange[];
  onDidChangeConfigChanges(listener: (folderKey: FolderKey) => void): () => void;
  resolveConfigChange(
    folderKey: FolderKey,
    changeId: string,
    action: 'keep' | 'revert',
  ): Promise<void>;
  /**
   * Deletes everything AgentCanopy captured about the folder: every blob, the log and the index.
   * Refused while a turn is running or a configuration change waits for a decision. The folder stays
   * open (and locked); the next `prewarm` or turn captures a fresh baseline. A folder with no stored
   * data resolves without doing anything.
   */
  purge(folderKey: FolderKey): Promise<void>;
  configChangeTexts(
    folderKey: FolderKey,
    changeId: string,
  ): Promise<{ before: string; after: string } | undefined>;
  /**
   * Hashes of the stored copies that configuration handling depends on, to be added to the root
   * set of a garbage collection: the before and after copies of every pending configuration change,
   * and what an open turn's configuration snapshot holds. Empty for an unknown folder.
   */
  configBlobHashes(folderKey: FolderKey): Promise<string[]>;
  folder(folderKey: FolderKey): FolderWorkspace | undefined;
  dispose(): Promise<void>;
}

export type { Clock };
