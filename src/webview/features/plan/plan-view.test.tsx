// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanDoc, PlanUserDecision } from '../../../shared';
import {
  assistantMessage,
  makeActive,
  makeConfigChange,
  makePlanContent,
  makePlanDoc,
  makePlanVersion,
  makeState,
  makeTurn,
  planId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { MessageList } from '../chat/MessageList';
import { registerPartRenderer } from '../chat/registry';
import { PlanUpdateCard } from './PlanUpdateCard';
import { formatTime } from './plan-model';

const PLAN = planId('plan1');

let off: () => void;
beforeEach(() => {
  off = registerPartRenderer('plan-update', PlanUpdateCard);
});
afterEach(() => {
  off();
});

const part = (version: number, id = PLAN) => ({
  kind: 'plan-update' as const,
  planId: id,
  version,
});

/** A chat with one assistant message per plan-update part version, the way plans arrive. */
function chat(
  plan: PlanDoc | null,
  partVersions: number[],
  extra: Parameters<typeof makeActive>[1] = {},
  configChanges = 0,
) {
  return makeState({
    active: makeActive('c1', {
      plan,
      messages: [
        userMessage('u0', 'plan it', { mode: 'plan' }),
        ...partVersions.map((v) => assistantMessage(`a${String(v)}`, [part(v)])),
      ],
      ...extra,
    }),
    review: {
      entries: [],
      configChanges: Array.from({ length: configChanges }, (_, i) =>
        makeConfigChange(`k${String(i)}`),
      ),
      busy: false,
    },
  });
}

const decision = (over: Partial<PlanUserDecision> & Pick<PlanUserDecision, 'targetId' | 'kind'>) =>
  ({ values: ['x'], decidedAt: 1_700_000_500_000, ...over }) satisfies PlanUserDecision;

const twoVersions = () =>
  makePlanDoc({
    versions: [
      makePlanVersion(1, {
        content: makePlanContent({ title: 'Old title', objective: 'Old objective' }),
      }),
      makePlanVersion(2, {
        author: 'user',
        content: makePlanContent({ title: 'New title', changeSummary: 'Added caching.' }),
      }),
    ],
  });

const threeVersions = () =>
  makePlanDoc({
    versions: [
      makePlanVersion(1, { content: makePlanContent({ title: 'Title one' }) }),
      makePlanVersion(2, { content: makePlanContent({ title: 'Title two' }) }),
      makePlanVersion(3, { content: makePlanContent({ title: 'Title three' }) }),
    ],
  });

const answeredAll = [
  decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'] }),
  decision({ targetId: 'size', kind: 'open-question', values: ['small'] }),
  decision({ targetId: 'keys', kind: 'open-question', values: ['user'] }),
  decision({ targetId: 'notes', kind: 'open-question', values: ['x'] }),
];

const current = () => document.querySelector<HTMLElement>('.plan-card--current') as HTMLElement;
const approve = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Approve and Execute' });
const describedBy = (el: HTMLElement) =>
  (el.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter((id) => id !== '')
    .map((id) => document.getElementById(id)?.textContent ?? '');

describe('the current plan card', () => {
  it('names the plan, the real version in words and the change summary', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), [2]));
    const card = screen.getByRole('region', { name: 'New title' });
    expect(within(card).getByRole('heading', { level: 2 }).textContent).toBe(
      'New title, open version 2',
    );
    expect(within(card).getByText('Version 2')).toBeTruthy();
    expect(within(card).getByText('Added caching.')).toBeTruthy();
    expect(within(card).queryByText(/restored/)).toBeNull();
  });

  it('leaves out an empty change summary', () => {
    renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    expect(document.querySelector('.plan-update-summary')).toBeNull();
  });

  it('opens the latest version from the title button', () => {
    const { host } = renderWithHost(<MessageList />, chat(twoVersions(), [2]));
    fireEvent.click(screen.getByRole('button', { name: 'New title, open version 2' }));
    expect(host.postedOf('plan.open')).toEqual([{ type: 'plan.open', planId: PLAN, version: 2 }]);
  });

  it('follows the state when the plan changes under it', () => {
    const { init } = renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    expect(screen.getByRole('button', { name: 'Add caching, open version 1' })).toBeTruthy();
    init(chat(twoVersions(), [1]), 1);
    expect(screen.getByRole('button', { name: 'New title, open version 2' })).toBeTruthy();
    expect(screen.getByText('Version 2')).toBeTruthy();
  });

  it('offers neither View changes nor Revert for version 1', () => {
    renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    expect(screen.queryByRole('button', { name: /^View changes/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Revert/ })).toBeNull();
  });

  it('compares with the previous version', () => {
    const { host } = renderWithHost(<MessageList />, chat(threeVersions(), [3]));
    fireEvent.click(within(current()).getByRole('button', { name: /^View changes/ }));
    expect(host.postedOf('plan.compare')).toEqual([
      { type: 'plan.compare', planId: PLAN, left: 2, right: 3 },
    ]);
  });

  it('reverts to the previous version', () => {
    const { host } = renderWithHost(<MessageList />, chat(threeVersions(), [3]));
    fireEvent.click(screen.getByRole('button', { name: 'Revert to version 2' }));
    expect(host.postedOf('plan.revert')).toEqual([
      { type: 'plan.revert', planId: PLAN, version: 2 },
    ]);
  });

  it('shows no export, editor or section controls any more', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), [2]));
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Open in editor/ })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.querySelector('.plan-section-toggle')).toBeNull();
  });
});

