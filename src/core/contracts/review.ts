import type { FolderKey, Hunk, RelPath, ReviewEntry } from '../../shared';

/**
 * How to reject a file.
 * - `strict`: only when the file on disk is exactly what the agent left.
 * - `agent-only`: the file changed since; undo the agent's change and keep the later edits (3-way merge).
 * - `overwrite`: put the earlier version back whatever is on disk. The caller has confirmed this with the user.
 */
export type RejectMode = 'strict' | 'agent-only' | 'overwrite';

export type RejectResult =
  | { status: 'done' }
  /**
   * Nothing was written, because rejecting could discard work that is not the agent's:
   * - `changed-since`: the file is no longer what the agent left.
   * - `uncertain-source`: the entry itself may hold the user's work (both changed the file, the change
   *   was not made by a tool call, or it was reconstructed after an interrupted turn).
   * - `unsaved-editor`: the file has unsaved changes in an editor.
   */
  | {
      status: 'conflict';
      reason: 'changed-since' | 'uncertain-source' | 'unsaved-editor';
      /** Whether `agent-only` could be tried (both sides are text and the earlier content was kept). */
      canRevertAgentOnly: boolean;
    }
  /** It cannot be done at all; `message` says why in plain language. Nothing was written. */
  | { status: 'refused'; message: string };

export interface RejectAllPreview {
  willReject: RelPath[];
  cannot: { path: RelPath; message: string }[];
}

export interface RejectAllResult {
  rejected: RelPath[];
  failed: { path: RelPath; message: string }[];
}

export type BaselineContent =
  | { kind: 'absent' }
  | { kind: 'content'; data: Uint8Array; binary: boolean }
  /** The earlier content was not captured, so it cannot be shown or restored. */
  | { kind: 'unavailable' };

/**
 * Review of agent changes for one workspace folder: what is pending, and accepting or rejecting it.
 * Nothing here uses Git. Every method that writes refuses while an agent turn runs in the folder.
 */
export interface ReviewService {
  entries(folderKey: FolderKey): Promise<ReviewEntry[]>;
  onDidChange(listener: (folderKey: FolderKey) => void): () => void;
  /** Hunks between the review baseline and the file on disk now. Empty for binary files. */
  hunks(folderKey: FolderKey, path: RelPath): Promise<Hunk[]>;
  /** The review baseline of a path, for the left side of a diff. */
  baselineContent(folderKey: FolderKey, path: RelPath): Promise<BaselineContent>;
  /** Accepts every pending file, or with `only` the pending files among those paths, in one record. */
  acceptAll(folderKey: FolderKey, only?: readonly RelPath[]): Promise<void>;
  acceptFile(folderKey: FolderKey, path: RelPath): Promise<void>;
  acceptHunk(folderKey: FolderKey, path: RelPath, hunkId: string): Promise<RejectResult>;
  rejectFile(folderKey: FolderKey, path: RelPath, mode: RejectMode): Promise<RejectResult>;
  rejectHunk(folderKey: FolderKey, path: RelPath, hunkId: string): Promise<RejectResult>;
  /** What "Reject all" would do right now, so the user can be told before anything is written. */
  previewRejectAll(
    folderKey: FolderKey,
    includePaths: readonly RelPath[],
  ): Promise<RejectAllPreview>;
  /**
   * Rejects the default set plus `includePaths`. With `only`, nothing outside that list is touched:
   * the caller passes the paths a preview named, so the write matches what the user confirmed.
   */
  rejectAll(
    folderKey: FolderKey,
    includePaths: readonly RelPath[],
    only?: readonly RelPath[],
  ): Promise<RejectAllResult>;
  /** Paths AgentCanopy reverted since the last agent turn, so the agent can be told they changed. */
  revertedSinceLastTurn(folderKey: FolderKey): Promise<RelPath[]>;
  /** Absolute path of a folder-relative path, or undefined when the folder is not open. */
  absolutePath(folderKey: FolderKey, path: RelPath): string | undefined;
}
