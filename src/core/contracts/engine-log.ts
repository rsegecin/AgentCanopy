import { z } from 'zod';
import {
  ConversationIdSchema,
  FileStateSchema,
  OperationIdSchema,
  OperationKindSchema,
  PathChangeSchema,
  RelPathSchema,
  TimestampSchema,
  TurnIdSchema,
} from '../../shared';

/**
 * The workspace log: one append-only JSONL file per workspace folder. Review state and checkpoints
 * are pure folds over it. Only an operation advances the state of a path.
 */

/** A set of file changes made by an agent turn or by AgentCanopy itself (reject, restore, crash recovery). */
export const OperationRecordSchema = z.object({
  type: z.literal('operation'),
  id: OperationIdSchema,
  kind: OperationKindSchema,
  at: TimestampSchema,
  conversationId: ConversationIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  /** `interrupted` when the turn did not end normally and its changes were reconstructed afterwards. */
  status: z.enum(['complete', 'interrupted']),
  changes: z.array(PathChangeSchema),
  /**
   * States the user produced during the turn that are not the before-state of any change above (for
   * example a version saved between two agent writes of the same file). Kept so their content is
   * never garbage-collected while this record exists.
   */
  preserved: z.array(z.object({ path: RelPathSchema, state: FileStateSchema })).default([]),
  /** For a restore: the operation whose "before" state was the target. */
  restoredTo: OperationIdSchema.optional(),
  /** Plain-language notes, such as Git state the agent changed. */
  notes: z.array(z.string()),
});
export type OperationRecord = z.infer<typeof OperationRecordSchema>;

/**
 * A difference between the disk and the last operation's after-state, found before the next operation.
 * It was made by the user or by another program. Baselines are rebased over it; it is never reverted
 * unless the user asks.
 */
export const ForeignDeltaRecordSchema = z.object({
  type: z.literal('foreign-delta'),
  id: OperationIdSchema,
  at: TimestampSchema,
  changes: z.array(
    z.object({ path: RelPathSchema, before: FileStateSchema, after: FileStateSchema }),
  ),
});
export type ForeignDeltaRecord = z.infer<typeof ForeignDeltaRecordSchema>;

/** The user accepted changes. No file changes; the review baseline of each path moves. */
export const ReviewDecisionRecordSchema = z.object({
  type: z.literal('review'),
  id: OperationIdSchema,
  at: TimestampSchema,
  accepted: z.array(
    z.object({
      path: RelPathSchema,
      /** The new baseline. For a whole-file accept it equals the current state; for a hunk it is a stored synthetic file. */
      baseline: FileStateSchema,
      whole: z.boolean(),
    }),
  ),
});
export type ReviewDecisionRecord = z.infer<typeof ReviewDecisionRecordSchema>;

export const LogRecordSchema = z.discriminatedUnion('type', [
  OperationRecordSchema,
  ForeignDeltaRecordSchema,
  ReviewDecisionRecordSchema,
]);
export type LogRecord = z.infer<typeof LogRecordSchema>;
