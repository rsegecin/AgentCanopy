// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  assistantMessage,
  autoOffered,
  convId,
  makeActive,
  makeAside,
  makeConfigChange,
  makePlanDoc,
  makeProvider,
  makeQuestionPrompt,
  makeState,
  makeTurn,
  msgId,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import type { QueuedMessage, ViewState } from '../../../shared';
import { Composer } from './Composer';

const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const enter = (init: Partial<KeyboardEventInit> = {}) =>
  fireEvent.keyDown(box(), { key: 'Enter', ...init });

describe('Composer sending', () => {
  it('sends the draft on Enter with mode and model, then clears it', () => {
    const { host } = renderWithHost(<Composer />);
    type('  explain this  ');
    enter();
    expect(host.postedOf('turn.send')).toEqual([
      { type: 'turn.send', text: 'explain this', mode: 'ask', model: 'default' },
    ]);
    expect(box().value).toBe('');
  });

  it('includes the conversation id when one is active, and uses its mode and model', () => {
    const { host } = renderWithHost(
      <Composer />,
      makeState({ active: makeActive('c7', { meta: { mode: 'agent', model: 'opus' } }) }),
    );
    type('go');
    enter();
    expect(host.postedOf('turn.send')).toEqual([
      { type: 'turn.send', conversationId: convId('c7'), text: 'go', mode: 'agent', model: 'opus' },
    ]);
  });

  it('sends with the Send button', () => {
    const { host } = renderWithHost(<Composer />);
    type('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(host.postedOf('turn.send')).toHaveLength(1);
  });

  it('does not send on Shift+Enter', () => {
    const { host } = renderWithHost(<Composer />);
    type('line one');
    enter({ shiftKey: true });
    expect(host.postedOf('turn.send')).toHaveLength(0);
    expect(box().value).toBe('line one');
  });

  it('does not send empty or whitespace-only text', () => {
    const { host } = renderWithHost(<Composer />);
    enter();
    type('   \n ');
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(0);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
  });

  it('does not send while an IME composition is in progress', () => {
    const { host } = renderWithHost(<Composer />);
    type('にほん');
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    expect(host.postedOf('turn.send')).toHaveLength(0);
  });

  it('keeps one draft per conversation', () => {
    const state = (id: string | null) => makeState({ active: id === null ? null : makeActive(id) });
    const { init } = renderWithHost(<Composer />, state('c1'));
    type('draft for c1');
    init(state('c2'), 1);
    expect(box().value).toBe('');
    type('draft for c2');
    init(state('c1'), 2);
    expect(box().value).toBe('draft for c1');
    init(state(null), 3);
    expect(box().value).toBe('');
  });

  it('restores the draft after a reload from the saved state', () => {
    const first = renderWithHost(<Composer />, makeState({ active: makeActive('c1') }));
    type('half-written');
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    renderWithHost(<Composer />, makeState({ active: makeActive('c1') }), saved);
    expect(box().value).toBe('half-written');
  });

  it('focuses on host events and leaves the draft to the App', () => {
    const { host } = renderWithHost(<Composer />);
    host.emit({ type: 'event', event: { kind: 'prefill-composer', text: 'from a fork' } });
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());
    (document.activeElement as HTMLElement).blur();
    host.emit({ type: 'event', event: { kind: 'focus-composer' } });
    expect(document.activeElement).toBe(box());
  });
});

