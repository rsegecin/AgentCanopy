import type { Attachment, ConversationId, FolderKey, HostMessage, Settings } from '../../shared';
import type { HostToolServer } from './host-tools';
import type { TurnObserver, TurnPolicy } from './policy';
import type { Clock, EditorPort, Logger } from './ports';
import type { ProviderRegistry } from './provider';
import type { ReviewService } from './review';

export interface FolderInfo {
  key: FolderKey;
  name: string;
  /** Absolute path on the machine the extension host runs on. */
  path: string;
}

/** What the application reads from its surroundings. Every call returns the current value. */
export interface AppEnvironment {
  trusted(): boolean;
  folders(): FolderInfo[];
  settings(): Settings;
  /** Per-workspace private storage. Undefined when no folder is open; nothing runs then. */
  storageDir(): string | undefined;
  /** Storage shared by every window of this user, for locks that must span windows. */
  globalStorageDir(): string | undefined;
}

/** Things only the editor can do. Implemented by the VS Code layer, faked in tests. */
export interface UiPort {
  /** A native modal confirmation. Resolves false when dismissed. Used for high-impact approvals. */
  confirm(input: { title: string; detail: string; confirmLabel: string }): Promise<boolean>;
  /** Lets the user choose files or folders inside a folder. Returns paths relative to it. */
  pickPaths(input: { folder: FolderInfo; what: 'file' | 'folder' }): Promise<string[]>;
  /** The active editor's selection as an attachment, when it lies inside the folder and is not empty. */
  currentSelection(folder: FolderInfo): Attachment | undefined;
  /** Problems of the active editor's file as an attachment, when there are any. */
  currentDiagnostics(folder: FolderInfo): Attachment | undefined;
  openFile(absolutePath: string, line?: number): Promise<void>;
  /** Opens an http, https or mailto link after the editor's own confirmation. */
  openExternal(url: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  /**
   * Opens a terminal running the provider's own sign-in. AgentCanopy never sees credentials.
   * `command` is the provider's sign-in command as the provider reports it (its detected executable
   * and arguments); without it the terminal runs the provider's default command found on PATH.
   */
  startSignIn(providerId: string, command?: { executable: string; args: string[] }): void;
  openEditorPanel(conversationId?: ConversationId): void;
  /** Opens the native diff editor on two read-only texts (used to compare plan versions). */
  showDiff(input: {
    title: string;
    leftLabel: string;
    leftText: string;
    rightLabel: string;
    rightText: string;
  }): Promise<void>;
  /**
   * A native modal with several named choices. Resolves the chosen id, or undefined when dismissed.
   * Used where a wrong click could discard the user's work.
   */
  choose(input: {
    title: string;
    detail: string;
    options: { id: string; label: string }[];
  }): Promise<string | undefined>;
  /** Opens the native diff editor for one pending file: its review baseline against the file on disk. */
  openChangeDiff(folderKey: FolderKey, path: string): Promise<void>;
  /** Opens the native multi-file changes editor for every pending file of a folder. */
  openAllChanges(folderKey: FolderKey): Promise<void>;
  /** Opens a text as a new untitled document the user can save (used to export a plan). */
  showDocument(input: { text: string; language: string }): Promise<void>;
  showLogs(): void;
}

export interface ViewSink {
  post(message: HostMessage): void;
}

export interface ViewHandle {
  readonly id: string;
  /** A message from the webview. Untrusted: it is validated before anything acts on it. */
  receive(raw: unknown): void;
  dispose(): void;
}

export interface AppController {
  /** Loads stored conversations and detects the provider. Safe to call once. */
  start(): Promise<void>;
  attachView(
    kind: 'sidebar' | 'panel',
    sink: ViewSink,
    initial?: { conversationId?: ConversationId },
  ): ViewHandle;
  /** Trust, folders or settings changed: recompute and update every view. */
  environmentChanged(): void;
  refreshProvider(): Promise<void>;
  /** Starts a new conversation in the most recently used view and focuses its composer. */
  newConversation(): void;
  /** Queues an attachment for the next message of the most recently used view. */
  addAttachment(attachment: Attachment): void;
  /** Review of agent changes, once storage is available. Undefined before `start()` or without a folder. */
  review(): ReviewService | undefined;
  /**
   * Rejects one pending file with the full interactive flow (the same one the review panel uses):
   * strict first, then the native choice dialog when the file changed since the agent edited it.
   */
  rejectFileInteractive(folderKey: FolderKey, path: string): Promise<void>;
  /**
   * Deletes everything AgentCanopy stored about a folder's files: captured file contents, the change
   * log, pending reviews and checkpoints. Conversations and plans are kept. Asks in a native dialog
   * first. Refused while an agent turn runs in the folder or a configuration change awaits a decision.
   */
  purgeStoredFileData(folderKey: FolderKey): Promise<void>;
  /** Forgets the user's decision about the folder's project Claude Code configuration, so the next turn asks again. */
  resetProjectConfigDecision(folderKey: FolderKey): Promise<void>;
  /** "Reject all" with its preview and native confirmation, for the given folder. */
  rejectAllInteractive(folderKey: FolderKey, includePaths: readonly string[]): Promise<void>;
  /** Number of turns currently running, for the status bar. */
  runningTurns(): number;
  onDidChangeRunning(listener: () => void): () => void;
  /** Stops running turns, flushes storage, releases the tool server. */
  dispose(): Promise<void>;
}

/** Everything the application controller is built from. */
export interface AppDeps {
  env: AppEnvironment;
  ui: UiPort;
  providers: ProviderRegistry;
  hostTools: HostToolServer;
  logger: Logger;
  clock?: Clock;
  /** Defaults to the built-in policy of the current phase. */
  policy?: TurnPolicy;
  /** Called around every turn, in order. */
  observers?: TurnObserver[];
  /** What the editor knows about open files. Defaults to "nothing is open". */
  editor?: EditorPort;
}
