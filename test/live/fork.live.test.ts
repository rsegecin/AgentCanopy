/**
 * Live test of conversation branches and checkpoints against the real Claude Code CLI.
 * It makes real model calls on the signed-in account, so it only runs through `npm run test:live`.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaudeProvider } from '../../src/core/provider/claude';
import {
  createHarness,
  until,
  type Harness,
  type TestView,
} from '../../src/core/session/test-support';
import type { AssistantMessage, ConversationId, Mode } from '../../src/shared';

let harness: Harness;
let view: TestView;

beforeAll(async () => {
  harness = await createHarness({
    providers: [createClaudeProvider({ claudePath: () => '' })],
    realDefaults: true,
  });
  await harness.controller.start();
  view = harness.attach();
});

afterAll(async () => {
  await harness.dispose();
});

async function send(text: string, mode: Mode = 'ask'): Promise<string> {
  const active = view.state?.active;
  const before = active?.turns.length ?? 0;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode,
    model: 'haiku',
  });
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
  const conversation = view.active();
  const turn = conversation.turns[conversation.turns.length - 1];
  expect(turn?.status).toBe('completed');
  return conversation.messages
    .filter((m): m is AssistantMessage => m.role === 'assistant' && m.turnId === turn?.id)
    .flatMap((m) => m.parts)
    .map((p) => (p.kind === 'text' ? p.text : ''))
    .join('');
}

describe('branches against the real CLI', () => {
  let parentId: ConversationId;

  it('branches at an earlier message with exactly the context up to that point', async () => {
    await send('Remember the codeword AZURE-17. Reply with OK.');
    await send('Remember a second codeword BRICK-42. Reply with OK.');
    const parent = view.active();
    parentId = parent.meta.id;
    const firstAnswer = parent.messages.find((m) => m.role === 'assistant');
    if (!firstAnswer) throw new Error('the first turn has no answer');

    view.send({ type: 'conversation.fork', conversationId: parentId, messageId: firstAnswer.id });
    await until('the branch to open', () => view.state?.active?.meta.id !== parentId);
    expect(view.active().meta.fork?.exactness).toBe('pending');

    const reply = await send('List every codeword you were told so far, comma separated.');
    expect(reply).toContain('AZURE-17');
    expect(reply).not.toContain('BRICK-42');
    const fork = view.active().meta.fork;
    expect(fork?.exactness).toBe('exact');
    expect(fork?.lost).toEqual([]);
    expect(view.active().meta.sessionId).not.toBe(parent.meta.sessionId);
  });

  it('leaves the original conversation unchanged', async () => {
    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent to open', () => view.state?.active?.meta.id === parentId);
    const reply = await send('List every codeword you were told so far, comma separated.');
    expect(reply).toContain('AZURE-17');
    expect(reply).toContain('BRICK-42');
    expect(view.problems).toEqual([]);
  });
});

describe('checkpoints against the real CLI', () => {
  it('restores the files to before an agent turn', async () => {
    view.send({ type: 'conversation.new' });
    await until('a new draft', () => view.state?.active === null);
    await send(
      'Use the Write tool to create a file named made-by-agent.txt containing exactly: hello',
      'agent',
    );
    const file = join(harness.workspace, 'made-by-agent.txt');
    expect(await fs.readFile(file, 'utf8')).toMatch(/hello/);

    await until('a checkpoint to be listed', () => (view.state?.checkpoints.length ?? 0) > 0);
    const checkpoint = view.current().checkpoints[0];
    if (!checkpoint) throw new Error('no checkpoint');
    expect(checkpoint.kind).toBe('agent-turn');

    view.send({ type: 'checkpoint.preview', operationId: checkpoint.operationId });
    await until('the preview', () => view.state?.restorePreview != null);
    const preview = view.current().restorePreview;
    if (!preview) throw new Error('no preview');
    expect(preview.items.map((i) => [i.path, i.action, i.selectedByDefault])).toEqual([
      ['made-by-agent.txt', 'delete', true],
    ]);

    view.send({
      type: 'checkpoint.restore',
      token: preview.token,
      paths: ['made-by-agent.txt'],
      andFork: false,
    });
    await until('the restore to finish', () => view.state?.restorePreview == null, 30_000);
    await expect(fs.access(file)).rejects.toThrow();
    expect(harness.ui.callsOf('confirm').length).toBeGreaterThan(0);
    await until(
      'the restore to be listed',
      () => view.current().checkpoints[0]?.kind === 'restore',
    );
    expect(view.problems).toEqual([]);
  });
});
