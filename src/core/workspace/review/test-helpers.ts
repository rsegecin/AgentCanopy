import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { FolderKey, RelPath, ReviewEntry, Settings } from '../../../shared';
import type { Clock, EditorPort } from '../../contracts';
import type { FolderWorkspace, WorkspaceTracker } from '../tracker';
import {
  FakeEditor,
  Turn,
  makeEnv,
  openWorkspace,
  operations,
  type Env,
} from '../tracker/test-support';
import { createReviewEngine, type ReviewEngine } from './engine';
import type { ExecutorHooks } from './executor';

/** Test support for the review engine. Not part of the public API. */

/** An editor whose unsaved files the test controls; it also reports saves, like the tracker's fake. */
export class TestEditor extends FakeEditor implements EditorPort {
  readonly dirty = new Set<string>();
  override dirtyFiles(): string[] {
    return [...this.dirty];
  }
  override isDirty(absolutePath?: string): boolean {
    return absolutePath !== undefined && this.dirty.has(absolutePath);
  }
}

export interface Harness {
  env: Env;
  tracker: WorkspaceTracker;
  ws: FolderWorkspace;
  engine: ReviewEngine;
  editor: TestEditor;
  hooks: ExecutorHooks;
  key: FolderKey;
  /** Another engine over the same tracker, as after a restart. */
  newEngine(): ReviewEngine;
  /** Plays an agent turn. */
  turn(play: (turn: Turn) => Promise<unknown>): Promise<void>;
  /** The user edits files outside any turn, and the tracker notices. */
  userEdit(files: Record<string, string | Buffer>): Promise<void>;
  sync(): Promise<void>;
  entries(): Promise<ReviewEntry[]>;
  entry(path: string): Promise<ReviewEntry | undefined>;
  read(path: string): Promise<string>;
  /** Every file and link below the folder, with a hash of its content. */
  listing(): Promise<Record<string, string>>;
  cleanup(): Promise<void>;
}

export async function makeHarness(
  options: { settings?: Partial<Settings>; clock?: Clock } = {},
): Promise<Harness> {
  const env = await makeEnv({ settings: options.settings });
  const editor = new TestEditor();
  // `Turn.userSave` reports the user's saves through the environment's editor.
  Object.assign(env, { editor });
  const tracker = env.tracker({ editor, ...(options.clock ? { clock: options.clock } : {}) });
  const ws = await openWorkspace(tracker, env);
  const hooks: ExecutorHooks = {};
  const make = (): ReviewEngine =>
    createReviewEngine({
      tracker,
      editor,
      settings: () => env.settings,
      executorHooks: hooks,
    });
  const engine = make();
  const key = env.folder.key;
  const harness: Harness = {
    env,
    tracker,
    ws,
    engine,
    editor,
    hooks,
    key,
    newEngine: make,
    async turn(play) {
      const turn = new Turn(tracker, env);
      await turn.begin();
      try {
        await play(turn);
      } finally {
        await turn.end();
      }
    },
    async userEdit(files) {
      await env.write(files);
      await ws.sync(env.settings);
    },
    sync: () => ws.sync(env.settings),
    entries: () => engine.entries(key),
    async entry(path) {
      return (await engine.entries(key)).find((e) => e.path === path);
    },
    read: (path) => env.read(path),
    listing: () => listTree(env.root),
    cleanup: () => env.cleanup(),
  };
  return harness;
}

export async function listTree(root: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out[`${rel}/`] = 'dir';
      Object.assign(out, await listTree(root, rel));
    } else if (entry.isSymbolicLink()) {
      out[rel] = `link:${await fs.readlink(join(root, rel))}`;
    } else {
      const data = await fs.readFile(join(root, rel));
      out[rel] =
        `${createHash('sha256').update(data).digest('hex')}:${(await fs.stat(join(root, rel))).mode & 0o777}`;
    }
  }
  return out;
}

export { operations };

export const p = (path: string): RelPath => path;

/** The reject operations in the log, oldest first. */
export function rejectRecords(ws: FolderWorkspace) {
  return operations(ws).filter((op) => op.kind === 'reject');
}
