// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Banner } from '../../shared';
import {
  assistantMessage,
  convId,
  makeActive,
  makePlanDoc,
  makeProvider,
  makeState,
  makeSummary,
  userMessage,
} from '../test-support/fixtures';
import { renderWithHost } from '../test-support/harness';
import { App } from './App';

const busyState = () =>
  makeState({
    conversations: [makeSummary('c1', { title: 'First' }), makeSummary('c2', { title: 'Second' })],
    active: makeActive('c1', {
      messages: [
        userMessage('u1', 'hello', {
          attachments: [{ kind: 'file', path: 'src/a.ts' }],
        }),
        assistantMessage('a1', [
          { kind: 'text', text: 'hi `src/a.ts:3`\n\n```ts\nconst a = 1;\n```' },
          { kind: 'thinking', text: 'hmm' },
          {
            kind: 'tool',
            call: {
              id: 't1',
              name: 'Read',
              input: { file_path: 'src/a.ts' },
              inputTruncated: false,
              status: 'done',
              parentId: null,
              startedAt: 1,
            },
          },
        ]),
      ],
    }),
    draftAttachments: [{ kind: 'folder', path: 'src' }],
    banners: [
      { id: 'b1', level: 'error', text: 'Something broke', dismissible: true },
      {
        id: 'b2',
        level: 'warning',
        text: 'Heads up',
        dismissible: false,
        action: { id: 'fix', label: 'Fix it' },
      },
      { id: 'b3', level: 'info', text: 'FYI', dismissible: true },
    ] satisfies Banner[],
  });

function accessibleName(button: HTMLElement): string {
  const label = button.getAttribute('aria-label');
  if (label !== null) return label.trim();
  const labelledBy = button.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    return labelledBy
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
  }
  return (button.textContent ?? '').trim();
}

