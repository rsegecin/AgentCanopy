import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanId } from '../../shared';
import { createPlanStore } from './index';
import type { PlanStore } from './index';
import { CONVERSATION, fakeClock, makeTempDir, maximalInput, minimalInput } from './test-support';

let dir: string;
let store: PlanStore;
beforeEach(async () => {
  dir = await makeTempDir();
  store = createPlanStore({ dir, clock: fakeClock() });
  await store.init();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const PREFIX = 'The plan was not saved because it is not valid:';
const SUFFIX = 'Fix these and call submit_plan again with the complete plan.';

async function rejection(raw: unknown): Promise<string> {
  const result = await store.submit({ conversationId: CONVERSATION, raw });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a failure');
  return result.message;
}

function problems(message: string): string[] {
  const lines = message.split('\n');
  expect(lines[0]).toBe(PREFIX);
  expect(lines[lines.length - 1]).toBe(SUFFIX);
  return lines.slice(1, -1);
}

function withStages(stages: unknown[]): Record<string, unknown> {
  return { ...minimalInput(), stages };
}

const stage = (id: string, dependsOn: string[] = []) => ({
  id,
  title: `Stage ${id}`,
  description: '',
  dependsOn,
});

describe('submit: versions', () => {
  it('creates a plan with version 1', async () => {
    const result = await store.submit({ conversationId: CONVERSATION, raw: minimalInput() });
    if (!result.ok) throw new Error(result.message);
    expect(result.version).toBe(1);
    expect(result.unchanged).toBe(false);
    expect(result.plan.conversationId).toBe(CONVERSATION);
    expect(result.plan.versions).toHaveLength(1);
    expect(result.plan.versions[0]).toMatchObject({
      version: 1,
      author: 'agent',
      createdAt: 1_000,
    });
    expect(result.plan.versions[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.get(result.plan.id)).toEqual(result.plan);
  });

  it('appends a second version', async () => {
    const first = await store.submit({ conversationId: CONVERSATION, raw: minimalInput('A') });
    if (!first.ok) throw new Error(first.message);
    const second = await store.submit({
      conversationId: CONVERSATION,
      planId: first.plan.id,
      raw: minimalInput('B'),
    });
    if (!second.ok) throw new Error(second.message);
    expect(second.version).toBe(2);
    expect(second.unchanged).toBe(false);
    expect(second.plan.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(second.plan.versions[0]?.content.title).toBe('A');
  });

  it('appends nothing when the content is unchanged', async () => {
    const first = await store.submit({ conversationId: CONVERSATION, raw: maximalInput() });
    if (!first.ok) throw new Error(first.message);
    const again = await store.submit({
      conversationId: CONVERSATION,
      planId: first.plan.id,
      raw: maximalInput(),
    });
    if (!again.ok) throw new Error(again.message);
    expect(again.unchanged).toBe(true);
    expect(again.version).toBe(1);
    expect(again.plan.versions).toHaveLength(1);
  });

  it('treats a change of only changeSummary as unchanged', async () => {
    const first = await store.submit({ conversationId: CONVERSATION, raw: maximalInput() });
    if (!first.ok) throw new Error(first.message);
    const again = await store.submit({
      conversationId: CONVERSATION,
      planId: first.plan.id,
      raw: { ...maximalInput(), changeSummary: 'Something else' },
    });
    if (!again.ok) throw new Error(again.message);
    expect(again.unchanged).toBe(true);
    expect(again.plan.versions).toHaveLength(1);
  });

  it('rejects an unknown plan id', async () => {
    await expect(
      store.submit({
        conversationId: CONVERSATION,
        planId: 'missing' as PlanId,
        raw: minimalInput(),
      }),
    ).rejects.toThrow(/Unknown plan/);
  });
});

describe('submit: schema failures', () => {
  it('names a missing title', async () => {
    const input = minimalInput();
    delete input.title;
    const lines = problems(await rejection(input));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^- title: /);
  });

  it('rejects empty stages', async () => {
    const lines = problems(await rejection({ ...minimalInput(), stages: [] }));
    expect(lines[0]).toMatch(/^- stages: /);
  });

  it('rejects bad id characters with the full path', async () => {
    const lines = problems(
      await rejection(withStages([{ id: 'bad id!', title: 'T', description: '' }])),
    );
    expect(lines[0]).toMatch(/^- stages\[0\]\.id: /);
    expect(lines[0]).toContain('letters, digits');
  });

  it('reports a wrong type deep inside', async () => {
    const input = maximalInput();
    (
      input.decisionPoints as Array<{ options: Array<Record<string, unknown>> }>
    )[0]!.options[1]!.label = 42;
    const lines = problems(await rejection(input));
    expect(lines).toEqual([expect.stringMatching(/^- decisionPoints\[0\]\.options\[1\]\.label: /)]);
  });

  it.each([null, 'a plan', ['x'], 42, undefined])('rejects garbage input %j', async (raw) => {
    const lines = problems(await rejection(raw));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^- \S+: /);
  });

  it('caps the list at 10 lines', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: '!',
      title: `T${i}`,
      description: '',
    }));
    const lines = problems(await rejection(withStages(many)));
    expect(lines).toHaveLength(10);
  });

  it('does not save anything on failure', async () => {
    await rejection(null);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.json'))).toEqual([]);
  });
});

