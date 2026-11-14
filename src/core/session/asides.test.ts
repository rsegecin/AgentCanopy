import { promises as fs, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import type {
  ActiveConversation,
  Aside,
  AssistantMessage,
  ConversationId,
  ConversationSummary,
  PatchOp,
} from '../../shared';
import type { TurnObserver, TurnPolicy } from '../contracts';
import type { ConversationStore } from '../conversations/store';
import { createPlanStore, renderPlanBlock } from '../plans';
import type { PlanStore } from '../plans';
import { projectAside } from './asides';
import { canonicalJson } from './prompts';
import {
  assistantText,
  assistantToolUse,
  createHarness,
  createPlanTestPolicy,
  createTestPolicy,
  finishedTurn,
  resultStep,
  sendAndFinish,
  stateEvent,
  streamedText,
  textScenario,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type TestView,
} from './test-support';
import { TEXT } from './text';

vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

// ---- the invariant: the parent's card equals a fresh projection of its branch -----------------------

interface StateInternals {
  runtimes: Map<ConversationId, { data: ActiveConversation }>;
  mutate: (...args: unknown[]) => void;
}

function internals(h: Harness): StateInternals {
  return Reflect.get(h.controller, 'state') as StateInternals;
}

/**
 * Checks after every change of every loaded conversation that each side question whose parent is
 * loaded is shown in the parent exactly as its branch projects. Returns the problems found.
 */
function watchAsides(h: Harness): string[] {
  const state = internals(h);
  const original = state.mutate.bind(state);
  const problems: string[] = [];
  let checks = 0;
  state.mutate = (...args: unknown[]) => {
    original(...args);
    for (const runtime of state.runtimes.values()) {
      const aside = runtime.data.meta.aside;
      if (aside?.turnId === undefined) continue;
      const parent = state.runtimes.get(aside.parentId);
      if (!parent) continue;
      checks += 1;
      const entry = parent.data.asides.find(
        (candidate) => candidate.conversationId === runtime.data.meta.id,
      );
      if (canonicalJson(entry) !== canonicalJson(projectAside(runtime.data))) {
        problems.push(`step ${String(checks)}: ${canonicalJson(entry)}`);
      }
    }
  };
  return problems;
}

async function harness(options: HarnessOptions): Promise<{ h: Harness; problems: string[] }> {
  const h = await createHarness(options);
  harnesses.push(h);
  return { h, problems: watchAsides(h) };
}

// ---- scenarios -----------------------------------------------------------------------------------------

const text = (answer: string): ScenarioSpec => ({ record: true, scenario: textScenario(answer) });

/** A parent turn that streams `working` and then waits until it is stopped. */
const hanging: ScenarioSpec = {
  record: true,
  scenario: { steps: [...streamedText(['working']), { hang: true }] },
};

/** A parent turn that completes by itself after `ms`. */
const slow = (ms: number): ScenarioSpec => ({
  scenario: { steps: [...streamedText(['working']), { sleep: ms }, ...resultStep('done')] },
});

/** The side question's answer, streamed in pieces after a pause. */
const streamedAnswer = (chunks: string[], pauseMs = 120): ScenarioSpec => ({
  record: true,
  scenario: {
    steps: [{ sleep: 200 }, ...streamedText(chunks, { pauseMs }), ...resultStep(chunks.join(''))],
  },
});

const QUESTIONS = [
  {
    question: 'Which file?',
    header: 'File',
    options: [
      { label: 'a.ts', description: 'The first' },
      { label: 'b.ts', description: 'The second' },
    ],
    multiSelect: false,
  },
];

/** A side question that asks the user with AskUserQuestion before it answers. */
const askingAnswer: ScenarioSpec = {
  scenario: {
    steps: [
      stateEvent('running'),
      initEvent(),
      assistantToolUse('toolu_q', 'AskUserQuestion', { questions: QUESTIONS }),
      {
        permission: {
          toolName: 'AskUserQuestion',
          input: { questions: QUESTIONS },
          toolUseId: 'toolu_q',
          onAllow: [
            userToolResult('toolu_q', 'answered', {
              decision: { decision: 'accept', source: 'user_temporary' },
            }),
          ],
          onDeny: [userToolResult('toolu_q', 'The user did not answer.', { isError: true })],
        },
      },
      assistantText('it is a.ts'),
      ...resultStep('it is a.ts'),
    ],
  },
};

// ---- helpers --------------------------------------------------------------------------------------------

function sendIn(
  view: TestView,
  conversationId: ConversationId,
  message: string,
  mode: 'ask' | 'plan' | 'agent' = 'ask',
): void {
  view.send({ type: 'turn.send', conversationId, text: message, mode, model: 'default' });
}

function assistants(view: TestView): AssistantMessage[] {
  return (view.state?.active?.messages ?? []).filter(
    (m): m is AssistantMessage => m.role === 'assistant',
  );
}

function branchesOf(view: TestView, parentId: ConversationId): ConversationSummary[] {
  return view.current().conversations.filter((summary) => summary.aside?.parentId === parentId);
}

function storedIds(h: Harness): ConversationId[] {
  const store = Reflect.get(h.controller, 'store') as { list(): { id: ConversationId }[] };
  return store.list().map((meta) => meta.id);
}

function entry(view: TestView, index = 0): Aside | undefined {
  return view.state?.active?.asides[index];
}

/** The parent's state without its side questions, for comparing before and after. */
function withoutAsides(active: ActiveConversation): Omit<ActiveConversation, 'asides'> {
  const { asides, ...rest } = active;
  void asides;
  return rest;
}

/** A fresh projection of a branch, read by opening it in a view of its own. */
async function freshProjection(h: Harness, branchId: ConversationId): Promise<Aside | undefined> {
  const reader = h.attach();
  reader.send({ type: 'conversation.open', conversationId: branchId });
  await until('the branch to open', () => reader.state?.active?.meta.id === branchId);
  const projection = projectAside(reader.active());
  reader.dispose();
  return projection;
}

/** The application's conversation store, whose methods a test may wrap. */
function storeOf(h: Harness): ConversationStore {
  return Reflect.get(h.controller, 'store') as ConversationStore;
}

/** A promise and the function that resolves it. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function conversationFile(h: Harness, id: ConversationId): string {
  return readFileSync(join(h.storage, 'conversations', `${id}.jsonl`), 'utf8');
}

/** A parent with one answered turn and a second turn that is running and has written `working`. */
async function runningParent(
  options: HarnessOptions,
): Promise<{ h: Harness; problems: string[]; view: TestView; parentId: ConversationId }> {
  const { h, problems } = await harness(options);
  const view = h.attach();
  await sendAndFinish(h, view, 'one');
  const parentId = view.active().meta.id;
  sendIn(view, parentId, 'two');
  await until('the running answer', () => (assistants(view)[1]?.parts.length ?? 0) === 1);
  return { h, problems, view, parentId };
}

// ---- tests ----------------------------------------------------------------------------------------------

describe('a question asked in Ask mode while a turn runs', () => {
  it('runs alongside in a branch of the finished turns and leaves the parent alone', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, streamedAnswer(['The ', 'side ', 'answer'])],
    });
    // The running turn's answer so far is stored before the parent is compared.
    await until('the running answer to be stored', () =>
      conversationFile(h, parentId).includes('working'),
    );
    const parentBefore = withoutAsides(view.active());
    const parentSession = parentBefore.meta.sessionId;
    const storedBefore = conversationFile(h, parentId);
    const runningAnswer = assistants(view)[1];

    sendIn(view, parentId, 'side question?');
    await until('the side question to run', () => h.controller.runningTurns() === 2);
    await until('the card', () => entry(view) !== undefined);
    expect(view.toasts).toEqual([]);
    expect(view.active().meta.id).toBe(parentId);
    await until('the answer', () => entry(view)?.status === 'completed');
    expect(h.controller.runningTurns()).toBe(1);

    // The branch.
    const [branch] = branchesOf(view, parentId);
    if (!branch) throw new Error('no branch');
    expect(branch.title).toBe('side question?');
    expect(branch.mode).toBe('ask');
    expect(branch.fork?.parentId).toBe(parentId);
    expect(branch.aside).toEqual({
      parentId,
      anchor: { messageId: runningAnswer?.id, afterParts: 1 },
      turnId: expect.any(String) as string,
    });
    const reader = h.attach();
    reader.send({ type: 'conversation.open', conversationId: branch.id });
    await until('the branch to open', () => reader.state?.active?.meta.id === branch.id);
    const opened = reader.active();
    expect(opened.turns).toHaveLength(2);
    expect(opened.turns[1]?.id).toBe(branch.aside?.turnId);
    expect(opened.messages.map((m) => (m.role === 'user' ? m.text : m.role))).toEqual([
      'one',
      'assistant',
      'side question?',
      'assistant',
    ]);

    // The card.
    expect(view.active().asides).toEqual([
      {
        conversationId: branch.id,
        anchor: { messageId: runningAnswer?.id, afterParts: 1 },
        question: 'side question?',
        parts: [{ kind: 'text', text: 'The side answer' }],
        prompts: [],
        status: 'completed',
      },
    ]);
    expect(view.active().asides[0]).toEqual(projectAside(opened));

    // A new session with the visible turns rebuilt: the parent's session is neither resumed nor copied.
    const request = h.requests[2];
    expect(request?.session.kind).toBe('new');
    expect(request?.session.kind === 'new' && request.session.sessionId).not.toBe(parentSession);
    const { argv, stdin } = await h.record(2);
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--fork-session');
    expect(stdin).toContain('<prior-conversation');
    expect(stdin).toContain('answer 1');
    expect(stdin).not.toContain('working');

    // The parent is untouched: in memory, in every view and in storage.
    expect(withoutAsides(view.active())).toEqual(parentBefore);
    expect(view.active().meta.sessionId).toBe(parentSession);
    expect(conversationFile(h, parentId)).toBe(storedBefore);
    expect(h.controller.runningTurns()).toBe(1);
    expect(view.active().turns[1]?.status).toBe('running');

    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
    view.expectMirror();
  });

  it('is anchored after the parts the running answer had', async () => {
    const parts: ScenarioSpec = {
      scenario: {
        steps: [
          ...streamedText(['looking']),
          assistantToolUse('toolu_1', 'Read', { file_path: 'a.ts' }),
          { hang: true },
        ],
      },
    };
    const { h, problems } = await harness({
      sequence: [parts, streamedAnswer(['ok'])],
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'one', mode: 'ask', model: 'default' });
    await until('two parts', () => (assistants(view)[0]?.parts.length ?? 0) === 2);
    const parentId = view.active().meta.id;
    sendIn(view, parentId, 'side');
    await until('the card', () => entry(view) !== undefined);
    expect(entry(view)?.anchor).toEqual({ messageId: assistants(view)[0]?.id, afterParts: 2 });
    // Nothing finished before the running turn: the branch keeps no turn.
    const [branch] = branchesOf(view, parentId);
    expect(branch?.fork?.lastKeptParentTurnId).toBeUndefined();
    await until('the answer', () => entry(view)?.status === 'completed');
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('is anchored at the running turn’s message when nothing was written yet', async () => {
    const silent: ScenarioSpec = {
      scenario: { steps: [stateEvent('running'), initEvent(), { hang: true }] },
    };
    const { h, problems } = await harness({ sequence: [silent, streamedAnswer(['ok'])] });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'one', mode: 'ask', model: 'default' });
    await until('the provider to start', () => h.requests.length === 1);
    await until('the turn to run', () => view.state?.active?.turns[0]?.status === 'running');
    const parentId = view.active().meta.id;
    expect(assistants(view)).toEqual([]);
    sendIn(view, parentId, 'side');
    await until('the card', () => entry(view) !== undefined);
    expect(entry(view)?.anchor).toEqual({
      messageId: view.active().messages[0]?.id,
      afterParts: 0,
    });
    await until('the answer', () => entry(view)?.status === 'completed');
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('streams into the parent view’s card as text appends', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, streamedAnswer(['Alpha ', 'beta ', 'gamma ', 'delta'])],
    });
    const before = view.messages.length;
    sendIn(view, parentId, 'side');
    await until('the card', () => entry(view) !== undefined);
    expect(entry(view)?.status).not.toBe('completed');
    await until('the answer', () => entry(view)?.status === 'completed');

    const ops: PatchOp[] = view.messages
      .slice(before)
      .flatMap((message) => (message.type === 'patch' ? message.ops : []));
    const appends = ops.filter(
      (op) => op.op === 'appendText' && op.path[0] === 'active' && op.path[1] === 'asides',
    );
    expect(appends.length).toBeGreaterThan(0);
    for (const op of appends) expect(op.path).toEqual(['active', 'asides', 0, 'parts', 0, 'text']);
    expect(entry(view)?.parts).toEqual([{ kind: 'text', text: 'Alpha beta gamma delta' }]);
    // No message of the side question reached the parent's transcript.
    expect(view.active().messages).toHaveLength(4);

    const branchId = entry(view)?.conversationId;
    if (!branchId) throw new Error('no branch');
    expect(entry(view)).toEqual(await freshProjection(h, branchId));
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
    view.expectMirror();
  });

  it('shows its prompts in the card, and an answer from the parent’s view lets it finish', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, askingAnswer],
    });
    sendIn(view, parentId, 'which file?');
    await until('the prompt', () => (entry(view)?.prompts.length ?? 0) === 1);
    const card = entry(view);
    const prompt = card?.prompts[0];
    if (!card || !prompt) throw new Error('no prompt');
    expect(prompt.state).toBe('pending');
    expect(prompt.conversationId).toBe(card.conversationId);
    expect(card.parts).toContainEqual({ kind: 'prompt', promptId: prompt.id });
    // The parent has no prompt of its own.
    expect(view.active().prompts).toEqual([]);

    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'question', answers: { 'Which file?': ['a.ts'] } },
    });
    await until('the answer', () => entry(view)?.status === 'completed');
    expect(entry(view)?.prompts[0]?.state).toBe('answered');
    expect(entry(view)?.parts.at(-1)).toEqual({ kind: 'text', text: 'it is a.ts' });
    expect(entry(view)).toEqual(await freshProjection(h, card.conversationId));
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('runs one at a time per conversation', async () => {
    const sideHanging: ScenarioSpec = {
      scenario: { steps: [...streamedText(['thinking']), { hang: true }] },
    };
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, sideHanging],
    });
    // Two in the same tick give one branch.
    sendIn(view, parentId, 'first side');
    sendIn(view, parentId, 'second side');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.asideRunning }]);
    await until('the card', () => entry(view) !== undefined);
    expect(entry(view)?.question).toBe('first side');

    // And one while it runs is refused too.
    sendIn(view, parentId, 'third side');
    await until('a second toast', () => view.toasts.length === 2);
    expect(view.toasts[1]).toEqual({ level: 'warning', text: TEXT.asideRunning });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(branchesOf(view, parentId)).toHaveLength(1);
    expect(storedIds(h)).toHaveLength(2);
    expect(view.active().asides).toHaveLength(1);
    expect(h.requests).toHaveLength(3);
    expect(h.controller.runningTurns()).toBe(2);
    expect(problems).toEqual([]);
  });

  it('is stopped on its own by turn.cancel for its branch', async () => {
    const sideHanging: ScenarioSpec = {
      scenario: { steps: [...streamedText(['thinking']), { hang: true }] },
    };
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, sideHanging],
    });
    sendIn(view, parentId, 'side');
    await until('the side answer', () => (entry(view)?.parts.length ?? 0) === 1);
    const branchId = entry(view)?.conversationId;
    if (!branchId) throw new Error('no branch');
    view.send({ type: 'turn.cancel', conversationId: branchId });
    await until('the stop', () => entry(view)?.status === 'interrupted');
    await until('one run left', () => h.controller.runningTurns() === 1);
    expect(view.active().turns[1]?.status).toBe('running');
    expect(entry(view)?.error).toBeUndefined();
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('is stopped when the application shuts down', async () => {
    const sideHanging: ScenarioSpec = {
      scenario: { steps: [...streamedText(['thinking']), { hang: true }] },
    };
    const { h, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, sideHanging],
    });
    sendIn(view, parentId, 'side');
    await until('the side answer', () => (entry(view)?.parts.length ?? 0) === 1);
    expect(h.controller.runningTurns()).toBe(2);
    await h.controller.dispose();
    expect(h.controller.runningTurns()).toBe(0);
    for (const handle of h.handles) await handle.done;
  });

  it('goes on when the parent’s turn ends, and a message queued in the parent goes out then', async () => {
    const { h, problems } = await harness({
      policy: createPlanTestPolicy(),
      sequence: [slow(2000), askingAnswer, { scenario: textScenario('agent answer') }],
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'first', mode: 'ask', model: 'default' });
    await until('the running answer', () => (assistants(view)[0]?.parts.length ?? 0) === 1);
    const parentId = view.active().meta.id;

    sendIn(view, parentId, 'side');
    await until('the side prompt', () => (entry(view)?.prompts.length ?? 0) === 1);
    // A side question does not keep an Agent message from being queued.
    sendIn(view, parentId, 'agent work', 'agent');
    await until('the queued message', () => view.state?.active?.queued != null);
    expect(view.toasts).toEqual([]);

    await until('the parent to complete', () => view.active().turns[0]?.status === 'completed');
    await until('the queued message to go out', () => view.active().turns.length === 2);
    expect(view.active().queued).toBeNull();
    expect(entry(view)?.status).toBe('running');
    await until('the agent turn', () => view.active().turns[1]?.status === 'completed');
    expect(entry(view)?.status).toBe('running');

    const prompt = entry(view)?.prompts[0];
    if (!prompt) throw new Error('no prompt');
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'question', answers: { 'Which file?': ['a.ts'] } },
    });
    await until('the side answer', () => entry(view)?.status === 'completed');
    await h.idle();
    expect(problems).toEqual([]);
    view.expectMirror();
  });

  it('leaves no branch behind when its turn cannot start', async () => {
    const base = createTestPolicy();
    const policy: TurnPolicy = {
      ...base,
      profile: (input) =>
        input.conversation.aside !== undefined
          ? { unavailable: 'Side questions are not available here.' }
          : base.profile(input),
    };
    const { h, problems, view, parentId } = await runningParent({
      policy,
      sequence: [text('answer 1'), hanging, streamedAnswer(['never'])],
    });
    h.ui.picked = ['src/a.ts'];
    view.send({ type: 'context.pick', what: 'file' });
    await until('the attachment', () => view.current().draftAttachments.length === 1);

    sendIn(view, parentId, 'side');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([
      { level: 'warning', text: 'Side questions are not available here.' },
    ]);
    await until('the branch to go', () => storedIds(h).length === 1);
    expect(storedIds(h)).toEqual([parentId]);
    await until('the list', () => view.current().conversations.length === 1);
    expect(view.active().asides).toEqual([]);
    expect(view.current().draftAttachments).toEqual([{ kind: 'file', path: 'src/a.ts' }]);
    expect(h.requests).toHaveLength(2);
    expect(h.controller.runningTurns()).toBe(1);
    expect(Reflect.get(h.controller, 'asking')).toEqual(new Set());
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('is rebuilt from the stored branch when the parent is opened again, and goes with its branch', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, streamedAnswer(['kept ', 'answer']), text('elsewhere')],
    });
    sendIn(view, parentId, 'side');
    await until('the answer', () => entry(view)?.status === 'completed');
    const shown = view.active().asides;
    const branchId = shown[0]?.conversationId;
    if (!branchId) throw new Error('no branch');
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await finishedTurn(h, view);

    // Released from memory: the view moves to a new conversation.
    view.send({ type: 'conversation.new' });
    await until('a draft', () => view.state?.active === null);
    await sendAndFinish(h, view, 'another conversation');
    expect(view.active().asides).toEqual([]);
    expect(internals(h).runtimes.has(parentId)).toBe(false);
    expect(internals(h).runtimes.has(branchId)).toBe(false);

    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => view.state?.active?.meta.id === parentId);
    expect(view.active().asides).toEqual(shown);
    expect(view.active().asides[0]).toEqual(await freshProjection(h, branchId));
    view.expectMirror();

    // Deleting the branch removes the card while the parent is shown.
    view.send({ type: 'conversation.delete', conversationId: branchId });
    await until('the card to go', () => view.state?.active?.asides.length === 0);
    expect(view.active().meta.id).toBe(parentId);
    view.expectMirror();

    // And it stays gone when the parent is loaded again.
    view.send({ type: 'conversation.new' });
    await until('a draft', () => view.state?.active === null);
    expect(internals(h).runtimes.has(parentId)).toBe(false);
    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => view.state?.active?.meta.id === parentId);
    expect(view.active().asides).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('keeps its branch, as an ordinary branch, when the parent is deleted', async () => {
    const { h, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, streamedAnswer(['ok'])],
    });
    sendIn(view, parentId, 'side');
    await until('the answer', () => entry(view)?.status === 'completed');
    const branchId = entry(view)?.conversationId;
    view.send({ type: 'conversation.delete', conversationId: parentId });
    await until('the parent to go', () => !storedIds(h).includes(parentId));
    expect(storedIds(h)).toEqual([branchId]);
  });
});

