import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewEntry } from '../../../shared';
import { applyHunkToBaseline, joinLines, splitLines } from './hunks';
import { makeHarness, type Harness } from './test-helpers';

/** Seeded generator, so that a failing run can be repeated from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FILES = ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt'];
const MARKER = '// USER-MARKER-';
const isMarker = (line: string): boolean => line.startsWith(MARKER);
const strip = (content: string): string =>
  content
    .split('\n')
    .filter((line) => !isMarker(line))
    .join('\n');
const original = (file: string): string =>
  `${Array.from({ length: 10 }, (_, i) => `${file} line ${i + 1}`).join('\n')}\n`;

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.cleanup();
});

async function runSteps(
  seed: number,
  steps: number,
): Promise<{ log: string[]; counts: Record<string, number> }> {
  const random = rng(seed);
  const int = (n: number): number => Math.floor(random() * n);
  const pickOf = <T>(items: readonly T[]): T => items[int(items.length)] as T;

  for (const file of FILES) await h.env.write({ [file]: original(file) });
  await h.sync();

  /** Markers the user inserted and has not removed, per file. */
  const markers = new Map<string, Set<string>>(FILES.map((f) => [f, new Set()]));
  /** What a file may look like, markers aside, when nothing is pending: the original or an accepted state. */
  const allowed = new Map<string, Set<string>>(FILES.map((f) => [f, new Set([original(f)])]));
  let counter = 0;
  const log: string[] = [];
  const counts: Record<string, number> = {};
  const count = (what: string): void => {
    counts[what] = (counts[what] ?? 0) + 1;
  };

  const read = (file: string): Promise<string> => fs.readFile(h.env.abs(file), 'utf8');
  const pendingOf = async (): Promise<ReviewEntry[]> =>
    (await h.entries()).filter((e) => e.status === 'pending');

  async function check(step: number, what: string): Promise<void> {
    const where = `seed ${seed}, step ${step} (${what}); steps so far: ${log.join(' | ')}`;
    // (3) The user's marker lines are still there.
    for (const file of FILES) {
      const lines = (await read(file)).split('\n');
      for (const marker of markers.get(file)!) {
        expect(lines, `marker ${marker} in ${file}: ${where}`).toContain(marker);
      }
    }
    // (4) With nothing pending, a file is its original or an accepted state, plus the user's markers.
    const entries = await h.entries();
    if (!entries.some((e) => e.status === 'pending')) {
      for (const file of FILES) {
        expect(
          allowed.get(file)!.has(strip(await read(file))),
          `${file} when nothing is pending: ${where}\nDISK:\n${await read(file)}`,
        ).toBe(true);
      }
    }
  }

  for (let step = 1; step <= steps; step += 1) {
    const roll = random();
    const pending = await pendingOf();
    const before = await h.listing();
    let what: string;
    let mayWrite = false;
    let writes: string[] = [];

    if (roll < 0.3 || (pending.length === 0 && roll < 0.55)) {
      // An agent turn editing one to three files, by file tool or by command. It keeps the user's lines.
      const chosen = new Set<string>();
      const n = 1 + int(3);
      while (chosen.size < n) chosen.add(pickOf(FILES));
      const useCommand = random() < 0.4;
      what = `turn ${[...chosen].join(',')} ${useCommand ? 'cmd' : 'tool'}`;
      const edits: Record<string, string> = {};
      for (const file of chosen) {
        const lines = (await read(file)).split('\n');
        counter += 1;
        const candidates = lines
          .map((_line, i) => i)
          .filter((i) => i < lines.length - 1 && !isMarker(lines[i]!));
        const kind = int(3);
        if (kind === 0 && candidates.length > 0)
          lines[pickOf(candidates)] = `AGENT-${counter} replaced`;
        else if (kind === 1) lines.splice(int(lines.length), 0, `AGENT-${counter} inserted`);
        else lines.splice(lines.length - 1, 0, `AGENT-${counter} appended`);
        edits[file] = lines.join('\n');
      }
      await h.turn(async (t) => {
        if (useCommand) await t.shellWrite(edits);
        else for (const [file, content] of Object.entries(edits)) await t.edit(file, content);
      });
      mayWrite = true; // by the agent, not by review
      writes = Object.keys(edits);
      count('turn');
    } else if (roll < 0.45) {
      const file = pickOf(FILES);
      const lines = (await read(file)).split('\n');
      counter += 1;
      const marker = `${MARKER}${counter}`;
      lines.splice(int(lines.length), 0, marker);
      await fs.writeFile(h.env.abs(file), lines.join('\n'));
      markers.get(file)!.add(marker);
      const synced = random() < 0.5;
      if (synced) await h.sync();
      what = `user marker in ${file}${synced ? ' (synced)' : ''}`;
      mayWrite = true;
      writes = [file];
      count('user edit');
    } else if (roll < 0.48) {
      const file = pickOf(FILES);
      const own = [...markers.get(file)!];
      if (own.length === 0) continue;
      const marker = pickOf(own);
      await fs.writeFile(
        h.env.abs(file),
        (await read(file))
          .split('\n')
          .filter((line) => line !== marker)
          .join('\n'),
      );
      markers.get(file)!.delete(marker);
      what = `user removes ${marker} from ${file}`;
      mayWrite = true;
      writes = [file];
    } else if (pending.length === 0) {
      continue;
    } else if (roll < 0.56) {
      const entry = pickOf(pending);
      what = `accept ${entry.path}`;
      await h.engine.acceptFile(h.key, entry.path);
      allowed.get(entry.path)!.add(strip(await read(entry.path)));
      count('accept file');
    } else if (roll < 0.58) {
      what = 'accept all';
      await h.engine.acceptAll(h.key);
      for (const entry of pending) allowed.get(entry.path)!.add(strip(await read(entry.path)));
      count('accept all');
    } else if (roll < 0.66) {
      const entry = pickOf(pending);
      const hunks = await h.engine.hunks(h.key, entry.path);
      if (hunks.length === 0) continue;
      const hunk = pickOf(hunks);
      what = `accept hunk ${hunk.index}/${hunks.length} of ${entry.path}`;
      // What the baseline becomes, worked out from the hunk before the engine acts.
      const baselineBefore = await h.engine.baselineContent(h.key, entry.path);
      const baselineText =
        baselineBefore.kind === 'content'
          ? Buffer.from(baselineBefore.data).toString('utf8')
          : baselineBefore.kind === 'absent'
            ? ''
            : undefined;
      const result = await h.engine.acceptHunk(h.key, entry.path, hunk.id);
      if (result.status === 'done' && baselineText !== undefined) {
        allowed
          .get(entry.path)!
          .add(strip(joinLines(applyHunkToBaseline(splitLines(baselineText), hunk))));
      }
      count('accept hunk');
    } else if (roll < 0.8) {
      const entry = pickOf(pending);
      // Sometimes only the agent's part is taken out (keeping the user's lines), and sometimes the
      // log fails to take one of the records of that: what was in the file stays retrievable.
      const agentOnly = random() < 0.3;
      const failAt = agentOnly && random() < 0.4 ? int(3) : undefined;
      what = `reject ${entry.path} ${agentOnly ? 'agent-only' : 'strict'}${failAt === undefined ? '' : ` with failing append ${failAt}`}`;
      const baseline = await h.engine.baselineContent(h.key, entry.path);
      const preContent = await read(entry.path);
      const real = h.ws.appendRecord.bind(h.ws);
      let calls = 0;
      if (failAt !== undefined) {
        h.ws.appendRecord = async (record) => {
          const mine = calls;
          calls += 1;
          if (mine === failAt) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          await real(record);
        };
      }
      let result;
      try {
        result = await h.engine.rejectFile(h.key, entry.path, agentOnly ? 'agent-only' : 'strict');
      } finally {
        h.ws.appendRecord = real;
      }
      if (failAt !== undefined) {
        mayWrite = true;
        writes = [entry.path];
        if ((await read(entry.path)) !== preContent) {
          const roots = await h.engine.referencedHashes(h.key);
          expect(
            roots.has(createHash('sha256').update(preContent).digest('hex')),
            `what ${entry.path} held is still referenced: step ${step}, seed ${seed}`,
          ).toBe(true);
        }
        count('reject failing append');
      } else if (result.status === 'done') {
        if (!agentOnly) {
          // (2) Exactly the baseline, byte for byte.
          expect(baseline.kind, `baseline of ${entry.path} (${what})`).toBe('content');
          if (baseline.kind === 'content') {
            const disk = await fs.readFile(h.env.abs(entry.path));
            expect(
              disk.equals(Buffer.from(baseline.data)),
              `${entry.path} equals its baseline: step ${step}, seed ${seed}`,
            ).toBe(true);
          }
        }
        mayWrite = true;
        writes = [entry.path];
        count(agentOnly ? 'reject agent-only done' : 'reject file done');
      } else {
        count(`reject file ${result.status}`);
      }
    } else if (roll < 0.9) {
      const entry = pickOf(pending);
      const hunks = await h.engine.hunks(h.key, entry.path);
      if (hunks.length === 0) continue;
      const hunk = pickOf(hunks);
      what = `reject hunk ${hunk.index}/${hunks.length} of ${entry.path}`;
      const result = await h.engine.rejectHunk(h.key, entry.path, hunk.id);
      if (result.status === 'done') {
        mayWrite = true;
        writes = [entry.path];
        count('reject hunk done');
      } else {
        count(`reject hunk ${result.status}`);
      }
    } else {
      what = 'reject all';
      const preview = await h.engine.previewRejectAll(h.key, []);
      expect(await h.listing(), 'a preview writes nothing').toEqual(before);
      const result = await h.engine.rejectAll(h.key, []);
      expect(
        [...result.rejected].sort(),
        `preview equals outcome, seed ${seed}, step ${step}`,
      ).toEqual([...preview.willReject].sort());
      expect(result.failed.map((f) => f.path).sort()).toEqual(
        preview.cannot.map((c) => c.path).sort(),
      );
      if (result.rejected.length > 0) {
        mayWrite = true;
        writes = result.rejected;
      }
      count('reject all');
    }
    log.push(what);

    // (1) Only a step that is allowed to write changes any file, and only the files it names.
    const after = await h.listing();
    const changed = new Set(
      Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]),
    );
    if (!mayWrite)
      expect([...changed], `no file may change: step ${step}, ${what}, seed ${seed}`).toEqual([]);
    else
      for (const path of changed) expect(writes, `${path} was not named: ${what}`).toContain(path);
    expect(
      Object.keys(after).filter((k) => !FILES.includes(k)),
      'no stray files',
    ).toEqual([]);

    await check(step, what);
  }

  // Everything that is left can be rejected or accepted without surprises, and a new engine agrees.
  expect(await h.newEngine().entries(h.key)).toEqual(await h.entries());
  return { log, counts };
}

