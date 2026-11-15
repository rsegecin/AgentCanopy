// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Aside, MessagePart } from '../../../shared';
import {
  assistantMessage,
  convId,
  makeActive,
  makeAside,
  makeQuestionPrompt,
  makeState,
  makeToolCall,
  makeTurn,
  msgId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { MessageList } from './MessageList';
import { PromptPart } from './PromptCards';
import { registerPartRenderer } from './registry';

const text = (t: string): MessagePart => ({ kind: 'text', text: t });

let unregister: () => void;
beforeEach(() => {
  unregister = registerPartRenderer('prompt', PromptPart);
});
afterEach(() => {
  unregister();
  vi.unstubAllGlobals();
});

function stateWith(asides: Aside[], parts: MessagePart[] = [text('P1'), text('P2'), text('P3')]) {
  return makeState({
    active: makeActive('c1', {
      turns: [makeTurn({ status: 'running' })],
      messages: [userMessage('u1', 'work on it'), assistantMessage('a1', parts)],
      asides,
    }),
  });
}

const card = (question: string) =>
  screen.getByRole('region', { name: `Side question: ${question}` });

/** The children of the assistant message after its header: a part's text, or "card:" and the question. */
function assistantOrder(): string[] {
  const article = screen.getByRole('article', { name: 'Assistant' });
  return Array.from(article.children)
    .filter((el) => !el.classList.contains('message-meta'))
    .map((el) =>
      el.tagName === 'SECTION'
        ? `card:${el.querySelector('.aside-question')?.textContent ?? ''}`
        : (el.textContent ?? '').trim(),
    );
}

describe('side question card position', () => {
  it('sits after N parts of an assistant message', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', anchor: { messageId: msgId('a1'), afterParts: 1 } }),
      ]),
    );
    expect(assistantOrder()).toEqual(['P1', 'card:Q1', 'P2', 'P3']);
  });

  it('sits before the first part when it was asked under a message with none yet', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', anchor: { messageId: msgId('a1'), afterParts: 0 } }),
      ]),
    );
    expect(assistantOrder()).toEqual(['card:Q1', 'P1', 'P2', 'P3']);
  });

  it('is clamped to the number of parts the message has', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', anchor: { messageId: msgId('a1'), afterParts: 9 } }),
      ]),
    );
    expect(assistantOrder()).toEqual(['P1', 'P2', 'P3', 'card:Q1']);
  });

  it('sits right after a user message when that is the anchor', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', anchor: { messageId: msgId('u1'), afterParts: 0 } }),
      ]),
    );
    const user = screen.getByRole('article', { name: 'You' });
    expect(user.nextElementSibling).toBe(card('Q1'));
    expect(within(user).queryByRole('region')).toBeNull();
    expect(card('Q1').nextElementSibling).toBe(screen.getByRole('article', { name: 'Assistant' }));
  });

  it('goes to the end of the log when its message is not in the transcript', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', anchor: { messageId: msgId('gone'), afterParts: 3 } }),
      ]),
    );
    const column = screen.getByRole('log').firstElementChild;
    expect(column?.lastElementChild).toBe(card('Q1'));
    expect(assistantOrder()).toEqual(['P1', 'P2', 'P3']);
  });

  it('puts the oldest first when several share an anchor', () => {
    const anchor = { messageId: msgId('a1'), afterParts: 2 };
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'First', anchor, status: 'completed' }),
        makeAside('b2', { question: 'Second', anchor }),
      ]),
    );
    expect(assistantOrder()).toEqual(['P1', 'P2', 'card:First', 'card:Second', 'P3']);
  });

  it('places cards at different anchors each where they belong', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Early', anchor: { messageId: msgId('a1'), afterParts: 1 } }),
        makeAside('b2', { question: 'Late', anchor: { messageId: msgId('a1'), afterParts: 3 } }),
        makeAside('b3', { question: 'Lost', anchor: { messageId: msgId('x'), afterParts: 0 } }),
      ]),
    );
    expect(assistantOrder()).toEqual(['P1', 'card:Early', 'P2', 'P3', 'card:Late']);
    expect(screen.getByRole('log').firstElementChild?.lastElementChild).toBe(card('Lost'));
  });

  it('renders no card without side questions', () => {
    renderWithHost(<MessageList />, stateWith([]));
    expect(screen.queryByRole('region')).toBeNull();
  });
});