describe('Your decisions', () => {
  it('lists every decision with its question and values, orphans last and marked', () => {
    renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({
          decisions: [
            decision({
              targetId: 'eviction',
              kind: 'decision-point',
              values: ['lru'],
              decidedAt: 1,
            }),
            decision({
              targetId: 'gone-point',
              kind: 'decision-point',
              values: ['a'],
              decidedAt: 2,
            }),
            decision({
              targetId: 'keys',
              kind: 'open-question',
              values: ['user', 'org'],
              decidedAt: 3,
            }),
            decision({
              targetId: 'Which colour?',
              kind: 'interactive-question',
              values: ['Red'],
              decidedAt: 4,
            }),
            decision({
              targetId: 'gone-question',
              kind: 'open-question',
              values: ['free'],
              decidedAt: 5,
            }),
          ],
        }),
        [1],
      ),
    );
    const group = screen.getByRole('group', { name: 'Your decisions' });
    const items = within(group).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('.plan-question')?.textContent)).toEqual([
      'Which eviction policy?',
      'Which keys are cached?',
      'Which colour?',
      'gone-point',
      'gone-question',
    ]);
    expect(items.map((li) => li.querySelector('.plan-decision-values')?.textContent)).toEqual([
      'LRU',
      'User, Org',
      'Red',
      'a',
      'free',
    ]);
    expect(items.map((li) => within(li).queryByText('No longer in the plan') !== null)).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    expect(within(items[0] as HTMLElement).getByText(formatTime(1), { exact: false })).toBeTruthy();
  });

  it('shows no orphan mark when everything is still in the plan, and no list without decisions', () => {
    const first = renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({
          decisions: [decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'] })],
        }),
        [1],
      ),
    );
    expect(screen.queryByText('No longer in the plan')).toBeNull();
    first.unmount();
    renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    expect(screen.queryByRole('group', { name: 'Your decisions' })).toBeNull();
  });

  it('judges orphans against the latest version', () => {
    const doc = twoVersions();
    doc.versions[1] = makePlanVersion(2, {
      content: makePlanContent({ decisionPoints: [], openQuestions: [] }),
    });
    doc.decisions = [decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'] })];
    renderWithHost(<MessageList />, chat(doc, [1, 2]));
    expect(within(current()).getByText('No longer in the plan')).toBeTruthy();
  });
});

