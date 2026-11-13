import { execFile } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  ConversationIdSchema,
  RelPathSchema,
  TurnIdSchema,
  type Attribution,
  type BaselineStatus,
  type ConfigChange,
  type FileState,
  type FolderKey,
  type OperationId,
  type PathChange,
  type RelPath,
  type Settings,
} from '../../../shared';
import {
  systemClock,
  silentLogger,
  type Clock,
  type EditorPort,
  type FolderInfo,
  type Logger,
  type PermissionRequest,
  type ToolHookEvent,
  type TurnContext,
  type TurnNotice,
  type TurnObserver,
} from '../../contracts';
import { newId } from '../../util/ids';
import { AbortError, statChanged, toFileState, toStatEntry, type WorkspaceIndex } from '../store';
import { attribute, entryChanged } from './attribution';
import { callFor, captureForCall, scanForChanges } from './capture';
import {
  ConfigChangeList,
  configTexts,
  diffConfig,
  listWatched,
  revertConfigFile,
  snapshotConfig,
  toConfigChange,
  type WatchedFile,
} from './config-watch';
import {
  FolderState,
  fileStatesEqual,
  folderDirName,
  isIgnoredDeep,
  readStoredFolderInfo,
} from './folder';
import { findGit, gitStateChanged, readGitState, GIT_CHANGED_NOTE } from './git-state';
import { readJournal, removeJournal, writeJournal, type Journal } from './journal';
import { defaultIsProcessAlive } from './lock';
import { PresenceChecker, captureCurrentState } from './presence';
import { openCalls, type ToolCall, type TurnState } from './turn-state';
import type { FolderWorkspace, WorkspaceTracker, WorkspaceTrackerOptions } from './types';

const execFileAsync = promisify(execFile);

export const BUSY_MESSAGE =
  'Another agent turn is running in this folder. Stop it or wait for it to finish.';
export const CONFIG_PENDING_MESSAGE =
  'The last turn changed tool or editor configuration. Review those changes before starting another turn.';
export const RECORD_FAILED_MESSAGE =
  'AgentCanopy could not record what changed in this turn. Review the workspace before continuing.';
export const INTERRUPTED_NOTE =
  'AgentCanopy was closed while this turn was running, so it cannot tell which of these changes the agent made.';

export const PURGE_BUSY_MESSAGE = 'An agent turn is running in this folder. Wait for it to finish.';
export const PURGE_CONFIG_PENDING_MESSAGE =
  'A configuration change is waiting for your decision. Keep or revert it first.';

const JOURNAL_WRITE_INTERVAL_MS = 1000;
const STATUS_INTERVAL_MS = 100;
const AFTER_INTERRUPTION_SLACK_MS = 2000;

async function defaultProcessStartTime(pid: number): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      timeout: 2000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function listNames(names: string[], max: number): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

function stillRunningNote(pid: number): string {
  return `Claude Code from an interrupted turn is still running (process ${pid}). Stop it, then reload the window.`;
}

function mayStillBeRunningNote(pid: number): string {
  return `Claude Code from an interrupted turn may still be running (process ${pid}). Stop it, then choose Recover now.`;
}

function unrepresentableNote(paths: string[]): string {
  const n = paths.length;
  return `${n} changed ${n === 1 ? 'path has a name' : 'paths have names'} AgentCanopy cannot track: ${listNames(paths, 3)}.`;
}

async function canonicalRelativePath(ws: FolderState, abs: string): Promise<RelPath | undefined> {
  try {
    const real = await fs.realpath(abs);
    return ws.relativePath(real);
  } catch {
    return undefined;
  }
}

async function currentStat(ws: FolderState, rel: RelPath) {
  const abs = join(ws.info.path, ...rel.split('/'));
  try {
    const stats = await fs.lstat(abs, { bigint: true });
    return toStatEntry(stats, stats.isSymbolicLink() ? 'symlink' : 'file');
  } catch {
    return undefined;
  }
}

class Tracker implements WorkspaceTracker {
  readonly observer: TurnObserver;

  private readonly storageDir: string;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly stopProcess: ((pid: number) => Promise<boolean>) | undefined;
  private readonly processStartTime: (pid: number) => Promise<string | undefined>;
  private readonly lock: { dir?: string; heartbeatMs?: number; staleMs?: number };

  private readonly folders = new Map<FolderKey, FolderState>();
  private readonly opening = new Map<FolderKey, Promise<FolderState>>();
  private readonly configLists = new Map<FolderKey, ConfigChangeList>();
  private readonly statusListeners = new Set<(key: FolderKey) => void>();
  private readonly configListeners = new Set<(key: FolderKey) => void>();
  private readonly lastStatusEmit = new Map<FolderKey, number>();
  private readonly statusTimers = new Map<FolderKey, NodeJS.Timeout>();
  private readonly unsubscribeEditor: (() => void) | undefined;
  private disposed = false;

