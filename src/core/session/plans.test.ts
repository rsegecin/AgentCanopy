import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import type { AssistantMessage, ConversationId, PlanDoc, Prompt } from '../../shared';
import type { TurnPolicy, TurnRequest } from '../contracts';
import type * as PlansModule from '../plans';
import { BUSY_MESSAGE } from '../workspace/tracker/tracker';
import { createConversationStore } from '../conversations/store';
import type { ConversationStore } from '../conversations/store';
import {
  createPlanStore,
  renderExecutionPrompt,
  renderPlanBlock,
  renderPlanMarkdown,
} from '../plans';
import {
  assistantText,
  assistantToolUse,
  createHarness,
  createPlanTestPolicy,
  finishedTurn,
  imageReference,
  pasteImageMessage,
  pngBytes,
  resultStep,
  sendAndFinish,
  sleep,
  stateEvent,
  streamedText,
  textScenario,
  until,
  userToolResult,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type TestView,
} from './test-support';

/** Lets a test hold back the plan store's `approve`, to show that nothing starts before it resolves. */
const control = vi.hoisted(() => ({
  holdApprove: undefined as Promise<void> | undefined,
  approveCalls: 0,
  /** Question texts the plan store refuses to record as decisions. */
  failDecide: [] as string[],
  /** Every decision the plan store was asked to record, in order. */
  decideCalls: [] as { targetId: string; values: string[] }[],
}));

