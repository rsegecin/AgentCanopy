import * as z from 'zod';
import { AttachmentSchema, ImageMediaTypeSchema, MAX_IMAGE_BASE64_LENGTH } from './conversation';
import {
  ConversationIdSchema,
  FolderKeySchema,
  MessageIdSchema,
  OperationIdSchema,
  PlanIdSchema,
  PromptIdSchema,
  RelPathSchema,
} from './ids';
import { ModeSchema } from './modes';
import { PermissionSwitchSchema } from './permissions';
import { PromptAnswerSchema } from './prompts';
import { ViewStateSchema } from './view-state';

/* ------------------------------------------------------------------ host -> webview */

const pathSegment = z.union([z.string(), z.number().int().nonnegative()]);
export const StatePathSchema = z.array(pathSegment).max(16);
export type StatePath = z.infer<typeof StatePathSchema>;

/** A change to the view state. Paths index into `ViewState`. */
export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: StatePathSchema, value: z.unknown() }),
  z.object({ op: z.literal('push'), path: StatePathSchema, value: z.unknown() }),
  z.object({ op: z.literal('appendText'), path: StatePathSchema, text: z.string() }),
  z.object({ op: z.literal('delete'), path: StatePathSchema }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

/** Something that happens once and is not state. */
export const ViewEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('focus-composer') }),
  /** Text for the composer. It goes in front of what the user has already typed, never over it. */
  z.object({ kind: z.literal('prefill-composer'), text: z.string() }),
  z.object({
    kind: z.literal('show-tab'),
    tab: z.enum(['chat', 'history', 'checkpoints', 'permissions']),
  }),
  z.object({
    kind: z.literal('toast'),
    level: z.enum(['info', 'warning', 'error']),
    text: z.string(),
  }),
]);
export type ViewEvent = z.infer<typeof ViewEventSchema>;

