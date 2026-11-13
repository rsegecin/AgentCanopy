// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ConfigChange, Hunk, ReviewEntry, ViewState } from '../../../shared';
import { App } from '../../app/App';
import {
  makeActive,
  makeConfigChange,
  makeHunk,
  makeReviewEntry,
  makeState,
  makeTurn,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { ReviewView } from './ReviewView';
import { HUNK_MAX_LINES } from './review-model';

function stateWith(
  entries: ReviewEntry[],
  extra: {
    hunks?: Record<string, Hunk[]>;
    configChanges?: ConfigChange[];
    baseline?: ViewState['baseline'];
    running?: boolean;
  } = {},
): ViewState {
  return makeState({
    review: {
      entries,
      hunks: extra.hunks ?? {},
      configChanges: extra.configChanges ?? [],
    },
    ...(extra.baseline ? { baseline: extra.baseline } : {}),
    ...(extra.running
      ? { active: makeActive('c1', { turns: [makeTurn({ status: 'running' })] }) }
      : {}),
  });
}

const renderReview = (entries: ReviewEntry[], extra: Parameters<typeof stateWith>[1] = {}) =>
  renderWithHost(<ReviewView />, stateWith(entries, extra));

const A = () => makeReviewEntry('src/a.ts');
const region = (name: string | RegExp) => screen.getByRole('region', { name });

describe('Review tab', () => {
  const tab = (name: string | RegExp) => screen.queryByRole('tab', { name });
  const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);

  it('is hidden without entries or configuration changes', () => {
    renderWithHost(<App />, stateWith([]));
    expect(tabNames()).toEqual(['Chat', 'History']);
  });

  it('appears with an entry, and carries the pending count with an accessible name', () => {
    renderWithHost(
      <App />,
      stateWith([A(), makeReviewEntry('b.ts'), makeReviewEntry('c.ts', { status: 'accepted' })]),
    );
    const review = tab('Review, 2 pending');
    expect(review).not.toBeNull();
    expect(review?.querySelector('.tab-badge')?.textContent).toBe('2');
    expect(tabNames()).toEqual(['Chat', 'Review2Review, 2 pending', 'History']);
  });

  it('has no badge, and the plain name, when nothing is pending', () => {
    renderWithHost(<App />, stateWith([makeReviewEntry('c.ts', { status: 'accepted' })]));
    expect(tab('Review')?.querySelector('.tab-badge')).toBeNull();
  });

  it('appears for a configuration change alone', () => {
    renderWithHost(<App />, stateWith([], { configChanges: [makeConfigChange('k1')] }));
    expect(tab('Review')).not.toBeNull();
  });

  it('shows the view when selected', () => {
    renderWithHost(<App />, stateWith([A()]));
    fireEvent.click(tab('Review, 1 pending') as HTMLElement);
    expect(screen.getByRole('region', { name: /Agent changes/ })).toBeTruthy();
    expect(tab('Review, 1 pending')?.getAttribute('aria-selected')).toBe('true');
  });

  it('switches with show-tab', () => {
    const { host } = renderWithHost(<App />, stateWith([A()]));
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'review' } });
    expect(tab('Review, 1 pending')?.getAttribute('aria-selected')).toBe('true');
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'chat' } });
    expect(tab('Chat')?.getAttribute('aria-selected')).toBe('true');
  });

  it('falls back to Chat when everything is gone while Review is selected', () => {
    const { init } = renderWithHost(<App />, stateWith([A()]));
    fireEvent.click(tab('Review, 1 pending') as HTMLElement);
    init(stateWith([]), 1);
    expect(tab('Chat')?.getAttribute('aria-selected')).toBe('true');
    expect(tab('Review')).toBeNull();
  });

  it('follows the host as the pending count changes', () => {
    const { init } = renderWithHost(<App />, stateWith([A()]));
    init(stateWith([A(), makeReviewEntry('b.ts')]), 1);
    expect(tab('Review, 2 pending')).not.toBeNull();
  });
});

