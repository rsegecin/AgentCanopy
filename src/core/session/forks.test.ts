import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { reconstructContext } from '../conversations/reconstruct';
import { DEFAULT_SETTINGS } from '../../shared';
import type { AssistantMessage, ConversationId, MessageId } from '../../shared';
import {
  FOLDER_KEY,
  assistantText,
  assistantToolUse,
  createHarness,
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

vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function harness(options: HarnessOptions): Promise<Harness> {
  const h = await createHarness(options);
  harnesses.push(h);
  return h;
}

const text = (answer: string): ScenarioSpec => ({ record: true, scenario: textScenario(answer) });

const SESSION_LOST = {
  steps: [
    {
      emit: {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['No conversation found with session ID: gone'],
        session_id: '$SESSION',
      },
    },
    { exit: 1 },
  ],
};

const EXACT_UNAVAILABLE =
  'An exact copy of the conversation at an earlier message is turned off or not supported, so this branch continues from its visible messages as context.';
const SESSION_GONE =
  'Claude Code no longer has this session, so the conversation continues with its visible messages as context.';

// ---- helpers -----------------------------------------------------------------------------------------

function messageIds(view: TestView): MessageId[] {
  return view.active().messages.map((message) => message.id);
}

/** Branches the conversation the view shows and waits for the branch to be shown. */
async function branchAt(view: TestView, messageId: MessageId | undefined): Promise<ConversationId> {
  const parentId = view.active().meta.id;
  view.send({ type: 'conversation.fork', conversationId: parentId, messageId });
  await until('the branch to open', () => view.state?.active?.meta.id !== parentId);
  return parentId;
}

function noticesOf(message: AssistantMessage | undefined): string[] {
  return (message?.parts ?? []).flatMap((part) => (part.kind === 'notice' ? [part.text] : []));
}

function assistants(view: TestView): AssistantMessage[] {
  return view.active().messages.filter((m): m is AssistantMessage => m.role === 'assistant');
}

function argOf(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

/** A conversation with `count` answered turns. */
async function parentWithTurns(
  options: HarnessOptions,
  count: number,
): Promise<{ h: Harness; view: TestView; parentSession: string }> {
  const sequence = options.sequence ?? [];
  const h = await harness({ ...options, sequence });
  const view = h.attach();
  for (let index = 0; index < count; index += 1)
    await sendAndFinish(h, view, `question ${index + 1}`);
  const parentSession = view.active().meta.sessionId;
  if (!parentSession) throw new Error('the parent has no session');
  return { h, view, parentSession };
}

const answers = (n: number, extra: ScenarioSpec[] = []): ScenarioSpec[] => [
  ...Array.from({ length: n }, (_, index) => text(`answer ${index + 1}`)),
  ...extra,
];

// ---- the strategies ---------------------------------------------------------------------------------------

describe('the first turn of a branch', () => {
  it('stays pending until it has run, and runs in a new session when nothing is kept', async () => {
    const { h, view } = await parentWithTurns({ sequence: answers(1, [text('fresh')]) }, 1);
    const userId = messageIds(view)[0];
    await branchAt(view, userId);
    expect(view.active().messages).toEqual([]);
    expect(view.active().meta.fork).toMatchObject({ exactness: 'pending', lost: [] });
    expect(view.active().meta.sessionId).toBeUndefined();

    await sendAndFinish(h, view, 'a different question');
    const { argv, stdin } = await h.record(1);
    expect(argv).toContain('--session-id');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--fork-session');
    expect(stdin).not.toContain('<prior-conversation');
    expect(view.active().meta.fork).toMatchObject({ exactness: 'exact', lost: [] });
    expect(view.active().meta.sessionId).toBe(argOf(argv, '--session-id'));
    view.expectMirror();
  });

  it('is an exact copy of the whole session when the branch keeps everything the parent has', async () => {
    const { h, view, parentSession } = await parentWithTurns(
      { sequence: answers(1, [text('b')]) },
      1,
    );
    const answerId = messageIds(view)[1];
    await branchAt(view, answerId);
    expect(view.active().meta.fork?.exactness).toBe('pending');

    await sendAndFinish(h, view, 'follow-up');
    const { argv, stdin } = await h.record(1);
    expect(argOf(argv, '--resume')).toBe(parentSession);
    expect(argv).toContain('--fork-session');
    expect(argv).not.toContain('--resume-session-at');
    const branchSession = argOf(argv, '--session-id');
    expect(branchSession).toBeDefined();
    expect(branchSession).not.toBe(parentSession);
    expect(stdin).not.toContain('<prior-conversation');
    expect(view.active().meta.fork).toMatchObject({ exactness: 'exact', lost: [] });
    expect(view.active().meta.sessionId).toBe(branchSession);
    expect(assistants(view).flatMap((m) => noticesOf(m))).toEqual([]);

    // The next turn resumes the branch's own session.
    await sendAndFinish(h, view, 'and again');
    expect(h.requests[2]?.session).toEqual({ kind: 'resume', sessionId: branchSession });
    view.expectMirror();
  });

  it('is cut at the kept turn for an earlier message, when the provider and the setting allow it', async () => {
    const { h, view, parentSession } = await parentWithTurns(
      { sequence: answers(2, [text('b')]) },
      2,
    );
    const first = view.active().turns[0];
    expect(first?.forkPointEventId).toBeDefined();
    await branchAt(view, messageIds(view)[1]);
    expect(view.active().turns).toHaveLength(1);

    await sendAndFinish(h, view, 'a different follow-up');
    const { argv } = await h.record(2);
    expect(argOf(argv, '--resume')).toBe(parentSession);
    expect(argv).toContain('--fork-session');
    expect(argOf(argv, '--resume-session-at')).toBe(first?.forkPointEventId);
    expect(view.active().meta.fork).toMatchObject({ exactness: 'exact', lost: [] });
    expect(assistants(view).flatMap((m) => noticesOf(m))).toEqual([]);
    view.expectMirror();
  });

  it('is rebuilt from the visible messages when exact copies are switched off', async () => {
    const { h, view } = await parentWithTurns({ sequence: answers(2, [text('b')]) }, 2);
    h.env.settingsValue = { ...DEFAULT_SETTINGS, exactEarlierForks: false };
    await branchAt(view, messageIds(view)[1]);
    await sendAndFinish(h, view, 'a different follow-up');
    const { argv, stdin } = await h.record(2);
    expect(argv).not.toContain('--fork-session');
    expect(argv).not.toContain('--resume');
    expect(argv).toContain('--session-id');
    expect(stdin.startsWith('<prior-conversation reconstructed="true">')).toBe(true);
    expect(stdin).toContain('answer 1');
    expect(stdin).not.toContain('answer 2');
    const fork = view.active().meta.fork;
    expect(fork?.exactness).toBe('reconstructed');
    // What the rebuilt context leaves out is what the branch reports as lost.
    expect(fork?.lost).toEqual(reconstructContext(view.active().messages.slice(0, 2)).lost);
    expect(noticesOf(assistants(view)[1])).toEqual([EXACT_UNAVAILABLE]);
    expect(h.requests[2]?.session.kind).toBe('new');
    view.expectMirror();
  });

  it('is rebuilt when the provider cannot cut at a message, but still exact for the whole session', async () => {
    const { h, view } = await parentWithTurns(
      { forkAtMessage: 'none', sequence: answers(2, [text('b'), text('c')]) },
      2,
    );
    expect(view.current().provider?.capabilities.forkAtMessage).toBe('none');
    await branchAt(view, messageIds(view)[1]);
    await sendAndFinish(h, view, 'earlier branch');
    expect((await h.record(2)).stdin.startsWith('<prior-conversation reconstructed="true">')).toBe(
      true,
    );
    expect(view.active().meta.fork?.exactness).toBe('reconstructed');
    expect(noticesOf(assistants(view)[1])).toEqual([EXACT_UNAVAILABLE]);

    // Everything kept: a copy of the whole session needs no cut.
    const original = view.current().conversations.find((item) => item.fork === undefined)?.id;
    view.send({ type: 'conversation.open', conversationId: original });
    await until('the parent to open', () => view.state?.active?.meta.id === original);
    const parentId = view.active().meta.id;
    view.send({
      type: 'conversation.fork',
      conversationId: parentId,
      messageId: messageIds(view)[3],
    });
    await until('the second branch', () => view.state?.active?.meta.id !== parentId);
    await sendAndFinish(h, view, 'latest branch');
    expect((await h.record(3)).argv).toContain('--fork-session');
    expect(view.active().meta.fork?.exactness).toBe('exact');
    view.expectMirror();
  });

  it('is rebuilt when the parent no longer exists', async () => {
    const { h, view } = await parentWithTurns({ sequence: answers(1, [text('b')]) }, 1);
    const parentId = view.active().meta.id;
    await branchAt(view, messageIds(view)[1]);
    view.send({ type: 'conversation.delete', conversationId: parentId });
    await until('the parent to go', () => view.current().conversations.length === 1);

    await sendAndFinish(h, view, 'on its own');
    const { argv, stdin } = await h.record(1);
    expect(argv).not.toContain('--fork-session');
    expect(stdin.startsWith('<prior-conversation reconstructed="true">')).toBe(true);
    expect(view.active().meta.fork?.exactness).toBe('reconstructed');
    view.expectMirror();
  });

  it('is rebuilt when the parent has no session of its own', async () => {
    const h = await harness({ sequence: [text('b')], noStart: true });
    const { createConversationStore } = await import('../conversations/store');
    const store = createConversationStore({ dir: join(h.storage, 'conversations') });
    await store.init();
    const meta = await store.create({
      folder: FOLDER_KEY,
      providerId: 'claude-code',
      model: 'default',
      mode: 'ask',
      title: 'Seeded',
    });
    const {
      turn,
      userMessage,
      assistantMessage,
      text: textPart,
    } = await import('../conversations/test-support');
    await store.putTurn(meta.id, turn('t1', { mode: 'ask' }));
    await store.putMessage(meta.id, userMessage('u1', 't1', 'old question', { mode: 'ask' }));
    await store.putMessage(meta.id, assistantMessage('a1', 't1', [textPart('old answer')]));
    await store.flush();
    await h.controller.start();
    const view = h.attach();
    view.send({ type: 'conversation.open', conversationId: meta.id });
    await until('the conversation', () => view.state?.active?.meta.id === meta.id);
    await branchAt(view, view.active().messages[1]?.id);

    await sendAndFinish(h, view, 'new question');
    const { argv, stdin } = await h.record(0);
    expect(argv).not.toContain('--fork-session');
    expect(stdin).toContain('old answer');
    expect(view.active().meta.fork?.exactness).toBe('reconstructed');
  });

  it('falls back once to a rebuilt context when the provider no longer has the parent session', async () => {
    const { h, view } = await parentWithTurns(
      { sequence: [text('answer 1'), { scenario: SESSION_LOST }, text('rebuilt answer')] },
      1,
    );
    await branchAt(view, messageIds(view)[1]);
    const turn = await sendAndFinish(h, view, 'follow-up');
    expect(turn.status).toBe('completed');
    expect(h.requests).toHaveLength(3);
    expect(h.requests[1]?.session.kind).toBe('fork');
    expect(h.requests[2]?.session.kind).toBe('new');
    const { stdin } = await h.record(2);
    expect(stdin.startsWith('<prior-conversation reconstructed="true">')).toBe(true);
    expect(stdin).toContain('answer 1');
    const fork = view.active().meta.fork;
    expect(fork?.exactness).toBe('reconstructed');
    expect(fork?.lost).toEqual(reconstructContext(view.active().messages.slice(0, 2)).lost);
    expect(noticesOf(assistants(view).at(-1))).toEqual([SESSION_GONE]);
    const retried = h.requests[2]?.session;
    expect(view.active().meta.sessionId).toBe(
      retried?.kind === 'new' ? retried.sessionId : undefined,
    );
    view.expectMirror();
  });
});

// ---- forking while the parent runs ---------------------------------------------------------------------------

describe('branching from a conversation with a running turn', () => {
  const hanging: ScenarioSpec = {
    record: true,
    scenario: { steps: [...streamedText(['working']), { hang: true }] },
  };

  it('is refused for the latest message and allowed for an earlier one', async () => {
    const h = await harness({ sequence: [text('answer 1'), hanging, text('branch answer')] });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    const parentId = view.active().meta.id;
    view.send({
      type: 'turn.send',
      conversationId: parentId,
      text: 'two',
      mode: 'ask',
      model: 'default',
    });
    await until(
      'the second answer to start',
      () => assistants(view).length === 2 && assistants(view)[1]?.parts.length === 1,
    );
    const last = messageIds(view).at(-1);

    view.send({ type: 'conversation.fork', conversationId: parentId, messageId: last });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({
      level: 'warning',
      text: 'Wait for the turn to finish before branching from its last message.',
    });
    expect(view.current().conversations).toHaveLength(1);

    // An earlier message is fine: the branch keeps only turns that have ended.
    view.send({
      type: 'conversation.fork',
      conversationId: parentId,
      messageId: messageIds(view)[1],
    });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(view.active().turns).toHaveLength(1);

    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => view.state?.active?.meta.id === parentId);
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
    view.expectMirror();
  });
});

// ---- files newer than the branch ------------------------------------------------------------------------------

describe('the files of a branch', () => {
  const NEWER =
    'The files in the workspace include changes made after this point in the conversation. Branching does not change files; use the checkpoint history to restore them.';
  const allowed = { decision: 'accept', source: 'user_temporary' } as const;

  function writes(name: string | undefined, answer: string): ScenarioSpec {
    const steps: object[] = [stateEvent('running'), initEvent()];
    if (name !== undefined) {
      const input = { file_path: `$CWD/${name}`, content: `${name}\n` };
      steps.push(assistantToolUse(`toolu_${name}`, 'Write', input), {
        permission: {
          toolName: 'Write',
          input,
          toolUseId: `toolu_${name}`,
          onAllow: [
            { writeFile: { path: `$CWD/${name}`, content: `${name}\n` } },
            userToolResult(`toolu_${name}`, 'ok', { decision: allowed }),
          ],
          onDeny: [],
        },
      });
    }
    steps.push(assistantText(answer), ...resultStep(answer));
    return { record: true, scenario: { steps } };
  }

  async function agentTurns(specs: ScenarioSpec[]) {
    const h = await harness({ realDefaults: true, noStart: true, sequence: specs });
    h.env.settingsValue = { ...DEFAULT_SETTINGS, editApproval: 'auto' };
    await h.controller.start();
    await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
    const view = h.attach();
    for (let index = 0; index < specs.length; index += 1) {
      const active = view.state?.active;
      view.send({
        type: 'turn.send',
        ...(active ? { conversationId: active.meta.id } : {}),
        text: `step ${index + 1}`,
        mode: 'agent',
        model: 'default',
      });
      await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > index);
      await finishedTurn(h, view);
    }
    return { h, view };
  }

  it('say so when later turns changed files, and only then', async () => {
    const { view } = await agentTurns([writes('a.txt', 'one'), writes('b.txt', 'two')]);
    const parentId = view.active().meta.id;
    // Branching after the first turn leaves a turn that changed files behind.
    view.send({
      type: 'conversation.fork',
      conversationId: parentId,
      messageId: messageIds(view)[1],
    });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(noticesOf(assistants(view).at(-1))).toEqual([NEWER]);
    expect(view.active().messages.at(-1)?.role).toBe('assistant');
    view.expectMirror();

    // Branching after the last turn keeps everything: nothing is newer.
    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => view.state?.active?.meta.id === parentId);
    view.send({
      type: 'conversation.fork',
      conversationId: parentId,
      messageId: messageIds(view).at(-1),
    });
    await until('the second branch', () => view.state?.active?.meta.id !== parentId);
    expect(assistants(view).flatMap((m) => noticesOf(m))).not.toContain(NEWER);
  });

  it('say nothing when the later turns changed no files', async () => {
    const { view } = await agentTurns([writes('a.txt', 'one'), writes(undefined, 'two')]);
    const parentId = view.active().meta.id;
    view.send({
      type: 'conversation.fork',
      conversationId: parentId,
      messageId: messageIds(view)[1],
    });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(assistants(view).flatMap((m) => noticesOf(m))).not.toContain(NEWER);
  });

  it('say it when opened if the branch keeps no messages at all', async () => {
    const { view } = await agentTurns([writes('a.txt', 'one')]);
    const parentId = view.active().meta.id;
    view.send({
      type: 'conversation.fork',
      conversationId: parentId,
      messageId: messageIds(view)[0],
    });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(view.active().messages).toEqual([]);
    await until('the message', () => view.toasts.some((toast) => toast.text === NEWER));
    expect(view.toasts.find((toast) => toast.text === NEWER)?.level).toBe('info');
  });
});

