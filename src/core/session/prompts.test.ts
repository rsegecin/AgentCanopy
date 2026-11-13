import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import type { AssistantMessage, Prompt, ToolCallView } from '../../shared';
import type { NewPrompt, TurnPolicy } from '../contracts';
import { createConversationStore } from '../conversations/store';
import {
  assistantText,
  assistantToolUse,
  createHarness,
  finishedTurn,
  resultStep,
  sendAndFinish,
  sleep,
  stateEvent,
  until,
  userToolResult,
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

const allowed = { decision: 'accept', source: 'user_temporary' } as const;
const rejected = { decision: 'reject', source: 'user_reject' } as const;

/** The fake CLI asks to use AskUserQuestion; what the host answers decides what happens next. */
function questionScenario() {
  return {
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
            { writeFile: { path: 'answers.json', content: '$UPDATED.answers' } },
            userToolResult('toolu_q', 'answered', { decision: allowed }),
          ],
          onDeny: [
            userToolResult('toolu_q', 'The user did not answer.', {
              isError: true,
              decision: rejected,
              nonExecutionKind: 'permission-rule',
            }),
          ],
        },
      },
      assistantText('thanks'),
      ...resultStep('thanks'),
    ],
  };
}

function pending(view: TestView): Prompt | undefined {
  return view.state?.active?.prompts.find((prompt) => prompt.state === 'pending');
}

async function startAndWaitForPrompt(h: Harness, view: TestView): Promise<Prompt> {
  view.send({ type: 'turn.send', text: 'ask me', mode: 'ask', model: 'default' });
  await until('a pending prompt', () => pending(view) !== undefined);
  const prompt = pending(view);
  if (!prompt) throw new Error('no prompt');
  void h;
  return prompt;
}

function assistant(view: TestView): AssistantMessage {
  const message = view.active().messages.find((m): m is AssistantMessage => m.role === 'assistant');
  if (!message) throw new Error('no assistant message');
  return message;
}

