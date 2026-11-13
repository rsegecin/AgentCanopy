import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type { PermissionPrompt } from '../../shared';
import {
  FOLDER_KEY,
  assistantText,
  assistantToolUse,
  createHarness,
  finishedTurn,
  providerStatus,
  resultStep,
  sleep,
  stateEvent,
  streamedText,
  stubProvider,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type TestView,
} from './test-support';

vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const allowed = { decision: 'accept', source: 'user_temporary' } as const;

// ---- scenarios and helpers -------------------------------------------------------------------------------

function writes(name: string, content: string): ScenarioSpec {
  const id = `toolu_${name}`;
  const input = { file_path: `$CWD/${name}`, content };
  return {
    record: true,
    scenario: {
      steps: [
        stateEvent('running'),
        initEvent(),
        assistantToolUse(id, 'Write', input),
        {
          permission: {
            toolName: 'Write',
            input,
            toolUseId: id,
            onAllow: [
              { writeFile: { path: `$CWD/${name}`, content } },
              userToolResult(id, 'written', { decision: allowed }),
            ],
            onDeny: [],
          },
        },
        assistantText('done'),
        ...resultStep('done'),
      ],
    },
  };
}

const hanging: ScenarioSpec = {
  record: true,
  scenario: { steps: [...streamedText(['working']), { hang: true }] },
};

async function started(
  sequence: ScenarioSpec[],
  options: HarnessOptions = {},
): Promise<{ h: Harness; view: TestView }> {
  const h = await createHarness({ realDefaults: true, noStart: true, sequence, ...options });
  harnesses.push(h);
  h.env.settingsValue = { ...DEFAULT_SETTINGS, editApproval: 'auto' };
  await h.controller.start();
  await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
  return { h, view: h.attach() };
}

async function agentTurn(h: Harness, view: TestView, text = 'go'): Promise<void> {
  const active = view.state?.active;
  const before = active?.turns.length ?? 0;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'agent',
    model: 'default',
  });
  await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > before);
  await finishedTurn(h, view);
}

// ---- deleting stored file data ----------------------------------------------------------------------------

