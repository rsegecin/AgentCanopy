import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type {
  AssistantMessage,
  FolderKey,
  PermissionPrompt,
  PlanDoc,
  ToolCallView,
} from '../../shared';
import type { OperationRecord } from '../contracts';
import { BUSY_MESSAGE, CONFIG_PENDING_MESSAGE } from '../workspace/tracker/tracker';
import {
  FOLDER_KEY,
  assistantText,
  assistantToolUse,
  createHarness,
  createPlanTestPolicy,
  finishedTurn,
  resultStep,
  sleep,
  stateEvent,
  streamedText,
  textScenario,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type ScenarioSpec,
  type TestView,
} from './test-support';

// A real tracker reads the folder and the machine may be busy with other work: allow more time.
vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness({ realDefaults: true, ...args[0] });
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const SECOND_FOLDER = 'folder-2' as FolderKey;
const allowed = { decision: 'accept', source: 'user_temporary' } as const;
const rejected = { decision: 'reject', source: 'user_reject' } as const;

function sendAgent(view: TestView, text = 'go'): void {
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'agent',
    model: 'default',
  });
}

/** Waits until the conversation shown by the view has a finished last turn and nothing runs. */
async function agentTurn(h: Harness, view: TestView, text = 'go') {
  sendAgent(view, text);
  await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > 0);
  return finishedTurn(h, view);
}

function assistants(view: TestView): AssistantMessage[] {
  return view.active().messages.filter((m): m is AssistantMessage => m.role === 'assistant');
}

function operations(h: Harness): OperationRecord[] {
  const records = h.tracker()?.folder(FOLDER_KEY)?.log.records() ?? [];
  return records.filter((record): record is OperationRecord => record.type === 'operation');
}

function pendingPrompt(view: TestView): PermissionPrompt | undefined {
  const prompt = view.state?.active?.prompts.find((candidate) => candidate.state === 'pending');
  return prompt?.kind === 'permission' ? prompt : undefined;
}

async function answer(
  view: TestView,
  choice: 'allow-once' | 'allow-always' | 'deny',
  feedback?: string,
): Promise<PermissionPrompt> {
  await until('a prompt', () => pendingPrompt(view) !== undefined);
  const prompt = pendingPrompt(view);
  if (!prompt) throw new Error('no prompt');
  view.send({
    type: 'prompt.answer',
    promptId: prompt.id,
    displayHash: prompt.displayHash,
    answer: { kind: 'permission', choice, ...(feedback !== undefined ? { feedback } : {}) },
  });
  return prompt;
}

function toolCalls(view: TestView): ToolCallView[] {
  return assistants(view).flatMap((message) =>
    message.parts.flatMap((part) => (part.kind === 'tool' ? [part.call] : [])),
  );
}

// ---- scenarios -----------------------------------------------------------------------------------

/** The fake CLI replaces `$CWD` with the folder it runs in, so the paths here are absolute, as Claude Code's are. */
function writeScenario(name: string, content: string, toolUseId = 'toolu_w'): ScenarioSpec {
  const path = `$CWD/${name}`;
  const input = { file_path: path, content };
  return {
    scenario: {
      steps: [
        stateEvent('running'),
        initEvent(),
        assistantToolUse(toolUseId, 'Write', input),
        {
          permission: {
            toolName: 'Write',
            input,
            toolUseId,
            onAllow: [
              { writeFile: { path, content } },
              userToolResult(toolUseId, 'written', { decision: allowed }),
            ],
            onDeny: [
              userToolResult(toolUseId, 'denied', {
                isError: true,
                decision: rejected,
                nonExecutionKind: 'permission-rule',
              }),
            ],
          },
        },
        assistantText('done'),
        ...resultStep('done'),
      ],
    },
  };
}

function bashScenario(command: string, writes: string, toolUseId = 'toolu_b'): ScenarioSpec {
  const input = { command };
  return {
    record: true,
    scenario: {
      steps: [
        stateEvent('running'),
        initEvent(),
        assistantToolUse(toolUseId, 'Bash', input),
        {
          permission: {
            toolName: 'Bash',
            input,
            toolUseId,
            onAllow: [
              { hook: { phase: 'pre', toolName: 'Bash', input, toolUseId } },
              { writeFile: { path: writes, content: 'made by a command' } },
              { hook: { phase: 'post', toolName: 'Bash', input, toolUseId } },
              userToolResult(toolUseId, 'ran', { decision: allowed }),
            ],
            onDeny: [
              userToolResult(toolUseId, 'denied', {
                isError: true,
                decision: rejected,
                nonExecutionKind: 'permission-rule',
              }),
            ],
          },
        },
        assistantText('done'),
        ...resultStep('done'),
      ],
    },
  };
}

const hanging: ScenarioSpec = {
  scenario: { steps: [...streamedText(['working']), { hang: true }] },
};

