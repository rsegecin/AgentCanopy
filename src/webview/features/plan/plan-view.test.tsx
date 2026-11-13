// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanContent, PlanDoc, PlanUserDecision } from '../../../shared';
import {
  convId,
  makeActive,
  makePlanContent,
  makePlanDoc,
  makePlanVersion,
  makeState,
  makeTurn,
  planId,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import { resetMermaidForTests } from '../diagram/mermaid-render';
import { PlanView } from './PlanView';
import { diagramLabel, formatTime, stageDiagramSource } from './plan-model';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

beforeEach(() => {
  resetMermaidForTests();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
  mermaid.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>drawn</text></svg>',
  });
});
afterEach(() => {
  delete document.body.dataset.viewKind;
});

const PLAN = planId('plan1');

function stateWith(
  plan: PlanDoc | null,
  extra: Parameters<typeof makeActive>[1] = {},
  locked = false,
) {
  return makeState({
    active: makeActive('c1', { plan, meta: { planLocked: locked }, ...extra }),
  });
}

const renderPlan = (plan: PlanDoc, extra: Parameters<typeof makeActive>[1] = {}, locked = false) =>
  renderWithHost(<PlanView />, stateWith(plan, extra, locked));

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

describe('PlanView without a plan', () => {
  it('says there is no plan', () => {
    renderWithHost(<PlanView />, stateWith(null));
    expect(screen.getByText(/no plan yet/)).toBeTruthy();
  });
});

