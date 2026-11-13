import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileState } from '../../../shared';
import { isCaseInsensitiveVolume } from '../store';
import { Turn, makeEnv, openWorkspace, sha, type Env } from './test-support';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

/** A small seeded generator, so a failing run can be repeated. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ['a.ts', 'b.ts', 'c/d.ts', 'e.txt', 'f.txt', 'g/h.txt'];

function describeState(state: FileState): string {
  if (state.kind === 'absent') return 'absent';
  if (state.kind === 'symlink') return `link:${state.target}`;
  return `file:${state.hash ?? '?'}:${state.mode}`;
}

/** The file's content hash, but only when the file really has this exact name (not a case alias). */
async function exactHash(path: string): Promise<string | undefined> {
  const abs = env.abs(path);
  const names = await fs.readdir(dirname(abs)).catch(() => [] as string[]);
  if (!names.includes(path.slice(path.lastIndexOf('/') + 1))) return undefined;
  try {
    return sha(await fs.readFile(abs));
  } catch {
    return undefined;
  }
}

/** The name a path really has on disk: the path itself, or its upper-case alias after a case-only rename. */
async function diskName(path: string): Promise<string> {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const names = await fs.readdir(dirname(env.abs(path))).catch(() => [] as string[]);
  if (names.includes(name)) return path;
  const alias = name.toUpperCase();
  return names.includes(alias) ? path.slice(0, slash + 1) + alias : path;
}

/** The file's content hash under any spelling of its name. */
async function looseHash(path: string): Promise<string | undefined> {
  try {
    return sha(await fs.readFile(env.abs(path)));
  } catch {
    return undefined;
  }
}

