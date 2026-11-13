/**
 * Live Agent-mode test against the real Claude Code CLI, with the real policy and change tracker.
 * It makes real model calls on the signed-in account, so it only runs through `npm run test:live`.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaudeProvider } from '../../src/core/provider/claude';
import {
  createHarness,
  FOLDER_KEY,
  until,
  type Harness,
  type TestView,
} from '../../src/core/session/test-support';
import type { AssistantMessage } from '../../src/shared';

let harness: Harness;
let view: TestView;

beforeAll(async () => {
  harness = await createHarness({
    providers: [createClaudeProvider({ claudePath: () => '' })],
    realDefaults: true,
  });
  await fs.writeFile(join(harness.workspace, 'existing.txt'), 'before\n');
  await harness.controller.start();
  view = harness.attach();
});

afterAll(async () => {
  await harness.dispose();
});

function turnCount(): number {
  return view.state?.active?.turns.length ?? 0;
}

async function waitForTurnEnd(before: number): Promise<void> {
  await until(
    'the live turn to finish',
    () => {
      const turns = view.state?.active?.turns ?? [];
      const last = turns[turns.length - 1];
      return (
        turns.length > before &&
        harness.controller.runningTurns() === 0 &&
        last !== undefined &&
        last.status !== 'running' &&
        last.status !== 'preparing'
      );
    },
    170_000,
  );
}

function send(text: string): number {
  const before = turnCount();
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'agent',
    model: 'haiku',
  });
  return before;
}

function lastTurnParts() {
  const conversation = view.active();
  const turn = conversation.turns[conversation.turns.length - 1];
  return {
    status: turn?.status,
    parts: conversation.messages
      .filter((m): m is AssistantMessage => m.role === 'assistant' && m.turnId === turn?.id)
      .flatMap((m) => m.parts),
  };
}

function operations() {
  const folder = harness.tracker()?.folder(FOLDER_KEY);
  return (folder?.log.records() ?? []).filter((r) => r.type === 'operation');
}

describe('Agent mode against the real CLI', () => {
  it('applies a file-tool edit without asking and records it as the agent’s', async () => {
    const before = send(
      'Use the Write tool to create a file named notes.txt containing exactly: hello',
    );
    await waitForTurnEnd(before);
    const { status, parts } = lastTurnParts();
    expect(status).toBe('completed');
    expect(await fs.readFile(join(harness.workspace, 'notes.txt'), 'utf8')).toMatch(/hello/);
    expect(view.active().prompts).toEqual([]);
    const write = parts.find((p) => p.kind === 'tool' && p.call.name === 'Write');
    expect(write?.kind === 'tool' && write.call.approval).toBe('policy');

    const ops = operations();
    expect(ops).toHaveLength(1);
    const change = ops[0]?.changes.find((c) => c.path === 'notes.txt');
    expect(change?.attribution).toBe('agent-tool');
    expect(change?.before.kind).toBe('absent');
    expect(view.problems).toEqual([]);
  });

  it('asks before a command, runs it once allowed, and attributes what it wrote to the command', async () => {
    const before = send(
      'Run exactly this shell command and nothing else: echo changed >> existing.txt',
    );
    await until(
      'the command prompt',
      () => view.active().prompts.some((p) => p.state === 'pending'),
      120_000,
    );
    const prompt = view.active().prompts.find((p) => p.state === 'pending');
    expect(prompt?.kind).toBe('permission');
    if (prompt?.kind !== 'permission') throw new Error('expected a permission prompt');
    expect(prompt.category).toBe('command');
    expect(prompt.detail).toContain('existing.txt');
    // Nothing ran yet.
    expect(await fs.readFile(join(harness.workspace, 'existing.txt'), 'utf8')).toBe('before\n');

    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'permission', choice: 'allow-once' },
    });
    await waitForTurnEnd(before);

    expect(await fs.readFile(join(harness.workspace, 'existing.txt'), 'utf8')).toBe(
      'before\nchanged\n',
    );
    const ops = operations();
    expect(ops).toHaveLength(2);
    const change = ops[1]?.changes.find((c) => c.path === 'existing.txt');
    // Hooks from the real CLI bracket the command, so the change is tied to it.
    expect(change?.attribution).toBe('agent-command');
    expect(change?.before.kind === 'file' && change.before.stored).toBe(true);
    const { parts } = lastTurnParts();
    const bash = parts.find((p) => p.kind === 'tool' && p.call.name === 'Bash');
    expect(bash?.kind === 'tool' && bash.call.approval).toBe('user');
  });

  it('does not run a command the user denies', async () => {
    const before = send('Run exactly this shell command and nothing else: echo no > denied.txt');
    await until(
      'the command prompt',
      () => view.active().prompts.some((p) => p.state === 'pending'),
      120_000,
    );
    const prompt = view.active().prompts.find((p) => p.state === 'pending');
    if (prompt?.kind !== 'permission') throw new Error('expected a permission prompt');
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'permission', choice: 'deny', feedback: 'Do not create that file. Stop.' },
    });
    await waitForTurnEnd(before);
    await expect(fs.access(join(harness.workspace, 'denied.txt'))).rejects.toThrow();
    expect(operations()).toHaveLength(2);
  });

  it('lists what the agent changed and rejects it, putting the workspace back as it was', async () => {
    await until('both changes to be listed', () => (view.state?.review.entries.length ?? 0) === 2);
    const entries = view.current().review.entries;
    expect(entries.map((e) => [e.path, e.changeType, e.status])).toEqual([
      ['existing.txt', 'modified', 'pending'],
      ['notes.txt', 'created', 'pending'],
    ]);

    // The file the command changed goes back to its earlier content.
    await harness.controller.rejectFileInteractive(FOLDER_KEY, 'existing.txt');
    expect(await fs.readFile(join(harness.workspace, 'existing.txt'), 'utf8')).toBe('before\n');
    // The file the agent created is removed.
    await harness.controller.rejectFileInteractive(FOLDER_KEY, 'notes.txt');
    await expect(fs.access(join(harness.workspace, 'notes.txt'))).rejects.toThrow();

    await until('the review list to empty', () => view.current().review.entries.length === 0);
    expect(harness.ui.callsOf('choose')).toEqual([]);
    const rejects = operations().filter((op) => op.kind === 'reject');
    expect(rejects).toHaveLength(2);
    expect(view.problems).toEqual([]);
  });

  it('tells the agent on the next turn which files were reverted', async () => {
    const before = send(
      'Which files did I revert since your last turn? Reply with their names only.',
    );
    await waitForTurnEnd(before);
    const { status, parts } = lastTurnParts();
    expect(status).toBe('completed');
    const text = parts.map((p) => (p.kind === 'text' ? p.text : '')).join('');
    expect(text).toContain('existing.txt');
    expect(text).toContain('notes.txt');
  });
});
