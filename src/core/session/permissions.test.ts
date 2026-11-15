import { promises as fs } from 'node:fs';
import { parse, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type { FolderKey, PermissionPrompt, ToolCallView, AssistantMessage } from '../../shared';
import type { Grant } from '../policy';
import { useHome } from '../policy/readonly/test-support';
import {
  FOLDER_KEY,
  assistantToolUse,
  createHarness,
  finishedTurn,
  resultStep,
  stateEvent,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type Step,
  type TestView,
} from './test-support';
import { TEXT } from './text';

// A real tracker reads the folder and the machine may be busy with other work: allow more time.
vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const SECOND_FOLDER = 'folder-2' as FolderKey;
const allowed = { decision: 'accept', source: 'user_temporary' } as const;
const rejected = { decision: 'reject', source: 'user_reject' } as const;

const READ_OUTSIDE_TITLE = 'Allow reads outside the folder without asking?';
const DIRECTORY_TITLE = 'Always allow reads in this folder?';
const CARD_TITLE = 'Always allow this?';

interface Dialog {
  title: string;
  detail: string;
  confirmLabel: string;
}

const harnesses: Harness[] = [];
const restores: (() => void)[] = [];
afterEach(async () => {
  // Last first: each one restores what the one before it had set.
  for (const restore of restores.splice(0).reverse()) restore();
  for (const h of harnesses.splice(0)) await h.dispose();
});

/** What a test of permissions needs besides the harness: a home of its own and a folder outside the workspace. */
interface Setup {
  h: Harness;
  /** The directory `os.homedir()` answers with for the test. */
  home: string;
  /** A directory that is neither in the workspace folder, nor sensitive, nor too broad. */
  outside: string;
}

async function setup(
  sequence: ScenarioSpec[] = [{ scenario: { steps: [] } }],
  options: HarnessOptions & { settings?: Partial<typeof DEFAULT_SETTINGS> } = {},
): Promise<Setup> {
  const { settings, ...rest } = options;
  // The temporary directories lie under the real home (on Windows under `AppData`, which is
  // sensitive), so the test has a home of its own.
  const h = await createHarness({ realDefaults: true, sequence, ...rest });
  harnesses.push(h);
  if (settings) {
    h.env.settingsValue = { ...DEFAULT_SETTINGS, ...settings };
    h.controller.environmentChanged();
  }
  const home = join(h.root, 'home');
  const outside = join(h.root, 'elsewhere');
  await fs.mkdir(join(home, '.ssh'), { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(join(outside, 'a.txt'), 'outside\n');
  await fs.writeFile(join(outside, 'b.txt'), 'outside\n');
  restores.push(useHome(home));
  return { h, home, outside };
}

function store(h: Harness) {
  const grants = h.grants();
  if (!grants) throw new Error('no grant store');
  return grants;
}

function saved(h: Harness) {
  const list = h.saved();
  if (!list) throw new Error('no saved permissions');
  return list;
}

function dialogsOf(h: Harness, ...titles: string[]): Dialog[] {
  return h.ui
    .callsOf('confirm')
    .map((call) => call[0] as Dialog)
    .filter((dialog) => titles.length === 0 || titles.includes(dialog.title));
}

/** Holds the dialogs with these titles open until `release` is called. */
function holdDialog(h: Harness, ...titles: string[]): () => void {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.ui.onConfirm = (input) => (titles.includes(input.title) ? held : undefined);
  return release;
}

/** How many patches of the view's permissions it has received. */
function permissionPatches(view: TestView): number {
  return view.patches().filter((patch) => patch.ops.some((op) => op.path[0] === 'permissions'))
    .length;
}

function switchesOf(h: Harness, key: FolderKey = FOLDER_KEY): string[] {
  return store(h).get(key).switches;
}

function grantsOf(h: Harness, key: FolderKey = FOLDER_KEY): Grant[] {
  return store(h).get(key).grants;
}

async function secondFolder(h: Harness): Promise<string> {
  const path = join(h.root, 'work2');
  await fs.mkdir(path, { recursive: true });
  h.env.folderList = [...h.env.folderList, { key: SECOND_FOLDER, name: 'work2', path }];
  h.controller.environmentChanged();
  return path;
}

// ---- scenarios ---------------------------------------------------------------------------------------

function denied(toolUseId: string): Step {
  return userToolResult(toolUseId, 'denied', {
    isError: true,
    decision: rejected,
    nonExecutionKind: 'permission-rule',
  });
}

function readSteps(file: string, toolUseId: string): Step[] {
  const input = { file_path: file };
  return [
    assistantToolUse(toolUseId, 'Read', input),
    {
      permission: {
        toolName: 'Read',
        input,
        toolUseId,
        onAllow: [userToolResult(toolUseId, 'contents', { decision: allowed })],
        onDeny: [denied(toolUseId)],
      },
    },
  ];
}

function fetchSteps(url: string, toolUseId: string): Step[] {
  const input = { url };
  return [
    assistantToolUse(toolUseId, 'WebFetch', input),
    {
      permission: {
        toolName: 'WebFetch',
        input,
        toolUseId,
        onAllow: [userToolResult(toolUseId, 'fetched', { decision: allowed })],
        onDeny: [denied(toolUseId)],
      },
    },
  ];
}

function scenario(...parts: Step[][]): ScenarioSpec {
  return {
    scenario: {
      steps: [stateEvent('running'), initEvent(), ...parts.flat(), ...resultStep('done')],
    },
  };
}

function sendAsk(view: TestView, text = 'go'): void {
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'ask',
    model: 'default',
  });
}

function pendingPrompt(view: TestView): PermissionPrompt | undefined {
  const prompt = view.state?.active?.prompts.find((candidate) => candidate.state === 'pending');
  return prompt?.kind === 'permission' ? prompt : undefined;
}

async function answer(
  view: TestView,
  choice: 'allow-once' | 'allow-always' | 'deny',
): Promise<PermissionPrompt> {
  await until('a prompt', () => pendingPrompt(view) !== undefined);
  const prompt = pendingPrompt(view);
  if (!prompt) throw new Error('no prompt');
  view.send({
    type: 'prompt.answer',
    promptId: prompt.id,
    displayHash: prompt.displayHash,
    answer: { kind: 'permission', choice },
  });
  return prompt;
}

function toolCalls(view: TestView): ToolCallView[] {
  return view
    .active()
    .messages.filter((m): m is AssistantMessage => m.role === 'assistant')
    .flatMap((message) =>
      message.parts.flatMap((part) => (part.kind === 'tool' ? [part.call] : [])),
    );
}

/** A new Ask turn, up to its first prompt. */
async function askUntilPrompt(h: Harness): Promise<{ view: TestView; prompt: PermissionPrompt }> {
  const view = h.attach();
  sendAsk(view);
  await until('the prompt', () => pendingPrompt(view) !== undefined);
  const prompt = pendingPrompt(view);
  if (!prompt) throw new Error('no prompt');
  return { view, prompt };
}

/** Answers the pending prompt with "Always allow". */
function chooseAlways(view: TestView, prompt: PermissionPrompt): void {
  view.send({
    type: 'prompt.answer',
    promptId: prompt.id,
    displayHash: prompt.displayHash,
    answer: { kind: 'permission', choice: 'allow-always' },
  });
}

/**
 * Files in the directory `elsewhere` next to the workspace folder (`$CWD` is the workspace folder),
 * which `setup` creates. A scenario is built before the harness exists, so it names them like this.
 */
const OUT_A = '$CWD/../elsewhere/a.txt';
const OUT_B = '$CWD/../elsewhere/b.txt';

// ---- the view state ----------------------------------------------------------------------------------

describe('the permissions a view shows', () => {
  it('are those of the folder the view shows, and follow it', async () => {
    const { h } = await setup();
    await secondFolder(h);
    await store(h).setSwitch(SECOND_FOLDER, 'web-search', true);
    await store(h).setSwitch(FOLDER_KEY, 'web-fetch', true);
    const view = h.attach();
    h.controller.environmentChanged();
    expect(view.current().permissions).toEqual({
      folder: FOLDER_KEY,
      switches: ['web-fetch'],
      saved: [],
    });
    view.send({ type: 'conversation.new', folder: SECOND_FOLDER });
    await until('the second folder', () => view.current().permissions.folder === SECOND_FOLDER);
    expect(view.current().permissions.switches).toEqual(['web-search']);
    view.expectMirror();
  });

  it('are empty without a folder', async () => {
    const { h } = await setup(undefined, { noFolder: true });
    const view = h.attach();
    expect(view.current().permissions).toEqual({ folder: null, switches: [], saved: [] });
  });

  it('list both stores', async () => {
    const { h, outside } = await setup();
    await h.rules()?.add(FOLDER_KEY, 'Bash(npm test)');
    await store(h).add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    const view = h.attach();
    h.controller.environmentChanged();
    expect(view.current().permissions.saved.map((entry) => [entry.kind, entry.text])).toEqual([
      ['read-directory', outside],
      ['command', 'npm test'],
    ]);
    view.expectMirror();
  });
});

// ---- switches ----------------------------------------------------------------------------------------

describe('turning a switch on', () => {
  it('saves nothing when the dialog is declined', async () => {
    const { h } = await setup();
    h.ui.confirmAnswer = false;
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    await until('the permissions sent again', () => permissionPatches(view) === 1);
    expect(switchesOf(h)).toEqual([]);
    expect(view.current().permissions.switches).toEqual([]);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('asks once per message, and a message alone adds none of the three', async () => {
    const { h } = await setup();
    h.ui.confirmAnswer = false;
    const view = h.attach();
    let asked = 0;
    for (const name of ['read-outside', 'web-fetch', 'web-search'] as const) {
      view.send({ type: 'permissions.setSwitch', name, on: true });
      asked += 1;
      // One dialog at a time: the next message comes when the view has its answer.
      await until('the dialog', () => h.ui.callsOf('confirm').length === asked);
      await until('the permissions sent again', () => permissionPatches(view) === asked);
    }
    expect(switchesOf(h)).toEqual([]);
    expect(await fs.readdir(join(h.storage, 'permissions'))).toEqual([]);
  });

  it('is on after the dialog is confirmed, and every view of the folder shows it', async () => {
    const { h } = await setup();
    const view = h.attach();
    const other = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('the switch', () => view.current().permissions.switches.length === 1);
    expect(switchesOf(h)).toEqual(['read-outside']);
    expect(other.current().permissions.switches).toEqual(['read-outside']);
    const [dialog] = dialogsOf(h);
    expect(dialog?.title).toBe(READ_OUTSIDE_TITLE);
    expect(dialog?.confirmLabel).toBe('Allow');
    expect(dialog?.detail).toContain(`Workspace folder: ${h.workspace}`);
    view.expectMirror();
    other.expectMirror();

    // It lasts: the file is in the workspace storage.
    const file = JSON.parse(
      await fs.readFile(join(h.storage, 'permissions', `${FOLDER_KEY}.json`), 'utf8'),
    ) as { switches: string[] };
    expect(file.switches).toEqual(['read-outside']);
  });

  it('does nothing and asks nothing when it is on already', async () => {
    const { h } = await setup();
    await store(h).setSwitch(FOLDER_KEY, 'web-fetch', true);
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'web-fetch', on: true });
    await until('the permissions sent again', () => permissionPatches(view) === 1);
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(view.toasts).toEqual([]);
  });

  it('is refused in an untrusted workspace, with no dialog', async () => {
    const { h } = await setup(undefined, { untrusted: true });
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.untrustedRefusal });
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(switchesOf(h)).toEqual([]);
    // The view is told, so that its control is released.
    expect(permissionPatches(view)).toBe(1);
  });

  it('is refused without a folder', async () => {
    const { h } = await setup(undefined, { noFolder: true });
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.noFolder });
    expect(h.ui.callsOf('confirm')).toEqual([]);
  });

  it('is refused while another permissions dialog of the view is open', async () => {
    const { h } = await setup();
    const release = holdDialog(h, READ_OUTSIDE_TITLE);
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    view.send({ type: 'permissions.setSwitch', name: 'web-fetch', on: true });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.permissionDialogOpen });
    // Neither a folder picker nor a second dialog.
    view.send({ type: 'permissions.addDirectory' });
    await until('a second toast', () => view.toasts.length === 2);
    expect(h.ui.callsOf('pickDirectory')).toEqual([]);
    expect(h.ui.callsOf('confirm')).toHaveLength(1);
    release();
    await until('the switch', () => switchesOf(h).length === 1);
    expect(switchesOf(h)).toEqual(['read-outside']);

    // Another view of the same folder is not held up by it.
    const other = h.attach();
    other.send({ type: 'permissions.setSwitch', name: 'web-search', on: true });
    await until('the other switch', () => switchesOf(h).length === 2);
  });

  it('is not saved when the view moved to a folder that is another one while the dialog was open', async () => {
    const { h } = await setup();
    await secondFolder(h);
    const release = holdDialog(h, READ_OUTSIDE_TITLE);
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    view.send({ type: 'conversation.new', folder: SECOND_FOLDER });
    await until('the second folder', () => view.current().permissions.folder === SECOND_FOLDER);
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.permissionChangedDuringDialog });
    expect(switchesOf(h, FOLDER_KEY)).toEqual([]);
    expect(switchesOf(h, SECOND_FOLDER)).toEqual([]);
    expect(view.current().permissions.switches).toEqual([]);
    view.expectMirror();
  });

  it('is not saved when the workspace stopped being trusted while the dialog was open', async () => {
    const { h } = await setup();
    const release = holdDialog(h, READ_OUTSIDE_TITLE);
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    h.env.trustedValue = false;
    h.controller.environmentChanged();
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.permissionChangedDuringDialog);
    expect(switchesOf(h)).toEqual([]);
  });

  it('is not saved when the view was closed while the dialog was open', async () => {
    const { h } = await setup();
    const release = holdDialog(h, READ_OUTSIDE_TITLE);
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    view.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(switchesOf(h)).toEqual([]);
  });

  it('is left off, with a warning, when it cannot be saved', async () => {
    const { h } = await setup();
    const grants = store(h);
    grants.setSwitch = () => Promise.reject(new Error('the disk is full'));
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'web-search', on: true });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.switchNotChanged });
    expect(view.current().permissions.switches).toEqual([]);
    expect(h.logger.has('warn', 'a switch could not be changed')).toBe(true);
  });
});

