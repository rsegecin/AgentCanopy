import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanContentSchema } from '../../shared';
import type { ConversationId, PlanContent, PlanDoc, PlanId } from '../../shared';
import type { Clock } from '../contracts/ports';

/** Helpers for the plan tests. Not part of the module's public surface. */

export const CONVERSATION = 'conv-1' as ConversationId;

export async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'agc-plans-'));
}

export function fakeClock(start = 1_000): Clock & { advance(ms?: number): void } {
  let now = start;
  return {
    now: () => now,
    advance(ms = 1) {
      now += ms;
    },
  };
}

/** The smallest valid input, as the model would send it. */
export function minimalInput(title = 'Plan'): Record<string, unknown> {
  return {
    title,
    objective: 'Do the thing',
    stages: [{ id: 's1', title: 'First', description: '' }],
  };
}

export function minimalPlan(title = 'Plan'): PlanContent {
  return PlanContentSchema.parse(minimalInput(title));
}

/** Input that uses every field. */
export function maximalInput(): Record<string, unknown> {
  return {
    title: 'Add caching',
    objective: 'Cache the results of slow lookups.',
    requirements: ['Entries expire', 'Memory use is bounded'],
    analysis: 'Lookups take 2s.\n\nThey are repeated.',
    architecture: 'A cache in front of the lookup.',
    relevantFiles: [
      { path: 'src/cache.ts', action: 'create', role: 'The cache' },
      { path: 'src/lookup.ts', action: 'modify', role: 'Uses the cache' },
      { path: 'src/old.ts', action: 'delete', role: 'Superseded' },
      { path: 'src/types.ts', action: 'read', role: 'Shared types' },
    ],
    stages: [
      {
        id: 's1',
        title: 'Write the cache',
        description: 'Implement an LRU cache.',
        files: ['src/cache.ts'],
        dependsOn: [],
        acceptance: ['Unit tests pass'],
      },
      {
        id: 's2',
        title: 'Use the cache',
        description: 'Wire it in.',
        files: ['src/lookup.ts'],
        dependsOn: ['s1'],
        acceptance: ['Lookups are cached'],
      },
    ],
    dependencies: ['lru-cache 10'],
    diagrams: [{ id: 'd1', title: 'Flow', mermaid: 'flowchart TD\n  A --> B' }],
    alternatives: [
      {
        id: 'a1',
        title: 'In-memory LRU',
        summary: 'Simple.',
        pros: ['Fast'],
        cons: ['Lost on restart'],
        chosen: true,
      },
      { id: 'a2', title: 'Disk cache', summary: 'Durable.', pros: ['Persistent'], cons: ['Slow'] },
    ],
    decisionPoints: [
      {
        id: 'dp1',
        question: 'Which eviction policy?',
        options: [
          { id: 'lru', label: 'LRU', description: 'Least recently used' },
          { id: 'ttl', label: 'TTL' },
        ],
        recommendedOptionId: 'lru',
      },
    ],
    openQuestions: [
      {
        id: 'q1',
        question: 'Which size limit?',
        kind: 'single',
        options: [
          { id: 'small', label: 'Small' },
          { id: 'large', label: 'Large' },
        ],
      },
      {
        id: 'q2',
        question: 'Which layers?',
        kind: 'multi',
        options: [
          { id: 'api', label: 'API' },
          { id: 'ui', label: 'UI' },
        ],
      },
      { id: 'q3', question: 'Anything else?', kind: 'text' },
    ],
    testingStrategy: 'Unit tests for the cache.',
    acceptanceCriteria: ['Latency under 100ms'],
    changeSummary: 'Added the cache.',
  };
}

export function maximalPlan(): PlanContent {
  return PlanContentSchema.parse(maximalInput());
}

/** A plan document built directly, without the store. */
export function planDoc(contents: PlanContent[], extra: Partial<PlanDoc> = {}): PlanDoc {
  return {
    id: 'plan-1' as PlanId,
    conversationId: CONVERSATION,
    createdAt: 1_000,
    versions: contents.map((content, index) => ({
      version: index + 1,
      author: 'agent' as const,
      createdAt: 1_000 + index,
      content,
      contentHash: `hash-${index + 1}`,
    })),
    decisions: [],
    approvals: [],
    ...extra,
  };
}
