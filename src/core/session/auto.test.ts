import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { TEXT } from './text';

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
        const written = updateMeta(id, patch);
        const hold = stores.holdMeta?.(patch);
        if (!hold) return written;
        written.catch(() => undefined);
        await hold;
        return written;
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
        'In "hello" (work), Agent turns run terminal commands and edits inside the folder without asking for each one. Commands run with your privileges.',
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
        'In "hello" (work), Agent turns run edits inside the folder without asking for each one. Terminal commands still ask, because agentCanopy.agent.alwaysAskCommands is on.',
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
          'In the new conversation (work), Agent turns run terminal commands and edits inside the folder without asking for each one. Commands run with your privileges.',
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
    expect(autoDialogs(h)[0]?.detail).toContain('In "a\\u{202E}b" (work)');
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
    // ...and set by hand in the store, then carried into memory by a rename.
    await store().updateMeta(id, { agentAuto: true });
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
    expect(autoDialogs(h)[0]?.detail).toContain('In the new conversation (work)');

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
    // The conversation's flag comes back behind the controller's back: the setting alone, read
    // live by the turn, keeps Auto away.
    await store().updateMeta(id, { agentAuto: true });
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