describe('AskUserQuestion', () => {
  it('round-trips an answer, ignoring everything that is not the first valid answer', async () => {
    const h = await harness({ scenario: questionScenario() });
    const view = h.attach();
    const prompt = await startAndWaitForPrompt(h, view);

    expect(prompt.kind).toBe('question');
    expect(prompt.toolCallId).toBe('toolu_q');
    expect(prompt.displayHash.length).toBeGreaterThan(10);
    const message = assistant(view);
    expect(message.parts.filter((p) => p.kind === 'prompt')).toEqual([
      { kind: 'prompt', promptId: prompt.id },
    ]);
    const tool = message.parts.find((p) => p.kind === 'tool');
    expect((tool as { call: ToolCallView }).call.status).toBe('awaiting-approval');
    expect(view.current().conversations[0]?.pendingPrompts).toBe(1);

    // A second view on the same conversation sees the same prompt.
    const other = h.attach();
    other.send({ type: 'conversation.open', conversationId: view.active().meta.id });
    await until('the second view to show it', () => pending(other)?.id === prompt.id);

    const answer = { kind: 'question', answers: { 'Which colour?': ['Red', 'Blue'] } };
    const attempts = [
      // Wrong display hash.
      { type: 'prompt.answer', promptId: prompt.id, displayHash: 'not-the-hash', answer },
      // Wrong kind.
      {
        type: 'prompt.answer',
        promptId: prompt.id,
        displayHash: prompt.displayHash,
        answer: { kind: 'permission', choice: 'allow-once' },
      },
      // Unknown prompt id.
      {
        type: 'prompt.answer',
        promptId: 'unknown-prompt',
        displayHash: prompt.displayHash,
        answer,
      },
      // An answer for a question that was not asked.
      {
        type: 'prompt.answer',
        promptId: prompt.id,
        displayHash: prompt.displayHash,
        answer: { kind: 'question', answers: { 'Something else?': ['x'] } },
      },
    ];
    for (const attempt of attempts) view.send(attempt);
    await sleep(80);
    expect(pending(view)?.id).toBe(prompt.id);
    expect(pending(other)?.id).toBe(prompt.id);
    expect(h.logger.entries.filter((e) => e.message.startsWith('ignored an answer'))).toHaveLength(
      4,
    );

    // The right answer settles it.
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer,
    });
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    for (const v of [view, other]) {
      const settled = v.active().prompts[0];
      expect(settled?.state).toBe('answered');
      expect(settled?.kind === 'question' && settled.answered).toEqual({
        'Which colour?': 'Red, Blue',
      });
    }
    // The fake CLI received the joined answers in updatedInput.
    const written = await fs.readFile(join(h.workspace, 'answers.json'), 'utf8');
    expect(JSON.parse(written)).toEqual({ 'Which colour?': 'Red, Blue' });
    const call = (assistant(view).parts.find((p) => p.kind === 'tool') as { call: ToolCallView })
      .call;
    expect(call.status).toBe('done');
    expect(call.approval).toBe('user');

    // A second answer is ignored.
    const before = view.current();
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'question', answers: { 'Which colour?': ['Blue'] } },
    });
    await sleep(60);
    expect(view.current()).toEqual(before);

    // It was stored with its final state.
    const store = createConversationStore({ dir: join(h.storage, 'conversations') });
    await store.init();
    const data = await store.load(view.active().meta.id);
    expect(data?.prompts[0]?.state).toBe('answered');
    await store.flush();

    view.expectMirror();
    other.expectMirror();
  });

  it('denies the call when the question cannot be shown', async () => {
    const scenario = questionScenario();
    const h = await harness({
      scenario: {
        steps: scenario.steps.map((step) => {
          const permission = (step as { permission?: { input: object } }).permission;
          return permission ? { permission: { ...permission, input: { questions: [] } } } : step;
        }),
      },
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'ask me');
    expect(turn.status).toBe('completed');
    expect(view.active().prompts).toEqual([]);
    const call = (assistant(view).parts.find((p) => p.kind === 'tool') as { call: ToolCallView })
      .call;
    expect(call.status).toBe('denied');
    expect(call.approval).toBe('policy');
    await expect(fs.access(join(h.workspace, 'answers.json'))).rejects.toThrow();
  });
});

describe('a prompt that is not answered', () => {
  it('is cancelled by turn.cancel, ending the turn as interrupted without an error', async () => {
    const h = await harness({ scenario: questionScenario() });
    const view = h.attach();
    await startAndWaitForPrompt(h, view);
    const id = view.active().meta.id;
    view.send({ type: 'turn.cancel', conversationId: id });
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('interrupted');
    expect(turn.error).toBeUndefined();
    expect(view.active().prompts[0]?.state).toBe('cancelled');
    expect(assistant(view).parts.filter((p) => p.kind === 'notice')).toEqual([]);
    expect(view.active().activity).toBeNull();
    expect(view.current().conversations[0]?.pendingPrompts).toBe(0);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('expires when the request is aborted because the CLI went away', async () => {
    const h = await harness({ scenario: questionScenario() });
    const view = h.attach();
    await startAndWaitForPrompt(h, view);
    h.handles[0]?.kill();
    await finishedTurn(h, view);
    expect(view.active().prompts[0]?.state).toBe('expired');
    expect(view.current().conversations[0]?.pendingPrompts).toBe(0);
    const call = (assistant(view).parts.find((p) => p.kind === 'tool') as { call: ToolCallView })
      .call;
    expect(call.status).toBe('not-run');
    view.expectMirror();
  });

  it('is cancelled when the application shuts down, and the answer that comes late is ignored', async () => {
    const h = await harness({ scenario: questionScenario() });
    const view = h.attach();
    const prompt = await startAndWaitForPrompt(h, view);
    await h.controller.dispose();
    expect(h.controller.runningTurns()).toBe(0);
    const store = createConversationStore({ dir: join(h.storage, 'conversations') });
    await store.init();
    const data = await store.load(view.active().meta.id);
    expect(data?.prompts[0]?.state).toBe('cancelled');
    expect(data?.turns[0]?.status).toBe('interrupted');
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'question', answers: { 'Which colour?': ['Red'] } },
    });
    await store.flush();
  });
});

