import type { RelPath } from '../../../shared';
import type { Logger, TurnContext, TurnNotice, TurnObserver } from '../../contracts';
import { silentLogger } from '../../contracts';
import {
  AbortError,
  loadIgnoreRules,
  scanWorkspace,
  statChanged,
  type IgnoreRules,
  type ScanResult,
} from '../../workspace/store';
import { escapeForDisplay } from './escape';

const MAX_LISTED = 5;

interface Baseline {
  rules: IgnoreRules;
  scan: ScanResult;
}

function watches(context: TurnContext): boolean {
  return context.mode === 'ask' || context.mode === 'plan';
}

function changedPaths(before: ScanResult, after: ScanResult): RelPath[] {
  const changed: RelPath[] = [];
  for (const [path, entry] of after.entries) {
    const old = before.entries.get(path);
    if (old === undefined || statChanged(old, entry)) changed.push(path);
  }
  for (const path of before.entries.keys()) {
    if (!after.entries.has(path)) changed.push(path);
  }
  return changed.sort();
}

function noticeText(paths: RelPath[]): string {
  const shown = paths.slice(0, MAX_LISTED).map((path) => escapeForDisplay(path));
  const more = paths.length - shown.length;
  const list = more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
  const one = paths.length === 1;
  return (
    `${paths.length} ${one ? 'file' : 'files'} changed in the workspace while this read-only turn was running: ${list}. ` +
    `The agent of this turn had no tool that can write, so an Agent turn in this folder, another program or an edit of yours changed ${one ? 'it' : 'them'}. ` +
    'AgentCanopy reverts nothing here.'
  );
}

/**
 * Compares the folder's file stats from before and after a read-only turn. It only reports: it never
 * writes anywhere, and it never refuses a turn because the scan failed.
 */
export function createReadOnlyTripwire(options: { logger?: Logger } = {}): TurnObserver {
  const logger = options.logger ?? silentLogger;
  /** Per conversation id; `undefined` means "no baseline" (the scan failed or was cut short). */
  const baselines = new Map<string, Baseline | undefined>();

  return {
    async beforeTurn(context, signal) {
      if (!watches(context)) return;
      const id = context.conversation.id;
      baselines.delete(id);
      try {
        const rules = await loadIgnoreRules(context.folder.path, context.settings.snapshotExclude);
        const scan = await scanWorkspace(context.folder.path, rules, { signal });
        if (scan.truncated) {
          logger.info(
            'The workspace is too large for the read-only tripwire; it is off for this turn.',
          );
          baselines.set(id, undefined);
        } else {
          baselines.set(id, { rules, scan });
        }
      } catch (error) {
        if (signal.aborted || error instanceof AbortError) throw error;
        logger.warn('The read-only tripwire could not scan the workspace before the turn.', {
          reason: error instanceof Error ? error.message : String(error),
        });
        baselines.set(id, undefined);
      }
    },

    async afterTurn(context) {
      const id = context.conversation.id;
      const baseline = baselines.get(id);
      baselines.delete(id);
      if (!watches(context) || baseline === undefined) return [];
      try {
        const after = await scanWorkspace(context.folder.path, baseline.rules);
        if (after.truncated) return [];
        const paths = changedPaths(baseline.scan, after);
        if (paths.length === 0) return [];
        const notice: TurnNotice = { level: 'warning', text: noticeText(paths) };
        return [notice];
      } catch (error) {
        logger.warn('The read-only tripwire could not scan the workspace after the turn.', {
          reason: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  };
}
