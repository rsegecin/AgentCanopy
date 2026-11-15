import { describe, expect, it } from 'vitest';
import { EMPTY_VIEW_STATE } from '../../shared';
import type { ConversationId, HostMessage, Prompt, PromptAnswer, ViewState } from '../../shared';
import type { NewPrompt } from '../contracts';
import { silentLogger } from '../contracts';
import { answerProblem, canonicalJson, displayHashOf } from './prompts';
import type { PendingPrompt } from './prompts';
import { SessionState, previewOf } from './state';
import { ViewRecord } from './view';
import { assistantMessage, text, userMessage } from '../conversations/test-support';

function newView(flushMs = 10_000): { view: ViewRecord; posted: HostMessage[] } {
  const posted: HostMessage[] = [];
  const state: ViewState = {
    ...EMPTY_VIEW_STATE,
    active: {
      meta: {
        id: 'c1' as ConversationId,
        title: 't',
        createdAt: 1,
        updatedAt: 1,
        folder: 'f' as never,
        providerId: 'claude-code',
        model: 'default',
        mode: 'ask',
        planLocked: false,
      },
      turns: [],
      messages: [],
      prompts: [],
      plan: null,
      activity: 'a',
      queued: null,
      asides: [],
    },
  };
  const view = new ViewRecord(
    'v1',
    'sidebar',
    { post: (message) => posted.push(message) },
    state,
    silentLogger,
    flushMs,
  );
  return { view, posted };
}

describe('a view record', () => {
  it('merges text appends, and sends them before any other change', () => {
    const { view, posted } = newView();
    view.ready = true;
    const path = ['active', 'activity'];
    view.apply([{ op: 'set', path, value: '' }]);
    view.apply([{ op: 'appendText', path, text: 'a' }]);
    view.apply([{ op: 'appendText', path, text: 'b' }]);
    view.apply([{ op: 'appendText', path, text: 'c' }]);
    // Only the set has been sent so far; the appends wait.
    expect(posted).toHaveLength(1);
    view.apply([{ op: 'set', path: ['active', 'activity'], value: 'done' }]);
    expect(posted.map((m) => m.type === 'patch' && [m.seq, m.ops.map((o) => o.op)])).toEqual([
      [1, ['set']],
      [2, ['appendText']],
      [3, ['set']],
    ]);
    const merged = posted[1];
    expect(merged?.type === 'patch' && merged.ops[0]).toEqual({
      op: 'appendText',
      path,
      text: 'abc',
    });
    expect(view.seq).toBe(3);
    expect(view.state.active?.activity).toBe('done');
  });

  it('sends held text on its own after the flush delay', async () => {
    const { view, posted } = newView(15);
    view.ready = true;
    view.apply([{ op: 'appendText', path: ['active', 'activity'], text: 'x' }]);
    expect(posted).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posted).toHaveLength(1);
    view.dispose();
  });

  it('keeps appends to different places apart', () => {
    const { view, posted } = newView();
    view.ready = true;
    view.apply([{ op: 'appendText', path: ['active', 'activity'], text: 'a' }]);
    view.apply([{ op: 'appendText', path: ['active', 'meta', 'title'], text: 'b' }]);
    view.apply([{ op: 'appendText', path: ['active', 'activity'], text: 'c' }]);
    view.flush();
    const patch = posted[0];
    expect(patch?.type === 'patch' && patch.ops).toHaveLength(3);
  });

  it('changes its state but posts nothing until it is ready, and init carries the sequence', () => {
    const { view, posted } = newView();
    view.apply([{ op: 'set', path: ['trusted'], value: true }]);
    view.apply([{ op: 'set', path: ['trusted'], value: false }]);
    expect(posted).toEqual([]);
    expect(view.seq).toBe(2);
    view.ready = true;
    view.init();
    expect(posted).toEqual([{ type: 'init', seq: 2, state: view.state }]);
    view.event({ kind: 'focus-composer' });
    expect(posted[1]).toEqual({ type: 'event', event: { kind: 'focus-composer' } });
  });

  it('a throwing sink does not break the view', () => {
    const state = EMPTY_VIEW_STATE;
    const view = new ViewRecord(
      'v',
      'panel',
      {
        post: () => {
          throw new Error('gone');
        },
      },
      state,
      silentLogger,
    );
    view.ready = true;
    expect(() => view.apply([{ op: 'set', path: ['trusted'], value: true }])).not.toThrow();
    expect(view.state.trusted).toBe(true);
  });
});

