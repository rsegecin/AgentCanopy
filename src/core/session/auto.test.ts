import { promises as fs, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type {
  AssistantMessage,
  ConversationId,
  FolderKey,
  PermissionPrompt,
  PlanDoc,
  Settings,
  ToolCallView,
  UserMessage,
} from '../../shared';
import type { NewPrompt, PolicyContext, TurnPolicy, TurnRequest } from '../contracts';
import type { ConversationStore } from '../conversations/store';
import { prepareInvocation } from '../provider/claude/process/invocation';
import {
  FOLDER_KEY,
  assistantText,
  assistantToolUse,
  createHarness,
  createPlanTestPolicy,
  finishedTurn,
  providerStatus,
  resultStep,
  sendAndFinish,
  stateEvent,
  streamedText,
  stubProvider,
  textScenario,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type Step,
  type TestView,
} from './test-support';
import { AUTO_RESET_FILE } from './auto-reset';
import { TEXT, shownPath } from './text';

// The conversation store, with a way to make its meta writes fail or hold them (written, but not yet
// resolved to the controller), to hold the creation of a conversation, and a handle on the instance,
// so a test can change a stored conversation behind the controller's back.
const stores = vi.hoisted(() => ({
  latest: undefined as ConversationStore | undefined,
  failMeta: undefined as ((patch: Record<string, unknown>) => boolean) | undefined,
  /** Writes the patch (memory and disk), then reports a failure anyway: a store that kept the change. */
  failAfterWrite: undefined as ((patch: Record<string, unknown>) => boolean) | undefined,
  holdMeta: undefined as
    ((patch: Record<string, unknown>) => Promise<void> | undefined) | undefined,
  holdCreate: undefined as Promise<void> | undefined,
  /** Waits, then reports a failure without writing anything: a write that failed late. */
  failLater: undefined as
    ((patch: Record<string, unknown>) => Promise<void> | undefined) | undefined,
  /** Holds what `load` read (the snapshot is taken) before it is returned to the controller. */
  holdLoad: undefined as Promise<void> | undefined,
  /** How many loads have read their snapshot. */
  loads: 0,
  /** The patches whose write has resolved to the controller, in order. */
  landed: [] as Record<string, unknown>[],
}));
vi.mock('../conversations/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../conversations/store')>();
  return {
    ...actual,
    createConversationStore: (options: Parameters<typeof actual.createConversationStore>[0]) => {
      const store = actual.createConversationStore(options);
      const updateMeta = store.updateMeta.bind(store);
      store.updateMeta = async (id, patch) => {
        if (stores.failMeta?.(patch) === true) throw new Error('the disk is full');
        if (stores.failAfterWrite?.(patch) === true) {
          await updateMeta(id, patch);
          throw new Error('the write could not be confirmed');
        }
        const late = stores.failLater?.(patch);
        if (late) {
          await late;
          throw new Error('the disk is full');
        }
        const written = updateMeta(id, patch);
        const hold = stores.holdMeta?.(patch);
        if (hold) {
          written.catch(() => undefined);
          await hold;
        }
        const result = await written;
        stores.landed.push(patch);
        return result;
      };
      const load = store.load.bind(store);
      store.load = async (id) => {
        const data = await load(id);
        stores.loads += 1;
        if (stores.holdLoad) await stores.holdLoad;
        return data;
      };
      const create = store.create.bind(store);
      store.create = async (input) => {
        if (stores.holdCreate) await stores.holdCreate;
        return create(input);
      };
      stores.latest = store;
      return store;
    },
  };
});

// A real tracker reads the folder and the machine may be busy with other work: allow more time.
vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  stores.failMeta = undefined;
  stores.failAfterWrite = undefined;
  stores.holdMeta = undefined;
  stores.holdCreate = undefined;
  stores.failLater = undefined;
  stores.holdLoad = undefined;
  stores.loads = 0;
  stores.landed = [];
  for (const h of harnesses.splice(0)) await h.dispose();
});

const SECOND_FOLDER = 'folder-2' as FolderKey;
const allowed = { decision: 'accept', source: 'user_temporary' } as const;
const rejected = { decision: 'reject', source: 'user_reject' } as const;

const AUTO_TITLE = 'Turn on Auto for this conversation?';
const DRAFT_TITLE = 'Turn on Auto for the new conversation?';
const APPROVAL_TITLE = 'Approve and execute this plan?';
const AUTO_PARAGRAPH = 'This is Agent mode with Auto on.';
const REVIEW_PARAGRAPH =
  'Review and checkpoints undo file changes inside the folder only. They do not undo what a command does outside it, to Git or over the network, and a command can change protected files without asking.';
const STAYS_PARAGRAPH =
  'Auto stays on for this conversation, also for queued messages and approved plans, until you turn it off.';

// ---- harness -----------------------------------------------------------------------------------------

async function harness(
  sequence: ScenarioSpec[],
  options: HarnessOptions & {
    settings?: Partial<Settings>;
    beforeStart?: (h: Harness) => void;
  } = {},
): Promise<Harness> {
  const { settings, beforeStart, ...rest } = options;
  const h = await createHarness({ realDefaults: true, noStart: true, sequence, ...rest });
  harnesses.push(h);
  h.env.settingsValue = { ...DEFAULT_SETTINGS, ...settings };
  beforeStart?.(h);
  await h.controller.start();
  return h;
}

function changeSettings(h: Harness, patch: Partial<Settings>): void {
  h.env.settingsValue = { ...h.env.settingsValue, ...patch };
  h.controller.environmentChanged();
}

function store(): ConversationStore {
  if (!stores.latest) throw new Error('no store');
  return stores.latest;
}

function storedMeta(id: ConversationId) {
  return store()
    .list()
    .find((meta) => meta.id === id);
}

interface Dialog {
  title: string;
  detail: string;
  confirmLabel: string;
}

function dialogs(h: Harness, ...titles: string[]): Dialog[] {
  return h.ui
    .callsOf('confirm')
    .map((call) => call[0] as Dialog)
    .filter((dialog) => titles.includes(dialog.title));
}

function autoDialogs(h: Harness): Dialog[] {
  return dialogs(h, AUTO_TITLE, DRAFT_TITLE);
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

function setAuto(view: TestView, on: boolean, conversationId?: ConversationId): void {
  view.send({
    type: 'conversation.setAuto',
    ...(conversationId !== undefined ? { conversationId } : {}),
    on,
  });
}

/** Turns Auto on for the view's conversation through the dialog, and waits for it. */
async function turnOn(h: Harness, view: TestView): Promise<void> {
  const before = autoDialogs(h).length;
  setAuto(view, true, view.active().meta.id);
  await until('Auto to be on', () => view.state?.active?.meta.agentAuto === true);
  expect(autoDialogs(h)).toHaveLength(before + 1);
}

/** A first Ask turn, so that a conversation exists. */
async function conversation(h: Harness, view: TestView, text = 'hello'): Promise<ConversationId> {
  await sendAndFinish(h, view, text);
  return view.active().meta.id;
}

function send(view: TestView, mode: 'ask' | 'plan' | 'agent', text = 'go'): void {
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode,
    model: 'default',
  });
}

async function agentTurn(h: Harness, view: TestView, text = 'go') {
  const before = view.state?.active?.turns.length ?? 0;
  send(view, 'agent', text);
  await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > before);
  return finishedTurn(h, view);
}

function pendingPrompt(view: TestView): PermissionPrompt | undefined {
  const prompt = view.state?.active?.prompts.find((candidate) => candidate.state === 'pending');
  return prompt?.kind === 'permission' ? prompt : undefined;
}