// ---- tries that did not work, and a parent that moves ----------------------------------------------------------

const silent: ScenarioSpec = { record: true, scenario: { steps: [{ hang: true }] } };

/** Sends in a conversation and presses Stop before the provider has printed anything. */
async function sendAndStop(h: Harness, view: TestView, requests: number): Promise<void> {
  const conversationId = view.active().meta.id;
  view.send({ type: 'turn.send', conversationId, text: 'a try', mode: 'ask', model: 'default' });
  await until('the provider to start', () => h.requests.length === requests);
  view.send({ type: 'turn.cancel', conversationId });
  await until('the turn to end', () => h.controller.runningTurns() === 0);
}

describe('a branch whose first try did not work', () => {
  it('is planned from the parent again: a cut at the kept turn, not a copy of everything', async () => {
    const { h, view, parentSession } = await parentWithTurns(
      { sequence: answers(2, [silent, text('second try')]) },
      2,
    );
    const keptEvent = view.active().turns[0]?.forkPointEventId;
    expect(keptEvent).toBeDefined();
    await branchAt(view, messageIds(view)[1]);

    await sendAndStop(h, view, 3);
    expect(view.active().meta.fork?.exactness).toBe('pending');
    expect(h.requests[2]?.session).toMatchObject({ kind: 'fork', atProviderEventId: keptEvent });

    await sendAndFinish(h, view, 'second try');
    const request = h.requests[3];
    expect(request?.session).toMatchObject({
      kind: 'fork',
      fromSessionId: parentSession,
      atProviderEventId: keptEvent,
    });
    expect(view.active().meta.fork).toMatchObject({ exactness: 'exact', lost: [] });
    view.expectMirror();
  });

  it('does not copy a turn the parent took after the branch was made', async () => {
    const { h, view } = await parentWithTurns(
      { sequence: [text('answer 1'), silent, text('answer 2'), text('second try')] },
      1,
    );
    const parentId = view.active().meta.id;
    const keptEvent = view.active().turns[0]?.forkPointEventId;
    await branchAt(view, messageIds(view)[1]);
    const branchId = view.active().meta.id;
    await sendAndStop(h, view, 2);

    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => view.state?.active?.meta.id === parentId);
    await sendAndFinish(h, view, 'a second turn in the parent');
    view.send({ type: 'conversation.open', conversationId: branchId });
    await until('the branch', () => view.state?.active?.meta.id === branchId);
    await sendAndFinish(h, view, 'second try');

    // The branch keeps one turn, so its copy stops after it, whatever the parent has now.
    expect(h.requests[3]?.session).toMatchObject({ kind: 'fork', atProviderEventId: keptEvent });
    expect(view.active().meta.fork?.exactness).toBe('exact');
    view.expectMirror();
  });
});

