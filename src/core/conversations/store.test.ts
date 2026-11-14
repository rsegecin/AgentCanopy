import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConversationId, Message, MessageId, Turn } from '../../shared';
import type { ConversationStore } from './store';
import {
  FOLDER,
  assistantMessage,
  fakeClock,
  makeTempDir,
  messageIds,
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

async function open(options: { compactAfterSuperseded?: number } = {}) {
  const clock = fakeClock();
  const store = trackedStore({ dir, clock, ...options });
  await store.init();
  return { store, clock };
}

const base = { folder: FOLDER, providerId: 'claude-code', model: 'sonnet', mode: 'agent' as const };

async function readLines(id: ConversationId): Promise<string[]> {
  const raw = await fs.readFile(join(dir, `${id}.jsonl`), 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

describe('create, list and load', () => {
  it('round-trips a conversation with turns, messages and prompts', async () => {
    const { store } = await open();
    const meta = await store.create({ ...base, title: 'Hello' });
    expect(meta).toMatchObject({
      title: 'Hello',
      planLocked: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    const t = turn('t1');
    const u = userMessage('m1', 't1', 'hi');
    const a = assistantMessage('m2', 't1', [text('hello')]);
    const p = permissionPrompt('p1', meta.id, 't1');
    await store.putTurn(meta.id, t);
    await store.putMessage(meta.id, u);
    await store.putMessage(meta.id, a);
    await store.putPrompt(meta.id, p);

    const data = await store.load(meta.id);
    expect(data?.turns).toEqual([t]);
    expect(data?.messages).toEqual([u, a]);
    expect(data?.prompts).toEqual([p]);
    expect(data?.meta.id).toBe(meta.id);
    expect(store.list().map((m) => m.id)).toEqual([meta.id]);
  });

  it('uses the default title and lists newest updatedAt first', async () => {
    const { store, clock } = await open();
    const first = await store.create(base);
    clock.advance(10);
    const second = await store.create(base);
    expect(first.title).toBe('New conversation');
    expect(store.list().map((m) => m.id)).toEqual([second.id, first.id]);
    clock.advance(10);
    await store.putMessage(first.id, userMessage('m1', 't1', 'x'));
    expect(store.list().map((m) => m.id)).toEqual([first.id, second.id]);
  });

  it('returns undefined for an unknown conversation', async () => {
    const { store } = await open();
    expect(await store.load('nope' as ConversationId)).toBeUndefined();
  });

  it('updateMeta merges, bumps updatedAt and can clear a key', async () => {
    const { store, clock } = await open();
    const meta = await store.create(base);
    clock.advance(5);
    const updated = await store.updateMeta(meta.id, { title: 'Renamed', sessionId: 's-1' });
    expect(updated).toMatchObject({ title: 'Renamed', sessionId: 's-1', updatedAt: 1_005 });
    clock.advance(5);
    const cleared = await store.updateMeta(meta.id, { sessionId: undefined });
    expect(cleared.sessionId).toBeUndefined();
    await store.flush();
    const data = await store.load(meta.id);
    expect(data?.meta.title).toBe('Renamed');
    expect(data?.meta.sessionId).toBeUndefined();
    expect(data?.meta.createdAt).toBe(1_000);
  });

  it('bumps updatedAt on every put and leaves the index current after flush', async () => {
    const { store, clock } = await open();
    const meta = await store.create(base);
    clock.advance(100);
    await store.putTurn(meta.id, turn('t1'));
    await store.flush();
    const index = JSON.parse(await fs.readFile(join(dir, 'index.json'), 'utf8')) as {
      conversations: { id: string; updatedAt: number }[];
    };
    expect(index.conversations).toHaveLength(1);
    expect(index.conversations[0]?.updatedAt).toBe(1_100);
  });
});

describe('agentAuto', () => {
  it('is absent from a new conversation and from one stored before it existed', async () => {
    const { store } = await open();
    const meta = await store.create(base);
    expect(meta).not.toHaveProperty('agentAuto');
    await store.flush();
    // Written by hand, as an older version would have: no agentAuto key at all.
    const line = JSON.parse((await readLines(meta.id))[0] ?? '') as { t: string; meta: object };
    expect(line.t).toBe('meta');
    expect(line.meta).not.toHaveProperty('agentAuto');
    const { store: again } = await open();
    expect((await again.load(meta.id))?.meta).not.toHaveProperty('agentAuto');
  });

  it('a branch never inherits it, and the parent keeps it across a reload', async () => {
    const { store } = await open();
    const parent = await store.create(base);
    await store.putMessage(parent.id, userMessage('m1', 't1', 'q'));
    await store.putMessage(parent.id, assistantMessage('m2', 't1', [text('a')]));
    await store.updateMeta(parent.id, { agentAuto: true });
    const { meta } = await store.fork({ parentId: parent.id, atMessageId: 'm2' as MessageId });
    expect(meta).not.toHaveProperty('agentAuto');
    await store.flush();

    const { store: again } = await open();
    expect((await again.load(parent.id))?.meta.agentAuto).toBe(true);
    expect((await again.load(meta.id))?.meta).not.toHaveProperty('agentAuto');
  });

  it('keeps when it was turned on, only together with it, and a branch does not inherit it', async () => {
    const { store } = await open();
    const created = await store.create({ ...base, agentAuto: true, agentAutoSince: 1_234 });
    expect(created).toMatchObject({ agentAuto: true, agentAutoSince: 1_234 });
    const without = await store.create({ ...base, agentAutoSince: 1_234 });
    expect(without).not.toHaveProperty('agentAuto');
    expect(without).not.toHaveProperty('agentAutoSince');
    await store.putMessage(created.id, userMessage('m1', 't1', 'q'));
    await store.putMessage(created.id, assistantMessage('m2', 't1', [text('a')]));
    const { meta } = await store.fork({ parentId: created.id, atMessageId: 'm2' as MessageId });
    expect(meta).not.toHaveProperty('agentAutoSince');
    await store.flush();

    const { store: again } = await open();
    expect((await again.load(created.id))?.meta).toMatchObject({
      agentAuto: true,
      agentAutoSince: 1_234,
    });
  });
});

describe('folding', () => {
  it('lets the last record for an id win and keeps first-appearance order', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.putMessage(id, userMessage('m1', 't1', 'one'));
    await store.putMessage(id, assistantMessage('m2', 't1', [text('two')]));
    await store.putMessage(id, userMessage('m3', 't2', 'three'));
    await store.putMessage(id, assistantMessage('m2', 't1', [text('two, revised')]));
    await store.putMessage(id, userMessage('m1', 't1', 'one, revised'));
    await store.putTurn(id, turn('t1', { status: 'running' }));
    await store.putTurn(id, turn('t1', { status: 'completed' }));

    const data = await store.load(id);
    expect(messageIds(data?.messages ?? [])).toEqual(['m1', 'm2', 'm3']);
    expect(data?.messages[0]).toMatchObject({ text: 'one, revised' });
    expect(data?.messages[1]).toMatchObject({ parts: [{ kind: 'text', text: 'two, revised' }] });
    expect(data?.turns).toHaveLength(1);
    expect(data?.turns[0]?.status).toBe('completed');
  });
});

describe('restart and the index', () => {
  it('a new store instance on the same directory sees everything', async () => {
    const { store } = await open();
    const meta = await store.create({ ...base, title: 'Persisted' });
    await store.putMessage(meta.id, userMessage('m1', 't1', 'kept'));
    await store.updateMeta(meta.id, { sessionId: 'abc' });
    await store.flush();

    const { store: again } = await open();
    expect(again.list()).toHaveLength(1);
    const data = await again.load(meta.id);
    expect(data?.meta).toMatchObject({ title: 'Persisted', sessionId: 'abc' });
    expect(data?.messages).toHaveLength(1);
  });

  async function seeded(): Promise<ConversationId[]> {
    const { store } = await open();
    const a = await store.create({ ...base, title: 'A' });
    const b = await store.create({ ...base, title: 'B' });
    await store.putMessage(a.id, userMessage('m1', 't1', 'x'));
    await store.flush();
    return [a.id, b.id];
  }

  it('rebuilds the index when it is deleted', async () => {
    const ids = await seeded();
    await fs.rm(join(dir, 'index.json'));
    const { store } = await open();
    expect(
      store
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual([...ids].sort());
    await expect(fs.stat(join(dir, 'index.json'))).resolves.toBeDefined();
  });

  it('rebuilds the index when it is corrupt', async () => {
    const ids = await seeded();
    await fs.writeFile(join(dir, 'index.json'), '{not json');
    const { store } = await open();
    expect(
      store
        .list()
        .map((m) => m.id)
        .sort(),
    ).toEqual([...ids].sort());
    JSON.parse(await fs.readFile(join(dir, 'index.json'), 'utf8'));
  });

  it('rebuilds the index when it has the wrong shape', async () => {
    const ids = await seeded();
    await fs.writeFile(join(dir, 'index.json'), JSON.stringify({ version: 2 }));
    const { store } = await open();
    expect(store.list()).toHaveLength(ids.length);
  });

  it('rebuilds the index when a conversation file exists that it does not know', async () => {
    await seeded();
    const extra = {
      id: 'extra-conversation',
      title: 'Found on disk',
      createdAt: 5,
      updatedAt: 5,
      folder: FOLDER,
      providerId: 'p',
      model: 'm',
      mode: 'ask',
      planLocked: false,
    };
    await fs.writeFile(
      join(dir, 'extra-conversation.jsonl'),
      `${JSON.stringify({ t: 'meta', meta: extra })}\n`,
    );
    const { store } = await open();
    expect(store.list()).toHaveLength(3);
    expect(store.list().find((m) => m.id === 'extra-conversation')?.title).toBe('Found on disk');
  });

  it('drops an index entry whose file is gone', async () => {
    const [a] = await seeded();
    await fs.rm(join(dir, `${a}.jsonl`));
    const { store } = await open();
    expect(store.list().map((m) => m.id)).not.toContain(a);
    expect(store.list()).toHaveLength(1);
  });

  it('ignores a file without usable metadata when rebuilding', async () => {
    await seeded();
    await fs.writeFile(join(dir, 'junk.jsonl'), 'garbage\n');
    const { store } = await open();
    expect(store.list()).toHaveLength(2);
  });
});

describe('damaged files', () => {
  it('skips a garbage line and a torn final line', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.putMessage(id, userMessage('m1', 't1', 'good'));
    await store.flush();
    const path = join(dir, `${id}.jsonl`);
    await fs.appendFile(path, 'this is not json\n');
    await fs.appendFile(path, `${JSON.stringify({ t: 'message', message: { role: 'user' } })}\n`);
    await fs.appendFile(path, '{"t":"message","message":{"role":"us');

    const { store: again } = await open();
    const data = await again.load(id);
    expect(messageIds(data?.messages ?? [])).toEqual(['m1']);
  });

  it('terminates a torn line before appending so the next record survives', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.flush();
    await fs.appendFile(join(dir, `${id}.jsonl`), '{"t":"message","message":{"role":"us');

    const { store: again } = await open();
    await again.putMessage(id, userMessage('m2', 't1', 'after the tear'));
    await again.flush();
    const { store: third } = await open();
    const data = await third.load(id);
    expect(messageIds(data?.messages ?? [])).toEqual(['m2']);
  });
});

describe('validation', () => {
  it('rejects invalid input and writes nothing', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.flush();
    const before = await fs.readFile(join(dir, `${id}.jsonl`), 'utf8');

    const badMessage = { ...userMessage('m1', 't1', 'x'), mode: 'bogus' } as unknown as Message;
    await expect(store.putMessage(id, badMessage)).rejects.toThrow();
    await expect(
      store.putTurn(id, { ...turn('t1'), status: 'nope' } as unknown as Turn),
    ).rejects.toThrow();
    await expect(
      store.putMessage(id, { ...userMessage('m1', 't1', 'x'), id: '' } as unknown as Message),
    ).rejects.toThrow();
    await expect(store.updateMeta(id, { mode: 'bogus' } as never)).rejects.toThrow();
    await expect(store.updateMeta(id, { id: 'other' } as never)).rejects.toThrow();
    await expect(store.updateMeta(id, { title: 'x'.repeat(201) })).rejects.toThrow();
    await expect(
      store.putPrompt(id, permissionPrompt('p1', 'another' as ConversationId, 't1')),
    ).rejects.toThrow();
    await expect(store.create({ ...base, model: 5 as unknown as string })).rejects.toThrow();

    await store.flush();
    expect(await fs.readFile(join(dir, `${id}.jsonl`), 'utf8')).toBe(before);
    expect(store.list()).toHaveLength(1);
  });

  it('rejects writes to an unknown conversation', async () => {
    const { store } = await open();
    const ghost = 'ghost' as ConversationId;
    await expect(store.putTurn(ghost, turn('t1'))).rejects.toThrow(/unknown/);
    await expect(store.putMessage(ghost, userMessage('m1', 't1', 'x'))).rejects.toThrow(/unknown/);
    await expect(store.putPrompt(ghost, permissionPrompt('p', ghost, 't1'))).rejects.toThrow(
      /unknown/,
    );
    await expect(store.updateMeta(ghost, { title: 'x' })).rejects.toThrow(/unknown/);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.jsonl'))).toEqual([]);
  });
});

describe('delete', () => {
  it('removes the file and the index entry', async () => {
    const { store } = await open();
    const keep = await store.create(base);
    const gone = await store.create(base);
    await store.putMessage(gone.id, userMessage('m1', 't1', 'x'));
    await store.delete(gone.id);
    await store.flush();
    expect(store.list().map((m) => m.id)).toEqual([keep.id]);
    expect(await store.load(gone.id)).toBeUndefined();
    await expect(fs.stat(join(dir, `${gone.id}.jsonl`))).rejects.toThrow();
    const index = JSON.parse(await fs.readFile(join(dir, 'index.json'), 'utf8')) as {
      conversations: { id: string }[];
    };
    expect(index.conversations.map((c) => c.id)).toEqual([keep.id]);
    await expect(store.putMessage(gone.id, userMessage('m2', 't1', 'y'))).rejects.toThrow();
  });
});

describe('ordering under concurrency', () => {
  it('keeps every record of 200 interleaved puts, ordered per conversation', async () => {
    const { store } = await open();
    const a = await store.create(base);
    const b = await store.create(base);
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 200; i += 1) {
      const target = i % 2 === 0 ? a.id : b.id;
      writes.push(store.putMessage(target, userMessage(`m${i}`, 't1', `text ${i}`)));
    }
    await Promise.all(writes);

    for (const [meta, parity] of [
      [a, 0],
      [b, 1],
    ] as const) {
      const data = await store.load(meta.id);
      const expected = Array.from({ length: 100 }, (_, n) => `m${n * 2 + parity}`);
      expect(messageIds(data?.messages ?? [])).toEqual(expected);
    }
    await store.flush();
    const { store: again } = await open();
    expect((await again.load(a.id))?.messages).toHaveLength(100);
    expect((await again.load(b.id))?.messages).toHaveLength(100);
  });

  it('a load issued after a put sees it', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    void store.putMessage(id, userMessage('m1', 't1', 'x'));
    const data = await store.load(id);
    expect(data?.messages).toHaveLength(1);
  });
});