async function answer(
  view: TestView,
  choice: 'allow-once' | 'deny',
  category?: PermissionPrompt['category'],
): Promise<PermissionPrompt> {
  await until(`a ${category ?? ''} prompt`, () => {
    const prompt = pendingPrompt(view);
    return prompt !== undefined && (category === undefined || prompt.category === category);
  });
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

function userMessages(view: TestView): UserMessage[] {
  return view.active().messages.filter((m): m is UserMessage => m.role === 'user');
}

/** What History shows of a conversation's Auto. */
function summaryAuto(view: TestView, id: ConversationId): boolean | undefined {
  return view.current().conversations.find((c) => c.id === id)?.agentAuto;
}

/** The first line of the dialog that turns Auto on, for the harness's own folder. */
function workLine(h: Harness): string {
  return `Folder: ${shownPath(h.workspace, homedir())}`;
}

/** A promise a test resolves when it wants to. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Only the write that turns Auto off on its own (not a retry carried by another change). */
function isOffWrite(patch: Record<string, unknown>): boolean {
  return Object.keys(patch).length === 1 && patch['agentAuto'] === false;
}

/** The `sandbox` section of the settings file the provider writes for a request. */
async function sandboxSettingsOf(request: TurnRequest | undefined): Promise<unknown> {
  if (!request) throw new Error('no request');
  const runDir = await fs.mkdtemp(join(tmpdir(), 'agc-auto-settings-'));
  try {
    await prepareInvocation({ ...request, runDir });
    const settings = JSON.parse(await fs.readFile(join(runDir, 'settings.json'), 'utf8')) as {
      sandbox?: unknown;
    };
    return settings.sandbox;
  } finally {
    await fs.rm(runDir, { recursive: true, force: true });
  }
}

// ---- scenarios -----------------------------------------------------------------------------------------

function denied(toolUseId: string): Step {
  return userToolResult(toolUseId, 'denied', {
    isError: true,
    decision: rejected,
    nonExecutionKind: 'permission-rule',
  });
}

/** A command that writes `writes` (relative to the folder) once it is allowed. */
function commandSteps(command: string, writes: string, toolUseId: string): Step[] {
  const input = { command };
  return [
    assistantToolUse(toolUseId, 'Bash', input),
    {
      permission: {
        toolName: 'Bash',
        input,
        toolUseId,
        onAllow: [
          { hook: { phase: 'pre', toolName: 'Bash', input, toolUseId } },
          { writeFile: { path: `$CWD/${writes}`, content: 'made by a command' } },
          { hook: { phase: 'post', toolName: 'Bash', input, toolUseId } },
          userToolResult(toolUseId, 'ran', { decision: allowed }),
        ],
        onDeny: [denied(toolUseId)],
      },
    },
  ];
}

function webFetchSteps(toolUseId: string): Step[] {
  const input = { url: 'https://example.com/' };
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

function writeSteps(name: string, content: string, toolUseId: string): Step[] {
  const input = { file_path: `$CWD/${name}`, content };
  return [
    assistantToolUse(toolUseId, 'Write', input),
    {
      permission: {
        toolName: 'Write',
        input,
        toolUseId,
        onAllow: [
          { writeFile: { path: `$CWD/${name}`, content } },
          userToolResult(toolUseId, 'written', { decision: allowed }),
        ],
        onDeny: [denied(toolUseId)],
      },
    },
  ];
}

function agentScenario(...parts: Step[][]): ScenarioSpec {
  return {
    record: true,
    scenario: {
      steps: [
        stateEvent('running'),
        initEvent(),
        ...parts.flat(),
        assistantText('done'),
        ...resultStep('done'),
      ],
    },
  };
}

function bashScenario(command = 'echo hello', writes = 'made.txt'): ScenarioSpec {
  return agentScenario(commandSteps(command, writes, 'toolu_b'));
}

function text(answerText = 'ok'): ScenarioSpec {
  return { record: true, scenario: textScenario(answerText) };
}

function slowText(): ScenarioSpec {
  return {
    record: true,
    scenario: {
      steps: [...streamedText(['one ', 'two ', 'three'], { pauseMs: 400 }), ...resultStep('ok')],
    },
  };
}

const hanging: ScenarioSpec = {
  record: true,
  scenario: { steps: [...streamedText(['working']), { hang: true }] },
};

function submitPlanScenario(): ScenarioSpec {
  return {
    scenario: {
      steps: [
        stateEvent('running'),
        initEvent(),
        {
          callTool: {
            name: 'submit_plan',
            arguments: {
              title: 'Make a file',
              objective: 'Run a command.',
              stages: [{ id: 's1', title: 'Run', description: 'Do it.' }],
            },
            saveAs: 'result',
          },
        },
        assistantText('Planned.'),
        ...resultStep('Planned.'),
      ],
    },
  };
}

async function planned(h: Harness, view: TestView): Promise<PlanDoc> {
  view.send({ type: 'turn.send', text: 'plan it', mode: 'plan', model: 'default' });
  await until('the plan', () => view.state?.active?.plan?.versions.length === 1);
  await finishedTurn(h, view);
  const plan = view.active().plan;
  if (!plan) throw new Error('no plan');
  return plan;
}

function approve(view: TestView, plan: PlanDoc): void {
  view.send({
    type: 'plan.approve',
    planId: plan.id,
    version: 1,
    contentHash: plan.versions[0]?.contentHash ?? 'missing',
  });
}

// ---- turning it on -----------------------------------------------------------------------------------

describe('turning Auto on', () => {
  it('asks in a native dialog and changes nothing when the dialog is declined', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    h.ui.confirmAnswer = false;
    setAuto(view, true, id);
    await until('the dialog', () => autoDialogs(h).length === 1);
    // A later change of the same conversation, written after anything the declined dialog could
    // have written, and carried back into memory from the store.
    view.send({ type: 'conversation.rename', conversationId: id, title: 'later' });
    await until('the rename', () => view.active().meta.title === 'later');
    await store().flush();
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(storedMeta(id)).not.toHaveProperty('agentAuto');
    expect(summaryAuto(view, id)).toBeUndefined();
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('declined for a draft, changes nothing: the first message runs without Auto', async () => {
    const h = await harness([bashScenario()]);
    const view = h.attach();
    h.ui.confirmAnswer = false;
    setAuto(view, true);
    await until('the dialog', () => autoDialogs(h).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.current().draftAgentAuto).toBe(false);
    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(storedMeta(view.active().meta.id)).not.toHaveProperty('agentAuto');
    expect(userMessages(view)[0]).not.toHaveProperty('auto');
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(view.toasts).toEqual([]);
  });

  it('turns it on when the dialog is accepted, with the five paragraphs', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    expect(storedMeta(id)?.agentAuto).toBe(true);
    expect(view.current().conversations.find((c) => c.id === id)?.agentAuto).toBe(true);
    const [dialog] = autoDialogs(h);
    expect(dialog).toEqual({
      title: AUTO_TITLE,
      confirmLabel: 'Turn On Auto',
      detail: [
        `${workLine(h)}\nConversation: hello`,
        'Agent turns in this conversation run terminal commands and edits inside the folder without asking for each one. Commands run with your privileges.',
        'Commands are not sandboxed.',
        'Still asks: protected files, anything outside the folder, web access and other tools.',
        REVIEW_PARAGRAPH,
        STAYS_PARAGRAPH,
      ].join('\n\n'),
    });
    // On already: nothing, and no second dialog.
    setAuto(view, true, id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(autoDialogs(h)).toHaveLength(1);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('names alwaysAskCommands and the web setting in the dialog', async () => {
    const h = await harness([text()], {
      settings: { alwaysAskCommands: true, agentAutoWebTools: true },
    });
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    expect(autoDialogs(h)[0]?.detail).toBe(
      [
        `${workLine(h)}\nConversation: hello`,
        'Agent turns in this conversation run edits inside the folder without asking for each one. Terminal commands still ask, because agentCanopy.agent.alwaysAskCommands is on.',
        'Commands are not sandboxed.',
        'Still asks: protected files, anything outside the folder and other tools. Web fetch and web search also run without asking (agentCanopy.agent.auto.webTools).',
        REVIEW_PARAGRAPH,
        STAYS_PARAGRAPH,
      ].join('\n\n'),
    );
  });

  it.each([
    [
      true,
      'The sandbox is requested by your settings; AgentCanopy cannot verify that it is active. With Auto on, a command cannot leave it.',
    ],
    [
      false,
      'The sandbox setting is on, but the sandbox is not available on this platform: commands are not sandboxed.',
    ],
  ])('says what is known of the sandbox (available: %s)', async (available, sentence) => {
    const status = providerStatus();
    const h = await createHarness({
      providers: [
        stubProvider(
          providerStatus({ capabilities: { ...status.capabilities, sandbox: available } }),
        ),
      ],
      noStart: true,
    });
    harnesses.push(h);
    h.env.settingsValue = { ...DEFAULT_SETTINGS, sandbox: true };
    await h.controller.start();
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    expect(autoDialogs(h)).toEqual([
      {
        title: DRAFT_TITLE,
        confirmLabel: 'Turn On Auto',
        detail: [
          `${workLine(h)}\nConversation: new`,
          'Agent turns in this conversation run terminal commands and edits inside the folder without asking for each one. Commands run with your privileges.',
          sentence,
          'Still asks: protected files, anything outside the folder, web access and other tools.',
          REVIEW_PARAGRAPH,
          STAYS_PARAGRAPH,
        ].join('\n\n'),
      },
    ]);
  });

  it('writes model-written text in the dialog as plain text', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    view.send({ type: 'conversation.rename', conversationId: id, title: 'a‮b' });
    await until('the rename', () => view.active().meta.title === 'a‮b');
    await turnOn(h, view);
    expect(autoDialogs(h)[0]?.detail).toContain(`${workLine(h)}\nConversation: a\\u{202E}b\n\n`);
  });

  it('is refused while a turn runs, and Auto never comes on during it', async () => {
    const h = await harness([text(), hanging]);
    const view = h.attach();
    const id = await conversation(h, view);
    send(view, 'agent');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    setAuto(view, true, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoWaitForTurn });
    expect(autoDialogs(h)).toEqual([]);
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    view.send({ type: 'turn.cancel', conversationId: id });
    await h.idle();
  });

  it('is refused while the plan approval dialog is open', async () => {
    const h = await harness([submitPlanScenario()]);
    const view = h.attach();
    const plan = await planned(h, view);
    const release = holdDialog(h, APPROVAL_TITLE);
    approve(view, plan);
    await until('the approval dialog', () => dialogs(h, APPROVAL_TITLE).length === 1);
    setAuto(view, true, view.active().meta.id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoWaitForTurn });
    expect(autoDialogs(h)).toEqual([]);
    h.ui.confirmAnswer = false;
    release();
    await h.idle();
    expect(view.active().meta).not.toHaveProperty('agentAuto');
  });

  it('is refused with the setting off, in an untrusted workspace and for an unknown conversation', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);

    changeSettings(h, { agentAuto: false });
    setAuto(view, true, id);
    setAuto(view, true);
    await until('two toasts', () => view.toasts.length === 2);
    expect(view.toasts.map((t) => t.text)).toEqual([TEXT.autoNotOffered, TEXT.autoNotOffered]);

    changeSettings(h, { agentAuto: true });
    h.env.trustedValue = false;
    setAuto(view, true, id);
    await until('a third toast', () => view.toasts.length === 3);
    expect(view.toasts[2]?.text).toBe(TEXT.untrustedRefusal);

    h.env.trustedValue = true;
    setAuto(view, true, 'no-such-conversation' as ConversationId);
    await until('a fourth toast', () => view.toasts.length === 4);
    expect(view.toasts[3]?.text).toBe(TEXT.conversationGone);

    expect(autoDialogs(h)).toEqual([]);
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(view.current().draftAgentAuto).toBe(false);
  });

  it('is refused while another Auto dialog of the view is open', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    const release = holdDialog(h, AUTO_TITLE);
    setAuto(view, true, id);
    await until('the dialog', () => autoDialogs(h).length === 1);
    setAuto(view, true, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoDialogOpen });
    expect(autoDialogs(h)).toHaveLength(1);
    release();
    await until('Auto to be on', () => view.active().meta.agentAuto === true);
  });

  it('checks again after the dialog: a turn that started meanwhile keeps it off', async () => {
    const h = await harness([text(), hanging]);
    const view = h.attach();
    const id = await conversation(h, view);
    const release = holdDialog(h, AUTO_TITLE);
    setAuto(view, true, id);
    await until('the dialog', () => autoDialogs(h).length === 1);
    send(view, 'agent');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoChangedDuringDialog });
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(storedMeta(id)).not.toHaveProperty('agentAuto');
    view.send({ type: 'turn.cancel', conversationId: id });
    await h.idle();
  });

  it('checks again after the dialog: the setting turned off meanwhile keeps it off', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    const release = holdDialog(h, AUTO_TITLE);
    setAuto(view, true, id);
    await until('the dialog', () => autoDialogs(h).length === 1);
    changeSettings(h, { agentAuto: false });
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.autoChangedDuringDialog);
    expect(storedMeta(id)).not.toHaveProperty('agentAuto');
  });
});

// ---- turns with Auto ----------------------------------------------------------------------------------