describe('an Ask message that is not a side question', () => {
  it('is refused in a side question’s branch while its question runs', async () => {
    const sideHanging: ScenarioSpec = {
      scenario: { steps: [...streamedText(['thinking']), { hang: true }] },
    };
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, sideHanging],
    });
    sendIn(view, parentId, 'side');
    await until('the side answer', () => (entry(view)?.parts.length ?? 0) === 1);
    const branchId = entry(view)?.conversationId;
    if (!branchId) throw new Error('no branch');

    const other = h.attach();
    other.send({ type: 'conversation.open', conversationId: branchId });
    await until('the branch', () => other.state?.active?.meta.id === branchId);
    const messages = other.active().messages.length;
    sendIn(other, branchId, 'nested');
    await until('a toast', () => other.toasts.length === 1);
    expect(other.toasts).toEqual([{ level: 'warning', text: TEXT.turnRunning }]);
    expect(other.active().messages).toHaveLength(messages);
    expect(storedIds(h)).toHaveLength(2);
    expect(h.controller.runningTurns()).toBe(2);
    expect(problems).toEqual([]);
  });

  it('is an ordinary turn in a conversation where nothing runs', async () => {
    const { h, problems } = await harness({ sequence: [text('answer 1'), text('answer 2')] });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    await sendAndFinish(h, view, 'two');
    expect(view.active().turns).toHaveLength(2);
    expect(view.active().asides).toEqual([]);
    expect(storedIds(h)).toHaveLength(1);
    expect(view.active().meta.aside).toBeUndefined();
    expect(problems).toEqual([]);
  });
});