describe('side question card content', () => {
  it('shows the label, the question and the note that the agent did not see it', () => {
    renderWithHost(<MessageList />, stateWith([makeAside('b1', { question: 'What is X?' })]));
    const c = card('What is X?');
    expect(within(c).getByText('Side question')).toBeTruthy();
    expect(within(c).getByText('What is X?')).toBeTruthy();
    expect(within(c).getByText('The agent did not see this question.')).toBeTruthy();
  });

  it('draws the answer with the transcript part renderers, in order', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', {
          question: 'Q1',
          status: 'completed',
          parts: [
            text('Answer **bold** text'),
            { kind: 'tool', call: makeToolCall({ input: { command: 'ls src' } }) },
            { kind: 'notice', level: 'warning', text: 'Heads up' },
          ],
        }),
      ]),
    );
    const c = card('Q1');
    expect(c.querySelector('strong')?.textContent).toBe('bold');
    expect(within(c).getByText(/ls src/)).toBeTruthy();
    expect(within(c).getByText(/Heads up/)).toBeTruthy();
    const body = c.textContent ?? '';
    expect(body.indexOf('Answer')).toBeLessThan(body.indexOf('ls src'));
    expect(body.indexOf('ls src')).toBeLessThan(body.indexOf('Heads up'));
  });

  it('finds a prompt part in the side question prompts, and answers it', () => {
    const prompt = makeQuestionPrompt('pq1', { conversationId: convId('b1') });
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', {
          question: 'Q1',
          parts: [{ kind: 'prompt', promptId: prompt.id }],
          prompts: [prompt],
        }),
      ]),
    );
    const c = card('Q1');
    // The open conversation has no prompts: the card found it in the side question's own list.
    expect(within(c).getByRole('group', { name: /Question from the agent/ })).toBeTruthy();
    expect(within(c).getByText('Needs your answer')).toBeTruthy();
    fireEvent.click(within(c).getByRole('radio', { name: /Red/ }));
    fireEvent.click(within(c).getByRole('button', { name: 'Submit' }));
    expect(host.postedOf('prompt.answer')).toEqual([
      {
        type: 'prompt.answer',
        promptId: prompt.id,
        displayHash: prompt.displayHash,
        answer: { kind: 'question', answers: { 'Which colour do you prefer?': ['Red'] } },
      },
    ]);
  });

  it('falls back to the placeholder when the prompt is not in the side question prompts', () => {
    const elsewhere = makeQuestionPrompt('pq9');
    const state = stateWith([
      makeAside('b1', { question: 'Q1', parts: [{ kind: 'prompt', promptId: elsewhere.id }] }),
    ]);
    // The same id exists in the open conversation, which must not be consulted for this card.
    if (state.active) state.active.prompts = [elsewhere];
    renderWithHost(<MessageList />, state);
    expect(within(card('Q1')).queryByRole('group', { name: /Question from the agent/ })).toBeNull();
    expect(within(card('Q1')).getByText('Waiting for your answer')).toBeTruthy();
  });

  it('keeps prompt cards of the transcript working beside a card', () => {
    const own = makeQuestionPrompt('own1');
    const state = stateWith(
      [makeAside('b1', { question: 'Q1' })],
      [{ kind: 'prompt', promptId: own.id }],
    );
    if (state.active) state.active.prompts = [own];
    renderWithHost(<MessageList />, state);
    expect(screen.getByRole('group', { name: /Question from the agent/ })).toBeTruthy();
  });
});

