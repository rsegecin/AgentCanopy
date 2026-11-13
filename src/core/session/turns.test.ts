import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, MessagePart, PatchOp, ToolCallView } from '../../shared';
import { createConversationStore } from '../conversations/store';
import {
  createHarness,
  createTestPolicy,
  fixtureSteps,
  finishedTurn,
  lastTurn,
  resultStep,
  sendAndFinish,
  streamedText,
  textScenario,
  until,
  type Harness,
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

function assistantOf(messages: readonly { role: string }[]): AssistantMessage {
  const found = messages.find((m): m is AssistantMessage => m.role === 'assistant');
  if (!found) throw new Error('no assistant message');
  return found;
}

function parts(message: AssistantMessage, kind: MessagePart['kind']): MessagePart[] {
  return message.parts.filter((part) => part.kind === kind);
}

describe('a text turn', () => {
  it('streams, completes, persists and cleans up', async () => {
    const chunks = Array.from({ length: 40 }, (_, i) => `chunk${i} `);
    const full = chunks.join('');
    const h = await harness({
      scenario: { steps: [...streamedText(chunks), ...resultStep(full)] },
    });
    const view = h.attach();
    let runningChanges = 0;
    h.controller.onDidChangeRunning(() => {
      runningChanges += 1;
    });

    const turn = await sendAndFinish(h, view, 'hello there\nsecond line');
    expect(turn.status).toBe('completed');
    expect(turn.error).toBeUndefined();

    const active = view.active();
    expect(active.meta.title).toBe('hello there second line');
    expect(active.meta.sessionId).toBeDefined();
    expect(active.activity).toBeNull();
    const [user, assistant] = active.messages;
    expect(user?.role).toBe('user');
    expect(user?.role === 'user' && user.text).toBe('hello there\nsecond line');
    expect(assistant?.role).toBe('assistant');
    const text = assistantOf(active.messages).parts;
    expect(text).toEqual([{ kind: 'text', text: full }]);
    expect(turn.forkPointEventId).toBeDefined();
    expect(runningChanges).toBe(2);
    expect(h.controller.runningTurns()).toBe(0);

    // Deltas were coalesced: far fewer patches carry text than chunks were sent.
    const textPatches = view
      .patches()
      .filter((patch) => patch.ops.some((op: PatchOp) => op.op === 'appendText'));
    expect(textPatches.length).toBeGreaterThan(0);
    expect(textPatches.length).toBeLessThan(chunks.length / 2);

    // The summary shows the turn is over and what it said last.
    const summary = view.current().conversations.find((c) => c.id === active.meta.id);
    expect(summary?.running).toBe(false);
    expect(summary?.preview.startsWith('chunk0 chunk1')).toBe(true);
    expect(summary?.pendingPrompts).toBe(0);

    // The run directory is gone and the registration no longer answers.
    const runRoot = join(h.storage, 'run');
    expect(await fs.readdir(runRoot)).toEqual([]);
    const request = h.requests[0];
    if (!request) throw new Error('no request recorded');
    expect(request.session.kind).toBe('new');
    const response = await fetch(request.host.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${request.host.bearerToken}`,
      },
      body: '{}',
    });
    expect(response.status).toBe(404);

    view.expectMirror();

    // A new controller on the same directory sees the same conversation.
    const again = await createHarness({ reuse: h });
    harnesses.push(again);
    const other = again.attach();
    other.send({ type: 'conversation.open', conversationId: active.meta.id });
    await until('the conversation to open', () => other.state?.active != null);
    const reopened = other.active();
    expect(reopened.messages).toEqual(active.messages);
    expect(reopened.turns).toEqual(active.turns);
    expect(reopened.prompts).toEqual(active.prompts);
    expect({ ...reopened.meta, updatedAt: 0 }).toEqual({ ...active.meta, updatedAt: 0 });
    expect(other.current().conversations[0]?.preview).toBe(summary?.preview);
  });
});

describe('a turn with a tool call', () => {
  it('goes from running to done and records that Claude Code allowed it', async () => {
    const h = await harness({ scenario: { steps: fixtureSteps('T2') } });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'what is in notes.txt?');
    expect(turn.status).toBe('completed');

    const message = assistantOf(view.active().messages);
    const tool = message.parts.find((part) => part.kind === 'tool');
    expect(tool?.kind === 'tool' && tool.call.status).toBe('done');
    const call = (tool as { kind: 'tool'; call: ToolCallView }).call;
    expect(call.name).toBe('Read');
    expect(call.approval).toBe('provider');
    expect(call.resultPreview).toBe('1\talpha beta');
    expect(call.resultTruncated).toBe(false);
    expect(call.parentId).toBeNull();
    expect(call.input).toEqual({ file_path: '/work/notes.txt' });
    expect(message.parts.at(-1)).toEqual({ kind: 'text', text: 'alpha' });

    // The part was first shown as running, then changed to done.
    const statuses: string[] = [];
    for (const patch of view.patches()) {
      for (const op of patch.ops) {
        const value = op.op === 'push' || op.op === 'set' ? op.value : undefined;
        if (op.op === 'push' && (value as MessagePart | undefined)?.kind === 'tool') {
          statuses.push((value as { call: ToolCallView }).call.status);
        } else if (op.op === 'set' && op.path[op.path.length - 1] === 'call') {
          statuses.push((value as ToolCallView).status);
        }
      }
    }
    expect(statuses).toEqual(['running', 'done']);
    view.expectMirror();
  });
});

describe('failures', () => {
  it('shows a crash in the middle of a turn as an error', async () => {
    const h = await harness({
      scenario: { steps: [...streamedText(['half']), { stderr: 'boom' }, { exit: 3 }] },
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('Claude Code stopped unexpectedly.');
    const notices = parts(assistantOf(view.active().messages), 'notice');
    expect(notices).toEqual([
      { kind: 'notice', level: 'error', text: 'Claude Code stopped unexpectedly.' },
    ]);
    view.expectMirror();
  });

  it('names the model when Claude Code does not know it', async () => {
    const h = await harness({ scenario: { steps: fixtureSteps('E1') } });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'hi', { model: 'not-a-real-model-xyz' });
    const sentence = 'Claude Code does not know the model "not-a-real-model-xyz".';
    expect(turn.status).toBe('error');
    expect(turn.error).toBe(sentence);
    const notices = parts(assistantOf(view.active().messages), 'notice');
    expect(notices).toEqual([{ kind: 'notice', level: 'error', text: sentence }]);
    view.expectMirror();
  });

  it('stops the process when the policy refuses an event', async () => {
    const base = createTestPolicy();
    const h = await harness({
      scenario: {
        steps: [...streamedText(['x']), { hang: true }],
        onSigint: 'ignore',
        onSigterm: 'ignore',
      },
      policy: {
        ...base,
        inspect: (event) =>
          event.type === 'session' ? { stop: 'The session was not read-only.' } : undefined,
      },
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('The session was not read-only.');
    expect(parts(assistantOf(view.active().messages), 'notice')).toEqual([
      { kind: 'notice', level: 'error', text: 'The session was not read-only.' },
    ]);
    // The text that came after the refused event was not shown.
    expect(parts(assistantOf(view.active().messages), 'text')).toEqual([]);
    const pid = h.handles[0]?.pid;
    expect(pid).toBeDefined();
    view.expectMirror();
  });

  it('keeps the controller going when the policy throws on an event', async () => {
    const h = await harness({
      scenario: {
        steps: [...streamedText(['x']), { hang: true }],
        onSigint: 'ignore',
        onSigterm: 'ignore',
      },
      policy: {
        ...createTestPolicy(),
        inspect: () => {
          throw new Error('inspection broke');
        },
      },
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('AgentCanopy could not check this turn and stopped it.');
    expect(h.logger.has('error', 'could not inspect')).toBe(true);
  });
});

describe('sessions', () => {
  it('resumes the session on the second turn', async () => {
    const h = await harness({ scenario: textScenario('pong'), record: true });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    const sessionId = view.active().meta.sessionId;
    expect(sessionId).toBeDefined();
    const first = await h.record();
    expect(first.argv).toContain('--session-id');
    expect(first.argv).toContain(sessionId);
    expect(first.argv).not.toContain('--resume');
    expect(first.stdin).not.toContain('<prior-conversation');

    await sendAndFinish(h, view, 'two');
    const second = await h.record();
    expect(second.argv).toContain('--resume');
    expect(second.argv[second.argv.indexOf('--resume') + 1]).toBe(sessionId);
    expect(second.argv).not.toContain('--session-id');
    expect(second.stdin.endsWith('two')).toBe(true);
    expect(second.stdin).not.toContain('<prior-conversation');
    expect(view.active().meta.sessionId).toBe(sessionId);
    expect(view.active().turns).toHaveLength(2);
    view.expectMirror();
  });

  it('retries once with a new session when Claude Code lost the old one', async () => {
    const missing = {
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
    const h = await harness({
      sequence: [
        { scenario: textScenario('first answer') },
        { scenario: missing },
        { scenario: textScenario('second answer'), record: true },
      ],
    });
    const view = h.attach();
    await sendAndFinish(h, view, 'one');
    const oldSession = view.active().meta.sessionId;

    const turn = await sendAndFinish(h, view, 'two');
    expect(turn.status).toBe('completed');
    expect(h.handles).toHaveLength(3);
    expect(h.requests[1]?.session.kind).toBe('resume');
    expect(h.requests[2]?.session.kind).toBe('new');

    const newSession = view.active().meta.sessionId;
    expect(newSession).toBeDefined();
    expect(newSession).not.toBe(oldSession);
    const record = await h.record(2);
    expect(record.argv).toContain('--session-id');
    expect(record.argv).not.toContain('--resume');
    expect(record.stdin.startsWith('<prior-conversation reconstructed="true">')).toBe(true);
    expect(record.stdin).toContain('first answer');
    expect(record.stdin.endsWith('two')).toBe(true);

    const second = view.active().messages.filter((m) => m.role === 'assistant')[1];
    expect(second?.role === 'assistant' && parts(second, 'notice')).toEqual([
      {
        kind: 'notice',
        level: 'info',
        text: 'Claude Code no longer has this session, so the conversation continues with its visible messages as context.',
      },
    ]);
    expect(second?.role === 'assistant' && parts(second, 'text')).toEqual([
      { kind: 'text', text: 'second answer' },
    ]);
    view.expectMirror();
  });
});

describe('branches', () => {
  it('posts the prefill after the patch that shows the branch', async () => {
    const h = await harness({ scenario: textScenario('an answer') });
    const view = h.attach();
    await sendAndFinish(h, view, 'the question');
    const parent = view.active();
    const posted = view.messages.length;

    view.send({
      type: 'conversation.fork',
      conversationId: parent.meta.id,
      messageId: parent.messages[0]?.id,
    });
    await until('the prefill', () =>
      view.events.some((event) => event.kind === 'prefill-composer'),
    );
    const after = view.messages.slice(posted);
    const shown = after.findIndex(
      (message) =>
        message.type === 'patch' &&
        message.ops.some(
          (op) =>
            op.op === 'set' &&
            JSON.stringify(op.path) === '["active"]' &&
            (op.value as { meta: { id: string } } | null)?.meta.id !== parent.meta.id,
        ),
    );
    const prefill = after.findIndex(
      (message) => message.type === 'event' && message.event.kind === 'prefill-composer',
    );
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(prefill).toBeGreaterThan(shown);
    expect(view.active().meta.id).not.toBe(parent.meta.id);
    view.expectMirror();
  });

  it('opens the branch, prefills a user message and copies the session for the first turn', async () => {
    const h = await harness({ scenario: textScenario('an answer'), record: true });
    const view = h.attach();
    await sendAndFinish(h, view, 'the question');
    const parent = view.active();
    const userId = parent.messages[0]?.id;
    const assistantId = parent.messages[1]?.id;
    expect(userId).toBeDefined();

    // Forking at the user message keeps nothing before it and puts its text back in the composer.
    view.send({ type: 'conversation.fork', conversationId: parent.meta.id, messageId: userId });
    await until('the branch to open', () => view.state?.active?.meta.id !== parent.meta.id);
    expect(view.events).toContainEqual({ kind: 'prefill-composer', text: 'the question' });
    expect(view.active().messages).toEqual([]);
    expect(view.active().meta.fork?.exactness).toBe('pending');

    // Forking at the answer keeps the turn and sends no prefill.
    view.send({ type: 'conversation.open', conversationId: parent.meta.id });
    await until('the parent to open', () => view.state?.active?.meta.id === parent.meta.id);
    const before = view.events.length;
    view.send({
      type: 'conversation.fork',
      conversationId: parent.meta.id,
      messageId: assistantId,
    });
    await until('the second branch to open', () => view.state?.active?.meta.id !== parent.meta.id);
    expect(view.events.length).toBe(before);
    const branch = view.active();
    expect(branch.meta.fork?.parentId).toBe(parent.meta.id);
    expect(branch.messages).toHaveLength(2);
    expect(branch.meta.sessionId).toBeUndefined();

    // The branch keeps everything its parent has, so its first turn runs on a copy of the session.
    const parentSession = parent.meta.sessionId;
    expect(parentSession).toBeDefined();
    await sendAndFinish(h, view, 'a follow-up');
    const record = await h.record();
    expect(record.argv).toContain('--fork-session');
    expect(record.argv).not.toContain('--resume-session-at');
    expect(record.argv[record.argv.indexOf('--resume') + 1]).toBe(parentSession);
    expect(record.stdin).not.toContain('<prior-conversation');
    expect(record.stdin.endsWith('a follow-up')).toBe(true);
    const fork = view.active().meta.fork;
    expect(fork?.exactness).toBe('exact');
    expect(fork?.lost).toEqual([]);
    expect(view.active().meta.sessionId).toBe(record.argv[record.argv.indexOf('--session-id') + 1]);

    // The turn after that resumes the branch's own session.
    await sendAndFinish(h, view, 'and another');
    expect((await h.record()).argv).toContain('--resume');
    expect((await h.record()).argv).not.toContain('--fork-session');
    view.expectMirror();
  });
});

describe('refusing to send', () => {
  async function expectRefusal(
    h: Harness,
    toast: string | RegExp,
    mode: 'ask' | 'plan' | 'agent' = 'ask',
  ): Promise<void> {
    const view = h.attach();
    const store = createConversationStore({ dir: join(h.storage, 'conversations') });
    await store.init();
    const before = { state: view.current(), conversations: store.list().length };
    const eventsBefore = view.events.length;
    view.send({ type: 'turn.send', text: 'hello', mode, model: 'default' });
    await until('a toast', () => view.events.length > eventsBefore);
    const toasts = view.toasts;
    const text = toasts[toasts.length - 1]?.text ?? '';
    if (typeof toast === 'string') expect(text).toBe(toast);
    else expect(text).toMatch(toast);
    expect(toasts[toasts.length - 1]?.level).toBe('warning');
    // Nothing changed: no state patch, nothing stored, no process started.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(view.current()).toEqual(before.state);
    expect(store.list().length).toBe(before.conversations);
    expect(h.handles).toHaveLength(0);
    expect(h.controller.runningTurns()).toBe(0);
    await store.flush();
  }

  it('in a workspace that is not trusted', async () => {
    const h = await harness({ untrusted: true });
    await expectRefusal(
      h,
      'This workspace is not trusted, so AgentCanopy will not run agents here.',
    );
  });

  it('when no folder is open', async () => {
    const h = await harness({ noFolder: true });
    await expectRefusal(h, 'Open a folder to start a conversation.');
  });

  it('when Claude Code is not installed', async () => {
    const { providerStatus, stubProvider } = await import('./test-support');
    const h = await harness({
      providers: [
        stubProvider(
          providerStatus({
            installed: false,
            meetsMinimum: false,
            version: undefined,
            problems: ['Claude Code was not found.'],
          }),
        ),
      ],
    });
    await expectRefusal(h, /Claude Code is not installed/);
  });

  it('when Claude Code is too old', async () => {
    const { providerStatus, stubProvider } = await import('./test-support');
    const h = await harness({
      providers: [
        stubProvider(
          providerStatus({
            meetsMinimum: false,
            version: '1.0.0',
            problems: ['Claude Code 1.0.0 is older than the minimum.'],
          }),
        ),
      ],
    });
    await expectRefusal(h, /needs to be updated/);
  });

  it('when Claude Code is signed out', async () => {
    const h = await harness({ auth: { loggedIn: false } });
    await expectRefusal(h, /Claude Code is not signed in/);
  });

  it('in Plan mode, which does not run yet', async () => {
    const h = await harness({ scenario: textScenario('x') });
    await expectRefusal(h, 'Plan mode is not available yet.', 'plan');
  });

  it('in Agent mode, which does not run yet', async () => {
    const h = await harness({ scenario: textScenario('x') });
    await expectRefusal(h, 'Agent mode is not available yet.', 'agent');
  });

  it('while a turn is running in the conversation', async () => {
    const h = await harness({
      scenario: { steps: [...streamedText(['working']), { hang: true }] },
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'one', mode: 'ask', model: 'default' });
    await until('text to appear', () => {
      const message = view.state?.active?.messages[1];
      return message?.role === 'assistant' && message.parts.length > 0;
    });
    const id = view.active().meta.id;
    const messages = view.active().messages.length;
    view.send({
      type: 'turn.send',
      conversationId: id,
      text: 'two',
      mode: 'ask',
      model: 'default',
    });
    await until('a toast', () => view.toasts.length > 0);
    expect(view.toasts[0]).toEqual({
      level: 'warning',
      text: 'A turn is already running in this conversation.',
    });
    expect(view.active().messages).toHaveLength(messages);
    expect(view.active().turns).toHaveLength(1);
    expect(h.controller.runningTurns()).toBe(1);

    view.send({ type: 'turn.cancel', conversationId: id });
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('interrupted');
  });
});

describe('cancelling', () => {
  it('during streaming ends the turn as interrupted without an error', async () => {
    const h = await harness({
      scenario: { steps: [...streamedText(['partial text']), { hang: true }] },
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'go', mode: 'ask', model: 'default' });
    await until('text to appear', () => {
      const message = view.state?.active?.messages[1];
      return message?.role === 'assistant' && message.parts.length > 0;
    });
    const id = view.active().meta.id;
    expect(view.active().activity).not.toBeNull();
    view.send({ type: 'turn.cancel', conversationId: id });
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('interrupted');
    expect(turn.error).toBeUndefined();
    expect(view.active().activity).toBeNull();
    const message = assistantOf(view.active().messages);
    expect(parts(message, 'notice')).toEqual([]);
    expect(parts(message, 'text')).toEqual([{ kind: 'text', text: 'partial text' }]);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });
});

describe('shutting down', () => {
  it('ends a running turn and resolves', async () => {
    const h = await harness({
      scenario: { steps: [...streamedText(['busy']), { hang: true }] },
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'go', mode: 'ask', model: 'default' });
    await until('the process to start', () => h.handles.length === 1);
    await until('a pid', () => h.handles[0]?.pid !== undefined);
    expect(h.controller.runningTurns()).toBe(1);
    await h.controller.dispose();
    expect(h.controller.runningTurns()).toBe(0);
    const handle = h.handles[0];
    await handle?.done;
    // The turn is stored as interrupted.
    const store = createConversationStore({ dir: join(h.storage, 'conversations') });
    await store.init();
    const [meta] = store.list();
    const data = meta ? await store.load(meta.id) : undefined;
    expect(data?.turns[0]?.status).toBe('interrupted');
    await store.flush();
  });
});

describe('other tools', () => {
  it('are denied by the default policy and shown as denied', async () => {
    const { assistantToolUse, userToolResult, stateEvent } = await import('./test-support');
    const { initEvent } = await import('../../../test/fake-cli');
    const h = await harness({
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          assistantToolUse('toolu_bash', 'Bash', { command: 'rm -rf /' }),
          {
            permission: {
              toolName: 'Bash',
              input: { command: 'rm -rf /' },
              toolUseId: 'toolu_bash',
              onAllow: [{ writeFile: { path: 'ran.txt', content: 'should not exist' } }],
              onDeny: [
                userToolResult('toolu_bash', 'This action is not allowed in ask mode.', {
                  isError: true,
                  decision: { decision: 'reject', source: 'user_reject' },
                  nonExecutionKind: 'permission-rule',
                }),
              ],
            },
          },
          ...resultStep('done'),
        ],
      },
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'delete everything');
    expect(turn.status).toBe('completed');
    const tool = assistantOf(view.active().messages).parts.find((p) => p.kind === 'tool');
    const call = (tool as { kind: 'tool'; call: ToolCallView }).call;
    expect(call.status).toBe('denied');
    expect(call.approval).toBe('policy');
    await expect(fs.access(join(h.workspace, 'ran.txt'))).rejects.toThrow();
    view.expectMirror();
  });
});

describe('conversation settings while a turn runs', () => {
  it('refuses to change the mode or model, and a delete cancels the turn first', async () => {
    const h = await harness({
      scenario: { steps: [...streamedText(['busy']), { hang: true }] },
    });
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'go', mode: 'ask', model: 'default' });
    await until('text to appear', () => {
      const message = view.state?.active?.messages[1];
      return message?.role === 'assistant' && message.parts.length > 0;
    });
    const id = view.active().meta.id;
    view.send({ type: 'conversation.setMode', conversationId: id, mode: 'plan' });
    view.send({ type: 'conversation.setModel', conversationId: id, model: 'opus' });
    await until('two toasts', () => view.toasts.length === 2);
    expect(view.toasts.every((t) => t.text.startsWith('Wait for the current turn'))).toBe(true);
    expect(view.active().meta.mode).toBe('ask');
    expect(view.active().meta.model).toBe('default');

    const other = h.attach();
    other.send({ type: 'conversation.open', conversationId: id });
    await until('the second view to show it', () => other.state?.active?.meta.id === id);

    view.send({ type: 'conversation.delete', conversationId: id });
    await until('the conversation to go', () => view.current().conversations.length === 0);
    await h.idle();
    expect(view.current().active).toBeNull();
    expect(other.current().active).toBeNull();
    expect(h.controller.runningTurns()).toBe(0);
    expect(await fs.readdir(join(h.storage, 'run'))).toEqual([]);
    view.expectMirror();
    other.expectMirror();
  });
});

describe('draft attachments', () => {
  it('are sent with the message and cleared', async () => {
    const h = await harness({ scenario: textScenario('ok'), record: true });
    const view = h.attach();
    h.ui.picked = ['src/a.ts', 'src/b.ts', '../escape'];
    view.send({ type: 'context.pick', what: 'file' });
    await until('picked files', () => h.ui.callsOf('pickPaths').length === 1);
    h.ui.selection = {
      kind: 'selection',
      path: 'src/a.ts',
      startLine: 1,
      endLine: 2,
      text: 'let a;',
    };
    view.send({ type: 'context.addSelection' });
    await sendAndFinish(h, view, 'look at these');
    const user = view.active().messages[0];
    expect(user?.role === 'user' && user.attachments.map((a) => a.kind)).toEqual([
      'file',
      'file',
      'selection',
    ]);
    const record = await h.record();
    expect(record.stdin).toContain('- src/a.ts');
    expect(record.stdin).toContain('let a;');
    expect(record.stdin).not.toContain('escape');
    expect(view.current().draftAttachments).toEqual([]);
    expect(lastTurn(view).status).toBe('completed');
  });
});
