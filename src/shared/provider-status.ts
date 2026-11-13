import * as z from 'zod';

export const ProviderCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  resume: z.boolean(),
  forkWhole: z.boolean(),
  /** `exact` when the provider can cut a fork at an earlier message. */
  forkAtMessage: z.enum(['exact', 'none']),
  modelSelection: z.boolean(),
  interactiveApproval: z.boolean(),
  /** `tool-layer` when read-only modes are enforced by removing tools, not by prompt. */
  readOnlyEnforcement: z.enum(['tool-layer', 'none']),
  cancellation: z.enum(['graceful', 'hard', 'none']),
  toolEvents: z.boolean(),
  interactiveQuestions: z.boolean(),
  usage: z.boolean(),
  hostTools: z.boolean(),
  sandbox: z.boolean(),
  /** Whether the provider exposes its own session transcripts through a supported interface. */
  sessionHistory: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ModelInfoSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  custom: z.boolean(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const ProviderStatusSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1),
  installed: z.boolean(),
  version: z.string().optional(),
  /** False when the installed version is older than the minimum we support. */
  meetsMinimum: z.boolean(),
  minimumVersion: z.string(),
  auth: z.enum(['signed-in', 'signed-out', 'unknown']),
  credential: z.enum(['subscription', 'api-key', 'other', 'unknown']),
  capabilities: ProviderCapabilitiesSchema,
  /** Plain-language problems to show the user, most important first. */
  problems: z.array(z.string()),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;