describe('side question status line', () => {
  const status = (c: HTMLElement) => within(c).queryByRole('status');

  it.each(['running', 'preparing'] as const)('says Answering… while %s with no part yet', (s) => {
    renderWithHost(<MessageList />, stateWith([makeAside('b1', { question: 'Q1', status: s })]));
    expect(status(card('Q1'))?.textContent).toBe('Answering…');
  });

  it('shows no status line once the answer streams, and says Answered. when completed', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', parts: [text('So far')] }),
        makeAside('b2', { question: 'Q2', status: 'completed', parts: [text('Done')] }),
      ]),
    );
    expect(status(card('Q1'))).toBeNull();
    expect(status(card('Q2'))?.textContent).toBe('Answered.');
  });

  it('says Stopped. when interrupted', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', status: 'interrupted', parts: [text('Part')] }),
      ]),
    );
    expect(status(card('Q1'))?.textContent).toBe('Stopped.');
  });

  it('shows the error text as an alert when the side question fails while shown', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1', parts: [text('x')] })]),
    );
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [
        { op: 'set', path: ['active', 'asides', 0, 'status'], value: 'error' },
        { op: 'set', path: ['active', 'asides', 0, 'error'], value: 'The model is unavailable.' },
      ],
    });
    const alert = within(card('Q1')).getByRole('alert');
    expect(alert.textContent).toBe('The model is unavailable.');
    expect(status(card('Q1'))).toBeNull();
  });

  it('shows the error of a card that had already failed when it appeared as a plain line', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', status: 'error', error: 'The model is unavailable.' }),
        makeAside('b2', { question: 'Q2', status: 'error' }),
      ]),
    );
    expect(within(card('Q1')).getByText('The model is unavailable.')).toBeTruthy();
    expect(within(card('Q2')).getByText('The side question failed.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(status(card('Q1'))).toBeNull();
  });
});

describe('side question card actions', () => {
  it('Stop posts turn.cancel for the side question branch, not the open conversation', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1' }), makeAside('b2', { question: 'Q2' })]),
    );
    fireEvent.click(within(card('Q2')).getByRole('button', { name: 'Stop side question: Q2' }));
    expect(host.postedOf('turn.cancel')).toEqual([
      { type: 'turn.cancel', conversationId: convId('b2') },
    ]);
  });

  it('Open as conversation posts conversation.open with the branch id', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1' }), makeAside('b2', { question: 'Q2' })]),
    );
    fireEvent.click(within(card('Q1')).getByRole('button', { name: 'Open as conversation: Q1' }));
    expect(host.postedOf('conversation.open')).toEqual([
      { type: 'conversation.open', conversationId: convId('b1') },
    ]);
  });

  it('shows Stop only while the side question runs, and Open as conversation always', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        makeAside('b1', { question: 'Q1', status: 'completed' }),
        makeAside('b2', { question: 'Q2', status: 'error' }),
        makeAside('b3', { question: 'Q3', status: 'interrupted' }),
      ]),
    );
    for (const q of ['Q1', 'Q2', 'Q3']) {
      expect(within(card(q)).queryByRole('button', { name: /^Stop/ })).toBeNull();
      expect(
        within(card(q)).getByRole('button', { name: `Open as conversation: ${q}` }),
      ).toBeTruthy();
    }
  });

  it('names a long question in shortened form', () => {
    const long = 'word '.repeat(40).trim();
    renderWithHost(<MessageList />, stateWith([makeAside('b1', { question: long })]));
    const region = screen.getByRole('region', { name: /^Side question: word word/ });
    const name = region.getAttribute('aria-label') ?? '';
    expect(name.length).toBeLessThan(90);
    expect(name.endsWith('…')).toBe(true);
    expect(within(region).getByText(long)).toBeTruthy();
  });

  it('keeps focus on the card when Stop goes away because the side question ended', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1', parts: [text('x')] })]),
    );
    const stop = screen.getByRole('button', { name: 'Stop side question: Q1' });
    stop.focus();
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'set', path: ['active', 'asides', 0, 'status'], value: 'completed' }],
    });
    expect(screen.queryByRole('button', { name: 'Stop side question: Q1' })).toBeNull();
    expect(document.activeElement).toBe(card('Q1'));
  });
});