describe('Composer while a turn runs', () => {
  const runningIn = (
    mode: 'ask' | 'plan' | 'agent',
    over: Parameters<typeof makeActive>[1] = {},
    extra: Partial<ViewState> = {},
  ) =>
    makeState({
      active: makeActive('c1', {
        meta: { mode },
        turns: [makeTurn({ status: 'running' })],
        messages: [assistantMessage('a1', [])],
        ...over,
      }),
      ...extra,
    });
  const running = () => runningIn('ask');
  const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
  const queuedMessage = (): QueuedMessage => ({
    text: 'first',
    mode: 'agent',
    model: 'default',
    attachments: [],
    queuedAt: 1_700_000_000_000,
  });

  it('shows Stop next to Send, and Stop posts turn.cancel', () => {
    const { host } = renderWithHost(<Composer />, running());
    expect(send()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(host.postedOf('turn.cancel')).toEqual([
      { type: 'turn.cancel', conversationId: convId('c1') },
    ]);
  });

  it('shows Stop while the turn is preparing, and not when it is idle', () => {
    const { init } = renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1', { turns: [makeTurn({ status: 'preparing' })] }),
      }),
    );
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    init(makeState({ active: makeActive('c1', { turns: [makeTurn()] }) }), 1);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(send()).toBeTruthy();
  });

  it.each(['agent', 'plan'] as const)(
    'sends with Send and with Enter in %s mode while running, and clears the draft',
    (mode) => {
      const { host } = renderWithHost(<Composer />, runningIn(mode));
      type('next');
      expect(send().disabled).toBe(false);
      fireEvent.click(send());
      expect(host.postedOf('turn.send')).toEqual([
        { type: 'turn.send', conversationId: convId('c1'), text: 'next', mode, model: 'default' },
      ]);
      expect(box().value).toBe('');
      type('and then');
      enter();
      expect(host.postedOf('turn.send')).toHaveLength(2);
      expect(box().value).toBe('');
    },
  );

  const ASIDE_NOTE = 'Asked as a side question: the agent keeps working and does not see it.';
  const ASIDE_RUNNING = 'A side question is already running. Wait for it or stop it.';
  const ASIDE_OF_ASIDE = 'Wait for the answer or stop it.';
  const asideMeta = {
    parentId: convId('p'),
    anchor: { messageId: msgId('a1'), afterParts: 0 },
  };

  it('sends a question in Ask mode while running, as usual, and says it is a side question', () => {
    const { host } = renderWithHost(<Composer />, running());
    type('what is this?');
    expect(send().disabled).toBe(false);
    const note = screen.getByText(ASIDE_NOTE);
    expect(box().getAttribute('aria-describedby')).toBe(note.id);
    expect(send().getAttribute('aria-describedby')).toBe(note.id);
    fireEvent.click(send());
    expect(host.postedOf('turn.send')).toEqual([
      {
        type: 'turn.send',
        conversationId: convId('c1'),
        text: 'what is this?',
        mode: 'ask',
        model: 'default',
      },
    ]);
    expect(box().value).toBe('');
    type('and this?');
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(2);
  });

  it('shows the side question note only in Ask mode while a turn runs', () => {
    renderWithHost(<Composer />);
    expect(screen.queryByText(ASIDE_NOTE)).toBeNull();
    cleanup();
    renderWithHost(<Composer />, runningIn('agent'));
    expect(screen.queryByText(ASIDE_NOTE)).toBeNull();
    cleanup();
    renderWithHost(
      <Composer />,
      makeState({ active: makeActive('c1', { turns: [makeTurn({ status: 'completed' })] }) }),
    );
    expect(screen.queryByText(ASIDE_NOTE)).toBeNull();
  });

  it.each(['running', 'preparing'] as const)(
    'disables Send in Ask mode while a side question is %s, with the reason, and keeps the text',
    (status) => {
      const { host } = renderWithHost(
        <Composer />,
        runningIn('ask', { asides: [makeAside('b1', { status })] }),
      );
      type('another');
      expect(send().disabled).toBe(true);
      enter();
      fireEvent.click(send());
      expect(host.postedOf('turn.send')).toHaveLength(0);
      expect(box().value).toBe('another');
      const hint = screen.getByText(ASIDE_RUNNING);
      expect(hint.getAttribute('role')).toBe('status');
      expect(box().getAttribute('aria-describedby')).toBe(hint.id);
      expect(send().getAttribute('aria-describedby')).toBe(hint.id);
      expect(screen.queryByText(ASIDE_NOTE)).toBeNull();
    },
  );

  it('allows a new side question once the earlier ones have ended', () => {
    const { host } = renderWithHost(
      <Composer />,
      runningIn('ask', {
        asides: [
          makeAside('b1', { status: 'completed' }),
          makeAside('b2', { status: 'interrupted' }),
          makeAside('b3', { status: 'error' }),
        ],
      }),
    );
    type('another');
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(1);
  });

  it('does not let a running side question block Agent or Plan', () => {
    for (const mode of ['agent', 'plan'] as const) {
      const { host } = renderWithHost(<Composer />, runningIn(mode, { asides: [makeAside('b1')] }));
      type('instruction');
      enter();
      expect(host.postedOf('turn.send')).toHaveLength(1);
      cleanup();
    }
  });

  it('disables Send in Ask mode while the open conversation is itself a side question', () => {
    const { host } = renderWithHost(<Composer />, runningIn('ask', { meta: { aside: asideMeta } }));
    type('follow up');
    expect(send().disabled).toBe(true);
    enter();
    fireEvent.click(send());
    expect(host.postedOf('turn.send')).toHaveLength(0);
    expect(box().value).toBe('follow up');
    const hint = screen.getByText(ASIDE_OF_ASIDE);
    expect(hint.getAttribute('role')).toBe('status');
    expect(box().getAttribute('aria-describedby')).toBe(hint.id);
    expect(screen.queryByText(ASIDE_NOTE)).toBeNull();
  });

  it('sends in a side question conversation once its turn has ended', () => {
    const { host } = renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1', { meta: { aside: asideMeta }, turns: [makeTurn()] }),
      }),
    );
    type('follow up');
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(1);
  });

  it('does not show a side question hint when nothing runs', () => {
    renderWithHost(<Composer />);
    type('next');
    expect(send().disabled).toBe(false);
    expect(screen.queryByText(ASIDE_RUNNING)).toBeNull();
    expect(screen.queryByText(ASIDE_NOTE)).toBeNull();
  });

  it.each(['agent', 'plan'] as const)(
    'disables Send in %s mode while a message is queued, with the reason, and keeps the text on Enter',
    (mode) => {
      const { host } = renderWithHost(<Composer />, runningIn(mode, { queued: queuedMessage() }));
      type('second');
      expect(send().disabled).toBe(true);
      enter();
      fireEvent.click(send());
      expect(host.postedOf('turn.send')).toHaveLength(0);
      expect(box().value).toBe('second');
      const hint = screen.getByText('A message is already queued. Edit or remove it first.');
      expect(hint.getAttribute('role')).toBe('status');
      expect(box().getAttribute('aria-describedby')).toBe(hint.id);
      expect(send().getAttribute('aria-describedby')).toBe(hint.id);
    },
  );

  it.each(['agent', 'plan'] as const)(
    'sends with Send and with Enter in %s mode while a held message exists and no turn runs',
    (mode) => {
      const { host } = renderWithHost(
        <Composer />,
        makeState({
          active: makeActive('c1', {
            meta: { mode },
            turns: [makeTurn({ status: 'interrupted' })],
            queued: queuedMessage(),
          }),
        }),
      );
      type('second');
      expect(send().disabled).toBe(false);
      expect(
        screen.queryByText('A message is already queued. Edit or remove it first.'),
      ).toBeNull();
      fireEvent.click(send());
      expect(host.postedOf('turn.send')).toEqual([
        { type: 'turn.send', conversationId: convId('c1'), text: 'second', mode, model: 'default' },
      ]);
      expect(box().value).toBe('');
      type('third');
      enter();
      expect(host.postedOf('turn.send')).toHaveLength(2);
    },
  );

  it('does not block Ask mode for an idle conversation that has a held message', () => {
    const { host } = renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1', {
          turns: [makeTurn({ status: 'interrupted' })],
          queued: queuedMessage(),
        }),
      }),
    );
    type('question');
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(1);
  });

  describe('which hint is shown when several apply', () => {
    const config = {
      review: { entries: [], configChanges: [makeConfigChange('k1')], busy: false },
    };
    const hints = () =>
      screen
        .queryAllByRole('status')
        .map((el) => el.textContent)
        .filter((text) => text !== '');

    it('puts the provider problem before everything else', () => {
      renderWithHost(
        <Composer />,
        runningIn('agent', { queued: queuedMessage() }, { ...config, trusted: false }),
      );
      expect(hints()).toHaveLength(1);
      expect(hints()[0]).toMatch(/not trusted/);
      expect(box().getAttribute('aria-describedby')).toBe(screen.getByRole('status').id);
    });

    it('puts the configuration changes before an already queued message', () => {
      renderWithHost(<Composer />, runningIn('agent', { queued: queuedMessage() }, config));
      expect(hints()).toEqual([
        'Keep or revert the configuration changes in the changes card below the chat before sending in Agent mode.',
      ]);
    });

    it('does not let a queued message block Ask: the question is sent as a side question', () => {
      const { host } = renderWithHost(<Composer />, runningIn('ask', { queued: queuedMessage() }));
      expect(hints()).not.toContain('A message is already queued. Edit or remove it first.');
      expect(screen.getByText(ASIDE_NOTE)).toBeTruthy();
      type('a question');
      expect(send().disabled).toBe(false);
      enter();
      expect(host.postedOf('turn.send')).toHaveLength(1);
    });

    it('puts a queued message before the side question hint in Plan and Agent, not in Ask', () => {
      renderWithHost(
        <Composer />,
        runningIn('plan', { queued: queuedMessage(), asides: [makeAside('b1')] }),
      );
      expect(hints()).toEqual(['A message is already queued. Edit or remove it first.']);
    });

    it('does not let configuration changes block Plan or Ask, so the next hint shows', () => {
      renderWithHost(<Composer />, runningIn('ask', {}, config));
      type('a question');
      expect(send().disabled).toBe(false);
      expect(screen.getByText(ASIDE_NOTE)).toBeTruthy();
      cleanup();
      renderWithHost(<Composer />, runningIn('ask', { asides: [makeAside('b1')] }, config));
      expect(hints()).toEqual([ASIDE_RUNNING]);
    });

    it('puts the provider problem before the side question hint', () => {
      renderWithHost(
        <Composer />,
        runningIn('ask', { asides: [makeAside('b1')] }, { trusted: false }),
      );
      expect(hints()).toHaveLength(1);
      expect(hints()[0]).toMatch(/not trusted/);
      expect(screen.queryByText(ASIDE_NOTE)).toBeNull();
    });

    it('shows one side question hint when the conversation is a side question and one is running', () => {
      renderWithHost(
        <Composer />,
        runningIn('ask', { meta: { aside: asideMeta }, asides: [makeAside('b1')] }),
      );
      expect(hints()).toEqual([ASIDE_OF_ASIDE]);
    });
  });

  it('applies the configuration block while running too', () => {
    const { host } = renderWithHost(
      <Composer />,
      runningIn(
        'agent',
        {},
        {
          review: { entries: [], configChanges: [makeConfigChange('k1')], busy: false },
        },
      ),
    );
    type('next');
    enter();
    expect(send().disabled).toBe(true);
    expect(host.postedOf('turn.send')).toHaveLength(0);
  });

  it('moves focus to Stop on Escape', () => {
    renderWithHost(<Composer />, running());
    box().focus();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop' }));
  });

  it('does not touch focus on Escape when nothing runs', () => {
    renderWithHost(<Composer />);
    box().focus();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(document.activeElement).toBe(box());
  });

  it('keeps focus in the composer when Stop goes away while it has focus', () => {
    const { init } = renderWithHost(<Composer />, running());
    screen.getByRole('button', { name: 'Stop' }).focus();
    init(makeState({ active: makeActive('c1', { turns: [makeTurn()] }) }), 1);
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(document.activeElement).toBe(box());
  });
});

