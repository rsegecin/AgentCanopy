import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../shared';
import { createReadOnlyPolicy } from './index';
import { meta } from './test-support';

describe('profile', () => {
  const policy = createReadOnlyPolicy();
  const profile = (mode: 'ask' | 'plan' | 'agent', askWebTools = false, planLocked = false) =>
    policy.profile({
      mode,
      settings: { ...DEFAULT_SETTINGS, askWebTools },
      conversation: meta('c', mode, planLocked),
    });

  it('ask is read-only without web tools by default', () => {
    expect(profile('ask')).toEqual({ kind: 'read-only', webTools: false, planTool: false });
  });

  it('ask follows the web-tools setting', () => {
    expect(profile('ask', true)).toEqual({ kind: 'read-only', webTools: true, planTool: false });
  });

  it('ask never offers the plan tool, locked or not', () => {
    expect(profile('ask', false, true)).toEqual({
      kind: 'read-only',
      webTools: false,
      planTool: false,
    });
  });

  it('plan with an unlocked plan offers the plan tool', () => {
    expect(profile('plan')).toEqual({ kind: 'read-only', webTools: false, planTool: true });
  });

  it('plan with a locked plan does not', () => {
    expect(profile('plan', false, true)).toEqual({
      kind: 'read-only',
      webTools: false,
      planTool: false,
    });
  });

  it('plan follows the web-tools setting', () => {
    expect(profile('plan', true)).toEqual({ kind: 'read-only', webTools: true, planTool: true });
  });

  it('agent is unavailable', () => {
    expect(profile('agent')).toEqual({ unavailable: 'Agent mode is not available yet.' });
  });
});