describe('Still to decide', () => {
  it('is headed with the number of unanswered questions', () => {
    renderWithHost(
      <MessageList />,
      chat(makePlanDoc({ decisions: [answeredAll[0] as PlanUserDecision] }), [1]),
    );
    expect(screen.getByRole('group', { name: 'Still to decide (3)' })).toBeTruthy();
    expect(screen.queryByText('Decision points')).toBeNull();
  });

  it('becomes "Decision points" once every question is answered, and keeps the answers', () => {
    renderWithHost(<MessageList />, chat(makePlanDoc({ decisions: answeredAll }), [1]));
    const group = screen.getByRole('group', { name: 'Decision points' });
    expect(within(group).getByRole<HTMLInputElement>('radio', { name: 'LRU' }).checked).toBe(true);
    expect(screen.queryByText(/Still to decide/)).toBeNull();
  });

  it('is absent when the plan carries no decision points or open questions', () => {
    renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({
          versions: [
            makePlanVersion(1, {
              content: makePlanContent({ decisionPoints: [], openQuestions: [] }),
            }),
          ],
        }),
        [1],
      ),
    );
    expect(screen.queryByText(/Still to decide|Decision points/)).toBeNull();
  });
});

describe('decision points', () => {
  const group = () => screen.getByRole('radiogroup', { name: 'Which eviction policy?' });

  it('shows option cards with description and a Recommended tag', () => {
    renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    const lru = within(group()).getByRole('radio', { name: 'LRU' });
    expect(lru.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(group()).getByText('Least recently used')).toBeTruthy();
    expect(within(group()).getAllByText('Recommended')).toHaveLength(1);
    expect(within(group()).queryByText('Your choice')).toBeNull();
  });

  it('posts the chosen option id', () => {
    const { host } = renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    fireEvent.click(within(group()).getByRole('radio', { name: 'TTL' }));
    expect(host.postedOf('plan.decide')).toEqual([
      {
        type: 'plan.decide',
        planId: PLAN,
        targetId: 'eviction',
        kind: 'decision-point',
        values: ['ttl'],
      },
    ]);
  });

  it('shows the recorded choice as Your choice, and it can be changed', () => {
    const { init, host } = renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    init(
      chat(
        makePlanDoc({
          decisions: [decision({ targetId: 'eviction', kind: 'decision-point', values: ['ttl'] })],
        }),
        [1],
      ),
      1,
    );
    expect(within(group()).getByRole<HTMLInputElement>('radio', { name: 'TTL' }).checked).toBe(
      true,
    );
    const chosen = within(group()).getByText('Your choice');
    expect(chosen.closest('label')?.textContent).toContain('TTL');
    expect(
      within(group()).getByRole('radio', { name: 'TTL' }).getAttribute('aria-describedby'),
    ).toContain(chosen.id);
    fireEvent.click(within(group()).getByRole('radio', { name: 'LRU' }));
    expect(host.postedOf('plan.decide')[0]?.values).toEqual(['lru']);
  });

  it('uses the newest answer when several are recorded', () => {
    renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({
          decisions: [
            decision({
              targetId: 'eviction',
              kind: 'decision-point',
              values: ['ttl'],
              decidedAt: 5,
            }),
            decision({
              targetId: 'eviction',
              kind: 'decision-point',
              values: ['lru'],
              decidedAt: 9,
            }),
          ],
        }),
        [1],
      ),
    );
    expect(within(group()).getByRole<HTMLInputElement>('radio', { name: 'LRU' }).checked).toBe(
      true,
    );
  });

  it('does not mix up a decision point and an open question with the same id', () => {
    renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({
          decisions: [decision({ targetId: 'eviction', kind: 'open-question', values: ['lru'] })],
        }),
        [1],
      ),
    );
    expect(within(group()).getByRole<HTMLInputElement>('radio', { name: 'LRU' }).checked).toBe(
      false,
    );
  });
});