  constructor(options: WorkspaceTrackerOptions) {
    this.storageDir = options.storageDir;
    this.logger = options.logger ?? silentLogger;
    this.clock = options.clock ?? systemClock;
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.stopProcess = options.stopProcess;
    this.processStartTime = options.processStartTime ?? defaultProcessStartTime;
    this.lock = {
      dir: options.lockDir,
      heartbeatMs: options.lockHeartbeatMs,
      staleMs: options.lockStaleMs,
    };
    const editor: EditorPort | undefined = options.editor;
    this.unsubscribeEditor = editor?.onDidSave((path) => this.handleSave(path));

    this.observer = {
      beforeTurn: (context, signal) => this.beforeTurn(context, signal),
      afterTurn: (context) => this.afterTurn(context),
      wantsToolHooks: (context) => context.mode === 'agent',
      onProcessStarted: (context, pid) => this.onProcessStarted(context, pid),
      onPermissionRequest: (context, request) => this.onPermissionRequest(context, request),
      onToolHook: (context, event) => this.onToolHook(context, event),
      onToolResult: (context, result) => this.onToolResult(context, result),
    };
  }

  // --- folders --------------------------------------------------------------------------------

  private openFolder(info: FolderInfo): Promise<FolderState> {
    const existing = this.folders.get(info.key);
    if (existing) return Promise.resolve(existing);
    let pending = this.opening.get(info.key);
    if (!pending) {
      pending = FolderState.open(info, {
        storageDir: this.storageDir,
        logger: this.logger,
        clock: this.clock,
        isProcessAlive: this.isProcessAlive,
        lockDir: this.lock.dir,
        lockHeartbeatMs: this.lock.heartbeatMs,
        lockStaleMs: this.lock.staleMs,
        onStatus: (key) => this.notifyStatus(key as FolderKey),
      }).then(
        (folder) => {
          this.opening.delete(info.key);
          if (this.disposed) {
            void folder.release();
            throw new Error('The workspace tracker has been disposed.');
          }
          this.folders.set(info.key, folder);
          this.configListFor(info).adopt(info);
          return folder;
        },
        (error: unknown) => {
          this.opening.delete(info.key);
          throw error;
        },
      );
      this.opening.set(info.key, pending);
    }
    return pending;
  }

  private configListFor(info: { key: FolderKey; name: string; path: string }): ConfigChangeList {
    let list = this.configLists.get(info.key);
    if (!list) {
      const file = join(this.storageDir, folderDirName(info.key), 'config', 'changes.json');
      list = ConfigChangeList.loadSync(file, info, (path) => readFileSync(path, 'utf8'));
      this.configLists.set(info.key, list);
    }
    return list;
  }

  folder(folderKey: FolderKey): FolderWorkspace | undefined {
    return this.folders.get(folderKey);
  }

  // --- status ---------------------------------------------------------------------------------

  status(folderKey: FolderKey): BaselineStatus {
    return this.folders.get(folderKey)?.status ?? { state: 'idle', filesDone: 0, filesTotal: 0 };
  }