describe('a turn with Auto', () => {
  it('runs a command without a prompt, labelled, captured and undoable', async () => {
    const h = await harness([text(), bashScenario('echo hello', 'made.txt')]);
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');

    const turn = await agentTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(view.active().prompts).toEqual([]);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', status: 'done', approval: 'auto' }]);
    const users = userMessages(view);
    expect(users[0]).not.toHaveProperty('auto');
    expect(users[1]?.auto).toBe(true);
    expect((await h.record()).stdin).toContain(AUTO_PARAGRAPH);
    expect(await fs.readFile(join(h.workspace, 'made.txt'), 'utf8')).toBe('made by a command');

    // Recorded for review like any command's change, and rejecting it undoes it.
    await until('the review entry', () =>
      view.current().review.entries.some((e) => e.path === 'made.txt' && e.status === 'pending'),
    );
    view.send({ type: 'review.rejectFile', path: 'made.txt' });
    await until('the entry to go', () =>
      view.current().review.entries.every((e) => e.path !== 'made.txt'),
    );
    await expect(fs.access(join(h.workspace, 'made.txt'))).rejects.toThrow();
    view.expectMirror();
  });

  it('does not cover commands with alwaysAskCommands on, and does not tell the model it does', async () => {
    const h = await harness([text(), bashScenario()], { settings: { alwaysAskCommands: true } });
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(view)[1]?.auto).toBe(true);
    expect((await h.record()).stdin).not.toContain(AUTO_PARAGRAPH);
  });

  it('turned off during a turn: the next command asks, without a dialog', async () => {
    const h = await harness([
      text(),
      agentScenario(
        commandSteps('echo one', 'one.txt', 'toolu_1'),
        webFetchSteps('toolu_2'),
        commandSteps('echo two', 'two.txt', 'toolu_3'),
      ),
    ]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    // The web fetch still asks; the first command ran without a prompt.
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');
    expect(toolCalls(view)[0]).toMatchObject({ name: 'Bash', approval: 'auto' });

    setAuto(view, false, id);
    await until('Auto to be off', () => view.active().meta.agentAuto === false);
    await answer(view, 'deny', 'network');
    const prompt = await answer(view, 'allow-once', 'command');
    expect(prompt.detail).toBe('echo two');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => [call.name, call.approval])).toEqual([
      ['Bash', 'auto'],
      ['WebFetch', 'user'],
      ['Bash', 'user'],
    ]);
    expect(autoDialogs(h)).toHaveLength(1);
    await until('the store', () => storedMeta(id)?.agentAuto === false);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('turned off during a turn while the store cannot write: off in memory, a toast, and the next command asks', async () => {
    const h = await harness([
      text(),
      agentScenario(
        commandSteps('echo one', 'one.txt', 'toolu_1'),
        webFetchSteps('toolu_2'),
        commandSteps('echo two', 'two.txt', 'toolu_3'),
      ),
    ]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');

    stores.failMeta = (patch) => patch['agentAuto'] === false;
    setAuto(view, false, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoOffNotSaved });
    expect(view.active().meta.agentAuto).toBe(false);
    await answer(view, 'deny', 'network');
    await answer(view, 'deny', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['auto', 'user', 'user']);
    await expect(fs.access(join(h.workspace, 'two.txt'))).rejects.toThrow();
  });

  it('turned off during a turn, stays off for it even when the meta comes back on behind its back', async () => {
    const h = await harness([
      text(),
      agentScenario(
        commandSteps('echo one', 'one.txt', 'toolu_1'),
        webFetchSteps('toolu_2'),
        commandSteps('echo two', 'two.txt', 'toolu_3'),
      ),
    ]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');
    setAuto(view, false, id);
    await until('the store', () => storedMeta(id)?.agentAuto === false);
    await store().updateMeta(id, { agentAuto: true });
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the meta in memory', () => view.active().meta.agentAuto === true);
    await answer(view, 'deny', 'network');
    await answer(view, 'deny', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['auto', 'user', 'user']);
  });

  it('cannot come on during a turn, not even when the meta is set behind its back', async () => {
    const h = await harness(
      [text(), agentScenario(webFetchSteps('toolu_1'), commandSteps('echo x', 'x.txt', 'toolu_2'))],
      { settings: { sandbox: true } },
    );
    const view = h.attach();
    const id = await conversation(h, view);
    send(view, 'agent');
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');
    expect(h.requests[1]?.profile).toMatchObject({ kind: 'agent', sandboxLocked: false });

    // Refused through the handler...
    setAuto(view, true, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.autoWaitForTurn);
    // ...and set by hand in the store (later than any reset), then carried into memory by a rename.
    await store().updateMeta(id, { agentAuto: true, agentAutoSince: Date.now() + 60_000 });
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the meta in memory', () => view.active().meta.agentAuto === true);

    await answer(view, 'deny', 'network');
    await answer(view, 'deny', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['user', 'user']);
    expect(userMessages(view)[1]).not.toHaveProperty('auto');
    expect(autoDialogs(h)).toEqual([]);
  });

  it('sends a queued Agent message with the conversation’s Auto', async () => {
    const h = await harness([text(), slowText(), bashScenario()]);
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'ask', 'a slow question');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    send(view, 'agent', 'queued');
    await until('the queued chip', () => view.state?.active?.queued !== null);
    await until('the queued turn', () => (view.state?.active?.turns.length ?? 0) === 3);
    await finishedTurn(h, view);
    expect(view.active().prompts).toEqual([]);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
    const users = userMessages(view);
    expect(users.map((m) => [m.text, m.mode, m.auto])).toEqual([
      ['hello', 'ask', undefined],
      ['a slow question', 'ask', undefined],
      ['queued', 'agent', true],
    ]);
  });

  it('a side question asked during an Agent turn with Auto runs without it', async () => {
    const h = await harness([text(), hanging, text('side answer')]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    // The Agent turn's provider has started (a preparing turn counts as running): the requests,
    // and the scenarios they get, are in a known order.
    await until('the Agent request', () => h.requests.length === 2);
    send(view, 'ask', 'a side question');
    await until('the side question', () => h.requests.length === 3);
    expect(h.requests[2]?.profile.kind).toBe('read-only');
    const branch = store()
      .list()
      .find((meta) => meta.aside?.parentId === id);
    expect(branch).toBeDefined();
    expect(branch).not.toHaveProperty('agentAuto');
    await until('the side question to end', () => h.controller.runningTurns() === 1);
    const data = await store().load(branch?.id as ConversationId);
    const users = (data?.messages ?? []).filter((m): m is UserMessage => m.role === 'user');
    expect(users.at(-1)?.text).toBe('a side question');
    expect(users.at(-1)).not.toHaveProperty('auto');
    expect(view.active().meta.agentAuto).toBe(true);
    view.send({ type: 'turn.cancel', conversationId: id });
    await h.idle();
  });
});

// ---- turning it off ----------------------------------------------------------------------------------

describe('turning Auto off', () => {
  it('needs no dialog; off for an unknown conversation or a draft without it does nothing', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    setAuto(view, false, id);
    await until('Auto to be off', () => view.active().meta.agentAuto === false);
    expect(storedMeta(id)?.agentAuto).toBe(false);
    setAuto(view, false, 'no-such-conversation' as ConversationId);
    setAuto(view, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(autoDialogs(h)).toHaveLength(1);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });
});

// ---- the draft ---------------------------------------------------------------------------------------

describe('Auto for a new conversation', () => {
  it('a first Agent message creates the conversation with Auto, and the turn runs with it', async () => {
    const h = await harness([bashScenario()], { settings: { sandbox: true } });
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    expect(autoDialogs(h).map((d) => d.title)).toEqual([DRAFT_TITLE]);

    await agentTurn(h, view);
    expect(view.active().meta.agentAuto).toBe(true);
    expect(storedMeta(view.active().meta.id)?.agentAuto).toBe(true);
    expect(view.current().draftAgentAuto).toBe(false);
    expect(view.active().prompts).toEqual([]);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
    expect(userMessages(view)[0]?.auto).toBe(true);
    // The profile saw the Auto of the conversation the send created.
    expect(h.requests[0]?.profile).toMatchObject({
      kind: 'agent',
      sandbox: true,
      sandboxLocked: true,
    });
    view.expectMirror();
  });

  it.each(['plan', 'ask'] as const)(
    'a first %s message creates the conversation with Auto, runs without it, and a later Agent turn has it',
    async (mode) => {
      const h = await harness([text(), bashScenario()], { settings: { sandbox: true } });
      const view = h.attach();
      setAuto(view, true);
      await until('the draft flag', () => view.state?.draftAgentAuto === true);
      send(view, mode, 'first');
      await until('the conversation', () => view.state?.active !== null);
      await finishedTurn(h, view);
      const id = view.active().meta.id;
      expect(view.active().meta.agentAuto).toBe(true);
      expect(storedMeta(id)?.agentAuto).toBe(true);
      expect(summaryAuto(view, id)).toBe(true);
      expect(view.current().draftAgentAuto).toBe(false);
      // That turn itself has no Auto: a read-only profile, no lock, nothing on its message.
      expect(userMessages(view)[0]).not.toHaveProperty('auto');
      expect(h.requests[0]?.profile.kind).toBe('read-only');
      expect(await sandboxSettingsOf(h.requests[0])).toBeUndefined();
      expect((await h.record(0)).stdin).not.toContain(AUTO_PARAGRAPH);

      // The next Agent turn runs with it, without a second dialog.
      await agentTurn(h, view);
      expect(view.active().prompts).toEqual([]);
      expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
      expect(userMessages(view)[1]?.auto).toBe(true);
      expect(autoDialogs(h)).toHaveLength(1);
      expect(h.requests[1]?.profile).toMatchObject({ kind: 'agent', sandboxLocked: true });
      // A new draft does not have it again.
      view.send({ type: 'conversation.new' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.current().draftAgentAuto).toBe(false);
      view.expectMirror();
    },
  );

  it('is used up before the conversation is stored: two sends at once create one conversation with it', async () => {
    const h = await harness([bashScenario()]);
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    const creation = gate();
    stores.holdCreate = creation.promise;
    send(view, 'agent', 'one');
    send(view, 'agent', 'two');
    await until('the flag to go', () => view.state?.draftAgentAuto === false);
    await until('the second send to be refused', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.turnRunning);
    expect(store().list()).toEqual([]);
    creation.release();
    await until('the conversation', () => view.state?.active !== null);
    await finishedTurn(h, view);
    expect(store().list()).toHaveLength(1);
    expect(view.active().meta.agentAuto).toBe(true);
    expect(userMessages(view).map((m) => [m.text, m.auto])).toEqual([['one', true]]);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
    expect(view.current().draftAgentAuto).toBe(false);
  });

  it('a send refused before the conversation exists keeps the draft’s Auto', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    h.env.trustedValue = false;
    send(view, 'agent');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.untrustedRefusal);
    expect(view.current().draftAgentAuto).toBe(true);
  });

  it('ends when the view moves to another conversation or a new draft, and off clears it', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const first = await conversation(h, view);
    view.send({ type: 'conversation.new' });
    await until('the draft', () => view.state?.active === null);

    // Refused while the view shows a conversation.
    const other = h.attach();
    other.send({ type: 'conversation.open', conversationId: first });
    await until('the other view to show it', () => other.state?.active?.meta.id === first);
    setAuto(other, true);
    await until('a toast', () => other.toasts.length === 1);
    expect(other.toasts[0]?.text).toBe(TEXT.autoDraftGone);

    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    view.send({ type: 'conversation.new' });
    await until('the flag to go', () => view.state?.draftAgentAuto === false);

    setAuto(view, true);
    await until('the draft flag again', () => view.state?.draftAgentAuto === true);
    view.send({ type: 'conversation.open', conversationId: first });
    await until('the conversation', () => view.state?.active?.meta.id === first);
    expect(view.current().draftAgentAuto).toBe(false);
    view.send({ type: 'conversation.new' });
    await until('the draft', () => view.state?.active === null);
    expect(view.current().draftAgentAuto).toBe(false);

    setAuto(view, true);
    await until('the draft flag a third time', () => view.state?.draftAgentAuto === true);
    setAuto(view, false);
    await until('the flag to go again', () => view.state?.draftAgentAuto === false);
    expect(autoDialogs(h)).toHaveLength(3);
    view.expectMirror();
    other.expectMirror();
  });

  it('checks again after the dialog: a view that moved on meanwhile does not get it', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const release = holdDialog(h, DRAFT_TITLE);
    setAuto(view, true);
    await until('the dialog', () => autoDialogs(h).length === 1);
    view.send({ type: 'conversation.new' });
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.autoChangedDuringDialog);
    expect(view.current().draftAgentAuto).toBe(false);
  });

  it('is used only in the folder the dialog named', async () => {
    const h = await harness([text()], {
      beforeStart: (made) => {
        made.env.folderList = [
          ...made.env.folderList,
          { key: SECOND_FOLDER, name: 'second', path: join(made.root, 'second') },
        ];
      },
    });
    await fs.mkdir(join(h.root, 'second'), { recursive: true });
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    expect(autoDialogs(h)[0]?.detail).toContain(`${workLine(h)}\nConversation: new\n\n`);

    // The first folder is now another one; nothing told the controller.
    const [work, second] = h.env.folderList;
    if (!work || !second) throw new Error('two folders expected');
    h.env.folderList = [second, work];
    await agentTurn(h, view);
    expect(view.active().meta.folder).toBe(SECOND_FOLDER);
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(userMessages(view)[0]).not.toHaveProperty('auto');
  });

  it('ends when its folder is no longer open', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    h.env.folderList = [];
    h.controller.environmentChanged();
    await until('the flag to go', () => view.state?.draftAgentAuto === false);
  });
});

// ---- branches ------------------------------------------------------------------------------------------

describe('branches', () => {
  it('a branch starts without Auto and the conversation keeps it', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const parentId = await conversation(h, view);
    await turnOn(h, view);
    const assistant = view.active().messages.find((m) => m.role === 'assistant');
    view.send({ type: 'conversation.fork', conversationId: parentId, messageId: assistant?.id });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(view.active().meta.fork?.parentId).toBe(parentId);
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(storedMeta(parentId)?.agentAuto).toBe(true);
  });

  it('"Restore and Branch From Here" starts without Auto', async () => {
    const h = await harness(
      [
        agentScenario(writeSteps('a.txt', 'first\n', 'toolu_1')),
        agentScenario(writeSteps('a.txt', 'second\n', 'toolu_2')),
      ],
      { settings: { editApproval: 'auto' } },
    );
    await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    await agentTurn(h, view, 'step 1');
    await agentTurn(h, view, 'step 2');
    const parentId = view.active().meta.id;
    expect(view.active().meta.agentAuto).toBe(true);
    await until('two checkpoints', () => view.current().checkpoints.length === 2);

    view.send({
      type: 'checkpoint.preview',
      operationId: view.current().checkpoints[0]?.operationId,
    });
    await until('the preview', () => view.current().restorePreview !== null);
    const shown = view.current().restorePreview;
    if (!shown) throw new Error('no preview');
    view.send({
      type: 'checkpoint.restore',
      token: shown.token,
      paths: shown.items.map((item) => item.path),
      andFork: true,
    });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(view.active().meta.fork?.parentId).toBe(parentId);
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(storedMeta(parentId)?.agentAuto).toBe(true);
  });
});