describe('turning a switch off', () => {
  it('needs no dialog and is also done in an untrusted workspace', async () => {
    const { h } = await setup(undefined, { untrusted: true });
    await store(h).setSwitch(FOLDER_KEY, 'web-fetch', true);
    const view = h.attach();
    h.controller.environmentChanged();
    expect(view.current().permissions.switches).toEqual(['web-fetch']);
    view.send({ type: 'permissions.setSwitch', name: 'web-fetch', on: false });
    await until('it is off', () => view.current().permissions.switches.length === 0);
    expect(switchesOf(h)).toEqual([]);
    expect(h.ui.callsOf('confirm')).toEqual([]);
  });

  it('reports a failure and keeps what was saved', async () => {
    const { h } = await setup();
    await store(h).setSwitch(FOLDER_KEY, 'web-fetch', true);
    store(h).setSwitch = () => Promise.reject(new Error('the disk is full'));
    const view = h.attach();
    h.controller.environmentChanged();
    view.send({ type: 'permissions.setSwitch', name: 'web-fetch', on: false });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.switchNotChanged });
    expect(view.current().permissions.switches).toEqual(['web-fetch']);
  });

  it('during a running turn makes the next outside read of that turn ask', async () => {
    const { h } = await setup([
      scenario(readSteps(OUT_A, 'toolu_1'), [{ sleep: 1000 }], readSteps(OUT_B, 'toolu_2')),
    ]);
    const view = h.attach();
    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: true });
    await until('the switch', () => view.current().permissions.switches.length === 1);
    sendAsk(view);
    await until(
      'the first read',
      () => view.state?.active !== null && toolCalls(view)[0]?.status === 'done',
    );
    // The first read ran without asking.
    expect(toolCalls(view)[0]).toMatchObject({ name: 'Read', approval: 'user' });
    expect(view.active().prompts).toEqual([]);
    expect(h.controller.runningTurns()).toBe(1);

    view.send({ type: 'permissions.setSwitch', name: 'read-outside', on: false });
    await until('the switch to be off', () => view.current().permissions.switches.length === 0);
    expect(h.controller.runningTurns()).toBe(1);

    // The second read of the same turn asks.
    const prompt = await answer(view, 'deny');
    expect(prompt.category).toBe('read-outside');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => [call.status, call.approval])).toEqual([
      ['done', 'user'],
      ['denied', 'user'],
    ]);
    // Only the dialog that turned it on.
    expect(dialogsOf(h).map((dialog) => dialog.title)).toEqual([READ_OUTSIDE_TITLE]);
  });
});

