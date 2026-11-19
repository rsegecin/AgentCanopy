import * as z from 'zod';
import { ModeSchema } from './modes';

/**
 * AgentCanopy settings as the core sees them. The VS Code layer reads them from configuration.
 * Everything that affects safety has machine scope there, so a repository cannot change it.
 */
export const SettingsSchema = z.object({
  /** Path to the `claude` executable. Empty means "find it on PATH and in the default install location". */
  claudePath: z.string(),
  defaultMode: ModeSchema,
  /** Model alias or id. `default` lets Claude Code choose. */
  defaultModel: z.string().min(1),
  customModels: z.array(z.string().min(1)),
  askWebTools: z.boolean(),
  /** Fail a read-only turn when a plugin other than the built-in ones is loaded. */
  strictReadOnly: z.boolean(),
  /** `auto`: workspace edits are applied and reviewed afterwards. `ask`: every edit asks first. */
  editApproval: z.enum(['auto', 'ask']),
  alwaysAskCommands: z.boolean(),
  sandbox: z.boolean(),
  /** Offer Agent mode's Auto switch. Off hides it and turns Auto off in every conversation. */
  agentAuto: z.boolean(),
  /** Let Auto also approve web fetch and web search. */
  agentAutoWebTools: z.boolean(),
  /** Use the provider's cut-at-message flag for forks from an earlier message when it is available. */
  exactEarlierForks: z.boolean(),
  unsavedFiles: z.enum(['warn', 'ignore']),
  snapshotMaxFileBytes: z.number().int().positive(),
  snapshotMaxTotalBytes: z.number().int().positive(),
  snapshotExclude: z.array(z.string()),
  retentionOperations: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  claudePath: '',
  defaultMode: 'ask',
  defaultModel: 'default',
  customModels: [],
  askWebTools: false,
  strictReadOnly: false,
  editApproval: 'auto',
  alwaysAskCommands: false,
  sandbox: false,
  agentAuto: true,
  agentAutoWebTools: true,
  exactEarlierForks: true,
  unsavedFiles: 'warn',
  snapshotMaxFileBytes: 10 * 1024 * 1024,
  snapshotMaxTotalBytes: 512 * 1024 * 1024,
  snapshotExclude: [],
  retentionOperations: 50,
  retentionDays: 30,
};
