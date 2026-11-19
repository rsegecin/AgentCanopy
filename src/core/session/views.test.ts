import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared';
import type {
  Attachment,
  ConversationId,
  FolderKey,
  ModelInfo,
  PatchOp,
  ProviderStatus,
} from '../../shared';
import type { AgentProvider } from '../contracts';
import {
  assistantMessage,
  permissionPrompt,
  text,
  toolPart,
  turn,
  userMessage,
} from '../conversations/test-support';
import { createConversationStore } from '../conversations/store';
import type { ConversationStore } from '../conversations/store';
import { AUTO_RESET_FILE } from './auto-reset';
import { LEARNED_MODELS_FILE } from './learned-models';
import {
  FOLDER_KEY,
  createHarness,
  finishedTurn,
  fixtureSteps,
  providerStatus,
  sendAndFinish,
  sleep,
  streamedText,
  stubProvider,
  textScenario,
  until,
  type Harness,
  type TestView,
} from './test-support';

const harnesses: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function seed(h: Harness, build: (store: ConversationStore) => Promise<void>): Promise<void> {
  const store = createConversationStore({ dir: join(h.storage, 'conversations') });
  await store.init();
  await build(store);
  await store.flush();
}

async function seedConversation(
  store: ConversationStore,
  title: string,
  body: string,
  folder: FolderKey = FOLDER_KEY,
): Promise<ConversationId> {
  const meta = await store.create({
    folder,
    providerId: 'claude-code',
    model: 'default',
    mode: 'ask',
    title,
  });
  const id = `${title}-turn`;
  await store.putTurn(meta.id, turn(id, { mode: 'ask' }));
  await store.putMessage(meta.id, userMessage(`${title}-u`, id, body, { mode: 'ask' }));
  await store.putMessage(meta.id, assistantMessage(`${title}-a`, id, [text(`Re: ${body}`)]));
  return meta.id;
}

async function open(view: TestView, id: ConversationId): Promise<void> {
  view.send({ type: 'conversation.open', conversationId: id });
  await until('the conversation to open', () => view.state?.active?.meta.id === id);
}

describe('the view protocol', () => {
  it('posts nothing before ready, sends init on ready and again on resync', async () => {
    const h = await harness({ noStart: true });
    const view = h.attach({ ready: false });
    await h.controller.start();
    expect(view.messages).toEqual([]);

    // A view that has not said ready is told nothing, not even about changes; init has them all.
    h.env.trustedValue = false;
    h.controller.environmentChanged();
    view.send({ type: 'resync' });
    expect(view.messages).toEqual([]);

    view.ready();
    expect(view.messages).toHaveLength(1);
    const init = view.messages[0];
    expect(init?.type).toBe('init');
    if (init?.type !== 'init') return;
    expect(init.state.trusted).toBe(false);
    expect(init.state.folders).toEqual([{ key: FOLDER_KEY, name: 'work' }]);
    expect(init.state.provider?.installed).toBe(true);
    expect(init.state.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['default', 'sonnet', 'haiku']),
    );
    expect(init.state.defaults).toEqual({ mode: 'ask', model: 'default' });
    expect(init.state.banners.map((b) => b.id)).toEqual(['untrusted']);
    expect(init.state.active).toBeNull();

    view.send({ type: 'resync' });
    expect(view.messages).toHaveLength(2);
    const again = view.messages[1];
    expect(again?.type === 'init' && again.seq).toBe(init.seq);
    expect(again?.type === 'init' && again.state).toEqual(init.state);

    // After init, a change arrives as the next patch.
    h.env.trustedValue = true;
    h.controller.environmentChanged();
    const patches = view.patches();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.seq).toBe(init.seq + 1);
    expect(view.current().banners).toEqual([]);
    view.expectMirror();
  });

  it('keeps the global state equal in every view and the active conversation separate', async () => {
    const h = await harness({ noStart: true });
    let id: ConversationId | undefined;
    await seed(h, async (store) => {
      id = await seedConversation(store, 'One', 'first');
    });
    await h.controller.start();
    const a = h.attach();
    const b = h.attach();
    if (!id) throw new Error('no conversation');
    await open(a, id);
    expect(a.current().active?.meta.id).toBe(id);
    expect(b.current().active).toBeNull();
    const global = (v: TestView) => ({ ...v.current(), active: null, search: null });
    expect(global(a)).toEqual(global(b));

    h.env.settingsValue = {
      ...h.env.settingsValue,
      defaultMode: 'plan',
      customModels: ['my-model'],
    };
    h.controller.environmentChanged();
    expect(global(a)).toEqual(global(b));
    expect(a.current().defaults.mode).toBe('plan');
    expect(a.current().models.some((m) => m.id === 'my-model' && m.custom)).toBe(true);
    a.expectMirror();
    b.expectMirror();
  });

  it('opens the conversation a view was attached with', async () => {
    const h = await harness({ noStart: true });
    let id: ConversationId | undefined;
    await seed(h, async (store) => {
      id = await seedConversation(store, 'One', 'first');
    });
    const view = h.attach({ conversationId: id });
    await h.controller.start();
    await until('the conversation to open', () => view.state?.active?.meta.id === id);
    view.expectMirror();
  });

  it('ignores invalid messages and logs only their type', async () => {
    const h = await harness();
    const view = h.attach();
    const eventsBefore = view.events.length;
    view.send({
      type: 'conversation.rename',
      conversationId: 'c',
      title: '',
      secret: 'SECRETVALUE',
    });
    view.send({ type: 'no.such.message', payload: 'SECRETVALUE' });
    view.send('SECRETVALUE');
    view.send(null);
    await sleep(30);
    expect(view.events.length).toBe(eventsBefore);
    const invalid = h.logger.entries.filter((e) => e.message.includes('invalid message'));
    expect(invalid).toHaveLength(4);
    expect(JSON.stringify(h.logger.entries)).not.toContain('SECRETVALUE');
    view.expectMirror();
  });

  it('turns a throwing handler into an error toast and keeps working', async () => {
    const h = await harness();
    const view = h.attach();
    h.ui.failCopy = true;
    view.send({ type: 'clipboard.copy', text: 'SECRETTEXT' });
    await until('an error toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.level).toBe('error');
    expect(view.toasts[0]?.text).toBe('Something went wrong. The AgentCanopy log has the details.');
    expect(h.logger.has('error', 'message handler failed')).toBe(true);
    expect(JSON.stringify(h.logger.entries)).not.toContain('SECRETTEXT');

    h.ui.failCopy = false;
    view.send({ type: 'open.link', url: 'https://example.com/a' });
    await until('the link to open', () => h.ui.callsOf('openExternal').length === 1);
    expect(view.toasts).toHaveLength(1);
  });

  it('ignores messages after dispose', async () => {
    const h = await harness();
    const view = h.attach();
    await h.controller.dispose();
    view.send({ type: 'open.link', url: 'https://example.com/' });
    await sleep(30);
    expect(h.ui.callsOf('openExternal')).toEqual([]);
  });
});