vi.mock('../plans', async (importOriginal) => {
  const actual = await importOriginal<typeof PlansModule>();
  return {
    ...actual,
    createPlanStore: (options: Parameters<typeof actual.createPlanStore>[0]) => {
      const real = actual.createPlanStore(options);
      return {
        ...real,
        approve: async (...args: Parameters<typeof real.approve>) => {
          control.approveCalls += 1;
          if (control.holdApprove) await control.holdApprove;
          return real.approve(...args);
        },
        decide: (...args: Parameters<typeof real.decide>) => {
          const [, decision] = args;
          control.decideCalls.push({ targetId: decision.targetId, values: decision.values });
          if (control.failDecide.includes(decision.targetId)) {
            return Promise.reject(new Error('the decision was refused'));
          }
          return real.decide(...args);
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
  control.holdApprove = undefined;
  control.approveCalls = 0;
  control.failDecide = [];
  control.decideCalls = [];
  for (const h of harnesses.splice(0)) await h.dispose();
});

// ---- fixtures ----------------------------------------------------------------------------------

/** A plan with one decision point and one open question, so two things are unanswered. */
const PLAN = {
  title: 'Add caching',
  objective: 'Cache the results of slow lookups.',
  stages: [
    { id: 's1', title: 'Write the cache', description: 'Implement it.' },
    { id: 's2', title: 'Use the cache', description: 'Wire it in.', dependsOn: ['s1'] },
  ],
  decisionPoints: [
    {
      id: 'd1',
      question: 'Which store?',
      options: [
        { id: 'mem', label: 'Memory' },
        { id: 'disk', label: 'Disk' },
      ],
    },
  ],
  openQuestions: [{ id: 'q1', question: 'How big may it grow?', kind: 'text' }],
};

/** The same idea with nothing left to answer. */
const SIMPLE = {
  title: 'Rename things',
  objective: 'Rename the helpers.',
  stages: [{ id: 's1', title: 'Rename', description: 'Do it.' }],
};

const SECOND = { ...SIMPLE, title: 'Rename things, second try', changeSummary: 'A new title.' };

const SAVED_TEXT =
  'Plan saved as version 1. The user reviews it in the plan card in the chat. Do not repeat the plan in chat: ' +
  'say in two or three sentences what it covers, or what changed.';

/** A turn in which the model calls submit_plan and notes what the tool answered. */
function submitScenario(input: object, file = 'tool-result.txt'): ScenarioSpec {
  return {
    record: true,
    scenario: {
      steps: [
        stateEvent('running'),
        initEvent(),
        { callTool: { name: 'submit_plan', arguments: input, saveAs: 'result' } },
        { writeFile: { path: file, content: '$SAVED.result' } },
        assistantText('The plan covers it.'),
        ...resultStep('The plan covers it.'),
      ],
    },
  };
}

function textSpec(text = 'an answer'): ScenarioSpec {
  return { record: true, scenario: textScenario(text) };
}

const hanging: ScenarioSpec = {
  record: true,
  scenario: { steps: [...streamedText(['working']), { hang: true }] },
};

async function planHarness(sequence: ScenarioSpec[], extra: HarnessOptions = {}): Promise<Harness> {
  return harness({ policy: createPlanTestPolicy(), sequence, ...extra });
}

function send(view: TestView, text: string, mode: 'ask' | 'plan' | 'agent' = 'plan'): void {
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode,
    model: 'default',
  });
}

function planOf(view: TestView): PlanDoc {
  const { plan } = view.active();
  if (!plan) throw new Error('the conversation has no plan');
  return plan;
}

function planStoreOf(h: Harness) {
  return createPlanStore({ dir: join(h.storage, 'plans') });
}

function assistants(view: TestView): AssistantMessage[] {
  return view.active().messages.filter((m): m is AssistantMessage => m.role === 'assistant');
}

function noticesOf(message: AssistantMessage | undefined): string[] {
  return (message?.parts ?? []).flatMap((part) => (part.kind === 'notice' ? [part.text] : []));
}

const NO_PLAN_NOTICE =
  'No plan was saved in this turn. Ask for the plan again, or switch to Ask mode if you only wanted an answer.';

/** Starts with a Plan mode turn that saves PLAN (or another input), and waits for it to end. */
async function withPlan(
  more: ScenarioSpec[] = [],
  options: { input?: object; extra?: HarnessOptions } = {},
): Promise<{ h: Harness; view: TestView; plan: PlanDoc }> {
  const h = await planHarness([submitScenario(options.input ?? PLAN), ...more], options.extra);
  const view = h.attach();
  await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
  return { h, view, plan: planOf(view) };
}

async function nextTurn(
  h: Harness,
  view: TestView,
  text: string,
  mode: 'ask' | 'plan' | 'agent' = 'plan',
) {
  return sendAndFinish(h, view, text, { mode });
}

async function openConversation(view: TestView, id: ConversationId): Promise<void> {
  view.send({ type: 'conversation.open', conversationId: id });
  await until('the conversation to open', () => view.state?.active?.meta.id === id);
}

// ---- the plan tool ---------------------------------------------------------------------------------

describe('the plan tool', () => {
  it('saves a plan from a Plan mode turn and shows it in every view of the conversation', async () => {
    const h = await planHarness([submitScenario(PLAN)]);
    const a = h.attach();
    const b = h.attach();
    send(a, 'plan it');
    await until('the conversation', () => a.state?.active !== null);
    await openConversation(b, a.active().meta.id);
    const turn = await finishedTurn(h, a);
    expect(turn.status).toBe('completed');
    await until(
      'the second view to settle',
      () => b.state?.active?.turns[0]?.status === 'completed',
    );

    const plan = planOf(a);
    expect(plan.versions).toHaveLength(1);
    expect(plan.versions[0]?.content.title).toBe('Add caching');
    expect(plan.conversationId).toBe(a.active().meta.id);
    expect(a.active().meta.planId).toBe(plan.id);
    expect(b.active().plan).toEqual(plan);
    expect(b.active().meta.planId).toBe(plan.id);
    expect(await planStoreOf(h).get(plan.id)).toEqual(plan);

    const [message] = assistants(a);
    expect(message?.parts.filter((part) => part.kind === 'plan-update')).toEqual([
      { kind: 'plan-update', planId: plan.id, version: 1 },
    ]);
    expect(await fs.readFile(join(h.workspace, 'tool-result.txt'), 'utf8')).toBe(SAVED_TEXT);
    expect(noticesOf(message)).toEqual([]);

    // The plan is loaded again when the conversation is opened later.
    const c = h.attach();
    await openConversation(c, a.active().meta.id);
    expect(c.active().plan).toEqual(plan);
    a.expectMirror();
    b.expectMirror();
    c.expectMirror();
  });

  it('answers an invalid plan with an error and saves nothing', async () => {
    const h = await planHarness([submitScenario({ title: '' })]);
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    expect(turn.status).toBe('completed');
    expect(view.active().plan).toBeNull();
    expect(view.active().meta.planId).toBeUndefined();
    const answer = await fs.readFile(join(h.workspace, 'tool-result.txt'), 'utf8');
    expect(answer.length).toBeGreaterThan(0);
    expect(answer).not.toContain('Plan saved');
    const [message] = assistants(view);
    expect(message?.parts.some((part) => part.kind === 'plan-update')).toBe(false);
    // The model did call the tool, so nobody says that no plan was saved.
    expect(noticesOf(message)).toEqual([]);
    expect(await fs.readdir(join(h.storage, 'plans'))).toEqual([]);
    view.expectMirror();
  });

  it('adds no version and no card when the same plan is submitted again', async () => {
    const h = await planHarness([submitScenario(PLAN), submitScenario(PLAN, 'second-result.txt')]);
    const view = h.attach();
    await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    const first = planOf(view);
    await nextTurn(h, view, 'plan it again');
    expect(planOf(view)).toEqual(first);
    expect(planOf(view).versions).toHaveLength(1);
    expect(await fs.readFile(join(h.workspace, 'second-result.txt'), 'utf8')).toBe(
      'The plan is identical to version 1, so nothing was saved.',
    );
    const updates = assistants(view).flatMap((message) =>
      message.parts.filter((part) => part.kind === 'plan-update'),
    );
    expect(updates).toHaveLength(1);
    view.expectMirror();
  });

  it('adds a new version and a card when the plan changes', async () => {
    const { h, view } = await withPlan([submitScenario(SECOND, 'second-result.txt')]);
    await nextTurn(h, view, 'change the title');
    expect(planOf(view).versions.map((version) => version.version)).toEqual([1, 2]);
    expect(await fs.readFile(join(h.workspace, 'second-result.txt'), 'utf8')).toContain(
      'Plan saved as version 2.',
    );
    expect(
      assistants(view).flatMap((message) =>
        message.parts.flatMap((part) => (part.kind === 'plan-update' ? [part.version] : [])),
      ),
    ).toEqual([1, 2]);
    view.expectMirror();
  });

  it('is not offered when the plan is locked', async () => {
    const { h, view, plan } = await withPlan([submitScenario(SECOND, 'second-result.txt')]);
    view.send({ type: 'plan.setLocked', conversationId: view.active().meta.id, locked: true });
    await until('the lock', () => view.active().meta.planLocked);
    const turn = await nextTurn(h, view, 'change the title');
    // The server has no such tool for this turn, so the call fails and the fake CLI gives up.
    expect(turn.status).toBe('error');
    expect(h.requests[1]?.host.planToolName).toBeUndefined();
    expect(h.requests[0]?.host.planToolName).toBe('submit_plan');
    expect(planOf(view)).toEqual(plan);
    await expect(fs.access(join(h.workspace, 'second-result.txt'))).rejects.toThrow();
    view.expectMirror();
  });
});

// ---- the prompt ----------------------------------------------------------------------------------------

describe('the plan in the prompt', () => {
  it('reaches the provider in Plan mode, unlocked and locked, and in Ask mode as read-only', async () => {
    const { h, view, plan } = await withPlan([textSpec(), textSpec(), textSpec()]);
    // Not in the first turn: there was no plan yet.
    expect((await h.record(0)).stdin).not.toContain('<current-plan');

    await nextTurn(h, view, 'why stage 2?');
    const unlocked = (await h.record(1)).stdin;
    expect(unlocked).toContain(renderPlanBlock(plan, { locked: false }));
    expect(unlocked).toContain('Then produce or revise the plan by calling the `submit_plan` tool');

    view.send({ type: 'plan.setLocked', conversationId: view.active().meta.id, locked: true });
    await until('the lock', () => view.active().meta.planLocked);
    await nextTurn(h, view, 'why stage 2, again?');
    const locked = (await h.record(2)).stdin;
    expect(locked).toContain(renderPlanBlock(plan, { locked: true }));
    expect(locked).toContain('The plan is locked for this turn');

    await nextTurn(h, view, 'just a question', 'ask');
    const ask = (await h.record(3)).stdin;
    expect(ask).toContain(renderPlanBlock(plan, { locked: true }));
    expect(ask).toContain('This is Ask mode.');
    view.expectMirror();
  });
});

// ---- questions as decisions ---------------------------------------------------------------------------

const QUESTIONS = [
  {
    question: 'Which colour?',
    header: 'Colour',
    options: [
      { label: 'Red', description: 'Warm' },
      { label: 'Blue', description: 'Cool' },
    ],
    multiSelect: true,
  },
];

function questionSpec(): ScenarioSpec {
  return {
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
            onDeny: [],
          },
        },
        assistantText('thanks'),
        ...resultStep('thanks'),
      ],
    },
  };
}