async function run(
  seed: number,
  steps: number,
  caseInsensitive: boolean,
): Promise<{ turns: number; checks: number; renames: number }> {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  let unique = 0;
  const content = (who: string): string => `${who}-${(unique += 1)}-${seed}\n`;
  const userHashes = new Set<string>();
  /** User states that were on disk when something looked, and so must be kept by a record. */
  const required = new Set<string>();
  const why = new Map<string, string>();
  /** The user's latest state of each path that nothing has looked at yet. */
  const unobserved = new Map<string, string>();

  for (const path of FILES) if (random() < 0.7) await env.write({ [path]: content('initial') });

  const tracker = env.tracker();
  const ws = await openWorkspace(tracker, env);
  await ws.sync(env.settings);

  const pathsWithHistory = (): Set<string> => {
    const out = new Set<string>();
    for (const record of ws.log.records()) {
      if (record.type === 'review') continue;
      for (const change of record.changes) out.add(change.path);
    }
    return out;
  };

  /** Something looked at the disk: what the user left there is now observed. */
  const observe = async (hadHistory: Set<string> | 'all'): Promise<void> => {
    for (const [path, hash] of [...unobserved]) {
      unobserved.delete(path);
      if ((await looseHash(path)) !== hash) continue;
      if (hadHistory === 'all' || hadHistory.has(await diskName(path))) {
        required.add(hash);
        why.set(hash, `observed ${path} step ${currentStep}`);
      }
    }
  };

  /** What the user saved in the open turn, by path: the tracker stores it at the save. */
  const savedInTurn = new Map<string, string>();

  const userWrites = async (path: string, text: string, viaEditorIn?: Turn): Promise<void> => {
    userHashes.add(sha(text));
    if (viaEditorIn) await viaEditorIn.userSave(path, text);
    else await env.write({ [path]: text });
    if (viaEditorIn) savedInTurn.set(path, sha(text));
    unobserved.set(path, sha(text));
  };

  /** An agent write to the path: a saved version is overwritten, and must have been preserved. */
  const agentOverwrites = (path: string): void => {
    const saved = savedInTurn.get(path);
    if (saved !== undefined) {
      required.add(saved);
      why.set(saved, `saved then overwritten ${path} step ${currentStep}`);
      savedInTurn.delete(path);
    }
  };

  const check = async (): Promise<void> => {
    const history = pathsWithHistory();
    await ws.sync(env.settings);
    await observe(history);
    const records = ws.log.records();
    const last = new Map<string, FileState>();
    for (const record of records) {
      if (record.type === 'review') continue;
      for (const change of record.changes) {
        const known = last.get(change.path);
        // (2) No gap: what a record starts from is what the previous one left.
        if (known !== undefined) {
          expect(describeState(change.before), `gap at ${change.path}`).toBe(describeState(known));
        }
        last.set(change.path, change.after);
      }
    }

    for (const [path, state] of last) {
      // (1) Replaying the log reproduces the disk.
      const onDisk = await exactHash(path);
      const expected = state.kind === 'file' ? state.hash : undefined;
      expect(onDisk, `replay of ${path}`).toBe(expected);

      // (3b) User content that is still on disk was recorded, and not as the agent's.
      if (onDisk !== undefined && userHashes.has(onDisk)) {
        const recorded = records.some(
          (r) =>
            r.type !== 'review' &&
            r.changes.some((c) => {
              if (c.path !== path || c.after.kind !== 'file' || c.after.hash !== onDisk)
                return false;
              if (r.type === 'foreign-delta') return true;
              return (
                'attribution' in c &&
                (c.attribution === 'user' ||
                  c.attribution === 'mixed' ||
                  c.attribution === 'unattributed')
              );
            }),
        );
        expect(recorded, `user content at ${path} was not recorded as the user's`).toBe(true);
      }
    }

    const referenced = new Set<string>();
    for (const record of records) {
      if (record.type === 'review') continue;
      if (record.type === 'operation') {
        for (const { state } of record.preserved) {
          if (state.kind === 'file' && state.hash !== undefined) referenced.add(state.hash);
        }
      }
      for (const change of record.changes) {
        for (const state of [change.before, change.after]) {
          if (state.kind === 'file' && state.hash !== undefined) referenced.add(state.hash);
        }
        // (3a) The user's content is never blamed on the agent alone.
        if (
          'attribution' in change &&
          (change.attribution === 'agent-tool' || change.attribution === 'agent-command') &&
          change.after.kind === 'file' &&
          change.after.hash !== undefined
        ) {
          expect(userHashes.has(change.after.hash), `${change.path} blamed on the agent`).toBe(
            false,
          );
        }
        // (4) Every before-state of an operation can be brought back.
        if (record.type === 'operation' && change.before.kind === 'file') {
          expect(change.before.stored, `before of ${change.path} not stored`).toBe(true);
          const bytes = await ws.blobs.get(change.before.hash as string);
          expect(sha(bytes)).toBe(change.before.hash);
        }
      }
    }

    // (5) Every state of the user's that something looked at is kept by a record and retrievable.
    for (const hash of required) {
      expect(
        referenced.has(hash),
        `user state ${hash.slice(0, 8)} (${why.get(hash)}) is in no record`,
      ).toBe(true);
      expect(sha(await ws.blobs.get(hash))).toBe(hash);
    }
  };

  let currentStep = 0;
  let turns = 0;
  let checks = 0;
  let renames = 0;
  for (let step = 0; step < steps; step += 1) {
    currentStep = step;
    const roll = random();
    if (roll < 0.4) {
      turns += 1;
      const history = pathsWithHistory();
      const turn = new Turn(tracker, env, `turn-${seed}-${step}`);
      savedInTurn.clear();
      await turn.begin();
      await observe(history);
      const actions = 1 + Math.floor(random() * 3);
      for (let i = 0; i < actions; i += 1) {
        const path = pick(FILES);
        const kind = random();
        if (kind < 0.25) {
          // The agent's file tool. It captures whatever the user left there.
          const hash = unobserved.get(path);
          await turn.edit(path, content('agent-tool'));
          agentOverwrites(path);
          if (hash !== undefined) {
            unobserved.delete(path);
            required.add(hash);
            why.set(hash, `captured by edit ${path} step ${step}`);
          }
        } else if (kind < 0.4) {
          unobserved.delete(path); // a command overwrites a hand edit before anything can look
          await turn.shellWrite({ [path]: content('agent-command') });
          agentOverwrites(path);
        } else if (kind < 0.5) {
          unobserved.delete(path);
          await turn.command(() => fs.rm(env.abs(path), { force: true }));
          agentOverwrites(path);
        } else if (kind < 0.62) {
          await userWrites(path, content('user-save'), turn);
        } else if (kind < 0.75) {
          // The user saves, then the agent's file tool overwrites it in the same turn.
          await userWrites(path, content('user-save'), turn);
          const hash = unobserved.get(path);
          await turn.edit(path, content('agent-tool'));
          agentOverwrites(path);
          unobserved.delete(path);
          if (hash !== undefined) {
            required.add(hash);
            why.set(hash, `save then edit ${path} step ${step}`);
          }
        } else if (kind < 0.88) {
          // A denied file-tool request, then the user edits the file by hand.
          await turn.fileTool('Edit', env.abs(path), () => Promise.resolve(), {
            outcome: 'denied',
          });
          await userWrites(path, content('user-hand'));
        } else {
          // A failed file tool that nevertheless changed the file.
          await turn.fileTool('Edit', env.abs(path), () => env.write({ [path]: content('half') }), {
            outcome: 'failed',
          });
          agentOverwrites(path);
          unobserved.delete(path);
        }
      }
      const notices = await turn.end();
      expect(notices.filter((n) => n.level === 'error')).toEqual([]);
      await observe('all');
    } else if (roll < 0.65) {
      const path = pick(FILES);
      await userWrites(path, content('user-edit'));
    } else if (roll < 0.74) {
      const path = pick(FILES);
      await fs.rm(env.abs(path), { force: true });
      unobserved.delete(path);
    } else if (roll < 0.8) {
      const path = pick(FILES);
      await fs.rm(env.abs(path), { force: true });
      await userWrites(path, content('user-recreate'));
    } else if (roll < 0.9 && caseInsensitive) {
      // A case-only rename.
      const path = pick(FILES);
      const slash = path.lastIndexOf('/');
      const name = path.slice(slash + 1);
      const alias = name.toUpperCase();
      const dir = slash < 0 ? '' : path.slice(0, slash + 1);
      const names = await fs.readdir(dirname(env.abs(path))).catch(() => [] as string[]);
      if (names.includes(name)) {
        await fs.rename(env.abs(path), join(dirname(env.abs(path)), alias));
        renames += 1;
      } else if (names.includes(alias)) {
        await fs.rename(join(env.root, dir, alias), env.abs(path));
        renames += 1;
      }
    } else {
      const history = pathsWithHistory();
      await ws.sync(env.settings);
      await observe(history);
    }
    if (random() < 0.5) {
      checks += 1;
      await check();
    }
  }
  await check();
  return { turns, checks: checks + 1, renames };
}

describe('property: random interleavings of agent turns, user edits, saves, denials, renames and deletes', () => {
  it.each([20261111, 7])(
    'keeps the log gap-free, replayable, honest about the user and keeping the user’s states (seed %i)',
    async (seed) => {
      const insensitive = await isCaseInsensitiveVolume(env.root);
      const { turns, checks, renames } = await run(seed, 200, insensitive);
      expect(turns).toBeGreaterThan(40);
      expect(checks).toBeGreaterThan(40);
      if (insensitive) expect(renames).toBeGreaterThan(0);
    },
    120_000,
  );
});