// ---- the setting -----------------------------------------------------------------------------------------

describe('the setting', () => {
  it('is mirrored to every view', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    expect(view.current().agentAuto).toEqual({ offered: true, commands: true });
    changeSettings(h, { alwaysAskCommands: true });
    expect(view.current().agentAuto).toEqual({ offered: true, commands: false });
    changeSettings(h, { agentAuto: false });
    expect(view.current().agentAuto).toEqual({ offered: false, commands: false });
    view.expectMirror();
  });

  it('turned off, clears Auto everywhere, and turned on again arms nothing', async () => {
    const h = await harness([text('a'), text('b'), bashScenario()]);
    const view = h.attach();
    const first = await conversation(h, view, 'first');
    await turnOn(h, view);
    const other = h.attach();
    const second = await conversation(h, other, 'second');
    await turnOn(h, other);
    // The second conversation is only in storage now.
    other.send({ type: 'conversation.new' });
    await until('the other draft', () => other.state?.active === null);
    setAuto(other, true);
    await until('the draft flag', () => other.state?.draftAgentAuto === true);

    changeSettings(h, { agentAuto: false });
    expect(view.active().meta.agentAuto).toBe(false);
    expect(other.current().draftAgentAuto).toBe(false);
    await until(
      'the stored flags to clear',
      () => storedMeta(first)?.agentAuto === false && storedMeta(second)?.agentAuto === false,
    );

    changeSettings(h, { agentAuto: true });
    expect(view.active().meta.agentAuto).toBe(false);
    expect(other.current().draftAgentAuto).toBe(false);
    expect(
      store()
        .list()
        .some((meta) => meta.agentAuto === true),
    ).toBe(false);

    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    view.expectMirror();
    other.expectMirror();
  });

  it('turned off during a turn, takes Auto away from it at once', async () => {
    const h = await harness([
      text(),
      agentScenario(webFetchSteps('toolu_1'), commandSteps('echo x', 'x.txt', 'toolu_2')),
    ]);
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');
    const id = view.active().meta.id;
    changeSettings(h, { agentAuto: false });
    await until('the stored flag to clear', () => storedMeta(id)?.agentAuto === false);
    // The conversation's flag comes back behind the controller's back, later than the reset: the
    // setting alone, read live by the turn, keeps Auto away.
    await store().updateMeta(id, { agentAuto: true, agentAutoSince: Date.now() + 60_000 });
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the meta in memory', () => view.active().meta.agentAuto === true);
    await answer(view, 'deny', 'network');
    await answer(view, 'deny', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['user', 'user']);
  });

  it('off when the store opens, clears the stored flags', async () => {
    const first = await harness([text()]);
    const view = first.attach();
    const id = await conversation(first, view);
    await turnOn(first, view);
    await first.controller.dispose();

    const second = await createHarness({ reuse: first, realDefaults: true, noStart: true });
    // Disposed before the first, which removes the shared directories.
    harnesses.unshift(second);
    second.env.settingsValue = { ...DEFAULT_SETTINGS, agentAuto: false };
    await second.controller.start();
    await until('the stored flag to clear', () => storedMeta(id)?.agentAuto === false);
  });
});

// ---- plans -----------------------------------------------------------------------------------------------

describe('approving a plan', () => {
  it('says nothing of Auto when it is off', async () => {
    const h = await harness([submitPlanScenario()]);
    const view = h.attach();
    const plan = await planned(h, view);
    h.ui.confirmAnswer = false;
    approve(view, plan);
    await until('the approval dialog', () => dialogs(h, APPROVAL_TITLE).length === 1);
    expect(dialogs(h, APPROVAL_TITLE)[0]?.detail).toBe(
      'Version 1 of "Make a file" will be implemented in Agent mode. Changes are checkpointed and you review them afterwards.',
    );
  });

  it('with alwaysAskCommands, says that commands still ask', async () => {
    const h = await harness([submitPlanScenario()], { settings: { alwaysAskCommands: true } });
    const view = h.attach();
    const plan = await planned(h, view);
    await turnOn(h, view);
    h.ui.confirmAnswer = false;
    approve(view, plan);
    await until('the approval dialog', () => dialogs(h, APPROVAL_TITLE).length === 1);
    expect(dialogs(h, APPROVAL_TITLE)[0]?.detail.split('\n\n').at(-1)).toBe(
      'Auto is on for this conversation: edits inside the folder will run without asking. Terminal commands still ask.',
    );
  });

  it('says so when Auto is on, and the execution runs its command without a prompt', async () => {
    const h = await harness([submitPlanScenario(), bashScenario()]);
    const view = h.attach();
    const plan = await planned(h, view);
    await turnOn(h, view);
    approve(view, plan);
    await until('the execution turn', () => (view.state?.active?.turns.length ?? 0) === 2);
    const turn = await finishedTurn(h, view);
    expect(turn.mode).toBe('agent');
    expect(dialogs(h, APPROVAL_TITLE)[0]?.detail).toBe(
      [
        'Version 1 of "Make a file" will be implemented in Agent mode. Changes are checkpointed and you review them afterwards.',
        'Auto is on for this conversation: terminal commands and edits inside the folder will run without asking.',
      ].join('\n\n'),
    );
    expect(view.active().prompts).toEqual([]);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
    expect(userMessages(view).at(-1)).toMatchObject({ mode: 'agent', auto: true });
  });
});

// ---- an off that is not saved ------------------------------------------------------------------------

describe('Auto turned off while the store cannot save it', () => {
  it('stays off in memory, in the view and in History through later changes, and a successful one saves it', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    stores.failMeta = (patch) => patch['agentAuto'] === false;
    setAuto(view, false, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoOffNotSaved });
    // The store still says on, in memory and on disk.
    expect(storedMeta(id)?.agentAuto).toBe(true);
    expect(view.active().meta.agentAuto).toBe(false);
    expect(summaryAuto(view, id)).toBe(false);

    // A change while the disk still fails carries the off along and fails with it.
    view.send({ type: 'conversation.rename', conversationId: id, title: 'not saved' });
    await until('the failure', () => view.toasts.length === 2);
    expect(view.active().meta.title).toBe('hello');
    expect(view.active().meta.agentAuto).toBe(false);
    expect(summaryAuto(view, id)).toBe(false);

    // Other changes do not copy the store's Auto back once the disk works again.
    stores.failMeta = undefined;
    view.send({ type: 'conversation.setMode', conversationId: id, mode: 'plan' });
    await until('the mode', () => view.active().meta.mode === 'plan');
    expect(view.active().meta.agentAuto).toBe(false);
    expect(summaryAuto(view, id)).toBe(false);
    // ...and that write saved the off.
    expect(storedMeta(id)?.agentAuto).toBe(false);
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the rename', () => view.active().meta.title === 'renamed');
    expect(view.active().meta.agentAuto).toBe(false);
    expect(storedMeta(id)?.agentAuto).toBe(false);
    view.expectMirror();
  });

  it('a rename that succeeds while only the off itself fails also saves the off', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    stores.failMeta = isOffWrite;
    setAuto(view, false, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(storedMeta(id)?.agentAuto).toBe(true);
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the rename', () => view.active().meta.title === 'renamed');
    expect(view.active().meta.agentAuto).toBe(false);
    expect(summaryAuto(view, id)).toBe(false);
    expect(storedMeta(id)?.agentAuto).toBe(false);
  });

  it('is off when the conversation is loaded again, and a new Agent turn asks for its command', async () => {
    const h = await harness([text('one'), text('two'), bashScenario()]);
    const view = h.attach();
    const id = await conversation(h, view, 'first');
    await turnOn(h, view);
    stores.failMeta = isOffWrite;
    setAuto(view, false, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(storedMeta(id)?.agentAuto).toBe(true);

    // Another conversation in the view: the first one is released from memory.
    view.send({ type: 'conversation.new' });
    await until('the draft', () => view.state?.active === null);
    const other = await conversation(h, view, 'second');
    expect(other).not.toBe(id);
    expect(summaryAuto(view, id)).toBe(false);

    view.send({ type: 'conversation.open', conversationId: id });
    await until('the first conversation', () => view.state?.active?.meta.id === id);
    expect(storedMeta(id)?.agentAuto).toBe(true);
    expect(view.active().meta.agentAuto).toBe(false);
    expect(summaryAuto(view, id)).toBe(false);

    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    expect((await h.record()).stdin).not.toContain(AUTO_PARAGRAPH);
    expect(view.active().meta.agentAuto).toBe(false);
    view.expectMirror();
  });

  it('can be turned on again, only through the dialog', async () => {
    const h = await harness([text(), bashScenario()]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    stores.failMeta = isOffWrite;
    setAuto(view, false, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(storedMeta(id)?.agentAuto).toBe(true);

    // On again while the store already says on: the dialog is shown, not skipped.
    stores.failMeta = undefined;
    await turnOn(h, view);
    expect(autoDialogs(h)).toHaveLength(2);
    expect(storedMeta(id)?.agentAuto).toBe(true);
    expect(summaryAuto(view, id)).toBe(true);
    // No longer off-but-unsaved: a change keeps it on.
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the rename', () => view.active().meta.title === 'renamed');
    expect(view.active().meta.agentAuto).toBe(true);
    expect(storedMeta(id)?.agentAuto).toBe(true);
    const turn = await agentTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
  });

  it('the setting turned off while the store cannot write: off everywhere, also after the setting comes back', async () => {
    const h = await harness([text('a'), text('b'), bashScenario()]);
    const view = h.attach();
    const first = await conversation(h, view, 'first');
    await turnOn(h, view);
    const other = h.attach();
    const second = await conversation(h, other, 'second');
    await turnOn(h, other);
    // The second conversation is only in storage now.
    other.send({ type: 'conversation.new' });
    await until('the other draft', () => other.state?.active === null);

    stores.failMeta = isOffWrite;
    changeSettings(h, { agentAuto: false });
    await until(
      'both writes to fail',
      () =>
        h.logger.entries.filter(
          (entry) => entry.message === 'Auto could not be turned off in a stored conversation',
        ).length === 2,
    );
    await store().flush();
    expect(storedMeta(first)?.agentAuto).toBe(true);
    expect(storedMeta(second)?.agentAuto).toBe(true);

    changeSettings(h, { agentAuto: true });
    expect(view.active().meta.agentAuto).toBe(false);
    expect(summaryAuto(view, first)).toBe(false);
    expect(summaryAuto(view, second)).toBe(false);
    // A rename of the first while only the bare off fails: it saves the off.
    view.send({ type: 'conversation.rename', conversationId: first, title: 'renamed' });
    await until('the rename', () => view.active().meta.title === 'renamed');
    expect(view.active().meta.agentAuto).toBe(false);
    expect(storedMeta(first)?.agentAuto).toBe(false);

    // The second, loaded again, is off, and its Agent turn asks.
    other.send({ type: 'conversation.open', conversationId: second });
    await until('the second conversation', () => other.state?.active?.meta.id === second);
    expect(other.active().meta.agentAuto).toBe(false);
    send(other, 'agent');
    await answer(other, 'allow-once', 'command');
    await finishedTurn(h, other);
    expect(toolCalls(other)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(other).at(-1)).not.toHaveProperty('auto');
    view.expectMirror();
    other.expectMirror();
  });
});

// ---- decided once per send ------------------------------------------------------------------------------

describe('Auto is decided once per send', () => {
  it('an on still being written when a plan is approved: the execution has no Auto, the next turn has it', async () => {
    const h = await harness([submitPlanScenario(), bashScenario(), bashScenario()], {
      settings: { sandbox: true },
    });
    const view = h.attach();
    const plan = await planned(h, view);
    const id = view.active().meta.id;
    const write = gate();
    stores.holdMeta = (patch) => (patch['agentAuto'] === true ? write.promise : undefined);
    setAuto(view, true, id);
    await until('the store to say on', () => storedMeta(id)?.agentAuto === true);
    expect(view.active().meta.agentAuto).not.toBe(true);

    approve(view, plan);
    await until('the execution turn', () => (view.state?.active?.turns.length ?? 0) === 2);
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(dialogs(h, APPROVAL_TITLE)[0]?.detail).toBe(
      'Version 1 of "Make a file" will be implemented in Agent mode. Changes are checkpointed and you review them afterwards.',
    );
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(h.requests[1]?.profile).toMatchObject({ kind: 'agent', sandboxLocked: false });

    write.release();
    await until('Auto to be on', () => view.active().meta.agentAuto === true);
    await agentTurn(h, view, 'next');
    expect(userMessages(view).at(-1)).toMatchObject({ text: 'next', auto: true });
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'Bash', approval: 'auto' });
    expect(h.requests[2]?.profile).toMatchObject({ kind: 'agent', sandboxLocked: true });
  });

  it('an on that lands while the plan dialog is open: the dialog said nothing of it, so the execution has no Auto', async () => {
    const h = await harness([submitPlanScenario(), bashScenario(), bashScenario()], {
      settings: { sandbox: true },
    });
    const view = h.attach();
    const plan = await planned(h, view);
    const id = view.active().meta.id;
    const write = gate();
    stores.holdMeta = (patch) => (patch['agentAuto'] === true ? write.promise : undefined);
    setAuto(view, true, id);
    await until('the store to say on', () => storedMeta(id)?.agentAuto === true);
    const release = holdDialog(h, APPROVAL_TITLE);
    approve(view, plan);
    await until('the approval dialog', () => dialogs(h, APPROVAL_TITLE).length === 1);
    // The on lands now, after the profile and the dialog's text were built without it.
    write.release();
    await until('Auto to be on', () => view.active().meta.agentAuto === true);
    release();
    await until('the execution turn', () => (view.state?.active?.turns.length ?? 0) === 2);
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(dialogs(h, APPROVAL_TITLE)[0]?.detail).not.toContain('Auto');
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(h.requests[1]?.profile).toMatchObject({ kind: 'agent', sandboxLocked: false });
    expect((await h.record(1)).stdin).not.toContain(AUTO_PARAGRAPH);

    // The next turn was decided with it.
    await agentTurn(h, view, 'next');
    expect(userMessages(view).at(-1)).toMatchObject({ text: 'next', auto: true });
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'Bash', approval: 'auto' });
    expect(h.requests[2]?.profile).toMatchObject({ kind: 'agent', sandboxLocked: true });
  });

  it('with the sandbox on, every turn with Auto may not leave it', async () => {
    const h = await harness(
      [
        bashScenario('echo 1', 'one.txt'),
        bashScenario('echo 2', 'two.txt'),
        slowText(),
        bashScenario('echo 3', 'three.txt'),
        submitPlanScenario(),
        bashScenario('echo 4', 'four.txt'),
      ],
      { settings: { sandbox: true } },
    );
    const view = h.attach();
    // A conversation created by a draft with Auto.
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    await agentTurn(h, view, 'draft');
    // An ordinary send.
    await agentTurn(h, view, 'ordinary');
    // A queued dispatch.
    send(view, 'ask', 'a slow question');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    send(view, 'agent', 'queued');
    await until('the queued turn', () => (view.state?.active?.turns.length ?? 0) === 4);
    await finishedTurn(h, view);
    // A plan execution.
    view.send({
      type: 'turn.send',
      conversationId: view.active().meta.id,
      text: 'plan it',
      mode: 'plan',
      model: 'default',
    });
    await until('the plan', () => view.state?.active?.plan?.versions.length === 1);
    await finishedTurn(h, view);
    const plan = view.active().plan;
    if (!plan) throw new Error('no plan');
    approve(view, plan);
    await until('the execution turn', () => (view.state?.active?.turns.length ?? 0) === 6);
    await finishedTurn(h, view);

    const users = userMessages(view);
    expect(users.map((m) => [m.mode, m.auto === true])).toEqual([
      ['agent', true],
      ['agent', true],
      ['ask', false],
      ['agent', true],
      ['plan', false],
      ['agent', true],
    ]);
    expect(view.active().prompts).toEqual([]);
    expect(h.requests).toHaveLength(6);
    for (const [index, user] of users.entries()) {
      if (user.auto !== true) continue;
      expect(await sandboxSettingsOf(h.requests[index])).toEqual({
        enabled: true,
        autoAllowBashIfSandboxed: false,
        allowUnsandboxedCommands: false,
      });
    }
  });

  it('turned off while the plan dialog is open: the execution runs without Auto', async () => {
    const h = await harness([submitPlanScenario(), bashScenario()], {
      settings: { sandbox: true },
    });
    const view = h.attach();
    const plan = await planned(h, view);
    const id = view.active().meta.id;
    await turnOn(h, view);
    const release = holdDialog(h, APPROVAL_TITLE);
    approve(view, plan);
    await until('the approval dialog', () => dialogs(h, APPROVAL_TITLE).length === 1);
    expect(dialogs(h, APPROVAL_TITLE)[0]?.detail).toContain('Auto is on for this conversation');
    setAuto(view, false, id);
    await until('Auto to be off', () => view.active().meta.agentAuto === false);
    release();
    await until('the execution turn', () => (view.state?.active?.turns.length ?? 0) === 2);
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect((await h.record()).stdin).not.toContain(AUTO_PARAGRAPH);
  });

  it('the plan dialog says nothing of Auto with the setting off, although the meta still says on', async () => {
    const h = await harness([submitPlanScenario()]);
    const view = h.attach();
    const plan = await planned(h, view);
    await turnOn(h, view);
    // Read when the send is decided; nothing has told the controller yet.
    h.env.settingsValue = { ...h.env.settingsValue, agentAuto: false };
    expect(view.active().meta.agentAuto).toBe(true);
    h.ui.confirmAnswer = false;
    approve(view, plan);
    await until('the approval dialog', () => dialogs(h, APPROVAL_TITLE).length === 1);
    expect(dialogs(h, APPROVAL_TITLE)[0]?.detail).toBe(
      'Version 1 of "Make a file" will be implemented in Agent mode. Changes are checkpointed and you review them afterwards.',
    );
  });

  it('reads the setting at every send: turned off between two sends, the second asks', async () => {
    const h = await harness([text(), bashScenario(), bashScenario()]);
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    await agentTurn(h, view, 'first');
    expect(toolCalls(view).at(-1)).toMatchObject({ approval: 'auto' });
    // Nothing has told the controller: only the live read can see it.
    h.env.settingsValue = { ...h.env.settingsValue, agentAuto: false };
    send(view, 'agent', 'second');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'Bash', approval: 'user' });
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
  });
});