async function answerQuestion(h: Harness, view: TestView): Promise<void> {
  const find = (): Prompt | undefined =>
    view.state?.active?.prompts.find((prompt) => prompt.state === 'pending');
  await until('a pending prompt', () => find() !== undefined);
  const prompt = find();
  if (!prompt) throw new Error('no prompt');
  view.send({
    type: 'prompt.answer',
    promptId: prompt.id,
    displayHash: prompt.displayHash,
    answer: { kind: 'question', answers: { 'Which colour?': ['Red', 'Blue'] } },
  });
  await finishedTurn(h, view);
}

describe('interactive questions', () => {
  it('are recorded as decisions of the plan when the conversation has one', async () => {
    const { h, view, plan } = await withPlan([questionSpec()]);
    send(view, 'ask me something');
    await answerQuestion(h, view);
    const decisions = planOf(view).decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: 'interactive-question',
      targetId: 'Which colour?',
      values: ['Red', 'Blue'],
    });
    expect((await planStoreOf(h).get(plan.id))?.decisions).toEqual(decisions);
    view.expectMirror();
  });

  it('are not recorded when there is no plan', async () => {
    const h = await planHarness([questionSpec()]);
    const view = h.attach();
    send(view, 'ask me something', 'ask');
    await answerQuestion(h, view);
    expect(view.active().plan).toBeNull();
    expect(view.active().meta.planId).toBeUndefined();
    expect(await fs.readdir(join(h.storage, 'plans'))).toEqual([]);
    view.expectMirror();
  });
});

const SIZE_QUESTIONS = [
  {
    question: 'Which size?',
    header: 'Size',
    options: [
      { label: 'Small', description: 'Few' },
      { label: 'Large', description: 'Many' },
    ],
    multiSelect: false,
  },
];

/** The steps of one AskUserQuestion call that the user answers. */
function askSteps(id: string, questions: object[]): object[] {
  return [
    assistantToolUse(id, 'AskUserQuestion', { questions }),
    {
      permission: {
        toolName: 'AskUserQuestion',
        input: { questions },
        toolUseId: id,
        onAllow: [
          userToolResult(id, 'answered', {
            decision: { decision: 'accept', source: 'user_temporary' },
          }),
        ],
        onDeny: [],
      },
    },
  ];
}

const submitStep = (input: object, saveAs: string) => ({
  callTool: { name: 'submit_plan', arguments: input, saveAs },
});

/** A turn with the given steps between the start and a closing result. */
function stepsSpec(steps: object[]): ScenarioSpec {
  return {
    record: true,
    scenario: {
      steps: [stateEvent('running'), initEvent(), ...steps, ...resultStep('done')],
    },
  };
}

async function answerPending(view: TestView, answers: Record<string, string[]>): Promise<void> {
  const find = (): Prompt | undefined =>
    view.state?.active?.prompts.find((prompt) => prompt.state === 'pending');
  await until('a pending prompt', () => find() !== undefined);
  const prompt = find();
  if (!prompt) throw new Error('no prompt');
  view.send({
    type: 'prompt.answer',
    promptId: prompt.id,
    displayHash: prompt.displayHash,
    answer: { kind: 'question', answers },
  });
  await until('the prompt to settle', () => find()?.id !== prompt.id);
}

/** Remembers the plan the view showed when the first plan-update part appeared. */
function watchPlanCard(view: TestView): { planAtCard: () => PlanDoc | null | undefined } {
  let seen: PlanDoc | null | undefined;
  let found = false;
  const post = view.post.bind(view);
  view.post = (message) => {
    post(message);
    if (found) return;
    const parts = view.state?.active?.messages.flatMap((m) =>
      m.role === 'assistant' ? m.parts : [],
    );
    if (parts?.some((part) => part.kind === 'plan-update')) {
      found = true;
      seen = structuredClone(view.state?.active?.plan);
    }
  };
  return { planAtCard: () => seen };
}

