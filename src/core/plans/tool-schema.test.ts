import { describe, expect, it } from 'vitest';
import { PlanContentSchema } from '../../shared';
import { planToolInputSchema } from './index';
import { maximalInput, minimalInput } from './test-support';

describe('planToolInputSchema', () => {
  const schema = planToolInputSchema() as {
    type?: string;
    required?: string[];
    properties?: Record<string, { description?: string }>;
    $schema?: unknown;
  };

  it('is an object schema without a $schema key', () => {
    expect(schema.type).toBe('object');
    expect('$schema' in schema).toBe(false);
  });

  it('requires only title, objective and stages', () => {
    expect([...(schema.required ?? [])].sort()).toEqual(['objective', 'stages', 'title']);
  });

  it('describes every top-level property', () => {
    const properties = schema.properties ?? {};
    expect(Object.keys(properties)).toEqual(Object.keys(PlanContentSchema.shape));
    for (const [name, property] of Object.entries(properties)) {
      expect(property.description, name).toBeTruthy();
    }
    expect(properties.stages?.description).toContain('stable id');
    expect(properties.diagrams?.description).toContain('no code fences');
  });

  it('returns a fresh object each call', () => {
    expect(planToolInputSchema()).toEqual(planToolInputSchema());
    expect(planToolInputSchema()).not.toBe(planToolInputSchema());
  });

  it('accepts a minimal and a maximal plan', () => {
    expect(PlanContentSchema.safeParse(minimalInput()).success).toBe(true);
    expect(PlanContentSchema.safeParse(maximalInput()).success).toBe(true);
  });
});
