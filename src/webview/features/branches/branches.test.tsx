// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ForkInfo } from '../../../shared';
import {
  assistantMessage,
  convId,
  makeActive,
  makeState,
  makeSummary,
  msgId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { HistoryList } from '../history/HistoryList';
import { MessageList } from '../chat/MessageList';
import { forkStatusText } from './branch-model';

const fork = (over: Partial<ForkInfo> = {}): ForkInfo => ({
  parentId: convId('p'),
  atMessageId: msgId('m1'),
  exactness: 'exact',
  lost: [],
  ...over,
});

function branchState(forkInfo: ForkInfo | undefined, parentInList = true) {
  return makeState({
    conversations: [
      ...(parentInList ? [makeSummary('p', { title: 'Parent talk' })] : []),
      makeSummary('b', { title: 'Branch talk', ...(forkInfo ? { fork: forkInfo } : {}) }),
    ],
    active: makeActive('b', {
      meta: { title: 'Branch talk', ...(forkInfo ? { fork: forkInfo } : {}) },
      messages: [
        userMessage('u1', 'hi'),
        assistantMessage('a1', [{ kind: 'text', text: 'hello' }]),
      ],
    }),
  });
}

const header = () => screen.getByRole('group', { name: 'Branch information' });

describe('branch header', () => {
  it('is absent for a conversation that is not a branch', () => {
    renderWithHost(<MessageList />, branchState(undefined));
    expect(screen.queryByRole('group', { name: 'Branch information' })).toBeNull();
  });

  it('names the parent as a button that opens it', () => {
    const { host } = renderWithHost(<MessageList />, branchState(fork()));
    expect(header().textContent).toContain('Branch of Parent talk');
    fireEvent.click(
      within(header()).getByRole('button', { name: 'Open the parent conversation: Parent talk' }),
    );
    expect(host.postedOf('conversation.open')).toEqual([
      { type: 'conversation.open', conversationId: convId('p') },
    ]);
  });

  it('shows plain text when the parent was deleted', () => {
    renderWithHost(<MessageList />, branchState(fork(), false));
    expect(header().textContent).toContain('Branch of a conversation that was deleted');
    expect(within(header()).queryByRole('button')).toBeNull();
  });

  it('says a pending branch decides its context at the first message', () => {
    renderWithHost(<MessageList />, branchState(fork({ exactness: 'pending' })));
    expect(
      within(header()).getByText('Its context is decided when you send the first message.'),
    ).toBeTruthy();
  });

  it('says an exact branch is an exact copy', () => {
    renderWithHost(<MessageList />, branchState(fork({ exactness: 'exact' })));
    expect(
      within(header()).getByText('Exact copy of the conversation up to that point.'),
    ).toBeTruthy();
  });

  it('lists what a reconstructed branch lost, with an icon and text', () => {
    renderWithHost(
      <MessageList />,
      branchState(
        fork({
          exactness: 'reconstructed',
          lost: ['tool results', 'thinking blocks', 'file changes'],
        }),
      ),
    );
    const status = within(header()).getByText(
      'Context rebuilt from the visible messages. Not carried over: tool results, thinking blocks, file changes.',
    );
    expect(status.closest('p')?.querySelector('.codicon-warning')).not.toBeNull();
    expect(within(header()).queryByText(/Exact copy/)).toBeNull();
  });

  it('words a reconstructed branch with nothing listed sensibly', () => {
    expect(forkStatusText(fork({ exactness: 'reconstructed', lost: [] }))).toBe(
      'Context rebuilt from the visible messages.',
    );
  });
});

describe('branch markers on the parent', () => {
  const parentState = (branches: { id: string; at: string; title: string }[]) =>
    makeState({
      conversations: [
        makeSummary('p', { title: 'Parent talk' }),
        ...branches.map((b) =>
          makeSummary(b.id, {
            title: b.title,
            fork: fork({ atMessageId: msgId(b.at) }),
          }),
        ),
        makeSummary('x', { title: 'Unrelated', fork: fork({ parentId: convId('other') }) }),
      ],
      active: makeActive('p', {
        messages: [
          userMessage('m1', 'first'),
          assistantMessage('m2', [{ kind: 'text', text: 'second' }]),
          userMessage('m3', 'third'),
        ],
      }),
    });

  it('shows a marker only on the messages branches were taken at', () => {
    renderWithHost(
      <MessageList />,
      parentState([
        { id: 'b1', at: 'm2', title: 'Branch one' },
        { id: 'b2', at: 'm2', title: 'Branch two' },
        { id: 'b3', at: 'm3', title: 'Branch three' },
      ]),
    );
    const articles = screen.getAllByRole('article');
    expect(within(articles[0] as HTMLElement).queryByRole('button', { name: /branch/ })).toBeNull();
    expect(
      within(articles[1] as HTMLElement).getByRole('button', { name: '2 branches' }),
    ).toBeTruthy();
    expect(
      within(articles[2] as HTMLElement).getByRole('button', { name: '1 branch' }),
    ).toBeTruthy();
    expect(screen.queryByText('Unrelated')).toBeNull();
  });

  it('expands to the branch titles, each opening that branch', () => {
    const { host } = renderWithHost(
      <MessageList />,
      parentState([
        { id: 'b1', at: 'm2', title: 'Branch one' },
        { id: 'b2', at: 'm2', title: 'Branch two' },
      ]),
    );
    const toggle = screen.getByRole('button', { name: '2 branches' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Branch one')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByRole('list', { name: 'Branches from this message' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: 'Open branch Branch two' }));
    expect(host.postedOf('conversation.open')).toEqual([
      { type: 'conversation.open', conversationId: convId('b2') },
    ]);
    fireEvent.click(toggle);
    expect(screen.queryByText('Branch one')).toBeNull();
  });

  it('shows no marker on a conversation without branches', () => {
    renderWithHost(<MessageList />, parentState([]));
    expect(screen.queryByRole('button', { name: /branch/ })).toBeNull();
  });
});

describe('history branch marker', () => {
  it('carries the exactness wording as title and as hidden description', () => {
    renderWithHost(
      <HistoryList onOpened={() => undefined} />,
      makeState({
        conversations: [
          makeSummary('p', { title: 'Parent talk' }),
          makeSummary('b', {
            title: 'Rebuilt',
            fork: fork({ exactness: 'reconstructed', lost: ['tool results'] }),
          }),
          makeSummary('c', { title: 'Waiting', fork: fork({ exactness: 'pending' }) }),
        ],
      }),
    );
    const flags = Array.from(document.querySelectorAll('.history-flag')).filter((f) =>
      f.textContent?.includes('Branch of'),
    );
    expect(flags.map((f) => f.getAttribute('title'))).toEqual(
      expect.arrayContaining([
        'Context rebuilt from the visible messages. Not carried over: tool results.',
        'Its context is decided when you send the first message.',
      ]),
    );
    expect(flags[0]?.querySelector('.visually-hidden')?.textContent).toMatch(/^\. /);
    // The visible words are unchanged.
    expect(screen.getAllByText('Branch of Parent talk')).toHaveLength(2);
  });
});