describe('App shell', () => {
  it('shows a quiet loading state until the first init, then the app', () => {
    const { host, init } = renderWithHost(<App />, null);
    expect(host.posted).toEqual([{ type: 'ready' }]);
    expect(screen.getByRole('status').textContent).toContain('Loading');
    expect(screen.queryByRole('tablist')).toBeNull();
    init(makeState());
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('starts a new conversation from the header and goes to the chat tab', () => {
    const { host } = renderWithHost(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(host.postedOf('conversation.new')).toEqual([{ type: 'conversation.new' }]);
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });

  it('reports the provider state with text, not just colour', () => {
    const { init } = renderWithHost(<App />);
    expect(screen.getAllByRole('status')[0]?.textContent).toContain('Claude Code');
    init(makeState({ provider: makeProvider({ auth: 'signed-out' }) }), 1);
    const indicator = screen.getByTitle(/Claude Code: Signed out/);
    expect(indicator.textContent).toContain('Signed out');
  });

  it('switches tabs from host events', () => {
    const { host } = renderWithHost(<App />);
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'history' } });
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
    host.emit({ type: 'event', event: { kind: 'focus-composer' } });
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });

  it('has no Plan tab, even for a conversation with a plan, and ignores a saved plan tab', () => {
    const state = makeState({ active: makeActive('c1', { plan: makePlanDoc() }) });
    renderWithHost(<App />, state, { tab: 'plan' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'History']);
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens a conversation from History and returns to Chat', () => {
    const { host } = renderWithHost(<App />, busyState());
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: /^Second/ }));
    expect(host.postedOf('conversation.open')).toEqual([
      { type: 'conversation.open', conversationId: convId('c2') },
    ]);
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows toasts from the host and lets them be dismissed', () => {
    const { host } = renderWithHost(<App />);
    host.emit({ type: 'event', event: { kind: 'toast', level: 'error', text: 'Copy failed' } });
    expect(screen.getByRole('alert').textContent).toContain('Copy failed');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(screen.queryByText('Copy failed')).toBeNull();
  });

  it('remembers the active tab across a reload', () => {
    const first = renderWithHost(<App />);
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    renderWithHost(<App />, makeState(), saved);
    expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('overflow menu', () => {
  it('offers the three actions and posts their messages', () => {
    const { host } = renderWithHost(<App />, busyState());
    const trigger = screen.getByRole('button', { name: 'More actions' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'Open in editor area',
      'Show logs',
      'Refresh provider',
    ]);
    expect(document.activeElement).toBe(items[0]);

    fireEvent.click(items[0] as HTMLElement);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Show logs' }));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Refresh provider' }));
    expect(host.postedOf('conversation.openInEditor')).toEqual([
      { type: 'conversation.openInEditor', conversationId: convId('c1') },
    ]);
    expect(host.postedOf('logs.show')).toHaveLength(1);
    expect(host.postedOf('provider.refresh')).toHaveLength(1);
  });

  it('omits the conversation id when none is open', () => {
    const { host } = renderWithHost(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in editor area' }));
    expect(host.postedOf('conversation.openInEditor')).toEqual([
      { type: 'conversation.openInEditor' },
    ]);
  });

  it('moves with the arrow keys and closes with Escape, returning focus', () => {
    renderWithHost(<App />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitem');
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: 'ArrowUp' });
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2] as HTMLElement, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on an outside click', () => {
    renderWithHost(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('banners', () => {
  it('uses role=alert for errors only, with level text and actions', () => {
    const { host } = renderWithHost(<App />, busyState());
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Something broke');
    expect(alert.textContent).toContain('Error');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByText(/Heads up/).closest('[role="status"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    expect(host.postedOf('banner.action')).toEqual([
      { type: 'banner.action', bannerId: 'b2', actionId: 'fix' },
    ]);
  });

  it('shows a dismiss button only on dismissible banners', () => {
    const { host } = renderWithHost(<App />, busyState());
    const dismissers = screen.getAllByRole('button', { name: 'Dismiss' });
    expect(dismissers).toHaveLength(2);
    fireEvent.click(dismissers[0] as HTMLElement);
    expect(host.postedOf('banner.dismiss')).toEqual([{ type: 'banner.dismiss', bannerId: 'b1' }]);
  });

  it('follows state patches', () => {
    const { host } = renderWithHost(<App />, busyState());
    host.emit({ type: 'patch', seq: 1, ops: [{ op: 'set', path: ['banners'], value: [] }] });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('tabs', () => {
  it('has tablist, tab and tabpanel roles wired together', () => {
    renderWithHost(<App />);
    const list = screen.getByRole('tablist');
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Chat', 'History']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0]?.id);
    expect(tabs[0]?.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('moves and selects with the arrow keys, wrapping around, and with Home and End', () => {
    renderWithHost(<App />);
    const [chat, history] = screen.getAllByRole('tab') as [HTMLElement, HTMLElement];
    chat.focus();
    fireEvent.keyDown(chat, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(history);
    expect(history.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(history.id);
    fireEvent.keyDown(history, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(chat);
    fireEvent.keyDown(chat, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(history);
    fireEvent.keyDown(history, { key: 'Home' });
    expect(document.activeElement).toBe(chat);
    fireEvent.keyDown(chat, { key: 'End' });
    expect(document.activeElement).toBe(history);
  });
});

describe('accessible names', () => {
  it('gives every button in every view an accessible name', () => {
    renderWithHost(<App />, busyState());
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const check = () => {
      const buttons = screen.getAllByRole('button');
      expect(buttons.length).toBeGreaterThan(8);
      for (const button of buttons) {
        expect(accessibleName(button), button.outerHTML).not.toBe('');
      }
    };
    check();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete First' }));
    check();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename First' }));
    check();
  });

  it('gives every form control a name', () => {
    renderWithHost(<App />, busyState());
    for (const control of screen.getAllByRole('textbox')) {
      expect(accessibleName(control) || control.getAttribute('aria-label')).toBeTruthy();
    }
    expect(screen.getByRole('combobox', { name: 'Model' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Conversation' })).toBeTruthy();
  });

  it('marks icons as decorative', () => {
    const { container } = renderWithHost(<App />, busyState());
    const icons = container.querySelectorAll('.codicon');
    expect(icons.length).toBeGreaterThan(5);
    for (const icon of Array.from(icons)) expect(icon.getAttribute('aria-hidden')).toBe('true');
  });

  it('applies a patch that arrives after the first render without remounting the composer', () => {
    const { host } = renderWithHost(<App />, busyState());
    const box = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(box, { target: { value: 'draft' } });
    act(() => {
      host.emit({ type: 'patch', seq: 1, ops: [{ op: 'set', path: ['trusted'], value: true }] });
    });
    expect(screen.getByRole('textbox', { name: 'Message' })).toBe(box);
    expect((box as HTMLTextAreaElement).value).toBe('draft');
  });
});