describe('banners', () => {
  it('shows trust and folder banners', async () => {
    const h = await harness({ untrusted: true, noFolder: true });
    const view = h.attach();
    expect(view.current().banners).toEqual([
      {
        id: 'untrusted',
        level: 'warning',
        text: 'This workspace is not trusted, so AgentCanopy will not run agents here. Your conversation history stays readable.',
        dismissible: false,
      },
      {
        id: 'no-folder',
        level: 'info',
        text: 'Open a folder to start a conversation.',
        dismissible: false,
      },
    ]);
    h.env.trustedValue = true;
    h.env.folderList = [{ key: FOLDER_KEY, name: 'work', path: h.workspace }];
    h.controller.environmentChanged();
    expect(view.current().banners).toEqual([]);
    expect(view.current().folders).toEqual([{ key: FOLDER_KEY, name: 'work' }]);
    view.expectMirror();
  });

  it('shows one banner per provider problem with the right level and action', async () => {
    const signedOut = await harness({ auth: { loggedIn: false } });
    const view = signedOut.attach();
    expect(view.current().banners).toEqual([
      {
        id: 'provider-problem:signed-out',
        level: 'error',
        text: expect.stringContaining('not signed in') as string,
        action: { id: 'sign-in', label: 'Sign in' },
        dismissible: false,
      },
    ]);
    view.send({
      type: 'banner.action',
      bannerId: 'provider-problem:signed-out',
      actionId: 'sign-in',
    });
    await until('sign-in', () => signedOut.ui.callsOf('startSignIn').length === 1);
    expect(signedOut.ui.callsOf('startSignIn')[0]).toEqual(['claude-code']);

    const status: { current: ProviderStatus } = {
      current: providerStatus({
        installed: false,
        meetsMinimum: false,
        version: undefined,
        problems: ['Claude Code was not found.'],
      }),
    };
    let detections = 0;
    const provider: AgentProvider = {
      ...stubProvider(status.current),
      detect: () => {
        detections += 1;
        return Promise.resolve(status.current);
      },
    };
    const missing = await harness({ providers: [provider] });
    const other = missing.attach();
    expect(other.current().banners).toEqual([
      {
        id: 'provider-problem:not-installed',
        level: 'error',
        text: 'Claude Code was not found.',
        action: { id: 'refresh', label: 'Check again' },
        dismissible: false,
      },
    ]);
    const before = detections;
    status.current = providerStatus({
      version: '1.0.0',
      meetsMinimum: false,
      problems: ['Claude Code 1.0.0 is older than the minimum.'],
    });
    other.send({
      type: 'banner.action',
      bannerId: 'provider-problem:not-installed',
      actionId: 'refresh',
    });
    await until(
      'the banner to change',
      () => other.current().banners[0]?.id === 'provider-problem:too-old',
    );
    expect(detections).toBe(before + 1);
    // An action the banner does not have is ignored.
    other.send({
      type: 'banner.action',
      bannerId: 'provider-problem:too-old',
      actionId: 'sign-in',
    });
    await sleep(30);
    expect(missing.ui.callsOf('startSignIn')).toEqual([]);
    other.expectMirror();
  });

  it('hides a dismissed notice until its condition changes', async () => {
    const apiKey =
      'An ANTHROPIC_API_KEY environment variable is set, so Claude Code bills the API account instead of your subscription.';
    const status: { current: ProviderStatus } = {
      current: providerStatus({ credential: 'api-key', problems: [apiKey] }),
    };
    const provider: AgentProvider = {
      ...stubProvider(status.current),
      detect: () => Promise.resolve(status.current),
    };
    const h = await harness({ providers: [provider] });
    const view = h.attach();
    expect(view.current().banners).toEqual([
      {
        id: 'provider-problem:api-key',
        level: 'warning',
        text: apiKey,
        action: { id: 'refresh', label: 'Check again' },
        dismissible: true,
      },
    ]);
    view.send({ type: 'banner.dismiss', bannerId: 'provider-problem:api-key' });
    expect(view.current().banners).toEqual([]);
    h.controller.environmentChanged();
    expect(view.current().banners).toEqual([]);

    // The condition goes away and comes back: the notice is shown again.
    status.current = providerStatus({ problems: [] });
    await h.controller.refreshProvider();
    status.current = providerStatus({ credential: 'api-key', problems: [apiKey] });
    await h.controller.refreshProvider();
    expect(view.current().banners.map((b) => b.id)).toEqual(['provider-problem:api-key']);

    // A banner that cannot be dismissed stays.
    status.current = providerStatus({
      installed: false,
      meetsMinimum: false,
      version: undefined,
      problems: ['Claude Code was not found.'],
    });
    await h.controller.refreshProvider();
    view.send({ type: 'banner.dismiss', bannerId: 'provider-problem:not-installed' });
    expect(view.current().banners.map((b) => b.id)).toEqual(['provider-problem:not-installed']);
    view.expectMirror();
  });

  it('maps provider.refresh, provider.signIn, logs.show and clipboard.copy to the UI', async () => {
    const h = await harness();
    const view = h.attach();
    view.send({ type: 'provider.signIn' });
    view.send({ type: 'logs.show' });
    view.send({ type: 'clipboard.copy', text: 'copied text' });
    view.send({ type: 'provider.refresh' });
    view.send({ type: 'conversation.openInEditor' });
    await until('all calls', () => h.ui.calls.length >= 4);
    expect(h.ui.callsOf('startSignIn')).toEqual([['claude-code']]);
    expect(h.ui.callsOf('showLogs')).toHaveLength(1);
    expect(h.ui.callsOf('copyToClipboard')).toEqual([['copied text']]);
    expect(h.ui.callsOf('openEditorPanel')).toEqual([[undefined]]);
  });

  it('maps settings.open to the UI', async () => {
    const h = await harness();
    const view = h.attach();
    view.send({ type: 'settings.open' });
    await until('the call', () => h.ui.callsOf('openSettings').length === 1);
    expect(h.ui.callsOf('openSettings')).toHaveLength(1);
  });

  it.each([
    ['permissions.remove', { type: 'permissions.remove', id: 'a' }],
    ['permissions.setSwitch', { type: 'permissions.setSwitch', name: 'web-fetch', on: true }],
    ['permissions.addDirectory', { type: 'permissions.addDirectory' }],
    ['permissions.addEditDirectory', { type: 'permissions.addEditDirectory' }],
  ] as const)('answers %s with "not available yet" and changes nothing', async (_name, message) => {
    const h = await harness();
    const view = h.attach();
    view.send(message);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'info', text: 'This is not available yet.' });
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(h.ui.callsOf('pickDirectory')).toEqual([]);
    expect(view.current().permissions).toEqual({ folder: null, switches: [], saved: [] });
    view.expectMirror();
  });

  it('shows the policy settings and follows a settings change', async () => {
    const h = await harness();
    const view = h.attach();
    expect(view.current().policySettings).toEqual({
      editApproval: 'auto',
      alwaysAskCommands: false,
      askWebTools: false,
      autoOffered: true,
      autoWebTools: true,
      sandbox: false,
    });

    h.env.settingsValue = {
      ...h.env.settingsValue,
      editApproval: 'ask',
      alwaysAskCommands: true,
      askWebTools: true,
      agentAuto: false,
      agentAutoWebTools: false,
      sandbox: true,
    };
    h.controller.environmentChanged();
    expect(view.current().policySettings).toEqual({
      editApproval: 'ask',
      alwaysAskCommands: true,
      askWebTools: true,
      autoOffered: false,
      autoWebTools: false,
      sandbox: true,
    });
    view.expectMirror();
  });
});