describe('permission prompts and "allow always"', () => {
  const choices = ['allow-once', 'allow-always', 'deny'] as const;

  function policyAsking(prompt: (toolCallId: string) => NewPrompt): TurnPolicy {
    return {
      profile: () => ({ kind: 'read-only', webTools: false, planTool: false }),
      async decide(request, context) {
        const answer = await context.askUser(prompt(request.toolCallId));
        if (answer?.kind === 'permission' && answer.choice !== 'deny') {
          return { response: { behavior: 'allow' }, approval: 'user' };
        }
        return { response: { behavior: 'deny', message: 'Denied by the user.' }, approval: 'user' };
      },
    };
  }

  function bashScenario() {
    return {
      steps: [
        stateEvent('running'),
        initEvent(),
        assistantToolUse('toolu_b', 'Bash', { command: 'npm test' }),
        {
          permission: {
            toolName: 'Bash',
            input: { command: 'npm test' },
            toolUseId: 'toolu_b',
            onAllow: [
              { writeFile: { path: 'ran.txt', content: 'ran' } },
              userToolResult('toolu_b', 'ok', { decision: allowed }),
            ],
            onDeny: [
              userToolResult('toolu_b', 'Denied by the user.', {
                isError: true,
                decision: rejected,
                nonExecutionKind: 'permission-rule',
              }),
            ],
          },
        },
        ...resultStep('done'),
      ],
    };
  }

  function bashPrompt(toolCallId: string, offered: readonly string[] = choices): NewPrompt {
    return {
      kind: 'permission',
      toolCallId,
      toolName: 'Bash',
      category: 'command',
      title: 'Run a terminal command',
      detail: 'npm test',
      inputPreview: '{"command":"npm test"}',
      choices: [...offered] as (typeof choices)[number][],
      alwaysRule: { rule: 'Bash(npm test)', runsProjectCode: true },
    };
  }

  async function answerPermission(
    h: Harness,
    view: TestView,
    choice: 'allow-once' | 'allow-always' | 'deny',
  ): Promise<void> {
    const prompt = await startAndWaitForPrompt(h, view);
    expect(prompt.kind).toBe('permission');
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'permission', choice },
    });
    await finishedTurn(h, view);
  }

  it('asks for a native confirmation first and records the always answer when it is given', async () => {
    const h = await harness({
      scenario: bashScenario(),
      policy: policyAsking((id) => bashPrompt(id)),
    });
    h.ui.confirmAnswer = true;
    const view = h.attach();
    await answerPermission(h, view, 'allow-always');
    const confirms = h.ui.callsOf('confirm');
    expect(confirms).toHaveLength(1);
    const [input] = confirms[0] as [{ title: string; detail: string; confirmLabel: string }];
    expect(input.title).toBe('Always allow this?');
    expect(input.detail).toContain('Bash(npm test)');
    expect(input.detail).toContain(
      'This command runs code from the project, which can do anything you can do.',
    );
    const prompt = view.active().prompts[0];
    expect(prompt?.kind === 'permission' && prompt.answered).toBe('allow-always');
    expect(await fs.readFile(join(h.workspace, 'ran.txt'), 'utf8')).toBe('ran');
    view.expectMirror();
  });

  it('treats an always answer as allow once when the confirmation is declined', async () => {
    const h = await harness({
      scenario: bashScenario(),
      policy: policyAsking((id) => bashPrompt(id)),
    });
    h.ui.confirmAnswer = false;
    const view = h.attach();
    await answerPermission(h, view, 'allow-always');
    expect(h.ui.callsOf('confirm')).toHaveLength(1);
    const prompt = view.active().prompts[0];
    expect(prompt?.kind === 'permission' && prompt.answered).toBe('allow-once');
    expect(await fs.readFile(join(h.workspace, 'ran.txt'), 'utf8')).toBe('ran');
  });

  it('does not ask for a confirmation for allow once or deny', async () => {
    const h = await harness({
      scenario: bashScenario(),
      policy: policyAsking((id) => bashPrompt(id)),
    });
    const view = h.attach();
    await answerPermission(h, view, 'deny');
    expect(h.ui.callsOf('confirm')).toHaveLength(0);
    const prompt = view.active().prompts[0];
    expect(prompt?.kind === 'permission' && prompt.answered).toBe('deny');
    const call = (assistant(view).parts.find((p) => p.kind === 'tool') as { call: ToolCallView })
      .call;
    expect(call.status).toBe('denied');
    await expect(fs.access(join(h.workspace, 'ran.txt'))).rejects.toThrow();
  });

  it('ignores a choice the prompt does not offer', async () => {
    const h = await harness({
      scenario: bashScenario(),
      policy: policyAsking((id) => bashPrompt(id, ['allow-once', 'deny'])),
    });
    const view = h.attach();
    const prompt = await startAndWaitForPrompt(h, view);
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'permission', choice: 'allow-always' },
    });
    await sleep(80);
    expect(pending(view)?.id).toBe(prompt.id);
    expect(h.ui.callsOf('confirm')).toHaveLength(0);
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'permission', choice: 'allow-once' },
    });
    await finishedTurn(h, view);
  });

  it('accepts only one answer while a confirmation is open', async () => {
    const h = await harness({
      scenario: bashScenario(),
      policy: policyAsking((id) => bashPrompt(id)),
    });
    let release: (value: boolean) => void = () => undefined;
    h.ui.confirm = () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      });
    const view = h.attach();
    const prompt = await startAndWaitForPrompt(h, view);
    const send = (choice: string) =>
      view.send({
        type: 'prompt.answer',
        promptId: prompt.id,
        displayHash: prompt.displayHash,
        answer: { kind: 'permission', choice },
      });
    send('allow-always');
    await sleep(30);
    send('deny');
    await sleep(30);
    release(true);
    await finishedTurn(h, view);
    const settled = view.active().prompts[0];
    expect(settled?.kind === 'permission' && settled.answered).toBe('allow-always');
    expect(await fs.readFile(join(h.workspace, 'ran.txt'), 'utf8')).toBe('ran');
  });
});

describe('a policy that fails', () => {
  it('denies the request and logs the failure', async () => {
    const h = await harness({
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          assistantToolUse('toolu_b', 'Bash', { command: 'ls' }),
          {
            permission: {
              toolName: 'Bash',
              input: { command: 'ls' },
              toolUseId: 'toolu_b',
              onAllow: [{ writeFile: { path: 'ran.txt', content: 'ran' } }],
              onDeny: [
                userToolResult('toolu_b', 'AgentCanopy could not decide on this request.', {
                  isError: true,
                  decision: rejected,
                  nonExecutionKind: 'permission-rule',
                }),
              ],
            },
          },
          ...resultStep('done'),
        ],
      },
      policy: {
        profile: () => ({ kind: 'read-only', webTools: false, planTool: false }),
        decide: () => Promise.reject(new Error('the policy broke')),
      },
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('completed');
    const call = (assistant(view).parts.find((p) => p.kind === 'tool') as { call: ToolCallView })
      .call;
    expect(call.status).toBe('denied');
    expect(call.approval).toBe('policy');
    expect(h.logger.has('error', 'failed to decide')).toBe(true);
    await expect(fs.access(join(h.workspace, 'ran.txt'))).rejects.toThrow();
  });
});