describe('a side question that cannot be set up', () => {
  it('says so, and leaves no branch, when its branch cannot be created', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, streamedAnswer(['ok'])],
    });
    h.ui.picked = ['src/a.ts'];
    view.send({ type: 'context.pick', what: 'file' });
    await until('the attachment', () => view.current().draftAttachments.length === 1);
    const store = storeOf(h);
    const original = store.fork.bind(store);
    let fail = true;
    store.fork = (input) => {
      if (!fail) return original(input);
      fail = false;
      return Promise.reject(new Error('no space left'));
    };

    sendIn(view, parentId, 'side');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.asideFailed }]);
    expect(storedIds(h)).toEqual([parentId]);
    expect(view.active().asides).toEqual([]);
    expect(view.current().draftAttachments).toEqual([{ kind: 'file', path: 'src/a.ts' }]);
    expect(h.requests).toHaveLength(2);
    expect(Reflect.get(h.controller, 'asking')).toEqual(new Set());
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('is stopped and its branch removed when it cannot be marked, and the next one can start', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, streamedAnswer(['ok'])],
    });
    const store = storeOf(h);
    const original = store.updateMeta.bind(store);
    let fail = true;
    store.updateMeta = (id, patch) => {
      if (!fail || patch.aside?.turnId === undefined) return original(id, patch);
      fail = false;
      return Promise.reject(new Error('no space left'));
    };

    sendIn(view, parentId, 'side');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.asideFailed }]);
    await until('the branch to go', () => storedIds(h).length === 1);
    expect(storedIds(h)).toEqual([parentId]);
    await until('the list', () => view.current().conversations.length === 1);
    expect(h.controller.runningTurns()).toBe(1);
    expect(view.active().asides).toEqual([]);
    expect(view.active().turns[1]?.status).toBe('running');
    expect(Reflect.get(h.controller, 'asking')).toEqual(new Set());

    // A later question is not refused as if one still ran.
    sendIn(view, parentId, 'side again');
    await until('the card', () => entry(view) !== undefined);
    expect(entry(view)?.question).toBe('side again');
    await until('the answer', () => entry(view)?.status === 'completed');
    expect(view.toasts).toHaveLength(1);
    expect(branchesOf(view, parentId)).toHaveLength(1);
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });
});

