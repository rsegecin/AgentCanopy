// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDoc, Prompt, ReviewEntry, ViewState } from '../../shared';
import { CheckpointsView } from '../features/checkpoints/CheckpointsView';
import { Composer } from '../features/chat/Composer';
import { QueuedMessage } from '../features/chat/QueuedMessage';
import { MessageList } from '../features/chat/MessageList';
import { PromptPart } from '../features/chat/PromptCards';
import { registerPartRenderer } from '../features/chat/registry';
import { PermissionsView } from '../features/permissions/PermissionsView';
import { PlanUpdateCard } from '../features/plan/PlanUpdateCard';
import { HistoryList } from '../features/history/HistoryList';
import { ChangesDock, SNAPSHOT_ANNOUNCE_MS } from '../features/review/ChangesDock';
import {
  assistantMessage,
  autoOffered,
  makeActive,
  makeAside,
  makeCheckpoint,
  makeConfigChange,
  makeFolderPermissions,
  makePermissionPrompt,
  makePlanContent,
  makePlanDoc,
  makePlanVersion,
  makeProvider,
  makeQuestionPrompt,
  makeRestoreItem,
  makeRestorePreview,
  makeReviewEntry,
  makeSavedPermission,
  makeState,
  makeSummary,
  makeToolCall,
  makeTurn,
  msgId,
  promptId,
  userMessage,
} from '../test-support/fixtures';
import { renderWithHost } from '../test-support/harness';
import { App } from './App';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