describe('the session state', () => {
  it('changes only the global fields that differ', () => {
    const state = new SessionState(() => []);
    const posted: HostMessage[] = [];
    const view = new ViewRecord(
      'v',
      'sidebar',
      { post: (m) => posted.push(m) },
      state.newViewState(),
      silentLogger,
    );
    view.ready = true;
    state.views.set(view.id, view);
    state.patchGlobal({ trusted: false });
    expect(posted).toEqual([]);
    state.patchGlobal({ trusted: true, banners: [] });
    expect(posted).toHaveLength(1);
    const patch = posted[0];
    expect(patch?.type === 'patch' && patch.ops).toEqual([
      { op: 'set', path: ['trusted'], value: true },
    ]);
  });

  it('builds a preview from the last message with text', () => {
    expect(previewOf([])).toBe('');
    const messages = [
      userMessage('u1', 't1', 'the   question\nover lines'),
      assistantMessage('a1', 't1', [text('first'), text('  the\nanswer  ')]),
      assistantMessage('a2', 't1', []),
    ];
    expect(previewOf(messages)).toBe('the answer');
    expect(previewOf(messages.slice(0, 1))).toBe('the question over lines');
    expect(previewOf([userMessage('u2', 't1', 'x'.repeat(500))])).toHaveLength(300);
  });
});

describe('prompt hashing and answers', () => {
  const base: NewPrompt = {
    kind: 'question',
    toolCallId: 'toolu_1',
    questions: [
      {
        question: 'Q?',
        header: 'H',
        options: [{ label: 'A', description: 'a' }],
        multiSelect: false,
      },
    ],
  };

  it('writes the same JSON for the same value whatever the key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: undefined, e: 'x' }] })).toBe(
      '{"a":[{"d":2,"e":"x"}],"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('hashes what the user sees, and nothing else', () => {
    const first = displayHashOf(base);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(displayHashOf({ ...base, toolCallId: 'toolu_2' })).toBe(first);
    const changed = {
      ...base,
      questions: [{ ...base.questions[0]!, question: 'Another?' }],
    } as NewPrompt;
    expect(displayHashOf(changed)).not.toBe(first);
    const permission: NewPrompt = {
      kind: 'permission',
      toolCallId: 'toolu_1',
      toolName: 'Bash',
      category: 'command',
      title: 'Run',
      detail: 'ls',
      inputPreview: '{}',
      choices: ['allow-once', 'deny'],
    };
    expect(displayHashOf(permission)).not.toBe(displayHashOf({ ...permission, detail: 'ls -la' }));
  });

  it('names the reason an answer cannot be taken', () => {
    const prompt = {
      ...base,
      id: 'p1',
      conversationId: 'c1',
      turnId: 't1',
      createdAt: 1,
      state: 'pending',
      displayHash: 'hash',
    } as unknown as Prompt;
    const entry: PendingPrompt = {
      prompt,
      answering: false,
      settled: false,
      settle: () => undefined,
    };
    const good: PromptAnswer = { kind: 'question', answers: { 'Q?': ['A'] } };
    expect(answerProblem(entry, 'hash', good)).toBeUndefined();
    expect(answerProblem(entry, 'other', good)).toMatch(/hash/);
    expect(answerProblem(entry, 'hash', { kind: 'permission', choice: 'deny' })).toMatch(/kind/);
    expect(answerProblem(entry, 'hash', { kind: 'question', answers: { 'Z?': ['A'] } })).toMatch(
      /unknown question/,
    );
    expect(answerProblem({ ...entry, settled: true }, 'hash', good)).toMatch(/not pending/);
    expect(answerProblem({ ...entry, answering: true }, 'hash', good)).toMatch(/confirmed/);
  });
});
