import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import type { AssistantMessage, PermissionPrompt, Prompt, ToolCallView } from '../../shared';
import type { NewPrompt, TurnPolicy } from '../contracts';
import { createConversationStore } from '../conversations/store';
import { alwaysAllowDetail, directoryDialog, editDirectoryDialog, switchDialog } from './prompts';
import { shownPath } from './text';
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

  /** A prompt that offers to always allow a directory or a site, for the workspace folder. */
  function outsidePrompt(
    toolCallId: string,
    kind: 'read-directory' | 'edit-directory' | 'web-site',
    rule: string,
  ): NewPrompt {
    const editing = kind === 'edit-directory';
    return {
      kind: 'permission',
      toolCallId,
      toolName: editing ? 'Edit' : 'Read',
      category: editing ? 'outside-workspace' : 'read-outside',
      title: editing ? 'Edit a file outside the workspace' : 'Read a file outside the workspace',
      detail: rule,
      inputPreview: '',
      choices: [...choices],
      alwaysRule: { kind, rule, runsProjectCode: false },
    };
  }

  it.each([
    [
      'a directory',
      'read-directory',
      'D:\\libs\\shared',
      (workspace: string) =>
        `Directory: D:\\libs\\shared\nWorkspace folder: ${workspace}\n\nReads and searches in this directory and below will no longer ask, in Ask, Plan and Agent mode, for this workspace folder. What is read is sent to the model.\n\nYou can remove this under Permissions.`,
    ],
    [
      'a directory for edits',
      'edit-directory',
      'D:\\libs\\shared',
      (workspace: string) =>
        `Directory: D:\\libs\\shared\nWorkspace folder: ${workspace}\n\nEdits to files in this directory and below will no longer ask, in Agent mode, for this workspace folder. Review and checkpoints do not cover files outside the workspace folder: AgentCanopy cannot show or undo these edits.\n\nReads and searches in this directory and below will no longer ask either, in Ask, Plan and Agent mode. What is read is sent to the model.\n\nProtected files (such as .git, .vscode, .claude and .env) and credential locations still ask.\n\nYou can remove this under Permissions.`,
    ],
    [
      'a site',
      'web-site',
      'docs.example.com:8080',
      (workspace: string) =>
        `Site: docs.example.com:8080\nWorkspace folder: ${workspace}\n\nAny address on this site will be fetched without asking, for this workspace folder. An address can carry file contents to the site. A redirect to another site is reported to the agent, and its next request is judged on its own.\n\nYou can remove this under Permissions.`,
    ],
  ] as const)(
    'names %s and the workspace folder in the confirmation, with no stores behind it',
    async (_name, kind, rule, expected) => {
      const h = await harness({
        scenario: bashScenario(),
        policy: policyAsking((id) => outsidePrompt(id, kind, rule)),
      });
      const view = h.attach();
      await answerPermission(h, view, 'allow-always');
      const [input] = h.ui.callsOf('confirm')[0] as [
        { title: string; detail: string; confirmLabel: string },
      ];
      expect(input.title).toBe('Always allow this?');
      expect(input.confirmLabel).toBe('Always allow');
      expect(input.detail).toBe(expected(shownPath(h.workspace, homedir())));
      const prompt = view.active().prompts[0];
      expect(prompt?.kind === 'permission' && prompt.answered).toBe('allow-always');
      // The application was given its policy, so it has no stores to check: nothing to warn about.
      expect(view.toasts).toEqual([]);
    },
  );

  it.each([
    ['a directory', 'read-directory', 'D:\\libs\\shared'],
    ['a directory for edits', 'edit-directory', 'D:\\libs\\shared'],
    ['a site', 'web-site', 'docs.example.com'],
  ] as const)(
    'takes an always answer for %s as allow once, with no dialog, when the folder is not open',
    async (_name, kind, rule) => {
      const h = await harness({
        scenario: bashScenario(),
        policy: policyAsking((id) => outsidePrompt(id, kind, rule)),
      });
      const view = h.attach();
      const prompt = await startAndWaitForPrompt(h, view);
      h.env.folderList = [];
      h.controller.environmentChanged();
      view.send({
        type: 'prompt.answer',
        promptId: prompt.id,
        displayHash: prompt.displayHash,
        answer: { kind: 'permission', choice: 'allow-always' },
      });
      await finishedTurn(h, view);
      expect(h.ui.callsOf('confirm')).toEqual([]);
      const settled = view.active().prompts[0];
      expect(settled?.kind === 'permission' && settled.answered).toBe('allow-once');
    },
  );
});