beforeEach(() => {
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>drawn</text></svg>',
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const composer = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

/* ------------------------------------------------------------------ 4. live regions */

describe('live regions', () => {
  const quiet = (container: HTMLElement) =>
    container.querySelector('.log-wrap > [role="status"]') as HTMLElement;
  const chat = (over: Parameters<typeof makeActive>[1] = {}) =>
    makeState({
      active: makeActive('c1', {
        messages: [userMessage('u1', 'go'), assistantMessage('a1', [{ kind: 'text', text: 'x' }])],
        ...over,
      }),
    });

  it('announces a turn starting and ending once each, and nothing on open', () => {
    const { container, init } = renderWithHost(<MessageList />, chat({ turns: [makeTurn()] }));
    expect(quiet(container).textContent).toBe('');
    expect(quiet(container).getAttribute('aria-live')).toBe('polite');
    init(chat({ turns: [makeTurn({ status: 'running' })], activity: 'Reading a.ts' }), 1);
    expect(quiet(container).textContent).toBe('The agent is working.');
    init(chat({ turns: [makeTurn({ status: 'running' })], activity: 'Searching for foo' }), 2);
    expect(quiet(container).textContent).toBe('The agent is working.');
    init(chat({ turns: [makeTurn({ status: 'completed' })] }), 3);
    expect(quiet(container).textContent).toBe('The agent finished.');
  });

  it('says when a turn failed or was stopped', () => {
    const first = renderWithHost(
      <MessageList />,
      chat({ turns: [makeTurn({ status: 'running' })] }),
    );
    first.init(chat({ turns: [makeTurn({ status: 'error', error: 'boom' })] }), 1);
    expect(quiet(first.container).textContent).toBe('The turn failed.');
    first.unmount();
    const second = renderWithHost(
      <MessageList />,
      chat({ turns: [makeTurn({ status: 'running' })] }),
    );
    second.init(chat({ turns: [makeTurn({ status: 'interrupted' })] }), 1);
    expect(quiet(second.container).textContent).toBe('The turn was stopped.');
  });

  it('announces a question that needs an answer', () => {
    const { container, init } = renderWithHost(<MessageList />, chat({ turns: [makeTurn()] }));
    init(chat({ prompts: [makeQuestionPrompt('q1')] }), 1);
    expect(quiet(container).textContent).toBe('The agent is waiting for your answer.');
    init(chat({ prompts: [makeQuestionPrompt('q1'), makePermissionPrompt('p2')] }), 2);
    expect(quiet(container).textContent).toBe('The agent is waiting for 2 answers.');
  });

  it('does not announce the streaming answer of a side question, and puts no live region in its card', () => {
    const withAside = (status: 'running' | 'completed', text: string) =>
      chat({
        turns: [makeTurn({ status: 'running' })],
        asides: [
          makeAside('b1', {
            question: 'Why?',
            status,
            parts: text === '' ? [] : [{ kind: 'text', text }],
          }),
        ],
      });
    const { container, init, host } = renderWithHost(<MessageList />, withAside('running', ''));
    const before = quiet(container).textContent;
    const card = screen.getByRole('region', { name: 'Side question: Why?' });
    // The only live element is the status line, and it carries no answer text.
    expect(card.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(1);
    expect(card.querySelector('[role="status"]')?.textContent).toBe('Answering…');
    init(withAside('running', 'first words'), 1);
    host.emit({
      type: 'patch',
      seq: 2,
      ops: [{ op: 'appendText', path: ['active', 'asides', 0, 'parts', 0, 'text'], text: ' more' }],
    });
    expect(quiet(container).textContent).toBe(before);
    expect(card.querySelector('[role="status"]')).toBeNull();
    expect(screen.getByRole('log').closest('[aria-live="polite"]')).toBeNull();
    expect(card.closest('[aria-live]')?.getAttribute('aria-live')).toBe('off');
  });

  it('announces a question that waits inside a side question, like any other', () => {
    const withAside = (prompts: ReturnType<typeof makeQuestionPrompt>[]) =>
      chat({
        turns: [makeTurn({ status: 'running' })],
        asides: [
          makeAside('b1', { question: 'Why?', parts: [{ kind: 'text', text: 'hm' }], prompts }),
        ],
      });
    const { container, init } = renderWithHost(<MessageList />, withAside([]));
    expect(quiet(container).textContent).toBe('');
    init(withAside([makeQuestionPrompt('q1')]), 1);
    expect(quiet(container).textContent).toBe('The agent is waiting for your answer.');
    // One in the conversation and one in the side question: two answers are waited for.
    init(
      chat({
        turns: [makeTurn({ status: 'running' })],
        prompts: [makeQuestionPrompt('q0')],
        asides: [makeAside('b1', { prompts: [makeQuestionPrompt('q1')] })],
      }),
      2,
    );
    expect(quiet(container).textContent).toBe('The agent is waiting for 2 answers.');
  });

  it('says "Answered." once when a side question completes, and again changes nothing', () => {
    const withStatus = (status: 'running' | 'completed', extra = '') =>
      chat({
        turns: [makeTurn({ status: 'running' })],
        asides: [
          makeAside('b1', {
            question: 'Why?',
            status,
            parts: [{ kind: 'text', text: `because${extra}` }],
          }),
        ],
      });
    const { init } = renderWithHost(<MessageList />, withStatus('running'));
    const card = screen.getByRole('region', { name: 'Side question: Why?' });
    expect(card.querySelector('[role="status"]')).toBeNull();
    init(withStatus('completed'), 1);
    const line = card.querySelector('[role="status"]');
    expect(line?.textContent).toBe('Answered.');
    // Later renders leave the line as it is: it is not announced again.
    init(withStatus('completed', ' and more'), 2);
    expect(card.querySelector('[role="status"]')).toBe(line);
    expect(line?.textContent).toBe('Answered.');
    expect(card.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(1);
  });

  it('reports a side question that fails while shown as an alert, not a status', () => {
    const withStatus = (status: 'running' | 'error') =>
      chat({
        turns: [makeTurn({ status: 'running' })],
        asides: [
          makeAside('b1', {
            question: 'Why?',
            status,
            ...(status === 'error' ? { error: 'The model is overloaded.' } : {}),
          }),
        ],
      });
    const { init } = renderWithHost(<MessageList />, withStatus('running'));
    const card = screen.getByRole('region', { name: 'Side question: Why?' });
    init(withStatus('error'), 1);
    const alert = within(card).getByRole('alert');
    expect(alert.textContent).toBe('The model is overloaded.');
    expect(card.querySelector('[role="status"]')).toBeNull();
  });

  it('does not announce a side question that had already failed when the conversation was opened', () => {
    const { container } = renderWithHost(
      <MessageList />,
      chat({
        asides: [
          makeAside('b1', { question: 'Why?', status: 'error', error: 'The model is overloaded.' }),
        ],
      }),
    );
    const card = screen.getByRole('region', { name: 'Side question: Why?' });
    expect(within(card).getByText('The model is overloaded.')).toBeTruthy();
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    expect(card.querySelector('[role="status"]')).toBeNull();
  });

  it('does not announce streaming text', () => {
    const { container, host } = renderWithHost(
      <MessageList />,
      chat({ turns: [makeTurn({ status: 'running' })] }),
    );
    const before = quiet(container).textContent;
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [
        { op: 'appendText', path: ['active', 'messages', 1, 'parts', 0, 'text'], text: 'more' },
      ],
    });
    expect(quiet(container).textContent).toBe(before);
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-live')).toBe('off');
    expect(log.closest('[aria-live="polite"]')).toBeNull();
  });

  it('announces snapshot progress at most every few seconds', () => {
    vi.useFakeTimers();
    const state = (done: number) =>
      makeState({ baseline: { state: 'capturing', filesDone: done, filesTotal: 100 } });
    const { init, container } = renderWithHost(<ChangesDock />, {
      ...state(1),
      review: { entries: [makeReviewEntry('a.ts')], configChanges: [], busy: false },
    });
    const live = () => container.querySelector('.review-snapshot [role="status"]') as HTMLElement;
    expect(live().textContent).toBe('Preparing the workspace snapshot: 1 of 100 files');
    for (let done = 10; done <= 50; done += 10) {
      init(
        {
          ...state(done),
          review: { entries: [makeReviewEntry('a.ts')], configChanges: [], busy: false },
        },
        done,
      );
      act(() => {
        vi.advanceTimersByTime(500);
      });
    }
    expect(live().textContent).toBe('Preparing the workspace snapshot: 1 of 100 files');
    act(() => {
      vi.advanceTimersByTime(SNAPSHOT_ANNOUNCE_MS);
    });
    expect(live().textContent).toBe('Preparing the workspace snapshot: 50 of 100 files');
    // The visible text is always current.
    expect(container.querySelector('.review-snapshot p')?.textContent).toContain('50 of 100');
  });

  it('announces errors assertively and other notifications politely, with the level in words', () => {
    const { host } = renderWithHost(<App />);
    host.emit({ type: 'event', event: { kind: 'toast', level: 'error', text: 'Copy failed' } });
    host.emit({ type: 'event', event: { kind: 'toast', level: 'info', text: 'Copied' } });
    host.emit({ type: 'event', event: { kind: 'toast', level: 'warning', text: 'Careful' } });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Error: Copy failed');
    const container = alert.parentElement as HTMLElement;
    expect(container.getAttribute('aria-live')).toBe('polite');
    expect(container.textContent).toContain('Note: Copied');
    expect(container.textContent).toContain('Warning: Careful');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ 2. focus management */

function reviewState(entries: ReviewEntry[], running = false): ViewState {
  return makeState({
    review: { entries, configChanges: [], busy: false },
    ...(running ? { active: makeActive('c1', { turns: [makeTurn({ status: 'running' })] }) } : {}),
  });
}

describe('focus after the focused control goes away', () => {
  const withComposer = (state: ViewState) =>
    renderWithHost(
      <>
        <ChangesDock />
        <Composer />
      </>,
      state,
    );

  it('moves to the next file when a review entry is accepted', () => {
    const { init } = withComposer(
      reviewState([makeReviewEntry('a.ts'), makeReviewEntry('b.ts'), makeReviewEntry('c.ts')]),
    );
    screen.getByRole('button', { name: 'Accept b.ts' }).focus();
    init(reviewState([makeReviewEntry('a.ts'), makeReviewEntry('c.ts')]), 1);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('li')).toBe(
      screen.getByRole('button', { name: 'Open diff of c.ts' }).closest('li'),
    );
  });

  it('moves to the composer when the last pending entry is accepted', () => {
    const { init } = withComposer(reviewState([makeReviewEntry('a.ts')]));
    screen.getByRole('button', { name: 'Accept a.ts' }).focus();
    init(reviewState([makeReviewEntry('a.ts', { status: 'accepted' })]), 1);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });

  it('moves to the card itself when there is no composer to take focus', () => {
    const { init } = renderWithHost(<ChangesDock />, reviewState([makeReviewEntry('a.ts')]));
    screen.getByRole('button', { name: 'Accept a.ts' }).focus();
    init(reviewState([makeReviewEntry('a.ts', { status: 'accepted' })]), 1);
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Changes' }));
  });

  it('leaves focus alone when it is somewhere that still exists', () => {
    const { init } = withComposer(reviewState([makeReviewEntry('a.ts'), makeReviewEntry('b.ts')]));
    const stay = screen.getByRole('button', { name: 'Reject b.ts' });
    stay.focus();
    init(reviewState([makeReviewEntry('b.ts')]), 1);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reject b.ts' }));
  });

  it('moves to the card when a question is answered', () => {
    const off = registerPartRenderer('prompt', PromptPart);
    try {
      const withPrompt = (p: Prompt): ViewState =>
        makeState({
          active: makeActive('c1', {
            turns: [makeTurn({ status: 'running' })],
            messages: [assistantMessage('a1', [{ kind: 'prompt', promptId: p.id }])],
            prompts: [p],
          }),
        });
      const { init } = renderWithHost(<MessageList />, withPrompt(makeQuestionPrompt('q1')));
      fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
      screen.getByRole('button', { name: 'Submit' }).focus();
      init(withPrompt(makeQuestionPrompt('q1', { state: 'answered', answered: { x: 'Red' } })), 1);
      expect(document.activeElement?.getAttribute('role')).toBe('group');
      expect(document.activeElement?.classList.contains('prompt-card')).toBe(true);
    } finally {
      off();
    }
  });

  it('moves to a neighbouring row when a conversation is deleted', () => {
    const list = (ids: string[]) =>
      makeState({
        conversations: ids.map((id, i) =>
          makeSummary(id, { title: `Talk ${id}`, updatedAt: 1_700_000_000_000 - i * 1000 }),
        ),
      });
    const { init, host } = renderWithHost(
      <HistoryList onOpened={() => undefined} now={1_700_000_001_000} />,
      list(['a', 'b', 'c']),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete Talk b' }));
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(host.postedOf('conversation.delete')).toHaveLength(1);
    init(list(['a', 'c']), 1);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.closest('li')?.textContent).toContain('Talk c');
  });

  it('moves to the heading when a restore preview opens and closes', () => {
    const target = makeCheckpoint('op1');
    const withPreview = (preview: ReturnType<typeof makeRestorePreview> | null) =>
      makeState({ checkpoints: [target], restorePreview: preview });
    const preview = makeRestorePreview({
      targetOperationId: target.operationId,
      items: [makeRestoreItem('a.ts')],
    });
    const { init } = renderWithHost(<CheckpointsView now={1_700_000_001_000} />, withPreview(null));
    screen.getByRole('button', { name: /^Preview restore/ }).focus();
    init(withPreview(preview), 1);
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toMatch(/^Restore to before/);

    screen.getByRole('button', { name: 'Back to history' }).focus();
    init(withPreview(null), 2);
    expect(document.activeElement?.tagName).toBe('H2');
    expect(document.activeElement?.textContent).toBe('Checkpoint history');
  });

  it('keeps focus in the composer when Send is disabled by a turn starting, and Stop appears next to it', () => {
    // A side question that is still running blocks the next Ask send, but only while a turn runs.
    const idle = makeState({
      active: makeActive('c1', { turns: [makeTurn()], asides: [makeAside('b1')] }),
    });
    const busy = makeState({
      active: makeActive('c1', {
        turns: [makeTurn({ status: 'running' })],
        asides: [makeAside('b1')],
      }),
    });
    const { init } = renderWithHost(<Composer />, idle);
    fireEvent.change(composer(), { target: { value: 'hello' } });
    screen.getByRole('button', { name: 'Send' }).focus();
    init(busy, 1);
    // Both buttons are there; Send is disabled and focus moves to the textarea.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(composer());
  });

  it('keeps focus on the side question card when its Stop goes away at the end of its answer', () => {
    const withStatus = (status: 'running' | 'completed') =>
      makeState({
        active: makeActive('c1', {
          messages: [userMessage('u1', 'go')],
          turns: [makeTurn({ status: 'running' })],
          asides: [
            makeAside('b1', {
              question: 'Why?',
              anchor: { messageId: msgId('u1'), afterParts: 0 },
              status,
              parts: [{ kind: 'text', text: 'because' }],
            }),
          ],
        }),
      });
    const { init } = renderWithHost(<MessageList />, withStatus('running'));
    screen.getByRole('button', { name: 'Stop side question: Why?' }).focus();
    init(withStatus('completed'), 1);
    expect(screen.queryByRole('button', { name: 'Stop side question: Why?' })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('region', { name: 'Side question: Why?' }),
    );
  });

  it('keeps focus in the composer when the focused Stop goes away at the end of the turn', () => {
    const busy = makeState({
      active: makeActive('c1', { turns: [makeTurn({ status: 'running' })] }),
    });
    const { init } = renderWithHost(<Composer />, busy);
    screen.getByRole('button', { name: 'Stop' }).focus();
    init(makeState({ active: makeActive('c1', { turns: [makeTurn()] }) }), 1);
    expect(document.activeElement).toBe(composer());
  });

  it('moves focus from the queued message to the composer when it is sent or removed', () => {
    const withQueued = (queued: boolean) =>
      makeState({
        active: makeActive('c1', {
          meta: { mode: 'agent' },
          turns: [makeTurn({ status: 'running' })],
          queued: queued
            ? { text: 'next', mode: 'agent', model: 'default', attachments: [], queuedAt: 1 }
            : null,
        }),
      });
    const { init } = renderWithHost(
      <>
        <QueuedMessage />
        <Composer />
      </>,
      withQueued(true),
    );
    screen.getByRole('button', { name: 'Send now, queued message' }).focus();
    init(withQueued(false), 1);
    expect(document.activeElement).toBe(composer());
  });

  it('keeps focus on an answer control of the plan when the host records the answer', () => {
    const doc: PlanDoc = makePlanDoc();
    const withAnswer = (recorded: boolean): ViewState =>
      makeState({
        active: makeActive('c1', {
          plan: recorded
            ? {
                ...doc,
                decisions: [
                  { targetId: 'size', kind: 'open-question', values: ['large'], decidedAt: 5 },
                ],
              }
            : doc,
        }),
      });
    const { init } = renderWithHost(<MessageList />, withAnswer(false));
    const radio = screen.getByRole('radio', { name: 'Large' });
    radio.focus();
    fireEvent.click(radio);
    init(withAnswer(true), 1);
    expect(screen.getByRole('radio', { name: 'Large' })).toBe(radio);
    expect(document.activeElement).toBe(radio);
    expect((radio as HTMLInputElement).checked).toBe(true);
  });

  it('keeps focus in a text answer when it is saved', () => {
    const doc = makePlanDoc();
    const saved = {
      ...doc,
      decisions: [
        { targetId: 'notes', kind: 'open-question' as const, values: ['hi'], decidedAt: 5 },
      ],
    };
    const { init } = renderWithHost(
      <MessageList />,
      makeState({ active: makeActive('c1', { plan: doc }) }),
    );
    const field = screen.getByRole('textbox', { name: 'Your answer to: Anything else?' });
    fireEvent.change(field, { target: { value: 'hi' } });
    field.focus();
    init(makeState({ active: makeActive('c1', { plan: saved }) }), 1);
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Your answer to: Anything else?' }),
    );
  });

  describe('plan cards in the chat', () => {
    let off: () => void;
    beforeEach(() => {
      off = registerPartRenderer('plan-update', PlanUpdateCard);
    });
    afterEach(() => {
      off();
    });

    const part = (version: number) => ({
      kind: 'plan-update' as const,
      planId: 'plan1' as never,
      version,
    });
    const version = (n: number, hash: string, extra: { restoredFrom?: number } = {}) =>
      makePlanVersion(n, {
        contentHash: hash,
        content: makePlanContent({ title: `Title ${String(n)}` }),
        ...extra,
      });
    const chat = (doc: PlanDoc, partVersions: number[]): ViewState =>
      makeState({
        active: makeActive('c1', {
          plan: doc,
          messages: partVersions.map((v) => assistantMessage(`a${String(v)}`, [part(v)])),
        }),
      });
    const slots = () => Array.from(document.querySelectorAll<HTMLElement>('.plan-card-slot'));

    it('keeps focus in the card slot when a newer part turns the current card into an older one', () => {
      const { init } = renderWithHost(
        <MessageList />,
        chat(makePlanDoc({ versions: [version(1, 'a')] }), [1]),
      );
      screen.getByRole('button', { name: 'Title 1, open version 1' }).focus();
      init(chat(makePlanDoc({ versions: [version(1, 'a'), version(2, 'b')] }), [1, 2]), 1);
      expect(document.querySelectorAll('.plan-card--older')).toHaveLength(1);
      expect(document.activeElement).not.toBe(document.body);
      expect(slots()[0]?.contains(document.activeElement)).toBe(true);
    });

    it('keeps focus in an older card when Restore this version goes away', () => {
      const before = makePlanDoc({ versions: [version(1, 'a'), version(2, 'b'), version(3, 'c')] });
      const after = makePlanDoc({
        versions: [...before.versions, version(4, 'b', { restoredFrom: 2 })],
      });
      const { init } = renderWithHost(<MessageList />, chat(before, [1, 2, 3]));
      screen.getByRole('button', { name: 'Restore this version (version 2)' }).focus();
      init(chat(after, [1, 2, 3]), 1);
      expect(screen.queryByRole('button', { name: 'Restore this version (version 2)' })).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(slots()[1]?.contains(document.activeElement)).toBe(true);
    });

    it('keeps focus in the first older card when its whole actions row goes away', () => {
      const before = makePlanDoc({ versions: [version(1, 'a'), version(2, 'b')] });
      const after = makePlanDoc({
        versions: [...before.versions, version(3, 'a', { restoredFrom: 1 })],
      });
      const { init } = renderWithHost(<MessageList />, chat(before, [1, 2]));
      screen.getByRole('button', { name: 'Restore this version (version 1)' }).focus();
      init(chat(after, [1, 2]), 1);
      expect(document.querySelector('.plan-card--older .plan-card-actions')).toBeNull();
      expect(document.activeElement).not.toBe(document.body);
      expect(slots()[0]?.contains(document.activeElement)).toBe(true);
    });

    it('moves focus from the synthetic card to the current card when a part for the plan arrives', () => {
      const doc = makePlanDoc({ versions: [version(1, 'a')] });
      const { init } = renderWithHost(<MessageList />, chat(doc, []));
      screen.getByRole('button', { name: 'Title 1, open version 1' }).focus();
      expect(document.querySelectorAll('.plan-card-slot')).toHaveLength(0);
      init(chat(doc, [1]), 1);
      const title = document.querySelector('.plan-card--current .plan-card-open');
      expect(title).not.toBeNull();
      expect(document.activeElement).toBe(title);
    });
  });

  it('returns focus to the composer when a toast is dismissed', () => {
    const { host } = renderWithHost(<App />);
    host.emit({ type: 'event', event: { kind: 'toast', level: 'info', text: 'Copied' } });
    const dismiss = screen.getByRole('button', { name: 'Dismiss notification' });
    dismiss.focus();
    fireEvent.click(dismiss);
    expect(document.activeElement).toBe(composer());
  });

  it('returns focus to the composer when a banner is dismissed', () => {
    const banner = { id: 'b1', level: 'info' as const, text: 'FYI', dismissible: true };
    const { init } = renderWithHost(<App />, makeState({ banners: [banner] }));
    screen.getByRole('button', { name: 'Dismiss' }).focus();
    init(makeState({ banners: [] }), 1);
    expect(document.activeElement).toBe(composer());
  });

  it('restores focus to the menu button when the menu closes', () => {
    renderWithHost(<App />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('does not trap focus in the menu: Tab closes it', () => {
    renderWithHost(<App />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0] as HTMLElement, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('focus when the tab changes', () => {
  const planState = (): ViewState =>
    makeState({
      active: makeActive('c1', {
        plan: makePlanDoc({ versions: [makePlanVersion(1), makePlanVersion(2)] }),
        messages: [
          assistantMessage('a1', [{ kind: 'plan-update', planId: 'plan1' as never, version: 2 }]),
        ],
      }),
    });

  it('does not move focus away from the tab the user pressed', () => {
    renderWithHost(<App />, planState());
    const tab = screen.getByRole('tab', { name: 'History' });
    tab.focus();
    fireEvent.click(tab);
    expect(document.activeElement).toBe(tab);
  });

  it('leaves focus in the composer when nothing changes tab', () => {
    const { init } = renderWithHost(<App />, planState());
    composer().focus();
    init(planState(), 1);
    expect(document.activeElement).toBe(composer());
  });

  it('puts focus on a panel, not on the page, when a host event replaces the composer', () => {
    const { host } = renderWithHost(<App />, planState());
    composer().focus();
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'history' } });
    expect(document.activeElement?.getAttribute('role')).toBe('tabpanel');
  });

  it('focuses the composer for focus-composer even from another tab', async () => {
    const { host } = renderWithHost(<App />, planState());
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    host.emit({ type: 'event', event: { kind: 'focus-composer' } });
    await waitFor(() => {
      expect(document.activeElement).toBe(composer());
    });
  });

  it('keeps a prefill sent while another tab is open', async () => {
    const { host } = renderWithHost(<App />, planState());
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    host.emit({ type: 'event', event: { kind: 'prefill-composer', text: 'from a fork' } });
    await waitFor(() => {
      expect(composer().value).toBe('from a fork');
    });
    expect(document.activeElement).toBe(composer());
  });
});

/* ------------------------------------------------------------------ 1 and 3. keyboard, names, roles, states */

describe('keyboard, names, roles and states', () => {
  const busyHost = makeState({
    provider: makeProvider({ installed: false, problems: ['Install it.'] }),
  });

  it('never uses a positive tabindex, and every custom link can be tabbed to', () => {
    renderWithHost(
      <App />,
      makeState({
        active: makeActive('c1', {
          plan: makePlanDoc(),
          messages: [
            userMessage('u1', 'hi'),
            assistantMessage('a1', [
              {
                kind: 'text',
                text: 'See `src/a.ts` and [b](src/b.ts)\n\n```ts\nconst a = 1;\n```',
              },
              { kind: 'tool', call: makeToolCall({ name: 'Read', input: { file_path: 'a.ts' } }) },
            ]),
          ],
        }),
        review: { entries: [makeReviewEntry('a.ts')], configChanges: [], busy: false },
        checkpoints: [makeCheckpoint('op1')],
        permissions: makeFolderPermissions({ saved: [makeSavedPermission('d1')] }),
      }),
    );
    for (const tab of ['Checkpoints', 'History', 'Permissions', 'Chat']) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }));
      for (const el of document.querySelectorAll('[tabindex]')) {
        expect(Number(el.getAttribute('tabindex')), el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(
          0,
        );
      }
      for (const link of document.querySelectorAll('[role="link"]')) {
        expect(link.getAttribute('tabindex')).toBe('0');
      }
    }
  });

  it('names each side question card and tells its buttons apart, and points the composer at its note', () => {
    renderWithHost(
      <>
        <MessageList />
        <Composer />
      </>,
      makeState({
        active: makeActive('c1', {
          messages: [
            userMessage('u1', 'go'),
            assistantMessage('a1', [{ kind: 'text', text: 'x' }]),
          ],
          turns: [makeTurn({ status: 'running' })],
          asides: [
            makeAside('b1', { question: 'First?', status: 'completed' }),
            makeAside('b2', { question: 'Second?' }),
          ],
        }),
      }),
    );
    const names = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual(['Side question: First?', 'Side question: Second?']);
    const second = within(screen.getByRole('region', { name: 'Side question: Second?' }));
    expect(second.getByRole('button', { name: 'Stop side question: Second?' })).toBeTruthy();
    expect(second.getByRole('button', { name: 'Open as conversation: Second?' })).toBeTruthy();
    // A side question is running: the next Ask send is disabled, with its reason.
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
    fireEvent.change(composer(), { target: { value: 'again' } });
    expect(send.disabled).toBe(true);
    expect(document.getElementById(send.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'A side question is already running. Wait for it or stop it.',
    );
  });

  it('points the composer at the side question note while an Ask send is allowed', () => {
    renderWithHost(
      <Composer />,
      makeState({ active: makeActive('c1', { turns: [makeTurn({ status: 'running' })] }) }),
    );
    expect(
      document.getElementById(composer().getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('Asked as a side question: the agent keeps working and does not see it.');
  });

  it('names the queued message region and its buttons, and points a disabled Send at its reason', () => {
    renderWithHost(
      <>
        <QueuedMessage />
        <Composer />
      </>,
      makeState({
        active: makeActive('c1', {
          meta: { mode: 'agent' },
          turns: [makeTurn({ status: 'running' })],
          queued: {
            text: 'next',
            mode: 'agent',
            model: 'default',
            attachments: [],
            queuedAt: 1,
          },
        }),
        review: { entries: [], configChanges: [makeConfigChange('k1')], busy: false },
      }),
    );
    const chip = screen.getByRole('region', { name: 'Queued message' });
    expect(within(chip).getByRole('button', { name: 'Edit queued message' })).toBeTruthy();
    expect(within(chip).getByRole('button', { name: 'Remove queued message' })).toBeTruthy();
    const now = within(chip).getByRole<HTMLButtonElement>('button', {
      name: 'Send now, queued message',
    });
    expect(now.disabled).toBe(true);
    expect(document.getElementById(now.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Sent when the agent finishes if the configuration changes are decided by then. Otherwise press Send afterwards.',
    );
    // Stop and Send are both in the composer, and Send is disabled with its own reason.
    const form = screen.getByRole('form', { name: 'Message composer' });
    expect(within(form).getByRole('button', { name: 'Stop' })).toBeTruthy();
    const send = within(form).getByRole<HTMLButtonElement>('button', { name: 'Send' });
    expect(send.disabled).toBe(true);
    expect(document.getElementById(send.getAttribute('aria-describedby') ?? '')).not.toBeNull();
  });

  it('follows the tabs pattern: one tab in the tab order, each tab controls a panel', () => {
    renderWithHost(
      <App />,
      makeState({
        active: makeActive('c1', { plan: makePlanDoc() }),
        review: { entries: [makeReviewEntry('a.ts')], configChanges: [], busy: false },
        checkpoints: [makeCheckpoint('op1')],
      }),
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(3);
    expect(tabs.filter((t) => t.getAttribute('tabindex') === '0')).toHaveLength(1);
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    // The arrow keys move through all of them.
    const chat = screen.getByRole('tab', { name: 'Chat' });
    for (let i = 0; i < 3; i++) {
      fireEvent.keyDown(document.activeElement ?? chat, { key: 'ArrowRight' });
    }
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the hover-only message actions reachable: real buttons that are not hidden', () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          messages: [
            userMessage('u1', 'hi'),
            assistantMessage('a1', [{ kind: 'text', text: 'x' }]),
          ],
        }),
      }),
    );
    const actions = document.querySelectorAll<HTMLButtonElement>('.message-actions button');
    expect(actions).toHaveLength(4);
    for (const button of actions) {
      expect(button.disabled).toBe(false);
      expect(button.closest('[hidden]')).toBeNull();
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('gives disabled composer controls the reason through aria-describedby', () => {
    renderWithHost(<Composer />, busyHost);
    const reason = screen.getByRole('status');
    for (const name of [
      'Send',
      'Add a file',
      'Add a folder',
      'Add the editor selection',
      /Add problems/,
    ]) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name });
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-describedby')).toBe(reason.id);
    }
  });

  it('explains why Submit is disabled, and drops the hint when it is not', () => {
    const off = registerPartRenderer('prompt', PromptPart);
    try {
      const prompt = makeQuestionPrompt('q1');
      renderWithHost(
        <MessageList />,
        makeState({
          active: makeActive('c1', {
            messages: [assistantMessage('a1', [{ kind: 'prompt', promptId: promptId('q1') }])],
            prompts: [prompt],
          }),
        }),
      );
      const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'Submit' });
      const hint = document.getElementById(submit.getAttribute('aria-describedby') ?? '');
      expect(hint?.textContent).toBe('Answer every question to submit.');
      fireEvent.click(screen.getByRole('radio', { name: 'Red' }));
      expect(submit.hasAttribute('aria-describedby')).toBe(false);
      expect(screen.queryByText('Answer every question to submit.')).toBeNull();
    } finally {
      off();
    }
  });

  it('explains why Restore Selected Files is disabled when nothing is ticked', () => {
    const target = makeCheckpoint('op1');
    renderWithHost(
      <CheckpointsView />,
      makeState({
        checkpoints: [target],
        restorePreview: makeRestorePreview({
          targetOperationId: target.operationId,
          items: [makeRestoreItem('a.ts', { selectedByDefault: false })],
        }),
      }),
    );
    const button = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Restore Selected Files',
    });
    expect(button.disabled).toBe(true);
    expect(
      document.getElementById(button.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toBe('0 of 1 file selected');
  });

  it('gives every control of a busy app a name', () => {
    renderWithHost(
      <App />,
      makeState({
        active: makeActive('c1', {
          plan: makePlanDoc(),
          messages: [userMessage('u1', 'hi')],
          asides: [
            makeAside('b1', {
              anchor: { messageId: msgId('u1'), afterParts: 0 },
              question: 'Why?',
            }),
          ],
        }),
        review: {
          entries: [makeReviewEntry('a.ts')],
          configChanges: [makeConfigChange('k1')],
          busy: false,
        },
        checkpoints: [makeCheckpoint('op1')],
        conversations: [makeSummary('c1')],
        permissions: makeFolderPermissions({
          switches: ['read-outside'],
          saved: [makeSavedPermission('d1')],
        }),
        banners: [{ id: 'b', level: 'info', text: 'FYI', dismissible: true }],
      }),
    );
    for (const tab of ['Chat', 'Checkpoints', 'History', 'Permissions']) {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }));
      for (const el of document.querySelectorAll<HTMLElement>('button, input, select, textarea')) {
        const byIds = (el.getAttribute('aria-labelledby') ?? '')
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join('');
        const control = el as HTMLInputElement;
        const label =
          el.getAttribute('aria-label') ??
          (byIds !== '' ? byIds : null) ??
          control.labels?.[0]?.textContent ??
          el.closest('label')?.textContent ??
          el.textContent ??
          '';
        expect(label.trim(), `${tab}: ${el.outerHTML.slice(0, 90)}`).not.toBe('');
      }
    }
  });
});