describe('the moment a branch is planned', () => {
  function held() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hold: { id?: ConversationId; waiting: boolean } = { waiting: false };
    const observer = {
      beforeTurn: async (context: { conversation: { id: ConversationId } }) => {
        if (context.conversation.id !== hold.id) return;
        hold.waiting = true;
        await gate;
      },
    };
    return { hold, release, observer };
  }

  it('is after the observers: a parent turn that ran meanwhile is not copied into an exact branch', async () => {
    const { hold, release, observer } = held();
    const { h, view } = await parentWithTurns(
      { observers: [observer], sequence: [text('answer 1'), text('parent two'), text('branch')] },
      1,
    );
    const parentId = view.active().meta.id;
    const keptEvent = view.active().turns[0]?.forkPointEventId;
    await branchAt(view, messageIds(view)[1]);
    hold.id = view.active().meta.id;
    view.send({
      type: 'turn.send',
      conversationId: hold.id,
      text: 'on the branch',
      mode: 'ask',
      model: 'default',
    });
    await until('the observer to hold the turn', () => hold.waiting);

    // While the branch waits, its parent takes another turn.
    const other = h.attach();
    other.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => other.state?.active?.meta.id === parentId);
    other.send({
      type: 'turn.send',
      conversationId: parentId,
      text: 'parent two',
      mode: 'ask',
      model: 'default',
    });
    await until(
      'the parent turn to end',
      () => other.state?.active?.turns[1]?.status === 'completed',
    );
    release();
    await until('the branch turn to end', () => h.controller.runningTurns() === 0);

    // Planned now, the branch sees a parent with a turn it does not keep: a cut, not a whole copy.
    expect(h.requests[2]?.session).toMatchObject({ kind: 'fork', atProviderEventId: keptEvent });
    expect(view.active().meta.fork).toMatchObject({ exactness: 'exact', lost: [] });
    view.expectMirror();
    other.expectMirror();
  });

  it('rebuilds when the parent is running at that moment', async () => {
    const { hold, release, observer } = held();
    const { h, view } = await parentWithTurns(
      {
        observers: [observer],
        sequence: [
          text('answer 1'),
          { record: true, scenario: { steps: [...streamedText(['x']), { hang: true }] } },
          text('branch'),
        ],
      },
      1,
    );
    const parentId = view.active().meta.id;
    await branchAt(view, messageIds(view)[1]);
    hold.id = view.active().meta.id;
    view.send({
      type: 'turn.send',
      conversationId: hold.id,
      text: 'on the branch',
      mode: 'ask',
      model: 'default',
    });
    await until('the observer to hold the turn', () => hold.waiting);
    const other = h.attach();
    other.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => other.state?.active?.meta.id === parentId);
    other.send({
      type: 'turn.send',
      conversationId: parentId,
      text: 'parent two',
      mode: 'ask',
      model: 'default',
    });
    await until('the parent turn to run', () => h.requests.length === 2);
    release();
    await until('the branch turn to start', () => h.requests.length === 3);
    expect(h.requests[2]?.session.kind).toBe('new');
    other.send({ type: 'turn.cancel', conversationId: parentId });
    await until('the turns to end', () => h.controller.runningTurns() === 0);
    expect(view.active().meta.fork?.exactness).toBe('reconstructed');
  });

  it('keeps the parent from taking a turn while its session is being copied', async () => {
    const { h, view } = await parentWithTurns(
      { sequence: [text('answer 1'), silent, text('parent two')] },
      1,
    );
    const parentId = view.active().meta.id;
    await branchAt(view, messageIds(view)[1]);
    const branchId = view.active().meta.id;
    view.send({
      type: 'turn.send',
      conversationId: branchId,
      text: 'on the branch',
      mode: 'ask',
      model: 'default',
    });
    await until('the copy to start', () => h.requests.length === 2);
    expect(h.requests[1]?.session.kind).toBe('fork');

    const other = h.attach();
    other.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => other.state?.active?.meta.id === parentId);
    other.send({
      type: 'turn.send',
      conversationId: parentId,
      text: 'parent two',
      mode: 'ask',
      model: 'default',
    });
    await until('a toast', () => other.toasts.length === 1);
    expect(other.toasts[0]?.text).toBe('A turn is already running in this conversation.');
    expect(h.requests).toHaveLength(2);

    // Once the attempt is over, the parent is free again.
    view.send({ type: 'turn.cancel', conversationId: branchId });
    await until('the branch turn to end', () => h.controller.runningTurns() === 0);
    await sendAndFinish(h, other, 'parent two');
    expect(h.requests).toHaveLength(3);
    other.expectMirror();
  });
});