// ---- removing ----------------------------------------------------------------------------------------

describe('removing a saved permission', () => {
  async function withTwoViews() {
    const context = await setup();
    const { h, outside } = context;
    await h.rules()?.add(FOLDER_KEY, 'Bash(npm test)');
    await store(h).add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    const view = h.attach();
    const other = h.attach();
    h.controller.environmentChanged();
    return { ...context, view, other };
  }

  it('does nothing for an id that no entry has, and says the same view again', async () => {
    const { h, view, other } = await withTwoViews();
    const before = saved(h).list(FOLDER_KEY);
    const patches = permissionPatches(view);
    const otherPatches = permissionPatches(other);
    view.send({ type: 'permissions.remove', id: 'no-such-entry' });
    await until('the permissions sent again', () => permissionPatches(view) === patches + 1);
    expect(saved(h).list(FOLDER_KEY)).toEqual(before);
    expect(h.rules()?.list(FOLDER_KEY)).toEqual(['Bash(npm test)']);
    expect(grantsOf(h)).toHaveLength(1);
    expect(permissionPatches(other)).toBe(otherPatches);
    expect(view.toasts).toEqual([]);
  });

  it('removes a command from the rule store, and every view of the folder shows it', async () => {
    const { h, view, other } = await withTwoViews();
    const entry = saved(h)
      .list(FOLDER_KEY)
      .find((item) => item.kind === 'command');
    if (!entry) throw new Error('no command entry');
    view.send({ type: 'permissions.remove', id: entry.id });
    await until('the command to go', () => other.current().permissions.saved.length === 1);
    expect(h.rules()?.list(FOLDER_KEY)).toEqual([]);
    expect(grantsOf(h)).toHaveLength(1);
    expect(view.current().permissions.saved.map((item) => item.kind)).toEqual(['read-directory']);
    expect(h.ui.callsOf('confirm')).toEqual([]);
    view.expectMirror();
    other.expectMirror();
  });

  it('removes a directory from the grant store, and every view of the folder shows it', async () => {
    const { h, view, other } = await withTwoViews();
    const entry = saved(h)
      .list(FOLDER_KEY)
      .find((item) => item.kind === 'read-directory');
    if (!entry) throw new Error('no directory entry');
    view.send({ type: 'permissions.remove', id: entry.id });
    await until('the directory to go', () => other.current().permissions.saved.length === 1);
    expect(grantsOf(h)).toEqual([]);
    expect(h.rules()?.list(FOLDER_KEY)).toEqual(['Bash(npm test)']);
    expect(other.current().permissions.saved.map((item) => item.kind)).toEqual(['command']);
    expect(h.ui.callsOf('confirm')).toEqual([]);
  });

  it('is also done in an untrusted workspace', async () => {
    const { h, outside } = await setup(undefined, { untrusted: true });
    await store(h).add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    const view = h.attach();
    h.controller.environmentChanged();
    const [entry] = view.current().permissions.saved;
    if (!entry) throw new Error('no entry');
    view.send({ type: 'permissions.remove', id: entry.id });
    await until('the entry to go', () => view.current().permissions.saved.length === 0);
    expect(grantsOf(h)).toEqual([]);
  });

  it('warns and keeps the entry when the store cannot remove it', async () => {
    const { h, view } = await withTwoViews();
    const rules = h.rules();
    if (!rules) throw new Error('no rules');
    rules.remove = () => Promise.reject(new Error('the disk is full'));
    const entry = saved(h)
      .list(FOLDER_KEY)
      .find((item) => item.kind === 'command');
    if (!entry) throw new Error('no command entry');
    view.send({ type: 'permissions.remove', id: entry.id });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.permissionNotRemoved });
    expect(view.current().permissions.saved).toHaveLength(2);
  });
});

