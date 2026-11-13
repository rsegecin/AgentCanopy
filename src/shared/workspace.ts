import * as z from 'zod';
import {
  ConversationIdSchema,
  OperationIdSchema,
  RelPathSchema,
  TimestampSchema,
  TurnIdSchema,
} from './ids';

/** The state of one path at one moment. "Absent" and "empty file" are different states. */
export const FileStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('absent') }),
  z.object({
    kind: z.literal('file'),
    /** sha256 of the content, hex. Absent when the file was tracked by stat only. */
    hash: z.string().optional(),
    size: z.number().int().nonnegative(),
    /** POSIX permission bits; 0 on platforms without them. */
    mode: z.number().int().nonnegative(),
    /** True when the content is in the blob store, so this state can be restored. */
    stored: z.boolean(),
    binary: z.boolean(),
  }),
  z.object({ kind: z.literal('symlink'), target: z.string() }),
]);
export type FileState = z.infer<typeof FileStateSchema>;

/**
 * Why we believe a change happened. Only `agent-tool` and `agent-command` are reverted by "Reject all"
 * without the user ticking the entry.
 */
export const AttributionSchema = z.enum([
  'agent-tool',
  'agent-command',
  'unattributed',
  'user',
  'mixed',
  'external',
  'after-interruption',
]);
export type Attribution = z.infer<typeof AttributionSchema>;

export const ChangeTypeSchema = z.enum(['created', 'modified', 'deleted', 'mode', 'type']);
export type ChangeType = z.infer<typeof ChangeTypeSchema>;

export const PathChangeSchema = z.object({
  path: RelPathSchema,
  before: FileStateSchema,
  after: FileStateSchema,
  attribution: AttributionSchema,
});
export type PathChange = z.infer<typeof PathChangeSchema>;

export const ReviewStatusSchema = z.enum(['pending', 'accepted']);

/** One file in the review set, as shown to the user. Derived from the workspace log. */
export const ReviewEntrySchema = z.object({
  path: RelPathSchema,
  changeType: ChangeTypeSchema,
  attribution: AttributionSchema,
  status: ReviewStatusSchema,
  /** The state "Reject" returns the path to. */
  baseline: FileStateSchema,
  /** The state after the last operation that touched the path. */
  current: FileStateSchema,
  /** False when rejecting cannot bring the baseline back (content was not captured). */
  restorable: z.boolean(),
  /** Plain-language reason when `restorable` is false or the entry needs attention. */
  note: z.string().optional(),
  /** True when the baseline was rebased over an edit the user made between turns. */
  includesUserEdits: z.boolean(),
  /** Set when a created path has the same content as a path deleted in the same operation. */
  renamedFrom: RelPathSchema.optional(),
  operationIds: z.array(OperationIdSchema),
  linesAdded: z.number().int().nonnegative().optional(),
  linesRemoved: z.number().int().nonnegative().optional(),
});
export type ReviewEntry = z.infer<typeof ReviewEntrySchema>;

/** One contiguous change between the baseline and the file on disk. Lines keep their terminators. */
export const HunkSchema = z.object({
  /** Derived from path, baseline hash, current hash and index. An action on a stale id is refused. */
  id: z.string().min(1),
  index: z.number().int().nonnegative(),
  baselineStart: z.number().int().nonnegative(),
  baselineLines: z.array(z.string()),
  currentStart: z.number().int().nonnegative(),
  currentLines: z.array(z.string()),
});
export type Hunk = z.infer<typeof HunkSchema>;

export const OperationKindSchema = z.enum(['agent-turn', 'reject', 'restore', 'recovery']);
export type OperationKind = z.infer<typeof OperationKindSchema>;

/** One entry of the checkpoint history. */
export const CheckpointSummarySchema = z.object({
  operationId: OperationIdSchema,
  kind: OperationKindSchema,
  at: TimestampSchema,
  conversationId: ConversationIdSchema.optional(),
  conversationTitle: z.string().optional(),
  turnId: TurnIdSchema.optional(),
  filesChanged: z.number().int().nonnegative(),
  interrupted: z.boolean(),
});
export type CheckpointSummary = z.infer<typeof CheckpointSummarySchema>;

export const RestoreConflictSchema = z.enum([
  'changed-since',
  'user-edit-between',
  'not-captured',
  'unsaved-editor',
  'blocked-path',
]);

export const RestoreItemSchema = z.object({
  path: RelPathSchema,
  action: z.enum(['write', 'delete', 'rename', 'chmod', 'skip']),
  /** Present when the item cannot be applied as planned. */
  conflict: RestoreConflictSchema.optional(),
  /** Plain-language explanation of the conflict or the skip. */
  note: z.string().optional(),
  attribution: AttributionSchema,
  /** Whether the item is ticked by default in the preview. */
  selectedByDefault: z.boolean(),
  /** Whether the user may tick it at all. */
  selectable: z.boolean(),
});
export type RestoreItem = z.infer<typeof RestoreItemSchema>;

export const RestorePreviewSchema = z.object({
  /** Opaque token identifying this preview; a restore request must echo it. */
  token: z.string().min(1),
  targetOperationId: OperationIdSchema,
  /** Every operation the restore would undo, newest first. */
  affectedOperations: z.array(CheckpointSummarySchema),
  items: z.array(RestoreItemSchema),
  /** Bytes needed for the safety copy and the writes. */
  bytesNeeded: z.number().int().nonnegative(),
});
export type RestorePreview = z.infer<typeof RestorePreviewSchema>;

export const RestoreOutcomeSchema = z.object({
  operationId: OperationIdSchema.optional(),
  items: z.array(
    z.object({ path: RelPathSchema, achieved: z.boolean(), detail: z.string().optional() }),
  ),
});
export type RestoreOutcome = z.infer<typeof RestoreOutcomeSchema>;

/** A change to tool or editor configuration seen during an Agent turn. The user must keep or revert it. */
export const ConfigChangeSchema = z.object({
  id: z.string().min(1),
  /** Path as displayed: relative to the folder when inside it, otherwise relative to the git root. */
  displayPath: z.string(),
  changeType: z.enum(['created', 'modified', 'deleted']),
  revertible: z.boolean(),
  detectedAt: TimestampSchema,
});
export type ConfigChange = z.infer<typeof ConfigChangeSchema>;