describe('open questions', () => {
  it('single choice posts the option id', () => {
    const { host } = renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    const group = screen.getByRole('radiogroup', { name: 'How big can the cache be?' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Large' }));
    expect(host.postedOf('plan.decide')).toEqual([
      {
        type: 'plan.decide',
        planId: PLAN,
        targetId: 'size',
        kind: 'open-question',
        values: ['large'],
      },
    ]);
  });

  it('multiple choice posts the ticked options in option order after Save', () => {
    const { host } = renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    const group = screen.getByRole('group', { name: 'Which keys are cached?' });
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save answer: Which keys are cached?',
    });
    expect(save.disabled).toBe(true);
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Repo' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'User' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Org' }));
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Org' }));
    expect(host.postedOf('plan.decide')).toEqual([]);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(host.postedOf('plan.decide')).toEqual([
      {
        type: 'plan.decide',
        planId: PLAN,
        targetId: 'keys',
        kind: 'open-question',
        values: ['user', 'repo'],
      },
    ]);
  });

  it('text posts the trimmed text after Save, and not an empty one', () => {
    const { host } = renderWithHost(<MessageList />, chat(makePlanDoc(), [1]));
    const field = screen.getByRole('textbox', { name: 'Your answer to: Anything else?' });
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Save answer: Anything else?',
    });
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '   ' } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '  Mind the memory.  ' } });
    fireEvent.click(save);
    expect(host.postedOf('plan.decide')).toEqual([
      {
        type: 'plan.decide',
        planId: PLAN,
        targetId: 'notes',
        kind: 'open-question',
        values: ['Mind the memory.'],
      },
    ]);
  });

  it('shows the recorded answers and when they were given, and they can be changed', () => {
    const { host } = renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({
          decisions: [
            decision({
              targetId: 'size',
              kind: 'open-question',
              values: ['small'],
              decidedAt: 1_700_000_300_000,
            }),
            decision({ targetId: 'keys', kind: 'open-question', values: ['org', 'repo'] }),
            decision({ targetId: 'notes', kind: 'open-question', values: ['Mind the memory.'] }),
          ],
        }),
        [1],
      ),
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Small' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Org' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'User' }).checked).toBe(false);
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your answer to: Anything else?' })
        .value,
    ).toBe('Mind the memory.');
    expect(document.querySelectorAll('.plan-recorded')).toHaveLength(3);
    expect(
      within(current()).getAllByText(`Answered ${formatTime(1_700_000_300_000)}`),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    expect(host.postedOf('plan.decide')[0]?.values).toEqual(['large']);
  });
});

