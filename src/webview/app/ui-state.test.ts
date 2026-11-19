import { describe, expect, it } from 'vitest';
import { FakeHost } from '../test-support/fixtures';
import { UiState } from './ui-state';

const draft = (label: string) => ({ labels: [label], other: '', otherOn: false });

describe('UiState question drafts', () => {
  it('stores a draft per prompt and question index, filling earlier questions with empty drafts', () => {
    const ui = new UiState(new FakeHost());
    ui.setQuestionDraft('p1', 1, draft('Red'));
    expect(ui.getSnapshot().questions['p1']).toEqual([
      { labels: [], other: '', otherOn: false },
      draft('Red'),
    ]);
    ui.setQuestionDraft('p1', 0, { labels: [], other: 'x', otherOn: true });
    expect(ui.getSnapshot().questions['p1']?.[0]?.other).toBe('x');
    expect(ui.getSnapshot().questions['p1']?.[1]).toEqual(draft('Red'));
  });

  it('notifies subscribers and persists through flush', () => {
    const host = new FakeHost();
    const ui = new UiState(host);
    let calls = 0;
    ui.subscribe(() => {
      calls++;
    });
    ui.setQuestionDraft('p1', 0, draft('Blue'));
    expect(calls).toBe(1);
    ui.flush();
    const restored = new UiState(new FakeHost(host.saved));
    expect(restored.getSnapshot().questions['p1']).toEqual([draft('Blue')]);
  });

  it('keeps only the newest prompts', () => {
    const ui = new UiState(new FakeHost());
    for (let i = 0; i < 35; i++) ui.setQuestionDraft(`p${String(i)}`, 0, draft('a'));
    const keys = Object.keys(ui.getSnapshot().questions);
    expect(keys).toHaveLength(30);
    expect(keys[0]).toBe('p5');
    expect(keys[29]).toBe('p34');
    // Touching an old prompt makes it the newest.
    ui.setQuestionDraft('p5', 0, draft('b'));
    ui.setQuestionDraft('p35', 0, draft('b'));
    expect(Object.keys(ui.getSnapshot().questions)).toContain('p5');
    expect(Object.keys(ui.getSnapshot().questions)).not.toContain('p6');
  });

  it('ignores saved question drafts that have the wrong shape', () => {
    const ui = new UiState(new FakeHost({ tab: 'chat', questions: { p1: 'nonsense' } }));
    expect(ui.getSnapshot().questions).toEqual({});
  });

  it('starts without drafts when nothing was saved', () => {
    expect(new UiState(new FakeHost()).getSnapshot().questions).toEqual({});
  });
});

describe('UiState removed tabs and plan sections', () => {
  it('falls back to the chat tab for the removed plan tab', () => {
    expect(new UiState(new FakeHost({ tab: 'plan' })).getSnapshot().tab).toBe('chat');
    expect(new UiState(new FakeHost({ tab: 'history' })).getSnapshot().tab).toBe('history');
  });

  it('keeps the permissions tab across a reload', () => {
    const host = new FakeHost();
    const ui = new UiState(host);
    ui.setTab('permissions');
    ui.flush();
    expect(host.saved).toMatchObject({ tab: 'permissions' });
    expect(new UiState(new FakeHost(host.saved)).getSnapshot().tab).toBe('permissions');
  });

  it('loads data that still has the removed planClosed key, and does not write it back', () => {
    const host = new FakeHost({ tab: 'chat', planClosed: { plan1: { analysis: true } } });
    const ui = new UiState(host);
    expect(ui.getSnapshot()).not.toHaveProperty('planClosed');
    ui.flush();
    expect(host.saved).not.toHaveProperty('planClosed');
    expect(new UiState(new FakeHost({ planClosed: [1] })).getSnapshot().tab).toBe('chat');
  });
});

describe('UiState review ticks', () => {
  it('ticks and unticks paths, persists them', () => {
    const host = new FakeHost();
    const ui = new UiState(host);
    ui.setReviewInclude('a.ts', true);
    ui.setReviewInclude('b.ts', true);
    ui.setReviewInclude('a.ts', false);
    expect(ui.getSnapshot().reviewInclude).toEqual({ 'b.ts': true });
    ui.flush();
    expect(new UiState(new FakeHost(host.saved)).getSnapshot().reviewInclude).toEqual({
      'b.ts': true,
    });
    expect(new UiState(new FakeHost({ reviewInclude: 'x' })).getSnapshot().reviewInclude).toEqual(
      {},
    );
  });

  it('prunes ticks of paths that are not listed, and does nothing when all are listed', () => {
    const host = new FakeHost();
    const ui = new UiState(host);
    ui.setReviewInclude('a.ts', true);
    ui.setReviewInclude('b.ts', true);
    ui.pruneReviewInclude(['b.ts', 'c.ts']);
    expect(ui.getSnapshot().reviewInclude).toEqual({ 'b.ts': true });
    const before = ui.getSnapshot();
    let notified = 0;
    ui.subscribe(() => notified++);
    ui.pruneReviewInclude(['b.ts']);
    expect(notified).toBe(0);
    expect(ui.getSnapshot()).toBe(before);
    ui.pruneReviewInclude([]);
    expect(ui.getSnapshot().reviewInclude).toEqual({});
  });

  it('falls back to the chat tab for the removed review tab', () => {
    expect(new UiState(new FakeHost({ tab: 'review' })).getSnapshot().tab).toBe('chat');
    expect(new UiState(new FakeHost({ tab: 'checkpoints' })).getSnapshot().tab).toBe('checkpoints');
  });

  it('keeps the strip collapsed state in the expanded map', () => {
    const host = new FakeHost();
    const ui = new UiState(host);
    ui.setExpanded('changes-dock-collapsed', true);
    ui.flush();
    expect(
      new UiState(new FakeHost(host.saved)).getSnapshot().expanded['changes-dock-collapsed'],
    ).toBe(true);
  });
});

describe('UiState restore selection', () => {
  it('records ticks per preview token, keeps the newest five previews and persists', () => {
    const host = new FakeHost();
    const ui = new UiState(host);
    ui.setRestoreSelection('t1', 'a.ts', false);
    ui.setRestoreSelection('t1', 'b.ts', true);
    expect(ui.getSnapshot().restoreSelection).toEqual({ t1: { 'a.ts': false, 'b.ts': true } });
    for (const t of ['t2', 't3', 't4', 't5', 't6']) ui.setRestoreSelection(t, 'a.ts', true);
    expect(Object.keys(ui.getSnapshot().restoreSelection)).toEqual(['t2', 't3', 't4', 't5', 't6']);
    ui.flush();
    expect(
      Object.keys(new UiState(new FakeHost(host.saved)).getSnapshot().restoreSelection),
    ).toHaveLength(5);
    expect(
      new UiState(new FakeHost({ restoreSelection: 3 })).getSnapshot().restoreSelection,
    ).toEqual({});
    expect(new UiState(new FakeHost({ tab: 'checkpoints' })).getSnapshot().tab).toBe('checkpoints');
  });
});
