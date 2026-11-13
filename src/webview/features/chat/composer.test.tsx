// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  assistantMessage,
  convId,
  makeActive,
  makeProvider,
  makeState,
  makeTurn,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
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

  it('prefills and focuses from host events', () => {
    const { host } = renderWithHost(<Composer />);
    host.emit({ type: 'event', event: { kind: 'prefill-composer', text: 'from a fork' } });
    expect(box().value).toBe('from a fork');
    expect(document.activeElement).toBe(box());
    (document.activeElement as HTMLElement).blur();
    host.emit({ type: 'event', event: { kind: 'focus-composer' } });
    expect(document.activeElement).toBe(box());
  });
});

describe('Composer while a turn runs', () => {
  const running = () =>
    makeState({
      active: makeActive('c1', {
        turns: [makeTurn({ status: 'running' })],
        messages: [assistantMessage('a1', [])],
      }),
    });

  it('turns Send into Stop, which posts turn.cancel', () => {
    const { host } = renderWithHost(<Composer />, running());
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(host.postedOf('turn.cancel')).toEqual([
      { type: 'turn.cancel', conversationId: convId('c1') },
    ]);
  });

  it('does not send on Enter while running', () => {
    const { host } = renderWithHost(<Composer />, running());
    type('next');
    enter();
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