describe('Composer mode chosen while a turn runs', () => {
  const stateIn = (
    mode: 'ask' | 'plan' | 'agent',
    status: 'running' | 'completed' = 'running',
    id = 'c1',
  ) =>
    makeState({
      active: makeActive(id, {
        meta: { mode },
        turns: [makeTurn({ status, mode })],
        messages: [assistantMessage('a1', [])],
      }),
    });
  const radio = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });
  const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
  const NOTE = 'Asked as a side question: the agent keeps working and does not see it.';

  it('choosing Ask during an Agent turn posts no setMode, shows Ask and the note, and sends in Ask', () => {
    const { host } = renderWithHost(<Composer />, stateIn('agent'));
    fireEvent.click(radio('Ask'));
    expect(host.postedOf('conversation.setMode')).toHaveLength(0);
    expect(radio('Ask').checked).toBe(true);
    expect(radio('Agent').checked).toBe(false);
    expect(screen.getByText(NOTE)).toBeTruthy();
    type('what is this?');
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    expect(host.postedOf('turn.send')).toEqual([
      {
        type: 'turn.send',
        conversationId: convId('c1'),
        text: 'what is this?',
        mode: 'ask',
        model: 'default',
      },
    ]);
    expect(host.postedOf('conversation.setMode')).toHaveLength(0);
    // A side question never changes the conversation's mode: the switch keeps the user's choice.
    expect(radio('Ask').checked).toBe(true);
  });

  it('choosing Plan during an Agent turn and sending posts turn.send in plan mode', () => {
    const { host } = renderWithHost(<Composer />, stateIn('agent'));
    fireEvent.click(radio('Plan'));
    expect(host.postedOf('conversation.setMode')).toHaveLength(0);
    expect(radio('Plan').checked).toBe(true);
    expect(screen.queryByText(NOTE)).toBeNull();
    type('plan this');
    enter();
    expect(host.postedOf('turn.send')).toEqual([
      {
        type: 'turn.send',
        conversationId: convId('c1'),
        text: 'plan this',
        mode: 'plan',
        model: 'default',
      },
    ]);
  });

  it('uses the chosen mode for the hints too: a queued message blocks Plan but not Ask', () => {
    const queued: QueuedMessage = {
      text: 'first',
      mode: 'agent',
      model: 'default',
      attachments: [],
      queuedAt: 1_700_000_000_000,
    };
    const state = stateIn('agent');
    const withQueue = { ...state, active: { ...state.active!, queued } };
    renderWithHost(<Composer />, withQueue);
    fireEvent.click(radio('Plan'));
    type('second');
    expect(send().disabled).toBe(true);
    expect(screen.getByText('A message is already queued. Edit or remove it first.')).toBeTruthy();
    fireEvent.click(radio('Ask'));
    expect(send().disabled).toBe(false);
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it('keeps the chosen mode when the turn ends and posts nothing by itself', () => {
    const { host, init } = renderWithHost(<Composer />, stateIn('agent'));
    fireEvent.click(radio('Ask'));
    init(stateIn('agent', 'completed'), 1);
    expect(radio('Ask').checked).toBe(true);
    expect(screen.queryByText(NOTE)).toBeNull();
    expect(host.posted.filter((m) => m.type !== 'ready')).toHaveLength(0);
  });

  it('posts conversation.setMode and clears the choice when no turn runs', () => {
    const { host, init, services } = renderWithHost(<Composer />, stateIn('agent'));
    fireEvent.click(radio('Ask'));
    init(stateIn('agent', 'completed'), 1);
    expect(services.ui.getSnapshot().sendMode).toEqual({ c1: 'ask' });
    fireEvent.click(radio('Plan'));
    expect(host.postedOf('conversation.setMode')).toEqual([
      { type: 'conversation.setMode', conversationId: convId('c1'), mode: 'plan' },
    ]);
    expect(services.ui.getSnapshot().sendMode).toEqual({});
    // The host owns the state: the radio shows the conversation's mode until the host says otherwise.
    expect(radio('Agent').checked).toBe(true);
  });

  it('forgets the choice once the conversation has that mode', () => {
    const { init, services } = renderWithHost(<Composer />, stateIn('agent'));
    fireEvent.click(radio('Plan'));
    expect(services.ui.getSnapshot().sendMode).toEqual({ c1: 'plan' });
    // The queued Plan message is dispatched: the host sets the mode of the conversation.
    init(stateIn('plan'), 1);
    expect(services.ui.getSnapshot().sendMode).toEqual({});
    expect(radio('Plan').checked).toBe(true);
    // From now on the conversation's mode is what the switch shows.
    init(stateIn('agent', 'completed'), 2);
    expect(radio('Agent').checked).toBe(true);
  });

  it('forgets the choice when the user goes back to the conversation mode', () => {
    const { services } = renderWithHost(<Composer />, stateIn('agent'));
    fireEvent.click(radio('Ask'));
    fireEvent.click(radio('Agent'));
    expect(services.ui.getSnapshot().sendMode).toEqual({});
    expect(radio('Agent').checked).toBe(true);
  });

  it('keeps the choice of one conversation out of another', () => {
    const { init } = renderWithHost(<Composer />, stateIn('agent', 'running', 'c1'));
    fireEvent.click(radio('Ask'));
    init(stateIn('agent', 'running', 'c2'), 1);
    expect(radio('Agent').checked).toBe(true);
    expect(screen.queryByText(NOTE)).toBeNull();
    init(stateIn('agent', 'running', 'c1'), 2);
    expect(radio('Ask').checked).toBe(true);
  });

  it('does not save the choice in the persisted state', () => {
    const { services, host } = renderWithHost(<Composer />, stateIn('agent'));
    fireEvent.click(radio('Ask'));
    services.ui.flush();
    expect(host.saved).not.toHaveProperty('sendMode');
    expect(JSON.stringify(host.saved)).not.toContain('"ask"');
  });

  it('leaves a new conversation alone: its mode is the local one', () => {
    const { host } = renderWithHost(<Composer />);
    fireEvent.click(radio('Plan'));
    expect(host.postedOf('conversation.setMode')).toHaveLength(0);
    expect(radio('Plan').checked).toBe(true);
  });

  describe('the plan lock', () => {
    const REASON = 'The lock can be changed when the turn ends.';
    const lock = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Lock plan' });
    const withPlan = (state: ViewState): ViewState => ({
      ...state,
      active: { ...state.active!, plan: makePlanDoc() },
    });

    it('is offered for the chosen mode only', () => {
      renderWithHost(<Composer />, withPlan(stateIn('agent')));
      expect(screen.queryByRole('button', { name: 'Lock plan' })).toBeNull();
      fireEvent.click(radio('Plan'));
      expect(lock()).toBeTruthy();
    });

    it('is enabled when no turn runs, and posts plan.setLocked', () => {
      const { host } = renderWithHost(<Composer />, withPlan(stateIn('plan', 'completed')));
      expect(lock().disabled).toBe(false);
      expect(lock().getAttribute('aria-describedby')).toBeNull();
      expect(screen.queryByText(REASON)).toBeNull();
      fireEvent.click(lock());
      expect(host.postedOf('plan.setLocked')).toEqual([
        { type: 'plan.setLocked', conversationId: convId('c1'), locked: true },
      ]);
    });

    it.each(['plan', 'agent'] as const)(
      'is disabled with its reason while a turn runs (stored mode %s), and posts nothing',
      (stored) => {
        const { host } = renderWithHost(<Composer />, withPlan(stateIn(stored)));
        if (stored !== 'plan') fireEvent.click(radio('Plan'));
        expect(lock().disabled).toBe(true);
        const reason = screen.getByText(REASON);
        expect(lock().getAttribute('aria-describedby')).toBe(reason.id);
        fireEvent.click(lock());
        expect(host.postedOf('plan.setLocked')).toHaveLength(0);
      },
    );
  });
});

