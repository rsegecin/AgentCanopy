import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationId, MessageId } from '../../shared';
import type { ConversationStore } from './store';
import {
  FOLDER,
  assistantMessage,
  fakeClock,
  makeTempDir,
  permissionPrompt,
  removeDir,
  trackedStore,
  text,
  toolPart,
  turn,
  userMessage,
} from './test-support';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir();
});
afterEach(async () => {
  await removeDir(dir);
});

async function setup() {
  const store = trackedStore({ dir, clock: fakeClock(5_000) });
  await store.init();
  const parent = await store.create({
    folder: FOLDER,
    providerId: 'claude-code',
    model: 'opus',
    mode: 'plan',
    title: 'Original',
  });
  await store.updateMeta(parent.id, { sessionId: 'session-1', planLocked: true });
  await store.putTurn(parent.id, turn('parent-t1', { forkPointEventId: 'ev-1' }));
  await store.putTurn(parent.id, turn('parent-t2', { status: 'running' }));
  await store.putMessage(parent.id, userMessage('parent-u1', 'parent-t1', 'first question'));
  await store.putMessage(
    parent.id,
    assistantMessage('parent-a1', 'parent-t1', [text('first answer'), toolPart('Read', 'done')]),
  );
  await store.putMessage(parent.id, userMessage('parent-u2', 'parent-t2', 'second\nquestion'));
  await store.putMessage(
    parent.id,
    assistantMessage('parent-a2', 'parent-t2', [
      { kind: 'thinking', text: 'hmm' },
      text('second answer'),
      toolPart('Bash', 'running', 'call-a'),
      toolPart('Edit', 'awaiting-approval', 'call-b'),
      toolPart('Grep', 'denied', 'call-c'),
      { kind: 'prompt', promptId: 'parent-p1' as never },
    ]),
  );
  await store.putPrompt(parent.id, permissionPrompt('parent-p1', parent.id, 'parent-t2'));
  await store.flush();
  return { store, parent };
}

async function parentBytes(id: ConversationId): Promise<Buffer> {
  return fs.readFile(join(dir, `${id}.jsonl`));
}

async function forkAt(store: ConversationStore, parentId: ConversationId, at: string) {
  return store.fork({ parentId, atMessageId: at as MessageId });
}

