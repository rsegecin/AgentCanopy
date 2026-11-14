// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mode, QueuedMessage as Queued, TurnStatus, ViewState } from '../../../shared';
import {
  convId,
  makeActive,
  makeConfigChange,
  makeState,
  makeTurn,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { App } from '../../app/App';
import { Composer } from './Composer';
import { QueuedMessage } from './QueuedMessage';

const queued = (over: Partial<Queued> = {}): Queued => ({
  text: 'Also add a test for the burst limit.',
  mode: 'agent',
  model: 'default',
  attachments: [],
  queuedAt: 1_700_000_000_000,
  ...over,
});

const state = (
  over: {
    status?: TurnStatus;
    queued?: Queued | null;
    config?: boolean;
    busy?: boolean;
  } = {},
): ViewState =>
  makeState({
    active: makeActive('c1', {
      meta: { mode: 'agent' },
      turns: [makeTurn({ status: over.status ?? 'running' })],
      queued: over.queued === undefined ? queued() : over.queued,
    }),
    review: {
      entries: [],
      configChanges: over.config === true ? [makeConfigChange('k1')] : [],
      busy: over.busy === true,
    },
  });

const region = () => screen.getByRole('region', { name: 'Queued message' });
const status = () => within(region()).getByRole('status');
const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QueuedMessage content', () => {
  it('renders nothing when no message is queued, or no conversation is open', () => {
    const first = renderWithHost(<QueuedMessage />, state({ queued: null }));
    expect(screen.queryByRole('region', { name: 'Queued message' })).toBeNull();
    first.unmount();
    renderWithHost(<QueuedMessage />, makeState());
    expect(screen.queryByRole('region', { name: 'Queued message' })).toBeNull();
  });

  it.each([
    ['agent', 'Agent'],
    ['plan', 'Plan'],
  ] as const satisfies readonly (readonly [Mode, string])[])(
    'shows the label, the %s mode and the whole text',
    (mode, label) => {
      renderWithHost(<QueuedMessage />, state({ queued: queued({ mode }) }));
      expect(within(region()).getByText('Queued')).toBeTruthy();
      expect(within(region()).getByText(label)).toBeTruthy();
      expect(within(region()).getByText('Also add a test for the burst limit.')).toBeTruthy();
    },
  );

  it('keeps a long text in the DOM in full', () => {
    const long = 'word '.repeat(400).trim();
    renderWithHost(<QueuedMessage />, state({ queued: queued({ text: long }) }));
    expect(within(region()).getByText(long)).toBeTruthy();
  });

  it('shows the number of attachments only when there are some', () => {
    const file = { kind: 'file' as const, path: 'src/a.ts' };
    const { init } = renderWithHost(<QueuedMessage />, state());
    expect(within(region()).queryByText(/attachment/)).toBeNull();
    init(state({ queued: queued({ attachments: [file] }) }), 1);
    expect(within(region()).getByText('1 attachment')).toBeTruthy();
    init(state({ queued: queued({ attachments: [file, { ...file, path: 'src/b.ts' }] }) }), 2);
    expect(within(region()).getByText('2 attachments')).toBeTruthy();
  });

  it('makes the text box reachable by the keyboard only when it scrolls', () => {
    const { init } = renderWithHost(<QueuedMessage />, state());
    expect(within(region()).queryByRole('group', { name: 'Queued message text' })).toBeNull();
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(200);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(60);
    init(state({ queued: queued({ text: 'a much longer text\n\n\n\nthan before' }) }), 1);
    const box = within(region()).getByRole('group', { name: 'Queued message text' });
    expect(box.getAttribute('tabindex')).toBe('0');
  });
});