describe('Approve and Execute', () => {
  it('posts the latest version and its content hash', () => {
    const { host } = renderWithHost(<MessageList />, chat(twoVersions(), [2]));
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toEqual([
      { type: 'plan.approve', planId: PLAN, version: 2, contentHash: 'hash-v2' },
    ]);
  });

  it('is disabled with a hint while a turn runs, and posts nothing', () => {
    const { host } = renderWithHost(
      <MessageList />,
      chat(makePlanDoc(), [1], { turns: [makeTurn({ status: 'running' })] }),
    );
    expect(approve().disabled).toBe(true);
    expect(describedBy(approve())).toContain('Wait for the current turn to finish.');
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toEqual([]);
  });

  it('is disabled with a hint while a turn is preparing', () => {
    renderWithHost(
      <MessageList />,
      chat(makePlanDoc(), [1], { turns: [makeTurn({ status: 'preparing' })] }),
    );
    expect(approve().disabled).toBe(true);
  });

  it('is disabled with a hint while configuration changes are pending', () => {
    const { host } = renderWithHost(
      <MessageList />,
      chat(makePlanDoc({ decisions: answeredAll }), [1], { turns: [makeTurn()] }, 1),
    );
    expect(approve().disabled).toBe(true);
    expect(describedBy(approve())).toEqual([
      'Keep or revert the configuration changes in the changes card below the chat first.',
    ]);
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toEqual([]);
  });

  it('is disabled with a hint while an Agent turn of another conversation holds the folder', () => {
    const { host } = renderWithHost(<MessageList />, {
      ...chat(makePlanDoc({ decisions: answeredAll }), [1], { turns: [makeTurn()] }),
      review: { entries: [], configChanges: [], busy: true },
    });
    expect(approve().disabled).toBe(true);
    expect(describedBy(approve())).toEqual(['Another agent turn is running in this folder.']);
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toEqual([]);
  });

  it('shows only the running hint while this conversation runs, even with the folder busy', () => {
    renderWithHost(<MessageList />, {
      ...chat(makePlanDoc({ decisions: answeredAll }), [1], {
        turns: [makeTurn({ status: 'running' })],
      }),
      review: { entries: [], configChanges: [], busy: true },
    });
    expect(approve().disabled).toBe(true);
    expect(describedBy(approve())).toEqual(['Wait for the current turn to finish.']);
    expect(screen.queryByText('Another agent turn is running in this folder.')).toBeNull();
  });

  it('gives both reasons when both apply', () => {
    renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({ decisions: answeredAll }),
        [1],
        { turns: [makeTurn({ status: 'running' })] },
        2,
      ),
    );
    expect(describedBy(approve())).toEqual([
      'Wait for the current turn to finish.',
      'Keep or revert the configuration changes in the changes card below the chat first.',
    ]);
  });

  it('is enabled and has no hint when the last turn is over and nothing is pending', () => {
    const { init } = renderWithHost(
      <MessageList />,
      chat(makePlanDoc({ decisions: answeredAll }), [1], { turns: [makeTurn()] }),
    );
    expect(approve().disabled).toBe(false);
    expect(approve().getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByText(/have no answer yet|has no answer yet/)).toBeNull();
    // It follows the state when a turn starts and when it ends.
    init(
      chat(makePlanDoc({ decisions: answeredAll }), [1], {
        turns: [makeTurn({ status: 'running' })],
      }),
      1,
    );
    expect(approve().disabled).toBe(true);
    init(chat(makePlanDoc({ decisions: answeredAll }), [1], { turns: [makeTurn()] }), 2);
    expect(approve().disabled).toBe(false);
  });

  it('warns about unanswered questions and decisions but stays enabled', () => {
    const { host } = renderWithHost(
      <MessageList />,
      chat(makePlanDoc({ decisions: [answeredAll[0] as PlanUserDecision] }), [1]),
    );
    const warning = screen.getByText('3 questions or decisions have no answer yet');
    expect(approve().disabled).toBe(false);
    expect(approve().getAttribute('aria-describedby')).toContain(warning.closest('p')?.id ?? '?');
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toHaveLength(1);
  });

  it('says "1 question or decision has no answer yet" for one', () => {
    renderWithHost(<MessageList />, chat(makePlanDoc({ decisions: answeredAll.slice(0, 3) }), [1]));
    expect(screen.getByText('1 question or decision has no answer yet')).toBeTruthy();
  });

  it('lists the approvals recorded for the latest version only', () => {
    renderWithHost(
      <MessageList />,
      chat(
        makePlanDoc({
          versions: [makePlanVersion(1), makePlanVersion(2)],
          approvals: [
            { version: 2, contentHash: 'hash-v2', approvedAt: 1_700_000_900_000 },
            { version: 2, contentHash: 'hash-v2', approvedAt: 1_700_001_000_000 },
            { version: 1, contentHash: 'hash-v1', approvedAt: 1_600_000_000_000 },
          ],
        }),
        [2],
      ),
    );
    expect(screen.getAllByText(/^Approved on /).map((li) => li.textContent)).toEqual([
      `Approved on ${formatTime(1_700_000_900_000)}`,
      `Approved on ${formatTime(1_700_001_000_000)}`,
    ]);
  });
});

