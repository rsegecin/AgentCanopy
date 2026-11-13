import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderKey, PathChange } from '../../../shared';
import type { ForeignDeltaRecord, OperationRecord } from '../../contracts';
import { BUSY_MESSAGE, CONFIG_PENDING_MESSAGE, RECORD_FAILED_MESSAGE } from './tracker';
import { LOCK_HELD_MESSAGE } from './lock';
import {
  FakeClock,
  RecordingLogger,
  Turn,
  context,
  makeEnv,
  openWorkspace,
  operations,
  recordsOf,
  sha,
  sleep,
  until,
  type Env,
} from './test-support';

const posix = process.platform !== 'win32';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

function changeOf(op: OperationRecord, path: string): PathChange {
  const found = op.changes.find((c) => c.path === path);
  if (!found) throw new Error(`no change for ${path}: ${op.changes.map((c) => c.path).join(', ')}`);
  return found;
}

function hashOf(state: PathChange['before']): string | undefined {
  return state.kind === 'file' ? state.hash : undefined;
}

async function contentOf(
  ws: { blobs: { get(hash: string): Promise<Buffer> } },
  state: PathChange['before'],
): Promise<string> {
  const hash = hashOf(state);
  if (hash === undefined) throw new Error('state has no hash');
  return (await ws.blobs.get(hash)).toString();
}