/** A Plan mode turn that saves a small plan with the plan tool. */
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
              title: 'Add caching',
              objective: 'Cache the results of slow lookups.',
              stages: [{ id: 's1', title: 'Write the cache', description: 'Implement it.' }],
            },
            saveAs: 'result',
          },
        },
        assistantText('The plan covers it.'),
        ...resultStep('The plan covers it.'),
      ],
    },
  };
}

// With Auto offered, approving a plan also turns Auto on and the dialog says so in its title.
const APPROVAL_TITLES = [
  'Approve and execute this plan?',
  'Approve and execute this plan with Auto?',
];

/** The approval dialogs asked so far; other confirmations (reverting a change) do not count. */
function approvalDialogs(h: Harness): unknown[][] {
  return h.ui
    .callsOf('confirm')
    .filter((call) => APPROVAL_TITLES.includes((call[0] as { title?: string }).title ?? ''));
}

/** Holds the approval dialog open until `release` is called. */
function holdApprovalDialog(h: Harness): () => void {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.ui.onConfirm = (input) => (APPROVAL_TITLES.includes(input.title) ? held : undefined);
  return release;
}

/** A Plan mode turn in a new conversation, which leaves a plan; returns that plan. */
async function planned(h: Harness, view: TestView): Promise<PlanDoc> {
  view.send({ type: 'turn.send', text: 'plan it', mode: 'plan', model: 'default' });
  await until('the plan', () => view.state?.active?.plan?.versions.length === 1);
  await finishedTurn(h, view);
  const plan = view.active().plan;
  if (!plan) throw new Error('the conversation has no plan');
  return plan;
}

function approveMessage(plan: PlanDoc) {
  return {
    type: 'plan.approve',
    planId: plan.id,
    version: 1,
    contentHash: plan.versions[0]?.contentHash ?? 'missing',
  };
}

function autoEdits(h: Harness): void {
  h.env.settingsValue = { ...DEFAULT_SETTINGS, editApproval: 'auto' };
}