describe('the current rule', () => {
  it('makes the part with the highest version the current card, with two parts', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), [1, 2]));
    expect(document.querySelectorAll('.plan-card')).toHaveLength(2);
    expect(document.querySelectorAll('.plan-card--current')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Approve and Execute' })).toHaveLength(1);
    const [first, second] = Array.from(document.querySelectorAll('.plan-card'));
    expect(first?.classList.contains('plan-card--older')).toBe(true);
    expect(second?.classList.contains('plan-card--current')).toBe(true);
    expect(
      within(current()).getByRole('button', { name: 'New title, open version 2' }),
    ).toBeTruthy();
  });

  it('keeps one current card and two older ones with three parts', () => {
    renderWithHost(<MessageList />, chat(threeVersions(), [1, 2, 3]));
    expect(document.querySelectorAll('.plan-card--older')).toHaveLength(2);
    expect(document.querySelectorAll('.plan-card--current')).toHaveLength(1);
    expect(within(current()).getByText('Version 3')).toBeTruthy();
  });

  it('does not depend on the order of the messages', () => {
    renderWithHost(<MessageList />, chat(threeVersions(), [3, 1, 2]));
    expect(within(current()).getByText('Version 3')).toBeTruthy();
    expect(document.querySelectorAll('.plan-card--older')).toHaveLength(2);
  });

  it('turns the current card into an older one when a newer part arrives', () => {
    const { init } = renderWithHost(<MessageList />, chat(twoVersions(), [1, 2]));
    init(chat(threeVersions(), [1, 2, 3]), 1);
    expect(document.querySelectorAll('.plan-card--older')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Approve and Execute' })).toHaveLength(1);
    expect(within(current()).getByText('Version 3')).toBeTruthy();
  });

  it('acts on the latest version after the user reverted, when the latest has no part', () => {
    // Version 3 is a copy of version 1 made by the user: no message mentions it.
    const doc = makePlanDoc({
      versions: [
        makePlanVersion(1, { content: makePlanContent({ title: 'Title one' }) }),
        makePlanVersion(2, { content: makePlanContent({ title: 'Title two' }) }),
        makePlanVersion(3, {
          author: 'user',
          restoredFrom: 1,
          contentHash: 'hash-v1',
          content: makePlanContent({ title: 'Title one' }),
        }),
      ],
    });
    const { host } = renderWithHost(<MessageList />, chat(doc, [1, 2]));
    // The card of part 2 is the current one and shows and acts on version 3.
    const card = current();
    expect(within(card).getByText('Version 3, restored by you from version 1')).toBeTruthy();
    expect(document.querySelectorAll('.plan-card')).toHaveLength(2);
    fireEvent.click(within(card).getByRole('button', { name: 'Title one, open version 3' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Approve and Execute' }));
    fireEvent.click(within(card).getByRole('button', { name: /^View changes/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Revert to version 2' }));
    expect(host.postedOf('plan.open')).toEqual([{ type: 'plan.open', planId: PLAN, version: 3 }]);
    expect(host.postedOf('plan.approve')).toEqual([
      { type: 'plan.approve', planId: PLAN, version: 3, contentHash: 'hash-v1' },
    ]);
    expect(host.postedOf('plan.compare')).toEqual([
      { type: 'plan.compare', planId: PLAN, left: 2, right: 3 },
    ]);
    expect(host.postedOf('plan.revert')).toEqual([
      { type: 'plan.revert', planId: PLAN, version: 2 },
    ]);
  });

  it('shows a part of another plan as the one-line stand-in', () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          plan: makePlanDoc(),
          messages: [assistantMessage('a1', [part(2, planId('other'))])],
        }),
      }),
    );
    expect(screen.getByText('Plan updated to version 2')).toBeTruthy();
    expect(document.querySelector('.part-line button')).toBeNull();
  });

  it('shows just the line when the plan is not in the state', () => {
    renderWithHost(<MessageList />, chat(null, [2]));
    expect(screen.getByText('Plan updated to version 2')).toBeTruthy();
    expect(document.querySelector('.plan-card')).toBeNull();
  });
});

