import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSY_MESSAGE, INTERRUPTED_NOTE } from './tracker';
import { Turn, makeEnv, openWorkspace, operations, sha, sleep, type Env } from './test-support';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

function journalFile(): string {
  return join(env.storage, env.folder.key, 'journal.json');
}

async function writeJournal(overrides: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(
    journalFile(),
    JSON.stringify({
      turnId: 'turn-dead',
      conversationId: 'conv-1',
      startedAt: Date.now() - 10_000,
      lastActivityAt: Date.now(),
      pid: null,
      ...overrides,
    }),
  );
}

/** A first run that saved its index and then went away, as a crashed one would. */
async function firstRun(files: Record<string, string>): Promise<void> {
  await env.write(files);
  const tracker = env.tracker();
  const ws = await openWorkspace(tracker, env);
  await ws.sync(env.settings);
  await tracker.dispose();
}

describe('recover', () => {
  it('does nothing without a journal', async () => {
    const tracker = env.tracker();
    await expect(tracker.recover(env.folder, env.settings)).resolves.toEqual({
      recovered: false,
      notes: [],
    });
  });

  it('turns a dead run’s changes into a recovery operation: after-interruption only for late files', async () => {
    await firstRun({ 'early.txt': 'e', 'late.txt': 'l', 'gone.txt': 'g', 'quiet.txt': 'q' });
    await fs.writeFile(env.abs('early.txt'), 'e2');
    await fs.rm(env.abs('gone.txt'));
    await writeJournal({ lastActivityAt: Date.now(), pid: 999_999 });
    await sleep(2300);
    await fs.writeFile(env.abs('late.txt'), 'l2');
    await fs.writeFile(env.abs('created.txt'), 'c');

    const tracker = env.tracker({ isProcessAlive: () => false });
    const result = await tracker.recover(env.folder, env.settings);
    expect(result).toEqual({ recovered: true, notes: [INTERRUPTED_NOTE] });
    expect(INTERRUPTED_NOTE).toBe(
      'AgentCanopy was closed while this turn was running, so it cannot tell which of these changes the agent made.',
    );

    const ws = tracker.folder(env.folder.key)!;
    const [op] = operations(ws);
    expect(op).toMatchObject({
      kind: 'recovery',
      status: 'interrupted',
      turnId: 'turn-dead',
      conversationId: 'conv-1',
      notes: [INTERRUPTED_NOTE],
    });
    const byPath = new Map(op!.changes.map((c) => [c.path, c.attribution]));
    expect(Object.fromEntries(byPath)).toEqual({
      'created.txt': 'after-interruption',
      'early.txt': 'unattributed',
      'gone.txt': 'unattributed',
      'late.txt': 'after-interruption',
    });
    const early = op!.changes.find((c) => c.path === 'early.txt')!;
    expect((await ws.blobs.get((early.before as { hash: string }).hash)).toString()).toBe('e');
    expect(ws.busy()).toBe(false);
    await expect(fs.access(journalFile())).rejects.toThrow();
    expect(ws.index().get('late.txt')?.hash).toBe(sha('l2'));

    // A second call finds nothing more.
    await expect(tracker.recover(env.folder, env.settings)).resolves.toEqual({
      recovered: false,
      notes: [],
    });
  }, 15_000);

  it('records no operation when nothing changed, but still recovers', async () => {
    await firstRun({ 'a.txt': 'a' });
    await writeJournal();
    const tracker = env.tracker({ isProcessAlive: () => false });
    await expect(tracker.recover(env.folder, env.settings)).resolves.toEqual({
      recovered: true,
      notes: [],
    });
    expect(operations(tracker.folder(env.folder.key)!)).toEqual([]);
  });

  it('a corrupt journal is still recovered, with nothing blamed on the interruption', async () => {
    await firstRun({ 'a.txt': 'a' });
    await fs.writeFile(env.abs('a.txt'), 'changed after');
    await fs.writeFile(journalFile(), '{not json');
    const tracker = env.tracker({ isProcessAlive: () => false });
    const result = await tracker.recover(env.folder, env.settings);
    expect(result.recovered).toBe(true);
    const [op] = operations(tracker.folder(env.folder.key)!);
    expect(op?.changes[0]?.attribution).toBe('unattributed');
  });

  it('does not record a change twice when the operation was logged but the index was not saved', async () => {
    await env.write({ 'a.txt': 'a' });
    const first = env.tracker();
    const ws = await openWorkspace(first, env);
    await ws.sync(env.settings);
    const turn = new Turn(first, env);
    await turn.begin();
    await turn.edit('a.txt', 'a2');
    await turn.end();
    await first.dispose();
    // As if the run died after appending the operation, before saving the index and removing the journal.
    await fs.rm(join(env.storage, env.folder.key, 'index.json'));
    await writeJournal();
    const second = env.tracker({ isProcessAlive: () => false });
    const result = await second.recover(env.folder, env.settings);
    expect(result.recovered).toBe(true);
    // With no index at all every path is "added"; the already-logged change is not repeated.
    expect(operations(second.folder(env.folder.key)!)).toHaveLength(1);
  });
});