describe('a side question and its parent’s session', () => {
  it('is never a copy of it and never holds the parent, even when the parent’s turn ends first', async () => {
    const held = gate();
    let holding = false;
    const observer: TurnObserver = {
      beforeTurn: async (context) => {
        if (context.conversation.aside === undefined) return;
        holding = true;
        await held.promise;
      },
    };
    const sideHanging: ScenarioSpec = {
      scenario: { steps: [...streamedText(['thinking']), { hang: true }] },
    };
    const { h, problems } = await harness({
      policy: createPlanTestPolicy(),
      observers: [observer],
      forkAtMessage: 'exact',
      sequence: [
        text('answer 1'),
        slow(1500),
        { scenario: textScenario('queued answer') },
        sideHanging,
        { scenario: textScenario('agent answer') },
      ],
    });
    expect(h.env.settings().exactEarlierForks).toBe(true);
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    const parentId = view.active().meta.id;
    const parentSession = view.active().meta.sessionId;
    // The parent's first turn could be copied exactly.
    expect(view.active().turns[0]?.forkPointEventId).toBeDefined();
    sendIn(view, parentId, 'two');
    await until('the running answer', () => (assistants(view)[1]?.parts.length ?? 0) === 1);

    sendIn(view, parentId, 'side question?');
    await until('the side question to wait before its provider starts', () => holding);
    sendIn(view, parentId, 'queued work', 'agent');
    await until('the queued message', () => view.state?.active?.queued != null);

    // The parent's turn ends while the side question has not started its provider.
    await until('the parent to complete', () => view.active().turns[1]?.status === 'completed');
    await until('the queued message to go out', () => view.active().turns.length === 3);
    expect(view.active().queued).toBeNull();
    await until('the queued turn', () => view.active().turns[2]?.status === 'completed');
    expect(h.requests).toHaveLength(3);

    held.open();
    await until('the side question to start', () => h.requests.length === 4);
    await until('the side answer', () => (entry(view)?.parts.length ?? 0) === 1);
    const request = h.requests[3];
    expect(request?.session.kind).toBe('new');
    expect(request?.session.kind === 'new' && request.session.sessionId).not.toBe(parentSession);
    expect(request?.prompt).toContain('<prior-conversation');
    expect(Reflect.get(h.controller, 'forkHolds')).toEqual(new Map());
    const [branch] = branchesOf(view, parentId);
    expect(branch?.fork).toMatchObject({ exactness: 'reconstructed', lost: [] });

    // Nothing holds the parent: an Agent message starts an ordinary turn at once.
    sendIn(view, parentId, 'agent work', 'agent');
    await until('the agent turn', () => view.active().turns.length === 4);
    expect(view.active().queued).toBeNull();
    await until('the agent answer', () => view.active().turns[3]?.status === 'completed');
    expect(view.toasts).toEqual([]);
    expect(h.requests[4]?.session.kind).toBe('resume');
    expect(entry(view)?.status).toBe('running');

    view.send({ type: 'turn.cancel', conversationId: branch?.id });
    await h.idle();
    expect(problems).toEqual([]);
    view.expectMirror();
  });
});

