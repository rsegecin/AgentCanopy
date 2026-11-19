import * as z from 'zod';
import {
  ConversationIdSchema,
  PromptIdSchema,
  TimestampSchema,
  ToolCallIdSchema,
  TurnIdSchema,
} from './ids';

/** How a permission request is presented. `external` covers network tools, MCP tools and anything unknown. */
export const PermissionCategorySchema = z.enum([
  'edit',
  'protected-path',
  'outside-workspace',
  'command',
  'read-outside',
  'network',
  'external',
]);
export type PermissionCategory = z.infer<typeof PermissionCategorySchema>;

export const PermissionChoiceSchema = z.enum(['allow-once', 'allow-always', 'deny']);
export type PermissionChoice = z.infer<typeof PermissionChoiceSchema>;

/**
 * What an "allow always" answer saves: the rule for one command or one tool of another tool server,
 * a directory outside the folder to read and search in, a directory outside the folder to edit files
 * in (which also allows reads and searches there), or a web site to fetch from.
 */
export const AlwaysRuleKindSchema = z.enum([
  'command',
  'tool',
  'read-directory',
  'edit-directory',
  'web-site',
]);
export type AlwaysRuleKind = z.infer<typeof AlwaysRuleKindSchema>;

export const PromptStateSchema = z.enum(['pending', 'answered', 'expired', 'cancelled']);
export type PromptState = z.infer<typeof PromptStateSchema>;

const promptBase = {
  id: PromptIdSchema,
  conversationId: ConversationIdSchema,
  turnId: TurnIdSchema,
  toolCallId: ToolCallIdSchema,
  createdAt: TimestampSchema,
  state: PromptStateSchema,
  /** Hash of exactly what is displayed. An answer must echo it, so a stale or forged answer is refused. */
  displayHash: z.string().min(1),
};

export const PermissionPromptSchema = z.object({
  ...promptBase,
  kind: z.literal('permission'),
  toolName: z.string(),
  category: PermissionCategorySchema,
  /** One-line summary, for example "Run a terminal command". */
  title: z.string(),
  /** The full command, path or URL. Never truncated; control and bidi characters are escaped by the host. */
  detail: z.string(),
  /** Pretty-printed tool input for the collapsible details. May be truncated. */
  inputPreview: z.string(),
  choices: z.array(PermissionChoiceSchema).min(1),
  /**
   * What "allow always" would save, when that choice is offered. `rule` is the command or tool rule,
   * the directory, or the site, by `kind`; a prompt without `kind` (stored before it existed) holds a
   * command or tool rule.
   */
  alwaysRule: z
    .object({
      kind: AlwaysRuleKindSchema.optional(),
      rule: z.string(),
      runsProjectCode: z.boolean(),
    })
    .optional(),
  /** The user's choice, once answered. */
  answered: PermissionChoiceSchema.optional(),
});
export type PermissionPrompt = z.infer<typeof PermissionPromptSchema>;

export const QuestionSchema = z.object({
  question: z.string().min(1),
  header: z.string(),
  options: z.array(z.object({ label: z.string().min(1), description: z.string() })),
  multiSelect: z.boolean(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const QuestionPromptSchema = z.object({
  ...promptBase,
  kind: z.literal('question'),
  questions: z.array(QuestionSchema).min(1),
  /** Answers keyed by question text, once answered. */
  answered: z.record(z.string(), z.string()).optional(),
});
export type QuestionPrompt = z.infer<typeof QuestionPromptSchema>;

export const PromptSchema = z.discriminatedUnion('kind', [
  PermissionPromptSchema,
  QuestionPromptSchema,
]);
export type Prompt = z.infer<typeof PromptSchema>;

export const PromptAnswerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('permission'),
    choice: PermissionChoiceSchema,
    /** Optional note sent to the agent with a denial. */
    feedback: z.string().max(4000).optional(),
  }),
  z.object({
    kind: z.literal('question'),
    /** Per question text: the chosen labels, or one free-text entry. */
    answers: z.record(z.string(), z.array(z.string().max(4000)).min(1)),
  }),
]);
export type PromptAnswer = z.infer<typeof PromptAnswerSchema>;