// ---- off for an idle conversation ----------------------------------------------------------------------

describe('Auto turned off between turns', () => {
  it('is off in memory at once, before the store has written it, and a turn sent then asks', async () => {
    const h = await harness([text(), bashScenario()]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    const write = gate();
    stores.holdMeta = (patch) => (isOffWrite(patch) ? write.promise : undefined);
    setAuto(view, false, id);
    await until('Auto to be off', () => view.active().meta.agentAuto === false);
    expect(summaryAuto(view, id)).toBe(false);
    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    expect(view.toasts).toEqual([]);
    write.release();
    await until('the store', () => storedMeta(id)?.agentAuto === false);
    expect(view.active().meta.agentAuto).toBe(false);
    expect(view.toasts).toEqual([]);
  });
});

// ---- the dialog's settings -----------------------------------------------------------------------------

describe('the settings the dialog names', () => {
  it.each([
    ['alwaysAskCommands', { alwaysAskCommands: true }],
    ['agentAutoWebTools', { agentAutoWebTools: true }],
    ['sandbox', { sandbox: true }],
  ] as const)('%s changed while the dialog is open: nothing is turned on', async (_name, patch) => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    const release = holdDialog(h, AUTO_TITLE);
    setAuto(view, true, id);
    await until('the dialog', () => autoDialogs(h).length === 1);
    changeSettings(h, patch);
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoChangedDuringDialog });
    await store().flush();
    expect(view.active().meta).not.toHaveProperty('agentAuto');
    expect(storedMeta(id)).not.toHaveProperty('agentAuto');
  });

  it('a setting changed while a draft’s dialog is open: the draft does not get it', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const release = holdDialog(h, DRAFT_TITLE);
    setAuto(view, true);
    await until('the dialog', () => autoDialogs(h).length === 1);
    changeSettings(h, { sandbox: true });
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(TEXT.autoChangedDuringDialog);
    expect(view.current().draftAgentAuto).toBe(false);
  });
});

// ---- an on that is not saved ---------------------------------------------------------------------------

describe('Auto turned on while the store cannot save it', () => {
  it.each([
    ['the store rolls it back', 'rollback'],
    ['the store kept it', 'kept'],
  ] as const)('stays off for the host when %s', async (_name, how) => {
    const h = await harness([text(), bashScenario(), bashScenario()]);
    const view = h.attach();
    const id = await conversation(h, view);
    if (how === 'rollback') stores.failMeta = (patch) => patch['agentAuto'] === true;
    else stores.failAfterWrite = (patch) => patch['agentAuto'] === true;
    setAuto(view, true, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoNotSaved });
    await store().flush();
    if (how === 'kept') expect(storedMeta(id)?.agentAuto).toBe(true);
    else expect(storedMeta(id)).not.toHaveProperty('agentAuto');
    expect(view.active().meta.agentAuto).not.toBe(true);
    expect(summaryAuto(view, id)).not.toBe(true);

    // A rename keeps it off, and saves the off over whatever the store kept.
    stores.failMeta = undefined;
    stores.failAfterWrite = undefined;
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the rename', () => view.active().meta.title === 'renamed');
    expect(view.active().meta.agentAuto).not.toBe(true);
    expect(summaryAuto(view, id)).not.toBe(true);
    expect(storedMeta(id)?.agentAuto).not.toBe(true);

    // An Agent turn asks for its command.
    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');

    // On again only through a second dialog, and then it works.
    await turnOn(h, view);
    expect(autoDialogs(h)).toHaveLength(2);
    expect(storedMeta(id)?.agentAuto).toBe(true);
    expect(summaryAuto(view, id)).toBe(true);
    await agentTurn(h, view, 'again');
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'Bash', approval: 'auto' });
    expect(userMessages(view).at(-1)).toMatchObject({ text: 'again', auto: true });
    view.expectMirror();
  });
});

// ---- read-only turns -----------------------------------------------------------------------------------