describe('older cards', () => {
  const olderCards = () => Array.from(document.querySelectorAll<HTMLElement>('.plan-card--older'));

  it('are compact and read-only: a label, the title, View changes and Restore', () => {
    const { host } = renderWithHost(<MessageList />, chat(threeVersions(), [1, 2, 3]));
    const [one, two] = olderCards() as [HTMLElement, HTMLElement];
    expect(one.getAttribute('aria-label')).toBe('Plan version 1');
    expect(within(one).getByText('Plan version 1')).toBeTruthy();
    expect(within(two).getByText('Plan version 2')).toBeTruthy();
    for (const card of [one, two]) {
      expect(within(card).queryByRole('button', { name: 'Approve and Execute' })).toBeNull();
      expect(card.querySelector('input, textarea')).toBeNull();
      expect(within(card).queryByText(/^Revert to version/)).toBeNull();
    }

    fireEvent.click(within(two).getByRole('button', { name: 'Title two, open version 2' }));
    fireEvent.click(within(two).getByRole('button', { name: /^View changes/ }));
    fireEvent.click(within(two).getByRole('button', { name: /^Restore this version/ }));
    expect(host.postedOf('plan.open')).toEqual([{ type: 'plan.open', planId: PLAN, version: 2 }]);
    expect(host.postedOf('plan.compare')).toEqual([
      { type: 'plan.compare', planId: PLAN, left: 1, right: 2 },
    ]);
    expect(host.postedOf('plan.revert')).toEqual([
      { type: 'plan.revert', planId: PLAN, version: 2 },
    ]);
  });

  it('has no View changes for version 1', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), [1, 2]));
    const [one] = olderCards() as [HTMLElement];
    expect(within(one).queryByRole('button', { name: /^View changes/ })).toBeNull();
    expect(within(one).getByRole('button', { name: /^Restore this version/ })).toBeTruthy();
  });

  it('hides Restore this version when its content equals the latest', () => {
    const doc = makePlanDoc({
      versions: [
        makePlanVersion(1, { contentHash: 'same' }),
        makePlanVersion(2, { contentHash: 'other' }),
        makePlanVersion(3, { contentHash: 'same', restoredFrom: 1 }),
      ],
    });
    renderWithHost(<MessageList />, chat(doc, [1, 2, 3]));
    const [one, two] = olderCards() as [HTMLElement, HTMLElement];
    expect(within(one).queryByRole('button', { name: /^Restore/ })).toBeNull();
    expect(within(two).getByRole('button', { name: /^Restore this version/ })).toBeTruthy();
  });

  it('shows just the line for a version the plan does not have', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), [7, 8]));
    // Part 7 is older and its version is not in the plan; part 8 is the current card.
    expect(screen.getAllByText(/^Plan updated to version/).map((el) => el.textContent)).toEqual([
      'Plan updated to version 7',
    ]);
    expect(olderCards()).toHaveLength(0);
    expect(document.querySelectorAll('.plan-card--current')).toHaveLength(1);
  });
});

