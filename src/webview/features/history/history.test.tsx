// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewState } from '../../../shared';
import { convId, makeActive, makeState, makeSummary, msgId } from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { HistoryList, highlightTerms } from './HistoryList';
import { groupByDay } from './grouping';

const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime();
const at = (daysAgo: number, hour = 9) => new Date(2026, 10, 11 - daysAgo, hour, 0, 0).getTime();

function state(extra: Partial<ViewState> = {}) {
  return makeState({
    conversations: [
      makeSummary('c1', {
        title: 'Fix the parser',
        preview: 'It crashes on empty input',
        updatedAt: at(0),
      }),
      makeSummary('c2', { title: 'Add search', updatedAt: at(0, 8), mode: 'agent', running: true }),
      makeSummary('c3', { title: 'Old idea', updatedAt: at(1), mode: 'plan', pendingPrompts: 2 }),
      makeSummary('c4', { title: 'Ancient', updatedAt: at(9) }),
    ],
    ...extra,
  });
}

function renderList(s: ViewState = state(), onOpened = vi.fn()) {
  return { onOpened, ...renderWithHost(<HistoryList onOpened={onOpened} now={NOW} />, s) };
}

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('groupByDay', () => {
  it('groups newest first into Today, Yesterday and dated groups', () => {
    const groups = groupByDay(state().conversations, NOW);
    expect(groups.map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      expect.stringMatching(/2026/),
    ]);
    expect(groups[0]?.conversations.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(groups[2]?.conversations.map((c) => c.id)).toEqual(['c4']);
  });

  it('treats just after midnight as Today and just before as Yesterday', () => {
    const midnight = new Date(2026, 10, 11, 0, 0, 0).getTime();
    const groups = groupByDay(
      [makeSummary('a', { updatedAt: midnight }), makeSummary('b', { updatedAt: midnight - 1 })],
      NOW,
    );
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday']);
  });
});