  onDidChangeStatus(listener: (folderKey: FolderKey) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** At most ten events a second per folder; the last change is always delivered. */
  private notifyStatus(key: FolderKey): void {
    if (this.statusTimers.has(key)) return;
    const now = Date.now();
    const wait = STATUS_INTERVAL_MS - (now - (this.lastStatusEmit.get(key) ?? 0));
    if (wait <= 0) {
      this.emitStatus(key);
      return;
    }
    const timer = setTimeout(() => {
      this.statusTimers.delete(key);
      this.emitStatus(key);
    }, wait);
    timer.unref();
    this.statusTimers.set(key, timer);
  }

  private emitStatus(key: FolderKey): void {
    this.lastStatusEmit.set(key, Date.now());
    for (const listener of [...this.statusListeners]) {
      try {
        listener(key);
      } catch (error) {
        this.logger.warn('status listener failed', { message: String(error) });
      }
    }
  }

  prewarm(folder: FolderInfo, settings: Settings): void {
    void (async () => {
      const ws = await this.openFolder(folder);
      if (ws.busy() || ws.prewarming) return;
      ws.prewarming = true;
      ws.prewarmAbort = new AbortController();
      try {
        await ws.sync(settings, ws.prewarmAbort.signal);
      } finally {
        ws.prewarming = false;
        ws.prewarmAbort = undefined;
      }
    })().catch((error: unknown) => {
      if (!(error instanceof AbortError)) {
        this.logger.warn('prewarm failed', {
          folder: folder.key,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  // --- editor ---------------------------------------------------------------------------------

  private handleSave(absolutePath: string): void {
    try {
      for (const ws of this.folders.values()) {
        const turn = ws.turn;
        if (!turn) continue;
        const rel = ws.relativePath(absolutePath);
        if (rel === undefined) continue;
        const record = { seq: (turn.seq += 1), hash: undefined as string | undefined };
        turn.userSaves.set(rel, record);
        // What was saved, so that the end of the turn can tell whether the file is still that. The
        // path is also filed under the name the filesystem really gives it, which can differ in case.
        turn.saveWork.push(
          (async () => {
            // The saved content is stored at once (whatever the limits say): the next write, by the
            // agent or the user, would otherwise leave no trace of it.
            const state = await captureCurrentState(ws, rel).catch(() => undefined);
            const hash = state?.kind === 'file' ? state.hash : undefined;
            if (state && state.kind !== 'absent') turn.userVersions.push({ path: rel, state });
            const canonical = await canonicalRelativePath(ws, absolutePath);
            if (canonical !== undefined && canonical !== rel) turn.userSaves.set(canonical, record);
            if (
              turn.userSaves.get(rel) === record ||
              turn.userSaves.get(canonical ?? rel) === record
            ) {
              record.hash = hash;
            }
          })(),
        );
      }
    } catch (error) {
      this.logger.warn('could not note an editor save', { message: String(error) });
    }
  }

  // --- the turn -------------------------------------------------------------------------------

  private async beforeTurn(context: TurnContext, signal: AbortSignal): Promise<void> {
    if (context.mode !== 'agent') return;
    const ws = await this.openFolder(context.folder);
    await ws.exclusive(async () => {
      if (ws.busy()) throw new Error(BUSY_MESSAGE);
      if (this.configListFor(context.folder).all().length > 0) {
        throw new Error(CONFIG_PENDING_MESSAGE);
      }
      if (signal.aborted) throw new AbortError();
      const sync = await ws.syncCore({
        settings: context.settings,
        signal,
        recordForeign: true,
      });
      if (signal.aborted) throw new AbortError();

      const baseline: WorkspaceIndex = new Map(ws.index());
      const git = await findGit(ws.info.path);
      const gitBefore = await readGitState(git);
      const watched = await listWatched(ws.info.path, git);
      const configBefore = await snapshotConfig(watched, ws.blobs);
      const now = this.clock.now();

      const turn: TurnState = {
        turnId: context.turnId,
        conversationId: context.conversation.id,
        startedAt: now,
        settings: context.settings,
        baseline,
        lastScan: new Map(baseline),
        rules: sync.rules,
        seq: 0,
        calls: new Map(),
        named: new Map(),
        preEdit: new Map(),
        windows: new Map(),
        gap: new Map(),
        windowsClosed: 0,
        hooksSeen: 0,
        permissionRequests: 0,
        userSaves: new Map(),
        userVersions: [],
        saveWork: [],
        git,
        gitBefore,
        configWatched: new Map(watched.map((w) => [w.abs, w])),
        configBefore,
        journal: {
          lastActivityAt: now,
          pid: null,
          lastWriteAt: Date.now(),
          chain: Promise.resolve(),
          closed: false,
        },
      };
      await writeJournal(ws.journalFile, this.journalOf(turn));
      ws.turn = turn;
    }, signal);
  }

  private journalOf(turn: TurnState): Journal {
    const journal: Journal = {
      turnId: turn.turnId,
      conversationId: turn.conversationId,
      startedAt: turn.startedAt,
      lastActivityAt: turn.journal.lastActivityAt,
      pid: turn.journal.pid,
    };
    if (turn.journal.processStart !== undefined) journal.processStart = turn.journal.processStart;
    return journal;
  }

  private writeJournalNow(ws: FolderState, turn: TurnState): void {
    const state = turn.journal;
    if (state.closed) return;
    state.lastWriteAt = Date.now();
    state.chain = state.chain
      .then(async () => {
        if (!state.closed) await writeJournal(ws.journalFile, this.journalOf(turn));
      })
      .catch((error: unknown) =>
        this.logger.warn('could not update the turn journal', { message: String(error) }),
      );
  }

  /** Records activity; the journal file is written at most once a second. */
  private touchJournal(ws: FolderState, turn: TurnState): void {
    const state = turn.journal;
    state.lastActivityAt = this.clock.now();
    if (state.closed || state.timer) return;
    const wait = JOURNAL_WRITE_INTERVAL_MS - (Date.now() - state.lastWriteAt);
    if (wait <= 0) {
      this.writeJournalNow(ws, turn);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.writeJournalNow(ws, turn);
    }, wait);
    state.timer.unref();
  }

  private currentTurn(context: TurnContext): { ws: FolderState; turn: TurnState } | undefined {
    if (context.mode !== 'agent') return undefined;
    const ws = this.folders.get(context.folder.key);
    const turn = ws?.turn;
    if (!ws || !turn || turn.turnId !== context.turnId) return undefined;
    return { ws, turn };
  }

  private onProcessStarted(context: TurnContext, pid: number): void {
    const found = this.currentTurn(context);
    if (!found) return;
    const { ws, turn } = found;
    // The pid and its start time go into the journal together, so a recorded pid can always be checked.
    turn.journal.pidWrite = (async () => {
      const start = await this.processStartTime(pid).catch(() => undefined);
      if (ws.turn !== turn || turn.journal.closed) return;
      turn.journal.pid = pid;
      if (start !== undefined) turn.journal.processStart = start;
      this.writeJournalNow(ws, turn);
    })().catch((error: unknown) =>
      this.logger.warn('could not record the process in the journal', { message: String(error) }),
    );
  }

  private async onPermissionRequest(
    context: TurnContext,
    request: PermissionRequest,
  ): Promise<void> {
    try {
      const found = this.currentTurn(context);
      if (!found) return;
      const { ws, turn } = found;
      await ws.exclusive(async () => {
        if (ws.turn !== turn) return;
        turn.permissionRequests += 1;
        this.touchJournal(ws, turn);
        const call = callFor(turn, request.toolCallId, request.toolName);
        // The request comes after the `pre` hook, so this capture is the closest to the write.
        if (call.fileTool) await captureForCall(ws, turn, call, request.input, this.logger);
      });
    } catch (error) {
      this.logger.warn('permission request not tracked', { message: String(error) });
    }
  }

  private async onToolHook(context: TurnContext, event: ToolHookEvent): Promise<void> {
    try {
      const found = this.currentTurn(context);
      if (!found) return;
      const { ws, turn } = found;
      await ws.exclusive(async () => {
        if (ws.turn !== turn) return;
        turn.hooksSeen += 1;
        this.touchJournal(ws, turn);
        const call = callFor(turn, event.toolCallId, event.toolName);
        if (event.phase === 'pre') {
          if (call.readOnly) return;
          // Changes since the last scan, with no tool running, were not made by a tool. This scan
          // comes before the capture, so a change the capture sees is already noted as outside.
          const noticed = new Set<RelPath>();
          if (openCalls(turn) === 0) {
            for (const path of await scanForChanges(ws, turn)) {
              turn.gap.set(path, (turn.seq += 1));
              noticed.add(path);
            }
          }
          if (call.fileTool) {
            await captureForCall(ws, turn, call, event.input, this.logger, noticed);
          }
          call.open = true;
          return;
        }
        call.open = false;
        if (call.readOnly) return;
        await this.scanWindow(ws, turn, call);
        if (event.failed === true) call.ran = false;
        else this.markRan(turn, event.toolCallId, call);
      });
    } catch (error) {
      this.logger.warn('tool hook not tracked', { tool: event.toolName, message: String(error) });
    }
  }

  /**
   * A tool result: the only signal that a denied call ended, and a backstop for a call whose `post`
   * hook never came. It closes the call's window and says whether the call ran.
   */
  private onToolResult(
    context: TurnContext,
    result: { toolCallId: string; executed: boolean; isError: boolean },
  ): void {
    const found = this.currentTurn(context);
    if (!found) return;
    const { ws, turn } = found;
    ws.exclusive(async () => {
      if (ws.turn !== turn) return;
      const call = turn.calls.get(result.toolCallId);
      if (!call) return;
      const wasOpen = call.open;
      call.open = false;
      if (!result.executed) {
        call.ran = false;
        return;
      }
      if (wasOpen && !call.readOnly) await this.scanWindow(ws, turn, call);
      if (result.isError) {
        if (call.ran === undefined) call.ran = false;
      } else {
        this.markRan(turn, result.toolCallId, call);
      }
    }).catch((error: unknown) =>
      this.logger.warn('tool result not tracked', { message: String(error) }),
    );
  }

  /** Closes a call's window with a scan and files each change under the right heading. */
  private async scanWindow(ws: FolderState, turn: TurnState, call: ToolCall): Promise<void> {
    turn.windowsClosed += 1;
    for (const path of await scanForChanges(ws, turn)) {
      if (!call.fileTool) {
        const window = turn.windows.get(path) ?? { tool: false, command: false };
        window.command = true;
        turn.windows.set(path, window);
      } else if (call.namedRel === path) {
        const window = turn.windows.get(path) ?? { tool: false, command: false };
        window.tool = true;
        turn.windows.set(path, window);
      } else {
        // A file tool changes the file it names and nothing else: this was someone else.
        turn.gap.set(path, (turn.seq += 1));
      }
    }
  }

  /**
   * A file tool call is known to have run: its path is now named, and the capture taken before it
   * becomes the turn's before-state of the path, unless the path was already written earlier.
   */
  private markRan(turn: TurnState, toolCallId: string, call: ToolCall): void {
    if (call.ran === true) return;
    call.ran = true;
    if (!call.fileTool || call.namedRel === undefined) return;
    const rel = call.namedRel;
    const ids = turn.named.get(rel);
    const capture = call.capture;
    if (capture && capture.state.kind !== 'absent') {
      // A capture that differs from what the turn knew of the path is someone else's version.
      const known = capture.intermediate
        ? undefined
        : (turn.preEdit.get(rel)?.state ?? toFileState(turn.baseline.get(rel)));
      if (known === undefined || !fileStatesEqual(known, capture.state)) {
        turn.userVersions.push({ path: rel, state: capture.state });
      }
    }
    if (ids) {
      ids.push(toolCallId);
      return;
    }
    if (capture && !capture.intermediate && !turn.windows.get(rel)?.command) {
      turn.preEdit.set(rel, capture);
    }
    turn.named.set(rel, [toolCallId]);
  }

  private async afterTurn(context: TurnContext): Promise<TurnNotice[]> {
    const found = this.currentTurn(context);
    if (!found) return [];
    const { ws, turn } = found;
    return ws.exclusive(() => this.finishTurn(ws, turn));
  }

  private async finishTurn(ws: FolderState, turn: TurnState): Promise<TurnNotice[]> {
    let indexWritten = false;
    try {
      await Promise.all(turn.saveWork);
      // If every window was closed we can tell what changed after the last tool; otherwise we cannot.
      const lateApplies = turn.windowsClosed > 0 && openCalls(turn) === 0;
      // Everything the agent touched is stored whatever the size and budget limits say. The one
      // exception is a sensitive file (.env, keys): the store hashes it and never keeps it, so the
      // after-state of an agent's edit to one cannot be restored. Its before-state can: that is
      // captured directly, before the edit, and is stored (mode 0600) like any other.
      const touched = new Set<RelPath>([
        ...turn.named.keys(),
        ...turn.windows.keys(),
        ...turn.gap.keys(),
      ]);
      const sync = await ws.syncCore({
        settings: turn.settings,
        recordForeign: false,
        forceRehash: touched,
        alwaysCapture: touched,
        commit: false,
      });
      const end = sync.refresh.index;
      const { changes, foreign, unrepresentable } = await this.computeChanges(
        ws,
        turn,
        end,
        lateApplies,
      );

      const preserved = this.preservedVersions(turn, end, changes, foreign);

      const notices: TurnNotice[] = [];
      const notes: string[] = [];
      const gitAfter = await readGitState(turn.git);
      if (gitStateChanged(turn.gitBefore, gitAfter)) {
        notes.push(GIT_CHANGED_NOTE);
        notices.push({ level: 'warning', text: GIT_CHANGED_NOTE });
      }
      const lost = changes
        .filter((c) => c.before.kind === 'file' && !c.before.stored)
        .map((c) => c.path);
      if (lost.length > 0) {
        const text = `${lost.length} changed ${lost.length === 1 ? 'file was' : 'files were'} too large or outside the capture budget, so their earlier content was not kept: ${listNames(lost, 3)}.`;
        notes.push(text);
        notices.push({ level: 'warning', text });
      }
      if (unrepresentable.length > 0) {
        const text = unrepresentableNote(unrepresentable);
        notes.push(text);
        notices.push({ level: 'warning', text });
      }

      // The log first, then the index: a crash in between repeats work instead of losing it. What
      // someone else changed before the agent wrote a path comes first, so that the operation that
      // follows starts from it.
      if (foreign.length > 0) {
        await ws.appendRecord({
          type: 'foreign-delta',
          id: newId<OperationId>(),
          at: this.clock.now(),
          changes: foreign,
        });
      }
      // With no change there is nothing to keep these against: the file on disk is the user's own latest.
      if (changes.length > 0) {
        await ws.appendRecord({
          type: 'operation',
          id: newId<OperationId>(),
          kind: 'agent-turn',
          at: this.clock.now(),
          conversationId: turn.conversationId,
          turnId: turn.turnId,
          status: 'complete',
          changes,
          preserved,
          notes,
        });
      }
      await ws.commitIndex(end);
      indexWritten = true;

      const configNotice = await this.compareConfig(ws, turn);
      if (configNotice) notices.push(configNotice);
      return notices;
    } catch (error) {
      this.logger.error('could not record the turn', {
        folder: ws.info.key,
        message: error instanceof Error ? error.message : String(error),
      });
      return [{ level: 'error', text: RECORD_FAILED_MESSAGE }];
    } finally {
      // Without a saved index the journal stays, so that recovery works out the turn.
      await this.closeTurn(ws, turn, { keepJournal: !indexWritten });
    }
  }

  /**
   * The versions someone else produced during the turn that no record of the turn already holds: not
   * the `after` of a foreign delta, nor the before or after of a change. They go into the
   * operation's `preserved` list so that their content is kept. Versions that equal what B or the
   * end of the turn says of the path are not preserved: the index holds those.
   */
  private preservedVersions(
    turn: TurnState,
    end: WorkspaceIndex,
    changes: PathChange[],
    foreign: { path: RelPath; before: FileState; after: FileState }[],
  ): { path: RelPath; state: FileState }[] {
    const key = (path: string, state: FileState): string =>
      `${path}\0${state.kind === 'file' ? (state.hash ?? `size:${state.size}`) : state.kind === 'symlink' ? `->${state.target}` : 'absent'}`;
    const held = new Set<string>();
    for (const change of foreign) held.add(key(change.path, change.after));
    for (const change of changes) {
      held.add(key(change.path, change.before));
      held.add(key(change.path, change.after));
    }
    const out: { path: RelPath; state: FileState }[] = [];
    for (const { path, state } of turn.userVersions) {
      if (!RelPathSchema.safeParse(path).success) continue;
      if (state.kind === 'file' && state.hash === undefined) continue; // too large to have been kept
      const k = key(path, state);
      if (held.has(k)) continue;
      if (fileStatesEqual(toFileState(turn.baseline.get(path)), state)) continue;
      if (fileStatesEqual(toFileState(end.get(path)), state)) continue;
      held.add(k);
      out.push({ path, state });
    }
    return out;
  }

  private async closeTurn(
    ws: FolderState,
    turn: TurnState,
    options: { keepJournal: boolean },
  ): Promise<void> {
    const state = turn.journal;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    try {
      await state.pidWrite;
      state.closed = true;
      await state.chain;
      if (options.keepJournal) {
        // Make sure there is one to find, even if the first write never happened.
        await writeJournal(ws.journalFile, this.journalOf(turn));
        ws.interrupted = true;
      } else {
        await removeJournal(ws.journalFile);
      }
    } catch (error) {
      this.logger.warn('could not finish the turn journal', { message: String(error) });
      if (options.keepJournal) ws.interrupted = true;
    } finally {
      state.closed = true;
      if (ws.turn === turn) ws.turn = undefined;
    }
  }

  private async computeChanges(
    ws: FolderState,
    turn: TurnState,
    end: WorkspaceIndex,
    lateApplies: boolean,
  ): Promise<{
    changes: PathChange[];
    foreign: { path: RelPath; before: FileState; after: FileState }[];
    unrepresentable: string[];
  }> {
    const hooksMissing = turn.hooksSeen === 0 && turn.permissionRequests > 0;
    const presence = new PresenceChecker(ws.info.path);
    const changes: PathChange[] = [];
    const unrepresentable: string[] = [];

    const candidates = new Set<RelPath>(turn.preEdit.keys());
    for (const path of new Set([...turn.baseline.keys(), ...end.keys()])) {
      if (entryChanged(turn.baseline.get(path), end.get(path))) candidates.add(path);
    }
    for (const path of [...candidates].sort()) {
      if (!RelPathSchema.safeParse(path).success) {
        unrepresentable.push(path);
        continue;
      }
      const entry = end.get(path);
      const pre = turn.preEdit.get(path);
      const before = pre ? pre.state : toFileState(turn.baseline.get(path));
      let after = toFileState(entry);
      let present = entry !== undefined;
      // Gone from the index is not gone from the disk: it may only have become ignored.
      if (entry === undefined && (await presence.isPresent(path))) {
        after = await captureCurrentState(ws, path);
        present = true;
      }
      if (fileStatesEqual(before, after)) continue;

      let late = false;
      if (lateApplies) {
        const last = turn.lastScan.get(path);
        if (entry) late = last === undefined || statChanged(last, entry);
        else if (!present) late = last !== undefined;
        else {
          const now = await currentStat(ws, path);
          late = last !== undefined && now !== undefined && statChanged(last, now);
        }
      }
      changes.push({
        path,
        before,
        after,
        attribution: attribute(turn, {
          path,
          finalHash: after.kind === 'file' ? after.hash : undefined,
          late,
          hooksMissing,
        }),
      });
    }

    // Someone else changed a path before the agent's file tool wrote it: that is a change of its
    // own, and the operation above starts from it.
    const foreign: { path: RelPath; before: FileState; after: FileState }[] = [];
    for (const [path, pre] of [...turn.preEdit].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const b = turn.baseline.get(path);
      const before = toFileState(b);
      if (fileStatesEqual(before, pre.state)) continue;
      if (b === undefined && (await isIgnoredDeep(turn.rules, path))) continue;
      foreign.push({ path, before, after: pre.state });
    }
    return { changes, foreign, unrepresentable };
  }

  // --- configuration tripwire -----------------------------------------------------------------

  private async compareConfig(ws: FolderState, turn: TurnState): Promise<TurnNotice | undefined> {
    // Look for Git again: a repository made during the turn brings its hooks and config with it.
    const gitNow = (await findGit(ws.info.path)) ?? turn.git;
    const watchedNow = await listWatched(ws.info.path, gitNow);
    const union = new Map<string, WatchedFile>(turn.configWatched);
    for (const file of watchedNow) if (!union.has(file.abs)) union.set(file.abs, file);
    const after = await snapshotConfig([...union.values()], ws.blobs);
    const records = diffConfig(turn.configBefore, after, union, this.clock.now());
    if (records.length === 0) return undefined;
    const list = this.configListFor(ws.info);
    await list.add(records);
    this.fireConfigChanged(ws.info.key);
    return {
      level: 'warning',
      text: `This turn changed tool or editor configuration (${listNames(
        records.map((r) => r.displayPath),
        5,
      )}). Review it before the next turn: such files can make later commands run without asking.`,
    };
  }

  private fireConfigChanged(key: FolderKey): void {
    for (const listener of [...this.configListeners]) {
      try {
        listener(key);
      } catch (error) {
        this.logger.warn('config listener failed', { message: String(error) });
      }
    }
  }

  configChanges(folderKey: FolderKey): ConfigChange[] {
    const known = this.folders.get(folderKey)?.info;
    const list = this.configListFor(known ?? { key: folderKey, name: '', path: '' });
    return list.all().map(toConfigChange);
  }

  onDidChangeConfigChanges(listener: (folderKey: FolderKey) => void): () => void {
    this.configListeners.add(listener);
    return () => this.configListeners.delete(listener);
  }

  /** The workspace folder for a key, opened from what the change list remembers when needed. */
  private async folderForConfig(folderKey: FolderKey): Promise<FolderState | undefined> {
    const open = this.folders.get(folderKey);
    if (open) return open;
    const info = this.configListFor({ key: folderKey, name: '', path: '' }).folderInfo;
    if (info.path === '') return undefined;
    return this.openFolder({ key: folderKey, name: info.name, path: info.path });
  }

  async resolveConfigChange(
    folderKey: FolderKey,
    changeId: string,
    action: 'keep' | 'revert',
  ): Promise<void> {
    const list = this.configListFor({ key: folderKey, name: '', path: '' });
    const record = list.find(changeId);
    if (!record) return;
    if (action === 'keep') {
      await list.remove(changeId);
      this.fireConfigChanged(folderKey);
      return;
    }
    const ws = await this.folderForConfig(folderKey);
    if (!ws) throw new Error('This folder is not open, so the file cannot be reverted.');
    await ws.exclusive(async () => {
      await revertConfigFile(record, ws.blobs);
      await list.remove(changeId);
    });
    this.fireConfigChanged(folderKey);
  }

  async purge(folderKey: FolderKey): Promise<void> {
    let ws = this.folders.get(folderKey);
    if (!ws) {
      // Not opened in this session: open it from what its storage remembers, if it has any.
      const info =
        (await readStoredFolderInfo(this.storageDir, folderKey)) ??
        (() => {
          const known = this.configListFor({ key: folderKey, name: '', path: '' }).folderInfo;
          return known.path === ''
            ? undefined
            : { key: folderKey, name: known.name, path: known.path };
        })();
      if (!info) return;
      ws = await this.openFolder(info);
    }
    const folder = ws;
    await folder.exclusive(async () => {
      if (folder.busy()) throw new Error(PURGE_BUSY_MESSAGE);
      if (this.configListFor(folder.info).all().length > 0) {
        throw new Error(PURGE_CONFIG_PENDING_MESSAGE);
      }
      // The log and the index first: a crash half way leaves empty records, never records that
      // point at blobs that are gone.
      await folder.rewriteLog([]);
      await folder.commitIndex(new Map());
      await fs.rm(join(folder.dir, 'blobs'), { recursive: true, force: true });
      await fs.mkdir(join(folder.dir, 'blobs'), { recursive: true, mode: 0o700 });
      await removeJournal(folder.journalFile);
      folder.setStatus({ state: 'idle', filesDone: 0, filesTotal: 0 });
      this.fireConfigChanged(folderKey);
    });
  }

  configBlobHashes(folderKey: FolderKey): Promise<string[]> {
    const hashes = new Set<string>();
    const add = (state: { stored: boolean; hash?: string }): void => {
      if (state.stored && state.hash !== undefined) hashes.add(state.hash);
    };
    for (const record of this.configListFor({ key: folderKey, name: '', path: '' }).all()) {
      add(record.before);
      add(record.after);
    }
    // The snapshot taken at the start of a turn is needed until the end of the turn compares it.
    const turn = this.folders.get(folderKey)?.turn;
    if (turn) for (const state of turn.configBefore.values()) add(state);
    return Promise.resolve([...hashes].sort());
  }

  async configChangeTexts(
    folderKey: FolderKey,
    changeId: string,
  ): Promise<{ before: string; after: string } | undefined> {
    const record = this.configListFor({ key: folderKey, name: '', path: '' }).find(changeId);
    if (!record) return undefined;
    const ws = await this.folderForConfig(folderKey);
    if (!ws) return undefined;
    return configTexts(record, ws.blobs);
  }

  // --- recovery -------------------------------------------------------------------------------

  async recover(
    folder: FolderInfo,
    settings: Settings,
    options: { force?: boolean } = {},
  ): Promise<{ recovered: boolean; notes: string[] }> {
    const ws = await this.openFolder(folder);
    return ws.exclusive(async () => {
      if (ws.turn) return { recovered: false, notes: [] };
      const read = await readJournal(ws.journalFile);
      if (read.kind === 'none') {
        ws.interrupted = false;
        return { recovered: false, notes: [] };
      }
      const journal = read.kind === 'ok' ? read.journal : undefined;

      if (!options.force && journal?.pid != null && this.isProcessAlive(journal.pid)) {
        const start = await this.processStartTime(journal.pid).catch(() => undefined);
        // Without both start times there is no telling the recorded process from another one.
        if (journal.processStart === undefined || start === undefined) {
          return { recovered: false, notes: [mayStillBeRunningNote(journal.pid)] };
        }
        if (start === journal.processStart) {
          if (this.stopProcess) {
            await this.stopProcess(journal.pid).catch((error: unknown) =>
              this.logger.warn('could not stop the interrupted process', {
                message: String(error),
              }),
            );
          }
          if (this.isProcessAlive(journal.pid)) {
            return { recovered: false, notes: [stillRunningNote(journal.pid)] };
          }
        }
      }

      const sync = await ws.syncCore({ settings, recordForeign: false, commit: false });
      const { refresh, previous } = sync;
      const threshold = journal ? journal.lastActivityAt + AFTER_INTERRUPTION_SLACK_MS : Infinity;
      const presence = new PresenceChecker(ws.info.path);
      const changes: PathChange[] = [];
      const unrepresentable: string[] = [];
      const candidates = [...refresh.changed, ...refresh.added, ...refresh.removed].sort();
      for (const path of candidates) {
        if (!RelPathSchema.safeParse(path).success) {
          unrepresentable.push(path);
          continue;
        }
        const entry = refresh.index.get(path);
        const before = toFileState(previous.get(path));
        let after = toFileState(entry);
        if (entry === undefined && (await presence.isPresent(path))) {
          after = await captureCurrentState(ws, path);
        }
        if (fileStatesEqual(before, after)) continue;
        // Already in the log: the operation was written but the run died before saving the index.
        const logged = ws.lastLoggedAfter(path);
        if (logged && fileStatesEqual(logged, after) && !fileStatesEqual(logged, before)) continue;
        let attribution: Attribution = 'unattributed';
        if (entry !== undefined) {
          const touchedMs = Number(
            (entry.mtimeNs > entry.ctimeNs ? entry.mtimeNs : entry.ctimeNs) / 1_000_000n,
          );
          if (touchedMs > threshold) attribution = 'after-interruption';
        }
        changes.push({ path, before, after, attribution });
      }

      const notes: string[] = [];
      if (changes.length > 0) notes.push(INTERRUPTED_NOTE);
      if (unrepresentable.length > 0) notes.push(unrepresentableNote(unrepresentable));
      if (changes.length > 0) {
        const turnId = TurnIdSchema.safeParse(journal?.turnId);
        const conversationId = ConversationIdSchema.safeParse(journal?.conversationId);
        await ws.appendRecord({
          type: 'operation',
          id: newId<OperationId>(),
          kind: 'recovery',
          at: this.clock.now(),
          ...(conversationId.success ? { conversationId: conversationId.data } : {}),
          ...(turnId.success ? { turnId: turnId.data } : {}),
          status: 'interrupted',
          changes,
          preserved: [],
          notes,
        });
      }
      await ws.commitIndex(refresh.index);
      await removeJournal(ws.journalFile);
      ws.interrupted = false;
      return { recovered: true, notes };
    });
  }

  // --- shutdown -------------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeEditor?.();
    for (const timer of this.statusTimers.values()) clearTimeout(timer);
    this.statusTimers.clear();
    this.statusListeners.clear();
    this.configListeners.clear();
    const pending = await Promise.allSettled([...this.opening.values()]);
    void pending;
    for (const ws of this.folders.values()) {
      ws.prewarmAbort?.abort();
      const turn = ws.turn;
      if (turn) {
        // Left in place: a journal that stays behind is how the next run knows this turn was cut off.
        // What is still waiting to be written (the process id, the last activity) is written first.
        await Promise.race([
          turn.journal.pidWrite,
          new Promise((resolve) => setTimeout(resolve, 3000).unref()),
        ]);
        if (turn.journal.timer) {
          clearTimeout(turn.journal.timer);
          turn.journal.timer = undefined;
          this.writeJournalNow(ws, turn);
        }
        await turn.journal.chain.catch(() => undefined);
        turn.journal.closed = true;
      }
      await Promise.race([
        ws.queue.idle(),
        new Promise((resolve) => setTimeout(resolve, 3000).unref()),
      ]);
      await ws.release().catch(() => undefined);
    }
    this.folders.clear();
  }
}

export function createWorkspaceTracker(options: WorkspaceTrackerOptions): WorkspaceTracker {
  return new Tracker(options);
}