describe('Agent mode with the default policy and tracker', () => {
  it('lets an edit inside the folder through without a prompt and attributes it to the agent tool', async () => {
    const h = await harness({ sequence: [writeScenario('a.txt', 'hello')] });
    autoEdits(h);
    const view = h.attach();
    const turn = await agentTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(turn.mode).toBe('agent');
    expect(view.active().prompts).toEqual([]);
    expect(toolCalls(view).map((call) => [call.name, call.status, call.approval])).toEqual([
      ['Write', 'done', 'policy'],
    ]);
    expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('hello');

    const ops = operations(h);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.kind).toBe('agent-turn');
    expect(ops[0]?.changes.map((change) => [change.path, change.attribution])).toEqual([
      ['a.txt', 'agent-tool'],
    ]);
    view.expectMirror();
  });

  it('shows a command prompt with three choices, runs the command once allowed and attributes its changes', async () => {
    const h = await harness({ sequence: [bashScenario('echo hello', 'made.txt')] });
    const view = h.attach();
    sendAgent(view);
    const prompt = await answer(view, 'allow-once');
    expect(prompt.category).toBe('command');
    expect(prompt.choices).toEqual(['allow-once', 'allow-always', 'deny']);
    expect(prompt.detail).toBe('echo hello');
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(toolCalls(view)[0]).toMatchObject({ name: 'Bash', status: 'done', approval: 'user' });
    expect(await fs.readFile(join(h.workspace, 'made.txt'), 'utf8')).toBe('made by a command');
    expect(
      operations(h).flatMap((op) => op.changes.map((change) => [change.path, change.attribution])),
    ).toEqual([['made.txt', 'agent-command']]);
    view.expectMirror();
  });

  it('denies a command with the feedback the user gave', async () => {
    const h = await harness({ sequence: [bashScenario('echo hello', 'made.txt')] });
    const view = h.attach();
    sendAgent(view);
    await answer(view, 'deny', 'not now');
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(toolCalls(view)[0]).toMatchObject({ name: 'Bash', status: 'denied', approval: 'user' });
    await expect(fs.access(join(h.workspace, 'made.txt'))).rejects.toThrow();
    expect(operations(h).flatMap((op) => op.changes)).toEqual([]);
    view.expectMirror();
  });

  it('stores an always-allow rule after a confirmation and gives it to the next turn', async () => {
    const h = await harness({
      sequence: [bashScenario('echo hello', 'one.txt'), bashScenario('echo hello', 'two.txt')],
    });
    const view = h.attach();
    sendAgent(view);
    await answer(view, 'allow-always');
    await finishedTurn(h, view);
    expect(h.ui.callsOf('confirm')).toHaveLength(1);
    const rules = h.rules()?.list(FOLDER_KEY) ?? [];
    expect(rules).toHaveLength(1);
    expect(h.requests).toHaveLength(1);

    sendAgent(view, 'again');
    await until('the second turn to start', () => h.requests.length === 2);
    const second = h.requests[1]?.profile;
    expect(second?.kind === 'agent' && second.allowRules).toEqual(expect.arrayContaining(rules));
    await finishedTurn(h, view);
    expect(h.requests[0]?.profile.kind === 'agent' && h.requests[0].profile.allowRules).toEqual([]);
    view.expectMirror();
  });

  it('does not store the rule when the confirmation is declined', async () => {
    const h = await harness({ sequence: [bashScenario('echo hello', 'one.txt')] });
    h.ui.confirmAnswer = false;
    const view = h.attach();
    sendAgent(view);
    await answer(view, 'allow-always');
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(h.ui.callsOf('confirm')).toHaveLength(1);
    expect(h.rules()?.list(FOLDER_KEY)).toEqual([]);
    view.expectMirror();
  });

  it("refuses a second Agent turn in the folder while one runs, with the tracker's message", async () => {
    const h = await harness({ sequence: [hanging, textScenarioSpec()] });
    const a = h.attach();
    const b = h.attach();
    sendAgent(a, 'first');
    await until('the first turn to run', () => h.requests.length === 1);
    sendAgent(b, 'second');
    await until('the second turn to end', () => {
      const status = b.state?.active?.turns[0]?.status;
      return status !== undefined && status !== 'preparing' && status !== 'running';
    });
    const turn = b.active().turns[0];
    expect(turn?.status).toBe('error');
    expect(turn?.error?.length).toBeGreaterThan(0);
    expect(assistants(b)[0]?.parts.filter((part) => part.kind === 'notice')).toEqual([
      { kind: 'notice', level: 'error', text: turn?.error },
    ]);
    expect(h.requests).toHaveLength(1);

    a.send({ type: 'turn.cancel', conversationId: a.active().meta.id });
    await until('the first turn to end', () => h.controller.runningTurns() === 0);
    a.expectMirror();
    b.expectMirror();
  });

  it('flags a configuration change, blocks the next Agent turn, and reverts it on request', async () => {
    const h = await harness({
      sequence: [writeScenario('.vscode/tasks.json', '{"version":"2.0.0"}'), textScenarioSpec()],
    });
    const view = h.attach();
    sendAgent(view);
    const prompt = await answer(view, 'allow-once');
    expect(prompt.category).toBe('protected-path');
    await finishedTurn(h, view);
    const file = join(h.workspace, '.vscode', 'tasks.json');
    expect(await fs.readFile(file, 'utf8')).toBe('{"version":"2.0.0"}');
    await until('the change', () => view.current().review.configChanges.length === 1);
    const [change] = view.current().review.configChanges;
    expect(change).toMatchObject({ displayPath: '.vscode/tasks.json', changeType: 'created' });
    expect(change?.revertible).toBe(true);

    // The next Agent turn is refused up front, with a toast, until the change is dealt with.
    const turnsBefore = view.active().turns.length;
    const messagesBefore = view.active().messages.length;
    sendAgent(view, 'again');
    await until('the toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: CONFIG_PENDING_MESSAGE });
    await sleep(40);
    expect(view.active().turns).toHaveLength(turnsBefore);
    expect(view.active().messages).toHaveLength(messagesBefore);
    expect(h.requests).toHaveLength(1);

    view.send({ type: 'config.openDiff', changeId: change?.id });
    await until('the diff', () => h.ui.callsOf('showDiff').length === 1);
    expect(h.ui.callsOf('showDiff')[0]?.[0]).toMatchObject({
      title: '.vscode/tasks.json (before ↔ after the turn)',
      leftLabel: 'Before',
      rightLabel: 'After',
      rightText: '{"version":"2.0.0"}',
    });

    // A declined confirmation changes nothing.
    h.ui.confirmAnswer = false;
    view.send({ type: 'config.revert', changeId: change?.id });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    await sleep(50);
    expect(view.current().review.configChanges).toHaveLength(1);
    expect(await fs.readFile(file, 'utf8')).toBe('{"version":"2.0.0"}');

    h.ui.confirmAnswer = true;
    view.send({ type: 'config.revert', changeId: change?.id });
    await until('the change to go', () => view.current().review.configChanges.length === 0);
    expect(h.ui.callsOf('confirm')[1]?.[0]).toEqual({
      title: 'Revert this configuration change?',
      detail: '.vscode/tasks.json goes back to what it was before the turn.',
      confirmLabel: 'Revert',
    });
    await expect(fs.access(file)).rejects.toThrow();

    const next = await agentTurn(h, view, 'now it works');
    expect(next.status).toBe('completed');
    view.expectMirror();
  });

  it('keeps a message queued behind a turn that left configuration changes pending, until they are dealt with', async () => {
    const h = await harness({
      sequence: [writeScenario('.vscode/tasks.json', '{"version":"2.0.0"}'), textScenarioSpec()],
    });
    const view = h.attach();
    sendAgent(view);
    // The turn waits for the answer: send the next message meanwhile.
    await until('the prompt', () => pendingPrompt(view) !== undefined);
    sendAgent(view, 'queued');
    await until('the message to be queued', () => view.state?.active?.queued != null);
    await answer(view, 'allow-once');
    await finishedTurn(h, view);
    await until('the change', () => view.current().review.configChanges.length === 1);
    const [change] = view.current().review.configChanges;

    // The turn completed, but an Agent message does not start while the change is pending.
    await sleep(150);
    expect(view.active().queued?.text).toBe('queued');
    expect(h.requests).toHaveLength(1);
    expect(view.toasts).toEqual([]);

    view.send({ type: 'queue.sendNow', conversationId: view.active().meta.id });
    await until('the toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: CONFIG_PENDING_MESSAGE });
    expect(view.active().queued?.text).toBe('queued');
    expect(h.requests).toHaveLength(1);

    view.send({ type: 'config.keep', changeId: change?.id });
    await until('the change to go', () => view.current().review.configChanges.length === 0);
    view.send({ type: 'queue.sendNow', conversationId: view.active().meta.id });
    await until('the second turn', () => view.active().turns.length === 2);
    const next = await finishedTurn(h, view);
    expect(next.status).toBe('completed');
    expect(view.active().queued).toBeNull();
    expect(h.requests).toHaveLength(2);
    view.expectMirror();
  });

  it('"Send now" does not stop a Plan turn when pending configuration changes block the queued Agent message', async () => {
    const h = await harness({
      policy: createPlanTestPolicy(),
      sequence: [
        writeScenario('.vscode/tasks.json', '{"version":"2.0.0"}'),
        { scenario: { steps: [...streamedText(['working']), { hang: true }] } },
      ],
    });
    const view = h.attach();
    sendAgent(view);
    await answer(view, 'allow-once');
    await finishedTurn(h, view);
    await until('the change', () => view.current().review.configChanges.length === 1);

    const id = view.active().meta.id;
    view.send({
      type: 'turn.send',
      conversationId: id,
      text: 'plan',
      mode: 'plan',
      model: 'default',
    });
    await until('the Plan turn to run', () => h.requests.length === 2);
    sendAgent(view, 'queued');
    await until('the message to be queued', () => view.state?.active?.queued != null);

    view.send({ type: 'queue.sendNow', conversationId: id });
    await until('the toast', () => view.toasts.length === 1);
    await sleep(100);
    expect(view.toasts).toEqual([{ level: 'warning', text: CONFIG_PENDING_MESSAGE }]);
    // The Plan turn was not interrupted and the message is still queued.
    expect(view.active().turns.at(-1)?.status).toBe('running');
    expect(h.controller.runningTurns()).toBe(1);
    expect(view.active().queued?.text).toBe('queued');
    expect(h.requests).toHaveLength(2);

    view.send({ type: 'turn.cancel', conversationId: id });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
  });

  it('lets the user keep a configuration change, which unblocks the next turn', async () => {
    const h = await harness({
      sequence: [writeScenario('.vscode/tasks.json', '{"version":"2.0.0"}'), textScenarioSpec()],
    });
    const view = h.attach();
    sendAgent(view);
    await answer(view, 'allow-once');
    await finishedTurn(h, view);
    await until('the change', () => view.current().review.configChanges.length === 1);
    const [change] = view.current().review.configChanges;

    // Keeping is final, so it asks first; declined, nothing changes and Agent turns stay blocked.
    h.ui.confirmAnswer = false;
    view.send({ type: 'config.keep', changeId: change?.id });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    await sleep(80);
    expect(view.current().review.configChanges).toHaveLength(1);

    h.ui.confirmAnswer = true;
    view.send({ type: 'config.keep', changeId: change?.id });
    await until('the change to go', () => view.current().review.configChanges.length === 0);
    expect(await fs.readFile(join(h.workspace, '.vscode', 'tasks.json'), 'utf8')).toBe(
      '{"version":"2.0.0"}',
    );
    expect(h.ui.callsOf('confirm')).toHaveLength(2);
    expect(h.ui.callsOf('confirm')[1]?.[0]).toEqual({
      title: 'Keep this configuration change?',
      detail:
        '.vscode/tasks.json stays as the turn left it. Its earlier version can then no longer be restored from here, and Agent turns are allowed again.',
      confirmLabel: 'Keep Change',
    });
    const next = await agentTurn(h, view, 'carry on');
    expect(next.status).toBe('completed');

    // An id that is not pending gets a toast.
    view.send({ type: 'config.keep', changeId: 'not-a-change' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('That configuration change was already resolved.');
    view.expectMirror();
  });

  it('refuses an Agent turn before storing anything while a configuration change waits, and lets Ask run', async () => {
    const h = await harness({
      sequence: [
        writeScenario('.vscode/tasks.json', '{"version":"2.0.0"}'),
        textScenarioSpec(),
        textScenarioSpec(),
        textScenarioSpec(),
      ],
    });
    const view = h.attach();
    sendAgent(view);
    await answer(view, 'allow-once');
    await finishedTurn(h, view);
    await until('the change', () => view.current().review.configChanges.length === 1);
    const [change] = view.current().review.configChanges;
    const conversationId = view.active().meta.id;
    const turns = view.active().turns.length;
    const messages = view.active().messages.length;

    sendAgent(view, 'again');
    await until('the toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: CONFIG_PENDING_MESSAGE });
    expect(CONFIG_PENDING_MESSAGE).toBe(
      'The last turn changed tool or editor configuration. Keep or revert those changes in the changes card below the chat before starting another Agent turn.',
    );
    await sleep(40);
    expect(view.active().turns).toHaveLength(turns);
    expect(view.active().messages).toHaveLength(messages);
    expect(h.requests).toHaveLength(1);
    expect(h.controller.runningTurns()).toBe(0);

    // A new conversation is not created either.
    const known = view.current().conversations.length;
    view.send({ type: 'conversation.new', folder: FOLDER_KEY });
    sendAgent(view, 'a new one');
    await until('the second toast', () => view.toasts.length === 2);
    await sleep(40);
    expect(view.current().conversations).toHaveLength(known);
    expect(h.requests).toHaveLength(1);
    view.send({ type: 'conversation.open', conversationId });
    await until('the conversation', () => view.state?.active?.meta.id === conversationId);

    // Ask is not blocked.
    view.send({ type: 'turn.send', conversationId, text: 'why?', mode: 'ask', model: 'default' });
    await until('the Ask turn to start', () => h.requests.length === 2);
    await finishedTurn(h, view);
    expect(view.active().turns.at(-1)?.mode).toBe('ask');
    expect(view.active().turns.at(-1)?.status).toBe('completed');
    expect(view.toasts).toHaveLength(2);

    // Plan is not blocked either, and says nothing.
    view.send({
      type: 'turn.send',
      conversationId,
      text: 'outline',
      mode: 'plan',
      model: 'default',
    });
    await until('the Plan turn to start', () => h.requests.length === 3);
    await finishedTurn(h, view);
    expect(view.active().turns.at(-1)?.mode).toBe('plan');
    expect(view.toasts).toHaveLength(2);

    // Once the change is decided the Agent turn runs.
    h.ui.confirmAnswer = true;
    view.send({ type: 'config.keep', changeId: change?.id });
    await until('the change to go', () => view.current().review.configChanges.length === 0);
    const next = await agentTurn(h, view, 'now');
    expect(next.status).toBe('completed');
    expect(h.requests).toHaveLength(4);
    view.expectMirror();
  });

  it('refuses Approve and Execute before the approval is recorded while a configuration change waits', async () => {
    const h = await harness({
      sequence: [
        submitPlanScenario(),
        writeScenario('.vscode/tasks.json', '{"version":"2.0.0"}'),
        textScenarioSpec(),
      ],
    });
    const view = h.attach();
    view.send({
      type: 'turn.send',
      text: 'plan it',
      mode: 'plan',
      model: 'default',
    });
    await until('the plan', () => view.state?.active?.plan?.versions.length === 1);
    await finishedTurn(h, view);
    sendAgent(view, 'change config');
    await answer(view, 'allow-once');
    await finishedTurn(h, view);
    await until('the change', () => view.current().review.configChanges.length === 1);
    const [change] = view.current().review.configChanges;
    const plan = view.active().plan;
    if (!plan) throw new Error('the conversation has no plan');
    const planFile = join(h.storage, 'plans', `${plan.id}.json`);
    const approvals = async (): Promise<PlanDoc['approvals']> =>
      (JSON.parse(await fs.readFile(planFile, 'utf8')) as PlanDoc).approvals;
    const turns = view.active().turns.length;
    const requests = h.requests.length;

    view.send({
      type: 'plan.approve',
      planId: plan.id,
      version: 1,
      contentHash: plan.versions[0]?.contentHash ?? 'missing',
    });
    await until('the toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: CONFIG_PENDING_MESSAGE });
    await sleep(40);
    expect(await approvals()).toEqual([]);
    expect(view.active().plan?.approvals).toEqual([]);
    expect(approvalDialogs(h)).toEqual([]);
    expect(view.active().turns).toHaveLength(turns);
    expect(h.requests).toHaveLength(requests);

    // After the change is reverted the same approval goes through.
    view.send({ type: 'config.revert', changeId: change?.id });
    await until('the change to go', () => view.current().review.configChanges.length === 0);
    view.send({
      type: 'plan.approve',
      planId: plan.id,
      version: 1,
      contentHash: plan.versions[0]?.contentHash ?? 'missing',
    });
    await until('the executing turn', () => h.requests.length === requests + 1);
    await finishedTurn(h, view);
    expect(approvalDialogs(h)).toHaveLength(1);
    expect(await approvals()).toHaveLength(1);
    view.expectMirror();
  });

  it('does not record an approval when another conversation left a configuration change while the dialog was open', async () => {
    const h = await harness({
      sequence: [submitPlanScenario(), writeScenario('.vscode/tasks.json', '{"version":"2.0.0"}')],
    });
    const view = h.attach();
    const plan = await planned(h, view);
    const turns = view.active().turns.length;
    const requests = h.requests.length;
    const release = holdApprovalDialog(h);

    view.send(approveMessage(plan));
    await until('the dialog', () => approvalDialogs(h).length === 1);
    // Meanwhile an Agent turn of another conversation in the folder changes configuration.
    const other = h.attach();
    sendAgent(other, 'change config');
    await answer(other, 'allow-once');
    await finishedTurn(h, other);
    await until('the change', () => view.current().review.configChanges.length === 1);
    release();

    await until('the toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: CONFIG_PENDING_MESSAGE });
    await sleep(40);
    expect(view.active().plan?.approvals).toEqual([]);
    expect(
      (
        JSON.parse(
          await fs.readFile(join(h.storage, 'plans', `${plan.id}.json`), 'utf8'),
        ) as PlanDoc
      ).approvals,
    ).toEqual([]);
    expect(view.active().turns).toHaveLength(turns);
    expect(h.requests).toHaveLength(requests + 1);
    expect(h.controller.runningTurns()).toBe(0);
    view.expectMirror();
  });

  it('does not record an approval when an Agent turn of another conversation still runs after the dialog', async () => {
    const h = await harness({ sequence: [submitPlanScenario(), hanging] });
    const view = h.attach();
    const plan = await planned(h, view);
    const turns = view.active().turns.length;
    const release = holdApprovalDialog(h);

    view.send(approveMessage(plan));
    await until('the dialog', () => approvalDialogs(h).length === 1);
    const other = h.attach();
    sendAgent(other, 'work');
    await until('the other turn to run', () => h.requests.length === 2);
    release();

    await until('the toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: BUSY_MESSAGE });
    await sleep(40);
    expect(view.active().plan?.approvals).toEqual([]);
    expect(
      (
        JSON.parse(
          await fs.readFile(join(h.storage, 'plans', `${plan.id}.json`), 'utf8'),
        ) as PlanDoc
      ).approvals,
    ).toEqual([]);
    expect(view.active().turns).toHaveLength(turns);
    expect(h.requests).toHaveLength(2);

    other.send({ type: 'turn.cancel', conversationId: other.active().meta.id });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
  });

  it('tells every view of the folder when an Agent turn runs, and not for an Ask turn', async () => {
    const h = await harness({ sequence: [hanging, hanging] });
    const view = h.attach();
    const other = h.attach();
    expect(view.current().review.busy).toBe(false);

    view.send({ type: 'turn.send', text: 'question', mode: 'ask', model: 'default' });
    await until('the Ask turn to run', () => h.requests.length === 1);
    expect(view.current().review.busy).toBe(false);
    expect(other.current().review.busy).toBe(false);
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await until('the Ask turn to end', () => h.controller.runningTurns() === 0);

    view.send({ type: 'conversation.new', folder: FOLDER_KEY });
    sendAgent(view, 'work');
    await until('the Agent turn to run', () => h.requests.length === 2);
    await until('busy', () => view.current().review.busy && other.current().review.busy);
    // A view opened meanwhile starts out busy; one on another folder stays idle.
    const late = h.attach();
    expect(late.current().review.busy).toBe(true);
    const second = join(h.root, 'second');
    await fs.mkdir(second);
    h.env.folderList = [...h.env.folderList, { key: SECOND_FOLDER, name: 'second', path: second }];
    const elsewhere = h.attach();
    elsewhere.send({ type: 'conversation.new', folder: SECOND_FOLDER });
    expect(elsewhere.current().review.busy).toBe(false);
    const before = other.patches().length;
    view.expectMirror();
    other.expectMirror();
    expect(other.patches().length).toBe(before);

    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
    await until('not busy', () => !view.current().review.busy && !other.current().review.busy);
    await until('the late view to be idle', () => !late.current().review.busy);
    expect(elsewhere.current().review.busy).toBe(false);
    view.expectMirror();
    other.expectMirror();
    late.expectMirror();
    elsewhere.expectMirror();
  });

  it('goes through capturing to ready after start-up', async () => {
    const files: Promise<void>[] = [];
    const h = await harness({ noStart: true, sequence: [textScenarioSpec()] });
    await fs.mkdir(join(h.workspace, 'many'), { recursive: true });
    for (let index = 0; index < 200; index += 1) {
      files.push(fs.writeFile(join(h.workspace, 'many', `file${index}.txt`), `content ${index}`));
    }
    await Promise.all(files);
    const view = h.attach();
    expect(view.current().baseline.state).toBe('idle');
    await h.controller.start();
    await until(
      'the baseline to be ready',
      () => view.current().baseline.state === 'ready',
      15_000,
    );
    const states = view
      .patches()
      .flatMap((patch) => patch.ops)
      .filter((op) => op.op === 'set' && JSON.stringify(op.path) === '["baseline"]')
      .map((op) => (op.op === 'set' ? (op.value as { state: string }).state : ''));
    expect(states[0]).toBe('capturing');
    expect(states.at(-1)).toBe('ready');
    expect(view.current().baseline).toEqual(h.tracker()?.status(FOLDER_KEY));
    view.expectMirror();
  });

  it('keeps its folder locks in the global storage directory', async () => {
    const h = await harness({ sequence: [textScenarioSpec()] });
    await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
    const view = h.attach();
    await agentTurn(h, view);
    const locks = await fs.readdir(join(h.globalStorage, 'locks')).catch(() => [] as string[]);
    expect(locks.length).toBeGreaterThan(0);
    const inside = await fs.readdir(join(h.storage, 'workspace', FOLDER_KEY));
    expect(inside.some((name) => name.includes('lock'))).toBe(false);
  });

  it('keeps the idle baseline and no configuration changes when it is given its own observers', async () => {
    const h = await createHarness({ scenario: textScenario('x') });
    harnesses.push(h);
    const view = h.attach();
    expect(h.tracker()).toBeUndefined();
    expect(view.current().baseline.state).toBe('idle');
    expect(view.current().review.configChanges).toEqual([]);
    view.send({ type: 'config.keep', changeId: 'x' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('This is not available yet.');
  });

  it('cleans up after a turn that was cut off, and says so in a banner and a toast', async () => {
    const cutOff: ScenarioSpec = {
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          { writeFile: { path: 'existing.txt', content: 'unfinished' } },
          ...streamedText(['working']),
          { hang: true },
        ],
      },
    };
    const first = await harness({ noStart: true, sequence: [cutOff] });
    await fs.writeFile(join(first.workspace, 'existing.txt'), 'finished');
    await first.controller.start();
    await until('the baseline', () => first.tracker()?.status(FOLDER_KEY).state === 'ready');
    const view = first.attach();
    sendAgent(view);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const text = await fs.readFile(join(first.workspace, 'existing.txt'), 'utf8');
      if (text === 'unfinished') break;
      await sleep(20);
    }
    await until('the turn to run', () => first.handles.length === 1);
    // The application goes away without the turn having ended: the tracker keeps its journal.
    await first.tracker()?.dispose();
    await first.controller.dispose();
    const journal = join(first.storage, 'workspace', FOLDER_KEY, 'journal.json');
    await fs.access(journal);

    const second = await createHarness({
      reuse: first,
      realDefaults: true,
      noStart: true,
      scenario: textScenario('ok'),
    });
    try {
      const other = second.attach();
      await second.controller.start();
      expect(other.current().banners.map((banner) => banner.id)).toContain(
        `recovery:${FOLDER_KEY}`,
      );
      const banner = other.current().banners.find((b) => b.id === `recovery:${FOLDER_KEY}`);
      expect(banner).toMatchObject({ level: 'warning', dismissible: true });
      expect(banner?.text.length).toBeGreaterThan(0);
      expect(other.toasts).toEqual([{ level: 'warning', text: banner?.text }]);
      await expect(fs.access(journal)).rejects.toThrow();
      expect(
        second
          .tracker()
          ?.folder(FOLDER_KEY)
          ?.log.records()
          .map((record) => record.type === 'operation' && record.kind),
      ).toEqual(['recovery']);

      other.send({ type: 'banner.dismiss', bannerId: `recovery:${FOLDER_KEY}` });
      expect(other.current().banners.map((b) => b.id)).not.toContain(`recovery:${FOLDER_KEY}`);
      other.expectMirror();
    } finally {
      await second.dispose();
    }
  });

  describe('a recovery that could not tell whether the old process has stopped', () => {
    const recoveryId = `recovery:${FOLDER_KEY}`;

    /** A folder whose journal names a live process, with a file changed since the baseline. */
    async function leftBehind(child: ChildProcess): Promise<Harness> {
      const first = await harness({ noStart: true, scenario: textScenario('ok') });
      await fs.writeFile(join(first.workspace, 'existing.txt'), 'finished');
      await first.controller.start();
      await until('the baseline', () => first.tracker()?.status(FOLDER_KEY).state === 'ready');
      await first.controller.dispose();
      await fs.writeFile(join(first.workspace, 'existing.txt'), 'changed afterwards');
      const journal = {
        turnId: 'a0000000-0000-4000-8000-000000000001',
        conversationId: 'b0000000-0000-4000-8000-000000000002',
        startedAt: Date.now() - 1000,
        lastActivityAt: Date.now() - 500,
        pid: child.pid,
      };
      await fs.writeFile(
        join(first.storage, 'workspace', FOLDER_KEY, 'journal.json'),
        JSON.stringify(journal),
      );
      return first;
    }

    it('stays on screen with a button, and "Recover now" finishes it after a confirmation', async () => {
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      try {
        const first = await leftBehind(child);
        const second = await createHarness({
          reuse: first,
          realDefaults: true,
          noStart: true,
          scenario: textScenario('ok'),
        });
        try {
          const view = second.attach();
          const sibling = second.attach();
          await second.controller.start();
          const banner = view.current().banners.find((b) => b.id === recoveryId);
          expect(banner).toMatchObject({
            level: 'warning',
            dismissible: false,
            action: { id: 'recover-now', label: 'Recover now' },
          });
          expect(view.toasts).toEqual([]);
          view.expectMirror();

          // Declined: nothing changes.
          second.ui.confirmAnswer = false;
          view.send({ type: 'banner.action', bannerId: recoveryId, actionId: 'recover-now' });
          await until('the question', () => second.ui.callsOf('confirm').length === 1);
          await sleep(50);
          expect(view.current().banners.find((b) => b.id === recoveryId)).toEqual(banner);

          second.ui.confirmAnswer = true;
          view.send({ type: 'banner.action', bannerId: recoveryId, actionId: 'recover-now' });
          await until('the banner to be replaced', () =>
            view.current().banners.some((b) => b.id === recoveryId && b.dismissible),
          );
          expect(second.ui.callsOf('confirm')[1]?.[0]).toEqual({
            title: 'Recover the interrupted turn now?',
            detail:
              'Do this only after Claude Code from that turn has stopped. If it is still running, its later changes will not be tracked.',
            confirmLabel: 'Recover Now',
          });
          // What the recovery wrote shows up in every view of the folder, with no reload.
          await until('the recovery in the checkpoints', () =>
            view.current().checkpoints.some((item) => item.kind === 'recovery'),
          );
          await until('the changed file for review', () =>
            view.current().review.entries.some((item) => item.path === 'existing.txt'),
          );
          sibling.send({ type: 'resync' });
          expect(sibling.current().checkpoints.some((item) => item.kind === 'recovery')).toBe(true);
          expect(
            sibling.current().review.entries.some((item) => item.path === 'existing.txt'),
          ).toBe(true);
          sibling.expectMirror();
          const done = view.current().banners.find((b) => b.id === recoveryId);
          expect(done?.action).toBeUndefined();
          expect(view.toasts).toEqual([{ level: 'warning', text: done?.text }]);
          await expect(
            fs.access(join(second.storage, 'workspace', FOLDER_KEY, 'journal.json')),
          ).rejects.toThrow();
          view.expectMirror();
        } finally {
          await second.dispose();
        }
      } finally {
        child.kill('SIGKILL');
      }
    });

    it('is tried again when an Agent turn is refused, so a process that has stopped is picked up', async () => {
      const child = spawn('sleep', ['60'], { stdio: 'ignore' });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        const first = await leftBehind(child);
        const second = await createHarness({
          reuse: first,
          realDefaults: true,
          noStart: true,
          scenario: textScenario('ok'),
        });
        try {
          const view = second.attach();
          await second.controller.start();
          expect(view.current().banners.find((b) => b.id === recoveryId)?.dismissible).toBe(false);

          child.kill('SIGKILL');
          await exited;
          sendAgent(view, 'try now');
          await until('the refused turn', () => {
            const status = view.state?.active?.turns[0]?.status;
            return status === 'error';
          });
          expect(second.requests).toHaveLength(0);
          await until('the banner to change', () =>
            view.current().banners.some((b) => b.id === recoveryId && b.dismissible),
          );
          expect(second.ui.callsOf('confirm')).toEqual([]);

          // With the recovery done, the next Agent turn goes ahead.
          const turn = await agentTurn(second, view, 'now');
          expect(turn.status).toBe('completed');
          view.expectMirror();
        } finally {
          await second.dispose();
        }
      } finally {
        child.kill('SIGKILL');
      }
    });
  });

  it('runs an Agent turn from an approved plan through the agent policy', async () => {
    const h = await harness({
      sequence: [
        {
          scenario: {
            steps: [
              stateEvent('running'),
              initEvent(),
              {
                callTool: {
                  name: 'submit_plan',
                  arguments: {
                    title: 'Make a file',
                    objective: 'Write a.txt.',
                    stages: [{ id: 's1', title: 'Write', description: 'Do it.' }],
                  },
                  saveAs: 'result',
                },
              },
              assistantText('Planned.'),
              ...resultStep('Planned.'),
            ],
          },
        },
        writeScenario('a.txt', 'from the plan'),
      ],
    });
    autoEdits(h);
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'plan it', mode: 'plan', model: 'default' });
    await until('the conversation', () => view.state?.active !== null);
    await finishedTurn(h, view);
    const plan = view.active().plan as PlanDoc;
    expect(plan.versions).toHaveLength(1);

    view.send({
      type: 'plan.approve',
      planId: plan.id,
      version: 1,
      contentHash: plan.versions[0]?.contentHash,
    });
    await until('the execution turn', () => view.active().turns.length === 2);
    const turn = await finishedTurn(h, view);
    expect(turn.mode).toBe('agent');
    expect(turn.status).toBe('completed');
    expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('from the plan');
    expect(operations(h).flatMap((op) => op.changes.map((change) => change.path))).toEqual([
      'a.txt',
    ]);
    view.expectMirror();
  });
});

function textScenarioSpec(): ScenarioSpec {
  return { scenario: textScenario('ok') };
}