describe('header indicator for configuration changes', () => {
  const indicator = () =>
    screen.queryByRole('button', { name: /configuration change.* your decision/ });

  it('is absent without configuration changes', () => {
    renderWithHost(<App />, stateWith([A()]));
    expect(indicator()).toBeNull();
  });

  it('is shown next to the tabs and switches to Review', () => {
    const { services } = renderWithHost(
      <App />,
      stateWith([], { configChanges: [makeConfigChange('k1'), makeConfigChange('k2')] }),
    );
    const button = indicator() as HTMLElement;
    expect(button.getAttribute('aria-label')).toMatch(
      /^2 configuration changes need your decision/,
    );
    expect(button.previousElementSibling).toBe(screen.getByRole('tablist'));
    fireEvent.click(button);
    expect(services.ui.getSnapshot().tab).toBe('review');
    expect(screen.getByRole('tab', { name: 'Review' }).getAttribute('aria-selected')).toBe('true');
  });

  it('uses the singular for one change', () => {
    renderWithHost(<App />, stateWith([], { configChanges: [makeConfigChange('k1')] }));
    expect(indicator()?.getAttribute('aria-label')).toMatch(/^1 configuration change needs/);
  });
});

describe('entry rows', () => {
  const rowOf = (path: string) =>
    screen.getByRole('button', { name: `Open diff of ${path}` }).closest('li') as HTMLElement;

  it.each([
    ['created', 'Added'],
    ['modified', 'Modified'],
    ['deleted', 'Deleted'],
    ['mode', 'Permissions'],
    ['type', 'Type changed'],
  ] as const)('marks a %s entry with the text %s', (changeType, label) => {
    renderReview([makeReviewEntry('src/x.ts', { changeType })]);
    const marker = rowOf('src/x.ts').querySelector('.review-marker');
    expect(marker?.textContent).toBe(label);
    expect(marker?.querySelector('.codicon')).not.toBeNull();
  });

  it('shows the path, line counts and the three actions for a plain entry', () => {
    renderReview([makeReviewEntry('src/a.ts', { linesAdded: 12, linesRemoved: 3 })]);
    const row = rowOf('src/a.ts');
    expect(within(row).getByText('src/a.ts')).toBeTruthy();
    expect(within(row).getByText('+12 −3')).toBeTruthy();
    expect(row.textContent).toContain('12 lines added, 3 lines removed');
    expect(within(row).getByRole('button', { name: 'Accept src/a.ts' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Reject src/a.ts' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Diff src/a.ts' })).toBeTruthy();
    expect(within(row).queryByText('Includes your edits')).toBeNull();
    expect(within(row).queryByText('Cannot be restored')).toBeNull();
  });

  it('shows only the counts that are known', () => {
    renderReview([
      makeReviewEntry('a.ts', { linesAdded: 4 }),
      makeReviewEntry('b.ts', { linesRemoved: 2 }),
      makeReviewEntry('c.ts'),
    ]);
    expect(within(rowOf('a.ts')).getByText('+4')).toBeTruthy();
    expect(within(rowOf('b.ts')).getByText('−2')).toBeTruthy();
    expect(rowOf('c.ts').querySelector('.review-counts')).toBeNull();
  });

  it('shows where a renamed file came from', () => {
    renderReview([
      makeReviewEntry('src/new.ts', { changeType: 'created', renamedFrom: 'src/old.ts' }),
    ]);
    expect(within(rowOf('src/new.ts')).getByText('renamed from src/old.ts')).toBeTruthy();
  });

  it('shows Includes your edits', () => {
    renderReview([makeReviewEntry('a.ts', { includesUserEdits: true })]);
    expect(within(rowOf('a.ts')).getByText('Includes your edits')).toBeTruthy();
  });

  it('shows Cannot be restored with its note as the description, and disables Reject', () => {
    renderReview([
      makeReviewEntry('big.bin', {
        restorable: false,
        note: 'The earlier content was too large to keep.',
      }),
    ]);
    const row = rowOf('big.bin');
    const badge = within(row).getByText('Cannot be restored').closest('.badge') as HTMLElement;
    const note = document.getElementById(badge.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe('The earlier content was too large to keep.');
    const reject = within(row).getByRole<HTMLButtonElement>('button', { name: 'Reject big.bin' });
    expect(reject.disabled).toBe(true);
    expect(
      within(row).getByRole<HTMLButtonElement>('button', { name: 'Accept big.bin' }).disabled,
    ).toBe(false);
  });

  it('keeps Reject enabled for a restorable entry that has a note', () => {
    renderReview([makeReviewEntry('a.ts', { note: 'Please look at this.' })]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject a.ts' }).disabled).toBe(
      false,
    );
    expect(screen.getByText('Please look at this.')).toBeTruthy();
  });

  it('posts the right message with the right path from each button', () => {
    const { host } = renderReview([makeReviewEntry('src/a.ts'), makeReviewEntry('src/b.ts')]);
    fireEvent.click(screen.getByRole('button', { name: 'Accept src/b.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Diff src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open diff of src/b.ts' }));
    expect(host.posted.filter((m) => m.type !== 'ready')).toEqual([
      { type: 'review.acceptFile', path: 'src/b.ts' },
      { type: 'review.rejectFile', path: 'src/a.ts' },
      { type: 'review.openDiff', path: 'src/a.ts' },
      { type: 'review.openDiff', path: 'src/b.ts' },
    ]);
  });
});

describe('groups', () => {
  it('splits pending entries by attribution, with the explanations', () => {
    renderReview([
      makeReviewEntry('tool.ts', { attribution: 'agent-tool' }),
      makeReviewEntry('cmd.ts', { attribution: 'agent-command' }),
      makeReviewEntry('mixed.ts', { attribution: 'mixed' }),
      makeReviewEntry('un.ts', { attribution: 'unattributed' }),
      makeReviewEntry('int.ts', { attribution: 'after-interruption' }),
    ]);
    const agent = region(/^Agent changes/);
    expect(
      within(agent)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('.review-path')?.textContent),
    ).toEqual(['tool.ts', 'cmd.ts']);
    const uncertain = region(/^Changed during a turn, source uncertain/);
    const rows = within(uncertain).getAllByRole('listitem');
    expect(rows.map((li) => li.querySelector('.review-path')?.textContent)).toEqual([
      'mixed.ts',
      'un.ts',
      'int.ts',
    ]);
    expect(rows[0]?.textContent).toContain('Both you and the agent changed this file');
    expect(rows[1]?.textContent).toContain(
      'Changed while the agent was working, but not by one of its tool calls',
    );
    expect(rows[2]?.textContent).toContain('Changed around an interrupted turn');
    expect(within(agent).queryByText('Include in Reject All')).toBeNull();
  });

  it('puts user and external changes in the uncertain group too', () => {
    renderReview([
      makeReviewEntry('u.ts', { attribution: 'user' }),
      makeReviewEntry('e.ts', { attribution: 'external' }),
    ]);
    expect(within(region(/source uncertain/)).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: /^Agent changes/ })).toBeNull();
  });

  it('names the groups with headings and counts', () => {
    renderReview([A(), makeReviewEntry('m.ts', { attribution: 'mixed' })]);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Agent changes 1',
      'Changed during a turn, source uncertain 1',
    ]);
  });

  it('shows the accepted group collapsed, with marked rows and no actions', () => {
    const { services } = renderReview([
      A(),
      makeReviewEntry('done.ts', { status: 'accepted', linesAdded: 1 }),
    ]);
    const toggle = screen.getByRole('button', { name: /^Accepted/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('done.ts')).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const row = screen
      .getByRole('button', { name: 'Open diff of done.ts' })
      .closest('li') as HTMLElement;
    expect(within(row).getByText('Accepted')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Accept done.ts' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Reject done.ts' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Diff done.ts' })).toBeNull();
    expect(services.ui.getSnapshot().expanded['review:accepted']).toBe(true);
    // Pending rows are not marked accepted.
    expect(within(region(/^Agent changes/)).queryByText('Accepted')).toBeNull();
  });

  it('does not count accepted entries as pending', () => {
    renderReview([makeReviewEntry('done.ts', { status: 'accepted' })]);
    expect(screen.getByText('No pending changes')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept All' })).toBeNull();
  });
});

describe('toolbar', () => {
  it('summarises pending changes and files', () => {
    renderReview([
      A(),
      makeReviewEntry('b.ts', { attribution: 'mixed' }),
      makeReviewEntry('new.ts', { changeType: 'created', renamedFrom: 'old.ts' }),
      makeReviewEntry('done.ts', { status: 'accepted' }),
    ]);
    expect(screen.getByText('3 pending changes in 4 files')).toBeTruthy();
  });

  it('uses the singular', () => {
    renderReview([A()]);
    expect(screen.getByText('1 pending change in 1 file')).toBeTruthy();
  });

  it('posts Accept All and Open All in Diff Editor', () => {
    const { host } = renderReview([A()]);
    fireEvent.click(screen.getByRole('button', { name: 'Accept All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open All in Diff Editor' }));
    expect(host.posted.filter((m) => m.type !== 'ready')).toEqual([
      { type: 'review.acceptAll' },
      { type: 'review.openAll' },
    ]);
  });

  it('posts Reject All with no paths by default', () => {
    const { host } = renderReview([A(), makeReviewEntry('m.ts', { attribution: 'mixed' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(host.postedOf('review.rejectAll')).toEqual([
      { type: 'review.rejectAll', includePaths: [] },
    ]);
  });

  it('feeds the ticked uncertain entries to Reject All', () => {
    const { host } = renderReview([
      A(),
      makeReviewEntry('m.ts', { attribution: 'mixed' }),
      makeReviewEntry('u.ts', { attribution: 'unattributed' }),
      makeReviewEntry('i.ts', { attribution: 'after-interruption' }),
    ]);
    const box = (path: string) =>
      screen.getByRole<HTMLInputElement>('checkbox', { name: `Include in Reject All: ${path}` });
    expect(box('m.ts').checked).toBe(false);
    fireEvent.click(box('i.ts'));
    fireEvent.click(box('m.ts'));
    fireEvent.click(box('u.ts'));
    fireEvent.click(box('u.ts'));
    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(host.postedOf('review.rejectAll')).toEqual([
      { type: 'review.rejectAll', includePaths: ['m.ts', 'i.ts'] },
    ]);
  });

  it('keeps the ticks across a reload, and ignores entries that are no longer pending', () => {
    const entries = [makeReviewEntry('m.ts', { attribution: 'mixed' })];
    const first = renderReview(entries);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include in Reject All: m.ts' }));
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    const second = renderWithHost(<ReviewView />, stateWith(entries), saved);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /m\.ts/ }).checked).toBe(true);
    second.init(stateWith([A()]), 1);
    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(second.host.postedOf('review.rejectAll')).toEqual([
      { type: 'review.rejectAll', includePaths: [] },
    ]);
  });

  it('disables accepting and rejecting while a turn runs, with the reason', () => {
    const { host } = renderReview([A(), makeReviewEntry('m.ts', { attribution: 'mixed' })], {
      running: true,
      hunks: { 'src/a.ts': [makeHunk(0)] },
    });
    const hint = screen.getByText('Wait for the turn to finish.');
    for (const name of [
      'Accept All',
      'Reject All',
      'Accept src/a.ts',
      'Reject src/a.ts',
      'Accept m.ts',
      'Reject m.ts',
    ]) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name });
      expect(button.disabled, name).toBe(true);
      expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Changes in src/a.ts' }));
    for (const name of ['Accept Change 1 in src/a.ts', 'Reject Change 1 in src/a.ts']) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true);
    }
    // Looking at diffs is still fine.
    for (const name of ['Open All in Diff Editor', 'Diff src/a.ts', 'Open diff of src/a.ts']) {
      expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(false);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Accept All' }));
    expect(host.postedOf('review.acceptAll')).toEqual([]);
  });

  it('is enabled and silent when no turn runs', () => {
    renderReview([A()]);
    expect(screen.queryByText('Wait for the turn to finish.')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Accept All' }).disabled).toBe(
      false,
    );
  });
});

