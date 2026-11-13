import * as z from 'zod';
import {
  ConversationIdSchema,
  FolderKeySchema,
  MessageIdSchema,
  PlanIdSchema,
  PromptIdSchema,
  RelPathSchema,
  TimestampSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from './ids';
import { ModeSchema } from './modes';

/** Context the user attached to a message. Paths are relative to the conversation's folder. */
export const AttachmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: RelPathSchema }),
  z.object({ kind: z.literal('folder'), path: RelPathSchema }),
  z.object({
    kind: z.literal('selection'),
    path: RelPathSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    text: z.string().max(100_000),
  }),
  z.object({ kind: z.literal('diagnostics'), path: RelPathSchema, text: z.string().max(100_000) }),
]);
export type Attachment = z.infer<typeof AttachmentSchema>;

/** Who allowed a tool call. `provider` means the host was never asked. */
export const ApprovalSourceSchema = z.enum(['user', 'policy', 'provider', 'unverified']);
export type ApprovalSource = z.infer<typeof ApprovalSourceSchema>;

export const ToolCallStatusSchema = z.enum([
  'running',
  'awaiting-approval',
  'done',
  'error',
  'denied',
  'not-run',
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolCallViewSchema = z.object({
  id: ToolCallIdSchema,
  name: z.string(),
  /** Tool input as the provider sent it, possibly truncated for storage. */
  input: z.unknown(),
  inputTruncated: z.boolean(),
  status: ToolCallStatusSchema,
  approval: ApprovalSourceSchema.optional(),
  resultPreview: z.string().optional(),
  resultTruncated: z.boolean().optional(),
  parentId: ToolCallIdSchema.nullable(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
});
export type ToolCallView = z.infer<typeof ToolCallViewSchema>;

export const NoticeLevelSchema = z.enum(['info', 'warning', 'error']);

export const MessagePartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  z.object({ kind: z.literal('tool'), call: ToolCallViewSchema }),
  z.object({ kind: z.literal('notice'), level: NoticeLevelSchema, text: z.string() }),
  z.object({
    kind: z.literal('plan-update'),
    planId: PlanIdSchema,
    version: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('prompt'), promptId: PromptIdSchema }),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  id: MessageIdSchema,
  turnId: TurnIdSchema,
  createdAt: TimestampSchema,
  text: z.string(),
  mode: ModeSchema,
  attachments: z.array(AttachmentSchema),
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  id: MessageIdSchema,
  turnId: TurnIdSchema,
  createdAt: TimestampSchema,
  parts: z.array(MessagePartSchema),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const MessageSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
]);
export type Message = z.infer<typeof MessageSchema>;

export const TurnStatusSchema = z.enum([
  'preparing',
  'running',
  'completed',
  'interrupted',
  'error',
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheCreationTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
  contextWindow: z.number().positive().optional(),
  contextTokens: z.number().nonnegative().optional(),
});

export const TurnSchema = z.object({
  id: TurnIdSchema,
  mode: ModeSchema,
  model: z.string(),
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  status: TurnStatusSchema,
  /** Provider event id to cut at when forking after this turn. Absent when the turn produced no assistant output. */
  forkPointEventId: z.string().optional(),
  usage: UsageSchema.optional(),
  /** Plain-language error shown to the user when the turn failed. */
  error: z.string().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

export const ForkInfoSchema = z.object({
  parentId: ConversationIdSchema,
  /** The last message of the parent that the branch keeps. */
  atMessageId: MessageIdSchema,
  /**
   * The parent's id of the last turn the branch keeps; absent when it keeps none. The branch's own
   * turns are never counted, so a failed first try cannot change what "kept" means.
   */
  lastKeptParentTurnId: TurnIdSchema.optional(),
  /** `pending` until the branch's first turn has run and the strategy is known. */
  exactness: z.enum(['pending', 'exact', 'reconstructed']),
  /** What a reconstructed branch does not carry over, in plain language. */
  lost: z.array(z.string()),
});
export type ForkInfo = z.infer<typeof ForkInfoSchema>;

export const ConversationMetaSchema = z.object({
  id: ConversationIdSchema,
  title: z.string().max(200),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  folder: FolderKeySchema,
  providerId: z.string(),
  model: z.string(),
  mode: ModeSchema,
  /** The provider's session id. Absent until the first turn starts. */
  sessionId: z.string().optional(),
  fork: ForkInfoSchema.optional(),
  planId: PlanIdSchema.optional(),
  planLocked: z.boolean(),
});
export type ConversationMeta = z.infer<typeof ConversationMetaSchema>;

export const ConversationSummarySchema = ConversationMetaSchema.extend({
  preview: z.string().max(300),
  running: z.boolean(),
  pendingPrompts: z.number().int().nonnegative(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
