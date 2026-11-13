import type {
  CheckpointSummary,
  FolderKey,
  OperationId,
  RelPath,
  RestoreOutcome,
  RestorePreview,
  Settings,
} from '../../shared';

/**
 * Checkpoints for one workspace folder: every recorded file operation is a point the files can be
 * taken back to. Restoring is itself a recorded operation, so it can be undone the same way.
 * Nothing here uses Git, and a restore never touches a path that no recorded operation changed.
 */
export interface CheckpointService {
  /** Recorded operations, newest first. `conversationTitle` is left for the caller to fill. */
  list(folderKey: FolderKey): Promise<CheckpointSummary[]>;
  onDidChange(listener: (folderKey: FolderKey) => void): () => void;
  /**
   * What restoring the files to their state before `operationId` would do. Nothing is written.
   * `refused` when it cannot be previewed at all (a turn is running, the operation is unknown).
   */
  preview(
    folderKey: FolderKey,
    operationId: OperationId,
  ): Promise<RestorePreview | { refused: string }>;
  /** Both sides of one previewed item as text, for a diff. Undefined when either side is not text or not kept. */
  itemTexts(
    folderKey: FolderKey,
    operationId: OperationId,
    token: string,
    path: RelPath,
  ): Promise<{ current: string; target: string } | undefined>;
  /**
   * Restores the given paths to their state before `operationId`. `token` must be the token of a
   * preview of that operation that still matches the folder's state (the plan is rebuilt and
   * compared); otherwise it is refused and the caller previews again. No preview is kept by the
   * service, so several views can each hold their own.
   */
  restore(
    folderKey: FolderKey,
    operationId: OperationId,
    token: string,
    paths: readonly RelPath[],
  ): Promise<RestoreOutcome | { refused: string }>;
  /** Drops operations older than the retention settings that no pending change still needs. */
  prune(folderKey: FolderKey, settings: Settings): Promise<{ removedRecords: number }>;
}