export const HostMessageSchema = z.discriminatedUnion('type', [
  /** Full state. Sent on `ready` and on `resync`. `seq` is the sequence number the state is at. */
  z.object({
    type: z.literal('init'),
    seq: z.number().int().nonnegative(),
    state: ViewStateSchema,
  }),
  /** Applies on top of `seq - 1`. A view that sees a gap asks for a resync. */
  z.object({
    type: z.literal('patch'),
    seq: z.number().int().positive(),
    ops: z.array(PatchOpSchema).min(1),
  }),
  z.object({ type: z.literal('event'), event: ViewEventSchema }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

/* ------------------------------------------------------------------ webview -> host */

const text = z.string().max(200_000);
const conversationId = ConversationIdSchema;

export const WebviewMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('resync') }),

  // Conversations
  z.object({ type: z.literal('conversation.new'), folder: FolderKeySchema.optional() }),
  z.object({ type: z.literal('conversation.open'), conversationId }),
  z.object({
    type: z.literal('conversation.rename'),
    conversationId,
    title: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal('conversation.delete'), conversationId }),
  z.object({ type: z.literal('conversation.search'), query: z.string().max(500) }),
  z.object({ type: z.literal('conversation.setMode'), conversationId, mode: ModeSchema }),
  z.object({
    type: z.literal('conversation.setModel'),
    conversationId,
    model: z.string().min(1).max(200),
  }),
  /**
   * Turns Agent mode's Auto switch on or off: for a conversation, or without an id for the
   * conversation this view is about to start. Turning it on opens a native dialog on the host;
   * turning it off needs none and also applies to a turn that is running.
   */
  z.object({
    type: z.literal('conversation.setAuto'),
    conversationId: conversationId.optional(),
    on: z.boolean(),
  }),
  z.object({ type: z.literal('conversation.fork'), conversationId, messageId: MessageIdSchema }),
  z.object({
    type: z.literal('conversation.openInEditor'),
    conversationId: conversationId.optional(),
  }),

  // Turns
  z.object({
    type: z.literal('turn.send'),
    /** Absent to start a new conversation with this message. */
    conversationId: conversationId.optional(),
    text: text.min(1),
    mode: ModeSchema,
    model: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal('turn.cancel'), conversationId }),

  // The message queued behind a running turn
  /**
   * Takes the queued message back for editing: the host drops it, returns its attachments to this
   * view's draft and sends the text back with a `prefill-composer` event. Nothing happens when the
   * message is already being sent.
   */
  z.object({ type: z.literal('queue.edit'), conversationId }),
  z.object({ type: z.literal('queue.remove'), conversationId }),
  /** Sends the queued message now. A turn that is running is stopped first and waited for. */
  z.object({ type: z.literal('queue.sendNow'), conversationId }),

  // Composer context
  z.object({
    type: z.literal('context.pick'),
    conversationId: conversationId.optional(),
    what: z.enum(['file', 'folder']),
  }),
  /** Search file and folder names in the conversation's folder. An empty query closes the search. */
  z.object({ type: z.literal('context.search'), query: z.string().max(200) }),
  /** Attach a file or folder by path (from a search result). The host checks that it exists inside the folder. */
  z.object({
    type: z.literal('context.add'),
    path: RelPathSchema,
    kind: z.enum(['file', 'folder']),
  }),
  z.object({ type: z.literal('context.addSelection'), conversationId: conversationId.optional() }),
  z.object({
    type: z.literal('context.addDiagnostics'),
    conversationId: conversationId.optional(),
  }),
  /**
   * An image pasted into the composer, as base64. The host checks the bytes, keeps them in memory
   * and attaches a reference to the view's draft.
   */
  z.object({
    type: z.literal('context.pasteImage'),
    mediaType: ImageMediaTypeSchema,
    data: z.string().min(1).max(MAX_IMAGE_BASE64_LENGTH),
  }),
  z.object({
    type: z.literal('context.remove'),
    conversationId: conversationId.optional(),
    attachment: AttachmentSchema,
  }),

  // Prompts
  z.object({
    type: z.literal('prompt.answer'),
    promptId: PromptIdSchema,
    displayHash: z.string().min(1).max(200),
    answer: PromptAnswerSchema,
  }),

  // Permissions of the folder the view shows. No message names a folder: the host uses the view's.
  /** Removes one saved permission, by the id the view state gave it. Needs no dialog. */
  z.object({ type: z.literal('permissions.remove'), id: z.string().min(1).max(64) }),
  /**
   * Turns one of the folder's switches on or off. Turning it on opens a native dialog on the host;
   * turning it off needs none and also applies to a turn that is running.
   */
  z.object({
    type: z.literal('permissions.setSwitch'),
    name: PermissionSwitchSchema,
    on: z.boolean(),
  }),
  /** Asks the host for its native folder picker, to allow reads and searches in a folder. */
  z.object({ type: z.literal('permissions.addDirectory') }),
  /** Opens the editor's settings on AgentCanopy's own. */
  z.object({ type: z.literal('settings.open') }),

  // Plans
  z.object({ type: z.literal('plan.setLocked'), conversationId, locked: z.boolean() }),
  z.object({
    type: z.literal('plan.decide'),
    planId: PlanIdSchema,
    targetId: z.string().min(1).max(1000),
    kind: z.enum(['decision-point', 'open-question']),
    values: z.array(z.string().max(4000)).min(1).max(20),
  }),
  z.object({
    type: z.literal('plan.approve'),
    planId: PlanIdSchema,
    version: z.number().int().positive(),
    contentHash: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal('plan.revert'),
    planId: PlanIdSchema,
    version: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('plan.compare'),
    planId: PlanIdSchema,
    left: z.number().int().positive(),
    right: z.number().int().positive(),
  }),
  /** Opens one version of the plan as a read-only Markdown document in the editor. */
  z.object({
    type: z.literal('plan.open'),
    planId: PlanIdSchema,
    version: z.number().int().positive(),
  }),

  // Review
  z.object({ type: z.literal('review.openDiff'), path: RelPathSchema }),
  z.object({ type: z.literal('review.openAll') }),
  z.object({ type: z.literal('review.acceptAll') }),
  z.object({
    type: z.literal('review.rejectAll'),
    includePaths: z.array(RelPathSchema).max(10_000),
  }),
  z.object({ type: z.literal('review.acceptFile'), path: RelPathSchema }),
  z.object({ type: z.literal('review.rejectFile'), path: RelPathSchema }),
  z.object({ type: z.literal('config.keep'), changeId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('config.revert'), changeId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('config.openDiff'), changeId: z.string().min(1).max(200) }),

  // Checkpoints
  z.object({ type: z.literal('checkpoint.preview'), operationId: OperationIdSchema }),
  z.object({ type: z.literal('checkpoint.cancelPreview') }),
  /** Opens a diff of one previewed item: the file now against what the restore would put there. */
  z.object({
    type: z.literal('checkpoint.openDiff'),
    token: z.string().min(1).max(200),
    path: RelPathSchema,
  }),
  z.object({
    type: z.literal('checkpoint.restore'),
    token: z.string().min(1).max(200),
    paths: z.array(RelPathSchema).max(100_000),
    /** Also branch the conversation at the turn that created this checkpoint. */
    andFork: z.boolean(),
  }),

  // Navigation and misc
  z.object({
    type: z.literal('open.file'),
    path: z.string().min(1).max(4096),
    line: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('open.link'), url: z.string().min(1).max(4096) }),
  z.object({
    type: z.literal('banner.action'),
    bannerId: z.string().min(1).max(200),
    actionId: z.string().min(1).max(200),
  }),
  z.object({ type: z.literal('banner.dismiss'), bannerId: z.string().min(1).max(200) }),
  z.object({ type: z.literal('clipboard.copy'), text: text }),
  z.object({ type: z.literal('provider.refresh') }),
  z.object({ type: z.literal('provider.signIn') }),
  z.object({ type: z.literal('logs.show') }),
]);
export type WebviewMessage = z.infer<typeof WebviewMessageSchema>;