describe('interactive questions answered before the first plan', () => {
  it('become decisions of the plan once it is saved, already shown with the plan card', async () => {
    const h = await planHarness([
      stepsSpec([
        ...askSteps('toolu_q', QUESTIONS),
        submitStep(PLAN, 'result'),
        assistantText('The plan covers it.'),
      ]),
    ]);
    const view = h.attach();
    const card = watchPlanCard(view);
    send(view, 'plan it');
    await answerPending(view, { 'Which colour?': ['Red', 'Blue'] });
    await finishedTurn(h, view);

    const decisions = planOf(view).decisions;
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      kind: 'interactive-question',
      targetId: 'Which colour?',
      values: ['Red', 'Blue'],
      planVersion: 1,
    });
    expect((await planStoreOf(h).get(planOf(view).id))?.decisions).toEqual(decisions);
    expect(card.planAtCard()?.decisions).toEqual(decisions);
    expect(control.decideCalls).toEqual([{ targetId: 'Which colour?', values: ['Red', 'Blue'] }]);
    view.expectMirror();
  });

  it('are all recorded, in the order they were answered', async () => {
    const h = await planHarness([
      stepsSpec([
        ...askSteps('toolu_q1', SIZE_QUESTIONS),
        ...askSteps('toolu_q2', QUESTIONS),
        submitStep(PLAN, 'result'),
      ]),
    ]);
    const view = h.attach();
    const card = watchPlanCard(view);
    send(view, 'plan it');
    await answerPending(view, { 'Which size?': ['Large'] });
    await answerPending(view, { 'Which colour?': ['Red'] });
    await finishedTurn(h, view);

    expect(control.decideCalls.map((call) => call.targetId)).toEqual([
      'Which size?',
      'Which colour?',
    ]);
    expect(planOf(view).decisions.map((d) => [d.targetId, d.values])).toEqual([
      ['Which size?', ['Large']],
      ['Which colour?', ['Red']],
    ]);
    expect(card.planAtCard()?.decisions).toHaveLength(2);
    view.expectMirror();
  });

  it('are not recorded when they were answered in an Ask turn and the plan comes later', async () => {
    const h = await planHarness([questionSpec(), submitScenario(PLAN)]);
    const view = h.attach();
    send(view, 'ask me something', 'ask');
    await answerQuestion(h, view);
    await nextTurn(h, view, 'plan it');
    expect(planOf(view).versions).toHaveLength(1);
    expect(planOf(view).decisions).toEqual([]);
    expect(control.decideCalls).toEqual([]);
    view.expectMirror();
  });

  it('are recorded once when a failed submit is followed by a good one in the same turn', async () => {
    const h = await planHarness([
      stepsSpec([
        ...askSteps('toolu_q', QUESTIONS),
        submitStep({ title: '' }, 'first'),
        submitStep(PLAN, 'second'),
      ]),
    ]);
    const view = h.attach();
    send(view, 'plan it');
    await answerPending(view, { 'Which colour?': ['Red'] });
    await finishedTurn(h, view);
    expect(control.decideCalls).toEqual([{ targetId: 'Which colour?', values: ['Red'] }]);
    expect(planOf(view).decisions.map((d) => d.targetId)).toEqual(['Which colour?']);
    view.expectMirror();
  });

  it('are dropped when the turn ends without a saved plan', async () => {
    const h = await planHarness([
      stepsSpec([...askSteps('toolu_q', QUESTIONS), submitStep({ title: '' }, 'first')]),
      submitScenario(PLAN),
    ]);
    const view = h.attach();
    send(view, 'plan it');
    await answerPending(view, { 'Which colour?': ['Red'] });
    await finishedTurn(h, view);
    expect(view.active().plan).toBeNull();
    expect(control.decideCalls).toEqual([]);

    await nextTurn(h, view, 'plan it again');
    expect(planOf(view).decisions).toEqual([]);
    expect(control.decideCalls).toEqual([]);
  });

  it('log a decision that cannot be recorded, keep the others and still save the plan', async () => {
    control.failDecide = ['Which size?'];
    const h = await planHarness([
      stepsSpec([
        ...askSteps('toolu_q1', SIZE_QUESTIONS),
        ...askSteps('toolu_q2', QUESTIONS),
        submitStep(PLAN, 'result'),
      ]),
    ]);
    const view = h.attach();
    send(view, 'plan it');
    await answerPending(view, { 'Which size?': ['Large'] });
    await answerPending(view, { 'Which colour?': ['Red'] });
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(planOf(view).versions).toHaveLength(1);
    expect(planOf(view).decisions.map((d) => d.targetId)).toEqual(['Which colour?']);
    expect(
      h.logger.entries.some(
        (entry) =>
          entry.level === 'warn' &&
          entry.message === 'an answer could not be recorded as a plan decision',
      ),
    ).toBe(true);
    view.expectMirror();
  });

  it('are recorded at once when the plan was saved earlier in the same turn', async () => {
    const h = await planHarness([
      stepsSpec([submitStep(PLAN, 'result'), ...askSteps('toolu_q', QUESTIONS)]),
    ]);
    const view = h.attach();
    send(view, 'plan it');
    await answerPending(view, { 'Which colour?': ['Blue'] });
    await finishedTurn(h, view);
    expect(planOf(view).decisions.map((d) => [d.targetId, d.values])).toEqual([
      ['Which colour?', ['Blue']],
    ]);
    expect(control.decideCalls).toHaveLength(1);
    view.expectMirror();
  });
});

// ---- the notice --------------------------------------------------------------------------------------------

describe('a Plan mode turn that saved no plan', () => {
  it('says so', async () => {
    const h = await planHarness([textSpec('Here is what I think.')]);
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'what would you do?', { mode: 'plan' });
    expect(turn.status).toBe('completed');
    expect(noticesOf(assistants(view)[0])).toEqual([NO_PLAN_NOTICE]);
    expect(assistants(view)[0]?.parts.find((part) => part.kind === 'notice')).toMatchObject({
      level: 'info',
    });
    view.expectMirror();
  });

  it('stays quiet after a submit, in Ask mode and for a locked plan', async () => {
    const h = await planHarness([submitScenario(PLAN), textSpec(), textSpec()]);
    const view = h.attach();
    await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    expect(noticesOf(assistants(view)[0])).toEqual([]);

    // The conversation has a plan now, so a plain answer is fine.
    await nextTurn(h, view, 'why stage 2?');
    expect(noticesOf(assistants(view)[1])).toEqual([]);

    await nextTurn(h, view, 'just a question', 'ask');
    expect(noticesOf(assistants(view)[2])).toEqual([]);
    view.expectMirror();
  });

  it('stays quiet in Ask mode and when the plan tool is not offered', async () => {
    const h = await planHarness([textSpec(), textSpec()]);
    const view = h.attach();
    await sendAndFinish(h, view, 'an Ask question', { mode: 'ask' });
    expect(noticesOf(assistants(view)[0])).toEqual([]);
    view.send({ type: 'plan.setLocked', conversationId: view.active().meta.id, locked: true });
    await until('the lock', () => view.active().meta.planLocked);
    await nextTurn(h, view, 'plan something');
    expect(noticesOf(assistants(view)[1])).toEqual([]);
    expect(h.requests[1]?.host.planToolName).toBeUndefined();
    view.expectMirror();
  });
});

// ---- messages about the plan ---------------------------------------------------------------------------