describe('what a branch can be cut at', () => {
  it('is only a turn that ended normally: after a stop, the branch is rebuilt, and labelled so', async () => {
    const stopped: ScenarioSpec = {
      record: true,
      scenario: { steps: [...streamedText(['partial answer']), { hang: true }] },
    };
    const h = await harness({ sequence: [stopped, text('second'), text('b')] });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'one', mode: 'ask', model: 'default' });
    await until('some output', () => (view.state?.active?.messages.length ?? 0) >= 2);
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await until('the stop', () => h.controller.runningTurns() === 0);
    expect(view.active().turns[0]?.status).toBe('interrupted');
    expect(view.active().turns[0]?.forkPointEventId).toBeUndefined();
    await sendAndFinish(h, view, 'two');
    expect(view.active().turns[1]?.forkPointEventId).toBeDefined();

    await branchAt(view, messageIds(view)[1]);
    await sendAndFinish(h, view, 'branch');
    expect(h.requests[2]?.session.kind).toBe('new');
    expect((await h.record(2)).stdin.startsWith('<prior-conversation reconstructed="true">')).toBe(
      true,
    );
    expect(view.active().meta.fork?.exactness).toBe('reconstructed');
    view.expectMirror();
  });
});

describe('a branch that was exact and loses its session', () => {
  it('is labelled rebuilt from then on', async () => {
    const { h, view } = await parentWithTurns(
      { sequence: [text('answer 1'), text('copy'), { scenario: SESSION_LOST }, text('rebuilt')] },
      1,
    );
    await branchAt(view, messageIds(view)[1]);
    await sendAndFinish(h, view, 'first on the branch');
    expect(view.active().meta.fork).toMatchObject({ exactness: 'exact', lost: [] });

    await sendAndFinish(h, view, 'second on the branch');
    expect(h.requests[3]?.session.kind).toBe('new');
    const fork = view.active().meta.fork;
    expect(fork?.exactness).toBe('reconstructed');
    expect(fork?.lost).toEqual(reconstructContext(view.active().messages.slice(0, 4)).lost);
    view.expectMirror();
  });
});

describe('branching from a running conversation, at the message that started the running turn', () => {
  it('is allowed: the branch keeps only the turns before it', async () => {
    const running: ScenarioSpec = {
      record: true,
      scenario: { steps: [...streamedText(['working']), { hang: true }] },
    };
    const h = await harness({ sequence: [text('answer 1'), running] });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    const parentId = view.active().meta.id;
    view.send({
      type: 'turn.send',
      conversationId: parentId,
      text: 'two',
      mode: 'ask',
      model: 'default',
    });
    await until('the answer to start', () => (assistants(view)[1]?.parts.length ?? 0) === 1);
    const userOfRunning = messageIds(view)[2];

    view.send({ type: 'conversation.fork', conversationId: parentId, messageId: userOfRunning });
    await until('the branch', () => view.state?.active?.meta.id !== parentId);
    expect(view.toasts).toEqual([]);
    expect(view.active().turns).toHaveLength(1);
    expect(view.active().meta.fork?.lastKeptParentTurnId).toBeDefined();

    view.send({ type: 'conversation.open', conversationId: parentId });
    await until('the parent', () => view.state?.active?.meta.id === parentId);
    view.send({ type: 'turn.cancel', conversationId: parentId });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
    view.expectMirror();
  });
});