describe('review: random sequences', () => {
  it('never changes a file except by a successful reject, and never loses the user marker lines', async () => {
    const { counts } = await runSteps(20260211, 150);
    // The run has to have exercised the interesting steps.
    expect(counts['turn']).toBeGreaterThan(10);
    expect(counts['user edit']).toBeGreaterThan(3);
    expect(counts['reject file done']).toBeGreaterThan(3);
    expect(counts['reject hunk done'] ?? 0).toBeGreaterThan(0);
    expect(counts['accept file']).toBeGreaterThan(0);
    expect(counts['reject all']).toBeGreaterThan(0);
  }, 120_000);

  it('holds for other seeds too, with agent-only rejects and failing log appends', async () => {
    const total: Record<string, number> = {};
    for (const seed of [7, 8, 9]) {
      const { counts } = await runSteps(seed, 150);
      for (const [key, value] of Object.entries(counts)) total[key] = (total[key] ?? 0) + value;
    }
    expect(total['reject failing append']).toBeGreaterThan(0);
    expect(total['reject agent-only done']).toBeGreaterThan(0);
  }, 240_000);

  // More seeds when hunting: REVIEW_PROP_SEEDS=100 runs seeds 1 to 100.
  const extra = Number(process.env['REVIEW_PROP_SEEDS'] ?? 0);
  for (let seed = 1; seed <= extra; seed += 1) {
    it(`holds for seed ${seed}`, async () => {
      await runSteps(seed, 150);
    }, 120_000);
  }
});