describe('side question card updates', () => {
  let renders: Record<string, number>;
  let unregisterText: () => void;
  beforeEach(() => {
    renders = {};
    unregisterText = registerPartRenderer('text', ({ part }) => {
      renders[part.text] = (renders[part.text] ?? 0) + 1;
      return <p>{part.text}</p>;
    });
  });
  afterEach(() => {
    unregisterText();
  });

  it('re-renders only the card whose text grows: not the other cards, not the transcript', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith(
        [
          makeAside('b1', { question: 'Q1', parts: [text('first answer')] }),
          makeAside('b2', {
            question: 'Q2',
            anchor: { messageId: msgId('a1'), afterParts: 2 },
            parts: [text('second answer')],
          }),
        ],
        [text('P1'), text('P2'), text('P3')],
      ),
    );
    const before = { ...renders };
    expect(before['first answer']).toBeGreaterThan(0);
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'appendText', path: ['active', 'asides', 0, 'parts', 0, 'text'], text: ' more' }],
    });
    expect(within(card('Q1')).getByText('first answer more')).toBeTruthy();
    expect(renders['first answer more']).toBe(1);
    expect(renders['second answer']).toBe(before['second answer']);
    expect(renders['P1']).toBe(before['P1']);
    expect(renders['P2']).toBe(before['P2']);
    expect(renders['P3']).toBe(before['P3']);
  });

  it('does not re-render the transcript parts when the side question changes status', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1' })]),
    );
    const before = { ...renders };
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [
        { op: 'push', path: ['active', 'asides', 0, 'parts'], value: text('hello') },
        { op: 'set', path: ['active', 'asides', 0, 'status'], value: 'completed' },
      ],
    });
    expect(within(card('Q1')).getByText('hello')).toBeTruthy();
    expect(renders['P1']).toBe(before['P1']);
    expect(renders['P3']).toBe(before['P3']);
  });

  it('keeps the card, and its focus, while a part is appended after it', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1', parts: [text('a')] })]),
    );
    const open = screen.getByRole('button', { name: 'Open as conversation: Q1' });
    open.focus();
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'push', path: ['active', 'asides', 0, 'parts'], value: text('b') }],
    });
    expect(screen.getByRole('button', { name: 'Open as conversation: Q1' })).toBe(open);
    expect(document.activeElement).toBe(open);
  });
});

describe('the log stays at the bottom while a side question streams', () => {
  let observers: { callback: () => void; target: Element | null; disconnected: boolean }[];
  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: (typeof observers)[number];
        constructor(callback: () => void) {
          this.entry = { callback, target: null, disconnected: false };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        unobserve() {}
        disconnect() {
          this.entry.disconnected = true;
        }
      },
    );
  });
  const geometry = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
  };
  const resize = (target: Element) => {
    act(() => {
      for (const o of observers) if (o.target === target && !o.disconnected) o.callback();
    });
  };

  it('follows the content when a card in the middle grows', () => {
    renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1', parts: [text('a')] })]),
    );
    const log = screen.getByRole('log');
    const content = log.firstElementChild as HTMLElement;
    geometry(log, 1000, 400);
    log.scrollTop = 600;
    fireEvent.scroll(log);
    // The card grew: the content got taller, the log did not change and nothing scrolled.
    geometry(log, 1300, 400);
    resize(content);
    expect(log.scrollTop).toBe(1300);
  });

  it('does not pull a user who scrolled up', () => {
    renderWithHost(
      <MessageList />,
      stateWith([makeAside('b1', { question: 'Q1', parts: [text('a')] })]),
    );
    const log = screen.getByRole('log');
    const content = log.firstElementChild as HTMLElement;
    geometry(log, 2000, 400);
    log.scrollTop = 100;
    fireEvent.scroll(log);
    geometry(log, 2300, 400);
    resize(content);
    expect(log.scrollTop).toBe(100);
  });
});
