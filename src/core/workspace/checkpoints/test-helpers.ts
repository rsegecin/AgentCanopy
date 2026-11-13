import type { Clock } from '../../contracts';
import { makeHarness, type Harness } from '../review/test-helpers';
import { createCheckpointService, type CheckpointServiceWithChanges } from './service';
import type { Settings } from '../../../shared';

/** Test support for checkpoints. Not part of the public API. */

export interface CheckpointHarness extends Harness {
  svc: CheckpointServiceWithChanges;
  /** Folder keys passed to `onDidRestore`. */
  restored: string[];
  /** Another service over the same tracker, as after a restart. */
  newService(): CheckpointServiceWithChanges;
}

export async function makeCheckpointHarness(
  options: { settings?: Partial<Settings>; clock?: Clock } = {},
): Promise<CheckpointHarness> {
  const h = await makeHarness(options);
  const restored: string[] = [];
  const make = (): CheckpointServiceWithChanges =>
    createCheckpointService({
      tracker: h.tracker,
      editor: h.editor,
      settings: () => h.env.settings,
      clock: options.clock,
      onDidRestore: (key) => restored.push(key),
      executorHooks: h.hooks,
    });
  return Object.assign(h, { svc: make(), restored, newService: make });
}
