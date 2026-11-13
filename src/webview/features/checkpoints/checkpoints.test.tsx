// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CheckpointSummary, RestoreItem, RestorePreview, ViewState } from '../../../shared';
import { App } from '../../app/App';
import {
  convId,
  makeActive,
  makeCheckpoint,
  makeRestoreItem,
  makeRestorePreview,
  makeState,
  makeTurn,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { CheckpointsView } from './CheckpointsView';
import { formatClock, formatFull, formatRelative } from './checkpoint-model';

const NOW = 1_700_000_000_000 + 10 * 60_000;

function stateWith(
  checkpoints: CheckpointSummary[],
  restorePreview: RestorePreview | null = null,
  running = false,
): ViewState {
  return makeState({
    checkpoints,
    restorePreview,
    ...(running ? { active: makeActive('c1', { turns: [makeTurn({ status: 'running' })] }) } : {}),
  });
}

const renderView = (...args: Parameters<typeof stateWith>) =>
  renderWithHost(<CheckpointsView now={NOW} />, stateWith(...args));

const sent = (host: { posted: { type: string }[] }) =>
  host.posted.filter((m) => m.type !== 'ready');

describe('Checkpoints tab', () => {
  const names = () => screen.getAllByRole('tab').map((t) => t.textContent);

  it('is hidden without checkpoints and without a preview', () => {
    renderWithHost(<App />, stateWith([]));
    expect(names()).toEqual(['Chat', 'History']);
  });

  it('appears with checkpoints, with no badge', () => {
    renderWithHost(<App />, stateWith([makeCheckpoint('op1')]));
    expect(names()).toEqual(['Chat', 'Checkpoints', 'History']);
    expect(screen.getByRole('tab', { name: 'Checkpoints' }).querySelector('.tab-badge')).toBeNull();
  });

  it('appears while a preview is open, even with an empty list', () => {
    renderWithHost(<App />, stateWith([], makeRestorePreview()));
    expect(names()).toContain('Checkpoints');
  });

  it('switches with show-tab and shows the history', () => {
    const { host } = renderWithHost(<App />, stateWith([makeCheckpoint('op1')]));
    host.emit({ type: 'event', event: { kind: 'show-tab', tab: 'checkpoints' } });
    expect(screen.getByRole('tab', { name: 'Checkpoints' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Checkpoint history' })).toBeTruthy();
  });

  it('falls back to Chat when the checkpoints go away', () => {
    const { init } = renderWithHost(<App />, stateWith([makeCheckpoint('op1')]));
    fireEvent.click(screen.getByRole('tab', { name: 'Checkpoints' }));
    init(stateWith([]), 1);
    expect(screen.getByRole('tab', { name: 'Chat' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('checkpoint list', () => {
  it('explains restoring in one sentence', () => {
    renderView([makeCheckpoint('op1')]);
    expect(
      screen.getByText(
        'Restoring puts files back to what they were before the chosen step. Nothing changes until you confirm.',
      ),
    ).toBeTruthy();
  });

  it.each([
    ['agent-turn', 'Agent turn'],
    ['reject', 'Rejected changes'],
    ['restore', 'Restored files'],
    ['recovery', 'Recovered after an interruption'],
  ] as const)('labels a %s checkpoint %s', (kind, label) => {
    renderView([makeCheckpoint('op1', { kind })]);
    expect(within(screen.getByRole('listitem')).getByText(label)).toBeTruthy();
  });

  it('shows the time (relative, with the absolute time as title and hidden text), title, count', () => {
    const at = 1_700_000_000_000;
    renderView([
      makeCheckpoint('op1', { at, conversationTitle: 'Fix the parser', filesChanged: 3 }),
      makeCheckpoint('op2', { at: at - 3 * 3_600_000, filesChanged: 1 }),
    ]);
    const [first, second] = screen.getAllByRole('listitem');
    const time = first?.querySelector('time') as HTMLElement;
    expect(time.textContent).toBe(`10 minutes ago, ${formatFull(at)}`);
    expect(time.getAttribute('title')).toBe(formatFull(at));
    expect(time.getAttribute('datetime')).toBe(new Date(at).toISOString());
    expect(first?.textContent).toContain('Fix the parser');
    expect(first?.textContent).toContain('3 files');
    expect(second?.textContent).toContain('1 file');
    expect(second?.textContent).not.toContain('Fix the parser');
    expect(second?.querySelector('time')?.textContent).toContain('3 hours ago');
  });

  it('marks an interrupted checkpoint with text', () => {
    renderView([makeCheckpoint('op1', { interrupted: true }), makeCheckpoint('op2')]);
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first as HTMLElement).getByText('Interrupted')).toBeTruthy();
    expect(within(second as HTMLElement).queryByText('Interrupted')).toBeNull();
  });

  it('lists the checkpoints in the order given (newest first)', () => {
    renderView([
      makeCheckpoint('new', { kind: 'restore', at: 5_000 }),
      makeCheckpoint('old', { kind: 'agent-turn', at: 1_000 }),
    ]);
    expect(
      screen
        .getAllByRole('listitem')
        .map((li) => li.querySelector('.checkpoint-kind')?.textContent),
    ).toEqual(['Restored files', 'Agent turn']);
  });

  it('names Preview Restore after the checkpoint and posts the operation id', () => {
    const at = 1_700_000_000_000;
    const { host } = renderView([makeCheckpoint('op7', { at, kind: 'reject' })]);
    const button = screen.getByRole('button', {
      name: `Preview restore to before Rejected changes, ${formatClock(at)}`,
    });
    expect(button.textContent).toBe('Preview Restore');
    fireEvent.click(button);
    expect(sent(host)).toEqual([{ type: 'checkpoint.preview', operationId: 'op7' }]);
  });

  it('disables Preview Restore with the reason while a turn runs', () => {
    const { host } = renderView([makeCheckpoint('op1')], null, true);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: /^Preview restore/ });
    expect(button.disabled).toBe(true);
    const hint = screen.getByText('Wait for the turn to finish.');
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(button);
    expect(sent(host)).toEqual([]);
  });

  it('formats relative times', () => {
    const now = 10_000_000_000;
    expect(formatRelative(now - 10_000, now)).toBe('just now');
    expect(formatRelative(now - 60_000, now)).toBe('1 minute ago');
    expect(formatRelative(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(formatRelative(now - 86_400_000, now)).toBe('1 day ago');
  });
});

describe('restore preview', () => {
  const target = makeCheckpoint('op1', {
    kind: 'agent-turn',
    at: 1_700_000_000_000,
    conversationId: convId('c9'),
    conversationTitle: 'Fix the parser',
  });
  const items: RestoreItem[] = [
    makeRestoreItem('src/a.ts'),
    makeRestoreItem('src/gone.ts', { action: 'delete' }),
    makeRestoreItem('bin/run.sh', { action: 'chmod' }),
    makeRestoreItem('src/my edit.ts', {
      conflict: 'user-edit-between',
      note: 'You changed this file after the agent did.',
      selectedByDefault: false,
    }),
    makeRestoreItem('src/risky.ts', {
      conflict: 'changed-since',
      note: 'Changed since the agent finished.',
      selectedByDefault: true,
    }),
    makeRestoreItem('big.bin', {
      selectable: false,
      selectedByDefault: false,
      conflict: 'not-captured',
      note: 'The earlier content was not kept.',
    }),
  ];
  const preview = (over: Partial<RestorePreview> = {}) =>
    makeRestorePreview({
      targetOperationId: target.operationId,
      affectedOperations: [
        makeCheckpoint('op2', { kind: 'restore', at: 1_700_000_600_000, filesChanged: 1 }),
        target,
      ],
      items,
      ...over,
    });
  const open = (p = preview(), running = false) => renderView([target], p, running);
  const region = () => screen.getByRole('region', { name: /^Restore to before/ });
  const box = (name: RegExp | string) => screen.getByRole<HTMLInputElement>('checkbox', { name });

  it('replaces the list, with a heading naming the checkpoint and its time', () => {
    open();
    expect(screen.queryByRole('heading', { name: 'Checkpoint history' })).toBeNull();
    expect(region().getAttribute('aria-labelledby')).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: `Restore to before Agent turn of ${formatFull(1_700_000_000_000)}`,
      }),
    ).toBeTruthy();
  });

  it('lists the steps it undoes', () => {
    open();
    expect(screen.getByText('This undoes 2 steps:')).toBeTruthy();
    const steps = within(region().querySelector('.restore-steps') as HTMLElement).getAllByRole(
      'listitem',
    );
    expect(steps.map((s) => s.querySelector('.checkpoint-kind')?.textContent)).toEqual([
      'Restored files',
      'Agent turn',
    ]);
    expect(steps[1]?.textContent).toContain('Fix the parser');
  });

  it('uses the singular for one step', () => {
    open(preview({ affectedOperations: [target] }));
    expect(screen.getByText('This undoes 1 step:')).toBeTruthy();
  });

  it('groups the items and shows actions as text', () => {
    open();
    const groups = within(region()).getAllByRole('region');
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual([
      'Will be restored 3',
      'Needs your decision 2',
      'Cannot be restored 1',
    ]);
    expect(within(groups[0] as HTMLElement).getByText('Restore content')).toBeTruthy();
    expect(within(groups[0] as HTMLElement).getByText('Delete')).toBeTruthy();
    expect(within(groups[0] as HTMLElement).getByText('Restore permissions')).toBeTruthy();
    expect(
      within(groups[1] as HTMLElement).getByText('You changed this file after the agent did.'),
    ).toBeTruthy();
    expect(
      within(groups[2] as HTMLElement).getByText('The earlier content was not kept.'),
    ).toBeTruthy();
  });

  it('ticks items from selectedByDefault, and gives blocked items no checkbox', () => {
    open();
    expect(box('Restore content src/a.ts').checked).toBe(true);
    expect(box('Delete src/gone.ts').checked).toBe(true);
    expect(box('Restore content src/my edit.ts').checked).toBe(false);
    expect(box('Restore content src/risky.ts').checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: /big\.bin/ })).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
  });

  it('ties each note to its checkbox with aria-describedby', () => {
    open();
    const mine = box('Restore content src/my edit.ts');
    const note = document.getElementById(mine.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe('You changed this file after the agent did.');
    expect(box('Restore content src/a.ts').hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows the count, follows the toggles and keeps them for the same token', () => {
    const { init } = open();
    expect(screen.getByText('4 of 5 files selected')).toBeTruthy();
    fireEvent.click(box('Restore content src/a.ts'));
    fireEvent.click(box('Restore content src/my edit.ts'));
    expect(screen.getByText('4 of 5 files selected')).toBeTruthy();
    fireEvent.click(box('Delete src/gone.ts'));
    expect(screen.getByText('3 of 5 files selected')).toBeTruthy();
    // The host refreshes the state with the same token: the ticks stay.
    init(stateWith([target], preview()), 1);
    expect(box('Delete src/gone.ts').checked).toBe(false);
    // A new preview starts from its own defaults.
    init(stateWith([target], preview({ token: 'tok-2' })), 2);
    expect(box('Delete src/gone.ts').checked).toBe(true);
    expect(screen.getByText('4 of 5 files selected')).toBeTruthy();
  });

  it('warns when a selected item has a conflict, and counts only selected ones', () => {
    open();
    expect(
      screen.getByText(
        '1 selected file contains changes that were not the agent’s. Restoring discards them.',
      ),
    ).toBeTruthy();
    fireEvent.click(box('Restore content src/my edit.ts'));
    expect(screen.getByText(/^2 selected files contain changes/)).toBeTruthy();
    fireEvent.click(box('Restore content src/my edit.ts'));
    fireEvent.click(box('Restore content src/risky.ts'));
    expect(screen.queryByText(/selected files? contains?/)).toBeNull();
    expect(screen.queryByText(/selected files contain/)).toBeNull();
  });

  it('restores exactly the selected paths', () => {
    const { host } = open();
    fireEvent.click(box('Restore content src/a.ts'));
    fireEvent.click(box('Restore content src/my edit.ts'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Selected Files' }));
    expect(sent(host)).toEqual([
      {
        type: 'checkpoint.restore',
        token: 'tok-1',
        paths: ['src/gone.ts', 'bin/run.sh', 'src/my edit.ts', 'src/risky.ts'],
        andFork: false,
      },
    ]);
  });

  it('restores and branches with the same selection', () => {
    const { host } = open();
    expect(
      screen.getByText('Also starts a branch of that conversation from just before that turn'),
    ).toBeTruthy();
    fireEvent.click(box('Delete src/gone.ts'));
    fireEvent.click(screen.getByRole('button', { name: 'Restore and Branch From Here' }));
    expect(sent(host)).toEqual([
      {
        type: 'checkpoint.restore',
        token: 'tok-1',
        paths: ['src/a.ts', 'bin/run.sh', 'src/risky.ts'],
        andFork: true,
      },
    ]);
  });

  it('hides the branch button without a conversation on the checkpoint', () => {
    const plain = makeCheckpoint('op1');
    renderView([plain], preview({ targetOperationId: plain.operationId }));
    expect(screen.queryByRole('button', { name: 'Restore and Branch From Here' })).toBeNull();
    expect(screen.queryByText(/starts a branch/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Restore Selected Files' })).toBeTruthy();
  });

  it('finds the target among the affected steps when the list does not have it', () => {
    renderWithHost(
      <CheckpointsView now={NOW} />,
      stateWith([], preview({ targetOperationId: target.operationId })),
    );
    expect(screen.getByRole('button', { name: 'Restore and Branch From Here' })).toBeTruthy();
  });

  it('disables restoring when nothing is selected', () => {
    const { host } = open();
    for (const name of [
      'Restore content src/a.ts',
      'Delete src/gone.ts',
      'Restore permissions bin/run.sh',
      'Restore content src/risky.ts',
    ]) {
      fireEvent.click(box(name));
    }
    expect(screen.getByText('0 of 5 files selected')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Restore Selected Files' }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Restore and Branch From Here' })
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Selected Files' }));
    expect(sent(host)).toEqual([]);
  });

  it('says so for an empty preview, and offers only a way back', () => {
    open(preview({ items: [] }));
    expect(screen.getByText('The files are already as they were before that step.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('goes back with Back to history and Cancel', () => {
    const { host } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Back to history' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sent(host)).toEqual([
      { type: 'checkpoint.cancelPreview' },
      { type: 'checkpoint.cancelPreview' },
    ]);
  });

  it('opens the diff of one item', () => {
    const { host } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Diff src/my edit.ts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Diff big.bin' }));
    expect(sent(host)).toEqual([
      { type: 'checkpoint.openDiff', token: 'tok-1', path: 'src/my edit.ts' },
      { type: 'checkpoint.openDiff', token: 'tok-1', path: 'big.bin' },
    ]);
  });

  it('disables the restore buttons, not Diff or Back, while a turn runs', () => {
    const { host } = open(preview(), true);
    const hint = screen.getByText('Wait for the turn to finish.');
    for (const name of ['Restore Selected Files', 'Restore and Branch From Here']) {
      const button = screen.getByRole<HTMLButtonElement>('button', { name });
      expect(button.disabled, name).toBe(true);
      expect(button.getAttribute('aria-describedby')).toContain(hint.id);
    }
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Diff src/a.ts' }).disabled).toBe(
      false,
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Back to history' }).disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Selected Files' }));
    expect(sent(host)).toEqual([]);
  });

  it('gives every button and checkbox a name, specific to its path where it has one', () => {
    open();
    const nameOf = (el: HTMLElement) =>
      el.getAttribute('aria-label') ??
      (el.closest('label')?.textContent ?? el.textContent ?? '').trim();
    for (const el of document.querySelectorAll<HTMLElement>('button, input')) {
      expect(nameOf(el), el.outerHTML).not.toBe('');
    }
    for (const item of items) {
      expect(screen.getByRole('button', { name: `Diff ${item.path}` })).toBeTruthy();
    }
    expect(screen.getAllByRole('list').length).toBeGreaterThan(2);
  });
});