describe('plan messages', () => {
  it('plan.decide records an answer and shows it in every view; a bad answer gets a toast', async () => {
    const { h, view, plan } = await withPlan();
    const other = h.attach();
    await openConversation(other, view.active().meta.id);

    view.send({
      type: 'plan.decide',
      planId: plan.id,
      targetId: 'd1',
      kind: 'decision-point',
      values: ['disk'],
    });
    await until('the decision', () => planOf(other).decisions.length === 1);
    expect(planOf(view)).toEqual(planOf(other));
    expect(planOf(view).decisions[0]).toMatchObject({
      targetId: 'd1',
      kind: 'decision-point',
      values: ['disk'],
    });
    expect((await planStoreOf(h).get(plan.id))?.decisions).toHaveLength(1);

    view.send({
      type: 'plan.decide',
      planId: plan.id,
      targetId: 'd1',
      kind: 'decision-point',
      values: ['tape'],
    });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.level).toBe('warning');
    expect(view.toasts[0]?.text).toBe(
      'That answer could not be saved. The plan may have changed; review it and try again.',
    );
    expect(planOf(view).decisions).toHaveLength(1);

    view.send({
      type: 'plan.decide',
      planId: 'plan-that-is-gone',
      targetId: 'd1',
      kind: 'decision-point',
      values: ['mem'],
    });
    await until('a second toast', () => view.toasts.length === 2);
    expect(view.toasts[1]?.text).toBe('That plan no longer exists.');
    view.expectMirror();
    other.expectMirror();
  });

  it('plan.revert adds a copy of an earlier version, and waits while a turn runs', async () => {
    const { h, view, plan } = await withPlan([
      submitScenario(SECOND, 'second-result.txt'),
      hanging,
    ]);
    await nextTurn(h, view, 'change it');
    expect(planOf(view).versions).toHaveLength(2);

    view.send({ type: 'plan.revert', planId: plan.id, version: 1 });
    await until('the revert', () => planOf(view).versions.length === 3);
    const latest = planOf(view).versions[2];
    expect(latest).toMatchObject({ version: 3, author: 'user', restoredFrom: 1 });
    expect(latest?.content).toEqual(plan.versions[0]?.content);
    expect((await planStoreOf(h).get(plan.id))?.versions).toHaveLength(3);

    send(view, 'keep working');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    view.send({ type: 'plan.revert', planId: plan.id, version: 2 });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('Wait for the current turn to finish before changing this.');
    expect(planOf(view).versions).toHaveLength(3);

    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await finishedTurn(h, view);
    view.send({ type: 'plan.revert', planId: plan.id, version: 99 });
    await until('a second toast', () => view.toasts.length === 2);
    expect(view.toasts[1]?.text).toBe('That version of the plan could not be restored.');
    view.expectMirror();
  });

  it('plan.setLocked changes the lock, and is refused while a turn runs', async () => {
    const h = await planHarness([hanging]);
    const view = h.attach();
    send(view, 'start');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    const id = view.active().meta.id;
    view.send({ type: 'plan.setLocked', conversationId: id, locked: true });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('Wait for the current turn to finish before changing this.');
    expect(view.active().meta.planLocked).toBe(false);

    view.send({ type: 'turn.cancel', conversationId: id });
    await finishedTurn(h, view);
    view.send({ type: 'plan.setLocked', conversationId: id, locked: true });
    await until('the lock', () => view.active().meta.planLocked);
    view.send({ type: 'plan.setLocked', conversationId: id, locked: false });
    await until('the unlock', () => !view.active().meta.planLocked);
    view.expectMirror();
  });

  it('plan.compare opens the diff of two versions; a missing version gets a toast', async () => {
    const { h, view, plan } = await withPlan([submitScenario(SECOND, 'second-result.txt')]);
    await nextTurn(h, view, 'change it');
    const [first, second] = planOf(view).versions;
    if (!first || !second) throw new Error('two versions expected');

    view.send({ type: 'plan.compare', planId: plan.id, left: 1, right: 2 });
    await until('the diff', () => h.ui.callsOf('showDiff').length === 1);
    expect(h.ui.callsOf('showDiff')[0]?.[0]).toEqual({
      title: 'Rename things, second try: version 1 ↔ version 2',
      leftLabel: 'Version 1',
      leftText: renderPlanMarkdown(first.content),
      rightLabel: 'Version 2',
      rightText: renderPlanMarkdown(second.content),
    });

    view.send({ type: 'plan.compare', planId: plan.id, left: 1, right: 7 });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('That version of the plan no longer exists.');
    expect(h.ui.callsOf('showDiff')).toHaveLength(1);
    view.expectMirror();
  });

  it('plan.open opens one version as a read-only document, beside the chat in a panel', async () => {
    const { h, view, plan } = await withPlan([submitScenario(SECOND, 'second-result.txt')]);
    await nextTurn(h, view, 'change it');
    const [first, second] = planOf(view).versions;
    if (!first || !second) throw new Error('two versions expected');
    const panel = h.attach({ kind: 'panel' });

    view.send({ type: 'plan.open', planId: plan.id, version: 1 });
    await until('the document', () => h.ui.callsOf('showReadOnlyDocument').length === 1);
    const opened = h.ui.callsOf('showReadOnlyDocument')[0]?.[0] as { beside?: boolean };
    expect(opened).toMatchObject({
      key: `plan-${plan.id}-v1`,
      title: 'Plan v1 - Add caching',
      text: renderPlanMarkdown(first.content),
    });
    expect(opened.beside).toBeFalsy();

    panel.send({ type: 'plan.open', planId: plan.id, version: 2 });
    await until('the second document', () => h.ui.callsOf('showReadOnlyDocument').length === 2);
    expect(h.ui.callsOf('showReadOnlyDocument')[1]?.[0]).toEqual({
      key: `plan-${plan.id}-v2`,
      title: 'Plan v2 - Rename things, second try',
      text: renderPlanMarkdown(second.content),
      beside: true,
    });
    expect(view.toasts).toEqual([]);
  });

  it('plan.open puts the version first in the title, so a long plan title cannot hide it', async () => {
    const long = 'L'.repeat(300);
    const { h, view, plan } = await withPlan([], { input: { ...SIMPLE, title: long } });
    view.send({ type: 'plan.open', planId: plan.id, version: 1 });
    await until('the document', () => h.ui.callsOf('showReadOnlyDocument').length === 1);
    const opened = h.ui.callsOf('showReadOnlyDocument')[0]?.[0] as { title: string };
    expect(opened.title.startsWith('Plan v1 - ')).toBe(true);
  });

  it('plan.open with an unknown version or plan gets a toast and opens nothing', async () => {
    const { h, view, plan } = await withPlan();
    view.send({ type: 'plan.open', planId: plan.id, version: 7 });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('That version of the plan no longer exists.');
    view.send({ type: 'plan.open', planId: 'plan-that-is-gone', version: 1 });
    await until('a second toast', () => view.toasts.length === 2);
    expect(view.toasts[1]?.text).toBe('That plan no longer exists.');
    expect(h.ui.callsOf('showReadOnlyDocument')).toEqual([]);
  });
});

// ---- approval --------------------------------------------------------------------------------------------

function approvalsOnDisk(h: Harness, plan: PlanDoc): PlanDoc['approvals'] {
  const text = readFileSync(join(h.storage, 'plans', `${plan.id}.json`), 'utf8');
  return (JSON.parse(text) as PlanDoc).approvals;
}

function approve(view: TestView, plan: PlanDoc, version = 1, hash?: string): void {
  view.send({
    type: 'plan.approve',
    planId: plan.id,
    version,
    contentHash: hash ?? plan.versions[version - 1]?.contentHash ?? 'missing',
  });
}

/** Nothing was recorded and nothing started: the state after any refusal. */
async function expectNothingHappened(
  h: Harness,
  view: TestView,
  plan: PlanDoc,
  turns = 1,
): Promise<void> {
  await sleep(40);
  expect(approvalsOnDisk(h, plan)).toEqual([]);
  expect(planOf(view).approvals).toEqual([]);
  expect(h.requests).toHaveLength(turns);
  expect(view.active().turns).toHaveLength(turns);
  expect(h.controller.runningTurns()).toBe(0);
}