describe('recover with a process that may still be running', () => {
  it('stops a live process whose start time matches, then recovers', async () => {
    await firstRun({ 'a.txt': 'a' });
    await fs.writeFile(env.abs('a.txt'), 'a2');
    await writeJournal({ pid: 4242, processStart: 'Mon Nov 10 10:00:00 2026' });
    let alive = true;
    const stopProcess = vi.fn(() => {
      alive = false;
      return Promise.resolve(true);
    });
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242 && alive,
      processStartTime: () => Promise.resolve('Mon Nov 10 10:00:00 2026'),
      stopProcess,
    });
    const result = await tracker.recover(env.folder, env.settings);
    expect(stopProcess).toHaveBeenCalledExactlyOnceWith(4242);
    expect(result.recovered).toBe(true);
    expect(tracker.folder(env.folder.key)!.busy()).toBe(false);
  });

  it('fails and keeps the folder busy when the process is still alive afterwards', async () => {
    await firstRun({ 'a.txt': 'a' });
    await writeJournal({ pid: 4242, processStart: 'S' });
    const stopProcess = vi.fn(() => Promise.resolve(false));
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242,
      processStartTime: () => Promise.resolve('S'),
      stopProcess,
    });
    const result = await tracker.recover(env.folder, env.settings);
    expect(result).toEqual({
      recovered: false,
      notes: [
        'Claude Code from an interrupted turn is still running (process 4242). Stop it, then reload the window.',
      ],
    });
    const ws = tracker.folder(env.folder.key)!;
    expect(ws.busy()).toBe(true);
    await expect(fs.access(journalFile())).resolves.toBeUndefined();
    await expect(new Turn(tracker, env).begin()).rejects.toThrow(BUSY_MESSAGE);
    // Sync does nothing either: the index stays as it was at the turn's start.
    await fs.writeFile(env.abs('a.txt'), 'changed');
    await ws.sync(env.settings);
    expect(ws.index().get('a.txt')?.hash).toBe(sha('a'));
  });

  it('never signals anything without a stopProcess', async () => {
    await firstRun({ 'a.txt': 'a' });
    await writeJournal({ pid: 4242, processStart: 'S' });
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242,
      processStartTime: () => Promise.resolve('S'),
    });
    const result = await tracker.recover(env.folder, env.settings);
    expect(result.recovered).toBe(false);
    expect(result.notes[0]).toContain('process 4242');
  });

  it('does not stop an unrelated process that reuses the pid', async () => {
    await firstRun({ 'a.txt': 'a' });
    await writeJournal({ pid: 4242, processStart: 'the old process' });
    const stopProcess = vi.fn(() => Promise.resolve(true));
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242,
      processStartTime: () => Promise.resolve('someone else entirely'),
      stopProcess,
    });
    const result = await tracker.recover(env.folder, env.settings);
    expect(stopProcess).not.toHaveBeenCalled();
    expect(result.recovered).toBe(true);
  });

  it('does not stop a live process whose start time was never recorded', async () => {
    await firstRun({ 'a.txt': 'a' });
    await writeJournal({ pid: 4242 });
    const stopProcess = vi.fn(() => Promise.resolve(true));
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242,
      processStartTime: () => Promise.resolve('S'),
      stopProcess,
    });
    const result = await tracker.recover(env.folder, env.settings);
    expect(stopProcess).not.toHaveBeenCalled();
    // Nothing can tell it from another process, so it may still be running: no recovery without force.
    expect(result.recovered).toBe(false);
    expect(tracker.folder(env.folder.key)!.busy()).toBe(true);
  });

  it('a leftover journal blocks a new turn until it is recovered', async () => {
    await firstRun({ 'a.txt': 'a' });
    await writeJournal();
    const tracker = env.tracker({ isProcessAlive: () => false });
    await expect(new Turn(tracker, env).begin()).rejects.toThrow(BUSY_MESSAGE);
    await tracker.recover(env.folder, env.settings);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.end();
  });

  it('does not touch a turn that is running in this very process', async () => {
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await expect(tracker.recover(env.folder, env.settings)).resolves.toEqual({
      recovered: false,
      notes: [],
    });
    expect(tracker.folder(env.folder.key)!.busy()).toBe(true);
    await turn.end();
  });

  it('a turn cut off by dispose is recovered by the next tracker', async () => {
    await env.write({ 'a.txt': 'a' });
    const first = env.tracker();
    await openWorkspace(first, env);
    const turn = new Turn(first, env);
    await turn.begin();
    await env.write({ 'a.txt': 'edited by the dying agent' });
    await first.dispose();

    const second = env.tracker({ isProcessAlive: () => false });
    const result = await second.recover(env.folder, env.settings);
    expect(result.recovered).toBe(true);
    const [op] = operations(second.folder(env.folder.key)!);
    expect(op?.kind).toBe('recovery');
    expect(op?.turnId).toBe(turn.ctx.turnId);
    expect(op?.changes.map((c) => c.path)).toEqual(['a.txt']);
  });
});
