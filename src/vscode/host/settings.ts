import * as vscode from 'vscode';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '../../shared';
import type { Logger } from '../../core/contracts';

const BYTES_PER_MB = 1024 * 1024;

/** Settings key, the configuration key under `agentCanopy`, and how the raw value becomes the core value. */
type Mapping = { [K in keyof Settings]: { config: string; convert?: (raw: unknown) => unknown } };

const megabytesToBytes = (raw: unknown): unknown =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw * BYTES_PER_MB) : raw;

const MAPPING: Mapping = {
  claudePath: { config: 'claude.path' },
  defaultMode: { config: 'defaultMode' },
  defaultModel: { config: 'defaultModel' },
  customModels: { config: 'customModels' },
  askWebTools: { config: 'ask.webTools' },
  strictReadOnly: { config: 'readOnly.strict' },
  editApproval: { config: 'agent.editApproval' },
  alwaysAskCommands: { config: 'agent.alwaysAskCommands' },
  sandbox: { config: 'agent.sandbox' },
  exactEarlierForks: { config: 'forks.exactEarlierMessages' },
  unsavedFiles: { config: 'unsavedFiles' },
  snapshotMaxFileBytes: { config: 'snapshots.maxFileSizeMB', convert: megabytesToBytes },
  snapshotMaxTotalBytes: { config: 'snapshots.maxTotalSizeMB', convert: megabytesToBytes },
  snapshotExclude: { config: 'snapshots.exclude' },
  retentionOperations: { config: 'checkpoints.keepOperations' },
  retentionDays: { config: 'checkpoints.keepDays' },
};

/** Invalid values already reported, so a setting read on every call does not flood the log. */
const reported = new Set<string>();

/**
 * Reads the `agentCanopy` configuration. A value that does not validate is replaced by its default,
 * key by key, and reported once through the logger.
 */
export function readSettings(logger?: Logger): Settings {
  const configuration = vscode.workspace.getConfiguration('agentCanopy');
  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(MAPPING) as (keyof Settings)[]) {
    const { config, convert } = MAPPING[key];
    const raw = configuration.get<unknown>(config);
    if (raw === undefined) continue;
    const value = convert ? convert(raw) : raw;
    if (SettingsSchema.shape[key].safeParse(value).success) {
      result[key] = value;
      continue;
    }
    const signature = `${config}=${JSON.stringify(raw)}`;
    if (!reported.has(signature)) {
      reported.add(signature);
      logger?.warn('invalid setting, using the default', { key: `agentCanopy.${config}` });
    }
  }
  const parsed = SettingsSchema.safeParse(result);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}