describe('QueuedMessage status line', () => {
  it('is a status region', () => {
    renderWithHost(<QueuedMessage />, state());
    expect(status().getAttribute('role')).toBe('status');
  });

  it.each([
    ['running', 'Sent when the agent finishes.'],
    ['preparing', 'Sent when the agent finishes.'],
    ['interrupted', 'Not sent: the turn was stopped.'],
    ['error', 'Not sent: the turn ended with an error.'],
    ['completed', 'Not sent yet.'],
  ] as const)('says, for a %s turn: %s', (turnStatus, text) => {
    renderWithHost(<QueuedMessage />, state({ status: turnStatus }));
    expect(status().textContent).toBe(text);
  });

  it('says it waits for the configuration changes when none runs and the message is for Agent', () => {
    renderWithHost(<QueuedMessage />, state({ status: 'interrupted', config: true }));
    expect(status().textContent).toBe('Waiting for your decision on the configuration changes.');
  });

  it('says the send also waits for the decision when a turn runs and configuration changes are pending', () => {
    renderWithHost(<QueuedMessage />, state({ status: 'running', config: true }));
    expect(status().textContent).toBe(
      'Sent when the agent finishes, once you decide on the configuration changes.',
    );
  });

  it('says only that it is sent when the turn finishes for a Plan message, with changes pending', () => {
    renderWithHost(
      <QueuedMessage />,
      state({ status: 'running', config: true, queued: queued({ mode: 'plan' }) }),
    );
    expect(status().textContent).toBe('Sent when the agent finishes.');
  });

  it('says another agent turn runs in this folder when none runs here and the message is for Agent', () => {
    renderWithHost(<QueuedMessage />, state({ status: 'interrupted', busy: true }));
    expect(status().textContent).toBe('Waiting: another agent turn is running in this folder.');
  });

  it('puts the configuration decision before the busy folder', () => {
    renderWithHost(<QueuedMessage />, state({ status: 'interrupted', busy: true, config: true }));
    expect(status().textContent).toBe('Waiting for your decision on the configuration changes.');
  });

  it('does not mention the busy folder for a Plan message or while a turn runs here', () => {
    const first = renderWithHost(
      <QueuedMessage />,
      state({ status: 'interrupted', busy: true, queued: queued({ mode: 'plan' }) }),
    );
    expect(status().textContent).toBe('Not sent: the turn was stopped.');
    first.unmount();
    renderWithHost(<QueuedMessage />, state({ status: 'running', busy: true }));
    expect(status().textContent).toBe('Sent when the agent finishes.');
  });

  it('does not wait for the configuration changes when the message is for Plan', () => {
    renderWithHost(
      <QueuedMessage />,
      state({ status: 'interrupted', config: true, queued: queued({ mode: 'plan' }) }),
    );
    expect(status().textContent).toBe('Not sent: the turn was stopped.');
  });

  it('follows the state when the turn ends', () => {
    const { init } = renderWithHost(<QueuedMessage />, state());
    init(state({ status: 'interrupted' }), 1);
    expect(status().textContent).toBe('Not sent: the turn was stopped.');
  });
});