describe('deleting stored file contents and change history', () => {
  async function withHistory() {
    const made = await started([writes('a.txt', 'made by the agent\n')]);
    await agentTurn(made.h, made.view);
    await until('a pending change and a checkpoint', () => {
      const state = made.view.current();
      return state.review.entries.length === 1 && state.checkpoints.length === 1;
    });
    return made;
  }

  it('does nothing when the confirmation is declined', async () => {
    const { h, view } = await withHistory();
    h.ui.confirmAnswer = false;
    await h.controller.purgeStoredFileData(FOLDER_KEY);
    expect(h.ui.callsOf('confirm')).toHaveLength(1);
    expect(view.current().review.entries).toHaveLength(1);
    expect(view.current().checkpoints).toHaveLength(1);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('deletes the data and tells every view, leaving files, conversations and plans alone', async () => {
    const { h, view } = await withHistory();
    const other = h.attach();
    const elsewhere = h.attach();
    // A restore preview is part of what is deleted.
    view.send({
      type: 'checkpoint.preview',
      operationId: view.current().checkpoints[0]?.operationId,
    });
    await until('the preview', () => view.current().restorePreview !== null);
    const engine = h.engine();
    const service = h.checkpoints();
    if (!engine || !service) throw new Error('no review or checkpoint service');
    let reviewHeard = 0;
    let checkpointsHeard = 0;
    engine.onDidChange(() => {
      reviewHeard += 1;
    });
    service.onDidChange(() => {
      checkpointsHeard += 1;
    });

    await h.controller.purgeStoredFileData(FOLDER_KEY);

    expect(h.ui.callsOf('confirm')[0]?.[0]).toEqual({
      title: 'Delete stored file contents and change history?',
      detail:
        'For work: the file contents AgentCanopy captured, the list of pending agent changes and the checkpoint history are deleted. Files in the folder are not touched, and conversations and plans are kept. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    const done = { level: 'info', text: 'Stored file contents and change history were deleted.' };
    await until('the lists to empty', () => {
      return (
        view.current().review.entries.length === 0 &&
        view.current().checkpoints.length === 0 &&
        other.current().review.entries.length === 0 &&
        other.current().checkpoints.length === 0
      );
    });
    expect(view.current().restorePreview).toBeNull();
    expect(view.toasts).toEqual([done]);
    expect(other.toasts).toEqual([done]);
    expect(reviewHeard).toBeGreaterThan(0);
    expect(checkpointsHeard).toBeGreaterThan(0);

    // The files, the conversation and what it shows are still there.
    expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('made by the agent\n');
    expect(view.current().conversations).toHaveLength(1);
    expect(view.active().turns).toHaveLength(1);
    // The folder is read again afterwards.
    await until('the baseline to be ready again', () => view.current().baseline.state === 'ready');
    view.expectMirror();
    other.expectMirror();
    elsewhere.expectMirror();
  });

  it("is refused with the tracker's message while an Agent turn runs", async () => {
    const { h, view } = await started([writes('a.txt', 'one\n'), hanging]);
    await agentTurn(h, view);
    await until('a pending change', () => view.current().review.entries.length === 1);
    view.send({
      type: 'turn.send',
      conversationId: view.active().meta.id,
      text: 'keep going',
      mode: 'agent',
      model: 'default',
    });
    await until('the turn to run', () => h.requests.length === 2);

    await h.controller.purgeStoredFileData(FOLDER_KEY);
    expect(view.toasts).toHaveLength(1);
    expect(view.toasts[0]?.level).toBe('warning');
    expect(view.toasts[0]?.text.length).toBeGreaterThan(0);
    expect(view.current().review.entries).toHaveLength(1);
    expect(view.current().checkpoints.length).toBeGreaterThan(0);

    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
    view.expectMirror();
  });

  it('is refused while a configuration change waits for a decision', async () => {
    const { h, view } = await started([writes('.vscode/tasks.json', '{"version":"2.0.0"}\n')]);
    view.send({ type: 'turn.send', text: 'go', mode: 'agent', model: 'default' });
    await until('the prompt', () => (view.state?.active?.prompts.length ?? 0) > 0);
    const prompt = view.active().prompts[0] as PermissionPrompt;
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'permission', choice: 'allow-once' },
    });
    await finishedTurn(h, view);
    await until('the change', () => view.current().review.configChanges.length === 1);

    await h.controller.purgeStoredFileData(FOLDER_KEY);
    expect(view.toasts).toHaveLength(1);
    expect(view.toasts[0]?.level).toBe('warning');
    expect(view.toasts[0]?.text.length).toBeGreaterThan(0);
    expect(view.current().review.configChanges).toHaveLength(1);
    expect(view.current().checkpoints.length).toBeGreaterThan(0);
    view.expectMirror();
  });

  it('is not available for an unknown folder, or without the default tracking', async () => {
    const { h, view } = await started([{ scenario: { steps: [] } }]);
    await h.controller.purgeStoredFileData('no-such-folder' as typeof FOLDER_KEY);
    await sleep(30);
    // No view shows that folder, so the message is only logged.
    expect(h.logger.has('info', 'a review message had no view to show it')).toBe(true);
    expect(h.ui.callsOf('confirm')).toEqual([]);

    const plain = await createHarness({});
    harnesses.push(plain);
    const plainView = plain.attach();
    await plain.controller.purgeStoredFileData(FOLDER_KEY);
    expect(plainView.toasts).toEqual([{ level: 'info', text: 'This is not available yet.' }]);
    expect(plain.ui.callsOf('confirm')).toEqual([]);
    view.expectMirror();
  });
});

// ---- signing in ----------------------------------------------------------------------------------------------

describe('signing in', () => {
  const signedOut = providerStatus({
    auth: 'signed-out',
    problems: ['Claude Code is not signed in. Use Sign in to open a terminal and run its login.'],
  });

  it("passes the provider's own command to the terminal, from a message and from the banner", async () => {
    const command = { executable: '/opt/claude/bin/claude', args: ['auth', 'login'] };
    const provider = { ...stubProvider(signedOut), signInCommand: () => command };
    const h = await createHarness({ providers: [provider] });
    harnesses.push(h);
    const view = h.attach();
    view.send({ type: 'provider.signIn' });
    view.send({
      type: 'banner.action',
      bannerId: 'provider-problem:signed-out',
      actionId: 'sign-in',
    });
    await until('both calls', () => h.ui.callsOf('startSignIn').length === 2);
    expect(h.ui.callsOf('startSignIn')).toEqual([
      ['claude-code', command],
      ['claude-code', command],
    ]);
    view.expectMirror();
  });

  it('passes nothing extra when the provider does not know where its program is', async () => {
    const provider = { ...stubProvider(signedOut), signInCommand: () => undefined };
    const h = await createHarness({ providers: [provider] });
    harnesses.push(h);
    const view = h.attach();
    view.send({ type: 'provider.signIn' });
    await until('the call', () => h.ui.callsOf('startSignIn').length === 1);
    expect(h.ui.callsOf('startSignIn')).toEqual([['claude-code']]);

    const bare = await createHarness({ providers: [stubProvider(signedOut)] });
    harnesses.push(bare);
    bare.attach().send({ type: 'provider.signIn' });
    await until('the call', () => bare.ui.callsOf('startSignIn').length === 1);
    expect(bare.ui.callsOf('startSignIn')).toEqual([['claude-code']]);
  });
});

// ---- an always-allow rule that cannot be kept ---------------------------------------------------------------

describe('a rule to always allow a command', () => {
  function bash(): ScenarioSpec {
    const input = { command: 'echo hello' };
    return {
      record: true,
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          assistantToolUse('toolu_b', 'Bash', input),
          {
            permission: {
              toolName: 'Bash',
              input,
              toolUseId: 'toolu_b',
              onAllow: [userToolResult('toolu_b', 'ran', { decision: allowed })],
              onDeny: [],
            },
          },
          assistantText('done'),
          ...resultStep('done'),
        ],
      },
    };
  }

  async function alwaysAllow(h: Harness, view: TestView): Promise<void> {
    view.send({ type: 'turn.send', text: 'go', mode: 'agent', model: 'default' });
    await until('the prompt', () => (view.state?.active?.prompts.length ?? 0) > 0);
    const prompt = view.active().prompts[0] as PermissionPrompt;
    view.send({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'permission', choice: 'allow-always' },
    });
    await finishedTurn(h, view);
  }

  it('is reported when it could not be stored: the command was allowed only once', async () => {
    const { h, view } = await started([bash()]);
    const rules = h.rules();
    if (!rules) throw new Error('no rule store');
    rules.add = () => Promise.reject(new Error('the disk is full'));

    await alwaysAllow(h, view);
    expect(view.active().turns[0]?.status).toBe('completed');
    expect(rules.list(FOLDER_KEY)).toEqual([]);
    expect(view.toasts).toEqual([
      {
        level: 'warning',
        text: 'The command was allowed this once, but the rule to always allow it could not be saved.',
      },
    ]);
    view.expectMirror();
  });

  it('is not reported when it was stored, nor when the confirmation was declined', async () => {
    const stored = await started([bash()]);
    await alwaysAllow(stored.h, stored.view);
    expect(stored.h.rules()?.list(FOLDER_KEY)).toHaveLength(1);
    expect(stored.view.toasts).toEqual([]);

    // Declined: it was only allowed once, as the user chose, and nothing is said about a rule.
    const declined = await started([bash()]);
    declined.h.ui.confirmAnswer = false;
    await alwaysAllow(declined.h, declined.view);
    expect(declined.h.rules()?.list(FOLDER_KEY)).toEqual([]);
    expect(declined.view.toasts).toEqual([]);
    stored.view.expectMirror();
    declined.view.expectMirror();
  });
});