describe('a read-only turn never has Auto', () => {
  /** A permission request the recording policy puts to the user. */
  function permissionScenario(toolUseId: string): ScenarioSpec {
    return agentScenario(commandSteps('echo read-only', 'never.txt', toolUseId));
  }

  /** The test policy, recording the context of every permission request and asking the user. */
  function recordingPolicy(contexts: PolicyContext[]): TurnPolicy {
    const base = createPlanTestPolicy();
    return {
      ...base,
      async decide(request, context) {
        contexts.push(context);
        const prompt: NewPrompt = {
          kind: 'permission',
          toolCallId: request.toolCallId,
          toolName: request.toolName,
          category: 'command',
          title: 'Run a terminal command',
          detail: 'echo read-only',
          inputPreview: '{}',
          choices: ['allow-once', 'deny'],
        };
        const answered = await context.askUser(prompt);
        return answered?.kind === 'permission' && answered.choice === 'allow-once'
          ? { response: { behavior: 'allow' }, approval: 'user' }
          : { response: { behavior: 'deny', message: 'Denied by the user.' }, approval: 'user' };
      },
    };
  }

  async function recordingHarness(
    sequence: ScenarioSpec[],
    contexts: PolicyContext[],
  ): Promise<Harness> {
    const h = await createHarness({ sequence, policy: recordingPolicy(contexts), noStart: true });
    harnesses.push(h);
    h.env.settingsValue = { ...DEFAULT_SETTINGS };
    await h.controller.start();
    return h;
  }

  it('an Ask and a Plan turn in a conversation with Auto: the policy sees it off, also after the meta changed', async () => {
    const contexts: PolicyContext[] = [];
    const h = await recordingHarness(
      [text(), permissionScenario('toolu_ask'), permissionScenario('toolu_plan')],
      contexts,
    );
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    for (const [index, mode] of (['ask', 'plan'] as const).entries()) {
      send(view, mode, `a ${mode} turn`);
      await until(`the ${mode} request`, () => contexts.length === index + 1);
      const context = contexts[index];
      if (!context) throw new Error('no context');
      expect(context.mode).toBe(mode);
      expect(context.auto).toBe(false);
      expect(context.conversation.agentAuto).not.toBe(true);
      // The meta changes while the request waits, and the conversation still has Auto.
      view.send({ type: 'conversation.rename', conversationId: id, title: `during ${mode}` });
      await until('the rename', () => view.active().meta.title === `during ${mode}`);
      expect(view.active().meta.agentAuto).toBe(true);
      expect(context.auto).toBe(false);
      await answer(view, 'deny');
      await finishedTurn(h, view);
      expect(context.auto).toBe(false);
      expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    }
    expect(h.requests.slice(1).map((request) => request.profile.kind)).toEqual([
      'read-only',
      'read-only',
    ]);
  });

  it('a side question during an Agent turn with Auto: the policy sees it off', async () => {
    const contexts: PolicyContext[] = [];
    const h = await recordingHarness([text(), hanging, permissionScenario('toolu_side')], contexts);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the Agent request', () => h.requests.length === 2);
    expect(userMessages(view).at(-1)?.auto).toBe(true);
    send(view, 'ask', 'a side question');
    await until('the side question’s request', () => contexts.length === 1);
    const context = contexts[0];
    if (!context) throw new Error('no context');
    expect(context.mode).toBe('ask');
    expect(context.conversation.id).not.toBe(id);
    expect(context.auto).toBe(false);
    view.send({
      type: 'conversation.rename',
      conversationId: id,
      title: 'during the side question',
    });
    await until('the rename', () => view.active().meta.title === 'during the side question');
    expect(context.auto).toBe(false);
    expect(view.active().meta.agentAuto).toBe(true);
    view.send({ type: 'turn.cancel', conversationId: context.conversation.id });
    view.send({ type: 'turn.cancel', conversationId: id });
    await h.idle();
    expect(context.auto).toBe(false);
  });
});

// ---- what may be turned on, and the dialog's text -------------------------------------------------------

describe('what Auto may be turned on for', () => {
  it('only the conversation the view shows: another one is refused, with no dialog', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    view.send({ type: 'conversation.new' });
    await until('the draft', () => view.state?.active === null);
    setAuto(view, true, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoNotShown });
    expect(autoDialogs(h)).toEqual([]);
    expect(storedMeta(id)).not.toHaveProperty('agentAuto');
    // Off stays allowed for any conversation.
    setAuto(view, false, id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(view.toasts).toHaveLength(1);
  });

  it('is refused for a conversation whose folder is not open, with no dialog', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    h.env.folderList = [{ key: SECOND_FOLDER, name: 'second', path: join(h.root, 'second') }];
    setAuto(view, true, id);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.conversationFolderClosed });
    expect(autoDialogs(h)).toEqual([]);
    expect(storedMeta(id)).not.toHaveProperty('agentAuto');
  });

  it('is refused for a draft with no folder open, with no dialog', async () => {
    const h = await harness([text()], { noFolder: true });
    const view = h.attach();
    setAuto(view, true);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.noFolder });
    expect(autoDialogs(h)).toEqual([]);
    expect(view.current().draftAgentAuto).toBe(false);
  });

  it('checks again after the dialog: trust revoked meanwhile keeps it off', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    const release = holdDialog(h, AUTO_TITLE);
    setAuto(view, true, id);
    await until('the dialog', () => autoDialogs(h).length === 1);
    h.env.trustedValue = false;
    h.controller.environmentChanged();
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoChangedDuringDialog });
    await store().flush();
    expect(storedMeta(id)).not.toHaveProperty('agentAuto');
    expect(view.active().meta).not.toHaveProperty('agentAuto');
  });

  it('checks again after the dialog: a conversation deleted meanwhile gets nothing', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    const release = holdDialog(h, AUTO_TITLE);
    setAuto(view, true, id);
    await until('the dialog', () => autoDialogs(h).length === 1);
    view.send({ type: 'conversation.delete', conversationId: id });
    await until('the conversation to go', () => storedMeta(id) === undefined);
    release();
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoChangedDuringDialog });
    await store().flush();
    expect(store().list()).toEqual([]);
    expect(stores.landed.some((patch) => patch['agentAuto'] === true)).toBe(false);
  });
});

describe('the dialog that turns Auto on', () => {
  it('cuts a long title to 60 characters', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    const long = 'x'.repeat(200);
    view.send({ type: 'conversation.rename', conversationId: id, title: long });
    await until('the rename', () => view.active().meta.title === long);
    await turnOn(h, view);
    const [names] = autoDialogs(h)[0]?.detail.split('\n\n') ?? [];
    expect(names).toBe(`${workLine(h)}\nConversation: ${'x'.repeat(59)}…`);
  });

  it('a title of quotes, line breaks and bidi controls cannot reach the folder line', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    const title = 'a"\n"Folder: elsewhere\u202E\r\n\u2066"\u2028b';
    view.send({ type: 'conversation.rename', conversationId: id, title });
    await until('the rename', () => view.active().meta.title === title);
    await turnOn(h, view);
    const detail = autoDialogs(h)[0]?.detail ?? '';
    const [names = '', sentence] = detail.split('\n\n');
    const lines = names.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(workLine(h));
    expect(lines[1]?.startsWith('Conversation: a"')).toBe(true);
    expect(lines[1]).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u2028\u2029\r]/);
    expect(sentence?.startsWith('Agent turns in this conversation run')).toBe(true);
  });
});

// ---- a conversation loading while Auto is turned off ------------------------------------------------------

describe('a conversation that loads while Auto is turned off', () => {
  it.each(['the setting', 'the switch'] as const)(
    'stays off when %s turns it off during the load',
    async (how) => {
      const h = await harness([text('one'), text('two'), bashScenario()]);
      const view = h.attach();
      const id = await conversation(h, view, 'first');
      await turnOn(h, view);
      // Another conversation in the view: the first one is released from memory.
      view.send({ type: 'conversation.new' });
      await until('the draft', () => view.state?.active === null);
      await conversation(h, view, 'second');

      const load = gate();
      stores.holdLoad = load.promise;
      const loads = stores.loads;
      view.send({ type: 'conversation.open', conversationId: id });
      // The snapshot, with Auto on, has been read.
      await until('the load to read', () => stores.loads > loads);
      if (how === 'the setting') changeSettings(h, { agentAuto: false });
      else setAuto(view, false, id);
      await until('the off to land', () => stores.landed.some(isOffWrite));
      expect(storedMeta(id)?.agentAuto).toBe(false);
      stores.holdLoad = undefined;
      load.release();
      await until('the first conversation', () => view.state?.active?.meta.id === id);
      if (how === 'the setting') changeSettings(h, { agentAuto: true });

      expect(view.active().meta.agentAuto).not.toBe(true);
      expect(summaryAuto(view, id)).not.toBe(true);
      expect(storedMeta(id)?.agentAuto).toBe(false);
      send(view, 'agent');
      await answer(view, 'allow-once', 'command');
      await finishedTurn(h, view);
      expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
      expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
      view.expectMirror();
    },
  );
});

// ---- offs and ons whose writes overlap --------------------------------------------------------------------

describe('Auto turned off, on and off again while the writes overlap', () => {
  /** Auto off for the host everywhere, and an Agent turn asks for its command. */
  async function expectOff(h: Harness, view: TestView, id: ConversationId): Promise<void> {
    expect(view.active().meta.agentAuto).not.toBe(true);
    expect(summaryAuto(view, id)).not.toBe(true);
    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(view).at(-1)).not.toHaveProperty('auto');
    expect(view.active().meta.agentAuto).not.toBe(true);
    expect(summaryAuto(view, id)).not.toBe(true);
    view.expectMirror();
  }

  it.each(['fails', 'succeeds'] as const)(
    'off in flight, on through the dialog, off again whose write %s after the earlier ones landed',
    async (last) => {
      const h = await harness([text(), bashScenario()]);
      const view = h.attach();
      const id = await conversation(h, view);
      await turnOn(h, view);

      const firstOff = gate();
      const on = gate();
      const secondOff = gate();
      let offWrites = 0;
      stores.failLater = (patch) => {
        if (!isOffWrite(patch)) return undefined;
        offWrites += 1;
        return offWrites === 2 && last === 'fails' ? secondOff.promise : undefined;
      };
      stores.holdMeta = (patch) => {
        if (patch['agentAuto'] === true) return on.promise;
        if (!isOffWrite(patch)) return undefined;
        return offWrites === 1 ? firstOff.promise : secondOff.promise;
      };

      setAuto(view, false, id);
      await until('Auto to be off', () => view.active().meta.agentAuto === false);
      setAuto(view, true, id);
      await until('the on to be written', () => storedMeta(id)?.agentAuto === true);
      expect(autoDialogs(h)).toHaveLength(2);
      setAuto(view, false, id);
      await until('the second off', () => offWrites === 2);

      firstOff.release();
      await until('the first off to land', () => stores.landed.filter(isOffWrite).length === 1);
      on.release();
      await until('the on to land', () => stores.landed.some((p) => p['agentAuto'] === true));
      // The window the guard protects: the on has landed, the later off has not.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(view.active().meta.agentAuto).not.toBe(true);
      expect(summaryAuto(view, id)).not.toBe(true);
      view.expectMirror();
      secondOff.release();
      if (last === 'fails') {
        await until('a toast', () => view.toasts.length === 1);
        expect(view.toasts[0]?.text).toBe(TEXT.autoOffNotSaved);
        // The store kept the on.
        expect(storedMeta(id)?.agentAuto).toBe(true);
      } else {
        await until('the second off to land', () => stores.landed.filter(isOffWrite).length === 2);
        expect(storedMeta(id)?.agentAuto).toBe(false);
        expect(view.toasts).toEqual([]);
      }
      stores.failLater = undefined;
      stores.holdMeta = undefined;
      await expectOff(h, view, id);
    },
  );

  it('a retry write in flight across a later off does not end that off', async () => {
    const h = await harness([text(), bashScenario()]);
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    // An off that cannot be saved: the store keeps on.
    stores.failMeta = isOffWrite;
    setAuto(view, false, id);
    await until('a toast', () => view.toasts.length === 1);
    stores.failMeta = undefined;

    // A rename carries the off along (a retry), and is held.
    const retry = gate();
    stores.holdMeta = (patch) => (patch['title'] === 'renamed' ? retry.promise : undefined);
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed' });
    await until('the retry to be written', () => storedMeta(id)?.title === 'renamed');
    // On through the dialog, saved; then off again, not saved.
    await turnOn(h, view);
    stores.failMeta = isOffWrite;
    setAuto(view, false, id);
    await until('a second toast', () => view.toasts.length === 2);
    expect(storedMeta(id)?.agentAuto).toBe(true);

    retry.release();
    await until('the retry to land', () => stores.landed.some((p) => p['title'] === 'renamed'));
    stores.failMeta = undefined;
    stores.holdMeta = undefined;
    await expectOff(h, view, id);
  });
});

// ---- settings that narrow Auto during a turn -------------------------------------------------------------