// ---- adding a folder ---------------------------------------------------------------------------------

describe('adding a folder in the view', () => {
  it('saves nothing when the picker is dismissed, and tells the view', async () => {
    const { h } = await setup();
    h.ui.directoryAnswer = undefined;
    const view = h.attach();
    view.send({ type: 'permissions.addDirectory' });
    await until('the permissions sent again', () => permissionPatches(view) === 1);
    expect(h.ui.callsOf('pickDirectory')).toEqual([
      [{ title: 'Allow reads in a folder', openLabel: 'Choose Folder' }],
    ]);
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(grantsOf(h)).toEqual([]);
    expect(view.toasts).toEqual([]);
  });

  it.each([
    ['a folder inside the workspace', 'inside-folder'],
    ['a drive or filesystem root', 'too-broad'],
    ['the home directory', 'too-broad'],
    ['a credential location', 'sensitive'],
    ['a folder that does not exist', 'not-a-directory'],
  ] as const)('refuses %s with its message and no dialog', async (name, reason) => {
    const { h, home } = await setup();
    const inside = join(h.workspace, 'sub');
    await fs.mkdir(inside, { recursive: true });
    h.ui.directoryAnswer = {
      'a folder inside the workspace': inside,
      'a drive or filesystem root': parse(h.workspace).root,
      'the home directory': home,
      'a credential location': join(home, '.ssh'),
      'a folder that does not exist': join(h.root, 'missing'),
    }[name];
    const view = h.attach();
    view.send({ type: 'permissions.addDirectory' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.directoryRefusal[reason] });
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(grantsOf(h)).toEqual([]);
    expect(permissionPatches(view)).toBe(1);
  });

  it('refuses a folder inside one that is saved already', async () => {
    const { h, outside } = await setup();
    const below = join(outside, 'below');
    await fs.mkdir(below);
    await store(h).add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    h.ui.directoryAnswer = below;
    const view = h.attach();
    view.send({ type: 'permissions.addDirectory' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.directoryRefusal.covered);
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(grantsOf(h)).toHaveLength(1);
  });

  it('saves a valid folder only after the dialog that names it is confirmed', async () => {
    const { h, outside } = await setup();
    h.ui.directoryAnswer = outside;
    const release = holdDialog(h, DIRECTORY_TITLE);
    const view = h.attach();
    const other = h.attach();
    view.send({ type: 'permissions.addDirectory' });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    expect(grantsOf(h)).toEqual([]);
    const [dialog] = dialogsOf(h);
    expect(dialog?.title).toBe(DIRECTORY_TITLE);
    expect(dialog?.confirmLabel).toBe('Always allow');
    expect(dialog?.detail).toContain(`Directory: ${outside}\nWorkspace folder: ${h.workspace}`);
    release();
    await until('the folder', () => grantsOf(h).length === 1);
    expect(grantsOf(h)).toEqual([{ kind: 'read-directory', path: outside }]);
    await until('both views', () => other.current().permissions.saved.length === 1);
    expect(view.current().permissions.saved[0]).toMatchObject({
      kind: 'read-directory',
      text: outside,
    });
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('saves nothing when the dialog is declined', async () => {
    const { h, outside } = await setup();
    h.ui.directoryAnswer = outside;
    h.ui.confirmAnswer = false;
    const view = h.attach();
    view.send({ type: 'permissions.addDirectory' });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    await until('the permissions sent again', () => permissionPatches(view) === 1);
    expect(grantsOf(h)).toEqual([]);
    expect(view.current().permissions.saved).toEqual([]);
  });

  it('is refused in an untrusted workspace, without a folder, and while a dialog is open', async () => {
    const untrusted = await setup(undefined, { untrusted: true });
    untrusted.h.ui.directoryAnswer = untrusted.outside;
    const a = untrusted.h.attach();
    a.send({ type: 'permissions.addDirectory' });
    await until('a toast', () => a.toasts.length === 1);
    expect(a.toasts[0]?.text).toBe(TEXT.untrustedRefusal);
    expect(untrusted.h.ui.callsOf('pickDirectory')).toEqual([]);

    const none = await setup(undefined, { noFolder: true });
    const b = none.h.attach();
    b.send({ type: 'permissions.addDirectory' });
    await until('a toast', () => b.toasts.length === 1);
    expect(b.toasts[0]?.text).toBe(TEXT.noFolder);
    expect(none.h.ui.callsOf('pickDirectory')).toEqual([]);

    const busy = await setup();
    busy.h.ui.directoryAnswer = busy.outside;
    const release = holdDialog(busy.h, DIRECTORY_TITLE);
    const c = busy.h.attach();
    c.send({ type: 'permissions.addDirectory' });
    await until('the dialog', () => busy.h.ui.callsOf('confirm').length === 1);
    c.send({ type: 'permissions.addDirectory' });
    c.send({ type: 'permissions.setSwitch', name: 'web-fetch', on: true });
    await until('two toasts', () => c.toasts.length === 2);
    expect(c.toasts.map((toast) => toast.text)).toEqual([
      TEXT.permissionDialogOpen,
      TEXT.permissionDialogOpen,
    ]);
    expect(busy.h.ui.callsOf('pickDirectory')).toHaveLength(1);
    release();
    await until('the folder', () => grantsOf(busy.h).length === 1);
    expect(switchesOf(busy.h)).toEqual([]);
  });

  it('is not saved when the view moved to another folder while the dialog was open', async () => {
    const { h, outside } = await setup();
    await secondFolder(h);
    h.ui.directoryAnswer = outside;
    const release = holdDialog(h, DIRECTORY_TITLE);
    const view = h.attach();
    view.send({ type: 'permissions.addDirectory' });
    await until('the dialog', () => h.ui.callsOf('confirm').length === 1);
    view.send({ type: 'conversation.new', folder: SECOND_FOLDER });
    await until('the second folder', () => view.current().permissions.folder === SECOND_FOLDER);
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.permissionChangedDuringDialog);
    expect(grantsOf(h, FOLDER_KEY)).toEqual([]);
    expect(grantsOf(h, SECOND_FOLDER)).toEqual([]);
  });

  it('warns when the confirmed folder cannot be saved', async () => {
    const { h, outside } = await setup();
    store(h).add = () => Promise.reject(new Error('the disk is full'));
    h.ui.directoryAnswer = outside;
    const view = h.attach();
    view.send({ type: 'permissions.addDirectory' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.permissionNotSaved });
    expect(view.current().permissions.saved).toEqual([]);
  });
});

// ---- the card's "Always allow this?" -----------------------------------------------------------------

describe('an always answer on a read-outside card', () => {
  const sequence = [scenario(readSteps(OUT_A, 'toolu_r'))];

  it('is allowed once and saves nothing when the dialog is declined', async () => {
    const { h, outside } = await setup(sequence);
    h.ui.confirmAnswer = false;
    const { view, prompt } = await askUntilPrompt(h);
    expect(prompt.choices).toEqual(['allow-once', 'allow-always', 'deny']);
    expect(prompt.alwaysRule).toEqual({
      kind: 'read-directory',
      rule: outside,
      runsProjectCode: false,
    });
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    expect(dialogsOf(h).map((dialog) => dialog.title)).toEqual([CARD_TITLE]);
    expect(grantsOf(h)).toEqual([]);
    const settled = view.active().prompts[0];
    expect(settled?.kind === 'permission' && settled.answered).toBe('allow-once');
    expect(toolCalls(view)[0]).toMatchObject({ name: 'Read', status: 'done', approval: 'user' });
    expect(view.toasts).toEqual([]);
    expect(view.current().permissions.saved).toEqual([]);
  });

  it('saves the directory when the dialog is confirmed, and the view lists it and the next read does not ask', async () => {
    const { h, outside } = await setup(sequence);
    const { view, prompt } = await askUntilPrompt(h);
    const other = h.attach();
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    const [dialog] = dialogsOf(h);
    expect(dialog?.title).toBe(CARD_TITLE);
    expect(dialog?.confirmLabel).toBe('Always allow');
    expect(dialog?.detail).toContain(`Directory: ${outside}`);
    expect(dialog?.detail).toContain(`Workspace folder: ${h.workspace}`);
    expect(grantsOf(h)).toEqual([{ kind: 'read-directory', path: outside }]);
    expect(view.toasts).toEqual([]);
    expect(view.current().permissions.saved).toMatchObject([
      { kind: 'read-directory', text: outside },
    ]);
    // Every view of the folder shows it.
    expect(other.current().permissions.saved).toMatchObject([
      { kind: 'read-directory', text: outside },
    ]);
    view.expectMirror();

    sendAsk(view, 'again');
    await until('the second turn', () => view.active().turns.length === 2);
    await finishedTurn(h, view);
    expect(view.active().prompts).toHaveLength(1);
    expect(toolCalls(view).map((call) => [call.status, call.approval])).toEqual([
      ['done', 'user'],
      ['done', 'user'],
    ]);
    expect(dialogsOf(h)).toHaveLength(1);
  });

  it('warns, and still allows the call once, when the directory cannot be saved', async () => {
    const { h } = await setup(sequence);
    store(h).add = () => Promise.reject(new Error('the disk is full'));
    const { view, prompt } = await askUntilPrompt(h);
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.permissionNotSaved }]);
    expect(toolCalls(view)[0]).toMatchObject({ status: 'done', approval: 'user' });
    expect(grantsOf(h)).toEqual([]);
    expect(view.current().permissions.saved).toEqual([]);
  });

  it('is allowed once, with no dialog, when the folder of its conversation is not open', async () => {
    const { h } = await setup(sequence);
    const { view, prompt } = await askUntilPrompt(h);
    h.env.folderList = [];
    h.controller.environmentChanged();
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(grantsOf(h)).toEqual([]);
    const settled = view.active().prompts[0];
    expect(settled?.kind === 'permission' && settled.answered).toBe('allow-once');
  });
});