describe('submit: semantic checks', () => {
  it('rejects duplicate stage ids', async () => {
    const lines = problems(await rejection(withStages([stage('a'), stage('a')])));
    expect(lines).toEqual(['- stages[1].id: duplicate stage id "a"']);
  });

  it('rejects duplicate diagram ids', async () => {
    const diagram = { id: 'd', title: 'D', mermaid: 'flowchart TD\n A-->B' };
    const lines = problems(await rejection({ ...minimalInput(), diagrams: [diagram, diagram] }));
    expect(lines).toEqual(['- diagrams[1].id: duplicate diagram id "d"']);
  });

  it('rejects duplicate alternative ids', async () => {
    const alternative = { id: 'x', title: 'X', summary: '' };
    const lines = problems(
      await rejection({ ...minimalInput(), alternatives: [alternative, alternative] }),
    );
    expect(lines).toEqual(['- alternatives[1].id: duplicate alternative id "x"']);
  });

  it('rejects duplicate decision point ids and duplicate option ids', async () => {
    const options = [
      { id: 'o', label: 'One' },
      { id: 'o', label: 'Two' },
    ];
    const point = { id: 'p', question: 'Q', options };
    const lines = problems(await rejection({ ...minimalInput(), decisionPoints: [point, point] }));
    expect(lines).toContain('- decisionPoints[1].id: duplicate decision point id "p"');
    expect(lines).toContain('- decisionPoints[0].options[1].id: duplicate option id "o"');
  });

  it('rejects duplicate open question ids and duplicate option ids', async () => {
    const question = {
      id: 'q',
      question: 'Q',
      kind: 'single',
      options: [
        { id: 'o', label: 'One' },
        { id: 'o', label: 'Two' },
      ],
    };
    const lines = problems(
      await rejection({ ...minimalInput(), openQuestions: [question, question] }),
    );
    expect(lines).toContain('- openQuestions[1].id: duplicate open question id "q"');
    expect(lines).toContain('- openQuestions[0].options[1].id: duplicate option id "o"');
  });

  it('allows the same id in different lists', async () => {
    const input = {
      ...minimalInput(),
      diagrams: [{ id: 's1', title: 'D', mermaid: 'flowchart TD\n A-->B' }],
    };
    expect((await store.submit({ conversationId: CONVERSATION, raw: input })).ok).toBe(true);
  });

  it('rejects a dependency on an unknown stage', async () => {
    const lines = problems(await rejection(withStages([stage('a', ['nope'])])));
    expect(lines).toEqual(['- stages[0].dependsOn[0]: no stage has the id "nope"']);
  });

  it('rejects a stage that depends on itself', async () => {
    const lines = problems(await rejection(withStages([stage('a', ['a'])])));
    expect(lines).toEqual(['- stages[0].dependsOn[0]: a stage cannot depend on itself']);
  });

  it('names one dependency cycle', async () => {
    const lines = problems(
      await rejection(
        withStages([stage('a', ['c']), stage('b', ['a']), stage('c', ['b']), stage('d')]),
      ),
    );
    expect(lines).toEqual(['- stages: dependency cycle a -> c -> b -> a']);
  });

  it('accepts a diamond-shaped graph', async () => {
    const stages = [stage('a'), stage('b', ['a']), stage('c', ['a']), stage('d', ['b', 'c'])];
    expect((await store.submit({ conversationId: CONVERSATION, raw: withStages(stages) })).ok).toBe(
      true,
    );
  });

  it('rejects a recommended option that is not an option', async () => {
    const point = {
      id: 'p',
      question: 'Q',
      options: [
        { id: 'a', label: 'A' },
        { id: 'b', label: 'B' },
      ],
      recommendedOptionId: 'zzz',
    };
    const lines = problems(await rejection({ ...minimalInput(), decisionPoints: [point] }));
    expect(lines).toEqual([
      '- decisionPoints[0].recommendedOptionId: "zzz" is not an option of this decision point',
    ]);
  });

  it.each(['single', 'multi'])(
    'rejects a %s question with fewer than two options',
    async (kind) => {
      const question = { id: 'q', question: 'Q', kind, options: [{ id: 'a', label: 'A' }] };
      const lines = problems(await rejection({ ...minimalInput(), openQuestions: [question] }));
      expect(lines).toEqual([
        `- openQuestions[0].options: a ${kind} question needs at least two options`,
      ]);
    },
  );

  it('accepts a text question without options', async () => {
    const question = { id: 'q', question: 'Q', kind: 'text' };
    const result = await store.submit({
      conversationId: CONVERSATION,
      raw: { ...minimalInput(), openQuestions: [question] },
    });
    expect(result.ok).toBe(true);
  });

  it('keeps the plan file out of the directory when a semantic check fails', async () => {
    await rejection(withStages([stage('a'), stage('a')]));
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
