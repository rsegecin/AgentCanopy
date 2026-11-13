import * as z from 'zod';
import { ConversationIdSchema, PlanIdSchema, TimestampSchema, TurnIdSchema } from './ids';

const shortText = z.string().min(1).max(300);
const markdown = z.string().max(40_000);
const itemId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'use letters, digits, dot, dash or underscore');

export const PlanFileSchema = z.object({
  path: z.string().min(1).max(1000),
  action: z.enum(['create', 'modify', 'delete', 'read']),
  role: z.string().max(500),
});

export const PlanStageSchema = z.object({
  id: itemId,
  title: shortText,
  description: markdown,
  files: z.array(z.string().max(1000)).max(200).default([]),
  dependsOn: z.array(itemId).max(50).default([]),
  acceptance: z.array(z.string().max(1000)).max(50).default([]),
});

export const PlanDiagramSchema = z.object({
  id: itemId,
  title: shortText,
  mermaid: z.string().min(1).max(20_000),
});

export const PlanAlternativeSchema = z.object({
  id: itemId,
  title: shortText,
  summary: z.string().max(4000),
  pros: z.array(z.string().max(1000)).max(20).default([]),
  cons: z.array(z.string().max(1000)).max(20).default([]),
  /** True for the approach the plan follows. */
  chosen: z.boolean().default(false),
});

const optionSchema = z.object({
  id: itemId,
  label: shortText,
  description: z.string().max(2000).default(''),
});

/** A choice the user is asked to make between approaches. */
export const PlanDecisionPointSchema = z.object({
  id: itemId,
  question: shortText,
  options: z.array(optionSchema).min(2).max(8),
  recommendedOptionId: itemId.optional(),
});

export const PlanOpenQuestionSchema = z.object({
  id: itemId,
  question: z.string().min(1).max(1000),
  kind: z.enum(['single', 'multi', 'text']),
  options: z.array(optionSchema).max(8).default([]),
});

/**
 * The content of one plan version. This schema, converted to JSON Schema, is the input of the
 * `submit_plan` tool, so every description here is read by the model.
 */
export const PlanContentSchema = z.object({
  title: shortText,
  objective: z.string().min(1).max(4000),
  requirements: z.array(z.string().max(2000)).max(100).default([]),
  analysis: markdown.default(''),
  architecture: markdown.default(''),
  relevantFiles: z.array(PlanFileSchema).max(300).default([]),
  stages: z.array(PlanStageSchema).min(1).max(60),
  dependencies: z.array(z.string().max(1000)).max(100).default([]),
  diagrams: z.array(PlanDiagramSchema).max(12).default([]),
  alternatives: z.array(PlanAlternativeSchema).max(12).default([]),
  decisionPoints: z.array(PlanDecisionPointSchema).max(20).default([]),
  openQuestions: z.array(PlanOpenQuestionSchema).max(20).default([]),
  testingStrategy: markdown.default(''),
  acceptanceCriteria: z.array(z.string().max(2000)).max(100).default([]),
  /** What changed since the previous version, in a sentence or two. Empty for the first version. */
  changeSummary: z.string().max(2000).default(''),
});
export type PlanContent = z.infer<typeof PlanContentSchema>;

export const PlanVersionSchema = z.object({
  version: z.number().int().positive(),
  author: z.enum(['agent', 'user']),
  createdAt: TimestampSchema,
  content: PlanContentSchema,
  /** sha256 of the canonical Markdown rendering of `content`. */
  contentHash: z.string().min(1),
  /** Set when this version is a copy of an earlier one ("revert to"). */
  restoredFrom: z.number().int().positive().optional(),
});
export type PlanVersion = z.infer<typeof PlanVersionSchema>;

/** An answer the user gave. Owned by the host; the model cannot change it. */
export const PlanUserDecisionSchema = z.object({
  /** Id of the decision point or open question, or the question text for an interactive question. */
  targetId: z.string().min(1).max(1000),
  kind: z.enum(['decision-point', 'open-question', 'interactive-question']),
  /** Chosen option ids or labels, or one free-text entry. */
  values: z.array(z.string().max(4000)).min(1),
  decidedAt: TimestampSchema,
  planVersion: z.number().int().positive().optional(),
});
export type PlanUserDecision = z.infer<typeof PlanUserDecisionSchema>;

export const PlanApprovalSchema = z.object({
  version: z.number().int().positive(),
  contentHash: z.string().min(1),
  approvedAt: TimestampSchema,
  executionTurnId: TurnIdSchema.optional(),
});
export type PlanApproval = z.infer<typeof PlanApprovalSchema>;

export const PlanDocSchema = z.object({
  id: PlanIdSchema,
  conversationId: ConversationIdSchema,
  createdAt: TimestampSchema,
  versions: z.array(PlanVersionSchema),
  decisions: z.array(PlanUserDecisionSchema),
  approvals: z.array(PlanApprovalSchema),
});
export type PlanDoc = z.infer<typeof PlanDocSchema>;
