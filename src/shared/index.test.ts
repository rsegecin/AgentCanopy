import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  EMPTY_VIEW_STATE,
  HostMessageSchema,
  PlanContentSchema,
  RelPathSchema,
  SettingsSchema,
  ViewStateSchema,
  WebviewMessageSchema,
} from './index';

describe('shared contracts', () => {
  it('accepts the default settings and the empty view state', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(ViewStateSchema.parse(EMPTY_VIEW_STATE)).toEqual(EMPTY_VIEW_STATE);
  });

  it('rejects paths that leave the folder', () => {
    for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:/x', '']) {
      expect(RelPathSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(RelPathSchema.safeParse('src/a..b/c.ts').success).toBe(true);
  });

  it('rejects unknown and malformed webview messages', () => {
    expect(WebviewMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({ type: 'turn.send', text: '', mode: 'ask', model: 'x' })
        .success,
    ).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({ type: 'turn.send', text: 'hi', mode: 'root', model: 'x' })
        .success,
    ).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({ type: 'review.rejectFile', path: '../../etc/hosts' })
        .success,
    ).toBe(false);
    expect(
      WebviewMessageSchema.safeParse({
        type: 'turn.send',
        text: 'hi',
        mode: 'ask',
        model: 'default',
      }).success,
    ).toBe(true);
  });

  it('validates host messages', () => {
    expect(
      HostMessageSchema.safeParse({ type: 'init', seq: 0, state: EMPTY_VIEW_STATE }).success,
    ).toBe(true);
    expect(HostMessageSchema.safeParse({ type: 'patch', seq: 1, ops: [] }).success).toBe(false);
  });

  it('fills plan defaults and converts to JSON Schema', async () => {
    const plan = PlanContentSchema.parse({
      title: 'Demo',
      objective: 'Show the schema',
      stages: [{ id: 's1', title: 'One', description: 'Do it' }],
    });
    expect(plan.stages[0]?.dependsOn).toEqual([]);
    const { z } = await import('zod');
    const schema = z.toJSONSchema(PlanContentSchema, { io: 'input' }) as {
      type?: string;
      required?: string[];
    };
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(expect.arrayContaining(['title', 'objective', 'stages']));
    expect(schema.required).not.toContain('analysis');
  });
});