describe('Composer waiting note', () => {
  const WAITING = 'The agent is waiting for your answer above.';

  it('shows the note for a pending prompt of the conversation', () => {
    renderWithHost(
      <Composer />,
      makeState({ active: makeActive('c1', { prompts: [makeQuestionPrompt('q1')] }) }),
    );
    expect(screen.getByText(WAITING)).toBeTruthy();
  });

  it('shows the note for a pending prompt inside a side question', () => {
    renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1', {
          turns: [makeTurn({ status: 'running' })],
          asides: [makeAside('b1', { prompts: [makeQuestionPrompt('q1')] })],
        }),
      }),
    );
    expect(screen.getByText(WAITING)).toBeTruthy();
  });

  it('shows no note once the prompt of a side question is answered', () => {
    renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1', {
          asides: [
            makeAside('b1', {
              status: 'completed',
              prompts: [makeQuestionPrompt('q1', { state: 'answered' })],
            }),
          ],
        }),
      }),
    );
    expect(screen.queryByText(WAITING)).toBeNull();
  });
});

describe('Composer with pending configuration changes', () => {
  const pending = (mode: 'ask' | 'plan' | 'agent') =>
    makeState({
      defaults: { mode, model: 'default' },
      review: {
        entries: [],
        configChanges: [makeConfigChange('k1')],
        busy: false,
      },
    });
  const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
  const hint = () =>
    screen.getByText(
      'Keep or revert the configuration changes in the changes card below the chat before sending in Agent mode.',
    );

  it('disables Send and Enter in Agent mode, keeps the text, and names the changes card', () => {
    const { host } = renderWithHost(<Composer />, pending('agent'));
    type('go on');
    expect(send().disabled).toBe(true);
    enter();
    fireEvent.click(send());
    expect(host.postedOf('turn.send')).toHaveLength(0);
    expect(box().value).toBe('go on');
    expect(hint().textContent).toContain('changes card below the chat');
    expect(hint().getAttribute('role')).toBe('status');
    expect(box().getAttribute('aria-describedby')).toBe(hint().id);
    expect(send().getAttribute('aria-describedby')).toBe(hint().id);
  });

  it('leaves the textarea, the mode switch and the attachments usable', () => {
    const { host } = renderWithHost(<Composer />, pending('agent'));
    expect(box().disabled).toBe(false);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ask' }).disabled).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add a file' }).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add a file' }));
    expect(host.postedOf('context.pick')).toHaveLength(1);
  });

  it.each(['ask', 'plan'] as const)('does not block %s mode', (mode) => {
    const { host } = renderWithHost(<Composer />, pending(mode));
    type('question');
    expect(send().disabled).toBe(false);
    expect(screen.queryByText(/changes card below the chat/)).toBeNull();
    enter();
    expect(host.postedOf('turn.send')).toEqual([
      { type: 'turn.send', text: 'question', mode, model: 'default' },
    ]);
  });

  it('is cleared by switching to Ask, and comes back when switching to Agent', () => {
    const { host } = renderWithHost(<Composer />, pending('agent'));
    type('hello');
    fireEvent.click(screen.getByRole('radio', { name: 'Ask' }));
    expect(send().disabled).toBe(false);
    expect(screen.queryByText(/changes card below the chat/)).toBeNull();
    expect(box().getAttribute('aria-describedby')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
    expect(send().disabled).toBe(true);
    expect(hint()).toBeTruthy();
    expect(host.postedOf('turn.send')).toHaveLength(0);
  });

  it('is cleared when the host reports the changes decided', () => {
    const { host, init } = renderWithHost(<Composer />, pending('agent'));
    type('now');
    init(makeState({ defaults: { mode: 'agent', model: 'default' } }), 1);
    expect(send().disabled).toBe(false);
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(1);
  });

  it('applies to an open conversation in Agent mode', () => {
    const { host } = renderWithHost(<Composer />, {
      ...pending('ask'),
      active: makeActive('c1', { meta: { mode: 'agent' } }),
    });
    type('go');
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(0);
    expect(send().disabled).toBe(true);
  });

  it('does not add the hint over a provider problem', () => {
    renderWithHost(<Composer />, { ...pending('agent'), trusted: false });
    expect(screen.queryByText(/changes card below the chat/)).toBeNull();
    expect(box().getAttribute('aria-describedby')).toBe(screen.getByRole('status').id);
  });
});