describe('an always answer on a web-fetch card', () => {
  const sequence = [scenario(fetchSteps('https://docs.example.com/guide', 'toolu_f'))];
  const settings = { askWebTools: true };

  it('is allowed once and saves nothing when the dialog is declined', async () => {
    const { h } = await setup(sequence, { settings });
    h.ui.confirmAnswer = false;
    const { view, prompt } = await askUntilPrompt(h);
    expect(prompt.alwaysRule).toEqual({
      kind: 'web-site',
      rule: 'docs.example.com',
      runsProjectCode: false,
    });
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    expect(dialogsOf(h).map((dialog) => dialog.title)).toEqual([CARD_TITLE]);
    expect(grantsOf(h)).toEqual([]);
    expect(toolCalls(view)[0]).toMatchObject({ name: 'WebFetch', status: 'done' });
    expect(view.toasts).toEqual([]);
  });

  it('saves the site when the dialog is confirmed, and the view lists it', async () => {
    const { h } = await setup(sequence, { settings });
    const { view, prompt } = await askUntilPrompt(h);
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    const [dialog] = dialogsOf(h);
    expect(dialog?.detail).toContain('Site: docs.example.com');
    expect(dialog?.detail).toContain(`Workspace folder: ${h.workspace}`);
    expect(grantsOf(h)).toEqual([{ kind: 'web-site', host: 'docs.example.com' }]);
    expect(view.toasts).toEqual([]);
    expect(view.current().permissions.saved).toMatchObject([
      { kind: 'web-site', text: 'docs.example.com' },
    ]);
    view.expectMirror();
  });

  it('warns, and still allows the call once, when the site cannot be saved', async () => {
    const { h } = await setup(sequence, { settings });
    store(h).add = () => Promise.reject(new Error('the disk is full'));
    const { view, prompt } = await askUntilPrompt(h);
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.permissionNotSaved }]);
    expect(toolCalls(view)[0]).toMatchObject({ status: 'done' });
    expect(grantsOf(h)).toEqual([]);
  });
});