describe('an Ask message sent while a finished turn wraps up', () => {
  it('waits and goes out as an ordinary Ask turn in the same conversation', async () => {
    const { h, problems } = await harness({ sequence: [text('answer 1'), text('answer 2')] });
    // The run waits for the write of "running" after its turn is final, so it stays in `runs`.
    const store = storeOf(h);
    const original = store.putTurn.bind(store);
    const held = gate();
    let holding = false;
    store.putTurn = (id, turn) => {
      const write = original(id, turn);
      if (holding || turn.status !== 'running') return write;
      holding = true;
      return write.then(() => held.promise);
    };
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'one', mode: 'ask', model: 'default' });
    await until(
      'the first turn to be final',
      () => view.state?.active?.turns[0]?.status === 'completed',
    );
    expect(h.controller.runningTurns()).toBe(1);
    const id = view.active().meta.id;

    sendIn(view, id, 'two');
    await until('the message to be queued', () => view.state?.active?.queued != null);
    expect(view.active().queued).toMatchObject({ text: 'two', mode: 'ask' });
    expect(view.toasts).toEqual([]);
    expect(view.active().asides).toEqual([]);
    expect(storedIds(h)).toEqual([id]);
    expect(h.requests).toHaveLength(1);

    held.open();
    await until('the queued message to go out', () => view.active().turns.length === 2);
    await until('the second turn', () => view.active().turns[1]?.status === 'completed');
    expect(view.active().meta.id).toBe(id);
    expect(view.active().queued).toBeNull();
    expect(view.active().turns[1]?.mode).toBe('ask');
    expect(view.active().messages.flatMap((m) => (m.role === 'user' ? [m.text] : []))).toEqual([
      'one',
      'two',
    ]);
    expect(view.active().asides).toEqual([]);
    expect(storedIds(h)).toEqual([id]);
    expect(h.requests[1]?.session.kind).toBe('resume');
    expect(view.toasts).toEqual([]);
    await h.idle();
    expect(problems).toEqual([]);
    view.expectMirror();
  });
});

