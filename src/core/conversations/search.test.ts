import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MessagePart } from '../../shared';
import {
  FOLDER,
  assistantMessage,
  fakeClock,
  makeTempDir,
  removeDir,
  trackedStore,
  text,
  toolPart,
  userMessage,
} from './test-support';

let dir: string;
beforeEach(async () => {
  dir = await makeTempDir();
});
afterEach(async () => {
  await removeDir(dir);
});

const base = { folder: FOLDER, providerId: 'p', model: 'm', mode: 'agent' as const };

async function open() {
  const clock = fakeClock();
  const store = trackedStore({ dir, clock });
  await store.init();
  return { store, clock };
}

describe('search', () => {
  it('matches titles, user text and assistant text, one result per conversation', async () => {
    const { store, clock } = await open();
    const byTitle = await store.create({ ...base, title: 'Fixing the Parser' });
    clock.advance(1);
    const byUser = await store.create({ ...base, title: 'One' });
    await store.putMessage(byUser.id, userMessage('u1', 't1', 'Why does the parser fail?'));
    clock.advance(1);
    const byAssistant = await store.create({ ...base, title: 'Two' });
    await store.putMessage(
      byAssistant.id,
      assistantMessage('a1', 't1', [text('The parser reads tokens'), text('parser again')]),
    );

    const hits = await store.search('parser');
    expect(hits.map((h) => h.conversationId)).toEqual([byTitle.id, byAssistant.id, byUser.id]);
    expect(hits[0]).toMatchObject({ title: 'Fixing the Parser', snippet: 'Fixing the Parser' });
    expect(hits.filter((h) => h.conversationId === byAssistant.id)).toHaveLength(1);
  });

  it('does not match thinking, tool input or tool output', async () => {
    const { store } = await open();
    const { id } = await store.create({ ...base, title: 'Quiet' });
    const parts: MessagePart[] = [
      { kind: 'thinking', text: 'zebra in the reasoning' },
      toolPart('Read', 'done'),
      { kind: 'notice', level: 'info', text: 'zebra notice' },
      text('nothing here'),
    ];
    await store.putMessage(id, assistantMessage('a1', 't1', parts));
    expect(await store.search('zebra')).toEqual([]);
    expect(await store.search('input-of-Read')).toEqual([]);
    expect(await store.search('output-of-Read')).toEqual([]);
    expect(await store.search('Read')).toEqual([]);
  });

  it('is case-insensitive and treats the query as plain text', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.putMessage(id, userMessage('u1', 't1', 'Use the A.B (C) pattern'));
    expect(await store.search('PATTERN')).toHaveLength(1);
    expect(await store.search('a.b (c)')).toHaveLength(1);
    expect(await store.search('a+b')).toEqual([]);
    expect(await store.search('.*')).toEqual([]);
  });

  it('builds a snippet of about 120 characters around the first match with newlines collapsed', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    const long = `${'a'.repeat(200)}\nline two\n\n${'b'.repeat(20)} NEEDLE ${'c'.repeat(20)}\n${'d'.repeat(200)} NEEDLE`;
    await store.putMessage(id, userMessage('u1', 't1', long));
    const [hit] = await store.search('needle');
    expect(hit).toBeDefined();
    const snippet = hit?.snippet ?? '';
    expect(snippet).toContain('NEEDLE');
    expect(snippet).not.toMatch(/[\r\n]/);
    expect(snippet.indexOf('NEEDLE')).toBe(snippet.lastIndexOf('NEEDLE'));
    expect(snippet.length).toBeGreaterThan(60);
    expect(snippet.length).toBeLessThanOrEqual(125);
  });

  it('keeps a short text whole', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.putMessage(id, userMessage('u1', 't1', 'first line\nsecond line'));
    expect((await store.search('second'))[0]?.snippet).toBe('first line second line');
    expect(id).toBeDefined();
  });

  it('puts title matches first, then newest first', async () => {
    const { store, clock } = await open();
    const oldContent = await store.create({ ...base, title: 'old' });
    await store.putMessage(oldContent.id, userMessage('u1', 't1', 'about topic'));
    clock.advance(10);
    const oldTitle = await store.create({ ...base, title: 'topic old' });
    clock.advance(10);
    const newContent = await store.create({ ...base, title: 'new' });
    await store.putMessage(newContent.id, userMessage('u2', 't1', 'topic again'));
    clock.advance(10);
    const newTitle = await store.create({ ...base, title: 'topic new' });

    const hits = await store.search('topic');
    expect(hits.map((h) => h.conversationId)).toEqual([
      newTitle.id,
      oldTitle.id,
      newContent.id,
      oldContent.id,
    ]);
  });

  it('honours the limit, with a default of 50', async () => {
    const { store, clock } = await open();
    for (let i = 0; i < 60; i += 1) {
      clock.advance(1);
      await store.create({ ...base, title: `match ${i}` });
    }
    expect(await store.search('match', 3)).toHaveLength(3);
    expect(await store.search('match')).toHaveLength(50);
    expect(await store.search('match', 0)).toEqual([]);
  });

  it('applies the limit across title and content matches', async () => {
    const { store, clock } = await open();
    const a = await store.create({ ...base, title: 'zzz' });
    await store.putMessage(a.id, userMessage('u1', 't1', 'needle'));
    clock.advance(1);
    const b = await store.create({ ...base, title: 'needle title' });
    expect((await store.search('needle', 1)).map((h) => h.conversationId)).toEqual([b.id]);
    expect((await store.search('needle', 2)).map((h) => h.conversationId)).toEqual([b.id, a.id]);
  });

  it('returns nothing for an empty or whitespace query', async () => {
    const { store } = await open();
    await store.create({ ...base, title: 'anything' });
    expect(await store.search('')).toEqual([]);
    expect(await store.search('   \n\t')).toEqual([]);
  });

  it('finds content again after a restart', async () => {
    const { store } = await open();
    const { id } = await store.create(base);
    await store.putMessage(id, userMessage('u1', 't1', 'persisted words'));
    await store.flush();
    const { store: again } = await open();
    expect((await again.search('persisted')).map((h) => h.conversationId)).toEqual([id]);
  });
});
