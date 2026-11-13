import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AgentEvent, type Mode } from '../../shared';
import type { PermissionRequest, PolicyDecision, TurnPolicy } from '../contracts';
import { createModePolicy } from './index';
import { makeContext, meta } from './readonly/test-support';

function stub(label: string): TurnPolicy & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    profile: () => {
      calls.push('profile');
      return { unavailable: label };
    },
    decide: () => {
      calls.push('decide');
      const decision: PolicyDecision = {
        response: { behavior: 'deny', message: label },
        approval: 'policy',
      };
      return Promise.resolve(decision);
    },
    inspect: () => {
      calls.push('inspect');
      return { notice: label };
    },
  };
}

const request: PermissionRequest = {
  toolCallId: 't',
  toolName: 'Read',
  input: {},
  signal: new AbortController().signal,
};
const event: AgentEvent = { type: 'status', state: 'running' };
const MODES: Mode[] = ['ask', 'plan', 'agent'];

describe('createModePolicy', () => {
  function build() {
    const stubs = { ask: stub('ask'), plan: stub('plan'), agent: stub('agent') };
    return { stubs, policy: createModePolicy(stubs) };
  }

  it.each(MODES)('profile goes to the %s policy by input.mode', (mode) => {
    const { stubs, policy } = build();
    expect(
      policy.profile({ mode, settings: DEFAULT_SETTINGS, conversation: meta('c', 'ask') }),
    ).toEqual({ unavailable: mode });
    expect(stubs[mode].calls).toEqual(['profile']);
    for (const other of MODES.filter((m) => m !== mode)) expect(stubs[other].calls).toEqual([]);
  });

  it.each(MODES)('decide goes to the %s policy by context.mode', async (mode) => {
    const { stubs, policy } = build();
    const { context } = makeContext({ folderPath: '/x', mode });
    expect(await policy.decide(request, context)).toMatchObject({
      response: { behavior: 'deny', message: mode },
    });
    expect(stubs[mode].calls).toEqual(['decide']);
    for (const other of MODES.filter((m) => m !== mode)) expect(stubs[other].calls).toEqual([]);
  });

  it.each(MODES)('inspect goes to the %s policy by context.mode', (mode) => {
    const { stubs, policy } = build();
    const { context } = makeContext({ folderPath: '/x', mode });
    expect(policy.inspect?.(event, context)).toEqual({ notice: mode });
    expect(stubs[mode].calls).toEqual(['inspect']);
    for (const other of MODES.filter((m) => m !== mode)) expect(stubs[other].calls).toEqual([]);
  });

  it('a policy without inspect gives no finding', () => {
    const noInspect: TurnPolicy = { profile: vi.fn(), decide: vi.fn() };
    const policy = createModePolicy({ ask: noInspect, plan: noInspect, agent: noInspect });
    const { context } = makeContext({ folderPath: '/x', mode: 'ask' });
    expect(policy.inspect?.(event, context)).toBeUndefined();
  });
});