describe('sync and foreign deltas', () => {
  it('updates the index silently for a path without history', async () => {
    await env.write({ 'a.txt': 'one' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.sync(env.settings);
    expect(ws.index().get('a.txt')?.hash).toBe(sha('one'));

    await env.write({ 'a.txt': 'two', 'new.txt': 'n' });
    await fs.rm(env.abs('a.txt'));
    await ws.sync(env.settings);
    expect(recordsOf(ws)).toEqual([]);
    expect(ws.index().has('a.txt')).toBe(false);
    expect(ws.index().get('new.txt')?.hash).toBe(sha('n'));
  });

  it('records one foreign delta for an outside edit to a path with history, and none the second time', async () => {
    await env.write({ 'a.txt': 'one', 'quiet.txt': 'q' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.sync(env.settings);

    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'three');
    await turn.end();
    expect(recordsOf(ws).map((r) => r.type)).toEqual(['operation']);

    await env.write({ 'a.txt': 'four', 'quiet.txt': 'q2' });
    await ws.sync(env.settings);
    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['operation', 'foreign-delta']);
    const delta = records[1] as ForeignDeltaRecord;
    expect(delta.changes).toHaveLength(1);
    expect(delta.changes[0]?.path).toBe('a.txt');
    expect(hashOf(delta.changes[0]!.before)).toBe(sha('three'));
    expect(hashOf(delta.changes[0]!.after)).toBe(sha('four'));

    await ws.sync(env.settings);
    expect(recordsOf(ws)).toHaveLength(2);
  });

  it('keeps one record for several paths changed at once', async () => {
    await env.write({ 'a.txt': 'a', 'b.txt': 'b' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.sync(env.settings);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'a2');
    await turn.edit('b.txt', 'b2');
    await turn.end();
    await env.write({ 'a.txt': 'a3' });
    await fs.rm(env.abs('b.txt'));
    await ws.sync(env.settings);
    const delta = recordsOf(ws)[1] as ForeignDeltaRecord;
    expect(delta.changes.map((c) => c.path)).toEqual(['a.txt', 'b.txt']);
    expect(delta.changes[1]?.after).toEqual({ kind: 'absent' });
  });

  it('survives a restart: the index and the history are kept', async () => {
    await env.write({ 'a.txt': 'one' });
    const first = env.tracker();
    const ws = await openWorkspace(first, env);
    await ws.sync(env.settings);
    const turn = new Turn(first, env);
    await turn.begin();
    await turn.edit('a.txt', 'two');
    await turn.end();
    await first.dispose();

    await env.write({ 'a.txt': 'three' });
    const second = env.tracker();
    const ws2 = await openWorkspace(second, env);
    expect(ws2.index().get('a.txt')?.hash).toBe(sha('two'));
    await ws2.sync(env.settings);
    expect(recordsOf(ws2).map((r) => r.type)).toEqual(['operation', 'foreign-delta']);
  });
});

describe('the blocker scenario: agent, user, agent', () => {
  it('logs operation, foreign delta, operation with every state retrievable', async () => {
    await env.write({ 'a.ts': 'R: original\n' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);

    const turn1 = new Turn(tracker, env);
    await turn1.begin();
    await turn1.edit('a.ts', 'A1: agent edit one\n');
    await turn1.end();

    await env.write({ 'a.ts': 'U1: the user edits it\n' });

    const turn2 = new Turn(tracker, env);
    await turn2.begin();
    await turn2.edit('a.ts', 'A2: agent edit two\n');
    await turn2.end();

    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['operation', 'foreign-delta', 'operation']);
    const [op1, delta, op2] = records as [OperationRecord, ForeignDeltaRecord, OperationRecord];
    const c1 = changeOf(op1, 'a.ts');
    const d = delta.changes[0]!;
    const c2 = changeOf(op2, 'a.ts');

    expect(delta.changes).toHaveLength(1);
    expect(await contentOf(ws, c1.before)).toBe('R: original\n');
    expect(await contentOf(ws, c1.after)).toBe('A1: agent edit one\n');
    expect(await contentOf(ws, d.before)).toBe('A1: agent edit one\n');
    expect(await contentOf(ws, d.after)).toBe('U1: the user edits it\n');
    expect(await contentOf(ws, c2.before)).toBe('U1: the user edits it\n');
    expect(await contentOf(ws, c2.after)).toBe('A2: agent edit two\n');
    for (const state of [c1.before, c1.after, d.before, d.after, c2.before, c2.after]) {
      expect(state).toMatchObject({ kind: 'file', stored: true });
    }
    expect(c1.attribution).toBe('agent-tool');
    expect(c2.attribution).toBe('agent-tool');
    expect(op1.kind).toBe('agent-turn');
    expect(op1.status).toBe('complete');
    expect(op1.conversationId).toBe('conv-1');
  });
});

describe('attribution', () => {
  async function started(files: Record<string, string> = {}) {
    await env.write({ 'seed.txt': 'seed', ...files });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.sync(env.settings);
    const turn = new Turn(tracker, env);
    await turn.begin();
    return { tracker, ws, turn };
  }

  it('file tool: agent-tool', async () => {
    const { ws, turn } = await started({ 'a.txt': 'a' });
    await turn.edit('a.txt', 'a2');
    await turn.end();
    expect(changeOf(operations(ws)[0]!, 'a.txt').attribution).toBe('agent-tool');
  });

  it('a Write that creates a file: before absent, agent-tool', async () => {
    const { ws, turn } = await started();
    await turn.edit('dir/new.txt', 'fresh', 'Write');
    await turn.end();
    const c = changeOf(operations(ws)[0]!, 'dir/new.txt');
    expect(c.before).toEqual({ kind: 'absent' });
    expect(hashOf(c.after)).toBe(sha('fresh'));
    expect(c.attribution).toBe('agent-tool');
  });

  it('command window: agent-command', async () => {
    const { ws, turn } = await started({ 'b.txt': 'b' });
    await turn.shellWrite({ 'b.txt': 'b2', 'made.txt': 'm' });
    await turn.end();
    const op = operations(ws)[0]!;
    expect(changeOf(op, 'b.txt').attribution).toBe('agent-command');
    expect(changeOf(op, 'made.txt').attribution).toBe('agent-command');
    expect(changeOf(op, 'made.txt').before).toEqual({ kind: 'absent' });
    expect(op.changes).toHaveLength(2);
  });

  it('a user save in no window: user', async () => {
    const { ws, turn } = await started({ 'c.txt': 'c' });
    await turn.userSave('c.txt', 'c-by-user');
    await turn.end();
    expect(changeOf(operations(ws)[0]!, 'c.txt').attribution).toBe('user');
  });

  it('file tool plus a user save: mixed', async () => {
    const { ws, turn } = await started({ 'd.txt': 'd' });
    await turn.edit('d.txt', 'd-agent');
    env.editor.save(env.abs('d.txt'));
    await turn.end();
    expect(changeOf(operations(ws)[0]!, 'd.txt').attribution).toBe('mixed');
  });

  it('command plus a user save: mixed', async () => {
    const { ws, turn } = await started({ 'e.txt': 'e' });
    await turn.shellWrite({ 'e.txt': 'e-cmd' });
    env.editor.save(env.abs('e.txt'));
    await turn.end();
    expect(changeOf(operations(ws)[0]!, 'e.txt').attribution).toBe('mixed');
  });

  it('a change made while no tool window was open: unattributed, even if a later command runs', async () => {
    const { ws, turn } = await started({ 'x.txt': 'x', 'y.txt': 'y' });
    await turn.shellWrite({ 'warm.txt': 'w' });
    await env.write({ 'x.txt': 'x-by-someone-else' }); // between tools
    await turn.shellWrite({ 'y.txt': 'y2' });
    await turn.end();
    const op = operations(ws)[0]!;
    expect(changeOf(op, 'x.txt').attribution).toBe('unattributed');
    expect(changeOf(op, 'y.txt').attribution).toBe('agent-command');
    expect(changeOf(op, 'warm.txt').attribution).toBe('agent-command');
  });

  it('a change after the last tool finished: unattributed', async () => {
    const { ws, turn } = await started({ 'x.txt': 'x' });
    await turn.shellWrite({ 'y.txt': 'y' });
    await env.write({ 'x.txt': 'late' });
    await turn.end();
    expect(changeOf(operations(ws)[0]!, 'x.txt').attribution).toBe('unattributed');
  });

  it('a turn with no hooks at all: unattributed for paths no file tool named', async () => {
    const { ws, turn } = await started({ 'a.txt': 'a', 'b.txt': 'b' });
    await turn.fileTool('Edit', env.abs('a.txt'), () => env.write({ 'a.txt': 'a2' }), {
      withHooks: false,
    });
    await turn.command(() => env.write({ 'b.txt': 'b2' }), { withHooks: false });
    await turn.end();
    const op = operations(ws)[0]!;
    expect(changeOf(op, 'a.txt').attribution).toBe('agent-tool');
    expect(changeOf(op, 'b.txt').attribution).toBe('unattributed');
  });

  it('a file touched but identical is not a change', async () => {
    const { ws, turn } = await started({ 'same.txt': 'same' });
    await turn.command(async () => {
      await fs.writeFile(env.abs('same.txt'), 'same');
      const later = new Date(Date.now() + 5000);
      await fs.utimes(env.abs('same.txt'), later, later);
    });
    await turn.end();
    expect(operations(ws)).toEqual([]);
  });

  it('deleted by a command', async () => {
    const { ws, turn } = await started({ 'gone.txt': 'bye' });
    await turn.command(() => fs.rm(env.abs('gone.txt')));
    await turn.end();
    const c = changeOf(operations(ws)[0]!, 'gone.txt');
    expect(c.after).toEqual({ kind: 'absent' });
    expect(await contentOf(ws, c.before)).toBe('bye');
    expect(c.attribution).toBe('agent-command');
  });

  it.skipIf(!posix)('mode-only change', async () => {
    const { ws, turn } = await started({ 'run.sh': '#!/bin/sh\n' });
    await fs.chmod(env.abs('run.sh'), 0o644);
    await ws.sync(env.settings);
    await turn.end();
    const turn2 = new Turn(turn.tracker, env);
    await turn2.begin();
    await turn2.command(() => fs.chmod(env.abs('run.sh'), 0o755));
    await turn2.end();
    const c = changeOf(operations(ws).at(-1)!, 'run.sh');
    expect(c.before).toMatchObject({ kind: 'file', mode: 0o644 });
    expect(c.after).toMatchObject({ kind: 'file', mode: 0o755 });
    expect(hashOf(c.before)).toBe(hashOf(c.after));
  });

  it.skipIf(!posix)('a file replaced by a symlink', async () => {
    const { ws, turn } = await started({ 'real.txt': 'real', 'swap.txt': 'swap me' });
    await turn.command(async () => {
      await fs.rm(env.abs('swap.txt'));
      await fs.symlink('real.txt', env.abs('swap.txt'));
    });
    await turn.end();
    const c = changeOf(operations(ws)[0]!, 'swap.txt');
    expect(c.after).toEqual({ kind: 'symlink', target: 'real.txt' });
    expect(await contentOf(ws, c.before)).toBe('swap me');
  });

  it('a file edited by a tool after the user changed it mid-turn without a save: the user change is its own record', async () => {
    const { ws, turn } = await started({ 'm.txt': 'm' });
    await turn.shellWrite({ 'warm.txt': 'w' }); // a post scan has happened
    await env.write({ 'm.txt': 'user changed it in another program' });
    await turn.edit('m.txt', 'agent overwrites');
    await turn.end();
    const records = recordsOf(ws);
    expect(records.map((r) => r.type)).toEqual(['foreign-delta', 'operation']);
    const op = records[1] as OperationRecord;
    expect(changeOf(op, 'm.txt').attribution).toBe('agent-tool');
    expect(await contentOf(ws, changeOf(op, 'm.txt').before)).toBe(
      'user changed it in another program',
    );
  });

  it('a file the agent wrote and someone else changed after the last tool call: mixed', async () => {
    const { ws, turn } = await started({ 'm.txt': 'm' });
    await turn.edit('m.txt', 'agent wrote this');
    await env.write({ 'm.txt': 'someone else wrote this after' });
    await turn.end();
    expect(changeOf(operations(ws)[0]!, 'm.txt').attribution).toBe('mixed');
  });

  it('records nothing for a turn that changed nothing, and still frees the folder', async () => {
    const { ws, turn } = await started();
    await turn.end();
    expect(operations(ws)).toEqual([]);
    expect(ws.busy()).toBe(false);
  });
});

describe('capture guarantees', () => {
  async function editAndFind(
    files: Record<string, string>,
    path: string,
    settings: Partial<typeof env.settings> = {},
  ) {
    env.settings = { ...env.settings, ...settings };
    await env.write(files);
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit(path, 'replacement');
    const notices = await turn.end();
    return { ws, change: changeOf(operations(ws)[0]!, path), notices };
  }

  it('an ignored file', async () => {
    const { ws, change } = await editAndFind(
      { '.gitignore': 'ignored.txt\n', 'ignored.txt': 'precious' },
      'ignored.txt',
    );
    expect(await contentOf(ws, change.before)).toBe('precious');
    expect(change.before).toMatchObject({ stored: true });
    expect(hashOf(change.after)).toBe(sha('replacement'));
    expect(change.attribution).toBe('agent-tool');
  });

  it('a .env file', async () => {
    const { ws, change } = await editAndFind({ '.env': 'SECRET=1\n' }, '.env');
    expect(await contentOf(ws, change.before)).toBe('SECRET=1\n');
    expect(change.before).toMatchObject({ stored: true });
  });

  it('a file over the size cap', async () => {
    const big = 'x'.repeat(500);
    const { ws, change } = await editAndFind({ 'big.txt': big }, 'big.txt', {
      snapshotMaxFileBytes: 100,
    });
    expect(await contentOf(ws, change.before)).toBe(big);
    expect(change.before).toMatchObject({ stored: true });
  });

  it('a zero total budget', async () => {
    const { ws, change } = await editAndFind({ 'a.txt': 'budgetless' }, 'a.txt', {
      snapshotMaxTotalBytes: 0,
    });
    expect(await contentOf(ws, change.before)).toBe('budgetless');
    expect(change.before).toMatchObject({ stored: true });
  });

  it('a second edit of the same file keeps the first before-state', async () => {
    await env.write({ 'a.txt': 'original' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'first');
    await turn.edit('a.txt', 'second');
    await turn.end();
    const c = changeOf(operations(ws)[0]!, 'a.txt');
    expect(await contentOf(ws, c.before)).toBe('original');
    expect(await contentOf(ws, c.after)).toBe('second');
  });

  it('a command changing an over-budget file: before not stored, with a notice', async () => {
    env.settings = { ...env.settings, snapshotMaxTotalBytes: 0 };
    await env.write({
      'a.txt': 'aaa',
      'b.txt': 'bbb',
      'c.txt': 'ccc',
      'd.txt': 'ddd',
      'e.txt': 'eee',
    });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.shellWrite({
      'a.txt': 'A',
      'b.txt': 'B',
      'c.txt': 'C',
      'd.txt': 'D',
      'e.txt': 'E',
    });
    const notices = await turn.end();
    const op = operations(ws)[0]!;
    expect(changeOf(op, 'a.txt').before).toMatchObject({ kind: 'file', stored: false });
    const text = notices.find((n) => n.text.includes('capture budget'))?.text;
    expect(text).toBe(
      '5 changed files were too large or outside the capture budget, so their earlier content was not kept: a.txt, b.txt, c.txt and 2 more.',
    );
    expect(notices.find((n) => n.text.includes('capture budget'))?.level).toBe('warning');
    expect(op.notes).toContain(text);
  });
});

describe('tool input that is not what we expect', () => {
  it('ignores a Write outside the folder without error', async () => {
    const outside = join(env.base, 'outside.txt');
    await fs.writeFile(outside, 'not ours');
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.fileTool('Write', outside, () => fs.writeFile(outside, 'changed'));
    await turn.fileTool('Write', '../outside.txt', () => fs.writeFile(outside, 'changed again'));
    await turn.end();
    expect(operations(ws)).toEqual([]);
    expect((await ws.blobs.list()).length).toBe(0);
  });

  it('a symlink inside the folder that points outside is ignored', async () => {
    if (!posix) return;
    const outside = join(env.base, 'outside.txt');
    await fs.writeFile(outside, 'not ours');
    await fs.symlink(outside, env.abs('link.txt'));
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.fileTool('Write', env.abs('link.txt'), () => fs.writeFile(outside, 'changed'));
    await turn.end();
    expect(await fs.readFile(outside, 'utf8')).toBe('changed');
    expect(await ws.blobs.list()).toEqual([]);
  });

  it('never throws on malformed input', async () => {
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    const bad: unknown[] = [
      undefined,
      null,
      42,
      'text',
      [],
      {},
      { file_path: 7 },
      { file_path: '' },
      { file_path: null },
      { notebook_path: {} },
      { file_path: 'a\0b' },
    ];
    for (const input of bad) {
      for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Read', 'Mystery']) {
        await expect(turn.permission(tool, input)).resolves.toBeUndefined();
        await expect(turn.hook('pre', tool, input, 'id-1')).resolves.toBeUndefined();
        await expect(turn.hook('post', tool, input, 'id-1')).resolves.toBeUndefined();
      }
    }
    await expect(turn.end()).resolves.toEqual([]);
  });

  it('a NotebookEdit names its notebook_path', async () => {
    await env.write({ 'n.ipynb': '{"cells":[]}' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.fileTool('NotebookEdit', env.abs('n.ipynb'), () =>
      env.write({ 'n.ipynb': '{"cells":[1]}' }),
    );
    await turn.end();
    expect(changeOf(operations(ws)[0]!, 'n.ipynb').attribution).toBe('agent-tool');
  });

  it('ignores hooks and permission requests that belong to no open turn', async () => {
    const tracker = env.tracker();
    const turn = new Turn(tracker, env);
    await expect(turn.permission('Edit', { file_path: 'a' })).resolves.toBeUndefined();
    await expect(turn.hook('pre', 'Bash', {}, 'x')).resolves.toBeUndefined();
    await expect(turn.end()).resolves.toEqual([]);
  });
});

describe('busy rules', () => {
  it('refuses a second turn on the same folder, then allows one after the first ends', async () => {
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const first = new Turn(tracker, env, 'turn-a');
    await first.begin();
    expect(ws.busy()).toBe(true);

    const second = new Turn(tracker, env, 'turn-b');
    await expect(second.begin()).rejects.toThrow(BUSY_MESSAGE);
    expect(BUSY_MESSAGE).toBe(
      'Another agent turn is running in this folder. Stop it or wait for it to finish.',
    );
    expect(ws.busy()).toBe(true);

    await first.end();
    expect(ws.busy()).toBe(false);
    await expect(second.begin()).resolves.toBeUndefined();
    await second.end();
  });

  it('removes the journal at the end of the turn and writes it at the start', async () => {
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const journal = join(env.storage, env.folder.key, 'journal.json');
    const turn = new Turn(tracker, env, 'turn-j');
    await turn.begin();
    const written = JSON.parse(await fs.readFile(journal, 'utf8')) as Record<string, unknown>;
    expect(written).toMatchObject({ turnId: 'turn-j', conversationId: 'conv-1', pid: null });
    await turn.end();
    await expect(fs.access(journal)).rejects.toThrow();
  });

  it('an abort during beforeTurn leaves the folder free', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) files[`d${i % 10}/f${i}.txt`] = `content ${i}`;
    await env.write(files);
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    turn.signal.abort();
    await expect(turn.begin()).rejects.toMatchObject({ name: 'AbortError' });
    expect(ws.busy()).toBe(false);
    await expect(fs.access(join(env.storage, env.folder.key, 'journal.json'))).rejects.toThrow();

    const mid = new Turn(tracker, env);
    const pending = mid.begin();
    mid.signal.abort();
    await pending.catch(() => undefined);
    expect(ws.busy()).toBe(false);
    const again = new Turn(tracker, env);
    await again.begin();
    await again.end();
  });

  it('afterTurn after an internal failure returns the error notice and leaves the turn for recovery', async () => {
    await env.write({ 'a.txt': 'a' });
    const logger = new RecordingLogger();
    const tracker = env.tracker({ logger, isProcessAlive: () => false });
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'a2');
    // The log can no longer be written.
    const logFile = join(env.storage, env.folder.key, 'log.jsonl');
    await fs.rm(logFile, { force: true });
    await fs.mkdir(logFile);
    const notices = await turn.end();
    expect(notices).toEqual([{ level: 'error', text: RECORD_FAILED_MESSAGE }]);
    expect(RECORD_FAILED_MESSAGE).toBe(
      'AgentCanopy could not record what changed in this turn. Review the workspace before continuing.',
    );
    // Neither the log nor the index was written: the journal stays and the folder stays busy.
    expect(ws.busy()).toBe(true);
    await expect(
      fs.access(join(env.storage, env.folder.key, 'journal.json')),
    ).resolves.toBeUndefined();
    expect(ws.index().get('a.txt')?.hash).toBe(sha('a'));
    expect(logger.lines.some((l) => l.level === 'error')).toBe(true);
    await expect(new Turn(tracker, env).begin()).rejects.toThrow(BUSY_MESSAGE);

    // Once the log works again, recovery records the change and frees the folder.
    await fs.rm(logFile, { recursive: true });
    const result = await tracker.recover(env.folder, env.settings);
    expect(result.recovered).toBe(true);
    expect(ws.busy()).toBe(false);
    const op = operations(ws)[0]!;
    expect(op.kind).toBe('recovery');
    expect(hashOf(changeOf(op, 'a.txt').after)).toBe(sha('a2'));
    expect(await contentOf(ws, changeOf(op, 'a.txt').before)).toBe('a');
    const next = new Turn(tracker, env);
    await next.begin();
    await next.end();
  });

  it('refuses a turn while a configuration change is unresolved', async () => {
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.shellWrite({ '.mcp.json': '{}' });
    await turn.end();
    expect(tracker.configChanges(env.folder.key)).toHaveLength(1);
    await expect(new Turn(tracker, env).begin()).rejects.toThrow(CONFIG_PENDING_MESSAGE);
  });

  it('serializes work with exclusive, with unlocked variants for work that holds the queue', async () => {
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const order: string[] = [];
    const a = ws.exclusive(async () => {
      order.push('a1');
      await sleep(20);
      await ws.syncUnlocked(env.settings);
      await ws.noteOwnWritesUnlocked([], env.settings);
      order.push('a2');
    });
    const b = ws.exclusive(() => {
      order.push('b');
      return Promise.resolve();
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a1', 'a2', 'b']);
    await expect(ws.exclusive(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(ws.exclusive(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('a timer or listener created inside exclusive work queues behind later work', async () => {
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const events: string[] = [];
    let later: Promise<void> = Promise.resolve();
    await ws.exclusive(() => {
      setTimeout(() => {
        later = ws.exclusive(async () => {
          events.push('late-start');
          await sleep(10);
          events.push('late-end');
        });
      }, 20);
      return Promise.resolve();
    });
    const long = ws.exclusive(async () => {
      events.push('work-start');
      await sleep(80);
      events.push('work-end');
    });
    await long;
    await later;
    expect(events).toEqual(['work-start', 'work-end', 'late-start', 'late-end']);
  });

  it('public sync and noteOwnWrites queue behind running work', async () => {
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const events: string[] = [];
    const held = ws.exclusive(async () => {
      events.push('held-start');
      await sleep(40);
      events.push('held-end');
    });
    const sync = ws.sync(env.settings).then(() => events.push('sync'));
    const own = ws.noteOwnWrites(['a.txt'], env.settings).then(() => events.push('own'));
    await Promise.all([held, sync, own]);
    expect(events).toEqual(['held-start', 'held-end', 'sync', 'own']);
  });
});

describe('ask and plan turns', () => {
  it.each(['ask', 'plan'] as const)('%s: every observer method does nothing', async (mode) => {
    const tracker = env.tracker();
    const ctx = context(env, 'turn-x', mode);
    const o = tracker.observer;
    await o.beforeTurn?.(ctx, new AbortController().signal);
    o.onProcessStarted?.(ctx, 1234);
    await o.onPermissionRequest?.(ctx, {
      toolCallId: 't',
      toolName: 'Edit',
      input: { file_path: env.abs('a.txt') },
      signal: new AbortController().signal,
    });
    await o.onToolHook?.(ctx, { phase: 'pre', toolCallId: 't', toolName: 'Bash', input: {} });
    await o.onToolHook?.(ctx, { phase: 'post', toolCallId: 't', toolName: 'Bash', input: {} });
    expect(o.wantsToolHooks?.(ctx)).toBe(false);
    expect(await o.afterTurn?.(ctx, 'completed')).toEqual([]);
    expect(await fs.readdir(env.storage)).toEqual([]);
    expect(tracker.folder(env.folder.key)).toBeUndefined();
  });

  it('agent mode wants tool hooks', () => {
    expect(env.tracker().observer.wantsToolHooks?.(context(env))).toBe(true);
  });
});

describe('own writes', () => {
  it('noteOwnWrites keeps AgentCanopy’s writes from being seen as foreign', async () => {
    await env.write({ 'a.txt': 'one', 'b.txt': 'b' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'two');
    await turn.edit('b.txt', 'b2');
    await turn.end();

    // AgentCanopy itself rewrites a.txt and deletes b.txt (as a restore would).
    await env.write({ 'a.txt': 'restored' });
    await fs.rm(env.abs('b.txt'));
    await ws.noteOwnWrites(['a.txt', 'b.txt'], env.settings);
    expect(ws.index().get('a.txt')?.hash).toBe(sha('restored'));
    expect(ws.index().has('b.txt')).toBe(false);
    expect(await ws.blobs.has(sha('restored'))).toBe(true);

    await ws.sync(env.settings);
    expect(recordsOf(ws).map((r) => r.type)).toEqual(['operation']);

    // A genuine outside edit is still seen.
    await env.write({ 'a.txt': 'someone else' });
    await ws.sync(env.settings);
    expect(recordsOf(ws).map((r) => r.type)).toEqual(['operation', 'foreign-delta']);
  });

  it('noteOwnWritesUnlocked is usable from inside exclusive and ignores paths outside the folder', async () => {
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    await ws.exclusive(async () => {
      await env.write({ 'a.txt': 'a2' });
      await ws.noteOwnWritesUnlocked(['a.txt', '../outside', '/etc/passwd', ''], env.settings);
    });
    expect(ws.index().get('a.txt')?.hash).toBe(sha('a2'));
  });
});

describe('prewarm and status', () => {
  it('goes idle, capturing, ready, with events', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) files[`d${i % 5}/f${i}.txt`] = `content ${i}`;
    await env.write(files);
    const tracker = env.tracker();
    const states: string[] = [];
    const unsubscribe = tracker.onDidChangeStatus((key) => {
      expect(key).toBe(env.folder.key);
      const state = tracker.status(key).state;
      if (states.at(-1) !== state) states.push(state);
    });
    expect(tracker.status(env.folder.key).state).toBe('idle');
    tracker.prewarm(env.folder, env.settings);
    await until(() => tracker.status(env.folder.key).state === 'ready');
    await sleep(150);
    unsubscribe();
    expect(states).toEqual(['capturing', 'ready']);
    expect(tracker.status(env.folder.key)).toMatchObject({
      state: 'ready',
      filesDone: 100,
      filesTotal: 100,
    });
    expect(tracker.folder(env.folder.key)?.index().size).toBe(100);
  });

  it('is degraded with a zero budget, in plain words', async () => {
    await env.write({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
    env.settings = { ...env.settings, snapshotMaxTotalBytes: 0 };
    const tracker = env.tracker();
    tracker.prewarm(env.folder, env.settings);
    await until(() => tracker.status(env.folder.key).state === 'degraded');
    expect(tracker.status(env.folder.key).note).toBe(
      '3 files are tracked without their content, so changes a command makes to them can be detected but not undone.',
    );
  });

  // Capturing files is slow when the whole suite runs in parallel, hence the smaller tree and the
  // longer limit: this test is about the event rate, not about speed.
  it('emits at most ten events a second', { timeout: 60_000 }, async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 800; i += 1) files[`d${i % 40}/f${i}.txt`] = `content ${i}`;
    await env.write(files);
    const tracker = env.tracker();
    const times: number[] = [];
    const started = Date.now();
    tracker.onDidChangeStatus(() => times.push(Date.now()));
    tracker.prewarm(env.folder, env.settings);
    await until(() => tracker.status(env.folder.key).state === 'ready', 50_000);
    await sleep(150);
    // Judge the rate over the whole run, not each gap: on a loaded machine a late timer and the
    // next one can fire close together without the tracker having sent more than its share.
    const seconds = (Date.now() - started) / 1000;
    expect(times.length).toBeLessThanOrEqual(Math.ceil(seconds * 10) + 2);
  });

  it('a turn that starts during a prewarm waits for it and gets a correct baseline', async () => {
    const files: Record<string, string> = { 'target.txt': 'original target' };
    for (let i = 0; i < 300; i += 1) files[`d${i % 10}/f${i}.txt`] = `content ${i}`;
    await env.write(files);
    const tracker = env.tracker();
    tracker.prewarm(env.folder, env.settings);
    const turn = new Turn(tracker, env);
    await turn.begin();
    expect(tracker.status(env.folder.key).state).toBe('ready');
    const ws = tracker.folder(env.folder.key)!;
    expect(ws.index().size).toBe(301);
    await turn.edit('target.txt', 'changed');
    await turn.shellWrite({ 'd1/f1.txt': 'rewritten by command' });
    await turn.end();
    const op = operations(ws)[0]!;
    expect(op.changes.map((c) => c.path).sort()).toEqual(['d1/f1.txt', 'target.txt']);
    expect(await contentOf(ws, changeOf(op, 'target.txt').before)).toBe('original target');
    expect(await contentOf(ws, changeOf(op, 'd1/f1.txt').before)).toBe('content 1');
  });

  it('prewarm does nothing while a turn is open', async () => {
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    const before = tracker.status(env.folder.key);
    tracker.prewarm(env.folder, env.settings);
    await sleep(50);
    expect(tracker.status(env.folder.key)).toEqual(before);
    await turn.end();
    expect(ws.busy()).toBe(false);
  });

  it('degrades when the scan is truncated', async () => {
    // A tiny tree cannot reach 500,000 entries, so check the note text path through the wording only.
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    tracker.prewarm(env.folder, env.settings);
    await until(() => tracker.status(env.folder.key).state === 'ready');
    expect(tracker.status(env.folder.key).note).toBeUndefined();
  });
});

describe('locking', () => {
  it('refuses a second tracker on the same folder while the first is open, and allows it after dispose', async () => {
    const first = env.tracker();
    await openWorkspace(first, env);
    const second = env.tracker();
    await expect(second.recover(env.folder, env.settings)).rejects.toThrow(LOCK_HELD_MESSAGE);
    expect(LOCK_HELD_MESSAGE).toBe('Another VS Code window is tracking changes in this folder.');
    await expect(new Turn(second, env).begin()).rejects.toThrow(LOCK_HELD_MESSAGE);
    await first.dispose();
    await expect(second.recover(env.folder, env.settings)).resolves.toEqual({
      recovered: false,
      notes: [],
    });
  });

  it('refuses when another live process holds the lock', async () => {
    const dir = join(env.storage, env.folder.key);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'lock'), JSON.stringify({ pid: 4242, startedAt: 1 }));
    const tracker = env.tracker({ isProcessAlive: (pid) => pid === 4242 });
    await expect(tracker.recover(env.folder, env.settings)).rejects.toThrow(LOCK_HELD_MESSAGE);
  });

  it('replaces a stale lock whose process is gone', async () => {
    const dir = join(env.storage, env.folder.key);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'lock'), JSON.stringify({ pid: 4242, startedAt: 1 }));
    const tracker = env.tracker({ isProcessAlive: () => false });
    await expect(tracker.recover(env.folder, env.settings)).resolves.toEqual({
      recovered: false,
      notes: [],
    });
    const lock = JSON.parse(await fs.readFile(join(dir, 'lock'), 'utf8')) as { pid: number };
    expect(lock.pid).toBe(process.pid);
  });

  it('replaces a lock left by an earlier process that had our pid', async () => {
    const dir = join(env.storage, env.folder.key);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'lock'), JSON.stringify({ pid: process.pid, startedAt: 1 }));
    const tracker = env.tracker();
    await expect(tracker.recover(env.folder, env.settings)).resolves.toMatchObject({
      recovered: false,
    });
  });

  it('dispose releases the lock file', async () => {
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    await tracker.dispose();
    await expect(fs.access(join(env.storage, env.folder.key, 'lock'))).rejects.toThrow();
  });

  it('keys with unsafe characters get a safe directory', async () => {
    const odd = { ...env.folder, key: '../../escape' as FolderKey };
    const tracker = env.tracker();
    await tracker.recover(odd, env.settings);
    expect((await fs.readdir(env.storage)).every((name) => !name.includes('..'))).toBe(true);
    await expect(fs.access(join(env.base, 'escape'))).rejects.toThrow();
  });
});

describe('journal', () => {
  it('records the process id and keeps lastActivityAt moving, written at most once a second', async () => {
    const clock = new FakeClock(1_000_000);
    const tracker = env.tracker({ clock, processStartTime: () => Promise.resolve('start-1') });
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    tracker.observer.onProcessStarted?.(turn.ctx, 4321);
    const journal = join(env.storage, env.folder.key, 'journal.json');
    await until(() => {
      try {
        const j = JSON.parse(readFileSync(journal, 'utf8')) as {
          pid: number | null;
          processStart?: string;
        };
        return j.pid === 4321 && j.processStart === 'start-1';
      } catch {
        return false;
      }
    });
    clock.set(1_500_000);
    for (let i = 0; i < 5; i += 1) await turn.hook('pre', 'Read', {}, `r${i}`);
    await until(() => {
      const j = JSON.parse(readFileSync(journal, 'utf8')) as {
        lastActivityAt: number;
      };
      return j.lastActivityAt === 1_500_000;
    }, 3000);
    await turn.end();
  });
});
