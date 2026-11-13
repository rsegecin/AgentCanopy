import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationId, FolderKey } from '../../shared';
import type * as ContextModule from '../context';
import { assistantMessage, text, turn, userMessage } from '../conversations/test-support';
import { createConversationStore } from '../conversations/store';
import {
  FOLDER_KEY,
  createHarness,
  sendAndFinish,
  sleep,
  textScenario,
  until,
  type Harness,
  type TestView,
} from './test-support';

/** Lets a test hold back the answer of one file search, to make answers arrive out of order. */
const control = vi.hoisted(() => ({
  holds: new Map<string, Promise<void>>(),
  finished: [] as string[],
}));

vi.mock('../context', async (importOriginal) => {
  const actual = await importOriginal<typeof ContextModule>();
  return {
    ...actual,
    createFileSearch: (options?: Parameters<typeof actual.createFileSearch>[0]) => {
      const real = actual.createFileSearch(options);
      return {
        ...real,
        search: async (...args: Parameters<typeof real.search>) => {
          const hold = control.holds.get(args[2]);
          if (hold) await hold;
          const results = await real.search(...args);
          control.finished.push(args[2]);
          return results;
        },
      };
    },
  };
});

const harnesses: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  control.holds.clear();
  control.finished.length = 0;
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function seedConversation(h: Harness, title: string): Promise<ConversationId> {
  const store = createConversationStore({ dir: join(h.storage, 'conversations') });
  await store.init();
  const meta = await store.create({
    folder: FOLDER_KEY,
    providerId: 'claude-code',
    model: 'default',
    mode: 'ask',
    title,
  });
  await store.putTurn(meta.id, turn(`${title}-turn`, { mode: 'ask' }));
  await store.putMessage(meta.id, userMessage(`${title}-u`, `${title}-turn`, 'q', { mode: 'ask' }));
  await store.putMessage(meta.id, assistantMessage(`${title}-a`, `${title}-turn`, [text('a')]));
  await store.flush();
  return meta.id;
}

async function open(view: TestView, id: ConversationId): Promise<void> {
  view.send({ type: 'conversation.open', conversationId: id });
  await until('the conversation to open', () => view.state?.active?.meta.id === id);
}

/** Picks files through the fake editor UI and waits until the view's list has the expected length. */
async function pick(h: Harness, view: TestView, paths: string[], length: number): Promise<void> {
  h.ui.picked = paths;
  view.send({ type: 'context.pick', what: 'file' });
  await until(
    `${length} draft attachments`,
    () => view.current().draftAttachments.length === length,
  );
}

