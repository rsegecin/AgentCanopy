// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDoc } from '../../../shared';
import { App } from '../../app/App';
import {
  assistantMessage,
  convId,
  makeActive,
  makePlanContent,
  makePlanDoc,
  makePlanVersion,
  makeState,
  makeTurn,
  planId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { Composer } from '../chat/Composer';
import { MessageList } from '../chat/MessageList';
import { registerPartRenderer } from '../chat/registry';
import { resetMermaidForTests } from '../diagram/mermaid-render';
import { PlanUpdateCard } from './PlanUpdateCard';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

beforeEach(() => {
  resetMermaidForTests();
  mermaid.render.mockReset();
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>drawn</text></svg>',
  });
});

const PLAN = planId('plan1');

function stateWith(plan: PlanDoc | null, extra: Parameters<typeof makeActive>[1] = {}) {
  return makeState({ active: makeActive('c1', { plan, ...extra }) });
}

const tab = (name: string) => screen.queryByRole('tab', { name });

describe('Plan tab', () => {
  it('appears only while the open conversation has a plan', () => {
    const { init } = renderWithHost(<App />, stateWith(null));
    expect(tab('Plan')).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'History']);
    init(stateWith(makePlanDoc()), 1);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Chat',
      'Plan',
      'History',
    ]);
    init(makeState(), 2);
    expect(tab('Plan')).toBeNull();
  });

  it('shows the plan when selected, and nothing of it otherwise', () => {
    renderWithHost(<App />, stateWith(makePlanDoc()));
    expect(screen.queryByRole('heading', { level: 1, name: 'Add caching' })).toBeNull();
    fireEvent.click(tab('Plan') as HTMLElement);
    expect(screen.getByRole('heading', { level: 1, name: 'Add caching' })).toBeTruthy();
    expect(tab('Plan')?.getAttribute('aria-selected')).toBe('true');
    const panel = document.getElementById(tab('Plan')?.getAttribute('aria-controls') ?? '');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.hasAttribute('hidden')).toBe(false);
  });

  it('switches with show-tab events for plan, chat and history', () => {
    const { host } = renderWithHost(<App />, stateWith(makePlanDoc()));
    const selected = () =>
      screen
        .getAllByRole('tab')
        .filter((t) => t.getAttribute('aria-selected') === 'true')
        .map((t) => t.textContent);
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'plan' } });
    expect(selected()).toEqual(['Plan']);
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'history' } });
    expect(selected()).toEqual(['History']);
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'chat' } });
    expect(selected()).toEqual(['Chat']);
  });

  it('falls back to Chat when the plan goes away while its tab is selected', () => {
    const { init } = renderWithHost(<App />, stateWith(makePlanDoc()));
    fireEvent.click(tab('Plan') as HTMLElement);
    init(makeState(), 1);
    expect(tab('Chat')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Plan')).toBeNull();
  });

  it('moves between the three tabs with the arrow keys', () => {
    renderWithHost(<App />, stateWith(makePlanDoc()));
    const chat = tab('Chat') as HTMLElement;
    fireEvent.keyDown(chat, { key: 'ArrowRight' });
    expect(tab('Plan')?.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(tab('Plan') as HTMLElement, { key: 'End' });
    expect(tab('History')?.getAttribute('aria-selected')).toBe('true');
  });

  it('remembers the Plan tab across a reload', () => {
    const first = renderWithHost(<App />, stateWith(makePlanDoc()));
    fireEvent.click(tab('Plan') as HTMLElement);
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    renderWithHost(<App />, stateWith(makePlanDoc()), saved);
    expect(tab('Plan')?.getAttribute('aria-selected')).toBe('true');
  });

  it('has every button named', () => {
    renderWithHost(<App />, stateWith(makePlanDoc()));
    fireEvent.click(tab('Plan') as HTMLElement);
    for (const button of screen.getAllByRole('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
      expect(name.trim(), button.outerHTML).not.toBe('');
    }
  });
});

describe('plan-update card', () => {
  let off: () => void;
  beforeEach(() => {
    off = registerPartRenderer('plan-update', PlanUpdateCard);
  });
  afterEach(() => {
    off();
  });

  function twoVersions(summary = 'Split the cache in two.'): PlanDoc {
    return makePlanDoc({
      versions: [
        makePlanVersion(1),
        makePlanVersion(2, { content: makePlanContent({ changeSummary: summary }) }),
      ],
    });
  }

  function chat(plan: PlanDoc | null, version: number) {
    return stateWith(plan, {
      messages: [
        userMessage('u1', 'plan it'),
        assistantMessage('a1', [{ kind: 'plan-update', planId: PLAN, version }]),
      ],
    });
  }

  it('shows the version and the change summary', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), 2));
    const card = screen.getByRole('group', { name: 'Plan update: version 2' });
    expect(within(card).getByText('Plan updated to version 2')).toBeTruthy();
    expect(within(card).getByText('Split the cache in two.')).toBeTruthy();
  });

  it('leaves out an empty change summary', () => {
    renderWithHost(<MessageList />, chat(twoVersions('  '), 2));
    expect(document.querySelector('.plan-update-summary')).toBeNull();
  });

  it('opens the Plan tab', () => {
    const { services } = renderWithHost(<MessageList />, chat(twoVersions(), 2));
    fireEvent.click(screen.getByRole('button', { name: 'Open plan' }));
    expect(services.ui.getSnapshot().tab).toBe('plan');
  });

  it('compares with the previous version', () => {
    const { host } = renderWithHost(<MessageList />, chat(twoVersions(), 2));
    fireEvent.click(screen.getByRole('button', { name: 'View changes' }));
    expect(host.postedOf('plan.compare')).toEqual([
      { type: 'plan.compare', planId: PLAN, left: 1, right: 2 },
    ]);
  });

  it('reverts to the previous version', () => {
    const { host } = renderWithHost(<MessageList />, chat(twoVersions(), 2));
    fireEvent.click(screen.getByRole('button', { name: 'Revert to version 1' }));
    expect(host.postedOf('plan.revert')).toEqual([
      { type: 'plan.revert', planId: PLAN, version: 1 },
    ]);
  });

  it('offers only Open plan for version 1', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), 1));
    expect(screen.getByRole('button', { name: 'Open plan' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
  });

  it('does not offer a revert for a version that is no longer the latest', () => {
    const three = makePlanDoc({
      versions: [makePlanVersion(1), makePlanVersion(2), makePlanVersion(3)],
    });
    renderWithHost(<MessageList />, chat(three, 2));
    expect(screen.getByRole('button', { name: 'View changes' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
  });

  it('follows the state when a newer version arrives', () => {
    const { init } = renderWithHost(<MessageList />, chat(twoVersions(), 2));
    expect(screen.getByRole('button', { name: 'Revert to version 1' })).toBeTruthy();
    init(
      chat(
        makePlanDoc({ versions: [makePlanVersion(1), makePlanVersion(2), makePlanVersion(3)] }),
        2,
      ),
      1,
    );
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull();
  });

  it('shows just the line when the plan is not in the state', () => {
    renderWithHost(<MessageList />, chat(null, 2));
    expect(screen.getByText('Plan updated to version 2')).toBeTruthy();
    expect(document.querySelector('.plan-update button')).toBeNull();
  });

  it('is registered by the plan feature itself', async () => {
    vi.resetModules();
    const registry = await import('../chat/registry');
    expect(registry.getPartRenderer('plan-update')).toBeUndefined();
    await import('./index');
    expect(registry.getPartRenderer('plan-update')).toBeDefined();
  });
});

describe('Composer with a plan', () => {
  const PLAN_HINT_OFF = 'The agent may revise the plan.';
  const PLAN_HINT_ON = 'The plan is locked. The agent can only answer questions about it.';
  const lock = () => screen.getByRole('button', { name: 'Lock plan' });

  function withMode(mode: 'ask' | 'plan' | 'agent', locked = false, plan = true) {
    return stateWith(plan ? makePlanDoc() : null, { meta: { mode, planLocked: locked } });
  }

  it('shows a lock toggle and the unlocked hint in Plan mode', () => {
    renderWithHost(<Composer />, withMode('plan'));
    expect(lock().getAttribute('aria-pressed')).toBe('false');
    expect(lock().getAttribute('title')).toMatch(/cannot change it/);
    expect(screen.getByText(PLAN_HINT_OFF)).toBeTruthy();
  });

  it('puts the toggle in the mode row, next to the mode selector', () => {
    renderWithHost(<Composer />, withMode('plan'));
    const row = lock().closest('.composer-modes');
    expect(row?.querySelector('[role="radiogroup"]')).not.toBeNull();
  });

  it('shows the locked hint and a pressed toggle when the plan is locked', () => {
    renderWithHost(<Composer />, withMode('plan', true));
    expect(lock().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(PLAN_HINT_ON)).toBeTruthy();
    expect(screen.queryByText(PLAN_HINT_OFF)).toBeNull();
  });

  it('posts plan.setLocked, and follows the host', () => {
    const { host, init } = renderWithHost(<Composer />, withMode('plan'));
    fireEvent.click(lock());
    expect(host.postedOf('plan.setLocked')).toEqual([
      { type: 'plan.setLocked', conversationId: convId('c1'), locked: true },
    ]);
    expect(lock().getAttribute('aria-pressed')).toBe('false');
    init(withMode('plan', true), 1);
    fireEvent.click(lock());
    expect(host.postedOf('plan.setLocked')[1]?.locked).toBe(false);
  });

  it('says the plan is attached read-only in Ask mode, without a toggle', () => {
    renderWithHost(<Composer />, withMode('ask'));
    expect(screen.getByText('The plan is attached read-only.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lock plan' })).toBeNull();
  });

  it('says nothing about the plan in Agent mode', () => {
    renderWithHost(<Composer />, withMode('agent'));
    expect(document.querySelector('.composer-hint')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock plan' })).toBeNull();
  });

  it('says nothing without a plan', () => {
    renderWithHost(<Composer />, withMode('plan', false, false));
    expect(document.querySelector('.composer-hint')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Lock plan' })).toBeNull();
  });

  it('keeps the lock usable while a turn runs', () => {
    renderWithHost(
      <Composer />,
      stateWith(makePlanDoc(), {
        meta: { mode: 'plan' },
        turns: [makeTurn({ status: 'running' })],
      }),
    );
    expect((lock() as HTMLButtonElement).disabled).toBe(false);
  });
});