describe('a command rule saved from a card', () => {
  it('keeps its own warning when the rule store cannot keep it', async () => {
    const input = { command: 'npm test' };
    const { h } = await setup([
      scenario([
        assistantToolUse('toolu_b', 'Bash', input),
        {
          permission: {
            toolName: 'Bash',
            input,
            toolUseId: 'toolu_b',
            onAllow: [userToolResult('toolu_b', 'ran', { decision: allowed })],
            onDeny: [denied('toolu_b')],
          },
        },
      ]),
    ]);
    const rules = h.rules();
    if (!rules) throw new Error('no rules');
    rules.add = () => Promise.reject(new Error('the disk is full'));
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'go', mode: 'agent', model: 'default' });
    await until('the prompt', () => pendingPrompt(view) !== undefined);
    const prompt = pendingPrompt(view);
    if (!prompt) throw new Error('no prompt');
    expect(prompt.alwaysRule?.kind).toBeUndefined();
    chooseAlways(view, prompt);
    await finishedTurn(h, view);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.ruleNotSaved }]);
  });
});

// ---- every handler tells the asking view ---------------------------------------------------------------

describe('every permissions message', () => {
  it('sends the permissions again to the view that asked, whatever came of it', async () => {
    const { h, outside } = await setup();
    const view = h.attach();
    let expected = permissionPatches(view);
    async function sends(message: object, wait: () => boolean): Promise<void> {
      view.send(message);
      await until('the message to be handled', wait);
      expected += 1;
      await until('the permissions sent again', () => permissionPatches(view) >= expected);
      // Once more for this message, although nothing changed.
      expect(permissionPatches(view)).toBe(expected);
    }
    const asked = (count: number) => () => h.ui.callsOf('confirm').length === count;

    // A switch whose dialog is declined.
    h.ui.confirmAnswer = false;
    await sends({ type: 'permissions.setSwitch', name: 'web-search', on: true }, asked(1));
    // A folder whose dialog is declined.
    h.ui.directoryAnswer = outside;
    await sends({ type: 'permissions.addDirectory' }, asked(2));
    // A picker that is dismissed.
    h.ui.directoryAnswer = undefined;
    await sends(
      { type: 'permissions.addDirectory' },
      () => h.ui.callsOf('pickDirectory').length === 2,
    );
    // An id nobody has, and a switch that is off already.
    await sends({ type: 'permissions.remove', id: 'nothing' }, () => true);
    await sends({ type: 'permissions.setSwitch', name: 'web-fetch', on: false }, () => true);
    // A refusal.
    h.env.trustedValue = false;
    await sends(
      { type: 'permissions.setSwitch', name: 'web-search', on: true },
      () => view.toasts.length === 1,
    );
    expect(grantsOf(h)).toEqual([]);
    expect(switchesOf(h)).toEqual([]);
  });
});