describe('draft attachments', () => {
  it('are kept before a conversation exists and go into the first message', async () => {
    const h = await harness({ scenario: textScenario('hi') });
    const view = h.attach();
    await pick(h, view, ['a.ts', 'b.ts'], 2);
    expect(view.current().active).toBeNull();
    expect(view.current().draftAttachments).toEqual([
      { kind: 'file', path: 'a.ts' },
      { kind: 'file', path: 'b.ts' },
    ]);
    view.expectMirror();

    await sendAndFinish(h, view, 'with files');
    const user = view.active().messages[0];
    expect(user?.role === 'user' && user.attachments).toEqual([
      { kind: 'file', path: 'a.ts' },
      { kind: 'file', path: 'b.ts' },
    ]);
    expect(view.current().draftAttachments).toEqual([]);
    view.expectMirror();
  });

  it('belong to one view each', async () => {
    const h = await harness({ scenario: textScenario('hi') });
    const a = h.attach();
    const b = h.attach();
    await pick(h, a, ['for-a.ts'], 1);
    await pick(h, b, ['for-b.ts'], 1);
    expect(a.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-a.ts' }]);
    expect(b.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-b.ts' }]);

    await sendAndFinish(h, a, 'from a');
    const user = a.active().messages[0];
    expect(user?.role === 'user' && user.attachments).toEqual([{ kind: 'file', path: 'for-a.ts' }]);
    expect(a.current().draftAttachments).toEqual([]);
    expect(b.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-b.ts' }]);

    b.send({ type: 'context.remove', attachment: { kind: 'file', path: 'for-b.ts' } });
    expect(b.current().draftAttachments).toEqual([]);
    a.expectMirror();
    b.expectMirror();
  });

  it('are cleared when the view opens another conversation or starts a new one', async () => {
    const h = await harness({ noStart: true, scenario: textScenario('hi') });
    const one = await seedConversation(h, 'One');
    const two = await seedConversation(h, 'Two');
    await h.controller.start();
    const view = h.attach();

    await pick(h, view, ['x.ts'], 1);
    await open(view, one);
    expect(view.current().draftAttachments).toEqual([]);

    // Opening the conversation that is already shown changes nothing.
    await pick(h, view, ['y.ts'], 1);
    view.send({ type: 'conversation.open', conversationId: one });
    await sleep(30);
    expect(view.current().draftAttachments).toEqual([{ kind: 'file', path: 'y.ts' }]);

    await open(view, two);
    expect(view.current().draftAttachments).toEqual([]);

    await pick(h, view, ['z.ts'], 1);
    view.send({ type: 'conversation.new' });
    expect(view.current().active).toBeNull();
    expect(view.current().draftAttachments).toEqual([]);

    // Also from a draft: starting a new one drops what was queued.
    await pick(h, view, ['w.ts'], 1);
    view.send({ type: 'conversation.new' });
    expect(view.current().draftAttachments).toEqual([]);
    view.expectMirror();
  });

  it('are capped at 50, with a toast', async () => {
    const h = await harness();
    const view = h.attach();
    await pick(
      h,
      view,
      Array.from({ length: 60 }, (_, i) => `file${i}.ts`),
      50,
    );
    expect(view.toasts.at(-1)).toEqual({
      level: 'warning',
      text: 'You can attach at most 50 items to a message.',
    });
    // At the cap, adding from the search complains as well.
    const toasts = view.toasts.length;
    await fs.writeFile(join(h.workspace, 'extra.ts'), '');
    view.send({ type: 'context.add', path: 'extra.ts', kind: 'file' });
    await until('a second toast', () => view.toasts.length === toasts + 1);
    expect(view.current().draftAttachments).toHaveLength(50);
    view.expectMirror();
  });

  it('go to the most recently used view when added from outside', async () => {
    const h = await harness();
    const a = h.attach();
    const b = h.attach();
    b.send({ type: 'resync' });
    h.controller.addAttachment({ kind: 'file', path: 'for-b.ts' });
    expect(b.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-b.ts' }]);
    expect(a.current().draftAttachments).toEqual([]);

    a.send({ type: 'resync' });
    h.controller.addAttachment({ kind: 'file', path: 'for-a.ts' });
    h.controller.addAttachment({ kind: 'file', path: 'for-a.ts' });
    expect(a.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-a.ts' }]);
    expect(b.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-b.ts' }]);
    a.expectMirror();
    b.expectMirror();
  });
});

async function workspaceFiles(h: Harness): Promise<void> {
  await fs.mkdir(join(h.workspace, 'src', 'util'), { recursive: true });
  await fs.writeFile(join(h.workspace, 'src', 'app.ts'), '');
  await fs.writeFile(join(h.workspace, 'src', 'util', 'helper.ts'), '');
  await fs.writeFile(join(h.workspace, 'README.md'), '');
}

describe('the file search', () => {
  it('shows results for the query and clears on an empty one', async () => {
    const h = await harness();
    await workspaceFiles(h);
    const view = h.attach();
    view.send({ type: 'context.search', query: 'util' });
    await until('results', () => view.current().fileSearch !== null);
    expect(view.current().fileSearch).toEqual({
      query: 'util',
      results: [
        { path: 'src/util', kind: 'folder' },
        { path: 'src/util/helper.ts', kind: 'file' },
      ],
    });
    view.expectMirror();

    view.send({ type: 'context.search', query: 'readme' });
    await until('new results', () => view.current().fileSearch?.query === 'readme');
    expect(view.current().fileSearch?.results).toEqual([{ path: 'README.md', kind: 'file' }]);

    view.send({ type: 'context.search', query: '   ' });
    expect(view.current().fileSearch).toBeNull();
    view.expectMirror();
  });

  it('searches the folder of the conversation the view shows', async () => {
    const h = await harness({ noStart: true });
    const second = join(h.root, 'second');
    await fs.mkdir(second);
    await fs.writeFile(join(second, 'only-here.ts'), '');
    h.env.folderList = [
      ...h.env.folderList,
      { key: 'folder-2' as FolderKey, name: 'second', path: second },
    ];
    await h.controller.start();
    const view = h.attach();
    view.send({ type: 'conversation.new', folder: 'folder-2' });
    view.send({ type: 'context.search', query: 'only' });
    await until('results', () => view.current().fileSearch !== null);
    expect(view.current().fileSearch?.results).toEqual([{ path: 'only-here.ts', kind: 'file' }]);
  });

  it('does not let an older answer replace a newer one', async () => {
    const h = await harness();
    await fs.writeFile(join(h.workspace, 'old-file.ts'), '');
    await fs.writeFile(join(h.workspace, 'new-file.ts'), '');
    const view = h.attach();
    let release: () => void = () => undefined;
    control.holds.set(
      'old',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    view.send({ type: 'context.search', query: 'old' });
    view.send({ type: 'context.search', query: 'new' });
    await until('the newer answer', () => view.current().fileSearch?.query === 'new');

    release();
    await until('the older search to finish', () => control.finished.includes('old'));
    await sleep(0);
    expect(view.current().fileSearch?.query).toBe('new');
    expect(view.current().fileSearch?.results).toEqual([{ path: 'new-file.ts', kind: 'file' }]);
    view.expectMirror();
  });

  it('does not bring back a search that was closed meanwhile', async () => {
    const h = await harness();
    await fs.writeFile(join(h.workspace, 'old-file.ts'), '');
    const view = h.attach();
    let release: () => void = () => undefined;
    control.holds.set(
      'old',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    view.send({ type: 'context.search', query: 'old' });
    view.send({ type: 'context.search', query: '' });
    release();
    await until('the search to finish', () => control.finished.includes('old'));
    await sleep(0);
    expect(view.current().fileSearch).toBeNull();
    view.expectMirror();
  });

  it('is closed by a message, by opening a conversation and by starting a new one', async () => {
    const h = await harness({ noStart: true, scenario: textScenario('ok') });
    await workspaceFiles(h);
    const id = await seedConversation(h, 'One');
    await h.controller.start();
    const view = h.attach();
    const search = async (): Promise<void> => {
      view.send({ type: 'context.search', query: 'app' });
      await until('results', () => view.current().fileSearch !== null);
    };

    await search();
    await open(view, id);
    expect(view.current().fileSearch).toBeNull();

    await search();
    view.send({ type: 'conversation.new' });
    expect(view.current().fileSearch).toBeNull();

    await search();
    // Sending also drops an answer that is still on its way.
    let release: () => void = () => undefined;
    control.holds.set(
      'readme',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    view.send({ type: 'context.search', query: 'readme' });
    await sendAndFinish(h, view, 'go');
    expect(view.current().fileSearch).toBeNull();
    release();
    await until('the search to finish', () => control.finished.includes('readme'));
    await sleep(0);
    expect(view.current().fileSearch).toBeNull();
    view.expectMirror();
  });
});

describe('adding a path from the search', () => {
  async function setup(): Promise<{ h: Harness; view: TestView }> {
    const h = await harness();
    await workspaceFiles(h);
    const outside = join(h.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'secret.txt'), 'x');
    await fs.symlink(outside, join(h.workspace, 'leak-dir'));
    await fs.symlink(join(outside, 'secret.txt'), join(h.workspace, 'leak-file'));
    await fs.symlink(join(h.workspace, 'src', 'app.ts'), join(h.workspace, 'inside-link'));
    return { h, view: h.attach() };
  }

  const notInside = { level: 'warning', text: 'That path is not inside the workspace folder.' };

  it('attaches a file and a folder and closes the search', async () => {
    const { view } = await setup();
    view.send({ type: 'context.search', query: 'app' });
    await until('results', () => view.current().fileSearch !== null);

    view.send({ type: 'context.add', path: 'src/app.ts', kind: 'file' });
    await until('the file', () => view.current().draftAttachments.length === 1);
    expect(view.current().fileSearch).toBeNull();

    view.send({ type: 'context.add', path: 'src/util', kind: 'folder' });
    await until('the folder', () => view.current().draftAttachments.length === 2);
    expect(view.current().draftAttachments).toEqual([
      { kind: 'file', path: 'src/app.ts' },
      { kind: 'folder', path: 'src/util' },
    ]);

    // The same path in another spelling is the same attachment.
    view.send({ type: 'context.add', path: './src/app.ts', kind: 'file' });
    view.send({ type: 'context.add', path: 'src/util/', kind: 'folder' });
    await sleep(50);
    expect(view.current().draftAttachments).toHaveLength(2);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('refuses a path that does not exist', async () => {
    const { view } = await setup();
    view.send({ type: 'context.search', query: 'app' });
    await until('results', () => view.current().fileSearch !== null);
    view.send({ type: 'context.add', path: 'src/missing.ts', kind: 'file' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([notInside]);
    expect(view.current().draftAttachments).toEqual([]);
    // A refused path leaves the search open.
    expect(view.current().fileSearch).not.toBeNull();
    view.expectMirror();
  });

  it('refuses a path of the wrong kind', async () => {
    const { view } = await setup();
    view.send({ type: 'context.add', path: 'src', kind: 'file' });
    await until('the first toast', () => view.toasts.length === 1);
    view.send({ type: 'context.add', path: 'src/app.ts', kind: 'folder' });
    await until('the second toast', () => view.toasts.length === 2);
    expect(view.toasts).toEqual([notInside, notInside]);
    expect(view.current().draftAttachments).toEqual([]);
    view.expectMirror();
  });

  it('refuses a symbolic link that leaves the folder, and follows one that stays', async () => {
    const { view } = await setup();
    view.send({ type: 'context.add', path: 'leak-dir', kind: 'folder' });
    await until('the first toast', () => view.toasts.length === 1);
    view.send({ type: 'context.add', path: 'leak-dir/secret.txt', kind: 'file' });
    await until('the second toast', () => view.toasts.length === 2);
    view.send({ type: 'context.add', path: 'leak-file', kind: 'file' });
    await until('the third toast', () => view.toasts.length === 3);
    expect(view.toasts).toEqual([notInside, notInside, notInside]);
    expect(view.current().draftAttachments).toEqual([]);

    view.send({ type: 'context.add', path: 'inside-link', kind: 'file' });
    await until('the link inside', () => view.current().draftAttachments.length === 1);
    expect(view.toasts).toHaveLength(3);
    view.expectMirror();
  });
});