describe('approving a plan', () => {
  it('records the approval before the provider starts, then runs an Agent turn with the approved plan', async () => {
    const started: { request: TurnRequest; approvals: PlanDoc['approvals'] }[] = [];
    let atConfirm: { approvals: PlanDoc['approvals']; requests: number } | undefined;
    const holder: { h?: Harness; plan?: PlanDoc } = {};
    const { h, view, plan } = await withPlan([textSpec('done')], {
      extra: {
        onStartTurn: (request) => {
          const { h: current, plan: known } = holder;
          if (current && known) {
            started.push({ request, approvals: approvalsOnDisk(current, known) });
          }
        },
      },
    });
    holder.h = h;
    holder.plan = plan;
    h.ui.onConfirm = () => {
      atConfirm = { approvals: approvalsOnDisk(h, plan), requests: h.requests.length };
    };

    approve(view, plan);
    await until('the execution turn', () => view.active().turns.length === 2);
    await finishedTurn(h, view);

    // The question is asked before anything is recorded or started.
    expect(atConfirm).toEqual({ approvals: [], requests: 1 });
    // Auto is offered and off, so approving also turns it on and the dialog says so (auto.test.ts
    // covers that in full); the plan and the open questions come first.
    expect(h.ui.callsOf('confirm')).toEqual([
      [
        {
          title: 'Approve and execute this plan with Auto?',
          detail: expect.stringMatching(/^Version 1 of "Add caching"/) as string,
          confirmLabel: 'Approve and Execute with Auto',
        },
      ],
    ]);
    const detail = (h.ui.callsOf('confirm')[0]?.[0] as { detail: string }).detail;
    expect(detail.split('\n\n').slice(0, 3)).toEqual([
      'Version 1 of "Add caching" will be implemented in Agent mode. Changes are checkpointed and you review them afterwards.',
      '2 question(s) or decision(s) in this plan have no answer yet.',
      'Approving also turns on Auto for this conversation.',
    ]);

    // The approval was on disk when the provider was asked to start.
    expect(started).toHaveLength(1);
    expect(started[0]?.request.mode).toBe('agent');
    expect(started[0]?.request.profile.kind).toBe('agent');
    expect(started[0]?.approvals).toHaveLength(1);
    expect(started[0]?.approvals[0]).toMatchObject({
      version: 1,
      contentHash: plan.versions[0]?.contentHash,
    });

    // The turn runs in Agent mode with a short message for the user and the plan for the provider.
    const executing = view.active().turns[1];
    expect(executing?.mode).toBe('agent');
    expect(executing?.status).toBe('completed');
    const user = view.active().messages.filter((m) => m.role === 'user')[1];
    expect(user?.role === 'user' && user.text).toBe('Execute plan version 1');
    expect(user?.role === 'user' && user.mode).toBe('agent');
    const stored = createConversationStore({ dir: join(h.storage, 'conversations') });
    await stored.init();
    const data = await stored.load(view.active().meta.id);
    expect(
      data?.messages.filter((m) => m.role === 'user').map((m) => m.role === 'user' && m.text),
    ).toEqual(['plan it', 'Execute plan version 1']);
    const { stdin } = await h.record(1);
    expect(stdin).toContain('<approved-plan version="1">');
    expect(stdin).toContain(renderExecutionPrompt(planOf(view), 1));
    expect(stdin.endsWith(renderExecutionPrompt(planOf(view), 1))).toBe(true);

    // The approval says which turn executed it.
    await until(
      'the execution turn to be recorded',
      () => planOf(view).approvals[0]?.executionTurnId !== undefined,
    );
    expect(planOf(view).approvals[0]?.executionTurnId).toBe(executing?.id);
    expect((await planStoreOf(h).get(plan.id))?.approvals[0]?.executionTurnId).toBe(executing?.id);
    view.expectMirror();
  });

  it('sends no images and takes none from the draft', async () => {
    const { h, view, plan } = await withPlan([textSpec('done')]);
    const image = pngBytes('draft-image');
    view.send(pasteImageMessage(image));
    expect(view.current().draftAttachments).toEqual([imageReference(image)]);

    approve(view, plan);
    await until('the execution turn', () => view.active().turns.length === 2);
    await finishedTurn(h, view);

    expect(h.requests).toHaveLength(2);
    expect('images' in (h.requests[1] ?? {})).toBe(false);
    expect(h.requests[1]?.prompt).not.toContain('Images attached');
    const user = view.active().messages.filter((m) => m.role === 'user')[1];
    expect(user?.role === 'user' && user.attachments).toEqual([]);
    // The image still belongs to the draft, and goes with the next message of the user.
    expect(view.current().draftAttachments).toEqual([imageReference(image)]);
    await nextTurn(h, view, 'now with the picture', 'agent');
    expect(h.requests[2]?.images).toHaveLength(1);
    expect(Buffer.from(h.requests[2]?.images?.[0]?.data ?? []).equals(image)).toBe(true);
  });

  it('starts nothing until the approval has been recorded', async () => {
    const { h, view, plan } = await withPlan([textSpec('done')]);
    let release: () => void = () => undefined;
    control.holdApprove = new Promise<void>((resolve) => {
      release = resolve;
    });
    approve(view, plan);
    await until('the approval to be asked for', () => control.approveCalls === 1);
    await sleep(150);
    // The user has confirmed, the store has not answered: no turn, no message, no process.
    expect(h.ui.callsOf('confirm')).toHaveLength(1);
    expect(h.requests).toHaveLength(1);
    expect(view.active().turns).toHaveLength(1);
    expect(view.active().messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(h.controller.runningTurns()).toBe(0);

    release();
    await until('the execution turn', () => view.active().turns.length === 2);
    await finishedTurn(h, view);
    expect(h.requests.map((request) => request.mode)).toEqual(['plan', 'agent']);
    expect(planOf(view).approvals).toHaveLength(1);
    view.expectMirror();
  });

  it('leaves out the sentence about open questions when everything is answered', async () => {
    const { h, view, plan } = await withPlan([textSpec('done')], { input: SIMPLE });
    approve(view, plan);
    await until('the execution turn', () => view.active().turns.length === 2);
    await finishedTurn(h, view);
    const detail = (h.ui.callsOf('confirm')[0]?.[0] as { detail: string }).detail;
    expect(detail.split('\n\n').slice(0, 2)).toEqual([
      'Version 1 of "Rename things" will be implemented in Agent mode. Changes are checkpointed and you review them afterwards.',
      'Approving also turns on Auto for this conversation.',
    ]);
    expect(detail).not.toContain('no answer yet');
    view.expectMirror();
  });

  it('does nothing when the confirmation is declined', async () => {
    const { h, view, plan } = await withPlan();
    h.ui.confirmAnswer = false;
    approve(view, plan);
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    await expectNothingHappened(h, view, plan);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('refuses when a turn is running, and when the plan, version or hash is not right', async () => {
    const { h, view, plan } = await withPlan([hanging]);
    send(view, 'keep working');
    await until('the turn to run', () => h.controller.runningTurns() === 1);
    // Wait for the provider itself: a turn cancelled while still preparing never reaches it,
    // and the request count asserted at the end would then be one short.
    await until('the provider to start', () => h.requests.length === 2);
    approve(view, plan);
    await until('the first toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('A turn is already running in this conversation.');
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await finishedTurn(h, view);

    approve(view, plan, 9, 'anything');
    await until('the second toast', () => view.toasts.length === 2);
    expect(view.toasts[1]?.text).toBe('That version of the plan no longer exists.');

    approve(view, plan, 1, 'not-the-hash');
    await until('the third toast', () => view.toasts.length === 3);
    expect(view.toasts[2]?.text).toBe(
      'The plan changed since it was shown. Review the current version and approve again.',
    );

    view.send({
      type: 'plan.approve',
      planId: 'plan-that-is-gone',
      version: 1,
      contentHash: 'x',
    });
    await until('the fourth toast', () => view.toasts.length === 4);
    expect(view.toasts[3]?.text).toBe('That plan no longer exists.');

    expect(h.ui.callsOf('confirm')).toEqual([]);
    await expectNothingHappened(h, view, plan, 2);
    view.expectMirror();
  });

  it('refuses without a dialog while an Agent turn of another conversation runs in the folder', async () => {
    const { h, view, plan } = await withPlan([hanging]);
    const other = h.attach();
    send(other, 'other work', 'agent');
    await until('the other turn to run', () => h.requests.length === 2);
    await until('the other conversation', () => other.state?.active != null);
    const otherId = other.active().meta.id;

    approve(view, plan);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: BUSY_MESSAGE });
    expect(h.ui.callsOf('confirm')).toEqual([]);
    await sleep(40);
    expect(approvalsOnDisk(h, plan)).toEqual([]);
    expect(planOf(view).approvals).toEqual([]);
    expect(h.requests).toHaveLength(2);
    expect(view.active().turns).toHaveLength(1);
    expect(h.controller.runningTurns()).toBe(1);

    other.send({ type: 'turn.cancel', conversationId: otherId });
    await until('the other turn to end', () => h.controller.runningTurns() === 0);
  });

  it('refuses a hash from an older version after a new version was saved', async () => {
    const { h, view, plan } = await withPlan([submitScenario(SECOND, 'second-result.txt')]);
    await nextTurn(h, view, 'change it');
    expect(planOf(view).versions).toHaveLength(2);
    const stale = plan.versions[0]?.contentHash;
    approve(view, planOf(view), 2, stale);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe(
      'The plan changed since it was shown. Review the current version and approve again.',
    );
    expect(h.ui.callsOf('confirm')).toEqual([]);
    await expectNothingHappened(h, view, plan, 2);
    view.expectMirror();
  });

  it('refuses without recording anything when Agent mode cannot run', async () => {
    const base = createPlanTestPolicy();
    let agentAvailable = true;
    const policy: TurnPolicy = {
      ...base,
      profile: (input) =>
        input.mode === 'agent' && !agentAvailable
          ? { unavailable: 'Agent mode is not available yet.' }
          : base.profile(input),
    };
    const { h, view, plan } = await withPlan([], { extra: { policy } });
    agentAvailable = false;
    approve(view, plan);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('Agent mode is not available yet.');

    h.env.trustedValue = false;
    approve(view, plan);
    await until('a second toast', () => view.toasts.length === 2);
    expect(view.toasts[1]?.text).toBe(
      'This workspace is not trusted, so AgentCanopy will not run agents here.',
    );
    h.env.trustedValue = true;

    h.env.folderList = [];
    approve(view, plan);
    await until('a third toast', () => view.toasts.length === 3);
    expect(view.toasts[2]?.text).toBe('Open a folder to start a conversation.');

    expect(h.ui.callsOf('confirm')).toEqual([]);
    await expectNothingHappened(h, view, plan);
    view.expectMirror();
  });

  it('is the only way to an Agent turn: questions and revision requests never execute', async () => {
    const { h, view, plan } = await withPlan([textSpec('Stage 2 depends on stage 1.')]);
    for (const text of [
      'why stage 2?',
      'change stage 1',
      'looks good, go ahead and implement it',
      'approve and execute the plan',
    ]) {
      await nextTurn(h, view, text, 'plan');
    }
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(approvalsOnDisk(h, plan)).toEqual([]);
    expect(planOf(view).approvals).toEqual([]);
    expect(h.requests.map((request) => request.mode)).toEqual([
      'plan',
      'plan',
      'plan',
      'plan',
      'plan',
    ]);
    expect(view.active().turns.map((turn) => turn.mode)).toEqual([
      'plan',
      'plan',
      'plan',
      'plan',
      'plan',
    ]);
    view.expectMirror();
  });
});

// ---- branches and deletion --------------------------------------------------------------------------------

describe('plans and conversations', () => {
  it('copies the plan to a branch', async () => {
    const { h, view, plan } = await withPlan();
    const parentId = view.active().meta.id;
    const answerId = assistants(view)[0]?.id;
    view.send({ type: 'conversation.fork', conversationId: parentId, messageId: answerId });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);

    const branch = view.active();
    expect(branch.meta.planId).toBeDefined();
    expect(branch.meta.planId).not.toBe(plan.id);
    expect(branch.plan?.id).toBe(branch.meta.planId);
    expect(branch.plan?.conversationId).toBe(branch.meta.id);
    expect(branch.plan?.versions).toEqual(plan.versions);
    expect(branch.plan?.approvals).toEqual([]);
    expect(await planStoreOf(h).get(plan.id)).toEqual(plan);
    expect(await fs.readdir(join(h.storage, 'plans'))).toHaveLength(2);
    // The branch's plan cards point at the copy, not at the parent's plan.
    const cards = branch.messages.flatMap((m) =>
      m.role === 'assistant' ? m.parts.filter((p) => p.kind === 'plan-update') : [],
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.kind === 'plan-update' && card.planId).toBe(branch.meta.planId);
    }
    view.expectMirror();
  });

  it('removes the copy again when it cannot be recorded on the branch', async () => {
    const { h, view, plan } = await withPlan();
    const parentId = view.active().meta.id;
    const store = Reflect.get(h.controller, 'store') as ConversationStore;
    const original = store.updateMeta.bind(store);
    let refused = false;
    store.updateMeta = (id, patch) => {
      if (id === parentId || patch.planId === undefined) return original(id, patch);
      refused = true;
      return Promise.reject(new Error('no space left'));
    };
    const answerId = assistants(view)[0]?.id;
    view.send({ type: 'conversation.fork', conversationId: parentId, messageId: answerId });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);

    expect(refused).toBe(true);
    expect(view.active().meta.planId).toBeUndefined();
    expect(view.active().plan).toBeNull();
    expect(await fs.readdir(join(h.storage, 'plans'))).toEqual([`${plan.id}.json`]);
    expect(await planStoreOf(h).get(plan.id)).toEqual(plan);
    view.expectMirror();
  });

  it('a branch taken before the plan existed gets no plan', async () => {
    const { view } = await withPlan();
    const parentId = view.active().meta.id;
    const firstUser = view.active().messages.find((m) => m.role === 'user');
    view.send({ type: 'conversation.fork', conversationId: parentId, messageId: firstUser?.id });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(view.active().meta.planId).toBeUndefined();
    expect(view.active().plan).toBeNull();
    view.expectMirror();
  });

  it('deletes the plan with its conversation', async () => {
    const { h, view, plan } = await withPlan();
    const id = view.active().meta.id;
    view.send({ type: 'conversation.delete', conversationId: id });
    await until('the conversation to go', () => view.current().conversations.length === 0);
    expect(await planStoreOf(h).get(plan.id)).toBeUndefined();
    expect(await fs.readdir(join(h.storage, 'plans'))).toEqual([]);
    view.expectMirror();
  });
});

