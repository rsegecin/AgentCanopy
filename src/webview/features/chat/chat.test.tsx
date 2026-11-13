// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessagePart, ToolCallView } from '../../../shared';
import {
  assistantMessage,
  convId,
  makeActive,
  makeState,
  makeTurn,
  msgId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { MessageList } from './MessageList';
import { summarizeToolInput } from './ToolCard';
import { registerPartRenderer } from './registry';

function tool(over: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: 'toolu_1',
    name: 'Bash',
    input: { command: 'npm test', description: 'run tests' },
    inputTruncated: false,
    status: 'done',
    approval: 'user',
    resultPreview: 'all green',
    parentId: null,
    startedAt: 1,
    ...over,
  };
}

function stateWith(parts: MessagePart[], extra: Parameters<typeof makeActive>[1] = {}) {
  return makeState({
    active: makeActive('c1', {
      messages: [userMessage('u1', 'first line\nsecond line'), assistantMessage('a1', parts)],
      ...extra,
    }),
  });
}

describe('MessageList', () => {
  it('shows an empty state without an active conversation', () => {
    renderWithHost(<MessageList />, makeState());
    expect(screen.getByText(/Ask a question, plan a change/)).toBeTruthy();
  });

  it('renders a user message with line breaks preserved, a mode badge and attachment chips', () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          messages: [
            userMessage('u1', 'line one\nline two', {
              mode: 'plan',
              attachments: [
                { kind: 'file', path: 'src/a.ts' },
                { kind: 'folder', path: 'src' },
                { kind: 'selection', path: 'src/b.ts', startLine: 3, endLine: 9, text: 'x' },
                { kind: 'diagnostics', path: 'src/c.ts', text: 'err' },
                { kind: 'image', id: 'd'.repeat(64), mediaType: 'image/png', bytes: 123456 },
              ],
            }),
          ],
        }),
      }),
    );
    const article = screen.getByRole('article', { name: 'You' });
    const text = article.querySelector('.user-text');
    expect(text?.textContent).toBe('line one\nline two');
    expect(within(article).getByText('Plan')).toBeTruthy();
    expect(within(article).getByText('a.ts')).toBeTruthy();
    expect(within(article).getByText('src')).toBeTruthy();
    expect(within(article).getByText('b.ts:3-9')).toBeTruthy();
    expect(within(article).getByText('Problems in c.ts')).toBeTruthy();
    expect(within(article).getByText('Image dddddd · PNG · 121 KB')).toBeTruthy();
  });

  it('renders every part kind', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        { kind: 'text', text: 'Hello **world**' },
        { kind: 'thinking', text: 'pondering' },
        { kind: 'tool', call: tool() },
        { kind: 'notice', level: 'warning', text: 'careful now' },
        { kind: 'plan-update', planId: 'p1' as never, version: 3 },
        { kind: 'prompt', promptId: 'q1' as never },
      ]),
    );
    expect(screen.getByText('world').tagName).toBe('STRONG');
    const thinking = screen.getByText('Thinking').closest('details');
    expect(thinking?.open).toBe(false);
    expect(screen.getByText('run tests')).toBeTruthy();
    expect(screen.getByText(/careful now/)).toBeTruthy();
    expect(screen.getByText('Plan updated to version 3')).toBeTruthy();
    expect(screen.getByText('Waiting for your answer')).toBeTruthy();
  });

  it('lets a later package replace a part renderer', () => {
    const off = registerPartRenderer('plan-update', ({ part }) => (
      <button type="button">Open plan v{part.version}</button>
    ));
    try {
      renderWithHost(
        <MessageList />,
        stateWith([{ kind: 'plan-update', planId: 'p1' as never, version: 2 }]),
      );
      expect(screen.getByRole('button', { name: 'Open plan v2' })).toBeTruthy();
      expect(screen.queryByText('Plan updated to version 2')).toBeNull();
    } finally {
      off();
    }
  });

  it('updates the text while appendText patches stream in, re-rendering only the last part', () => {
    const { host, container } = renderWithHost(
      <MessageList />,
      stateWith([
        { kind: 'text', text: 'First paragraph.' },
        { kind: 'text', text: 'Stream' },
      ]),
      undefined,
    );
    const firstPart = container.querySelectorAll('.markdown')[0];
    expect(screen.getByText('Stream')).toBeTruthy();

    host.emit({
      type: 'patch',
      seq: 1,
      ops: [
        { op: 'appendText', path: ['active', 'messages', 1, 'parts', 1, 'text'], text: 'ing now' },
      ],
    });
    host.emit({
      type: 'patch',
      seq: 2,
      ops: [
        {
          op: 'appendText',
          path: ['active', 'messages', 1, 'parts', 1, 'text'],
          text: ' **bold**',
        },
      ],
    });
    expect(screen.getByText(/Streaming now/)).toBeTruthy();
    expect(screen.getByText('bold').tagName).toBe('STRONG');
    // The untouched part keeps its DOM node: it was not re-rendered or remounted.
    expect(container.querySelectorAll('.markdown')[0]).toBe(firstPart);
  });

  it('re-renders only the streaming part (earlier parts are memoised)', () => {
    const renders: string[] = [];
    const off = registerPartRenderer('text', ({ part }) => {
      renders.push(part.text);
      return <p>{part.text}</p>;
    });
    try {
      const { host } = renderWithHost(
        <MessageList />,
        stateWith([
          { kind: 'text', text: 'First paragraph.' },
          { kind: 'text', text: 'Stream' },
        ]),
      );
      renders.length = 0;
      host.emit({
        type: 'patch',
        seq: 1,
        ops: [
          { op: 'appendText', path: ['active', 'messages', 1, 'parts', 1, 'text'], text: 'ing' },
        ],
      });
      expect(renders).toEqual(['Streaming']);
    } finally {
      off();
    }
  });

  it('shows the activity line only while the last turn runs, without announcing every change', () => {
    const { host, container } = renderWithHost(
      <MessageList />,
      stateWith([{ kind: 'text', text: 'x' }], {
        turns: [makeTurn({ status: 'running' })],
        activity: 'Reading src/a.ts',
      }),
    );
    const line = container.querySelector('.activity') as HTMLElement;
    // The line is for the eyes: the live region is a separate, quiet one (see accessibility tests).
    expect(line.hasAttribute('aria-live')).toBe(false);
    expect(within(line).getByText('Reading src/a.ts')).toBeTruthy();
    expect(container.querySelector('.activity .codicon-loading')).not.toBeNull();

    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'set', path: ['active', 'turns', 0, 'status'], value: 'completed' }],
    });
    expect(container.querySelector('.activity')?.textContent).toBe('');
  });

  it('uses a log region that does not announce streaming text', () => {
    renderWithHost(<MessageList />, stateWith([{ kind: 'text', text: 'x' }]));
    const log = screen.getByRole('log');
    expect(log.getAttribute('aria-live')).toBe('off');
  });

  it('shows a failed turn inline', () => {
    renderWithHost(
      <MessageList />,
      stateWith([{ kind: 'text', text: 'x' }], {
        turns: [makeTurn({ status: 'error', error: 'Claude Code crashed' })],
      }),
    );
    expect(screen.getByText(/Claude Code crashed/)).toBeTruthy();
  });

  it('posts conversation.fork and clipboard.copy from message actions', () => {
    const { host } = renderWithHost(
      <MessageList />,
      stateWith([
        { kind: 'text', text: 'Part one' },
        { kind: 'tool', call: tool() },
        { kind: 'text', text: 'Part two' },
      ]),
    );
    const assistant = screen.getByRole('article', { name: 'Assistant' });
    fireEvent.click(within(assistant).getByRole('button', { name: 'Fork from here' }));
    fireEvent.click(within(assistant).getByRole('button', { name: 'Copy message' }));
    const user = screen.getByRole('article', { name: 'You' });
    fireEvent.click(within(user).getByRole('button', { name: 'Copy message' }));

    expect(host.postedOf('conversation.fork')).toEqual([
      { type: 'conversation.fork', conversationId: convId('c1'), messageId: msgId('a1') },
    ]);
    expect(host.postedOf('clipboard.copy')).toEqual([
      { type: 'clipboard.copy', text: 'Part one\n\nPart two' },
      { type: 'clipboard.copy', text: 'first line\nsecond line' },
    ]);
  });

  describe('scrolling', () => {
    function setGeometry(
      el: HTMLElement,
      geometry: { scrollHeight: number; clientHeight: number },
    ) {
      Object.defineProperty(el, 'scrollHeight', {
        configurable: true,
        value: geometry.scrollHeight,
      });
      Object.defineProperty(el, 'clientHeight', {
        configurable: true,
        value: geometry.clientHeight,
      });
    }

    it('follows new content while at the bottom', () => {
      const { host } = renderWithHost(<MessageList />, stateWith([{ kind: 'text', text: 'a' }]));
      const log = screen.getByRole('log');
      setGeometry(log, { scrollHeight: 1000, clientHeight: 400 });
      log.scrollTop = 600;
      fireEvent.scroll(log);
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

      setGeometry(log, { scrollHeight: 1200, clientHeight: 400 });
      host.emit({
        type: 'patch',
        seq: 1,
        ops: [{ op: 'appendText', path: ['active', 'messages', 1, 'parts', 0, 'text'], text: 'b' }],
      });
      expect(log.scrollTop).toBe(1200);
    });

    it('does not pull the user down once they scrolled up, and offers Jump to latest', () => {
      const { host } = renderWithHost(<MessageList />, stateWith([{ kind: 'text', text: 'a' }]));
      const log = screen.getByRole('log');
      setGeometry(log, { scrollHeight: 2000, clientHeight: 400 });
      log.scrollTop = 100;
      fireEvent.scroll(log);

      host.emit({
        type: 'patch',
        seq: 1,
        ops: [{ op: 'appendText', path: ['active', 'messages', 1, 'parts', 0, 'text'], text: 'b' }],
      });
      expect(log.scrollTop).toBe(100);
      const jump = screen.getByRole('button', { name: /Jump to latest/ });

      fireEvent.click(jump);
      expect(log.scrollTop).toBe(2000);
      expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
    });

    describe('when the log is resized', () => {
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
      afterEach(() => {
        vi.unstubAllGlobals();
      });
      const resize = (log: HTMLElement) => {
        act(() => {
          for (const o of observers) if (o.target === log && !o.disconnected) o.callback();
        });
      };

      it('stays at the bottom when the changes card appears, grows or collapses', () => {
        renderWithHost(<MessageList />, stateWith([{ kind: 'text', text: 'a' }]));
        const log = screen.getByRole('log');
        setGeometry(log, { scrollHeight: 1000, clientHeight: 400 });
        log.scrollTop = 600;
        fireEvent.scroll(log);
        // The card appears: the log gets shorter, the content keeps its height.
        setGeometry(log, { scrollHeight: 1000, clientHeight: 200 });
        resize(log);
        expect(log.scrollTop).toBe(1000);
        // The card grows.
        setGeometry(log, { scrollHeight: 1000, clientHeight: 120 });
        log.scrollTop = 880;
        resize(log);
        expect(log.scrollTop).toBe(1000);
        // The card collapses: the log gets taller than before.
        setGeometry(log, { scrollHeight: 1000, clientHeight: 500 });
        log.scrollTop = 400;
        resize(log);
        expect(log.scrollTop).toBe(1000);
      });

      it('does not move a log the user scrolled up', () => {
        renderWithHost(<MessageList />, stateWith([{ kind: 'text', text: 'a' }]));
        const log = screen.getByRole('log');
        setGeometry(log, { scrollHeight: 2000, clientHeight: 400 });
        log.scrollTop = 100;
        fireEvent.scroll(log);
        setGeometry(log, { scrollHeight: 2000, clientHeight: 200 });
        resize(log);
        expect(log.scrollTop).toBe(100);
        expect(screen.getByRole('button', { name: /Jump to latest/ })).toBeTruthy();
      });

      it('stops observing when the log goes away', () => {
        const { unmount } = renderWithHost(
          <MessageList />,
          stateWith([{ kind: 'text', text: 'a' }]),
        );
        expect(observers.some((o) => o.target !== null && !o.disconnected)).toBe(true);
        unmount();
        expect(observers.every((o) => o.disconnected)).toBe(true);
      });
    });

    it('scrolls to a message the user just sent even when they were scrolled up', () => {
      const { host } = renderWithHost(<MessageList />, stateWith([{ kind: 'text', text: 'a' }]));
      const log = screen.getByRole('log');
      setGeometry(log, { scrollHeight: 2000, clientHeight: 400 });
      log.scrollTop = 100;
      fireEvent.scroll(log);
      act(() => {
        host.emit({
          type: 'patch',
          seq: 1,
          ops: [
            {
              op: 'push',
              path: ['active', 'messages'],
              value: userMessage('u2', 'another'),
            },
          ],
        });
      });
      expect(log.scrollTop).toBe(2000);
    });
  });
});