describe('start-up', () => {
  it('marks turns that were running when the application closed as interrupted', async () => {
    const h = await harness({ noStart: true });
    let ids: ConversationId[] = [];
    await seed(h, async (store) => {
      const running = await seedConversation(store, 'Running', 'busy');
      await store.putTurn(running, turn('Running-turn', { mode: 'ask', status: 'running' }));
      await store.putMessage(
        running,
        assistantMessage('Running-a', 'Running-turn', [
          text('partial'),
          toolPart('Read', 'running', 'call-a'),
          toolPart('Bash', 'awaiting-approval', 'call-b'),
          toolPart('Glob', 'done', 'call-c'),
        ]),
      );
      await store.putPrompt(running, permissionPrompt('prompt-1', running, 'Running-turn'));
      const preparing = await seedConversation(store, 'Preparing', 'soon');
      await store.putTurn(preparing, turn('Preparing-turn', { mode: 'ask', status: 'preparing' }));
      const finished = await seedConversation(store, 'Finished', 'done');
      ids = [running, preparing, finished];
    });
    await h.controller.start();
    const view = h.attach();
    const [running, preparing, finished] = ids;
    if (!running || !preparing || !finished) throw new Error('not seeded');

    await open(view, running);
    const active = view.active();
    expect(active.turns[0]?.status).toBe('interrupted');
    expect(active.turns[0]?.error).toBe('AgentCanopy was closed while this turn was running.');
    const message = active.messages[1];
    const statuses =
      message?.role === 'assistant'
        ? message.parts.flatMap((p) => (p.kind === 'tool' ? [p.call.status] : []))
        : [];
    expect(statuses).toEqual(['not-run', 'not-run', 'done']);
    expect(active.prompts[0]?.state).toBe('expired');
    expect(view.current().conversations.every((c) => !c.running && c.pendingPrompts === 0)).toBe(
      true,
    );

    await open(view, preparing);
    expect(view.active().turns[0]?.status).toBe('interrupted');
    await open(view, finished);
    expect(view.active().turns[0]?.status).toBe('completed');
    expect(view.active().turns[0]?.error).toBeUndefined();
    // Their previews are known by now.
    const previews = view.current().conversations.map((c) => c.preview);
    expect(previews).toEqual(expect.arrayContaining(['partial', 'Re: soon', 'Re: done']));
  });
});

