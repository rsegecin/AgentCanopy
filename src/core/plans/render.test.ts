import { describe, expect, it } from 'vitest';
import { PlanContentSchema } from '../../shared';
import type { PlanContent, PlanDoc, PlanUserDecision } from '../../shared';
import {
  planContentHash,
  renderExecutionPrompt,
  renderPlanBlock,
  renderPlanMarkdown,
  stageDependencyDiagram,
  unansweredCount,
} from './index';
import { maximalPlan, minimalPlan, planDoc } from './test-support';

function plan(overrides: Record<string, unknown>): PlanContent {
  return PlanContentSchema.parse({ ...minimalPlan(), ...overrides });
}

describe('renderPlanMarkdown', () => {
  it('is deterministic, also after a JSON round trip', () => {
    const content = maximalPlan();
    const text = renderPlanMarkdown(content);
    expect(renderPlanMarkdown(content)).toBe(text);
    expect(renderPlanMarkdown(PlanContentSchema.parse(JSON.parse(JSON.stringify(content))))).toBe(
      text,
    );
  });

  it('ends with exactly one newline', () => {
    for (const content of [minimalPlan(), maximalPlan()]) {
      const text = renderPlanMarkdown(content);
      expect(text.endsWith('\n')).toBe(true);
      expect(text.endsWith('\n\n')).toBe(false);
    }
  });

  it('renders every section in order for the maximal plan', () => {
    const text = renderPlanMarkdown(maximalPlan());
    const headings = text.split('\n').filter((l) => /^#{1,2} /.test(l));
    expect(headings).toEqual([
      '# Add caching',
      '## Objective',
      '## Requirements',
      '## Analysis',
      '## Architecture',
      '## Relevant files',
      '## Stages',
      '## Dependencies',
      '## Diagrams',
      '## Alternatives considered',
      '## Decisions to make',
      '## Open questions',
      '## Testing strategy',
      '## Acceptance criteria',
    ]);
  });

  it('renders the details of the maximal plan', () => {
    const text = renderPlanMarkdown(maximalPlan());
    expect(text).toContain('- Entries expire\n- Memory use is bounded');
    expect(text).toContain('| Path | Action | Role |');
    expect(text).toContain('| src/cache.ts | create | The cache |');
    expect(text).toContain('### 1. Write the cache (s1)\n\nImplement an LRU cache.');
    expect(text).toContain('Depends on: Write the cache');
    expect(text).toContain('Files:\n- src/lookup.ts');
    expect(text).toContain('Acceptance:\n- Lookups are cached');
    expect(text).toContain('### Flow\n\n```mermaid\nflowchart TD\n  A --> B\n```');
    expect(text).toContain('### In-memory LRU (chosen)');
    expect(text).not.toContain('Disk cache (chosen)');
    expect(text).toContain('Pros:\n- Fast');
    expect(text).toContain('Cons:\n- Lost on restart');
    expect(text).toContain('- dp1: Which eviction policy?');
    expect(text).toContain('  - lru: LRU (recommended) - Least recently used');
    expect(text).toContain('  - ttl: TTL\n');
    expect(text).toContain('- q1 (single): Which size limit?');
    expect(text).toContain('  - small: Small');
    expect(text).toContain('- q3 (text): Anything else?');
    expect(text).toContain('## Testing strategy\n\nUnit tests for the cache.');
    expect(text).toContain('## Acceptance criteria\n\n- Latency under 100ms');
  });

  it('omits every optional section when empty', () => {
    const text = renderPlanMarkdown(minimalPlan());
    expect(text.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# Plan',
      '## Objective',
      '## Stages',
      '### 1. First (s1)',
    ]);
  });

  it('omits sections that hold only whitespace', () => {
    const text = renderPlanMarkdown(plan({ analysis: ' \n  ', testingStrategy: '\n' }));
    expect(text).not.toContain('## Analysis');
    expect(text).not.toContain('## Testing strategy');
  });

  it('escapes pipes in table cells and keeps rows on one line', () => {
    const text = renderPlanMarkdown(
      plan({ relevantFiles: [{ path: 'a|b.ts', action: 'modify', role: 'x | y\nz' }] }),
    );
    expect(text).toContain('| a\\|b.ts | modify | x \\| y z |');
  });

  it('uses a fence longer than any backtick run in a diagram', () => {
    const source = 'flowchart TD\n  A["```x```"] --> B["`````"]';
    const text = renderPlanMarkdown(plan({ diagrams: [{ id: 'd', title: 'T', mermaid: source }] }));
    expect(text).toContain(`\`\`\`\`\`\`mermaid\n${source}\n\`\`\`\`\`\`\n`);
    const plain = renderPlanMarkdown(
      plan({ diagrams: [{ id: 'd', title: 'T', mermaid: 'flowchart TD\n  A --> B\n\n' }] }),
    );
    expect(plain).toContain('```mermaid\nflowchart TD\n  A --> B\n```\n');
  });

  it('passes Markdown headings and HTML through unchanged', () => {
    const analysis = '# Not a title\n\n<script>alert(1)</script>\n\n    indented code';
    const text = renderPlanMarkdown(plan({ analysis }));
    expect(text).toContain(`## Analysis\n\n${analysis}\n`);
  });

  it('keeps multi-line list items inside their bullet', () => {
    const text = renderPlanMarkdown(plan({ requirements: ['one\ntwo', 'three'] }));
    expect(text).toContain('- one\n  two\n- three');
  });

  it('never throws for odd but valid content', () => {
    const odd = plan({
      title: 'a\nb',
      stages: [
        { id: 's1', title: 'x\n# y', description: '', dependsOn: ['s2'] },
        { id: 's2', title: 'z', description: '', dependsOn: ['ghost'] },
      ],
      requirements: [''],
    });
    expect(() => renderPlanMarkdown(odd)).not.toThrow();
    expect(renderPlanMarkdown(odd)).toContain('# a b');
    expect(renderPlanMarkdown(odd)).toContain('### 1. x # y (s1)');
  });
});