describe('QueuedMessage buttons', () => {
  it('names what every button acts on', () => {
    renderWithHost(<QueuedMessage />, state());
    expect(within(region()).getByRole('button', { name: 'Edit queued message' })).toBeTruthy();
    expect(within(region()).getByRole('button', { name: 'Remove queued message' })).toBeTruthy();
    expect(within(region()).getByRole('button', { name: 'Send now, queued message' })).toBeTruthy();
  });

  it('shows Send now while a turn runs and Send when none runs, both posting queue.sendNow', () => {
    const first = renderWithHost(<QueuedMessage />, state());
    const now = within(region()).getByRole('button', { name: /^Send now/ });
    expect(within(region()).queryByRole('button', { name: /^Send queued/ })).toBeNull();
    fireEvent.click(now);
    expect(first.host.postedOf('queue.sendNow')).toEqual([
      { type: 'queue.sendNow', conversationId: convId('c1') },
    ]);
    first.unmount();

    const second = renderWithHost(<QueuedMessage />, state({ status: 'interrupted' }));
    expect(within(region()).queryByRole('button', { name: /^Send now/ })).toBeNull();
    fireEvent.click(within(region()).getByRole('button', { name: 'Send queued message' }));
    expect(second.host.postedOf('queue.sendNow')).toEqual([
      { type: 'queue.sendNow', conversationId: convId('c1') },
    ]);
  });

  it('Remove posts queue.remove', () => {
    const { host } = renderWithHost(<QueuedMessage />, state());
    fireEvent.click(within(region()).getByRole('button', { name: 'Remove queued message' }));
    expect(host.postedOf('queue.remove')).toEqual([
      { type: 'queue.remove', conversationId: convId('c1') },
    ]);
    expect(host.postedOf('queue.edit')).toHaveLength(0);
  });

  it.each(['running', 'interrupted'] as const)(
    'disables Send in Agent mode while configuration changes are pending (%s), described by the status line',
    (turnStatus) => {
      const { host } = renderWithHost(
        <QueuedMessage />,
        state({ status: turnStatus, config: true }),
      );
      const send = within(region()).getByRole<HTMLButtonElement>('button', { name: /^Send/ });
      expect(send.disabled).toBe(true);
      expect(send.getAttribute('aria-describedby')).toBe(status().id);
      fireEvent.click(send);
      expect(host.postedOf('queue.sendNow')).toHaveLength(0);
    },
  );

  it('disables Send for an Agent message when another agent turn runs in this folder, described by the status line', () => {
    const { host } = renderWithHost(
      <QueuedMessage />,
      state({ status: 'interrupted', busy: true }),
    );
    const send = within(region()).getByRole<HTMLButtonElement>('button', { name: /^Send/ });
    expect(send.disabled).toBe(true);
    expect(send.getAttribute('aria-describedby')).toBe(status().id);
    fireEvent.click(send);
    expect(host.postedOf('queue.sendNow')).toHaveLength(0);
  });

  it('keeps Send enabled for a Plan message when another agent turn runs in this folder', () => {
    renderWithHost(
      <QueuedMessage />,
      state({ status: 'interrupted', busy: true, queued: queued({ mode: 'plan' }) }),
    );
    const send = within(region()).getByRole<HTMLButtonElement>('button', { name: /^Send/ });
    expect(send.disabled).toBe(false);
  });

  it('keeps Send enabled with configuration changes pending when the message is for Plan', () => {
    renderWithHost(
      <QueuedMessage />,
      state({ status: 'interrupted', config: true, queued: queued({ mode: 'plan' }) }),
    );
    const send = within(region()).getByRole<HTMLButtonElement>('button', { name: /^Send/ });
    expect(send.disabled).toBe(false);
    expect(send.getAttribute('aria-describedby')).toBeNull();
  });
});

describe('QueuedMessage Edit', () => {
  const both = (over: Parameters<typeof state>[0] = {}) =>
    renderWithHost(
      <>
        <QueuedMessage />
        <Composer />
      </>,
      state(over),
    );
  const edit = () => within(region()).getByRole('button', { name: 'Edit queued message' });

  it('only posts queue.edit: the draft is not written and the focus is not moved', () => {
    const { host } = both();
    edit().focus();
    fireEvent.click(edit());
    expect(host.postedOf('queue.edit')).toEqual([
      { type: 'queue.edit', conversationId: convId('c1') },
    ]);
    expect(host.posted.filter((m) => m.type !== 'ready')).toHaveLength(1);
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(edit());
  });

  it('leaves a typed draft alone', () => {
    both();
    fireEvent.change(box(), { target: { value: 'my own draft' } });
    fireEvent.click(edit());
    expect(box().value).toBe('my own draft');
  });

  it('shows the text the host sends back, in front of the draft (the App writes it)', () => {
    const { host } = renderWithHost(<App />, state());
    fireEvent.change(box(), { target: { value: 'my own draft' } });
    fireEvent.click(edit());
    host.emit({
      type: 'event',
      event: { kind: 'prefill-composer', text: 'Also add a test for the burst limit.' },
    });
    expect(box().value).toBe('Also add a test for the burst limit.\n\nmy own draft');
  });
});

describe('QueuedMessage focus', () => {
  it('moves focus to the composer textarea when the chip goes away while it has focus', () => {
    const { init } = renderWithHost(
      <>
        <QueuedMessage />
        <Composer />
      </>,
      state(),
    );
    within(region()).getByRole('button', { name: 'Remove queued message' }).focus();
    init(state({ queued: null }), 1);
    expect(screen.queryByRole('region', { name: 'Queued message' })).toBeNull();
    expect(document.activeElement).toBe(box());
  });

  it('does not take focus from the composer when the chip goes away', () => {
    const { init } = renderWithHost(
      <>
        <QueuedMessage />
        <Composer />
      </>,
      state(),
    );
    box().focus();
    init(state({ queued: null }), 1);
    expect(document.activeElement).toBe(box());
  });
});