describe('the card of a side question', () => {
  it('follows the live branch when the parent is opened again while the question still runs', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, askingAnswer, text('elsewhere')],
    });
    sendIn(view, parentId, 'which file?');
    await until('the prompt', () => (entry(view)?.prompts.length ?? 0) === 1);
    const branchId = entry(view)?.conversationId;
    if (!branchId) throw new Error('no branch');
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await until('the parent to stop', () => view.active().turns[1]?.status === 'interrupted');
    await until('one run left', () => h.controller.runningTurns() === 1);

    // Released from memory: the only view moves to another conversation.
    view.send({ type: 'conversation.new' });
    await until('a draft', () => view.state?.active === null);
    view.send({ type: 'turn.send', text: 'another conversation', mode: 'ask', model: 'default' });
    await until(
      'the other conversation’s turn',
      () => view.state?.active?.turns[0]?.status === 'completed',
    );
    await until('only the side question to run', () => h.controller.runningTurns() === 1);
    expect(internals(h).runtimes.has(parentId)).toBe(false);
    const live = internals(h).runtimes.get(branchId);
    if (!live) throw new Error('the branch is not in memory');

    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => view.state?.active?.meta.id === parentId);
    expect(view.active().asides).toHaveLength(1);
    expect(view.active().asides[0]).toEqual(projectAside(live.data));
    expect(entry(view)?.status).toBe('running');
    expect(entry(view)?.prompts[0]?.state).toBe('pending');
    view.expectMirror();

    const prompt = entry(view)?.prompts[0];
    if (!prompt) throw new Error('no prompt');
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'question', answers: { 'Which file?': ['a.ts'] } },
    });
    await until('the answer', () => entry(view)?.status === 'completed');
    expect(entry(view)?.prompts[0]?.state).toBe('answered');
    expect(entry(view)?.parts.at(-1)).toEqual({ kind: 'text', text: 'it is a.ts' });
    expect(entry(view)).toEqual(await freshProjection(h, branchId));
    await h.idle();
    expect(problems).toEqual([]);
    view.expectMirror();
  });

  it('appears when the question ended before its branch was marked', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, text('quick answer')],
    });
    const store = storeOf(h);
    const original = store.updateMeta.bind(store);
    let delayed = false;
    store.updateMeta = async (id, patch) => {
      if (patch.aside?.turnId !== undefined) {
        delayed = true;
        await until('the side question to end', () => h.controller.runningTurns() === 1);
      }
      return original(id, patch);
    };

    sendIn(view, parentId, 'side');
    await until('the card', () => entry(view) !== undefined);
    expect(delayed).toBe(true);
    expect(entry(view)?.status).toBe('completed');
    expect(entry(view)?.parts).toEqual([{ kind: 'text', text: 'quick answer' }]);
    const branchId = entry(view)?.conversationId;
    if (!branchId) throw new Error('no branch');
    expect(internals(h).runtimes.has(branchId)).toBe(false);
    expect(h.controller.runningTurns()).toBe(1);
    expect(entry(view)).toEqual(await freshProjection(h, branchId));
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
    view.expectMirror();
  });
});