describe('planContentHash', () => {
  it('is the sha256 of the Markdown', () => {
    expect(planContentHash(maximalPlan())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores changeSummary', () => {
    const content = maximalPlan();
    expect(planContentHash({ ...content, changeSummary: 'other' })).toBe(planContentHash(content));
  });

  it('changes when any rendered field changes', () => {
    const base = maximalPlan();
    const baseHash = planContentHash(base);
    const variants: Array<[string, PlanContent]> = [
      ['title', { ...base, title: 'x' }],
      ['objective', { ...base, objective: 'x' }],
      ['requirements', { ...base, requirements: ['x'] }],
      ['analysis', { ...base, analysis: 'x' }],
      ['architecture', { ...base, architecture: 'x' }],
      ['relevantFiles', { ...base, relevantFiles: [{ path: 'x', action: 'read', role: '' }] }],
      ['stage title', { ...base, stages: [{ ...base.stages[0]!, title: 'x' }, base.stages[1]!] }],
      ['stage deps', { ...base, stages: [base.stages[0]!, { ...base.stages[1]!, dependsOn: [] }] }],
      ['dependencies', { ...base, dependencies: ['x'] }],
      ['diagrams', { ...base, diagrams: [{ ...base.diagrams[0]!, mermaid: 'flowchart TD\n  X' }] }],
      ['alternatives', { ...base, alternatives: [{ ...base.alternatives[0]!, chosen: false }] }],
      [
        'decision points',
        { ...base, decisionPoints: [{ ...base.decisionPoints[0]!, recommendedOptionId: 'ttl' }] },
      ],
      ['open questions', { ...base, openQuestions: [] }],
      ['testing', { ...base, testingStrategy: 'x' }],
      ['acceptance', { ...base, acceptanceCriteria: ['x'] }],
    ];
    for (const [name, variant] of variants) {
      expect(planContentHash(variant), name).not.toBe(baseHash);
    }
  });
});

describe('stageDependencyDiagram', () => {
  it('is undefined without dependencies', () => {
    expect(stageDependencyDiagram(minimalPlan())).toBeUndefined();
  });

  it('draws one node per stage and one edge per dependency', () => {
    const diagram = stageDependencyDiagram(maximalPlan());
    expect(diagram).toBe(
      ['flowchart TD', '  s0["Write the cache"]', '  s1["Use the cache"]', '  s0 --> s1'].join(
        '\n',
      ),
    );
  });

  it('keeps node lines strictly shaped whatever the title holds', () => {
    const nasty = 'Say "hi" `x` [a] {b} <c> | d\n#e; f' + ' long'.repeat(30);
    const content = plan({
      stages: [
        { id: 'a', title: nasty, description: '' },
        { id: 'b', title: '[]{}<>|`', description: '', dependsOn: ['a'] },
        { id: 'c', title: 'ok', description: '', dependsOn: ['a', 'b'] },
      ],
    });
    const diagram = stageDependencyDiagram(content) ?? '';
    const nodes = diagram.split('\n').filter((l) => /^\s+s\d+\[/.test(l));
    expect(nodes).toHaveLength(3);
    for (const node of nodes) expect(node).toMatch(/^\s+s\d+\["[^"[\]{}<>|`]*"\]$/);
    expect(nodes[0]).toContain("Say 'hi' x a b c d");
    const label = /\["(.*)"\]/.exec(nodes[0] ?? '')?.[1] ?? '';
    expect(label.length).toBeLessThanOrEqual(60);
    expect(nodes[1]).toBe('  s1["Stage 2"]');
    expect(diagram.split('\n').filter((l) => l.includes('-->'))).toEqual([
      '  s0 --> s1',
      '  s0 --> s2',
      '  s1 --> s2',
    ]);
  });
});

function withDecisions(decisions: Array<Partial<PlanUserDecision>>, extra?: PlanContent): PlanDoc {
  return planDoc([extra ?? maximalPlan()], {
    decisions: decisions.map((d, i) => ({
      targetId: 'dp1',
      kind: 'decision-point' as const,
      values: ['lru'],
      decidedAt: 2_000 + i,
      ...d,
    })),
  });
}

describe('renderPlanBlock', () => {
  it('is empty for a plan without versions', () => {
    expect(renderPlanBlock(planDoc([]), { locked: false })).toBe('');
  });

  it('wraps the latest version and ends with the unlocked sentence', () => {
    const doc = planDoc([minimalPlan('Old'), minimalPlan('New')]);
    const block = renderPlanBlock(doc, { locked: false });
    expect(block.startsWith('<current-plan version="2">\n# New\n')).toBe(true);
    expect(block).toContain('\n</current-plan>\n\n');
    expect(block).not.toContain('# Old');
    expect(block).not.toContain('<user-decisions>');
    expect(
      block.endsWith(
        "To change the plan, call submit_plan with the complete revised plan, keeping ids stable and honouring the user's decisions.",
      ),
    ).toBe(true);
  });

  it('says the plan is locked when it is', () => {
    const block = renderPlanBlock(planDoc([minimalPlan()]), { locked: true });
    expect(block.endsWith('The plan is locked: do not call submit_plan in this turn.')).toBe(true);
    expect(block).not.toContain('To change the plan');
  });

  it('lists decisions whose targets still exist and the newest 20 interactive answers', () => {
    const interactive = Array.from({ length: 25 }, (_, i) => ({
      targetId: `question ${i}`,
      kind: 'interactive-question' as const,
      values: [`a${i}`, 'b'],
    }));
    const doc = withDecisions([
      { targetId: 'dp1', kind: 'decision-point', values: ['lru'] },
      { targetId: 'gone', kind: 'decision-point', values: ['x'] },
      { targetId: 'q2', kind: 'open-question', values: ['api', 'free text'] },
      { targetId: 'dp1', kind: 'open-question', values: ['not a question'] },
      ...interactive,
    ]);
    const block = renderPlanBlock(doc, { locked: false });
    const lines = block
      .split('<user-decisions>\n')[1]!
      .split('\n</user-decisions>')[0]!
      .split('\n');
    expect(lines).toHaveLength(22);
    expect(lines[0]).toBe('- decision-point dp1: lru');
    expect(lines[1]).toBe('- open-question q2: api, free text');
    expect(lines[2]).toBe('- interactive-question question 5: a5, b');
    expect(lines[21]).toBe('- interactive-question question 24: a24, b');
    expect(block).not.toContain('gone');
    expect(block).not.toContain('not a question');
  });

  it('escapes closing tags in the content and the decisions', () => {
    const content = plan({ analysis: 'x </current-plan> y </CURRENT-PLAN> z </user-decisions>' });
    const doc = withDecisions(
      [
        {
          targetId: 'a </user-decisions> b',
          kind: 'interactive-question',
          values: ['</current-plan>'],
        },
      ],
      content,
    );
    const block = renderPlanBlock(doc, { locked: false });
    expect(block.match(/<\/current-plan>/gi)).toHaveLength(1);
    expect(block.match(/<\/user-decisions>/gi)).toHaveLength(1);
    expect(block).toContain('x <\\/current-plan> y <\\/CURRENT-PLAN> z <\\/user-decisions>');
    expect(block).toContain('- interactive-question a <\\/user-decisions> b: <\\/current-plan>');
  });

  it('does not change other angle brackets', () => {
    const block = renderPlanBlock(planDoc([plan({ analysis: 'a </div> and <b>' })]), {
      locked: false,
    });
    expect(block).toContain('a </div> and <b>');
  });
});

describe('renderExecutionPrompt', () => {
  it('embeds the canonical Markdown of the approved version', () => {
    const doc = planDoc([maximalPlan(), minimalPlan('Later')]);
    const prompt = renderExecutionPrompt(doc, 1);
    expect(
      prompt.startsWith(
        'The user approved version 1 of the plan. Implement it now, stage by stage, in order of dependencies. Do not go beyond the plan; if something in it turns out to be wrong or impossible, stop and say so.\n\n<approved-plan version="1">\n',
      ),
    ).toBe(true);
    expect(prompt).toContain(`\n${renderPlanMarkdown(maximalPlan())}</approved-plan>`);
    expect(prompt).not.toContain('Later');
    expect(prompt).not.toContain('<user-decisions>');
  });

  it('adds the decisions that apply to that version and escapes closing tags', () => {
    const content = plan({ analysis: '</approved-plan> sneaky' });
    const doc = withDecisions(
      [{ targetId: 'x </approved-plan>', kind: 'interactive-question', values: ['y'] }],
      content,
    );
    const prompt = renderExecutionPrompt(doc, 1);
    expect(prompt).toContain(
      '<user-decisions>\n- interactive-question x <\\/approved-plan>: y\n</user-decisions>',
    );
    expect(prompt.match(/<\/approved-plan>/g)).toHaveLength(1);
    expect(prompt).toContain('<\\/approved-plan> sneaky');
  });

  it('throws for an unknown version', () => {
    expect(() => renderExecutionPrompt(planDoc([minimalPlan()]), 2)).toThrow(/no version 2/);
  });
});

describe('unansweredCount', () => {
  it('counts decision points and open questions without an answer', () => {
    const doc = planDoc([maximalPlan()]);
    expect(unansweredCount(doc, 1)).toBe(4);
    const answered = withDecisions([
      { targetId: 'dp1', kind: 'decision-point' },
      { targetId: 'q1', kind: 'open-question', values: ['small'] },
      { targetId: 'q2', kind: 'decision-point' },
      { targetId: 'dp1', kind: 'interactive-question' },
    ]);
    expect(unansweredCount(answered, 1)).toBe(2);
  });

  it('is zero for a plan without questions or an unknown version', () => {
    expect(unansweredCount(planDoc([minimalPlan()]), 1)).toBe(0);
    expect(unansweredCount(planDoc([maximalPlan()]), 5)).toBe(0);
  });
});