describe('fork', () => {
  it('at an assistant message keeps up to and including its turn, with no prefill', async () => {
    const { store, parent } = await setup();
    const { meta, prefill } = await forkAt(store, parent.id, 'parent-a1');
    expect(prefill).toBeUndefined();
    const data = await store.load(meta.id);
    expect(data?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(data?.messages[0]).toMatchObject({ text: 'first question' });
    expect(data?.turns).toHaveLength(1);
    expect(data?.turns[0]).toMatchObject({ status: 'completed', forkPointEventId: 'ev-1' });
    expect(data?.prompts).toEqual([]);
    expect(meta.fork).toEqual({
      parentId: parent.id,
      atMessageId: 'parent-a1',
      lastKeptParentTurnId: 'parent-t1',
      exactness: 'pending',
      lost: [],
    });
  });

  it("records the parent's own id of the last turn it keeps, and none when nothing is kept", async () => {
    const { store, parent } = await setup();
    expect((await forkAt(store, parent.id, 'parent-a2')).meta.fork?.lastKeptParentTurnId).toBe(
      'parent-t2',
    );
    expect((await forkAt(store, parent.id, 'parent-u2')).meta.fork?.lastKeptParentTurnId).toBe(
      'parent-t1',
    );
    expect(
      (await forkAt(store, parent.id, 'parent-u1')).meta.fork?.lastKeptParentTurnId,
    ).toBeUndefined();
  });

  it('at the last assistant message keeps everything', async () => {
    const { store, parent } = await setup();
    const { meta } = await forkAt(store, parent.id, 'parent-a2');
    const data = await store.load(meta.id);
    expect(data?.messages).toHaveLength(4);
    expect(data?.turns).toHaveLength(2);
    expect(meta.fork?.atMessageId).toBe('parent-a2');
    // The parent's second turn was still running; the branch cannot continue it.
    expect(data?.turns[1]?.status).toBe('interrupted');
  });

  it('at a user message keeps what precedes its turn and prefills the text', async () => {
    const { store, parent } = await setup();
    const { meta, prefill } = await forkAt(store, parent.id, 'parent-u2');
    expect(prefill).toBe('second\nquestion');
    const data = await store.load(meta.id);
    expect(data?.messages).toHaveLength(2);
    expect(data?.turns).toHaveLength(1);
    expect(meta.fork?.atMessageId).toBe('parent-a1');
  });

  it('at the first user message gives an empty branch and the prefill', async () => {
    const { store, parent } = await setup();
    const { meta, prefill } = await forkAt(store, parent.id, 'parent-u1');
    expect(prefill).toBe('first question');
    const data = await store.load(meta.id);
    expect(data?.messages).toEqual([]);
    expect(data?.turns).toEqual([]);
    expect(meta.fork).toEqual({
      parentId: parent.id,
      atMessageId: 'parent-u1',
      exactness: 'pending',
      lost: [],
    });
  });

  it('copies title, folder, provider, model and mode, and starts without a session', async () => {
    const { store, parent } = await setup();
    const { meta } = await forkAt(store, parent.id, 'parent-a1');
    expect(meta).toMatchObject({
      title: 'Original (branch)',
      folder: FOLDER,
      providerId: 'claude-code',
      model: 'opus',
      mode: 'plan',
      planLocked: false,
      createdAt: 5_000,
    });
    expect(meta.sessionId).toBeUndefined();
    expect(meta.id).not.toBe(parent.id);
    expect(store.list().map((m) => m.id)).toContain(meta.id);
  });

  it('keeps a long title within its limit', async () => {
    const store = trackedStore({ dir });
    await store.init();
    const parent = await store.create({
      folder: FOLDER,
      providerId: 'p',
      model: 'm',
      mode: 'ask',
      title: 'x'.repeat(200),
    });
    await store.putMessage(parent.id, userMessage('parent-u1', 'parent-t1', 'q'));
    const { meta } = await forkAt(store, parent.id, 'parent-u1');
    expect(meta.title.length).toBeLessThanOrEqual(200);
    expect(meta.title.endsWith(' (branch)')).toBe(true);
  });

  it('gives new ids everywhere and keeps turn references consistent', async () => {
    const { store, parent } = await setup();
    const { meta } = await forkAt(store, parent.id, 'parent-a2');
    const data = await store.load(meta.id);
    const parentData = await store.load(parent.id);
    const oldIds = [
      parent.id,
      ...(parentData?.turns.map((t) => t.id) ?? []),
      ...(parentData?.messages.map((m) => m.id) ?? []),
    ] as string[];

    const withoutFork = JSON.stringify({ ...data, meta: { ...data?.meta, fork: undefined } });
    for (const id of oldIds) expect(withoutFork).not.toContain(id);
    expect(JSON.stringify(data?.meta.fork)).toContain(parent.id);

    const turnIds = new Set(data?.turns.map((t) => t.id));
    expect(turnIds.size).toBe(2);
    for (const message of data?.messages ?? []) expect(turnIds.has(message.turnId)).toBe(true);
    // Two messages share each turn.
    expect(data?.messages[0]?.turnId).toBe(data?.messages[1]?.turnId);
    expect(data?.messages[2]?.turnId).toBe(data?.messages[3]?.turnId);
    expect(data?.messages[0]?.turnId).not.toBe(data?.messages[2]?.turnId);
    expect(meta.fork?.atMessageId).toBe('parent-a2');
  });

  it('turns running and awaiting tools into not-run and drops prompt parts', async () => {
    const { store, parent } = await setup();
    const { meta } = await forkAt(store, parent.id, 'parent-a2');
    const data = await store.load(meta.id);
    const last = data?.messages[3];
    expect(last?.role).toBe('assistant');
    if (last?.role !== 'assistant') return;
    expect(last.parts.some((p) => p.kind === 'prompt')).toBe(false);
    const statuses = last.parts.flatMap((p) => (p.kind === 'tool' ? [p.call.status] : []));
    expect(statuses).toEqual(['not-run', 'not-run', 'denied']);
    // Finished tools keep their status, and thinking stays.
    const first = data?.messages[1];
    expect(first?.role === 'assistant' && first.parts.some((p) => p.kind === 'tool')).toBe(true);
    expect(last.parts.some((p) => p.kind === 'thinking')).toBe(true);
  });

  it('does not copy prompts', async () => {
    const { store, parent } = await setup();
    const { meta } = await forkAt(store, parent.id, 'parent-a2');
    expect((await store.load(meta.id))?.prompts).toEqual([]);
    expect((await store.load(parent.id))?.prompts).toHaveLength(1);
  });

  it('leaves the parent untouched, byte for byte', async () => {
    const { store, parent } = await setup();
    const before = await parentBytes(parent.id);
    const listBefore = JSON.stringify(store.list().filter((m) => m.id === parent.id));
    await forkAt(store, parent.id, 'parent-a1');
    await forkAt(store, parent.id, 'parent-u2');
    await store.flush();
    expect((await parentBytes(parent.id)).equals(before)).toBe(true);
    expect(JSON.stringify(store.list().filter((m) => m.id === parent.id))).toBe(listBefore);
  });

  it('survives a restart and can be written to', async () => {
    const { store, parent } = await setup();
    const { meta } = await forkAt(store, parent.id, 'parent-a1');
    await store.putMessage(meta.id, userMessage('new-1', 'new-turn', 'continuing'));
    await store.flush();
    const again = trackedStore({ dir });
    await again.init();
    const data = await again.load(meta.id);
    expect(data?.messages).toHaveLength(3);
    expect(data?.meta.fork?.parentId).toBe(parent.id);
  });

  it('rejects an unknown parent or message', async () => {
    const { store, parent } = await setup();
    await expect(forkAt(store, 'nope' as ConversationId, 'parent-a1')).rejects.toThrow(/unknown/);
    await expect(forkAt(store, parent.id, 'nope')).rejects.toThrow(/unknown/);
    expect(store.list()).toHaveLength(1);
  });
});