describe('HistoryList', () => {
  it('shows the groups with title, preview, mode, running indicator and pending badge', () => {
    renderList();
    expect(screen.getByRole('heading', { name: 'Today' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Yesterday' })).toBeTruthy();
    const today = screen.getByRole('region', { name: 'Today' });
    expect(within(today).getByText('Fix the parser')).toBeTruthy();
    expect(within(today).getByText('It crashes on empty input')).toBeTruthy();
    expect(within(today).getByText('Running')).toBeTruthy();
    expect(within(today).getByText('Agent')).toBeTruthy();
    const yesterday = screen.getByRole('region', { name: 'Yesterday' });
    expect(within(yesterday).getByText('Plan')).toBeTruthy();
    expect(within(yesterday).getByText('2 waiting for your answer')).toBeTruthy();
  });

  it('shows an empty message without conversations', () => {
    renderList(state({ conversations: [] }));
    expect(screen.getByText(/No conversations yet/)).toBeTruthy();
  });

  it('marks the open conversation', () => {
    renderList(state({ active: makeActive('c3') }));
    const open = screen.getByRole('button', { name: /^Old idea/ });
    expect(open.getAttribute('aria-current')).toBe('true');
  });

  it('shows a branch marker with the parent title when it is in the list', () => {
    renderList(
      state({
        conversations: [
          makeSummary('p', { title: 'Parent talk', updatedAt: at(0) }),
          makeSummary('b', {
            title: 'Branch talk',
            updatedAt: at(0, 8),
            fork: { parentId: convId('p'), atMessageId: msgId('m1'), exactness: 'exact', lost: [] },
          }),
          makeSummary('o', {
            title: 'Orphan branch',
            updatedAt: at(0, 7),
            fork: {
              parentId: convId('gone'),
              atMessageId: msgId('m1'),
              exactness: 'exact',
              lost: [],
            },
          }),
        ],
      }),
    );
    expect(screen.getByText('Branch of Parent talk')).toBeTruthy();
    expect(screen.getByText('Branch')).toBeTruthy();
  });

  it('opens a conversation and tells the app', () => {
    const { host, onOpened } = renderList();
    fireEvent.click(screen.getByRole('button', { name: /^Fix the parser/ }));
    expect(host.postedOf('conversation.open')).toEqual([
      { type: 'conversation.open', conversationId: convId('c1') },
    ]);
    expect(onOpened).toHaveBeenCalledOnce();
  });

  describe('rename', () => {
    it('confirms with Enter', () => {
      const { host } = renderList();
      fireEvent.click(screen.getByRole('button', { name: 'Rename Fix the parser' }));
      const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Conversation title' });
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('Fix the parser');
      fireEvent.change(input, { target: { value: '  Fix the lexer ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(host.postedOf('conversation.rename')).toEqual([
        { type: 'conversation.rename', conversationId: convId('c1'), title: 'Fix the lexer' },
      ]);
      expect(screen.queryByRole('textbox', { name: 'Conversation title' })).toBeNull();
    });

    it('cancels with Escape and sends nothing', () => {
      const { host } = renderList();
      fireEvent.click(screen.getByRole('button', { name: 'Rename Fix the parser' }));
      const input = screen.getByRole('textbox', { name: 'Conversation title' });
      fireEvent.change(input, { target: { value: 'Something else' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(host.postedOf('conversation.rename')).toHaveLength(0);
      expect(screen.getByText('Fix the parser')).toBeTruthy();
    });

    it('does not post an empty or unchanged title', () => {
      const { host } = renderList();
      fireEvent.click(screen.getByRole('button', { name: 'Rename Fix the parser' }));
      const input = screen.getByRole('textbox', { name: 'Conversation title' });
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.click(screen.getByRole('button', { name: 'Rename Fix the parser' }));
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Conversation title' }), {
        key: 'Enter',
      });
      expect(host.postedOf('conversation.rename')).toHaveLength(0);
    });

    it('can be confirmed or cancelled with the buttons', () => {
      const { host } = renderList();
      fireEvent.click(screen.getByRole('button', { name: 'Rename Fix the parser' }));
      fireEvent.change(screen.getByRole('textbox', { name: 'Conversation title' }), {
        target: { value: 'Renamed' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save title' }));
      expect(host.postedOf('conversation.rename')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Rename Fix the parser' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));
      expect(host.postedOf('conversation.rename')).toHaveLength(1);
    });
  });

  describe('delete', () => {
    it('needs a second step inside the row and focuses the safe choice', () => {
      const { host } = renderList();
      fireEvent.click(screen.getByRole('button', { name: 'Delete Fix the parser' }));
      expect(host.postedOf('conversation.delete')).toHaveLength(0);
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('Fix the parser');
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
      expect(host.postedOf('conversation.delete')).toEqual([
        { type: 'conversation.delete', conversationId: convId('c1') },
      ]);
    });

    it('cancels with the button or with Escape', () => {
      const { host } = renderList();
      fireEvent.click(screen.getByRole('button', { name: 'Delete Fix the parser' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Delete Fix the parser' }));
      fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' });
      expect(screen.queryByRole('alert')).toBeNull();
      expect(host.postedOf('conversation.delete')).toHaveLength(0);
    });
  });

  describe('search', () => {
    const searchBox = () => screen.getByRole('searchbox', { name: 'Search conversations' });

    it('posts conversation.search once, 250 ms after the last keystroke', () => {
      vi.useFakeTimers();
      const { host } = renderList();
      fireEvent.change(searchBox(), { target: { value: 'pa' } });
      advance(200);
      fireEvent.change(searchBox(), { target: { value: 'pars' } });
      advance(200);
      expect(host.postedOf('conversation.search')).toHaveLength(0);
      advance(60);
      expect(host.postedOf('conversation.search')).toEqual([
        { type: 'conversation.search', query: 'pars' },
      ]);
    });

    it('clears the search on the host when the box is emptied', () => {
      vi.useFakeTimers();
      const { host } = renderList();
      fireEvent.change(searchBox(), { target: { value: 'x' } });
      advance(250);
      fireEvent.change(searchBox(), { target: { value: '' } });
      advance(250);
      expect(host.postedOf('conversation.search').map((m) => m.query)).toEqual(['x', '']);
    });

    it('shows results with highlighted snippets instead of the day groups', () => {
      vi.useFakeTimers();
      const { host, init } = renderList();
      fireEvent.change(searchBox(), { target: { value: 'parser' } });
      advance(250);
      expect(host.postedOf('conversation.search')).toHaveLength(1);
      expect(screen.getByRole('status').textContent).toBe('Searching…');

      init(
        state({
          search: {
            query: 'parser',
            results: [
              {
                conversationId: convId('c1'),
                title: 'Fix the parser',
                snippet: 'the Parser fails; parser tests',
              },
            ],
          },
        }),
        1,
      );
      expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull();
      const results = screen.getByRole('region', { name: 'Search results' });
      const marks = Array.from(results.querySelectorAll('mark')).map((m) => m.textContent);
      expect(marks).toEqual(['Parser', 'parser']);
      fireEvent.click(within(results).getByRole('button', { name: /Fix the parser/ }));
      expect(host.postedOf('conversation.open')).toEqual([
        { type: 'conversation.open', conversationId: convId('c1') },
      ]);
    });

    it('says when nothing matches', () => {
      vi.useFakeTimers();
      renderList(state({ search: { query: 'zzz', results: [] } }));
      expect((searchBox() as HTMLInputElement).value).toBe('zzz');
      expect(screen.getByText(/No conversations match “zzz”/)).toBeTruthy();
    });
  });
});

describe('highlightTerms', () => {
  it('marks every term case-insensitively and treats the query as text, not a pattern', () => {
    const { container } = render(<p>{highlightTerms('a.b and A.B and axb', 'a.b')}</p>);
    expect(Array.from(container.querySelectorAll('mark')).map((m) => m.textContent)).toEqual([
      'a.b',
      'A.B',
    ]);
    expect(container.textContent).toBe('a.b and A.B and axb');
  });

  it('never turns snippet text into markup', () => {
    const { container } = render(<p>{highlightTerms('<b>bold</b> text', 'bold')}</p>);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toBe('<b>bold</b> text');
  });

  it('returns the text unchanged for an empty query', () => {
    expect(highlightTerms('plain', '  ')).toEqual(['plain']);
  });
});
