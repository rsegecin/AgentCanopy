import * as z from 'zod';
import {
  ConversationIdSchema,
  FolderKeySchema,
  MessageIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  PromptIdSchema,
  RelPathSchema,
  TimestampSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from './ids';
import { ModeSchema } from './modes';
import { ChangeTypeSchema } from './workspace';

/** Image types the user can paste into a message. */
export const ImageMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export type ImageMediaType = z.infer<typeof ImageMediaTypeSchema>;

/** Largest pasted image, in bytes. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Most images in one message. */
export const MAX_IMAGES_PER_MESSAGE = 5;
/** Combined size of the images in one message, in bytes (the largest size checked against the CLI). */
export const MAX_IMAGE_BYTES_PER_MESSAGE = 5 * 1024 * 1024;
/** Length of the base64 text for an image of `MAX_IMAGE_BYTES`. */
export const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

/** Content hash of an image: lowercase hex SHA-256. */
export const ImageIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Context the user attached to a message. Paths are relative to the conversation's folder.
 * An image is only a reference: its bytes stay in the extension host's memory until the turn that
 * sends it has ended, and are never stored with the conversation.
 */
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
  z.object({
    kind: z.literal('image'),
    id: ImageIdSchema,
    mediaType: ImageMediaTypeSchema,
    bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  }),
]);
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Who allowed a tool call. `policy`: AgentCanopy's standing rules. `auto`: AgentCanopy, because the
 * conversation's Auto switch was on. `provider` means the host was never asked.
 */
export const ApprovalSourceSchema = z.enum(['user', 'policy', 'auto', 'provider', 'unverified']);
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

/** Most files one `changes` part lists. It only limits the record: the live rows come from the review. */
export const MAX_CHANGES_LISTED = 200;

/**
 * The files an Agent turn left pending for review, written once when the turn ends. It marks where
 * the turn's card sits in the transcript and records what the turn changed; whether a file is still
 * pending is read from the review entries of the folder, never from here.
 */
export const ChangesPartSchema = z.object({
  kind: z.literal('changes'),
  /** The operations of the turn. An entry whose last operation is one of these is acted on here. */
  operationIds: z.array(OperationIdSchema).min(1),
  /** What the turn left pending when it ended, sorted by path, at most `MAX_CHANGES_LISTED`. */
  files: z
    .array(z.object({ path: RelPathSchema, changeType: ChangeTypeSchema }))
    .max(MAX_CHANGES_LISTED),
  /** How many more files there were than `files` lists. */
  more: z.number().int().nonnegative(),
});
export type ChangesPart = z.infer<typeof ChangesPartSchema>;

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
  ChangesPartSchema,
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
  /** The turn started with the conversation's Auto switch on (Agent mode only). Absent means no. */
  auto: z.boolean().optional(),
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

/** Where in the parent's transcript a side question was asked. */
export const AsideAnchorSchema = z.object({
  /**
   * The parent's message it was asked under: the assistant message being written, or the user
   * message of the running turn when nothing had been written yet.
   */
  messageId: MessageIdSchema,
  /** How many parts that message had at that moment: the card sits after them. 0 for a user message. */
  afterParts: z.number().int().nonnegative(),
});
export type AsideAnchor = z.infer<typeof AsideAnchorSchema>;

/**
 * Marks a branch that holds a side question: a question asked in Ask mode while a turn was running
 * in the parent. It ran alongside that turn, in a branch of the turns that had finished.
 */
export const AsideInfoSchema = z.object({
  parentId: ConversationIdSchema,
  anchor: AsideAnchorSchema,
  /** The turn of this branch that asks the question. Absent until that turn has started. */
  turnId: TurnIdSchema.optional(),
});
export type AsideInfo = z.infer<typeof AsideInfoSchema>;

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
  /** Set on a branch that holds a side question. Such a branch also has `fork`. */
  aside: AsideInfoSchema.optional(),
  planId: PlanIdSchema.optional(),
  planLocked: z.boolean(),
  /**
   * Agent mode's Auto switch: terminal commands and edits inside the folder run without a prompt for
   * each one. On only when exactly `true`; conversations stored before it existed do not have it.
   * Only the user turns it on, through a native dialog. A new conversation, a branch and a side
   * question start without it.
   */
  agentAuto: z.boolean().optional(),
  /**
   * When Auto was last turned on for this conversation. Auto counts as on only while this is later
   * than the last time the setting that offers Auto was seen off on this machine, so turning that
   * setting off and on again arms no conversation, also in a workspace that was closed meanwhile.
   */
  agentAutoSince: TimestampSchema.optional(),
});
export type ConversationMeta = z.infer<typeof ConversationMetaSchema>;

export const ConversationSummarySchema = ConversationMetaSchema.extend({
  preview: z.string().max(300),
  running: z.boolean(),
  pendingPrompts: z.number().int().nonnegative(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