describe('the text of the confirmations of permissions', () => {
  const FOLDER = 'D:\\projects\\app';
  const permissionPrompt = (
    rule: NonNullable<PermissionPrompt['alwaysRule']>,
  ): PermissionPrompt => ({
    id: 'p' as PermissionPrompt['id'],
    conversationId: 'c' as PermissionPrompt['conversationId'],
    turnId: 't' as PermissionPrompt['turnId'],
    toolCallId: 'tool',
    createdAt: 0,
    state: 'pending',
    displayHash: 'h',
    kind: 'permission',
    toolName: 'Bash',
    category: 'command',
    title: 'Run',
    detail: 'the detail',
    inputPreview: '',
    choices: ['allow-once', 'allow-always', 'deny'],
    alwaysRule: rule,
  });
  const PROJECT_CODE = 'This command runs code from the project, which can do anything you can do.';

  it('is the rule itself for a command or a tool, as before kinds existed', () => {
    expect(
      alwaysAllowDetail(permissionPrompt({ rule: 'Bash(npm test)', runsProjectCode: true })),
    ).toBe(`Bash(npm test)\n\n${PROJECT_CODE}`);
    expect(
      alwaysAllowDetail(
        permissionPrompt({ kind: 'command', rule: 'Bash(git status)', runsProjectCode: false }),
        FOLDER,
      ),
    ).toBe('Bash(git status)');
    expect(
      alwaysAllowDetail(
        permissionPrompt({ kind: 'command', rule: 'PowerShell(npm test)', runsProjectCode: true }),
        FOLDER,
      ),
    ).toBe(`PowerShell(npm test)\n\n${PROJECT_CODE}`);
    expect(
      alwaysAllowDetail(
        permissionPrompt({ kind: 'tool', rule: 'mcp__docs__search', runsProjectCode: false }),
        FOLDER,
      ),
    ).toBe('mcp__docs__search');
  });

  it('names the directory and the workspace folder, with each sentence', () => {
    const detail = alwaysAllowDetail(
      permissionPrompt({
        kind: 'read-directory',
        rule: 'D:\\libs\\shared',
        runsProjectCode: false,
      }),
      FOLDER,
    );
    expect(detail).toBe(
      [
        `Directory: D:\\libs\\shared\nWorkspace folder: ${FOLDER}`,
        'Reads and searches in this directory and below will no longer ask, in Ask, Plan and Agent mode, for this workspace folder. What is read is sent to the model.',
        'You can remove this under Permissions.',
      ].join('\n\n'),
    );
    expect(directoryDialog('D:\\libs\\shared', FOLDER)).toEqual({
      title: 'Always allow reads in this folder?',
      detail,
      confirmLabel: 'Always allow',
    });
  });

  it('names the directory for edits and the workspace folder, and says review and checkpoints do not cover it', () => {
    const detail = alwaysAllowDetail(
      permissionPrompt({
        kind: 'edit-directory',
        rule: 'D:\\libs\\shared',
        runsProjectCode: false,
      }),
      FOLDER,
    );
    expect(detail).toBe(
      [
        `Directory: D:\\libs\\shared\nWorkspace folder: ${FOLDER}`,
        'Edits to files in this directory and below will no longer ask, in Agent mode, for this workspace folder. Review and checkpoints do not cover files outside the workspace folder: AgentCanopy cannot show or undo these edits.',
        'Reads and searches in this directory and below will no longer ask either, in Ask, Plan and Agent mode. What is read is sent to the model.',
        'Protected files (such as .git, .vscode, .claude and .env) and credential locations still ask.',
        'You can remove this under Permissions.',
      ].join('\n\n'),
    );
    expect(detail).toContain('Review and checkpoints do not cover');
    expect(editDirectoryDialog('D:\\libs\\shared', FOLDER)).toEqual({
      title: 'Always allow edits in this folder?',
      detail,
      confirmLabel: 'Always allow',
    });
  });

  it('names the site and the workspace folder, with each sentence', () => {
    expect(
      alwaysAllowDetail(
        permissionPrompt({ kind: 'web-site', rule: 'docs.example.com', runsProjectCode: false }),
        FOLDER,
      ),
    ).toBe(
      [
        `Site: docs.example.com\nWorkspace folder: ${FOLDER}`,
        'Any address on this site will be fetched without asking, for this workspace folder. An address can carry file contents to the site. A redirect to another site is reported to the agent, and its next request is judged on its own.',
        'You can remove this under Permissions.',
      ].join('\n\n'),
    );
  });

  it('is written for each switch, with the title and the label', () => {
    expect(switchDialog('read-outside', FOLDER)).toEqual({
      title: 'Allow reads outside the folder without asking?',
      detail: [
        `Workspace folder: ${FOLDER}`,
        'In this workspace folder the agent will read and search files anywhere on this machine without asking, in Ask, Plan and Agent mode. What it reads is sent to the model.',
        "Credential locations (except Claude Code's own memory for this folder) and AgentCanopy's own storage still ask. Edits outside the folder still ask, except in folders you allowed for edits.",
        'You can turn this off under Permissions.',
      ].join('\n\n'),
      confirmLabel: 'Allow',
    });
    expect(switchDialog('web-fetch', FOLDER)).toEqual({
      title: 'Allow web fetches without asking?',
      detail: [
        `Workspace folder: ${FOLDER}`,
        'In this workspace folder any web address will be fetched without asking. A page can carry instructions for the agent, and an address can carry file contents out.',
        'In Ask and Plan mode this applies only while agentCanopy.ask.webTools is on.',
        'You can turn this off under Permissions.',
      ].join('\n\n'),
      confirmLabel: 'Allow',
    });
    expect(switchDialog('web-search', FOLDER)).toEqual({
      title: 'Allow web searches without asking?',
      detail: [
        `Workspace folder: ${FOLDER}`,
        'In this workspace folder every web search will run without asking. The query leaves this machine.',
        'In Ask and Plan mode this applies only while agentCanopy.ask.webTools is on.',
        'You can turn this off under Permissions.',
      ].join('\n\n'),
      confirmLabel: 'Allow',
    });
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