describe('hunks', () => {
  const toggle = (path = 'src/a.ts') => screen.getByRole('button', { name: `Changes in ${path}` });

  it('requests the hunks once, shows Loading changes… and renders them when they arrive', () => {
    const { host, init } = renderReview([A()]);
    expect(host.postedOf('review.requestHunks')).toEqual([]);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Loading changes…')).toBeTruthy();
    expect(host.postedOf('review.requestHunks')).toEqual([
      { type: 'review.requestHunks', path: 'src/a.ts' },
    ]);
    fireEvent.click(toggle());
    fireEvent.click(toggle());
    expect(host.postedOf('review.requestHunks')).toHaveLength(1);

    init(stateWith([A()], { hunks: { 'src/a.ts': [makeHunk(0), makeHunk(1)] } }), 1);
    expect(screen.queryByText('Loading changes…')).toBeNull();
    const list = screen.getByRole('list', { name: 'Changes in src/a.ts' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('does not ask again for hunks the host already has', () => {
    const { host } = renderReview([A()], { hunks: { 'src/a.ts': [makeHunk(0)] } });
    fireEvent.click(toggle());
    expect(host.postedOf('review.requestHunks')).toEqual([]);
    expect(screen.getByRole('list', { name: 'Changes in src/a.ts' })).toBeTruthy();
  });

  it('says so when there are no line-level changes', () => {
    renderReview([A()], { hunks: { 'src/a.ts': [] } });
    fireEvent.click(toggle());
    expect(screen.getByText('No line-level changes to show')).toBeTruthy();
  });

  it('shows removed lines then added lines with signs and hidden labels, trimming CRLF', () => {
    renderReview([A()], {
      hunks: {
        'src/a.ts': [
          makeHunk(0, {
            baselineLines: ['one\r\n', 'two\r\n'],
            currentLines: ['uno\r\n', 'dos\r\n', 'tres\r\n'],
          }),
        ],
      },
    });
    fireEvent.click(toggle());
    const lines = Array.from(document.querySelectorAll('.review-hunk .diff-line'));
    expect(lines.map((l) => l.textContent)).toEqual([
      'removed -one',
      'removed -two',
      'added +uno',
      'added +dos',
      'added +tres',
    ]);
    expect(lines.some((l) => /[\r\n]/.test(l.textContent))).toBe(false);
    expect(document.querySelector('.review-no-eol')).toBeNull();
    expect(lines[0]?.querySelector('.visually-hidden')?.textContent).toBe('removed ');
    expect(lines[2]?.querySelector('.diff-sign')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('marks a line that has no final newline', () => {
    renderReview([A()], {
      hunks: { 'src/a.ts': [makeHunk(0, { baselineLines: ['last\n'], currentLines: ['last'] })] },
    });
    fireEvent.click(toggle());
    const markers = document.querySelectorAll('.review-no-eol');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.closest('.diff-line')?.classList.contains('diff-line--added')).toBe(true);
    expect(markers[0]?.textContent?.trim()).toBe('No newline at end of file');
  });

  it('cuts a hunk at 80 lines and says how many more there are', () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${String(i)}\n`);
    renderReview([A()], {
      hunks: {
        'src/a.ts': [makeHunk(0, { baselineLines: many('o', 50), currentLines: many('n', 50) })],
      },
    });
    fireEvent.click(toggle());
    expect(document.querySelectorAll('.review-hunk .diff-line')).toHaveLength(HUNK_MAX_LINES);
    expect(screen.getByText('20 more lines')).toBeTruthy();
  });

  it('shows no note for a hunk of exactly 80 lines, and the singular for one more', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `l${String(i)}\n`);
    renderReview([A(), makeReviewEntry('b.ts')], {
      hunks: {
        'src/a.ts': [makeHunk(0, { baselineLines: [], currentLines: many(80) })],
        'b.ts': [makeHunk(0, { baselineLines: [], currentLines: many(81) })],
      },
    });
    fireEvent.click(toggle());
    expect(screen.queryByText(/more line/)).toBeNull();
    fireEvent.click(toggle('b.ts'));
    expect(screen.getByText('1 more line')).toBeTruthy();
  });

  it('posts the hunk id for Accept Change and Reject Change', () => {
    const { host } = renderReview([A()], {
      hunks: { 'src/a.ts': [makeHunk(0), makeHunk(1)] },
    });
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole('button', { name: 'Accept Change 2 in src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject Change 1 in src/a.ts' }));
    expect(host.posted.filter((m) => m.type.endsWith('Hunk'))).toEqual([
      { type: 'review.acceptHunk', path: 'src/a.ts', hunkId: 'hunk-1' },
      { type: 'review.rejectHunk', path: 'src/a.ts', hunkId: 'hunk-0' },
    ]);
  });

  it('shows the hunks of an accepted entry without buttons', () => {
    renderReview([makeReviewEntry('done.ts', { status: 'accepted' })], {
      hunks: { 'done.ts': [makeHunk(0)] },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Accepted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Changes in done.ts' }));
    expect(screen.getByRole('list', { name: 'Changes in done.ts' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept Change/ })).toBeNull();
  });

  it('remembers which entries are open', () => {
    const first = renderReview([A()], { hunks: { 'src/a.ts': [makeHunk(0)] } });
    fireEvent.click(toggle());
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    renderWithHost(
      <ReviewView />,
      stateWith([A()], { hunks: { 'src/a.ts': [makeHunk(0)] } }),
      saved,
    );
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});

describe('configuration changes', () => {
  it('shows the warning and one row per change with its buttons', () => {
    const { host } = renderReview([A()], {
      configChanges: [
        makeConfigChange('k1', { displayPath: '.claude/settings.json' }),
        makeConfigChange('k2', { displayPath: '.mcp.json', changeType: 'created' }),
        makeConfigChange('k3', { displayPath: '.vscode/tasks.json', changeType: 'deleted' }),
      ],
    });
    const section = region('Configuration changes');
    expect(screen.getAllByRole('region')[0]).toBe(section);
    expect(within(section).getByRole('note').textContent).toBe(
      'The last turn changed tool or editor configuration. Such files can make later commands run without asking. Decide for each before the next Agent turn.',
    );
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Modified');
    expect(rows[1]?.textContent).toContain('Created');
    expect(rows[2]?.textContent).toContain('Deleted');

    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', {
        name: 'Show Changes to .claude/settings.json',
      }),
    );
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Keep .mcp.json' }));
    fireEvent.click(
      within(rows[2] as HTMLElement).getByRole('button', { name: 'Revert .vscode/tasks.json' }),
    );
    expect(host.posted.filter((m) => m.type !== 'ready')).toEqual([
      { type: 'config.openDiff', changeId: 'k1' },
      { type: 'config.keep', changeId: 'k2' },
      { type: 'config.revert', changeId: 'k3' },
    ]);
  });

  it('disables Revert with the reason when the earlier content was not kept', () => {
    const { host } = renderReview([], {
      configChanges: [makeConfigChange('k1', { revertible: false })],
    });
    const revert = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Revert .claude/settings.json',
    });
    expect(revert.disabled).toBe(true);
    const reason = document.getElementById(revert.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('The earlier content was not kept');
    fireEvent.click(revert);
    expect(host.postedOf('config.revert')).toEqual([]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Keep / }).disabled).toBe(false);
  });

  it('shows a configuration change even when no file changed, and no toolbar', () => {
    renderReview([], { configChanges: [makeConfigChange('k1')] });
    expect(screen.getByText('No pending changes')).toBeTruthy();
    expect(screen.queryByText('No agent changes to review.')).toBeNull();
  });

  it('is not disabled by a running turn', () => {
    renderReview([], { configChanges: [makeConfigChange('k1')], running: true });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Keep / }).disabled).toBe(false);
  });
});

describe('snapshot status', () => {
  const base = { filesDone: 0, filesTotal: 0 };

  it('shows progress while capturing', () => {
    renderReview([A()], { baseline: { state: 'capturing', filesDone: 30, filesTotal: 120 } });
    const text = document.querySelector('.review-snapshot p') as HTMLElement;
    expect(text.textContent).toBe('Preparing the workspace snapshot: 30 of 120 files');
    const bar = document.querySelector('progress');
    expect(bar?.getAttribute('max')).toBe('120');
    expect(bar?.getAttribute('value')).toBe('30');
    expect(bar?.getAttribute('aria-labelledby')).toBe(text.id);
  });

  it('shows an indeterminate bar before the file count is known', () => {
    renderReview([A()], { baseline: { state: 'capturing', ...base } });
    expect(document.querySelector('progress')?.hasAttribute('value')).toBe(false);
  });

  it('shows a warning with the note when degraded', () => {
    renderReview([A()], {
      baseline: { state: 'degraded', ...base, note: 'Some large files were skipped.' },
    });
    expect(
      screen.getByText('Some large files were skipped.').closest('[role="note"]'),
    ).not.toBeNull();
  });

  it('falls back to a general warning when degraded without a note', () => {
    renderReview([A()], { baseline: { state: 'degraded', ...base } });
    expect(screen.getByText(/snapshot is incomplete/)).toBeTruthy();
  });

  it.each(['ready', 'idle'] as const)('shows nothing when %s', (state) => {
    renderReview([A()], { baseline: { state, ...base, note: 'ignored' } });
    expect(document.querySelector('progress')).toBeNull();
    expect(screen.queryByText('ignored')).toBeNull();
    expect(document.querySelector('.review-snapshot')).toBeNull();
  });
});

describe('empty state', () => {
  it('says there is nothing to review', () => {
    renderReview([]);
    expect(screen.getByText('No agent changes to review.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('accessibility', () => {
  it('gives every button and control a name, and entry actions the path', () => {
    renderReview(
      [
        A(),
        makeReviewEntry('m.ts', { attribution: 'mixed' }),
        makeReviewEntry('done.ts', { status: 'accepted' }),
      ],
      {
        hunks: { 'src/a.ts': [makeHunk(0)] },
        configChanges: [makeConfigChange('k1', { revertible: false })],
        baseline: { state: 'capturing', filesDone: 1, filesTotal: 2 },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Changes in src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: /^Accepted/ }));
    const nameOf = (el: HTMLElement) => {
      const label = el.getAttribute('aria-label');
      if (label) return label;
      return (el.closest('label')?.textContent ?? el.textContent ?? '').trim();
    };
    const controls = document.querySelectorAll<HTMLElement>('button, input');
    expect(controls.length).toBeGreaterThan(15);
    for (const control of controls) expect(nameOf(control), control.outerHTML).not.toBe('');
    for (const path of ['src/a.ts', 'm.ts']) {
      for (const verb of ['Accept', 'Reject', 'Diff', 'Changes in', 'Open diff of']) {
        const name =
          verb === 'Changes in' || verb === 'Open diff of' ? `${verb} ${path}` : `${verb} ${path}`;
        expect(screen.getByRole('button', { name }), name).toBeTruthy();
      }
    }
    for (const button of document.querySelectorAll<HTMLElement>(
      '.review-entry-actions button, .review-hunk-actions button',
    )) {
      expect(nameOf(button)).toMatch(/[./]|\b\w+\.\w+\b/);
    }
  });

  it('makes entries list items, groups regions with headings, and the expander a labelled button', () => {
    renderReview([A()]);
    const group = region(/^Agent changes/);
    expect(within(group).getByRole('list')).toBeTruthy();
    expect(within(group).getByRole('heading', { level: 2 })).toBeTruthy();
    const expander = screen.getByRole('button', { name: 'Changes in src/a.ts' });
    expect(expander.getAttribute('aria-controls')).toBeTruthy();
    expect(expander.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the actions of an entry in reading order: expander, path, then Accept, Reject, Diff', () => {
    renderReview([A()]);
    const row = screen.getAllByRole('listitem')[0] as HTMLElement;
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Changes in src/a.ts',
      'Open diff of src/a.ts',
      'Accept src/a.ts',
      'Reject src/a.ts',
      'Diff src/a.ts',
    ]);
  });
});
