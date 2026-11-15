// @vitest-environment jsdom
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  assistantMessage,
  makeActive,
  makePlanDoc,
  makePlanVersion,
  makeState,
  planId,
} from '../test-support/fixtures';
import { renderWithHost } from '../test-support/harness';
import { App } from './App';

// This file must not import features/plan: the card has to be registered by App alone.

describe('the plan card registration', () => {
  it('is done by importing App, which keeps the side-effect import of the plan feature', async () => {
    vi.resetModules();
    const registry = await import('../features/chat/registry');
    expect(registry.getPartRenderer('plan-update')).toBeUndefined();
    await import('./App');
    expect(registry.getPartRenderer('plan-update')).toBeDefined();
  });

  it('draws a plan-update part as the plan card, not as the one-line default', () => {
    renderWithHost(
      <App />,
      makeState({
        active: makeActive('c1', {
          plan: makePlanDoc({ versions: [makePlanVersion(1)] }),
          messages: [
            assistantMessage('a1', [{ kind: 'plan-update', planId: planId('plan1'), version: 1 }]),
          ],
        }),
      }),
    );
    expect(screen.getByRole('button', { name: 'Add caching, open version 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve and Execute' })).toBeTruthy();
    expect(screen.queryByText('Plan updated to version 1')).toBeNull();
  });
});
