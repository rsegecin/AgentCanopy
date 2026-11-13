import * as z from 'zod';
import {
  AttachmentSchema,
  ConversationMetaSchema,
  ConversationSummarySchema,
  MessageSchema,
  TurnSchema,
} from './conversation';
import { ConversationIdSchema, FolderKeySchema, RelPathSchema } from './ids';
import { ModeSchema } from './modes';
import { PlanDocSchema } from './plan';
import { PromptSchema } from './prompts';
import { ModelInfoSchema, ProviderStatusSchema } from './provider-status';
import {
  CheckpointSummarySchema,
  ConfigChangeSchema,
  HunkSchema,
  RestorePreviewSchema,
  ReviewEntrySchema,
} from './workspace';

export const ActiveConversationSchema = z.object({
  meta: ConversationMetaSchema,
  turns: z.array(TurnSchema),
  /** In order. The last assistant message grows while a turn is streaming. */
  messages: z.array(MessageSchema),
  prompts: z.array(PromptSchema),
  plan: PlanDocSchema.nullable(),
  /** One-line description of what the turn is doing, while one runs. */
  activity: z.string().nullable(),
});
export type ActiveConversation = z.infer<typeof ActiveConversationSchema>;

export const BannerSchema = z.object({
  id: z.string().min(1),
  level: z.enum(['info', 'warning', 'error']),
  text: z.string(),
  /** Optional action button: the host decides what the id does. */
  action: z.object({ id: z.string().min(1), label: z.string().min(1) }).optional(),
  dismissible: z.boolean(),
});
export type Banner = z.infer<typeof BannerSchema>;

export const BaselineStatusSchema = z.object({
  state: z.enum(['idle', 'capturing', 'ready', 'degraded']),
  filesDone: z.number().int().nonnegative(),
  filesTotal: z.number().int().nonnegative(),
  /** Plain-language note when coverage is partial. */
  note: z.string().optional(),
});
export type BaselineStatus = z.infer<typeof BaselineStatusSchema>;

/** Everything a webview needs to render. The host owns it; a view only ever receives it. */
export const ViewStateSchema = z.object({
  trusted: z.boolean(),
  folders: z.array(z.object({ key: FolderKeySchema, name: z.string() })),
  provider: ProviderStatusSchema.nullable(),
  models: z.array(ModelInfoSchema),
  defaults: z.object({ mode: ModeSchema, model: z.string() }),
  conversations: z.array(ConversationSummarySchema),
  active: ActiveConversationSchema.nullable(),
  /** Attachments queued for this view's next message, whether or not a conversation exists yet. */
  draftAttachments: z.array(AttachmentSchema),
  /** Results of the composer's file search (typing `@`), or null when no search is open. */
  fileSearch: z
    .object({
      query: z.string(),
      results: z.array(z.object({ path: RelPathSchema, kind: z.enum(['file', 'folder']) })),
    })
    .nullable(),
  search: z
    .object({
      query: z.string(),
      results: z.array(
        z.object({ conversationId: ConversationIdSchema, title: z.string(), snippet: z.string() }),
      ),
    })
    .nullable(),
  review: z.object({
    entries: z.array(ReviewEntrySchema),
    /** Hunks per path, filled when a view asks for them. */
    hunks: z.record(RelPathSchema, z.array(HunkSchema)),
    configChanges: z.array(ConfigChangeSchema),
    /**
     * An Agent turn is running in this view's folder. File changes cannot be accepted or rejected
     * meanwhile, so the view hides those actions. Configuration changes stay decidable.
     */
    busy: z.boolean(),
  }),
  checkpoints: z.array(CheckpointSummarySchema),
  restorePreview: RestorePreviewSchema.nullable(),
  baseline: BaselineStatusSchema,
  banners: z.array(BannerSchema),
});
export type ViewState = z.infer<typeof ViewStateSchema>;

export const EMPTY_VIEW_STATE: ViewState = {
  trusted: false,
  folders: [],
  provider: null,
  models: [],
  defaults: { mode: 'ask', model: 'default' },
  conversations: [],
  active: null,
  draftAttachments: [],
  fileSearch: null,
  search: null,
  review: { entries: [], hunks: {}, configChanges: [], busy: false },
  checkpoints: [],
  restorePreview: null,
  baseline: { state: 'idle', filesDone: 0, filesTotal: 0 },
  banners: [],
};
