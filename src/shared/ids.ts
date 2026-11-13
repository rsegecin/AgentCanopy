import * as z from 'zod';

const id = <B extends string>() => z.string().min(1).max(200).brand<B>();

export const ConversationIdSchema = id<'ConversationId'>();
export type ConversationId = z.infer<typeof ConversationIdSchema>;

export const TurnIdSchema = id<'TurnId'>();
export type TurnId = z.infer<typeof TurnIdSchema>;

export const MessageIdSchema = id<'MessageId'>();
export type MessageId = z.infer<typeof MessageIdSchema>;

export const PromptIdSchema = id<'PromptId'>();
export type PromptId = z.infer<typeof PromptIdSchema>;

export const PlanIdSchema = id<'PlanId'>();
export type PlanId = z.infer<typeof PlanIdSchema>;

export const OperationIdSchema = id<'OperationId'>();
export type OperationId = z.infer<typeof OperationIdSchema>;

/** A workspace folder, identified by a stable key derived from its real path. */
export const FolderKeySchema = id<'FolderKey'>();
export type FolderKey = z.infer<typeof FolderKeySchema>;

/** The provider's own id for a tool call (for Claude Code: `toolu_...`). Not branded: it is foreign data. */
export const ToolCallIdSchema = z.string().min(1).max(200);
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;

/** Milliseconds since the Unix epoch. */
export const TimestampSchema = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof TimestampSchema>;

/** A path relative to the workspace folder, with forward slashes, never starting with `/` or containing `..` segments. */
export const RelPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..'), {
    message: 'must be a relative path inside the folder',
  });
export type RelPath = z.infer<typeof RelPathSchema>;
