import type { ConversationId, FileState, RelPath, Settings, TurnId } from '../../../shared';
import type { IgnoreRules, StatEntry, WorkspaceIndex } from '../store';
import type { ConfigSnapshot, WatchedFile } from './config-watch';
import type { GitLocation, GitState } from './git-state';

/** The tools that write a named file. Their path is in `file_path` (`notebook_path` for notebooks). */
export const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Tools that cannot change the workspace; no scan after them. */
export const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'ToolSearch',
]);

/** One tool call of the turn, tracked by its id. */
export interface ToolCall {
  name: string;
  fileTool: boolean;
  readOnly: boolean;
  /** Between its `pre` hook and its end (a `post` hook, a tool result, or the end of the turn). */
  open: boolean;
  /** Whether the call is known to have run: true after a successful `post` or result, false when denied or failed. */
  ran: boolean | undefined;
  /** The folder-relative path this file tool named, when it named one inside the folder. */
  namedRel?: RelPath;
  abs?: string;
  /** The path as it was just before this call, taken at its last permission request or `pre` hook. */
  capture?: { state: FileState; seq: number; intermediate?: boolean };
}

export interface SaveRecord {
  seq: number;
  /** sha256 of the file when it was saved; undefined until read, or when it could not be read. */
  hash: string | undefined;
}

export interface JournalState {
  lastActivityAt: number;
  pid: number | null;
  processStart?: string;
  lastWriteAt: number;
  timer?: NodeJS.Timeout;
  /** Serializes journal writes. */
  chain: Promise<void>;
  /** The write of the process id, which waits for the start-time lookup. */
  pidWrite?: Promise<void>;
  /** Set once the turn is over: no further writes. */
  closed: boolean;
}

/** Everything the tracker remembers about the one open agent turn of a folder. */
export interface TurnState {
  turnId: TurnId;
  conversationId: ConversationId;
  startedAt: number;
  settings: Settings;
  /** B: the index as it was when the turn began. */
  baseline: WorkspaceIndex;
  /** The stat of every tracked path at the last scan of this turn. */
  lastScan: Map<RelPath, StatEntry>;
  rules: IgnoreRules;
  /** Orders events: captures, saves, gap changes. */
  seq: number;
  calls: Map<string, ToolCall>;
  /**
   * Paths written by a file tool that is known to have run, with the call ids. A request that was
   * denied, failed or never finished names nothing.
   */
  named: Map<RelPath, string[]>;
  /**
   * The state of a path just before the first file tool that ran wrote it, when B does not already
   * say. It can differ from B: someone else changed the path earlier in the turn.
   */
  preEdit: Map<RelPath, { state: FileState; seq: number }>;
  /** Paths seen to change inside a tool window (`command`: not a file tool's own path). */
  windows: Map<RelPath, { tool: boolean; command: boolean }>;
  /** Paths seen to change while no tool of ours was responsible, with when it was noticed. */
  gap: Map<RelPath, number>;
  /** How many windows were closed by a scan (a `post` hook or a tool result). */
  windowsClosed: number;
  hooksSeen: number;
  permissionRequests: number;
  /** Paths the user saved in an editor during the turn. */
  userSaves: Map<RelPath, SaveRecord>;
  /**
   * Versions of paths that someone other than the agent produced during the turn: each editor save
   * (stored when it happens) and each capture, before a file tool that ran, that differs from what
   * the turn knew. Kept in the operation's `preserved` list unless a record already holds them.
   */
  userVersions: { path: RelPath; state: FileState }[];
  /** Reads of saved files that are still running. */
  saveWork: Promise<void>[];
  git?: GitLocation;
  gitBefore?: GitState;
  configWatched: Map<string, WatchedFile>;
  configBefore: ConfigSnapshot;
  journal: JournalState;
}

export function openCalls(turn: TurnState): number {
  let count = 0;
  for (const call of turn.calls.values()) if (call.open && !call.readOnly) count += 1;
  return count;
}