// ---- the plan of a branch ---------------------------------------------------------------------------------

describe('the plan of a branch', () => {
  /** Every reading of the clock is later than the one before, so what happened when is unambiguous. */
  const monotonic = () => {
    let now = 1_800_000_000_000;
    return { now: () => (now += 10) };
  };

  async function branchAtMessage(view: TestView, messageId: string | undefined) {
    const parentId = view.active().meta.id;
    view.send({ type: 'conversation.fork', conversationId: parentId, messageId });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    await sleep(30);
    return parentId;
  }

  async function backTo(view: TestView, id: ConversationId): Promise<void> {
    view.send({ type: 'conversation.open', conversationId: id });
    await until('the conversation', () => view.state?.active?.meta.id === id);
  }

  it('has a version the user restored before the fork point, which the cards in the kept messages do not announce', async () => {
    const h = await planHarness(
      [submitScenario(PLAN), submitScenario(SECOND, 'second-result.txt'), textSpec(), textSpec()],
      { clock: monotonic() },
    );
    const view = h.attach();
    await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    const plan = planOf(view);
    await nextTurn(h, view, 'change the title');
    view.send({ type: 'plan.revert', planId: plan.id, version: 1 });
    await until('the restored version', () => planOf(view).versions.length === 3);
    await nextTurn(h, view, 'why stage 2?');
    await nextTurn(h, view, 'and stage 3?');
    const parentId = view.active().meta.id;
    const keptAnswer = assistants(view)[2]?.id;

    await branchAtMessage(view, keptAnswer);
    expect(view.active().plan?.versions.map((version) => version.version)).toEqual([1, 2, 3]);
    expect(view.active().plan?.versions[2]).toMatchObject({ author: 'user', restoredFrom: 1 });
    expect(view.active().meta.planId).toBe(view.active().plan?.id);

    // A branch taken before the restore does not have it.
    await backTo(view, parentId);
    await branchAtMessage(view, assistants(view)[1]?.id);
    expect(view.active().plan?.versions.map((version) => version.version)).toEqual([1, 2]);
    view.expectMirror();
  });

  it('carries the decisions made before the fork point and not the ones made after it', async () => {
    const h = await planHarness([submitScenario(PLAN), textSpec(), textSpec()], {
      clock: monotonic(),
    });
    const view = h.attach();
    await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    const plan = planOf(view);
    await nextTurn(h, view, 'why stage 2?');
    view.send({
      type: 'plan.decide',
      planId: plan.id,
      targetId: 'd1',
      kind: 'decision-point',
      values: ['disk'],
    });
    await until('the decision', () => planOf(view).decisions.length === 1);
    await nextTurn(h, view, 'and stage 3?');
    const parentId = view.active().meta.id;
    const answers = assistants(view);

    // After the decision: it is in the branch.
    await branchAtMessage(view, answers[2]?.id);
    expect(view.active().plan?.decisions.map((decision) => decision.targetId)).toEqual(['d1']);

    // Before the decision: the plan is there, the decision is not.
    await backTo(view, parentId);
    await branchAtMessage(view, answers[1]?.id);
    expect(view.active().plan?.versions).toHaveLength(1);
    expect(view.active().plan?.decisions).toEqual([]);
    view.expectMirror();
  });

  it('is the whole plan when the branch keeps every turn, with later decisions', async () => {
    const h = await planHarness([submitScenario(PLAN), textSpec()], { clock: monotonic() });
    const view = h.attach();
    await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    const plan = planOf(view);
    await nextTurn(h, view, 'why stage 2?');
    view.send({
      type: 'plan.decide',
      planId: plan.id,
      targetId: 'd1',
      kind: 'decision-point',
      values: ['mem'],
    });
    await until('the decision', () => planOf(view).decisions.length === 1);
    await branchAtMessage(view, assistants(view)[1]?.id);
    expect(view.active().plan?.decisions).toHaveLength(1);
    expect(view.active().plan?.versions).toHaveLength(1);
    expect(view.active().plan?.id).not.toBe(plan.id);
  });

  it('is none for a branch taken before the plan existed', async () => {
    const h = await planHarness([textSpec(), submitScenario(PLAN)], { clock: monotonic() });
    const view = h.attach();
    await sendAndFinish(h, view, 'just talking', { mode: 'plan' });
    // A plan tool is offered in Plan mode, but this turn did not save one.
    await nextTurn(h, view, 'now plan it');
    expect(planOf(view).versions).toHaveLength(1);
    await branchAtMessage(view, assistants(view)[0]?.id);
    expect(view.active().meta.planId).toBeUndefined();
    expect(view.active().plan).toBeNull();
    expect(view.active().turns).toHaveLength(1);
    view.expectMirror();
  });
});