describe('settings changed during a turn with Auto', () => {
  it('alwaysAskCommands turned on: the next command asks, and the composer says so at once', async () => {
    const h = await harness([
      text(),
      agentScenario(
        commandSteps('echo one', 'one.txt', 'toolu_1'),
        webFetchSteps('toolu_2'),
        commandSteps('echo two', 'two.txt', 'toolu_3'),
      ),
    ]);
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');
    expect(toolCalls(view)[0]).toMatchObject({ name: 'Bash', approval: 'auto' });
    changeSettings(h, { alwaysAskCommands: true });
    expect(view.current().agentAuto).toEqual({ offered: true, commands: false });
    await answer(view, 'deny', 'network');
    const prompt = await answer(view, 'allow-once', 'command');
    expect(prompt.detail).toBe('echo two');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['auto', 'user', 'user']);
  });

  it('auto.webTools turned off: the next web call asks', async () => {
    const h = await harness(
      [
        text(),
        agentScenario(
          webFetchSteps('toolu_1'),
          writeSteps('.vscode/settings.json', '{}', 'toolu_2'),
          webFetchSteps('toolu_3'),
        ),
      ],
      { settings: { agentAutoWebTools: true } },
    );
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the protected prompt', () => pendingPrompt(view)?.category === 'protected-path');
    expect(toolCalls(view)[0]).toMatchObject({ name: 'WebFetch', approval: 'auto' });
    changeSettings(h, { agentAutoWebTools: false });
    await answer(view, 'deny', 'protected-path');
    await answer(view, 'deny', 'network');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['auto', 'user', 'user']);
  });

  it('alwaysAskCommands turned off: commands still ask for the rest of the turn', async () => {
    const h = await harness(
      [
        text(),
        agentScenario(
          commandSteps('echo one', 'one.txt', 'toolu_1'),
          commandSteps('echo two', 'two.txt', 'toolu_2'),
        ),
      ],
      { settings: { alwaysAskCommands: true } },
    );
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the command prompt', () => pendingPrompt(view)?.category === 'command');
    changeSettings(h, { alwaysAskCommands: false });
    await answer(view, 'allow-once', 'command');
    const prompt = await answer(view, 'allow-once', 'command');
    expect(prompt.detail).toBe('echo two');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['user', 'user']);
  });

  it('auto.webTools turned on: web calls still ask for the rest of the turn', async () => {
    const h = await harness([
      text(),
      agentScenario(webFetchSteps('toolu_1'), webFetchSteps('toolu_2')),
    ]);
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');
    changeSettings(h, { agentAutoWebTools: true });
    await answer(view, 'deny', 'network');
    await until('the second web prompt', () => toolCalls(view)[0]?.status !== 'running');
    await answer(view, 'deny', 'network');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['user', 'user']);
  });
});

// ---- the reset of Auto on the whole machine --------------------------------------------------------------

/** What the file of the reset holds, or undefined when it is missing or cannot be read. */
function storedReset(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, AUTO_RESET_FILE), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** The stored time of the last reset, when the file holds a valid one. */
function storedResetValue(dir: string): number | undefined {
  const value = storedReset(dir);
  if (typeof value !== 'object' || value === null) return undefined;
  const lastSeenOff = (value as { lastSeenOff?: unknown }).lastSeenOff;
  return typeof lastSeenOff === 'number' ? lastSeenOff : undefined;
}

describe('the setting turned off and on again in another window', () => {
  it.each(['saved', 'not saved'] as const)(
    'leaves a conversation of a closed workspace off when it is opened again (the clearing %s)',
    async (clearing) => {
      const first = await harness([text()]);
      const view = first.attach();
      const id = await conversation(first, view);
      await turnOn(first, view);
      const since = storedMeta(id)?.agentAutoSince ?? 0;
      expect(since).toBeGreaterThan(0);
      await first.controller.dispose();

      // Another workspace, on the same machine: it sees the setting off, then on again.
      const other = await createHarness({
        globalStorage: first.globalStorage,
        realDefaults: true,
        noStart: true,
      });
      harnesses.push(other);
      other.env.settingsValue = { ...DEFAULT_SETTINGS };
      await other.controller.start();
      changeSettings(other, { agentAuto: false });
      changeSettings(other, { agentAuto: true });
      await until(
        'the reset to be stored',
        () => (storedResetValue(first.globalStorage) ?? 0) > since,
      );
      await other.dispose();

      // The first workspace again: its store was never swept. When the clearing of its flag cannot be
      // saved, the store keeps saying on, and the conversation is off all the same.
      if (clearing === 'not saved') stores.failMeta = isOffWrite;
      const again = await createHarness({
        reuse: first,
        realDefaults: true,
        noStart: true,
        sequence: [bashScenario(), bashScenario()],
      });
      harnesses.unshift(again);
      again.env.settingsValue = { ...DEFAULT_SETTINGS };
      await again.controller.start();
      const shown = again.attach();
      expect(summaryAuto(shown, id)).not.toBe(true);
      if (clearing === 'saved') {
        await until('the stored flag to clear', () => storedMeta(id)?.agentAuto === false);
      } else {
        await until('the clearing to fail', () =>
          again.logger.has('warn', 'Auto could not be turned off in a stored conversation'),
        );
        expect(storedMeta(id)?.agentAuto).toBe(true);
      }
      shown.send({ type: 'conversation.open', conversationId: id });
      await until('the conversation', () => shown.state?.active?.meta.id === id);
      expect(shown.active().meta.agentAuto).not.toBe(true);
      send(shown, 'agent');
      await answer(shown, 'allow-once', 'command');
      await finishedTurn(again, shown);
      expect(toolCalls(shown)).toMatchObject([{ name: 'Bash', approval: 'user' }]);

      // On again only through the dialog, and then it works.
      await turnOn(again, shown);
      expect(autoDialogs(again)).toHaveLength(1);
      expect(storedMeta(id)?.agentAutoSince).toBeGreaterThan(
        storedResetValue(first.globalStorage) ?? Infinity,
      );
      await agentTurn(again, shown, 'again');
      expect(toolCalls(shown).at(-1)).toMatchObject({ name: 'Bash', approval: 'auto' });
    },
  );

  it('warns once when the reset cannot be saved, and an environment change saves it later', async () => {
    const h = await harness([text()]);
    const view = h.attach();
    const file = join(h.globalStorage, AUTO_RESET_FILE);
    // The file can no longer be read, so it is not written over.
    await fs.rm(file, { force: true });
    await fs.mkdir(file);
    const warnings = () => view.toasts.filter((toast) => toast.text === TEXT.autoResetNotSaved);
    changeSettings(h, { agentAuto: false });
    await until('the warning', () => warnings().length === 1);
    expect(warnings()[0]).toEqual({ level: 'warning', text: TEXT.autoResetNotSaved });
    // Retries do not warn again.
    changeSettings(h, { agentAuto: true });
    changeSettings(h, { agentAuto: false });
    h.controller.environmentChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(warnings()).toHaveLength(1);
    expect((await fs.stat(file)).isDirectory()).toBe(true);
    // Once the file can be written, the next environment change saves the reset.
    await fs.rm(file, { recursive: true });
    changeSettings(h, { agentAuto: true });
    await until('the reset to be saved', () => (storedResetValue(h.globalStorage) ?? 0) > 0);
    expect(warnings()).toHaveLength(1);
  });

  it('works with no global storage: in memory only, and nothing throws', async () => {
    const h = await harness([text(), bashScenario(), bashScenario()], {
      beforeStart: (made) => {
        made.env.globalStorage = undefined;
      },
    });
    const view = h.attach();
    const id = await conversation(h, view);
    await turnOn(h, view);
    changeSettings(h, { agentAuto: false });
    changeSettings(h, { agentAuto: true });
    expect(view.active().meta.agentAuto).toBe(false);
    send(view, 'agent');
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'Bash', approval: 'user' });
    await turnOn(h, view);
    await agentTurn(h, view, 'again');
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'Bash', approval: 'auto' });
    expect(storedMeta(id)?.agentAuto).toBe(true);
    expect(storedReset(h.globalStorage)).toBeUndefined();
    expect(h.logger.entries.filter((entry) => entry.level === 'error')).toEqual([]);
  });

  it.each(['missing', 'corrupt', 'unreadable'] as const)(
    'a %s file when the workspace is opened again: only a missing one means never reset',
    async (how) => {
      const first = await harness([text()]);
      const view = first.attach();
      const id = await conversation(first, view);
      await turnOn(first, view);
      const since = storedMeta(id)?.agentAutoSince ?? 0;
      await first.controller.dispose();

      const file = join(first.globalStorage, AUTO_RESET_FILE);
      await fs.rm(file, { force: true });
      if (how === 'corrupt') await fs.writeFile(file, '{"lastSeenOff": "no"');
      // A directory where the file should be: it cannot be read, and must not be written over.
      if (how === 'unreadable') await fs.mkdir(file);

      const again = await createHarness({
        reuse: first,
        realDefaults: true,
        noStart: true,
        sequence: [bashScenario()],
      });
      harnesses.unshift(again);
      again.env.settingsValue = { ...DEFAULT_SETTINGS };
      await again.controller.start();
      const shown = again.attach();
      shown.send({ type: 'conversation.open', conversationId: id });
      await until('the conversation', () => shown.state?.active?.meta.id === id);

      if (how === 'missing') {
        // Never reset: the conversation keeps its Auto, and the file is written.
        expect(shown.active().meta.agentAuto).toBe(true);
        await until('the file to be written', () => storedResetValue(first.globalStorage) === 0);
        await agentTurn(again, shown);
        expect(toolCalls(shown)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
        return;
      }
      // Fails closed: a reset now, so the conversation is off and its flag is cleared.
      expect(shown.active().meta.agentAuto).not.toBe(true);
      expect(summaryAuto(shown, id)).not.toBe(true);
      await until('the stored flag to clear', () => storedMeta(id)?.agentAuto === false);
      if (how === 'corrupt') {
        // Written again, with the reset later than the conversation's Auto.
        await until(
          'the file to be written',
          () => (storedResetValue(first.globalStorage) ?? 0) > since,
        );
        await turnOn(again, shown);
        expect(storedMeta(id)?.agentAutoSince).toBeGreaterThan(
          storedResetValue(first.globalStorage) ?? Infinity,
        );
        return;
      }
      // Not written over, and Auto cannot be turned on while the time cannot be recorded.
      expect((await fs.stat(file)).isDirectory()).toBe(true);
      setAuto(shown, true, id);
      await until('a toast', () => shown.toasts.length === 1);
      expect(shown.toasts[0]).toEqual({ level: 'warning', text: TEXT.autoNotSaved });
      await again.controller.dispose();
      expect(storedMeta(id)?.agentAuto).toBe(false);
    },
  );
});

// ---- the draft's Auto after a folder change, and an off while the first message is sent -------------------