describe('PlanView sections', () => {
  it('shows the title as h1 and every section of a maximal plan as an h2, in order', () => {
    renderPlan(
      makePlanDoc({
        decisions: [decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'] })],
      }),
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Add caching');
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Objective',
      'Requirements',
      'Analysis',
      'Architecture',
      'Relevant files',
      'Stages',
      'Dependencies',
      'Diagrams',
      'Alternatives considered',
      'Decisions to make',
      'Open questions',
      'Testing strategy',
      'Acceptance criteria',
      'Your decisions',
    ]);
  });

  it('puts every h2 in a named region and keeps h3 under their h2', () => {
    renderPlan(makePlanDoc());
    for (const section of document.querySelectorAll('section.plan-section')) {
      const heading = section.querySelector('h2');
      expect(heading).not.toBeNull();
      expect(section.getAttribute('aria-labelledby')).toBe(heading?.id);
    }
    const levels = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) =>
      Number(h.tagName.slice(1)),
    );
    expect(levels[0]).toBe(1);
    levels.forEach((level, i) => {
      if (i > 0) expect(level - (levels[i - 1] as number)).toBeLessThanOrEqual(1);
    });
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThan(0);
  });

  it('shows the content of each section', () => {
    renderPlan(makePlanDoc());
    expect(screen.getByText('reads').tagName).toBe('STRONG');
    expect(screen.getByText('Keep the API')).toBeTruthy();
    expect(screen.getByText('A small cache in front of the store.')).toBeTruthy();
    expect(screen.getByText('lru-cache')).toBeTruthy();
    expect(screen.getByText('Unit tests and a soak test.')).toBeTruthy();
    expect(screen.getByText('Reads are 2x faster')).toBeTruthy();
    expect(screen.getByText('Use Redis')).toBeTruthy();
    expect(screen.getByText('Followed by the plan')).toBeTruthy();
    expect(screen.getByText('New service')).toBeTruthy();
  });

  it('omits every empty section', () => {
    const empty: Partial<PlanContent> = {
      requirements: [],
      analysis: '',
      architecture: '',
      relevantFiles: [],
      dependencies: [],
      diagrams: [],
      alternatives: [],
      decisionPoints: [],
      openQuestions: [],
      testingStrategy: '',
      acceptanceCriteria: [],
    };
    renderPlan(
      makePlanDoc({ versions: [makePlanVersion(1, { content: makePlanContent(empty) })] }),
    );
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Objective',
      'Stages',
    ]);
  });

  it('shows the relevant files as a table whose paths open the file', () => {
    const { host } = renderPlan(makePlanDoc());
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((c) => c.textContent),
    ).toEqual(['Path', 'Action', 'Role']);
    expect(within(table).getByText('Create')).toBeTruthy();
    fireEvent.click(within(table).getByRole('link', { name: 'src/store.ts' }));
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: 'src/store.ts' }]);
  });

  it('collapses a section, remembers it per plan and restores it after a reload', () => {
    const first = renderPlan(makePlanDoc());
    const toggle = screen.getByRole('button', { name: 'Requirements' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Keep the API')).toBeNull();
    expect(first.services.ui.getSnapshot().planClosed).toEqual({ plan1: { requirements: true } });
    first.services.ui.flush();
    const saved = first.host.saved;
    first.unmount();

    renderWithHost(<PlanView />, stateWith(makePlanDoc()), saved);
    expect(screen.getByRole('button', { name: 'Requirements' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: 'Objective' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Requirements' }));
    expect(screen.getByText('Keep the API')).toBeTruthy();
  });
});

describe('PlanView stages', () => {
  it('lists the stages in order with dependencies as chips, files as links and acceptance', () => {
    const { host } = renderPlan(makePlanDoc());
    const items = screen
      .getAllByRole('listitem')
      .filter((li) => li.classList.contains('plan-stage'));
    expect(items.map((li) => li.querySelector('h3')?.textContent)).toEqual([
      'Build the cache',
      'Wire it in',
    ]);
    const second = items[1] as HTMLElement;
    expect(within(second).getByText('Depends on')).toBeTruthy();
    const chips = within(second).getByRole('list', {
      name: 'Stages that Wire it in depends on',
    });
    expect(within(chips).getByText('Build the cache')).toBeTruthy();
    expect(within(second).getByText('Reads hit the cache')).toBeTruthy();
    fireEvent.click(within(second).getByRole('link', { name: 'src/store.ts' }));
    expect(host.postedOf('open.file')).toEqual([{ type: 'open.file', path: 'src/store.ts' }]);
    expect(within(items[0] as HTMLElement).queryByText('Depends on')).toBeNull();
  });

  it('draws a dependency diagram above the list, with the list as its text alternative', async () => {
    renderPlan(
      makePlanDoc({
        versions: [makePlanVersion(1, { content: makePlanContent({ diagrams: [] }) })],
      }),
    );
    const picture = await screen.findByRole('img', { name: 'Stage dependencies' });
    const list = document.getElementById(picture.getAttribute('aria-describedby') ?? '');
    expect(list?.tagName).toBe('OL');
    expect(list?.classList.contains('plan-stages')).toBe(true);
    expect(
      picture.compareDocumentPosition(list as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(mermaid.render.mock.calls[0]?.[1]).toBe(
      ['flowchart TD', '  s1["Build the cache"]', '  s2["Wire it in"]', '  s1 --> s2'].join('\n'),
    );
  });

  it('draws no dependency diagram when no stage depends on another', async () => {
    const stages = makePlanContent().stages.map((s) => ({ ...s, dependsOn: [] }));
    renderPlan(
      makePlanDoc({
        versions: [makePlanVersion(1, { content: makePlanContent({ stages, diagrams: [] }) })],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('draws the diagrams of the plan with their titles', async () => {
    renderPlan(makePlanDoc());
    expect(await screen.findByRole('img', { name: 'Read flow' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Read flow' })).toBeTruthy();
  });
});

describe('stage diagram source', () => {
  const nodeLine = /^\s+s\d+\["[^"[\]{}<>|`]*"\]$/;
  const edgeLine = /^\s+s\d+ --> s\d+$/;

  it('turns titles full of special characters into safe node lines', () => {
    const nasty = [
      'Plain',
      'Back`tick `code`',
      'Brackets [a] {b} <c> |d|',
      'Quote "x" and "y"',
      'Line\nbreak\r\nagain',
      'x'.repeat(200),
      '"]\n  s9 --> s1\n  s1["injected',
      '`[]{}<>|`',
    ];
    const stages = nasty.map((title, i) => ({
      id: `st${String(i)}`,
      title,
      description: '',
      files: [],
      dependsOn: i > 0 ? [`st${String(i - 1)}`, 'unknown'] : [],
      acceptance: [],
    }));
    const lines = stageDiagramSource(stages).split('\n');
    expect(lines[0]).toBe('flowchart TD');
    const body = lines.slice(1);
    expect(body).toHaveLength(nasty.length * 2 - 1);
    for (const line of body) expect(nodeLine.test(line) || edgeLine.test(line), line).toBe(true);
    expect(body.filter((l) => nodeLine.test(l))).toHaveLength(nasty.length);
    expect(body.filter((l) => edgeLine.test(l))).toHaveLength(nasty.length - 1);
  });

  it('sanitises a label exactly as specified', () => {
    expect(diagramLabel('a`b[c]d{e}f<g>h|i\nj"k"')).toBe("abcdefghi j'k'");
    expect(diagramLabel('y'.repeat(100))).toHaveLength(60);
  });

  it('names a stage whose title is only special characters', () => {
    const [, node] = stageDiagramSource([
      { id: 'a', title: '[]', description: '', files: [], dependsOn: [], acceptance: [] },
    ]).split('\n');
    expect(node).toBe('  s1["Stage 1"]');
  });
});

describe('PlanView versions', () => {
  const picker = () => screen.getByRole<HTMLSelectElement>('combobox', { name: 'Version' });

  it('shows the latest version, and lists all with author and time', () => {
    renderPlan(twoVersions());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New title');
    expect(picker().value).toBe('2');
    const labels = Array.from(picker().options).map((o) => o.textContent);
    expect(labels).toEqual([
      `Version 2 (You, ${formatTime(1_700_000_120_000)})`,
      `Version 1 (Agent, ${formatTime(1_700_000_060_000)})`,
    ]);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows an older version with a notice, and can come back', () => {
    renderPlan(twoVersions());
    fireEvent.change(picker(), { target: { value: '1' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Old title');
    expect(screen.getByText('Old objective')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toBe(
      'You are viewing version 1. The latest is version 2.',
    );
    fireEvent.change(picker(), { target: { value: '2' } });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New title');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('notes where a version was restored from', () => {
    renderPlan(
      makePlanDoc({
        versions: [makePlanVersion(1), makePlanVersion(2, { restoredFrom: 1 })],
      }),
    );
    expect(Array.from(picker().options)[0]?.textContent).toContain('restored from 1');
  });

  it('follows the host when a newer version arrives while the latest is shown', () => {
    const h = renderPlan(makePlanDoc());
    h.init(stateWith(twoVersions()), 1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('New title');
  });

  it('has no version-dependent controls for a single version', () => {
    renderPlan(makePlanDoc());
    expect(screen.queryByRole('combobox', { name: 'Compare with…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revert to this version' })).toBeNull();
  });
});

describe('PlanView header actions', () => {
  it('compares another version with the shown one', () => {
    const { host } = renderPlan(twoVersions());
    const compare = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Compare with…' });
    expect(Array.from(compare.options).map((o) => o.textContent)).toEqual([
      'Compare with…',
      'Version 1',
    ]);
    fireEvent.change(compare, { target: { value: '1' } });
    expect(host.postedOf('plan.compare')).toEqual([
      { type: 'plan.compare', planId: PLAN, left: 1, right: 2 },
    ]);
    // The select goes back to its prompt, so the same version can be chosen again.
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Compare with…' }).value).toBe(
      '',
    );
  });

  it('compares with the version being viewed as the right side', () => {
    const { host } = renderPlan(twoVersions());
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Compare with…' }), {
      target: { value: '2' },
    });
    expect(host.postedOf('plan.compare')).toEqual([
      { type: 'plan.compare', planId: PLAN, left: 2, right: 1 },
    ]);
  });

  it('reverts only from an older version', () => {
    const { host } = renderPlan(twoVersions());
    expect(screen.queryByRole('button', { name: 'Revert to this version' })).toBeNull();
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Revert to this version' }));
    expect(host.postedOf('plan.revert')).toEqual([
      { type: 'plan.revert', planId: PLAN, version: 1 },
    ]);
  });

  it('exports the version being shown', () => {
    const { host } = renderPlan(twoVersions());
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(host.postedOf('plan.export')).toEqual([
      { type: 'plan.export', planId: PLAN, version: 2 },
      { type: 'plan.export', planId: PLAN, version: 1 },
    ]);
  });

  it('opens the plan in an editor, except in an editor panel', () => {
    const first = renderPlan(makePlanDoc());
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(first.host.postedOf('plan.openInEditor')).toEqual([
      { type: 'plan.openInEditor', planId: PLAN },
    ]);
    first.unmount();
    document.body.dataset.viewKind = 'panel';
    renderPlan(makePlanDoc());
    expect(screen.queryByRole('button', { name: 'Open in editor' })).toBeNull();
  });

  it('toggles the lock, with the explanation as tooltip and as text', () => {
    const { host, init } = renderPlan(makePlanDoc());
    const hint =
      'While locked, the agent can answer questions about the plan but cannot change it.';
    const toggle = screen.getByRole('button', { name: 'Locked' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.getAttribute('title')).toBe(hint);
    expect(screen.getByText(hint).tagName).toBe('P');
    fireEvent.click(toggle);
    expect(host.postedOf('plan.setLocked')).toEqual([
      { type: 'plan.setLocked', conversationId: convId('c1'), locked: true },
    ]);
    // The host owns the state: the button follows it.
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    init(stateWith(makePlanDoc(), {}, true), 1);
    expect(screen.getByRole('button', { name: 'Locked' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Locked' }));
    expect(host.postedOf('plan.setLocked')[1]).toEqual({
      type: 'plan.setLocked',
      conversationId: convId('c1'),
      locked: false,
    });
  });
});

describe('PlanView decision points', () => {
  const group = () => screen.getByRole('radiogroup', { name: 'Which eviction policy?' });

  it('shows option cards with description and a Recommended tag', () => {
    renderPlan(makePlanDoc());
    const lru = within(group()).getByRole('radio', { name: 'LRU' });
    expect(lru.getAttribute('aria-describedby')).toBeTruthy();
    expect(within(group()).getByText('Least recently used')).toBeTruthy();
    expect(within(group()).getAllByText('Recommended')).toHaveLength(1);
    expect(within(group()).queryByText('Your choice')).toBeNull();
    expect(
      within(group())
        .getAllByRole('radio')
        .every((r) => !(r as HTMLInputElement).checked),
    ).toBe(true);
  });

  it('posts the chosen option id', () => {
    const { host } = renderPlan(makePlanDoc());
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

  it('shows the recorded choice as Your choice and checks it', () => {
    const { init } = renderPlan(makePlanDoc());
    init(
      stateWith(
        makePlanDoc({
          decisions: [decision({ targetId: 'eviction', kind: 'decision-point', values: ['ttl'] })],
        }),
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
  });

  it('uses the newest answer when several are recorded', () => {
    renderPlan(
      makePlanDoc({
        decisions: [
          decision({ targetId: 'eviction', kind: 'decision-point', values: ['ttl'], decidedAt: 5 }),
          decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'], decidedAt: 9 }),
        ],
      }),
    );
    expect(within(group()).getByRole<HTMLInputElement>('radio', { name: 'LRU' }).checked).toBe(
      true,
    );
  });

  it('does not mix up a decision point and an open question with the same id', () => {
    renderPlan(
      makePlanDoc({
        decisions: [decision({ targetId: 'eviction', kind: 'open-question', values: ['lru'] })],
      }),
    );
    expect(within(group()).getByRole<HTMLInputElement>('radio', { name: 'LRU' }).checked).toBe(
      false,
    );
  });
});

describe('PlanView open questions', () => {
  it('single choice posts the option id', () => {
    const { host } = renderPlan(makePlanDoc());
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
    const { host } = renderPlan(makePlanDoc());
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
    const { host } = renderPlan(makePlanDoc());
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

  it('shows the recorded answers and when they were given', () => {
    renderPlan(
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
    );
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Small' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Org' }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'User' }).checked).toBe(false);
    expect(
      screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your answer to: Anything else?' })
        .value,
    ).toBe('Mind the memory.');
    expect(screen.getAllByText(`Answered ${formatTime(1_700_000_300_000)}`)).toHaveLength(1);
    expect(document.querySelectorAll('.plan-recorded')).toHaveLength(3);
  });

  it('is read-only on an older version', () => {
    const doc = twoVersions();
    const { host } = renderPlan(doc);
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
    for (const input of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      '.plan-decision input, .plan-decision textarea',
    )) {
      expect(input.disabled).toBe(true);
    }
    expect(screen.queryByRole('button', { name: /^Save answer/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'Large' }));
    fireEvent.click(screen.getByRole('radio', { name: 'TTL' }));
    expect(host.postedOf('plan.decide')).toEqual([]);
  });
});

describe('PlanView Your decisions', () => {
  it('lists every decision with its question and values, and the orphans separately', () => {
    renderPlan(
      makePlanDoc({
        decisions: [
          decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'], decidedAt: 1 }),
          decision({
            targetId: 'keys',
            kind: 'open-question',
            values: ['user', 'org'],
            decidedAt: 2,
          }),
          decision({
            targetId: 'Which colour?',
            kind: 'interactive-question',
            values: ['Red'],
            decidedAt: 3,
          }),
          decision({ targetId: 'gone-point', kind: 'decision-point', values: ['a'], decidedAt: 4 }),
          decision({
            targetId: 'gone-question',
            kind: 'open-question',
            values: ['free'],
            decidedAt: 5,
          }),
        ],
      }),
    );
    const section = screen.getByRole('region', { name: 'Your decisions' });
    const items = within(section).getAllByRole('listitem');
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
    const orphanHeading = within(section).getByRole('heading', {
      level: 3,
      name: 'No longer in the plan',
    });
    const orphanList = orphanHeading.nextElementSibling as HTMLElement;
    expect(within(orphanList).getAllByRole('listitem')).toHaveLength(2);
    expect(within(orphanList).getByText('gone-point')).toBeTruthy();
  });

  it('shows no orphan group when everything is still in the plan, and no section without decisions', () => {
    const first = renderPlan(
      makePlanDoc({
        decisions: [decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'] })],
      }),
    );
    expect(screen.queryByText('No longer in the plan')).toBeNull();
    first.unmount();
    renderPlan(makePlanDoc());
    expect(screen.queryByRole('region', { name: 'Your decisions' })).toBeNull();
  });

  it('judges orphans against the latest version, also while an older one is shown', () => {
    const doc = twoVersions();
    doc.versions[1] = makePlanVersion(2, {
      content: makePlanContent({ decisionPoints: [], openQuestions: [] }),
    });
    doc.decisions = [decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'] })];
    renderPlan(doc);
    expect(screen.getByText('No longer in the plan')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
    expect(screen.getByText('No longer in the plan')).toBeTruthy();
  });
});

describe('PlanView approval', () => {
  const approve = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: /^Approve and execute version/ });
  const answeredAll = [
    decision({ targetId: 'eviction', kind: 'decision-point', values: ['lru'] }),
    decision({ targetId: 'size', kind: 'open-question', values: ['small'] }),
    decision({ targetId: 'keys', kind: 'open-question', values: ['user'] }),
    decision({ targetId: 'notes', kind: 'open-question', values: ['x'] }),
  ];

  it('posts the version and its content hash', () => {
    const { host } = renderPlan(twoVersions());
    expect(approve().textContent).toBe('Approve and execute version 2');
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toEqual([
      { type: 'plan.approve', planId: PLAN, version: 2, contentHash: 'hash-v2' },
    ]);
  });

  it('is absent while an older version is shown', () => {
    renderPlan(twoVersions());
    fireEvent.change(screen.getByRole('combobox', { name: 'Version' }), { target: { value: '1' } });
    expect(screen.queryByRole('button', { name: /Approve and execute/ })).toBeNull();
  });

  it('is disabled with an explanation while a turn runs', () => {
    const { host } = renderPlan(makePlanDoc(), { turns: [makeTurn({ status: 'running' })] });
    expect(approve().disabled).toBe(true);
    const ids = (approve().getAttribute('aria-describedby') ?? '').split(' ');
    const texts = ids.map((id) => document.getElementById(id)?.textContent ?? '');
    expect(texts.join(' ')).toMatch(/A turn is running/);
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toEqual([]);
  });

  it('is enabled when the last turn is over', () => {
    renderPlan(makePlanDoc({ decisions: answeredAll }), { turns: [makeTurn()] });
    expect(approve().disabled).toBe(false);
    expect(screen.queryByText(/have no answer yet|has no answer yet/)).toBeNull();
  });

  it('warns about unanswered questions and decisions but stays enabled', () => {
    const { host } = renderPlan(makePlanDoc({ decisions: [answeredAll[0] as PlanUserDecision] }));
    const warning = screen.getByText('3 questions or decisions have no answer yet');
    expect(approve().disabled).toBe(false);
    expect(approve().getAttribute('aria-describedby')).toContain(warning.closest('p')?.id ?? '?');
    fireEvent.click(approve());
    expect(host.postedOf('plan.approve')).toHaveLength(1);
  });

  it('says "1 question or decision has no answer yet" for one', () => {
    renderPlan(makePlanDoc({ decisions: answeredAll.slice(0, 3) }));
    expect(screen.getByText('1 question or decision has no answer yet')).toBeTruthy();
  });

  it('lists the approvals recorded for the shown version', () => {
    renderPlan(
      makePlanDoc({
        versions: [makePlanVersion(1), makePlanVersion(2)],
        approvals: [
          { version: 2, contentHash: 'hash-v2', approvedAt: 1_700_000_900_000 },
          { version: 2, contentHash: 'hash-v2', approvedAt: 1_700_001_000_000 },
          { version: 1, contentHash: 'hash-v1', approvedAt: 1_600_000_000_000 },
        ],
      }),
    );
    expect(screen.getAllByText(/^Approved on /).map((li) => li.textContent)).toEqual([
      `Approved on ${formatTime(1_700_000_900_000)}`,
      `Approved on ${formatTime(1_700_001_000_000)}`,
    ]);
  });
});

describe('PlanView accessibility', () => {
  it('gives every button and control an accessible name', () => {
    renderPlan(makePlanDoc({ versions: [makePlanVersion(1), makePlanVersion(2)] }));
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
    for (const el of document.querySelectorAll<HTMLElement>('button, input, select, textarea')) {
      expect(nameOf(el).trim(), el.outerHTML).not.toBe('');
    }
    for (const group of screen.getAllByRole('radiogroup')) {
      expect(group.getAttribute('aria-labelledby')).toBeTruthy();
    }
    for (const group of document.querySelectorAll('.plan-decision [role="group"]')) {
      expect(group.getAttribute('aria-labelledby')).toBeTruthy();
    }
  });

  it('exposes the collapsible headings as buttons with aria-expanded and aria-controls', () => {
    renderPlan(makePlanDoc());
    for (const heading of screen.getAllByRole('heading', { level: 2 })) {
      const button = within(heading).getByRole('button');
      expect(button.getAttribute('aria-expanded')).toBe('true');
      expect(document.getElementById(button.getAttribute('aria-controls') ?? '')).not.toBeNull();
    }
  });

  it('waits for diagrams without blocking the rest of the view', async () => {
    renderPlan(makePlanDoc());
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getAllByRole('img')).toHaveLength(2);
    });
  });
});