describe('previews at start-up', () => {
  it('fill in after start() has resolved, so a long history does not delay activation', async () => {
    const h = await harness({ noStart: true });
    await seed(h, async (store) => {
      for (let index = 0; index < 30; index += 1) {
        await seedConversation(store, `Chat${index}`, `question ${index}`);
      }
    });
    await h.controller.start();
    const view = h.attach();
    const summaries = view.current().conversations;
    expect(summaries).toHaveLength(30);
    expect(summaries.every((summary) => summary.preview === '')).toBe(true);

    await until('every preview', () =>
      view.current().conversations.every((summary) => summary.preview !== ''),
    );
    const previews = view.current().conversations.map((summary) => summary.preview);
    for (let index = 0; index < 30; index += 1) {
      expect(previews).toContain(`Re: question ${index}`);
    }
    view.expectMirror();
  });
});

describe('managing conversations', () => {
  it('renames, changes mode and model, and deletes', async () => {
    const h = await harness({ noStart: true });
    let id: ConversationId | undefined;
    await seed(h, async (store) => {
      id = await seedConversation(store, 'One', 'first');
    });
    await h.controller.start();
    const view = h.attach();
    if (!id) throw new Error('no conversation');
    await open(view, id);

    view.send({ type: 'conversation.rename', conversationId: id, title: '  Better title ' });
    await until('the new title', () => view.current().conversations[0]?.title === 'Better title');
    expect(view.active().meta.title).toBe('Better title');
    view.send({ type: 'conversation.rename', conversationId: id, title: '   ' });

    view.send({ type: 'conversation.setMode', conversationId: id, mode: 'plan' });
    view.send({ type: 'conversation.setModel', conversationId: id, model: 'opus' });
    await until('mode and model', () => {
      const meta = view.state?.active?.meta;
      return meta?.mode === 'plan' && meta.model === 'opus';
    });
    expect(view.current().conversations[0]).toMatchObject({
      title: 'Better title',
      mode: 'plan',
      model: 'opus',
    });
    view.expectMirror();

    // It is stored.
    const store = createConversationStore({ dir: join(h.storage, 'conversations') });
    await store.init();
    expect(store.list()[0]).toMatchObject({ title: 'Better title', mode: 'plan', model: 'opus' });
    await store.flush();

    view.send({ type: 'conversation.delete', conversationId: id });
    await until('the list to be empty', () => view.current().conversations.length === 0);
    expect(view.current().active).toBeNull();
    const after = createConversationStore({ dir: join(h.storage, 'conversations') });
    await after.init();
    expect(after.list()).toEqual([]);
    await after.flush();
    view.expectMirror();
  });

  it('refuses to rename a conversation that is not there', async () => {
    const h = await harness();
    const view = h.attach();
    view.send({ type: 'conversation.rename', conversationId: 'missing', title: 'x' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('That conversation no longer exists.');
  });

  it('searches, fills the results and clears them again', async () => {
    const h = await harness({ noStart: true });
    await seed(h, async (store) => {
      await seedConversation(store, 'Fruit', 'I like bananas');
      await seedConversation(store, 'Tools', 'a hammer');
    });
    await h.controller.start();
    const view = h.attach();
    view.send({ type: 'conversation.search', query: 'banana' });
    await until('results', () => view.current().search !== null);
    const search = view.current().search;
    expect(search?.query).toBe('banana');
    expect(search?.results).toHaveLength(1);
    expect(search?.results[0]?.title).toBe('Fruit');
    expect(search?.results[0]?.snippet).toContain('bananas');
    view.send({ type: 'conversation.search', query: '' });
    expect(view.current().search).toBeNull();
    view.send({ type: 'conversation.search', query: 'hammer' });
    await until('results again', () => view.current().search !== null);
    view.send({ type: 'conversation.search', query: '   ' });
    expect(view.current().search).toBeNull();
    view.expectMirror();
  });

  it('starts a draft, and ignores a conversation that loads after the view moved on', async () => {
    const h = await harness({ noStart: true });
    let id: ConversationId | undefined;
    await seed(h, async (store) => {
      id = await seedConversation(store, 'One', 'first');
    });
    await h.controller.start();
    const view = h.attach();
    if (!id) throw new Error('no conversation');
    view.send({ type: 'conversation.open', conversationId: id });
    view.send({ type: 'conversation.new' });
    await sleep(100);
    expect(view.current().active).toBeNull();

    await open(view, id);
    view.send({ type: 'conversation.new' });
    expect(view.current().active).toBeNull();

    view.send({ type: 'conversation.open', conversationId: 'missing' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('That conversation could not be opened.');
    view.expectMirror();
  });

  it('creates the conversation in the chosen folder when the first message is sent', async () => {
    const h = await harness({ scenario: textScenario('hi') });
    const second = join(h.root, 'second');
    await fs.mkdir(second);
    h.env.folderList = [
      ...h.env.folderList,
      { key: 'folder-2' as FolderKey, name: 'second', path: second },
    ];
    h.controller.environmentChanged();
    const view = h.attach();
    view.send({ type: 'conversation.new', folder: 'folder-2' });
    expect(h.requests).toHaveLength(0);
    expect(view.current().conversations).toEqual([]);
    await sendAndFinish(h, view, 'where am I');
    expect(view.active().meta.folder).toBe('folder-2');
    expect(h.requests[0]?.cwd).toBe(second);
    expect(view.current().conversations).toHaveLength(1);
  });
});

describe('context for the next message', () => {
  async function withConversation(): Promise<{ h: Harness; view: TestView; id: ConversationId }> {
    const h = await harness({ noStart: true, scenario: textScenario('noted') });
    let id: ConversationId | undefined;
    await seed(h, async (store) => {
      id = await seedConversation(store, 'One', 'first');
    });
    await h.controller.start();
    const view = h.attach();
    if (!id) throw new Error('no conversation');
    await open(view, id);
    return { h, view, id };
  }

  it('collects attachments without duplicates, removes them and hands them to the message', async () => {
    const { h, view } = await withConversation();
    h.ui.picked = ['a.ts', 'a.ts', 'dir/b.ts'];
    view.send({ type: 'context.pick', what: 'file' });
    await until('two attachments', () => view.current().draftAttachments.length === 2);
    expect(view.current().draftAttachments).toEqual([
      { kind: 'file', path: 'a.ts' },
      { kind: 'file', path: 'dir/b.ts' },
    ]);
    view.send({ type: 'context.pick', what: 'file' });
    await sleep(50);
    expect(view.current().draftAttachments).toHaveLength(2);

    h.ui.picked = ['dir'];
    view.send({ type: 'context.pick', what: 'folder' });
    await until('a folder', () => view.current().draftAttachments.length === 3);

    const selection: Attachment = {
      kind: 'selection',
      path: 'a.ts',
      startLine: 1,
      endLine: 2,
      text: 'let a = 1;',
    };
    h.ui.selection = selection;
    view.send({ type: 'context.addSelection' });
    view.send({ type: 'context.addSelection' });
    expect(view.current().draftAttachments).toHaveLength(4);
    view.send({ type: 'context.addDiagnostics' });
    expect(view.toasts.at(-1)?.text).toBe('There are no problems to add.');
    h.ui.diagnostics = { kind: 'diagnostics', path: 'a.ts', text: 'error TS1' };
    view.send({ type: 'context.addDiagnostics' });
    expect(view.current().draftAttachments).toHaveLength(5);

    view.send({ type: 'context.remove', attachment: { kind: 'file', path: 'a.ts' } });
    expect(view.current().draftAttachments.map((a) => a.kind)).toEqual([
      'file',
      'folder',
      'selection',
      'diagnostics',
    ]);
    view.expectMirror();

    const turn = await sendAndFinish(h, view, 'use them');
    expect(turn.status).toBe('completed');
    const user = view.active().messages.find((m) => m.role === 'user' && m.text === 'use them');
    expect(user?.role === 'user' && user.attachments).toHaveLength(4);
    expect(view.current().draftAttachments).toEqual([]);
    view.expectMirror();
  });

  it('keeps at most 50 attachments', async () => {
    const { h, view } = await withConversation();
    h.ui.picked = Array.from({ length: 60 }, (_, i) => `file${i}.ts`);
    view.send({ type: 'context.pick', what: 'file' });
    await until('50 attachments', () => view.current().draftAttachments.length === 50);
    expect(view.toasts.at(-1)?.text).toBe('You can attach at most 50 items to a message.');
  });

  it('keeps draft attachments for a conversation that is not stored yet until the first message', async () => {
    const h = await harness({ scenario: textScenario('hi') });
    const view = h.attach();
    h.ui.picked = ['x.ts'];
    view.send({ type: 'context.pick', what: 'file' });
    await until('the pick', () => h.ui.callsOf('pickPaths').length === 1);
    await sleep(30);
    h.ui.picked = ['x.ts', 'y.ts'];
    view.send({ type: 'context.pick', what: 'file' });
    await sleep(50);
    view.send({ type: 'context.remove', attachment: { kind: 'file', path: 'y.ts' } });
    await sendAndFinish(h, view, 'first message');
    const user = view.active().messages[0];
    expect(user?.role === 'user' && user.attachments).toEqual([{ kind: 'file', path: 'x.ts' }]);
  });

  it('go to the most recently used view', async () => {
    const h = await harness({ noStart: true });
    const ids: ConversationId[] = [];
    await seed(h, async (store) => {
      ids.push(await seedConversation(store, 'One', 'first'));
      ids.push(await seedConversation(store, 'Two', 'second'));
    });
    await h.controller.start();
    const a = h.attach();
    const b = h.attach();
    const [one, two] = ids;
    if (!one || !two) throw new Error('not seeded');
    await open(a, one);
    await open(b, two);

    // `b` sent the last message.
    h.controller.addAttachment({ kind: 'file', path: 'for-b.ts' });
    expect(b.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-b.ts' }]);
    expect(a.current().draftAttachments).toEqual([]);
    h.controller.newConversation();
    expect(b.current().active).toBeNull();
    expect(b.events.at(-1)).toEqual({ kind: 'focus-composer' });
    expect(a.current().active?.meta.id).toBe(one);

    h.controller.showPermissions();
    expect(b.events.at(-1)).toEqual({ kind: 'show-tab', tab: 'permissions' });
    expect(a.events).not.toContainEqual({ kind: 'show-tab', tab: 'permissions' });

    a.send({ type: 'resync' });
    h.controller.addAttachment({ kind: 'file', path: 'for-a.ts' });
    expect(a.current().draftAttachments).toEqual([{ kind: 'file', path: 'for-a.ts' }]);
    a.expectMirror();
    b.expectMirror();
  });
});

describe('files and links', () => {
  it('opens files inside the workspace folders and refuses everything else', async () => {
    const h = await harness();
    const view = h.attach();
    await fs.mkdir(join(h.workspace, 'src'), { recursive: true });
    await fs.writeFile(join(h.workspace, 'src', 'a.ts'), 'x');
    const outside = join(h.root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(join(outside, 'secret.txt'), 'x');
    await fs.symlink(outside, join(h.workspace, 'link'));

    // One at a time: each is resolved asynchronously, so concurrent ones could finish in any order.
    const openedBefore = () => h.ui.callsOf('openFile').length;
    const open = async (path: string, line?: number): Promise<void> => {
      const before = openedBefore();
      view.send({ type: 'open.file', path, ...(line ? { line } : {}) });
      await until('the file to open', () => openedBefore() === before + 1);
    };
    await open('src/a.ts', 3);
    await open('src/../src/a.ts');
    await open(join(h.workspace, 'src', 'a.ts'));
    await open('src/not-yet-created.ts');
    const send = (path: string): void => view.send({ type: 'open.file', path });
    expect(h.ui.callsOf('openFile')[0]).toEqual([join(h.workspace, 'src', 'a.ts'), 3]);
    expect(h.ui.callsOf('openFile')[3]?.[0]).toBe(join(h.workspace, 'src', 'not-yet-created.ts'));

    const refused = [
      '../../etc/passwd',
      '/etc/passwd',
      join(outside, 'secret.txt'),
      'link/secret.txt',
      '..',
      'a\0b',
    ];
    for (const path of refused) send(path);
    await until('refusals', () => view.toasts.length === refused.length);
    expect(h.ui.callsOf('openFile')).toHaveLength(4);
    expect(
      view.toasts.every(
        (t) => t.text === 'AgentCanopy only opens files inside the workspace folders.',
      ),
    ).toBe(true);
  });

  it('resolves relative paths against the folder of the active conversation', async () => {
    const h = await harness({ noStart: true });
    const second = join(h.root, 'second');
    await fs.mkdir(second);
    h.env.folderList = [
      ...h.env.folderList,
      { key: 'folder-2' as FolderKey, name: 'second', path: second },
    ];
    let id: ConversationId | undefined;
    await seed(h, async (store) => {
      id = await seedConversation(store, 'Two', 'in the second folder', 'folder-2' as FolderKey);
    });
    await h.controller.start();
    const view = h.attach();
    if (!id) throw new Error('no conversation');
    view.send({ type: 'open.file', path: 'a.ts' });
    await open(view, id);
    view.send({ type: 'open.file', path: 'a.ts' });
    await until('two opens', () => h.ui.callsOf('openFile').length === 2);
    expect(h.ui.callsOf('openFile')[0]?.[0]).toBe(join(h.workspace, 'a.ts'));
    expect(h.ui.callsOf('openFile')[1]?.[0]).toBe(join(second, 'a.ts'));
    // A path in another workspace folder is fine too.
    view.send({ type: 'open.file', path: join(h.workspace, 'b.ts') });
    await until('a third open', () => h.ui.callsOf('openFile').length === 3);
  });

  it('opens only http, https and mailto links', async () => {
    const h = await harness();
    const view = h.attach();
    const good = ['https://example.com/a?b=1', 'http://example.com/', 'mailto:someone@example.com'];
    const bad = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>1</script>',
      'ftp://example.com/x',
      'vscode://some.extension/open',
      'not a url',
      '//example.com/no-scheme',
    ];
    for (const url of [...good, ...bad]) view.send({ type: 'open.link', url });
    await until(
      'all answered',
      () => h.ui.callsOf('openExternal').length === 3 && view.toasts.length === bad.length,
    );
    expect(h.ui.callsOf('openExternal').map((call) => call[0])).toEqual(good);
    expect(view.toasts.every((t) => t.text === 'AgentCanopy only opens web and email links.')).toBe(
      true,
    );
  });
});

describe('features of the default workspace tracking, in an application built without it', () => {
  it('answer with a toast and change nothing', async () => {
    const h = await harness();
    const view = h.attach();
    const messages = [
      { type: 'review.openDiff', path: 'a.ts' },
      { type: 'review.openAll' },
      { type: 'review.acceptAll' },
      { type: 'review.rejectAll', includePaths: [] },
      { type: 'review.acceptFile', path: 'a.ts' },
      { type: 'review.rejectFile', path: 'a.ts' },
      { type: 'config.keep', changeId: 'c' },
      { type: 'config.revert', changeId: 'c' },
      { type: 'config.openDiff', changeId: 'c' },
      { type: 'checkpoint.preview', operationId: 'o' },
      { type: 'checkpoint.openDiff', token: 't', path: 'a.ts' },
      { type: 'checkpoint.restore', token: 't', paths: [], andFork: false },
    ];
    const before = view.current();
    for (const message of messages) view.send(message);
    await until('every toast', () => view.toasts.length === messages.length);
    expect(
      view.toasts.every((t) => t.level === 'info' && t.text === 'This is not available yet.'),
    ).toBe(true);
    expect(view.current()).toEqual(before);
  });
});

describe('the full ids that finished turns reported for model aliases', () => {
  const DEFAULT_LABEL = 'Default (Claude Code decides) · Haiku 5.5';

  function entryOf(view: TestView, id: string): ModelInfo | undefined {
    return view.current().models.find((model) => model.id === id);
  }

  /** The patches that set the whole list of models. */
  function modelPatches(view: TestView): PatchOp[] {
    return view
      .patches()
      .flatMap((patch) => patch.ops)
      .filter((op) => op.op === 'set' && op.path.length === 1 && op.path[0] === 'models');
  }

  it('puts the resolved id and label in every view after a completed turn', async () => {
    const h = await harness({ scenario: textScenario('ok') });
    const view = h.attach();
    const other = h.attach();
    expect(entryOf(view, 'default')?.resolved).toBeUndefined();
    expect(entryOf(view, 'default')?.label).toBe('Default (Claude Code decides)');
    expect(modelPatches(view)).toEqual([]);
    const before = view.current().models;

    const turn = await sendAndFinish(h, view, 'hello');
    expect(turn.status).toBe('completed');
    for (const v of [view, other]) {
      expect(entryOf(v, 'default')).toMatchObject({
        id: 'default',
        label: DEFAULT_LABEL,
        resolved: 'claude-haiku-5-5',
      });
      // Only what was learned changed.
      expect(v.current().models.filter((m) => m.id !== 'default')).toEqual(
        before.filter((m) => m.id !== 'default'),
      );
    }
    const patches = modelPatches(view);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.op === 'set' && patches[0].value).toEqual(view.current().models);
    expect(modelPatches(other)).toHaveLength(1);
    view.expectMirror();
    other.expectMirror();

    // The same id again changes nothing.
    await sendAndFinish(h, view, 'again');
    expect(modelPatches(view)).toHaveLength(1);
  });

  it('learns the model of a delegate choice for its base alias', async () => {
    const h = await harness({ scenario: textScenario('ok') });
    const view = h.attach();
    await sendAndFinish(h, view, 'hello', { model: 'fable+delegate' });
    expect(entryOf(view, 'fable')?.resolved).toBe('claude-haiku-5-5');
    expect(entryOf(view, 'fable+delegate')?.resolved).toBe('claude-haiku-5-5');
    expect(entryOf(view, 'default')?.resolved).toBeUndefined();
    expect(entryOf(view, 'default')?.label).toBe('Default (Claude Code decides)');
    view.expectMirror();
  });

  it('learns nothing from a turn that ended in an error', async () => {
    const h = await harness({ scenario: { steps: fixtureSteps('E1') } });
    const view = h.attach();
    const before = view.current().models;
    const turn = await sendAndFinish(h, view, 'hi');
    expect(turn.status).toBe('error');
    expect(view.current().models).toEqual(before);
    expect(modelPatches(view)).toEqual([]);
    await h.controller.dispose();
    expect(existsSync(join(h.globalStorage, LEARNED_MODELS_FILE))).toBe(false);
  });

  it('learns nothing from a turn that was interrupted', async () => {
    const h = await harness({
      scenario: { steps: [...streamedText(['partial text']), { hang: true }] },
    });
    const view = h.attach();
    const before = view.current().models;
    view.send({ type: 'turn.send', text: 'go', mode: 'ask', model: 'default' });
    await until('text to appear', () => {
      const message = view.state?.active?.messages[1];
      return message?.role === 'assistant' && message.parts.length > 0;
    });
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('interrupted');
    expect(view.current().models).toEqual(before);
    expect(modelPatches(view)).toEqual([]);
    await h.controller.dispose();
    expect(existsSync(join(h.globalStorage, LEARNED_MODELS_FILE))).toBe(false);
  });

  it('learns nothing for a custom model id', async () => {
    const h = await harness({ scenario: textScenario('ok'), noStart: true });
    h.env.settingsValue = { ...DEFAULT_SETTINGS, customModels: ['claude-custom-1'] };
    await h.controller.start();
    const view = h.attach();
    const before = view.current().models;
    expect(before.some((m) => m.id === 'claude-custom-1' && m.custom)).toBe(true);
    const turn = await sendAndFinish(h, view, 'hello', { model: 'claude-custom-1' });
    expect(turn.status).toBe('completed');
    expect(h.requests[0]?.model).toBe('claude-custom-1');
    expect(view.current().models).toEqual(before);
    expect(modelPatches(view)).toEqual([]);
    await h.controller.dispose();
    expect(existsSync(join(h.globalStorage, LEARNED_MODELS_FILE))).toBe(false);
  });

  it('is in the first state of a window that starts later on the same global storage', async () => {
    const first = await harness({ scenario: textScenario('ok') });
    const view = first.attach();
    await sendAndFinish(first, view, 'hello');
    // Written in the background; disposing waits for it.
    await first.controller.dispose();
    expect(existsSync(join(first.globalStorage, LEARNED_MODELS_FILE))).toBe(true);

    const second = await harness({
      scenario: textScenario('ok'),
      globalStorage: first.globalStorage,
    });
    const next = second.attach();
    const init = next.messages[0];
    expect(init?.type).toBe('init');
    if (init?.type !== 'init') return;
    expect(init.state.models.find((m) => m.id === 'default')).toMatchObject({
      label: DEFAULT_LABEL,
      resolved: 'claude-haiku-5-5',
    });
    expect(modelPatches(next)).toEqual([]);
  });

  it('works in memory when there is no global storage directory', async () => {
    const h = await harness({ scenario: textScenario('ok'), noStart: true });
    h.env.globalStorage = undefined;
    await h.controller.start();
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'hello');
    expect(turn.status).toBe('completed');
    expect(entryOf(view, 'default')).toMatchObject({
      label: DEFAULT_LABEL,
      resolved: 'claude-haiku-5-5',
    });
    expect(await fs.readdir(h.globalStorage)).toEqual([]);
    view.expectMirror();
  });

  it('does not reset Auto', async () => {
    const h = await harness({ scenario: textScenario('ok'), noStart: true });
    h.env.settingsValue = { ...DEFAULT_SETTINGS, agentAuto: false };
    await h.controller.start();
    const view = h.attach();
    // With the setting off, start-up has reset Auto once and saved when it saw that.
    const file = join(h.globalStorage, AUTO_RESET_FILE);
    await until('the reset to be saved', () => existsSync(file));
    await sleep(50);
    const resets: unknown = Reflect.get(h.controller, 'autoResets');
    const saved = await fs.readFile(file, 'utf8');

    const turn = await sendAndFinish(h, view, 'hello');
    expect(turn.status).toBe('completed');
    expect(entryOf(view, 'default')?.resolved).toBe('claude-haiku-5-5');
    expect(Reflect.get(h.controller, 'autoResets')).toBe(resets);
    await h.controller.dispose();
    expect(await fs.readFile(file, 'utf8')).toBe(saved);
  });
});