describe('Composer disabled states', () => {
  function expectDisabled(explanation: RegExp) {
    expect(box().disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toMatch(explanation);
    expect(box().getAttribute('aria-describedby')).toBe(screen.getByRole('status').id);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add a file' }).disabled).toBe(
      true,
    );
  }

  it('explains an untrusted workspace', () => {
    renderWithHost(<Composer />, makeState({ trusted: false }));
    expectDisabled(/not trusted/);
  });

  it('explains that no folder is open', () => {
    renderWithHost(<Composer />, makeState({ folders: [] }));
    expectDisabled(/Open a folder/);
  });

  it('explains a missing provider status', () => {
    renderWithHost(<Composer />, makeState({ provider: null }));
    expectDisabled(/Checking/);
  });

  it('explains a provider that is not installed, with its problems', () => {
    renderWithHost(
      <Composer />,
      makeState({
        provider: makeProvider({ installed: false, problems: ['Install it from the docs.'] }),
      }),
    );
    expectDisabled(/not installed/);
    expect(screen.getByText('Install it from the docs.')).toBeTruthy();
  });

  it('explains a provider that is too old', () => {
    renderWithHost(
      <Composer />,
      makeState({ provider: makeProvider({ meetsMinimum: false, version: '1.0.0' }) }),
    );
    expectDisabled(/1\.0\.0 is older than the minimum supported version 2\.0\.0/);
  });

  it('shows a Sign in button when signed out, which posts provider.signIn', () => {
    const { host } = renderWithHost(
      <Composer />,
      makeState({ provider: makeProvider({ auth: 'signed-out' }) }),
    );
    expectDisabled(/signed out/);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(host.postedOf('provider.signIn')).toHaveLength(1);
  });

  it('shows no Sign in button for other problems', () => {
    renderWithHost(<Composer />, makeState({ trusted: false }));
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('is enabled and silent when everything is fine', () => {
    renderWithHost(<Composer />);
    expect(box().disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Composer context', () => {
  it('posts the context messages, scoped to the active conversation', () => {
    const { host } = renderWithHost(<Composer />, makeState({ active: makeActive('c1') }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add the editor selection' }));
    fireEvent.click(screen.getByRole('button', { name: /Add problems/ }));
    const id = convId('c1');
    expect(host.posted.filter((m) => m.type.startsWith('context.'))).toEqual([
      { type: 'context.pick', conversationId: id, what: 'file' },
      { type: 'context.pick', conversationId: id, what: 'folder' },
      { type: 'context.addSelection', conversationId: id },
      { type: 'context.addDiagnostics', conversationId: id },
    ]);
  });

  it('omits the conversation id when none is active', () => {
    const { host } = renderWithHost(<Composer />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a file' }));
    expect(host.postedOf('context.pick')).toEqual([{ type: 'context.pick', what: 'file' }]);
  });

  it('shows draft attachments as chips and removes one', () => {
    const file = { kind: 'file' as const, path: 'src/a.ts' };
    const selection = {
      kind: 'selection' as const,
      path: 'src/b.ts',
      startLine: 2,
      endLine: 2,
      text: 'x',
    };
    const { host } = renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1'),
        draftAttachments: [file, selection],
      }),
    );
    const chips = screen.getByRole('list', { name: 'Attached context' });
    expect(within(chips).getAllByRole('listitem')).toHaveLength(2);
    expect(within(chips).getByText('b.ts:2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.ts' }));
    expect(host.postedOf('context.remove')).toEqual([
      { type: 'context.remove', conversationId: convId('c1'), attachment: file },
    ]);
  });

  it('shows draft attachments, and removes one, when no conversation exists yet', () => {
    const folder = { kind: 'folder' as const, path: 'src/lib' };
    const { host } = renderWithHost(<Composer />, makeState({ draftAttachments: [folder] }));
    const chips = screen.getByRole('list', { name: 'Attached context' });
    expect(within(chips).getByText('lib')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove lib' }));
    expect(host.postedOf('context.remove')).toEqual([
      { type: 'context.remove', attachment: folder },
    ]);
  });

  it('shows no chip list while there are no draft attachments', () => {
    renderWithHost(<Composer />);
    expect(screen.queryByRole('list', { name: 'Attached context' })).toBeNull();
  });
});

describe('Composer image paste', () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 250, 251, 252]);
  const pngFile = () => new File([bytes], 'clip.png', { type: 'image/png' });
  const clipboardOf = (file: File | null, text = '') => ({
    items: file ? [{ kind: 'file', type: file.type, getAsFile: () => file }] : [],
    files: file ? [file] : [],
    types: [...(file ? ['Files'] : []), ...(text !== '' ? ['text/plain'] : [])],
    getData: (format: string) => (format === 'text/plain' ? text : ''),
  });
  const paste = (clipboardData: ReturnType<typeof clipboardOf>) =>
    fireEvent.paste(box(), { clipboardData });

  it('posts one context.pasteImage for an image-only clipboard and prevents default', async () => {
    const { host } = renderWithHost(<Composer />);
    const notPrevented = paste(clipboardOf(pngFile()));
    expect(notPrevented).toBe(false);
    await waitFor(() => {
      expect(host.postedOf('context.pasteImage')).toHaveLength(1);
    });
    expect(host.postedOf('context.pasteImage')).toEqual([
      {
        type: 'context.pasteImage',
        mediaType: 'image/png',
        data: btoa(String.fromCharCode(...bytes)),
      },
    ]);
  });

  it('leaves a text-only paste alone', () => {
    const { host } = renderWithHost(<Composer />);
    const notPrevented = paste(clipboardOf(null, 'plain text'));
    expect(notPrevented).toBe(true);
    expect(host.postedOf('context.pasteImage')).toHaveLength(0);
  });

  it('treats a clipboard with text and an image as a text paste', async () => {
    const { host } = renderWithHost(<Composer />);
    const notPrevented = paste(clipboardOf(pngFile(), 'a spreadsheet cell'));
    expect(notPrevented).toBe(true);
    await Promise.resolve();
    expect(host.postedOf('context.pasteImage')).toHaveLength(0);
  });

  it('refuses an image over 5 MB with a notice, and clears the notice on the next good paste', async () => {
    const { host } = renderWithHost(<Composer />);
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    expect(paste(clipboardOf(big))).toBe(false);
    expect(screen.getByRole('status').textContent).toContain('The image is larger than 5 MB.');
    expect(host.postedOf('context.pasteImage')).toHaveLength(0);
    paste(clipboardOf(pngFile()));
    await waitFor(() => {
      expect(host.postedOf('context.pasteImage')).toHaveLength(1);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows a notice when the image cannot be read', async () => {
    const { host } = renderWithHost(<Composer />);
    const file = pngFile();
    file.arrayBuffer = () => Promise.reject(new Error('gone'));
    paste(clipboardOf(file));
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('The image could not be read.');
    });
    expect(host.postedOf('context.pasteImage')).toHaveLength(0);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
    type('hello');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(false);
  });

  it('keeps Send disabled while a paste is pending, then enables it', async () => {
    const { host } = renderWithHost(<Composer />);
    let release: (buffer: ArrayBuffer) => void = () => undefined;
    const file = pngFile();
    file.arrayBuffer = () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = resolve;
      });
    type('describe it');
    const send = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send' });
    expect(send().disabled).toBe(false);
    paste(clipboardOf(file));
    expect(send().disabled).toBe(true);
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(0);
    release(bytes.buffer);
    await waitFor(() => {
      expect(send().disabled).toBe(false);
    });
    expect(host.postedOf('context.pasteImage')).toHaveLength(1);
    enter();
    expect(host.postedOf('turn.send')).toHaveLength(1);
  });

  it('shows an image chip, and its remove button posts the exact attachment', () => {
    const image = {
      kind: 'image' as const,
      id: '3f2a9c'.padEnd(64, '0'),
      mediaType: 'image/png' as const,
      bytes: 1024,
    };
    const { host } = renderWithHost(<Composer />, makeState({ draftAttachments: [image] }));
    const chips = screen.getByRole('list', { name: 'Attached context' });
    expect(within(chips).getByText('Image 3f2a9c · PNG · 1 KB')).toBeTruthy();
    expect(chips.querySelector('.codicon-file-media')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Image 3f2a9c · PNG · 1 KB' }));
    expect(host.postedOf('context.remove')).toEqual([
      { type: 'context.remove', attachment: image },
    ]);
  });

  it('keeps two chips for different images distinct', () => {
    const a = {
      kind: 'image' as const,
      id: 'a'.repeat(64),
      mediaType: 'image/png' as const,
      bytes: 10,
    };
    const b = {
      kind: 'image' as const,
      id: 'b'.repeat(64),
      mediaType: 'image/jpeg' as const,
      bytes: 2000,
    };
    renderWithHost(<Composer />, makeState({ draftAttachments: [a, b] }));
    expect(screen.getByRole('button', { name: 'Remove Image aaaaaa · PNG · 10 B' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Image bbbbbb · JPEG · 2 KB' })).toBeTruthy();
  });

  it('asks for a message while an image is attached and the text is empty', () => {
    const image = {
      kind: 'image' as const,
      id: 'c'.repeat(64),
      mediaType: 'image/webp' as const,
      bytes: 5,
    };
    renderWithHost(<Composer />, makeState({ draftAttachments: [image] }));
    expect(screen.getByRole('status').textContent).toContain(
      'Add a message to send with the image.',
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(true);
    type('look');
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Composer mode and model', () => {
  it('offers Ask, Plan and Agent as a radio group with a description each', () => {
    renderWithHost(<Composer />);
    const group = screen.getByRole('radiogroup', { name: 'Mode' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(['ask', 'plan', 'agent']);
    expect(radios.map((r) => (r as HTMLInputElement).checked)).toEqual([true, false, false]);
    for (const radio of radios) {
      expect(radio.getAttribute('aria-describedby')).toBeTruthy();
      expect(
        document.getElementById(radio.getAttribute('aria-describedby') as string)?.textContent,
      ).toMatch(/\S/);
    }
    expect(within(group).getByRole('radio', { name: 'Ask' })).toBeTruthy();
  });

  it('changes the local mode and model before a conversation exists', () => {
    const { host } = renderWithHost(<Composer />);
    fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'opus' },
    });
    expect(host.postedOf('conversation.setMode')).toHaveLength(0);
    expect(host.postedOf('conversation.setModel')).toHaveLength(0);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Plan' }).checked).toBe(true);
    type('hi');
    enter();
    expect(host.postedOf('turn.send')).toEqual([
      { type: 'turn.send', text: 'hi', mode: 'plan', model: 'opus' },
    ]);
  });

  it('posts conversation.setMode and conversation.setModel for an existing conversation', () => {
    const { host } = renderWithHost(<Composer />, makeState({ active: makeActive('c1') }));
    fireEvent.click(screen.getByRole('radio', { name: 'Agent' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), {
      target: { value: 'opus' },
    });
    expect(host.postedOf('conversation.setMode')).toEqual([
      { type: 'conversation.setMode', conversationId: convId('c1'), mode: 'agent' },
    ]);
    expect(host.postedOf('conversation.setModel')).toEqual([
      { type: 'conversation.setModel', conversationId: convId('c1'), model: 'opus' },
    ]);
    // The host owns the state: the radio only changes when the host says so.
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Ask' }).checked).toBe(true);
  });

  it('lists the models from the state and keeps an unknown current model selectable', () => {
    renderWithHost(
      <Composer />,
      makeState({ active: makeActive('c1', { meta: { model: 'custom-x' } }) }),
    );
    const select = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Model' });
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['default', 'opus', 'custom-x']);
    expect(select.value).toBe('custom-x');
  });
});

describe('Composer Auto switch', () => {
  const radio = (name: string) => screen.getByRole<HTMLInputElement>('radio', { name });
  const auto = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Auto' });
  const noAuto = () => screen.queryByRole('button', { name: 'Auto' });
  const REASON = 'Auto can be turned on when the turn ends.';
  const open = (
    over: {
      mode?: 'ask' | 'plan' | 'agent';
      on?: boolean;
      running?: boolean;
      commands?: boolean;
      offered?: boolean;
    } = {},
    extra: Partial<ViewState> = {},
  ) =>
    makeState({
      ...(over.offered === false ? {} : autoOffered(over.commands ?? true)),
      active: makeActive('c1', {
        meta: {
          mode: over.mode ?? 'agent',
          ...(over.on === undefined ? {} : { agentAuto: over.on }),
        },
        turns: [makeTurn({ status: over.running === true ? 'running' : 'completed' })],
      }),
      ...extra,
    });

  it('is hidden when the settings do not offer it, also while on', () => {
    const { init } = renderWithHost(<Composer />, open({ offered: false }));
    expect(noAuto()).toBeNull();
    init(open({ offered: false, on: true }), 1);
    expect(noAuto()).toBeNull();
    expect(screen.queryByText(/Auto is on/)).toBeNull();
  });

  it.each(['ask', 'plan'] as const)('is hidden in %s mode while off', (mode) => {
    renderWithHost(<Composer />, open({ mode }));
    expect(noAuto()).toBeNull();
  });

  it('is shown in Agent mode while off, not pressed, and enabled', () => {
    renderWithHost(<Composer />, open());
    expect(auto().getAttribute('aria-pressed')).toBe('false');
    expect(auto().disabled).toBe(false);
    expect(auto().getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText(/Auto is on/)).toBeNull();
  });

  it.each(['ask', 'plan', 'agent'] as const)('is shown and pressed in %s mode while on', (mode) => {
    renderWithHost(<Composer />, open({ mode, on: true }));
    expect(auto().getAttribute('aria-pressed')).toBe('true');
    expect(auto().classList.contains('auto-switch--on')).toBe(true);
    // Not only colour: the icon changes too.
    expect(auto().querySelector('.codicon-pass-filled')).not.toBeNull();
  });

  it('is not pressed when the flag is false or absent (a conversation stored before Auto)', () => {
    const { init } = renderWithHost(<Composer />, open({ on: false }));
    expect(auto().getAttribute('aria-pressed')).toBe('false');
    init(open(), 1);
    expect(auto().getAttribute('aria-pressed')).toBe('false');
  });

  it('posts exactly conversation.setAuto with the id and the new value, and does not move by itself', () => {
    const { host, init } = renderWithHost(<Composer />, open());
    fireEvent.click(auto());
    expect(host.postedOf('conversation.setAuto')).toEqual([
      { type: 'conversation.setAuto', conversationId: convId('c1'), on: true },
    ]);
    expect(host.posted.filter((m) => m.type !== 'ready')).toHaveLength(1);
    expect(auto().getAttribute('aria-pressed')).toBe('false');
    // The user declined the dialog: the host's state did not change, nor does the switch.
    init(open(), 1);
    expect(auto().getAttribute('aria-pressed')).toBe('false');
    // The user accepted: the host's state moves it.
    init(open({ on: true }), 2);
    expect(auto().getAttribute('aria-pressed')).toBe('true');
  });

  it('posts on: false from the on state and waits for the host', () => {
    const { host } = renderWithHost(<Composer />, open({ on: true }));
    fireEvent.click(auto());
    expect(host.postedOf('conversation.setAuto')).toEqual([
      { type: 'conversation.setAuto', conversationId: convId('c1'), on: false },
    ]);
    expect(auto().getAttribute('aria-pressed')).toBe('true');
  });

  describe('for a conversation that is not open yet', () => {
    const draft = (on: boolean, mode: 'ask' | 'agent' = 'agent') =>
      makeState({
        ...autoOffered(),
        defaults: { mode, model: 'default' },
        draftAgentAuto: on,
      });

    it('reads draftAgentAuto and posts without an id', () => {
      const { host, init } = renderWithHost(<Composer />, draft(false));
      expect(auto().getAttribute('aria-pressed')).toBe('false');
      fireEvent.click(auto());
      expect(host.postedOf('conversation.setAuto')).toEqual([
        { type: 'conversation.setAuto', on: true },
      ]);
      expect(auto().getAttribute('aria-pressed')).toBe('false');
      init(draft(true), 1);
      expect(auto().getAttribute('aria-pressed')).toBe('true');
      fireEvent.click(auto());
      expect(host.postedOf('conversation.setAuto')[1]).toEqual({
        type: 'conversation.setAuto',
        on: false,
      });
    });

    it('is hidden in Ask mode while off and shown while the draft flag is on', () => {
      const { init } = renderWithHost(<Composer />, draft(false, 'ask'));
      expect(noAuto()).toBeNull();
      init(draft(true, 'ask'), 1);
      expect(auto().getAttribute('aria-pressed')).toBe('true');
    });

    it('appears when the user picks Agent mode', () => {
      renderWithHost(<Composer />, draft(false, 'ask'));
      fireEvent.click(radio('Agent'));
      expect(auto()).toBeTruthy();
    });
  });

  describe('while a turn runs', () => {
    it('is disabled while off, with its reason tied by aria-describedby, and posts nothing', () => {
      const { host } = renderWithHost(<Composer />, open({ running: true }));
      expect(auto().disabled).toBe(true);
      const reason = screen.getByText(REASON);
      expect(auto().getAttribute('aria-describedby')).toBe(reason.id);
      fireEvent.click(auto());
      expect(host.postedOf('conversation.setAuto')).toHaveLength(0);
    });

    it('stays enabled for turning it off, and posts on: false', () => {
      const { host } = renderWithHost(<Composer />, open({ running: true, on: true }));
      expect(auto().disabled).toBe(false);
      expect(screen.queryByText(REASON)).toBeNull();
      fireEvent.click(auto());
      expect(host.postedOf('conversation.setAuto')).toEqual([
        { type: 'conversation.setAuto', conversationId: convId('c1'), on: false },
      ]);
    });

    it('is enabled again when the turn ends', () => {
      const { init } = renderWithHost(<Composer />, open({ running: true }));
      init(open(), 1);
      expect(auto().disabled).toBe(false);
      expect(screen.queryByText(REASON)).toBeNull();
    });
  });

  describe('when the composer is blocked', () => {
    it('disables turning it on, pointing to the notice, but never turning it off', () => {
      const { init } = renderWithHost(<Composer />, open({}, { trusted: false }));
      expect(auto().disabled).toBe(true);
      const notice = screen.getByText(/workspace is not trusted/).closest('[role="status"]');
      expect(auto().getAttribute('aria-describedby')).toBe(notice?.id);
      init(open({ on: true }, { trusted: false }), 1);
      expect(auto().disabled).toBe(false);
    });

    it('does the same while the provider is not ready', () => {
      const { init } = renderWithHost(
        <Composer />,
        open({}, { provider: makeProvider({ installed: false }) }),
      );
      expect(auto().disabled).toBe(true);
      init(open({ on: true }, { provider: makeProvider({ installed: false }) }), 1);
      expect(auto().disabled).toBe(false);
    });
  });

  describe('the hint', () => {
    it('says commands and edits run without asking in Agent mode', () => {
      renderWithHost(<Composer />, open({ on: true }));
      expect(
        screen.getByText('Auto is on: commands and edits in this folder run without asking.'),
      ).toBeTruthy();
    });

    it('says commands still ask when the settings keep them asking', () => {
      renderWithHost(<Composer />, open({ on: true, commands: false }));
      expect(
        screen.getByText(
          'Auto is on: edits in this folder run without asking. Commands still ask.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/commands and edits/)).toBeNull();
    });

    it.each(['ask', 'plan'] as const)('says it is on for the Agent turns in %s mode', (mode) => {
      renderWithHost(<Composer />, open({ mode, on: true }));
      expect(screen.getByText("Auto is on for this conversation's Agent turns.")).toBeTruthy();
    });

    it('is not a blocking hint: Send stays enabled', () => {
      renderWithHost(<Composer />, open({ on: true }));
      type('go');
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(false);
      expect(box().getAttribute('aria-describedby')).toBeNull();
    });
  });

  describe('the mode description', () => {
    const OFF = 'Can edit files and run tools, with your approval.';
    const WITH_COMMANDS =
      'Can edit files and run commands. Protected files and anything outside the folder still ask.';
    const WITHOUT_COMMANDS =
      'Can edit files. Commands, protected files and anything outside the folder still ask.';
    const describedBy = (name: string) =>
      document.getElementById(radio(name).getAttribute('aria-describedby') as string);
    const visibleDescription = () =>
      Array.from(document.querySelectorAll<HTMLElement>('.mode-description'))
        .filter((el) => !el.hidden)
        .map((el) => el.textContent);
    const draftState = (on: boolean, commands: boolean, mode: 'ask' | 'plan' | 'agent' = 'agent') =>
      makeState({
        ...autoOffered(commands),
        defaults: { mode, model: 'default' },
        draftAgentAuto: on,
      });

    const cases = [
      ['an open conversation', (on: boolean, commands: boolean) => open({ on, commands })],
      ['a draft', (on: boolean, commands: boolean) => draftState(on, commands)],
    ] as const;

    describe.each(cases)('for %s', (_label, state) => {
      it('keeps the approval sentence while Auto is off', () => {
        renderWithHost(<Composer />, state(false, true));
        expect(describedBy('Agent')?.textContent).toBe(OFF);
        expect(visibleDescription()).toEqual([OFF]);
      });

      it('says commands run, and what still asks, while Auto is on with commands', () => {
        renderWithHost(<Composer />, state(true, true));
        expect(describedBy('Agent')?.textContent).toBe(WITH_COMMANDS);
        expect(visibleDescription()).toEqual([WITH_COMMANDS]);
        expect(screen.queryByText(OFF)).toBeNull();
      });

      it('says commands still ask while Auto is on without commands', () => {
        renderWithHost(<Composer />, state(true, false));
        expect(describedBy('Agent')?.textContent).toBe(WITHOUT_COMMANDS);
        expect(visibleDescription()).toEqual([WITHOUT_COMMANDS]);
        expect(screen.queryByText(OFF)).toBeNull();
      });
    });

    const READ_ONLY = {
      ask: 'Read-only. Ask about your code; nothing is changed.',
      plan: 'Read-only. Build a plan to review before any change.',
    } as const;

    it.each(['ask', 'plan'] as const)(
      'is unchanged in %s mode while Auto is on, for an open conversation and a draft',
      (mode) => {
        const { init } = renderWithHost(<Composer />, open({ mode, on: true }));
        expect(visibleDescription()).toEqual([READ_ONLY[mode]]);
        expect(describedBy(mode === 'ask' ? 'Ask' : 'Plan')?.textContent).toBe(READ_ONLY[mode]);
        init(draftState(true, true, mode), 1);
        expect(visibleDescription()).toEqual([READ_ONLY[mode]]);
        expect(describedBy(mode === 'ask' ? 'Ask' : 'Plan')?.textContent).toBe(READ_ONLY[mode]);
      },
    );

    it('says the draft hint is about the Agent turns while the composer is in Ask or Plan mode', () => {
      renderWithHost(<Composer />, draftState(true, true, 'ask'));
      expect(screen.getByText("Auto is on for this conversation's Agent turns.")).toBeTruthy();
      expect(screen.queryByText(/first message/)).toBeNull();
    });
  });

  it('follows the mode chosen during a turn: Agent chosen during a Plan turn shows the switch', () => {
    const state = open({ mode: 'plan', running: true });
    renderWithHost(<Composer />, state);
    expect(noAuto()).toBeNull();
    fireEvent.click(radio('Agent'));
    expect(auto().disabled).toBe(true);
    expect(auto().getAttribute('aria-pressed')).toBe('false');
  });

  it('follows the mode chosen during a turn for the hint while on', () => {
    renderWithHost(<Composer />, open({ mode: 'plan', running: true, on: true }));
    expect(screen.getByText("Auto is on for this conversation's Agent turns.")).toBeTruthy();
    fireEvent.click(radio('Agent'));
    expect(
      screen.getByText('Auto is on: commands and edits in this folder run without asking.'),
    ).toBeTruthy();
    fireEvent.click(radio('Ask'));
    expect(screen.getByText("Auto is on for this conversation's Agent turns.")).toBeTruthy();
    expect(auto().disabled).toBe(false);
  });
});