describe('a draft with Auto', () => {
  it.each(['reordered', 'replaced'] as const)(
    'loses it at once when the folders are %s and its first message would go elsewhere',
    async (how) => {
      const h = await harness([text()], {
        beforeStart: (made) => {
          made.env.folderList = [
            ...made.env.folderList,
            { key: SECOND_FOLDER, name: 'second', path: join(made.root, 'second') },
          ];
        },
      });
      await fs.mkdir(join(h.root, 'second'), { recursive: true });
      const view = h.attach();
      setAuto(view, true);
      await until('the draft flag', () => view.state?.draftAgentAuto === true);
      const [work, second] = h.env.folderList;
      if (!work || !second) throw new Error('two folders expected');
      h.env.folderList =
        how === 'reordered'
          ? [second, work]
          : [{ key: 'folder-3' as FolderKey, name: 'third', path: join(h.root, 'third') }, work];
      h.controller.environmentChanged();
      expect(view.current().draftAgentAuto).toBe(false);
      view.expectMirror();
    },
  );

  it('turned off while its first message creates the conversation: no Auto, and the command asks', async () => {
    const h = await harness([bashScenario()]);
    const view = h.attach();
    setAuto(view, true);
    await until('the draft flag', () => view.state?.draftAgentAuto === true);
    const creation = gate();
    stores.holdCreate = creation.promise;
    send(view, 'agent');
    await until('the flag to be used', () => view.state?.draftAgentAuto === false);
    // The view still shows the draft, so the off names no conversation.
    setAuto(view, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    creation.release();
    await until('the conversation', () => view.state?.active !== null);
    const id = view.active().meta.id;
    expect(view.active().meta.agentAuto).not.toBe(true);
    expect(summaryAuto(view, id)).not.toBe(true);
    await answer(view, 'allow-once', 'command');
    await finishedTurn(h, view);
    expect(toolCalls(view)).toMatchObject([{ name: 'Bash', approval: 'user' }]);
    expect(userMessages(view)[0]).not.toHaveProperty('auto');
    await until('the store', () => storedMeta(id)?.agentAuto === false);
    expect(view.active().meta.agentAuto).not.toBe(true);
    expect(view.current().draftAgentAuto).toBe(false);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });
});

// ---- second verification round ----------------------------------------------------------------------------

describe('settings that narrow Auto, changed back during the turn', () => {
  it('alwaysAskCommands on and off again before the next command: it still asks, the next turn does not', async () => {
    const h = await harness([
      text(),
      agentScenario(
        commandSteps('echo one', 'one.txt', 'toolu_1'),
        webFetchSteps('toolu_2'),
        commandSteps('echo two', 'two.txt', 'toolu_3'),
      ),
      bashScenario('echo three', 'three.txt'),
    ]);
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the web prompt', () => pendingPrompt(view)?.category === 'network');
    changeSettings(h, { alwaysAskCommands: true });
    changeSettings(h, { alwaysAskCommands: false });
    await answer(view, 'deny', 'network');
    const prompt = await answer(view, 'allow-once', 'command');
    expect(prompt.detail).toBe('echo two');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['auto', 'user', 'user']);
    // The next turn follows the settings as they are now.
    await agentTurn(h, view, 'next');
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'Bash', approval: 'auto' });
  });

  it('auto.webTools off and on again before the next web call: it still asks, the next turn does not', async () => {
    const h = await harness(
      [
        text(),
        agentScenario(
          webFetchSteps('toolu_1'),
          writeSteps('.vscode/settings.json', '{}', 'toolu_2'),
          webFetchSteps('toolu_3'),
        ),
        agentScenario(webFetchSteps('toolu_4')),
      ],
      { settings: { agentAutoWebTools: true } },
    );
    const view = h.attach();
    await conversation(h, view);
    await turnOn(h, view);
    send(view, 'agent');
    await until('the protected prompt', () => pendingPrompt(view)?.category === 'protected-path');
    changeSettings(h, { agentAutoWebTools: false });
    changeSettings(h, { agentAutoWebTools: true });
    await answer(view, 'deny', 'protected-path');
    await answer(view, 'deny', 'network');
    await finishedTurn(h, view);
    expect(toolCalls(view).map((call) => call.approval)).toEqual(['auto', 'user', 'user']);
    await agentTurn(h, view, 'next');
    expect(toolCalls(view).at(-1)).toMatchObject({ name: 'WebFetch', approval: 'auto' });
  });
});

/** The lines of the first paragraph of the dialog for a draft in a folder with this name and path. */
async function dialogHead(folder: { name?: string; path?: string }): Promise<string[]> {
  const h = await harness([text()], {
    beforeStart: (made) => {
      const [work] = made.env.folderList;
      if (!work) throw new Error('a folder expected');
      made.env.folderList = [{ ...work, ...folder }];
    },
  });
  const view = h.attach();
  setAuto(view, true);
  await until('the draft flag', () => view.state?.draftAgentAuto === true);
  const [names = ''] = autoDialogs(h)[0]?.detail.split('\n\n') ?? [];
  return names.split('\n');
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// eslint-disable-next-line no-control-regex
const RAW_CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029\u2063]/;

describe('the shown path', () => {
  it('shows the home directory as ~, at a path boundary only', () => {
    expect(shownPath('/home/someone', '/home/someone')).toBe('~');
    expect(shownPath('/home/someone/work/app', '/home/someone')).toBe('~/work/app');
    expect(shownPath('/home/someoneelse/app', '/home/someone')).toBe('/home/someoneelse/app');
    expect(shownPath('/Users/anna/x', '/Users/ann')).toBe('/Users/anna/x');
    expect(shownPath('C:\\Users\\me\\app', 'C:\\Users\\me')).toBe('~\\app');
    expect(shownPath('/srv/app', '/')).toBe('/srv/app');
    expect(shownPath('/srv/app', '')).toBe('/srv/app');
  });

  it('compares a Windows home without regard to the case of the drive letter', () => {
    expect(shownPath('c:\\Users\\me\\app', 'C:\\Users\\me')).toBe('~\\app');
    expect(shownPath('c:\\users\\me', 'C:\\Users\\me')).toBe('~');
    // The boundary rule holds, and the original text after the home is kept as it is.
    expect(shownPath('c:\\Users\\mee\\app', 'C:\\Users\\me')).toBe('c:\\Users\\mee\\app');
    expect(shownPath('c:\\Users\\me\\App', 'C:\\Users\\me')).toBe('~\\App');
    // A case that differs on a system with a case-sensitive path stays different.
    expect(shownPath('/users/me/app', '/Users/me')).toBe('/users/me/app');
  });

  it('keeps 120 code points whole and cuts 121 in the middle, both ends intact', () => {
    const whole = `/${'a'.repeat(59)}${'b'.repeat(60)}`;
    expect(Array.from(whole)).toHaveLength(120);
    expect(shownPath(whole, '/home/someone')).toBe(whole);
    const long = `/root${'m'.repeat(100)}the-very-end-of-the-path-is-here`;
    const chars = Array.from(long);
    expect(chars.length).toBeGreaterThan(120);
    const shown = shownPath(long, '/home/someone');
    expect(shown).toBe(`${chars.slice(0, 40).join('')}…${chars.slice(-79).join('')}`);
    expect(Array.from(shown)).toHaveLength(120);
    expect(shown.startsWith('/root')).toBe(true);
    expect(shown.endsWith('the-very-end-of-the-path-is-here')).toBe(true);
    const exact = `/${'c'.repeat(120)}`;
    expect(Array.from(exact)).toHaveLength(121);
    expect(shownPath(exact, '')).toBe(`/${'c'.repeat(39)}…${'c'.repeat(79)}`);
  });

  it('cuts a path of emoji by code point, never leaving half of one', () => {
    const shown = shownPath(`/${'😀'.repeat(130)}`, '');
    expect(shown).toBe(`/${'😀'.repeat(39)}…${'😀'.repeat(79)}`);
    expect(shown).not.toMatch(LONE_SURROGATE);
  });
});

describe('the folder line of the dialog', () => {
  it('two folders with the same name give two different dialogs', async () => {
    const h = await harness([text()], {
      beforeStart: (made) => {
        made.env.folderList = [
          ...made.env.folderList,
          { key: SECOND_FOLDER, name: 'work', path: join(made.root, 'elsewhere', 'work') },
        ];
      },
    });
    const view = h.attach();
    h.ui.confirmAnswer = false;
    setAuto(view, true);
    await until('the first dialog', () => autoDialogs(h).length === 1);
    view.send({ type: 'conversation.new', folder: SECOND_FOLDER });
    await new Promise((resolve) => setTimeout(resolve, 20));
    setAuto(view, true);
    await until('the second dialog', () => autoDialogs(h).length === 2);
    const [one, two] = autoDialogs(h).map((dialog) => dialog.detail.split('\n')[0]);
    expect(one).toBe(workLine(h));
    expect(two).toBe(`Folder: ${shownPath(join(h.root, 'elsewhere', 'work'), homedir())}`);
    expect(one).not.toBe(two);
  });

  it('the first paragraph is the folder path and the conversation, and the folder name is not shown', async () => {
    const lines = await dialogHead({
      name: 'app (~/work/app)\nFolder: elsewhere\u202E\r\n\u2066\u2028b',
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Folder: \//);
    expect(lines[1]).toBe('Conversation: new');
    expect(lines.join('\n')).not.toContain('app (~/work/app)');
    expect(lines.join('\n')).not.toContain('elsewhere');
  });

  it('two folders whose paths differ only by a line break, or only by U+2063, show differently', async () => {
    const base = '/srv/project';
    const heads = await Promise.all(
      [`${base}/a b`, `${base}/a\nb`, `${base}/a\r\nb`, `${base}/a\tb`, `${base}/a\u2063b`].map(
        async (path) => dialogHead({ path }),
      ),
    );
    const folders = heads.map((lines) => lines[0]);
    for (const lines of heads) {
      expect(lines).toHaveLength(2);
      expect(lines.join('\n')).not.toMatch(RAW_CONTROL);
    }
    expect(new Set(folders).size).toBe(folders.length);
    expect(folders[1]).toBe('Folder: /srv/project/a\\u{000A}b');
    expect(folders[4]).toBe('Folder: /srv/project/a\\u{2063}b');
  });

  it('a path longer than 120 code points is cut in the middle in the dialog', async () => {
    const path = `/start${'x'.repeat(130)}/the-end`;
    const [folder] = await dialogHead({ path });
    const chars = Array.from(path);
    expect(folder).toBe(`Folder: ${chars.slice(0, 40).join('')}…${chars.slice(-79).join('')}`);
  });
});

describe('the title in the dialog', () => {
  /** The `Conversation:` line of the dialog for a conversation with this title. */
  async function titleLine(title: string): Promise<string | undefined> {
    const h = await harness([text()]);
    const view = h.attach();
    const id = await conversation(h, view);
    view.send({ type: 'conversation.rename', conversationId: id, title });
    await until('the rename', () => view.active().meta.title === title);
    await turnOn(h, view);
    return autoDialogs(h)[0]?.detail.split('\n')[1];
  }

  it('shows 60 characters whole and cuts 61 to 59 and an ellipsis', async () => {
    expect(await titleLine('y'.repeat(60))).toBe(`Conversation: ${'y'.repeat(60)}`);
    expect(await titleLine('z'.repeat(61))).toBe(`Conversation: ${'z'.repeat(59)}…`);
  });

  it('cuts a title of emoji without leaving half of one', async () => {
    const line = await titleLine('😀'.repeat(61));
    expect(line).toBe(`Conversation: ${'😀'.repeat(59)}…`);
    expect(line).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

describe('the reset read again when the dialog is confirmed', () => {
  it('turns off a conversation it outdates, and the confirmed one is later than it', async () => {
    const h = await harness([text('a'), text('b'), bashScenario()]);
    const first = h.attach();
    const a = await conversation(h, first, 'first');
    await turnOn(h, first);
    const sinceA = storedMeta(a)?.agentAutoSince ?? 0;
    const second = h.attach();
    const b = await conversation(h, second, 'second');

    const release = holdDialog(h, AUTO_TITLE);
    setAuto(second, true, b);
    await until('the dialog', () => autoDialogs(h).length === 2);
    // Another window reset Auto after A was turned on.
    const reset = sinceA + 1;
    await fs.writeFile(
      join(h.globalStorage, AUTO_RESET_FILE),
      JSON.stringify({ lastSeenOff: reset, highestStamp: reset }),
    );
    release();
    await until('B to have Auto', () => second.state?.active?.meta.agentAuto === true);
    expect(first.active().meta.agentAuto).toBe(false);
    expect(summaryAuto(first, a)).toBe(false);
    expect(storedMeta(b)?.agentAutoSince).toBeGreaterThan(reset);
    await agentTurn(h, second);
    expect(toolCalls(second)).toMatchObject([{ name: 'Bash', approval: 'auto' }]);
  });
});

describe('a conversation built while it loads', () => {
  it('takes a change written during the load', async () => {
    const h = await harness([text('one'), text('two')]);
    const view = h.attach();
    const id = await conversation(h, view, 'first');
    view.send({ type: 'conversation.new' });
    await until('the draft', () => view.state?.active === null);
    await conversation(h, view, 'second');

    const load = gate();
    stores.holdLoad = load.promise;
    const loads = stores.loads;
    view.send({ type: 'conversation.open', conversationId: id });
    await until('the load to read', () => stores.loads > loads);
    view.send({ type: 'conversation.rename', conversationId: id, title: 'renamed meanwhile' });
    await until('the rename to land', () =>
      stores.landed.some((patch) => patch['title'] === 'renamed meanwhile'),
    );
    stores.holdLoad = undefined;
    load.release();
    await until('the conversation', () => view.state?.active?.meta.id === id);
    expect(view.active().meta.title).toBe('renamed meanwhile');
    expect(summaryAuto(view, id)).not.toBe(true);
    view.expectMirror();
  });
});