/* ------------------------------------------------------------------ 8. text alternatives, scrollable boxes */

describe('the Auto switch', () => {
  const stateOf = (
    over: { on?: boolean; running?: boolean; mode?: 'ask' | 'agent' } = {},
    extra: Partial<ViewState> = {},
  ) =>
    makeState({
      ...autoOffered(),
      active: makeActive('c1', {
        meta: { mode: over.mode ?? 'agent', agentAuto: over.on === true },
        turns: [makeTurn({ status: over.running === true ? 'running' : 'completed' })],
      }),
      ...extra,
    });
  const auto = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Auto' });

  it('has a name and a pressed state', () => {
    const { init } = renderWithHost(<Composer />, stateOf());
    expect(auto().getAttribute('aria-pressed')).toBe('false');
    init(stateOf({ on: true }), 1);
    expect(auto().getAttribute('aria-pressed')).toBe('true');
    expect(auto().getAttribute('type')).toBe('button');
  });

  it('exposes why it cannot be turned on, with the real disabled attribute', () => {
    renderWithHost(<Composer />, stateOf({ running: true }));
    expect(auto().disabled).toBe(true);
    const ids = (auto().getAttribute('aria-describedby') ?? '').split(' ');
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Auto can be turned on when the turn ends.',
    ]);
  });

  it('exposes the notice as the reason while the composer is blocked', () => {
    renderWithHost(<Composer />, stateOf({}, { trusted: false }));
    expect(auto().disabled).toBe(true);
    const reason = document.getElementById(auto().getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toContain('not trusted');
  });

  it('does not convey the on state by colour alone', () => {
    const { init } = renderWithHost(<Composer />, stateOf());
    const off = auto().querySelector('.codicon')?.className;
    init(stateOf({ on: true }), 1);
    // The state is in the pressed attribute, the icon, and the hint line in words; the class adds
    // weight and an outline (checked in styles.test.ts).
    expect(auto().querySelector('.codicon')?.className).not.toBe(off);
    expect(auto().querySelector('.codicon')?.getAttribute('aria-hidden')).toBe('true');
    expect(auto().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/^Auto is on:/)).toBeTruthy();
  });

  it('is turned off in every mode, so it is never stuck on', () => {
    renderWithHost(<Composer />, stateOf({ on: true, mode: 'ask', running: true }));
    expect(auto().disabled).toBe(false);
  });

  it('is flagged in History in words, not by the icon alone', () => {
    renderWithHost(
      <HistoryList onOpened={() => undefined} />,
      makeState({
        ...autoOffered(),
        conversations: [makeSummary('a', { title: 'Talk', mode: 'agent', agentAuto: true })],
      }),
    );
    const flag = document.querySelector('.history-flag') as HTMLElement;
    expect(flag.textContent).toContain('Auto');
    expect(flag.querySelector('.visually-hidden')?.textContent).toContain('Auto is on');
    expect(flag.querySelector('.codicon')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('the Permissions view', () => {
  const full = makeFolderPermissions({
    switches: ['read-outside'],
    saved: [
      makeSavedPermission('d1', { kind: 'read-directory', text: '/libs/shared' }),
      makeSavedPermission('w1', { kind: 'web-site', text: 'docs.example.com' }),
      makeSavedPermission('c1', {
        kind: 'command',
        text: 'npm test',
        shell: 'bash',
        runsProjectCode: true,
      }),
      makeSavedPermission('t1', { kind: 'mcp-tool', text: 'mcp__docs__search' }),
    ],
  });
  const view = (over: Partial<ViewState> = {}) =>
    renderWithHost(<PermissionsView />, makeState({ permissions: full, ...over }));

  it('has headings in order, without skipped levels', () => {
    view();
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
    expect(levels[0]).toBe(2);
    expect(levels.every((level) => level === 2 || level === 3)).toBe(true);
    levels.forEach((level, i) => {
      if (i > 0) expect(level - (levels[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    });
    expect(levels.filter((l) => l === 2)).toHaveLength(4);
  });

  it('gives every control a name, and puts every list in a real list', () => {
    view();
    const controls = document.querySelectorAll<HTMLElement>('button, input, select, textarea');
    expect(controls.length).toBeGreaterThan(8);
    for (const el of controls) {
      const byIds = (el.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join('');
      const name = el.getAttribute('aria-label') ?? (byIds !== '' ? byIds : (el.textContent ?? ''));
      expect(name.trim(), el.outerHTML.slice(0, 100)).not.toBe('');
    }
    expect(screen.getAllByRole('list').length).toBeGreaterThanOrEqual(5);
  });

  it('gives every switch a role, a checked state and a name', () => {
    view();
    const switches = screen.getAllByRole('switch');
    expect(switches).toHaveLength(3);
    expect(switches.map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    for (const s of switches) {
      expect(s.tagName).toBe('BUTTON');
      expect(s.getAttribute('aria-pressed')).toBeNull();
      expect(
        document.getElementById(s.getAttribute('aria-labelledby') ?? '')?.textContent,
      ).toBeTruthy();
    }
  });

  it('uses no positive tabindex, and has one scroll container that script can focus', () => {
    view();
    for (const el of document.querySelectorAll('[tabindex]')) {
      expect(Number(el.getAttribute('tabindex')), el.outerHTML.slice(0, 80)).toBeLessThanOrEqual(0);
    }
    expect(document.querySelector('.permissions-scroll')?.getAttribute('tabindex')).toBe('-1');
  });

  it('points every disabled control at its reason, which is on the page', () => {
    view({ trusted: false });
    const disabled = Array.from(document.querySelectorAll<HTMLButtonElement>('button:disabled'));
    expect(disabled).toHaveLength(8);
    for (const el of disabled) {
      const reason = (el.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent)
        .join(' ');
      expect(reason, el.outerHTML.slice(0, 100)).toContain('not trusted');
    }
  });

  it('names the warning for a command in words, with the icon hidden', () => {
    view();
    const row = screen.getByText('npm test').closest('li') as HTMLElement;
    expect(row.querySelector('.visually-hidden')?.textContent).toBe('Warning: ');
    expect(row.querySelector('.codicon')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps focus on the page when the pressed entry goes away', () => {
    const { init } = view();
    const remove = screen.getByRole('button', { name: 'Remove docs.example.com' });
    remove.focus();
    fireEvent.click(remove);
    init(
      makeState({
        permissions: { ...full, saved: full.saved.filter((e) => e.id !== 'w1') },
      }),
      1,
    );
    expect(document.activeElement).not.toBe(document.body);
    expect(document.querySelector('.permissions-scroll')?.contains(document.activeElement)).toBe(
      true,
    );
  });
});

describe('scrollable boxes and text alternatives', () => {
  it('gives the changes card a name, a toggle that states what it controls, and a reachable scroll box', () => {
    renderWithHost(
      <ChangesDock />,
      makeState({
        review: {
          entries: [makeReviewEntry('a.ts')],
          configChanges: [makeConfigChange('k1')],
          busy: false,
        },
      }),
    );
    const card = screen.getByRole('region', { name: 'Changes' });
    const toggle = within(card).getByRole('button', { name: /^Changes/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const region = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    const body = within(card).getByRole('group', { name: 'Changes details' });
    expect(body.getAttribute('tabindex')).toBe('0');
    expect(body.contains(region)).toBe(true);
    // Collapsed, the files are hidden from everyone, not only from sight; the decision stays.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(region?.hidden).toBe(true);
    expect(within(card).queryByRole('button', { name: 'Accept All' })).toBeNull();
    expect(within(card).getByRole('button', { name: /^Keep / })).toBeTruthy();
  });

  it('lets the keyboard reach a scrolling diagram, table, code block and tool output', async () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          messages: [
            assistantMessage('a1', [
              {
                kind: 'text',
                text: '| a | b |\n| - | - |\n| 1 | 2 |\n\n```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD; A-->B;\n```',
              },
              {
                kind: 'tool',
                call: makeToolCall({
                  name: 'Bash',
                  input: { command: 'ls', description: 'List' },
                  resultPreview: 'out',
                }),
              },
            ]),
          ],
        }),
      }),
    );
    const table = document.querySelector('.markdown-table') as HTMLElement;
    expect(table.getAttribute('tabindex')).toBe('0');
    expect(table.getAttribute('aria-label')).toBe('Table');
    expect(table.querySelector('table')).not.toBeNull();
    const code = screen.getByRole('group', { name: 'ts code' });
    expect(code.tagName).toBe('PRE');
    expect(code.getAttribute('tabindex')).toBe('0');
    const diagram = await screen.findByRole('img', { name: 'Diagram' });
    expect(diagram.getAttribute('tabindex')).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    for (const name of ['Input', 'Result']) {
      expect(screen.getByRole('group', { name }).getAttribute('tabindex')).toBe('0');
    }
  });
});
