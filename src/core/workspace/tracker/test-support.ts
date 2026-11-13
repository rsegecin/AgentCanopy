import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  type ConversationId,
  type ConversationMeta,
  type FolderKey,
  type Mode,
  type Settings,
  type TurnId,
  type TurnOutcome,
} from '../../../shared';
import type {
  Clock,
  EditorPort,
  FolderInfo,
  Logger,
  PermissionRequest,
  TurnContext,
  TurnNotice,
} from '../../contracts';
import type { LogRecord, OperationRecord } from '../../contracts';
import {
  createWorkspaceTracker,
  type FolderWorkspace,
  type WorkspaceTracker,
  type WorkspaceTrackerOptions,
} from './index';

/** Test support for the tracker. Not part of the public API. */

export const sha = (data: string | Buffer): string =>
  createHash('sha256').update(data).digest('hex');

export class FakeEditor implements EditorPort {
  private readonly listeners = new Set<(path: string) => void>();
  dirtyFiles(): string[] {
    return [];
  }
  isDirty(): boolean {
    return false;
  }
  onDidSave(listener: (absolutePath: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** The user saved this file. */
  save(absolutePath: string): void {
    for (const listener of [...this.listeners]) listener(absolutePath);
  }
}

export class FakeClock implements Clock {
  constructor(private time = Date.now()) {}
  now(): number {
    return this.time;
  }
  set(time: number): void {
    this.time = time;
  }
  advance(ms: number): void {
    this.time += ms;
  }
}

export class RecordingLogger implements Logger {
  readonly lines: { level: string; message: string }[] = [];
  debug(message: string): void {
    this.lines.push({ level: 'debug', message });
  }
  info(message: string): void {
    this.lines.push({ level: 'info', message });
  }
  warn(message: string): void {
    this.lines.push({ level: 'warn', message });
  }
  error(message: string): void {
    this.lines.push({ level: 'error', message });
  }
}

export interface Env {
  /** The extension's private storage. */
  storage: string;
  /** The workspace folder. */
  root: string;
  /** A directory that holds both, for tests that need siblings or parents. */
  base: string;
  folder: FolderInfo;
  settings: Settings;
  editor: FakeEditor;
  trackers: WorkspaceTracker[];
  tracker(options?: Partial<WorkspaceTrackerOptions>): WorkspaceTracker;
  /** Writes files below the folder: `{ 'a/b.txt': 'content' }`. */
  write(files: Record<string, string | Buffer>): Promise<void>;
  read(path: string): Promise<string>;
  abs(path: string): string;
  cleanup(): Promise<void>;
}

let counter = 0;

export async function makeEnv(
  options: { settings?: Partial<Settings>; folderSubdir?: string; key?: string } = {},
): Promise<Env> {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'agc-tracker-')));
  const storage = join(base, 'storage');
  const root = options.folderSubdir ? join(base, options.folderSubdir) : join(base, 'ws');
  await fs.mkdir(storage, { recursive: true });
  await fs.mkdir(root, { recursive: true });
  counter += 1;
  const key = (options.key ?? `folder-${counter}`) as FolderKey;
  const editor = new FakeEditor();
  const trackers: WorkspaceTracker[] = [];
  const env: Env = {
    storage,
    root,
    base,
    folder: { key, name: 'ws', path: root },
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    editor,
    trackers,
    tracker(extra = {}) {
      const tracker = createWorkspaceTracker({ storageDir: storage, editor, ...extra });
      trackers.push(tracker);
      return tracker;
    },
    async write(files) {
      for (const [path, content] of Object.entries(files)) {
        const abs = join(root, ...path.split('/'));
        await fs.mkdir(dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
    },
    read: (path) => fs.readFile(join(root, ...path.split('/')), 'utf8'),
    abs: (path) => join(root, ...path.split('/')),
    async cleanup() {
      for (const tracker of trackers) await tracker.dispose().catch(() => undefined);
      await fs.chmod(storage, 0o700).catch(() => undefined);
      await fs.rm(base, { recursive: true, force: true });
    },
  };
  return env;
}

export function conversation(env: Env, mode: Mode = 'agent'): ConversationMeta {
  return {
    id: 'conv-1' as ConversationId,
    title: 'Test',
    createdAt: 1,
    updatedAt: 1,
    folder: env.folder.key,
    providerId: 'claude',
    model: 'default',
    mode,
    planLocked: false,
  };
}

export function context(env: Env, turnId = 'turn-1', mode: Mode = 'agent'): TurnContext {
  return {
    conversation: conversation(env, mode),
    turnId: turnId as TurnId,
    mode,
    folder: env.folder,
    settings: env.settings,
  };
}

/** Opens the folder through the tracker and returns its workspace. */
export async function openWorkspace(tracker: WorkspaceTracker, env: Env): Promise<FolderWorkspace> {
  await tracker.recover(env.folder, env.settings);
  const ws = tracker.folder(env.folder.key);
  if (!ws) throw new Error('folder did not open');
  return ws;
}

export function operations(ws: FolderWorkspace): OperationRecord[] {
  return ws.log.records().filter((r): r is OperationRecord => r.type === 'operation');
}

export function recordsOf(ws: FolderWorkspace): LogRecord[] {
  return [...ws.log.records()];
}

let callCounter = 0;

/** Plays one agent turn the way the host drives it: hooks and permission requests around real writes. */
export class Turn {
  readonly ctx: TurnContext;
  readonly signal = new AbortController();
  private open = false;

  constructor(
    readonly tracker: WorkspaceTracker,
    readonly env: Env,
    turnId = `turn-${++callCounter}`,
  ) {
    this.ctx = context(env, turnId);
  }

  async begin(): Promise<void> {
    await this.tracker.observer.beforeTurn?.(this.ctx, this.signal.signal);
    this.open = true;
  }

  async end(outcome: TurnOutcome = 'completed'): Promise<TurnNotice[]> {
    const notices = (await this.tracker.observer.afterTurn?.(this.ctx, outcome)) ?? [];
    this.open = false;
    return notices;
  }

  get isOpen(): boolean {
    return this.open;
  }

  private nextId(): string {
    return `toolu_${++callCounter}`;
  }

  async permission(toolName: string, input: unknown, id = this.nextId()): Promise<void> {
    const request: PermissionRequest = {
      toolCallId: id,
      toolName,
      input: input as Record<string, unknown>,
      signal: new AbortController().signal,
    };
    await this.tracker.observer.onPermissionRequest?.(this.ctx, request);
  }

  async hook(
    phase: 'pre' | 'post',
    toolName: string,
    input: unknown,
    id: string,
    failed?: boolean,
  ): Promise<void> {
    await this.tracker.observer.onToolHook?.(this.ctx, {
      phase,
      toolCallId: id,
      toolName,
      input,
      ...(failed === undefined ? {} : { failed }),
    });
  }

  /** The tool result of a call, as the controller reports it. */
  result(id: string, executed: boolean, isError = false): void {
    this.tracker.observer.onToolResult?.(this.ctx, { toolCallId: id, executed, isError });
  }

  /**
   * A file tool, in the order the CLI uses: pre hook, permission request, the write, post hook, tool
   * result. `outcome` is `ran` (default), `denied` (no write, no post hook, a result that says it did
   * not run) or `failed` (the write may have happened but the tool reports failure).
   */
  async fileTool(
    toolName: 'Edit' | 'Write' | 'NotebookEdit',
    path: string,
    write: () => Promise<void>,
    options: {
      withPermission?: boolean;
      withHooks?: boolean;
      withResult?: boolean;
      outcome?: 'ran' | 'denied' | 'failed';
      id?: string;
    } = {},
  ): Promise<string> {
    const id = options.id ?? this.nextId();
    const input = toolName === 'NotebookEdit' ? { notebook_path: path } : { file_path: path };
    const hooks = options.withHooks !== false;
    const outcome = options.outcome ?? 'ran';
    if (hooks) await this.hook('pre', toolName, input, id);
    if (options.withPermission !== false) await this.permission(toolName, input, id);
    if (outcome === 'denied') {
      if (options.withResult !== false) this.result(id, false);
      return id;
    }
    await write();
    if (hooks)
      await this.hook('post', toolName, input, id, outcome === 'failed' ? true : undefined);
    if (options.withResult !== false) this.result(id, true, outcome === 'failed');
    return id;
  }

  /** A shell command: pre hook, whatever it does to the disk, post hook, tool result. */
  async command(
    run: () => Promise<void>,
    options: { withHooks?: boolean; withResult?: boolean; id?: string } = {},
  ): Promise<string> {
    const id = options.id ?? this.nextId();
    const input = { command: 'sh -c "..."' };
    if (options.withHooks !== false) await this.hook('pre', 'Bash', input, id);
    await run();
    if (options.withHooks !== false) await this.hook('post', 'Bash', input, id);
    if (options.withResult !== false) this.result(id, true);
    return id;
  }

  /** Writes a file through an Edit/Write file tool. */
  async edit(relPath: string, content: string | Buffer, tool: 'Edit' | 'Write' = 'Edit') {
    await this.fileTool(tool, this.env.abs(relPath), async () => {
      await fs.mkdir(dirname(this.env.abs(relPath)), { recursive: true });
      await fs.writeFile(this.env.abs(relPath), content);
    });
  }

  /** Writes files from a shell command. */
  async shellWrite(files: Record<string, string | Buffer>): Promise<void> {
    await this.command(() => this.env.write(files));
  }

  /** The user saves a file in the editor (the write and the save event). */
  async userSave(relPath: string, content: string | Buffer): Promise<void> {
    await this.env.write({ [relPath]: content });
    this.env.editor.save(this.env.abs(relPath));
    // The tracker reads the saved file a moment after the event; a person cannot save twice in that moment.
    await sleep(10);
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for a condition');
    await sleep(5);
  }
}