describe('compaction', () => {
  async function foldedState(store: ConversationStore, id: ConversationId) {
    const data = await store.load(id);
    return { turns: data?.turns, messages: data?.messages, prompts: data?.prompts };
  }

  it('rewrites the file with only live records and keeps the folded state', async () => {
    const { store } = await open({ compactAfterSuperseded: 5 });
    const { id } = await store.create(base);
    await store.putTurn(id, turn('t1'));
    await store.putMessage(id, userMessage('m1', 't1', 'q'));
    await store.putMessage(id, assistantMessage('m2', 't1', [text('draft 0')]));
    await store.putPrompt(id, permissionPrompt('p1', id, 't1'));
    const beforeLines = (await readLines(id)).length;
    expect(beforeLines).toBe(5);

    // Each replacement supersedes one record; the sixth makes more than five.
    for (let i = 1; i <= 6; i += 1) {
      await store.putMessage(id, assistantMessage('m2', 't1', [text(`draft ${i}`)]));
    }
    await store.flush();
    const lines = await readLines(id);
    expect(lines).toHaveLength(5);
    const kinds = lines.map((line) => (JSON.parse(line) as { t: string }).t);
    expect(kinds).toEqual(['meta', 'turn', 'message', 'message', 'prompt']);

    const state = await foldedState(store, id);
    expect(state.messages?.[1]).toMatchObject({ parts: [{ text: 'draft 6' }] });
    expect(messageIds(state.messages ?? [])).toEqual(['m1', 'm2']);

    const { store: again } = await open({ compactAfterSuperseded: 5 });
    expect(await foldedState(again, id)).toEqual(state);
  });

  it('counts superseded records already in the file when the process starts', async () => {
    const first = await open({ compactAfterSuperseded: 5 });
    const { id } = await first.store.create(base);
    await first.store.putMessage(id, userMessage('m1', 't1', 'v0'));
    for (let i = 1; i <= 4; i += 1) {
      await first.store.putMessage(id, userMessage('m1', 't1', `v${i}`));
    }
    await first.store.flush();
    expect(await readLines(id)).toHaveLength(6);

    const { store } = await open({ compactAfterSuperseded: 5 });
    await store.putMessage(id, userMessage('m1', 't1', 'v5'));
    await store.putMessage(id, userMessage('m1', 't1', 'v6'));
    await store.flush();
    expect(await readLines(id)).toHaveLength(2);
    expect((await store.load(id))?.messages[0]).toMatchObject({ text: 'v6' });
  });

  it('keeps the current metadata and stays correct while writes keep arriving', async () => {
    const { store } = await open({ compactAfterSuperseded: 3 });
    const { id } = await store.create(base);
    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 40; i += 1) {
      writes.push(store.putMessage(id, userMessage('m1', 't1', `v${i}`)));
      writes.push(store.putMessage(id, userMessage(`other-${i}`, 't1', `o${i}`)));
      if (i % 10 === 0) writes.push(store.updateMeta(id, { title: `title ${i}` }));
    }
    await Promise.all(writes);
    await store.flush();
    const { store: again } = await open();
    const data = await again.load(id);
    expect(data?.messages).toHaveLength(41);
    expect(data?.messages[0]).toMatchObject({ text: 'v39' });
    expect(data?.meta.title).toBe('title 30');
    expect((await readLines(id)).length).toBeLessThanOrEqual(1 + 41 + 3 + 1);
  });
});

describe('flush', () => {
  it('leaves the data readable straight from the files', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    void store.putMessage(id, userMessage('m1', 't1', 'on disk'));
    void store.putTurn(id, turn('t1'));
    await store.flush();
    const records = (await readLines(id)).map(
      (line) => JSON.parse(line) as { t: string; message?: { text: string } },
    );
    expect(records.map((r) => r.t)).toEqual(['meta', 'message', 'turn']);
    expect(records[1]?.message?.text).toBe('on disk');
    const index = JSON.parse(await fs.readFile(join(dir, 'index.json'), 'utf8')) as {
      conversations: unknown[];
    };
    expect(index.conversations).toHaveLength(1);
  });

  it('never writes anything but the typed records', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.putMessage(id, {
      ...userMessage('m1', 't1', 'x'),
      extraField: 'leak',
    } as unknown as Message);
    await store.flush();
    expect((await fs.readFile(join(dir, `${id}.jsonl`), 'utf8')).includes('leak')).toBe(false);
  });
});

describe('tool parts', () => {
  it('stores tool calls as given', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    const message = assistantMessage('m1', 't1', [toolPart('Read', 'done')]);
    await store.putMessage(id, message);
    expect((await store.load(id))?.messages[0]).toEqual(message);
  });
});