describe('ToolCard', () => {
  const toggle = () => screen.getByRole('button', { name: 'run tests' });
  const headerOf = (button: HTMLElement) => button.closest('.tool-card-header') as HTMLElement;

  it('shows title, summary, status and approval source, and expands to input and result', () => {
    renderWithHost(<MessageList />, stateWith([{ kind: 'tool', call: tool() }]));
    const header = toggle();
    expect(headerOf(header).textContent).toContain('npm test');
    expect(headerOf(header).textContent).toContain('Done');
    expect(headerOf(header).textContent).toContain('Approved by you');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('all green')).toBeNull();

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('all green')).toBeTruthy();
    expect(document.body.textContent).toContain('"command": "npm test"');

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('all green')).toBeNull();
  });

  it.each([
    ['running', 'Running'],
    ['awaiting-approval', 'Waiting for approval'],
    ['done', 'Done'],
    ['error', 'Failed'],
    ['denied', 'Denied'],
    ['not-run', 'Not run'],
  ] as const)('labels the %s status', (status, label) => {
    renderWithHost(
      <MessageList />,
      stateWith([{ kind: 'tool', call: tool({ status, approval: undefined }) }]),
    );
    expect(headerOf(toggle()).textContent).toContain(label);
    expect(headerOf(toggle()).textContent).not.toContain('Approved');
  });

  it.each([
    ['user', 'Approved by you'],
    ['policy', 'Allowed by AgentCanopy'],
    ['provider', 'Allowed by Claude Code'],
    ['unverified', 'Not verified by AgentCanopy'],
  ] as const)('labels the %s approval source', (approval, label) => {
    renderWithHost(<MessageList />, stateWith([{ kind: 'tool', call: tool({ approval }) }]));
    expect(headerOf(toggle()).textContent).toContain(label);
  });

  it('notes truncation and renders hostile result text as text', () => {
    renderWithHost(
      <MessageList />,
      stateWith([
        {
          kind: 'tool',
          call: tool({
            inputTruncated: true,
            resultTruncated: true,
            resultPreview: '<img src=x onerror=alert(1)>',
          }),
        },
      ]),
    );
    fireEvent.click(toggle());
    expect(screen.getByText('Input truncated')).toBeTruthy();
    expect(screen.getByText('Output truncated')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('remembers which cards are open in the local UI state', () => {
    const { services } = renderWithHost(
      <MessageList />,
      stateWith([{ kind: 'tool', call: tool() }]),
    );
    fireEvent.click(toggle());
    expect(services.ui.getSnapshot().expanded).toEqual({ toolu_1: true });
    services.ui.flush();
    expect(JSON.stringify((services.host as { saved?: unknown }).saved)).toContain('toolu_1');
  });
});

describe('summarizeToolInput', () => {
  it('prefers well-known keys, collapses whitespace and clips', () => {
    expect(summarizeToolInput({ file_path: '/a/b.ts', other: 1 })).toBe('/a/b.ts');
    expect(summarizeToolInput({ command: 'ls\n  -la' })).toBe('ls -la');
    expect(summarizeToolInput({ n: 1, s: 'first string' })).toBe('first string');
    expect(summarizeToolInput({ n: 1 })).toBe('{"n":1}');
    expect(summarizeToolInput('x'.repeat(500)).length).toBeLessThanOrEqual(120);
    expect(summarizeToolInput(undefined)).toBe('');
    expect(summarizeToolInput({})).toBe('');
  });
});
