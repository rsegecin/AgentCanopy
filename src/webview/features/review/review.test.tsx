// @vitest-environment jsdom
import { Profiler } from 'react';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ConfigChange, Message, MessagePart, ReviewEntry, ViewState } from '../../../shared';
import { App } from '../../app/App';
import { Composer } from '../chat/Composer';
import { MessageList } from '../chat/MessageList';
import {
  assistantMessage,
  makeActive,
  makeChangesPart,
  makeConfigChange,
  makeReviewEntry,
  makeState,
  opId,
  turnId,
  userMessage,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { ChangesDock, SNAPSHOT_ANNOUNCE_MS } from './ChangesDock';

function stateWith(
  entries: ReviewEntry[],
  extra: {
    configChanges?: ConfigChange[];
    baseline?: ViewState['baseline'];
    busy?: boolean;
    active?: boolean;
  } = {},
): ViewState {
  return makeState({
    review: {
      entries,
      configChanges: extra.configChanges ?? [],
      busy: extra.busy ?? false,
    },
    ...(extra.baseline ? { baseline: extra.baseline } : {}),
    ...(extra.active ? { active: makeActive('c1') } : {}),
  });
}

const renderDock = (entries: ReviewEntry[], extra: Parameters<typeof stateWith>[1] = {}) =>
  renderWithHost(<ChangesDock />, stateWith(entries, extra));

const A = () => makeReviewEntry('src/a.ts');

/** An entry whose operations are `ops`; the last one owns it. */
const own = (path: string, ops: string[], over: Partial<ReviewEntry> = {}) =>
  makeReviewEntry(path, { operationIds: ops.map(opId), ...over });
const turnMessage = (id: string, ...parts: MessagePart[]) => assistantMessage(id, parts);

/** An open conversation (one user message, then `messages`) with these review entries. */
function chatState(
  messages: Message[],
  entries: ReviewEntry[],
  extra: Omit<Parameters<typeof stateWith>[1], 'active'> = {},
): ViewState {
  return {
    ...stateWith(entries, extra),
    active: makeActive('c1', { messages: [userMessage('u1', 'go'), ...messages] }),
  };
}
const renderChat = (state: ViewState) =>
  renderWithHost(
    <>
      <MessageList />
      <ChangesDock />
    </>,
    state,
  );
const cardRegions = () => screen.getAllByRole('region', { name: 'Changed files' });
const region = (name: string | RegExp) => screen.getByRole('region', { name });
const sent = (host: { posted: { type: string }[] }) =>
  host.posted.filter((m) => m.type !== 'ready');

describe('dock visibility', () => {
  it('renders nothing when there is nothing to show', () => {
    const { container } = renderDock([]);
    expect(container.innerHTML).toBe('');
  });

  it.each(['idle', 'ready'] as const)('renders nothing when the snapshot is %s', (state) => {
    const { container } = renderDock([], {
      baseline: { state, filesDone: 0, filesTotal: 0, note: 'ignored' },
    });
    expect(container.innerHTML).toBe('');
  });

  it('renders with no open conversation', () => {
    renderDock([A()]);
    expect(region('Changes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept All' })).toBeTruthy();
  });

  it('renders with an open conversation too', () => {
    renderDock([A()], { active: true });
    expect(region('Changes')).toBeTruthy();
  });

  it('renders nothing when every file is accepted: there is nothing to decide', () => {
    const { container } = renderDock([makeReviewEntry('done.ts', { status: 'accepted' })]);
    expect(container.innerHTML).toBe('');
  });

  it('appears for a configuration change alone', () => {
    renderDock([], { configChanges: [makeConfigChange('k1')] });
    expect(region('Changes')).toBeTruthy();
  });

  it.each([
    { state: 'capturing', filesDone: 1, filesTotal: 2 },
    { state: 'degraded', filesDone: 2, filesTotal: 2, note: 'Some files were skipped.' },
  ] as const)('does not appear for a snapshot that is $state alone', (baseline) => {
    const { container } = renderDock([], { baseline });
    expect(container.innerHTML).toBe('');
  });

  it('shows the snapshot status inside a card that is visible for another reason', () => {
    renderDock([A()], { baseline: { state: 'degraded', filesDone: 2, filesTotal: 2 } });
    expect(screen.getByText(/snapshot is incomplete/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Changes/ }).textContent).toContain(
      'snapshot incomplete',
    );
  });

  it('follows the host as entries come and go', () => {
    const { init, container } = renderDock([A()]);
    init(stateWith([]), 1);
    expect(container.innerHTML).toBe('');
    init(stateWith([A(), makeReviewEntry('b.ts')]), 2);
    expect(screen.getByText('2 pending changes in 2 files')).toBeTruthy();
  });
});