describe('the plan of a side question', () => {
  const PLAN_INPUT = {
    title: 'Add caching',
    objective: 'Cache the results of slow lookups.',
    stages: [{ id: 's1', title: 'Write the cache', description: 'Implement it.' }],
  };
  /** A Plan mode turn that saves PLAN_INPUT. */
  const submitPlan: ScenarioSpec = {
    scenario: {
      steps: [
        stateEvent('running'),
        initEvent(),
        { callTool: { name: 'submit_plan', arguments: PLAN_INPUT, saveAs: 'result' } },
        assistantText('The plan covers it.'),
        ...resultStep('The plan covers it.'),
      ],
    },
  };

  /** A parent with a saved plan and a running Ask turn after it. */
  async function plannedParent(sequence: ScenarioSpec[]) {
    const { h, problems } = await harness({
      policy: createPlanTestPolicy(),
      sequence: [submitPlan, hanging, ...sequence],
    });
    const view = h.attach();
    await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    const parentId = view.active().meta.id;
    const parentPlanId = view.active().meta.planId;
    if (parentPlanId === undefined) throw new Error('no plan');
    sendIn(view, parentId, 'two');
    await until('the running answer', () => (assistants(view)[1]?.parts.length ?? 0) === 1);
    const plans = createPlanStore({ dir: join(h.storage, 'plans') });
    const before = await plans.get(parentPlanId);
    if (!before) throw new Error('no stored plan');
    return { h, problems, view, parentId, parentPlanId, plans, before };
  }

  it('is a copy in its branch, read-only in its prompt; answers go to the copy, the parent’s plan never changes', async () => {
    const { h, problems, view, parentId, parentPlanId, plans, before } = await plannedParent([
      askingAnswer,
    ]);
    const shownBefore = structuredClone(view.active().plan);

    sendIn(view, parentId, 'which file?');
    await until('the prompt', () => (entry(view)?.prompts.length ?? 0) === 1);
    const branchId = entry(view)?.conversationId;
    if (!branchId) throw new Error('no branch');
    const branchPlanId = storeOf(h)
      .list()
      .find((meta) => meta.id === branchId)?.planId;
    if (branchPlanId === undefined) throw new Error('the branch has no plan');
    expect(branchPlanId).not.toBe(parentPlanId);
    const copy = await plans.get(branchPlanId);
    if (!copy) throw new Error('no stored copy');
    expect(copy.conversationId).toBe(branchId);
    expect(copy.versions).toEqual(before.versions);
    expect(h.requests[2]?.prompt).toContain(renderPlanBlock(copy, { locked: true }));
    expect(h.requests[2]?.prompt).toContain('This is Ask mode.');

    const prompt = entry(view)?.prompts[0];
    if (!prompt) throw new Error('no prompt');
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'question', answers: { 'Which file?': ['a.ts'] } },
    });
    await until('the answer', () => entry(view)?.status === 'completed');
    await until('the side question to end', () => h.controller.runningTurns() === 1);

    const copyAfter = await plans.get(branchPlanId);
    expect(copyAfter?.decisions).toEqual([
      expect.objectContaining({
        kind: 'interactive-question',
        targetId: 'Which file?',
        values: ['a.ts'],
      }),
    ]);
    expect(await plans.get(parentPlanId)).toEqual(before);
    expect(view.active().plan).toEqual(shownBefore);
    expect(view.active().meta.planId).toBe(parentPlanId);

    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(await plans.get(parentPlanId)).toEqual(before);
    expect(problems).toEqual([]);
    view.expectMirror();
  });

  it('is not made when the parent has none, and the side question still runs', async () => {
    const { h, problems, view, parentId } = await runningParent({
      sequence: [text('answer 1'), hanging, streamedAnswer(['ok'])],
    });
    sendIn(view, parentId, 'side');
    await until('the answer', () => entry(view)?.status === 'completed');
    const branchId = entry(view)?.conversationId;
    expect(
      storeOf(h)
        .list()
        .find((meta) => meta.id === branchId)?.planId,
    ).toBeUndefined();
    expect(h.requests[2]?.prompt).not.toContain('<current-plan');
    const files = await fs.readdir(join(h.storage, 'plans')).catch(() => []);
    expect(files).toEqual([]);
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('that cannot be copied stops the side question from starting', async () => {
    const { h, problems, view, parentId, parentPlanId, plans, before } = await plannedParent([
      streamedAnswer(['never']),
    ]);
    const live = Reflect.get(h.controller, 'plans') as PlanStore;
    live.copy = () => Promise.reject(new Error('no space left'));

    sendIn(view, parentId, 'side');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.asideFailed }]);
    await until('the branch to go', () => storedIds(h).length === 1);
    expect(storedIds(h)).toEqual([parentId]);
    expect(view.active().asides).toEqual([]);
    expect(h.requests).toHaveLength(2);
    expect(h.controller.runningTurns()).toBe(1);
    expect(Reflect.get(h.controller, 'asking')).toEqual(new Set());
    expect(await plans.get(parentPlanId)).toEqual(before);
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('is removed again when it cannot be recorded on the branch', async () => {
    const { h, problems, view, parentId, parentPlanId, plans, before } = await plannedParent([
      streamedAnswer(['never']),
    ]);
    const store = storeOf(h);
    const original = store.updateMeta.bind(store);
    let copyWritten = false;
    store.updateMeta = async (id, patch) => {
      if (id === parentId || patch.planId === undefined) return original(id, patch);
      copyWritten = (await plans.get(patch.planId)) !== undefined;
      throw new Error('no space left');
    };

    sendIn(view, parentId, 'side');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.asideFailed }]);
    expect(copyWritten).toBe(true);
    await until('the branch to go', () => storedIds(h).length === 1);
    expect(storedIds(h)).toEqual([parentId]);
    expect(await fs.readdir(join(h.storage, 'plans'))).toEqual([`${parentPlanId}.json`]);
    expect(await plans.get(parentPlanId)).toEqual(before);
    expect(h.requests).toHaveLength(2);
    expect(h.controller.runningTurns()).toBe(1);
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });

  it('goes with an unused side question even when its branch cannot be deleted', async () => {
    const { h, problems, view, parentId, parentPlanId, plans, before } = await plannedParent([
      streamedAnswer(['never']),
    ]);
    const store = storeOf(h);
    const originalUpdate = store.updateMeta.bind(store);
    store.updateMeta = (id, patch) =>
      patch.aside?.turnId !== undefined
        ? Promise.reject(new Error('no space left'))
        : originalUpdate(id, patch);
    let deleteRefused = false;
    store.delete = () => {
      deleteRefused = true;
      return Promise.reject(new Error('locked'));
    };

    sendIn(view, parentId, 'side');
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts).toEqual([{ level: 'warning', text: TEXT.asideFailed }]);
    await until('the delete to be tried', () => deleteRefused);
    await until('the plan copy to go', () => readdirSync(join(h.storage, 'plans')).length === 1);
    expect(await fs.readdir(join(h.storage, 'plans'))).toEqual([`${parentPlanId}.json`]);
    expect(await plans.get(parentPlanId)).toEqual(before);
    expect(view.active().meta.planId).toBe(parentPlanId);
    expect(h.controller.runningTurns()).toBe(1);
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await h.idle();
    expect(problems).toEqual([]);
  });
});