describe('the synthetic card', () => {
  it('ends the log with one current card when no message has a part for the plan', () => {
    renderWithHost(
      <MessageList />,
      chat(twoVersions(), [], {
        messages: [userMessage('u0', 'plan it', { mode: 'plan' }), assistantMessage('a1', [])],
      }),
    );
    expect(document.querySelectorAll('.plan-card')).toHaveLength(1);
    expect(current().classList.contains('plan-card--current')).toBe(true);
    expect(within(current()).getByText('Version 2')).toBeTruthy();
    const column = current().parentElement as HTMLElement;
    expect(column.lastElementChild).toBe(current());
    expect(current().previousElementSibling?.tagName).toBe('ARTICLE');
  });

  it('is placed after the last message and before the failure notice', () => {
    renderWithHost(
      <MessageList />,
      chat(twoVersions(), [], {
        messages: [userMessage('u0', 'plan it')],
        turns: [makeTurn({ status: 'error', error: 'It broke.' })],
      }),
    );
    const column = current().parentElement as HTMLElement;
    const kids = Array.from(column.children);
    expect(kids.indexOf(current())).toBeLessThan(kids.findIndex((k) => k.matches('.notice')));
  });

  it('acts like the current card', () => {
    const { host } = renderWithHost(<MessageList />, chat(twoVersions(), []));
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toEqual([
      { type: 'plan.approve', planId: PLAN, version: 2, contentHash: 'hash-v2' },
    ]);
  });

  it('is not drawn once a message has a plan-update part for the plan', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), [1]));
    expect(document.querySelectorAll('.plan-card')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Approve and Execute' })).toHaveLength(1);
  });

  it('is drawn when the only parts belong to another plan', () => {
    renderWithHost(
      <MessageList />,
      makeState({
        active: makeActive('c1', {
          plan: makePlanDoc(),
          messages: [assistantMessage('a1', [part(1, planId('other'))])],
        }),
      }),
    );
    expect(document.querySelectorAll('.plan-card--current')).toHaveLength(1);
  });

  it('is not drawn without a plan', () => {
    renderWithHost(<MessageList />, chat(null, []));
    expect(document.querySelector('.plan-card')).toBeNull();
  });

  it('appears when a plan arrives for a conversation without parts, and goes with the plan', () => {
    const { init } = renderWithHost(<MessageList />, chat(null, []));
    init(chat(makePlanDoc(), []), 1);
    expect(document.querySelectorAll('.plan-card--current')).toHaveLength(1);
    init(chat(null, []), 2);
    expect(document.querySelector('.plan-card')).toBeNull();
  });
});

describe('plan card accessibility', () => {
  it('names every control and group of a card with questions', () => {
    renderWithHost(<MessageList />, chat(twoVersions(), [1, 2], {}, 1));
    const nameOf = (el: HTMLElement) => {
      const label = el.getAttribute('aria-label');
      if (label) return label;
      const by = el.getAttribute('aria-labelledby');
      if (by) {
        return by
          .split(' ')
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
      }
      return el.closest('label')?.textContent ?? el.textContent ?? '';
    };
    for (const el of document.querySelectorAll<HTMLElement>(
      '.plan-card button, .plan-card input, .plan-card textarea',
    )) {
      expect(nameOf(el).trim(), el.outerHTML).not.toBe('');
    }
    for (const group of document.querySelectorAll(
      '.plan-card [role="group"], .plan-card section',
    )) {
      expect(
        group.getAttribute('aria-labelledby') ?? group.getAttribute('aria-label'),
      ).toBeTruthy();
    }
    for (const group of screen.getAllByRole('radiogroup')) {
      expect(group.getAttribute('aria-labelledby')).toBeTruthy();
    }
  });

  it('says what each button of an older card acts on', () => {
    renderWithHost(<MessageList />, chat(threeVersions(), [1, 2, 3]));
    expect(
      screen.getAllByRole('button', { name: 'View changes between version 1 and 2' }),
    ).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: 'Restore this version (version 2)' }),
    ).toHaveLength(1);
  });

  it('says which version each title button opens', () => {
    renderWithHost(<MessageList />, chat(threeVersions(), [1, 2, 3]));
    const names = Array.from(
      document.querySelectorAll<HTMLElement>('.plan-card-open'),
      (el) => el.textContent,
    );
    expect(names).toEqual([
      'Title one, open version 1',
      'Title two, open version 2',
      'Title three, open version 3',
    ]);
    const one = document.querySelector('.plan-card--older') as HTMLElement;
    expect(within(one).getByRole('button', { name: 'Title one, open version 1' })).toBeTruthy();
    expect(
      within(current()).getByRole('button', { name: 'Title three, open version 3' }),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Title three' })).toBe(current());
  });

  it('starts headings at level 2 and does not skip a level', () => {
    renderWithHost(
      <MessageList />,
      chat(makePlanDoc({ decisions: [answeredAll[0] as PlanUserDecision] }), [1]),
    );
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
    expect(levels).toEqual([2, 3, 3]);
  });
});