describe('collapsing', () => {
  const toggle = () => screen.getByRole('button', { name: /^Changes/ });

  it('is open by default, and the header collapses and expands it', () => {
    const { services } = renderDock([A()]);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Accept All' })).toBeNull();
    expect(services.ui.getSnapshot().expanded['changes-dock-collapsed']).toBe(true);
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Accept All' })).toBeTruthy();
  });

  it('points aria-controls at the collapsible region, and says in the header what is waiting', () => {
    renderDock([A(), makeReviewEntry('b.ts')], { configChanges: [makeConfigChange('k1')] });
    const region = document.getElementById(toggle().getAttribute('aria-controls') ?? '');
    expect(region?.contains(screen.getByRole('button', { name: 'Accept All' }))).toBe(true);
    expect(region?.contains(screen.getByRole('button', { name: /^Keep / }))).toBe(false);
    expect(toggle().textContent).toContain('1 configuration change');
    expect(toggle().textContent).toContain('2 pending');
  });

  it('keeps Keep and Revert when collapsed, and hides the file rows', () => {
    renderDock([A()], { configChanges: [makeConfigChange('k1')] });
    fireEvent.click(toggle());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: /^Keep / })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Revert / })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Changes details' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept All' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open diff of src/a.ts' })).toBeNull();
  });

  it('has no toggle when there is nothing to collapse', () => {
    renderDock([], { configChanges: [makeConfigChange('k1')] });
    expect(screen.queryByRole('button', { name: /^Changes/ })).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toContain(
      'Changes1 configuration change',
    );
    expect(screen.getByRole('button', { name: /^Keep / })).toBeTruthy();
  });

  it('has a toggle for files that collapses everything below the header', () => {
    renderDock([A()]);
    fireEvent.click(toggle());
    expect(screen.queryByRole('group', { name: 'Changes details' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept All' })).toBeNull();
  });

  it('remembers the collapsed state across a reload', () => {
    const first = renderDock([A()]);
    fireEvent.click(toggle());
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    renderWithHost(<ChangesDock />, stateWith([A()]), saved);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
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
    renderDock([makeReviewEntry('src/x.ts', { changeType })]);
    const marker = rowOf('src/x.ts').querySelector('.review-marker');
    expect(marker?.textContent).toBe(label);
    expect(marker?.querySelector('.codicon')).not.toBeNull();
  });

  it('shows the path, line counts, Accept and Reject, and no hunk expander', () => {
    renderDock([makeReviewEntry('src/a.ts', { linesAdded: 12, linesRemoved: 3 })]);
    const row = rowOf('src/a.ts');
    expect(within(row).getByText('src/a.ts')).toBeTruthy();
    expect(within(row).getByText('+12 −3')).toBeTruthy();
    expect(row.textContent).toContain('12 lines added, 3 lines removed');
    expect(within(row).getByRole('button', { name: 'Accept src/a.ts' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Reject src/a.ts' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Changes in src/a.ts' })).toBeNull();
    expect(row.querySelector('[aria-expanded]')).toBeNull();
    expect(within(row).queryByText('Includes your edits')).toBeNull();
    expect(within(row).queryByText('Cannot be restored')).toBeNull();
  });

  it('shows only the counts that are known', () => {
    renderDock([
      makeReviewEntry('a.ts', { linesAdded: 4 }),
      makeReviewEntry('b.ts', { linesRemoved: 2 }),
      makeReviewEntry('c.ts'),
    ]);
    expect(within(rowOf('a.ts')).getByText('+4')).toBeTruthy();
    expect(within(rowOf('b.ts')).getByText('−2')).toBeTruthy();
    expect(rowOf('c.ts').querySelector('.review-counts')).toBeNull();
  });

  it('shows where a renamed file came from', () => {
    renderDock([
      makeReviewEntry('src/new.ts', { changeType: 'created', renamedFrom: 'src/old.ts' }),
    ]);
    expect(within(rowOf('src/new.ts')).getByText('renamed from src/old.ts')).toBeTruthy();
  });

  it('shows Includes your edits', () => {
    renderDock([makeReviewEntry('a.ts', { includesUserEdits: true })]);
    expect(within(rowOf('a.ts')).getByText('Includes your edits')).toBeTruthy();
  });

  it('shows Cannot be restored with its note as the description, and disables Reject', () => {
    renderDock([
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
    renderDock([makeReviewEntry('a.ts', { note: 'Please look at this.' })]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject a.ts' }).disabled).toBe(
      false,
    );
    expect(screen.getByText('Please look at this.')).toBeTruthy();
  });

  it('posts the right message with the right path from each button', () => {
    const { host } = renderDock([makeReviewEntry('src/a.ts'), makeReviewEntry('src/b.ts')]);
    fireEvent.click(screen.getByRole('button', { name: 'Accept src/b.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject src/a.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open diff of src/b.ts' }));
    expect(sent(host)).toEqual([
      { type: 'review.acceptFile', path: 'src/b.ts' },
      { type: 'review.rejectFile', path: 'src/a.ts' },
      { type: 'review.openDiff', path: 'src/b.ts' },
    ]);
  });
});

describe('groups', () => {
  it('splits pending entries by attribution, with the explanations', () => {
    renderDock([
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
    renderDock([
      makeReviewEntry('u.ts', { attribution: 'user' }),
      makeReviewEntry('e.ts', { attribution: 'external' }),
    ]);
    expect(within(region(/source uncertain/)).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('region', { name: /^Agent changes/ })).toBeNull();
  });

  it('names the sections with headings and counts, without skipping a level', () => {
    renderDock([A(), makeReviewEntry('m.ts', { attribution: 'mixed' })], {
      configChanges: [makeConfigChange('k1')],
    });
    expect(screen.getAllByRole('heading').map((h) => [h.tagName, h.textContent?.trim()])).toEqual([
      ['H2', 'Changes1 configuration change · 2 pending'],
      ['H3', 'Configuration changes'],
      ['H3', 'Pending changes'],
      ['H4', 'Agent changes 1'],
      ['H4', 'Changed during a turn, source uncertain 1'],
    ]);
  });

  it('shows the accepted group collapsed, with marked rows and no actions', () => {
    const { services } = renderDock([
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
    expect(services.ui.getSnapshot().expanded['review:accepted']).toBe(true);
    // Pending rows are not marked accepted.
    expect(within(region(/^Agent changes/)).queryByText('Accepted')).toBeNull();
  });

  it('shows one collapsed line in a card when nothing is pending, which opens the accepted files', () => {
    renderWithHost(
      <MessageList />,
      chatState(
        [turnMessage('a1', makeChangesPart(['op1'], ['done.ts', 'two.ts']))],
        [
          makeReviewEntry('done.ts', { status: 'accepted', operationIds: [opId('op1')] }),
          makeReviewEntry('two.ts', { status: 'accepted', operationIds: [opId('op1')] }),
        ],
      ),
    );
    const line = screen.getByRole('button', { name: 'No pending changes, 2 accepted' });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Accept All' })).toBeNull();
    expect(screen.queryByText('done.ts')).toBeNull();
    fireEvent.click(line);
    expect(screen.getByRole('button', { name: 'Open diff of done.ts' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open diff of two.ts' })).toBeTruthy();
  });
});

describe('toolbar', () => {
  it('summarises pending changes and files', () => {
    renderDock([
      A(),
      makeReviewEntry('b.ts', { attribution: 'mixed' }),
      makeReviewEntry('new.ts', { changeType: 'created', renamedFrom: 'old.ts' }),
      makeReviewEntry('done.ts', { status: 'accepted' }),
    ]);
    expect(screen.getByText('3 pending changes in 4 files')).toBeTruthy();
  });

  it('uses the singular', () => {
    renderDock([A()]);
    expect(screen.getByText('1 pending change in 1 file')).toBeTruthy();
  });

  it('posts Accept All and Open All in Diff Editor', () => {
    const { host } = renderDock([A()]);
    fireEvent.click(screen.getByRole('button', { name: 'Accept All' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open All in Diff Editor' }));
    expect(sent(host)).toEqual([{ type: 'review.acceptAll' }, { type: 'review.openAll' }]);
  });

  it('posts Reject All with no paths by default', () => {
    const { host } = renderDock([A(), makeReviewEntry('m.ts', { attribution: 'mixed' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(host.postedOf('review.rejectAll')).toEqual([
      { type: 'review.rejectAll', includePaths: [] },
    ]);
  });

  it('feeds the ticked uncertain entries to Reject All', () => {
    const { host } = renderDock([
      A(),
      makeReviewEntry('m.ts', { attribution: 'mixed' }),
      makeReviewEntry('u.ts', { attribution: 'unattributed' }),
      makeReviewEntry('i.ts', { attribution: 'after-interruption' }),
    ]);
    const box = (path: string) =>
      screen.getByRole<HTMLInputElement>('checkbox', { name: `Include in Reject All: ${path}` });
    expect(box('m.ts').checked).toBe(false);
    expect(
      screen.getByText('Reject All leaves these files alone unless you tick them.'),
    ).toBeTruthy();
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
    const first = renderDock(entries);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include in Reject All: m.ts' }));
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    const second = renderWithHost(<ChangesDock />, stateWith(entries), saved);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: /m\.ts/ }).checked).toBe(true);
    second.init(stateWith([A()]), 1);
    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(second.host.postedOf('review.rejectAll')).toEqual([
      { type: 'review.rejectAll', includePaths: [] },
    ]);
  });
});

describe('while an Agent turn runs', () => {
  it('renders nothing for pending files alone, so it does not flash before the card arrives', () => {
    const { container } = renderDock([A(), makeReviewEntry('m.ts', { attribution: 'mixed' })], {
      busy: true,
    });
    expect(container.innerHTML).toBe('');
  });

  it('says file changes wait for the turn to end, with a configuration change to decide', () => {
    renderDock([A(), makeReviewEntry('m.ts', { attribution: 'mixed' })], {
      busy: true,
      configChanges: [makeConfigChange('k1')],
    });
    expect(screen.getByText('File changes can be reviewed when the turn ends.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Pending changes' })).toBeNull();
    for (const name of ['Accept All', 'Reject All', 'Open All in Diff Editor']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Accept src/a.ts' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open diff of src/a.ts' })).toBeNull();
    // The header stays a button when a turn starts.
    const toggle = screen.getByRole('button', { name: /^Changes/ });
    expect(toggle.textContent).toContain('file changes after the turn');
    expect(toggle.textContent).toContain('1 configuration change');
  });

  it('shows no waiting line without entries', () => {
    renderDock([], { busy: true, configChanges: [makeConfigChange('k1')] });
    expect(screen.queryByText(/can be reviewed when the turn ends/)).toBeNull();
  });

  it('keeps the Configuration section, with working buttons', () => {
    const { host } = renderDock([A()], {
      busy: true,
      configChanges: [makeConfigChange('k1')],
    });
    expect(region('Configuration changes')).toBeTruthy();
    const keep = screen.getByRole<HTMLButtonElement>('button', { name: /^Keep / });
    expect(keep.disabled).toBe(false);
    fireEvent.click(keep);
    expect(host.postedOf('config.keep')).toHaveLength(1);
  });

  it('brings the files back when the turn ends', () => {
    const { init, container } = renderDock([A()], { busy: true });
    expect(container.innerHTML).toBe('');
    init(stateWith([A()], { busy: false }), 1);
    expect(screen.getByRole('button', { name: 'Accept All' })).toBeTruthy();
    expect(screen.queryByText(/can be reviewed when the turn ends/)).toBeNull();
  });
});

describe('configuration changes', () => {
  it('shows the warning and one row per change with its buttons', () => {
    const { host } = renderDock([A()], {
      configChanges: [
        makeConfigChange('k1', { displayPath: '.claude/settings.json' }),
        makeConfigChange('k2', { displayPath: '.mcp.json', changeType: 'created' }),
        makeConfigChange('k3', { displayPath: '.vscode/tasks.json', changeType: 'deleted' }),
      ],
    });
    const section = region('Configuration changes');
    const note = within(section).getByRole('note').textContent ?? '';
    expect(note).toMatch(/^The last turn changed tool or editor configuration\./);
    expect(note).not.toMatch(/\b(tab|Review)\b/);
    const rows = within(section).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Modified');
    expect(rows[1]?.textContent).toContain('Created');
    expect(rows[2]?.textContent).toContain('Deleted');

    fireEvent.click(
      within(rows[0] as HTMLElement).getByRole('button', {
        name: 'Open diff of .claude/settings.json',
      }),
    );
    fireEvent.click(within(rows[1] as HTMLElement).getByRole('button', { name: 'Keep .mcp.json' }));
    fireEvent.click(
      within(rows[2] as HTMLElement).getByRole('button', { name: 'Revert .vscode/tasks.json' }),
    );
    expect(sent(host)).toEqual([
      { type: 'config.openDiff', changeId: 'k1' },
      { type: 'config.keep', changeId: 'k2' },
      { type: 'config.revert', changeId: 'k3' },
    ]);
  });

  it('puts the configuration section before the files', () => {
    renderDock([A()], { configChanges: [makeConfigChange('k1')] });
    const regions = screen
      .getAllByRole('region')
      .map((r) => r.querySelector('h2, h3')?.textContent);
    expect(regions.slice(1, 3)).toEqual(['Configuration changes', 'Pending changes']);
  });

  it('disables Revert with the reason when the earlier content was not kept', () => {
    const { host } = renderDock([], {
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

  it('shows a configuration change without files, and no toolbar', () => {
    renderDock([], { configChanges: [makeConfigChange('k1')] });
    expect(screen.queryByRole('region', { name: 'Files' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept All' })).toBeNull();
  });

  it('does not lock Keep or Revert after a click, because the host may cancel its confirm', () => {
    const { host } = renderDock([], {
      configChanges: [makeConfigChange('k1')],
    });
    const keep = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Keep .claude/settings.json',
    });
    fireEvent.click(keep);
    expect(keep.disabled).toBe(false);
    fireEvent.click(keep);
    const revert = screen.getByRole<HTMLButtonElement>('button', { name: /^Revert / });
    fireEvent.click(revert);
    fireEvent.click(revert);
    expect(revert.disabled).toBe(false);
    expect(host.postedOf('config.keep')).toHaveLength(2);
    expect(host.postedOf('config.revert')).toHaveLength(2);
  });
});

describe('snapshot status', () => {
  const base = { filesDone: 0, filesTotal: 0 };

  it('shows progress while capturing', () => {
    renderDock([A()], { baseline: { state: 'capturing', filesDone: 30, filesTotal: 120 } });
    const text = document.querySelector('.review-snapshot p') as HTMLElement;
    expect(text.textContent).toBe('Preparing the workspace snapshot: 30 of 120 files');
    const bar = document.querySelector('progress');
    expect(bar?.getAttribute('max')).toBe('120');
    expect(bar?.getAttribute('value')).toBe('30');
    expect(bar?.getAttribute('aria-labelledby')).toBe(text.id);
  });

  it('shows an indeterminate bar before the file count is known', () => {
    renderDock([A()], { baseline: { state: 'capturing', ...base } });
    expect(document.querySelector('progress')?.hasAttribute('value')).toBe(false);
  });

  it('shows a warning with the note when degraded', () => {
    renderDock([A()], {
      baseline: { state: 'degraded', ...base, note: 'Some large files were skipped.' },
    });
    expect(
      screen.getByText('Some large files were skipped.').closest('[role="note"]'),
    ).not.toBeNull();
  });

  it('falls back to a general warning when degraded without a note', () => {
    renderDock([A()], { baseline: { state: 'degraded', ...base } });
    expect(screen.getByText(/snapshot is incomplete/)).toBeTruthy();
  });

  it.each(['ready', 'idle'] as const)('shows nothing when %s', (state) => {
    renderDock([A()], { baseline: { state, ...base, note: 'ignored' } });
    expect(document.querySelector('progress')).toBeNull();
    expect(screen.queryByText('ignored')).toBeNull();
    expect(document.querySelector('.review-snapshot')).toBeNull();
  });

  it('exports the announcement interval', () => {
    expect(SNAPSHOT_ANNOUNCE_MS).toBe(5000);
  });
});

describe('stale ticks', () => {
  const mixed = () => makeReviewEntry('m.ts', { attribution: 'mixed' });
  const rejectAll = (host: { postedOf: (t: 'review.rejectAll') => unknown[] }) =>
    host.postedOf('review.rejectAll');

  it('forgets a tick when its file leaves, so it comes back unticked', () => {
    const { host, init } = renderDock([mixed()]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include in Reject All: m.ts' }));
    init(stateWith([A()]), 1);
    init(stateWith([A(), mixed()]), 2);
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Include in Reject All: m.ts' })
        .checked,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(rejectAll(host)).toEqual([{ type: 'review.rejectAll', includePaths: [] }]);
  });

  it('forgets ticks even while the card renders nothing', () => {
    const { services, init } = renderDock([mixed()]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include in Reject All: m.ts' }));
    init(stateWith([]), 1);
    expect(services.ui.getSnapshot().reviewInclude).toEqual({});
  });

  it('keeps ticks across a reload while the files are still there', () => {
    const first = renderDock([mixed()]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include in Reject All: m.ts' }));
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    const second = renderWithHost(<ChangesDock />, stateWith([mixed()]), saved);
    expect(second.services.ui.getSnapshot().reviewInclude).toEqual({ 'm.ts': true });
    fireEvent.click(screen.getByRole('button', { name: 'Reject All' }));
    expect(rejectAll(second.host)).toEqual([{ type: 'review.rejectAll', includePaths: ['m.ts'] }]);
  });

  it('does not prune before the host state has arrived', () => {
    const first = renderDock([mixed()]);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include in Reject All: m.ts' }));
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();
    const second = renderWithHost(<ChangesDock />, null, saved);
    expect(second.services.ui.getSnapshot().reviewInclude).toEqual({ 'm.ts': true });
    second.init(stateWith([mixed()]), 0);
    expect(second.services.ui.getSnapshot().reviewInclude).toEqual({ 'm.ts': true });
  });
});

describe('focus', () => {
  const withComposer = (state: ViewState) =>
    renderWithHost(
      <>
        <ChangesDock />
        <Composer />
      </>,
      state,
    );

  it('moves to the next file when one is accepted', () => {
    const { init } = withComposer(stateWith([makeReviewEntry('a.ts'), makeReviewEntry('b.ts')]));
    screen.getByRole('button', { name: 'Accept a.ts' }).focus();
    act(() => {
      init(stateWith([makeReviewEntry('b.ts')]), 1);
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open diff of b.ts' }));
  });

  it('falls back to the composer when the whole card goes away', () => {
    const { init } = withComposer(stateWith([makeReviewEntry('a.ts')]));
    screen.getByRole('button', { name: 'Accept All' }).focus();
    act(() => {
      init(stateWith([]), 1);
    });
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });

  it('falls back to the composer form when the textarea is disabled', () => {
    const { init } = withComposer({
      ...stateWith([], { configChanges: [makeConfigChange('k1')] }),
      trusted: false,
    });
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' }).disabled).toBe(
      true,
    );
    screen.getByRole('button', { name: /^Keep / }).focus();
    act(() => {
      init({ ...stateWith([]), trusted: false }, 1);
    });
    expect(document.activeElement).toBe(screen.getByRole('form', { name: 'Message composer' }));
  });

  it('falls back to the composer when the last configuration change is decided', () => {
    const { init } = withComposer(stateWith([], { configChanges: [makeConfigChange('k1')] }));
    screen.getByRole('button', { name: /^Keep / }).focus();
    act(() => {
      init(stateWith([]), 1);
    });
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Message' }));
  });
});

describe('in the app', () => {
  it('sits between the log and the composer', () => {
    renderWithHost(<App />, stateWith([A()], { active: true }));
    const log = screen.getByRole('log');
    const dock = region('Changes');
    const composer = screen.getByRole('form', { name: 'Message composer' });
    expect(log.compareDocumentPosition(dock) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dock.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows with no open conversation', () => {
    renderWithHost(<App />, stateWith([], { configChanges: [makeConfigChange('k1')] }));
    expect(screen.getByText(/Ask a question, plan a change/)).toBeTruthy();
    expect(region('Configuration changes')).toBeTruthy();
  });

  it('has no Review tab, tab badge or header warning icon', () => {
    renderWithHost(
      <App />,
      stateWith([A(), makeReviewEntry('b.ts')], { configChanges: [makeConfigChange('k1')] }),
    );
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chat', 'History']);
    expect(document.querySelector('.tab-badge')).toBeNull();
    expect(document.querySelector('.header-warning')).toBeNull();
    expect(screen.queryByRole('button', { name: /your decision/ })).toBeNull();
  });

  it('is not shown on the other tabs', () => {
    renderWithHost(<App />, stateWith([A()]));
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
  });
});

describe('accessibility', () => {
  it('gives every button and control a name, and entry actions the path', () => {
    renderDock(
      [
        A(),
        makeReviewEntry('m.ts', { attribution: 'mixed' }),
        makeReviewEntry('done.ts', { status: 'accepted' }),
      ],
      {
        configChanges: [makeConfigChange('k1', { revertible: false })],
        baseline: { state: 'capturing', filesDone: 1, filesTotal: 2 },
      },
    );
    fireEvent.click(screen.getByRole('button', { name: /^Accepted/ }));
    const nameOf = (el: HTMLElement) => {
      const label = el.getAttribute('aria-label');
      if (label) return label;
      return (el.closest('label')?.textContent ?? el.textContent ?? '').trim();
    };
    const controls = document.querySelectorAll<HTMLElement>('button, input');
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) expect(nameOf(control), control.outerHTML).not.toBe('');
    for (const path of ['src/a.ts', 'm.ts']) {
      for (const name of [`Accept ${path}`, `Reject ${path}`, `Open diff of ${path}`]) {
        expect(screen.getByRole('button', { name }), name).toBeTruthy();
      }
    }
    for (const button of document.querySelectorAll<HTMLElement>('.review-entry-actions button')) {
      expect(nameOf(button)).toMatch(/[./]|\b\w+\.\w+\b/);
    }
  });

  it('makes entries list items, groups regions with headings, and the scroll box reachable', () => {
    renderDock([A()]);
    const group = region(/^Agent changes/);
    expect(within(group).getByRole('list')).toBeTruthy();
    expect(within(group).getByRole('heading', { level: 4 })).toBeTruthy();
    const body = screen.getByRole('group', { name: 'Changes details' });
    expect(body.getAttribute('tabindex')).toBe('0');
    expect(region('Changes').getAttribute('tabindex')).toBe('-1');
  });

  it('keeps the actions of an entry in reading order: path, then Accept, Reject', () => {
    renderDock([A()]);
    const row = screen.getAllByRole('listitem')[0] as HTMLElement;
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Open diff of src/a.ts', 'Accept src/a.ts', 'Reject src/a.ts']);
  });
});

describe('the strip, with a conversation open', () => {
  it('lists an entry no card owns, under its own title, and posts only that file', () => {
    const { host } = renderChat(
      chatState(
        [turnMessage('a1', makeChangesPart(['op1'], ['in-card.ts']))],
        [own('in-card.ts', ['op1']), own('outside.ts', ['op9'])],
      ),
    );
    const strip = within(region('Changes'));
    const files = strip.getByRole('region', {
      name: 'Pending changes outside this conversation',
    });
    expect(within(files).getByRole('button', { name: 'Open diff of outside.ts' })).toBeTruthy();
    expect(strip.queryByText('in-card.ts')).toBeNull();
    expect(
      within(region('Changed files')).queryByRole('button', { name: 'Open diff of outside.ts' }),
    ).toBeNull();
    expect(strip.getByRole('button', { name: /^Changes/ }).textContent).toContain('1 pending');

    fireEvent.click(strip.getByRole('button', { name: 'Accept All' }));
    fireEvent.click(strip.getByRole('button', { name: 'Open All in Diff Editor' }));
    fireEvent.click(strip.getByRole('button', { name: 'Reject All' }));
    expect(sent(host)).toEqual([
      { type: 'review.acceptAll', paths: ['outside.ts'] },
      { type: 'review.openAll', paths: ['outside.ts'] },
      { type: 'review.rejectAll', includePaths: [], paths: ['outside.ts'] },
    ]);
  });

  it('lists everything and posts for the whole folder when no card owns anything', () => {
    const { host } = renderChat(chatState([], [own('a.ts', ['op9']), own('b.ts', ['op8'])]));
    expect(
      screen.getByRole('region', { name: 'Pending changes outside this conversation' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept All' }));
    expect(sent(host)).toEqual([{ type: 'review.acceptAll' }]);
  });

  it('renders nothing while a card owns every pending file', () => {
    const { container } = renderChat(
      chatState([turnMessage('a1', makeChangesPart(['op1'], ['a.ts']))], [own('a.ts', ['op1'])]),
    );
    expect(container.querySelector('.changes-dock')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
  });

  it('does not re-render while text streams into a message', () => {
    let commits = 0;
    const { host } = renderWithHost(
      <Profiler
        id="strip"
        onRender={() => {
          commits += 1;
        }}
      >
        <ChangesDock />
      </Profiler>,
      chatState(
        [turnMessage('a1', { kind: 'text', text: 'a' }, makeChangesPart(['op1'], ['in-card.ts']))],
        [own('in-card.ts', ['op1']), own('outside.ts', ['op9'])],
      ),
    );
    expect(screen.getByRole('region', { name: 'Changes' })).toBeTruthy();
    const before = commits;
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'appendText', path: ['active', 'messages', 1, 'parts', 0, 'text'], text: 'bc' }],
    });
    expect(commits).toBe(before);
    // The probe does see a change that concerns the strip.
    host.emit({
      type: 'patch',
      seq: 2,
      ops: [{ op: 'set', path: ['review', 'busy'], value: true }],
    });
    expect(commits).toBeGreaterThan(before);
  });

  it('keeps the ticks of uncertain files that a card lists', () => {
    const state = () =>
      chatState(
        [turnMessage('a1', makeChangesPart(['op1'], ['m.ts']))],
        [own('m.ts', ['op1'], { attribution: 'mixed' })],
      );
    const { services, init } = renderChat(state());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include in Reject All: m.ts' }));
    init(state(), 1);
    expect(services.ui.getSnapshot().reviewInclude).toEqual({ 'm.ts': true });
  });
});

describe('the changes card in the log', () => {
  const turn1 = () =>
    turnMessage(
      'a1',
      { kind: 'text', text: 'Done.' },
      makeChangesPart(['op1'], ['src/a.ts', 'src/b.ts']),
    );

  it('lists the files of the turn with their actions, where the turn ended, and the strip stays out', () => {
    const { container } = renderChat(
      chatState([turn1()], [own('src/a.ts', ['op1']), own('src/b.ts', ['op1'])]),
    );
    const card = region('Changed files');
    expect(screen.getByRole('log').contains(card)).toBe(true);
    expect(card.closest('article')?.textContent).toContain('Done.');
    expect(within(card).getByRole('heading', { level: 3 }).textContent).toBe(
      'Changed files2 pending',
    );
    for (const path of ['src/a.ts', 'src/b.ts']) {
      expect(within(card).getByRole('button', { name: `Accept ${path}` })).toBeTruthy();
      expect(within(card).getByRole('button', { name: `Reject ${path}` })).toBeTruthy();
    }
    expect(within(card).getByText('2 pending changes in 2 files')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Accept All' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Changes' })).toBeNull();
    expect(container.querySelector('.changes-dock')).toBeNull();
  });

  it('names the groups with level-four headings under the card heading', () => {
    renderChat(
      chatState(
        [turn1()],
        [own('src/a.ts', ['op1']), own('src/b.ts', ['op1'], { attribution: 'mixed' })],
      ),
    );
    expect(
      within(region('Changed files'))
        .getAllByRole('heading')
        .map((h) => [h.tagName, h.textContent?.trim()]),
    ).toEqual([
      ['H3', 'Changed files2 pending'],
      ['H4', 'Agent changes 1'],
      ['H4', 'Changed during a turn, source uncertain 1'],
    ]);
  });

  it('says how many are accepted when nothing is pending', () => {
    renderChat(
      chatState(
        [turn1()],
        [
          own('src/a.ts', ['op1'], { status: 'accepted' }),
          own('src/b.ts', ['op1'], { status: 'accepted' }),
        ],
      ),
    );
    expect(within(region('Changed files')).getByRole('heading', { level: 3 }).textContent).toBe(
      'Changed files2 accepted',
    );
  });

  it('limits Accept All, Reject All and Open All to the files of the card', () => {
    const { host } = renderChat(
      chatState(
        [turn1()],
        [
          own('src/a.ts', ['op1']),
          own('src/b.ts', ['op1'], { attribution: 'mixed' }),
          own('src/c.ts', ['op1'], { attribution: 'unattributed' }),
          own('src/done.ts', ['op1'], { status: 'accepted' }),
          own('outside.ts', ['op9']),
        ],
      ),
    );
    const card = within(region('Changed files'));
    fireEvent.click(card.getByRole('checkbox', { name: 'Include in Reject All: src/c.ts' }));
    fireEvent.click(card.getByRole('button', { name: 'Accept All' }));
    fireEvent.click(card.getByRole('button', { name: 'Open All in Diff Editor' }));
    fireEvent.click(card.getByRole('button', { name: 'Reject All' }));
    const paths = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    expect(sent(host)).toEqual([
      { type: 'review.acceptAll', paths },
      { type: 'review.openAll', paths },
      { type: 'review.rejectAll', includePaths: ['src/c.ts'], paths },
    ]);
  });

  it('posts the per-file messages from the card', () => {
    const { host } = renderChat(chatState([turn1()], [own('src/a.ts', ['op1'])]));
    const card = within(region('Changed files'));
    fireEvent.click(card.getByRole('button', { name: 'Accept src/a.ts' }));
    fireEvent.click(card.getByRole('button', { name: 'Reject src/a.ts' }));
    fireEvent.click(card.getByRole('button', { name: 'Open diff of src/a.ts' }));
    expect(sent(host)).toEqual([
      { type: 'review.acceptFile', path: 'src/a.ts' },
      { type: 'review.rejectFile', path: 'src/a.ts' },
      { type: 'review.openDiff', path: 'src/a.ts' },
    ]);
  });

  it('keeps the open state of the Accepted group apart for each card', () => {
    const { services } = renderChat(
      chatState(
        [
          turn1(),
          userMessage('u2', 'again', { turnId: turnId('t2') }),
          assistantMessage('a2', [makeChangesPart(['op2'], ['c.ts'])], { turnId: turnId('t2') }),
        ],
        [
          own('src/a.ts', ['op1']),
          own('src/b.ts', ['op1'], { status: 'accepted' }),
          own('c.ts', ['op2'], { status: 'accepted' }),
        ],
      ),
    );
    const [first] = cardRegions();
    fireEvent.click(within(first as HTMLElement).getByRole('button', { name: /^Accepted/ }));
    const expanded = services.ui.getSnapshot().expanded;
    expect(expanded['review:accepted:a1']).toBe(true);
    expect(expanded['review:accepted:a2']).toBeUndefined();
    expect(expanded['review:accepted']).toBeUndefined();
  });

  describe('a file changed by two turns', () => {
    const state = () =>
      chatState(
        [
          turnMessage('a1', makeChangesPart(['op1'], ['src/a.ts'])),
          userMessage('u2', 'again', { turnId: turnId('t2') }),
          assistantMessage('a2', [makeChangesPart(['op2'], ['src/a.ts'])], {
            turnId: turnId('t2'),
          }),
        ],
        [own('src/a.ts', ['op1', 'op2'])],
      );

    it('has its actions in the card of the second turn only', () => {
      renderChat(state());
      const [first, second] = cardRegions().map((card) => within(card));
      expect(second?.getByRole('button', { name: 'Accept src/a.ts' })).toBeTruthy();
      expect(first?.queryByRole('button', { name: /^Accept|^Reject/ })).toBeNull();
      expect(first?.getByRole('heading', { level: 3 }).textContent).toBe(
        'Changed filesNo pending changes',
      );
      expect(screen.getAllByRole('button', { name: 'Accept src/a.ts' })).toHaveLength(1);
    });

    it('shows the path in the first card, as changed again, after opening its record', () => {
      const { services } = renderChat(state());
      const first = within(cardRegions()[0] as HTMLElement);
      expect(first.queryByText('Changed again in a later turn')).toBeNull();
      const toggle = first.getByRole('button', { name: '1 file no longer pending' });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(services.ui.getSnapshot().expanded['review:record:a1']).toBe(true);
      expect(first.getByText('Changed again in a later turn')).toBeTruthy();
      expect(first.getByRole('link', { name: 'src/a.ts' })).toBeTruthy();
      expect(first.getByText('Modified')).toBeTruthy();
      // Still no actions there.
      expect(first.queryByRole('button', { name: /^Accept|^Reject/ })).toBeNull();
    });
  });

  describe('the record of files that are no longer pending', () => {
    it('lists a path with no entry as settled, with no actions, and says there is nothing pending', () => {
      const { host } = renderChat(
        chatState(
          [turnMessage('a1', makeChangesPart(['op1'], ['x.ts', ['y.ts', 'deleted']], 3))],
          [],
        ),
      );
      const card = within(region('Changed files'));
      expect(card.getByRole('heading', { level: 3 }).textContent).toBe(
        'Changed filesNo pending changes',
      );
      expect(card.queryByRole('button', { name: /^Accept|^Reject|^Open/ })).toBeNull();
      const toggle = card.getByRole('button', { name: '5 files no longer pending' });
      expect(card.queryByText('x.ts')).toBeNull();
      fireEvent.click(toggle);
      expect(card.getByRole('link', { name: 'x.ts' })).toBeTruthy();
      // The file may not exist any more: no link.
      expect(card.getByText('y.ts').getAttribute('role')).toBeNull();
      expect(card.getByText('Deleted')).toBeTruthy();
      expect(card.getByText('and 3 more')).toBeTruthy();
      expect(card.queryByText('Changed again in a later turn')).toBeNull();
      fireEvent.click(card.getByRole('link', { name: 'x.ts' }));
      expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: 'x.ts' }]);
    });

    it('says one file in the singular, and has no record when everything is live', () => {
      const first = renderChat(
        chatState([turnMessage('a1', makeChangesPart(['op1'], ['x.ts']))], []),
      );
      expect(screen.getByRole('button', { name: '1 file no longer pending' })).toBeTruthy();
      first.unmount();
      renderChat(
        chatState([turnMessage('a1', makeChangesPart(['op1'], ['x.ts']))], [own('x.ts', ['op1'])]),
      );
      expect(screen.queryByRole('button', { name: /no longer pending/ })).toBeNull();
    });

    it('counts the files beyond the list only when they are not live', () => {
      renderChat(
        chatState(
          [turnMessage('a1', makeChangesPart(['op1'], ['x.ts'], 3))],
          [own('x.ts', ['op1']), own('beyond.ts', ['op1'])],
        ),
      );
      const card = within(region('Changed files'));
      expect(card.getByRole('button', { name: 'Open diff of beyond.ts' })).toBeTruthy();
      expect(card.getByRole('button', { name: '2 files no longer pending' })).toBeTruthy();
    });

    it('stays a card as files settle, and moves them to the record', () => {
      const { init } = renderChat(
        chatState([turn1()], [own('src/a.ts', ['op1']), own('src/b.ts', ['op1'])]),
      );
      expect(screen.getByRole('button', { name: 'Accept src/b.ts' })).toBeTruthy();
      act(() => {
        init(chatState([turn1()], [own('src/b.ts', ['op1'])]), 1);
      });
      const card = within(region('Changed files'));
      expect(card.queryByRole('button', { name: 'Accept src/a.ts' })).toBeNull();
      expect(card.getByRole('button', { name: '1 file no longer pending' })).toBeTruthy();
      act(() => {
        init(chatState([turn1()], []), 2);
      });
      expect(card.getByRole('heading', { level: 3 }).textContent).toBe(
        'Changed filesNo pending changes',
      );
      expect(card.queryByRole('button', { name: /^Accept/ })).toBeNull();
    });
  });

  describe('while an Agent turn runs', () => {
    const state = (extra: Parameters<typeof chatState>[2] = {}) =>
      chatState(
        [turn1()],
        [
          own('src/a.ts', ['op1']),
          own('src/b.ts', ['op1'], { attribution: 'mixed' }),
          own('outside.ts', ['op9']),
        ],
        { busy: true, ...extra },
      );

    it('keeps the rows, takes the buttons away and says file changes wait', () => {
      renderChat(state());
      const card = within(region('Changed files'));
      expect(card.getByRole('button', { name: 'Open diff of src/a.ts' })).toBeTruthy();
      expect(card.getByRole('button', { name: 'Open diff of src/b.ts' })).toBeTruthy();
      expect(card.getByText('File changes can be reviewed when the turn ends.')).toBeTruthy();
      expect(card.getByText('2 pending changes in 2 files')).toBeTruthy();
      expect(card.getByRole('heading', { level: 3 }).textContent).toBe('Changed files2 pending');
      expect(card.queryByRole('button', { name: /^Accept|^Reject|^Open All/ })).toBeNull();
      expect(card.queryByRole('checkbox')).toBeNull();
      // The explanation of the uncertain file stays.
      expect(card.getByText('Both you and the agent changed this file')).toBeTruthy();
    });

    it('gives the buttons back when the turn ends', () => {
      const { init } = renderChat(state());
      act(() => {
        init(state({ busy: false }), 1);
      });
      const card = within(region('Changed files'));
      expect(card.getByRole('button', { name: 'Accept src/a.ts' })).toBeTruthy();
      expect(card.queryByText(/can be reviewed when the turn ends/)).toBeNull();
    });

    it('leaves the strip out for pending files alone', () => {
      const { container } = renderChat(state());
      expect(container.querySelector('.changes-dock')).toBeNull();
    });

    it('shows the strip, with the note and no buttons, when a configuration change waits too', () => {
      renderChat(state({ configChanges: [makeConfigChange('k1')] }));
      const strip = within(region('Changes'));
      expect(strip.getByText('File changes can be reviewed when the turn ends.')).toBeTruthy();
      expect(strip.queryByRole('button', { name: /^Accept|^Reject|^Open All/ })).toBeNull();
      expect(strip.queryByRole('button', { name: 'Open diff of outside.ts' })).toBeNull();
      expect(strip.getByRole('button', { name: /^Keep / })).toBeTruthy();
      expect(strip.getByRole('button', { name: /^Changes/ }).textContent).toContain(
        'file changes after the turn',
      );
    });
  });

  describe('the snapshot', () => {
    const degraded = {
      state: 'degraded',
      filesDone: 2,
      filesTotal: 2,
      note: 'Some files were skipped.',
    } as const;

    it('warns in a card that has pending files', () => {
      renderChat(chatState([turn1()], [own('src/a.ts', ['op1'])], { baseline: degraded }));
      const note = within(region('Changed files')).getByText('Some files were skipped.');
      expect(note.closest('[role="note"]')).not.toBeNull();
    });

    it('says nothing in a card with nothing pending', () => {
      renderChat(chatState([turn1()], [], { baseline: degraded }));
      expect(within(region('Changed files')).queryByRole('note')).toBeNull();
    });
  });

  describe('focus', () => {
    const withComposer = (state: ViewState) =>
      renderWithHost(
        <>
          <MessageList />
          <ChangesDock />
          <Composer />
        </>,
        state,
      );
    const composerBox = () => screen.getByRole('textbox', { name: 'Message' });

    it('moves to the composer when the last pending file of a card is accepted', () => {
      const entry = own('a.ts', ['op1']);
      const message = () => turnMessage('a1', makeChangesPart(['op1'], ['a.ts']));
      const { init } = withComposer(chatState([message()], [entry]));
      screen.getByRole('button', { name: 'Accept a.ts' }).focus();
      act(() => {
        init(chatState([message()], [{ ...entry, status: 'accepted' }]), 1);
      });
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement).toBe(composerBox());
    });

    it('moves to the composer when the file leaves the review altogether', () => {
      const message = () => turnMessage('a1', makeChangesPart(['op1'], ['a.ts']));
      const { init } = withComposer(chatState([message()], [own('a.ts', ['op1'])]));
      screen.getByRole('button', { name: 'Reject a.ts' }).focus();
      act(() => {
        init(chatState([message()], []), 1);
      });
      expect(document.activeElement).toBe(composerBox());
    });

    it('moves to the card itself when there is no composer to take focus', () => {
      const entry = own('a.ts', ['op1']);
      const message = () => turnMessage('a1', makeChangesPart(['op1'], ['a.ts']));
      const { init } = renderWithHost(<MessageList />, chatState([message()], [entry]));
      screen.getByRole('button', { name: 'Accept a.ts' }).focus();
      act(() => {
        init(chatState([message()], [{ ...entry, status: 'accepted' }]), 1);
      });
      expect(document.activeElement).toBe(region('Changed files'));
    });

    it('moves to the next file of the card when one is accepted', () => {
      const message = () => turnMessage('a1', makeChangesPart(['op1'], ['a.ts', 'b.ts']));
      const { init } = withComposer(
        chatState([message()], [own('a.ts', ['op1']), own('b.ts', ['op1'])]),
      );
      screen.getByRole('button', { name: 'Accept a.ts' }).focus();
      act(() => {
        init(chatState([message()], [own('b.ts', ['op1'])]), 1);
      });
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Open diff of b.ts' }),
      );
    });

    it('stays in the page when a turn starts and the buttons go away', () => {
      const message = () => turnMessage('a1', makeChangesPart(['op1'], ['a.ts']));
      const entries = () => [own('a.ts', ['op1'])];
      const { init } = withComposer(chatState([message()], entries()));
      screen.getByRole('button', { name: 'Accept All' }).focus();
      act(() => {
        init(chatState([message()], entries(), { busy: true }), 1);
      });
      expect(document.activeElement).not.toBe(document.body);
    });
  });
});
