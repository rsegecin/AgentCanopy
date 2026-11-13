import { describe, expect, it } from 'vitest';
import type { AgentProvider } from '../../contracts';
import { createProviderRegistry } from './index';

function provider(id: string): AgentProvider {
  return {
    id,
    displayName: id.toUpperCase(),
    detect: () => Promise.reject(new Error('not used')),
    listModels: () => [],
    startTurn: () => {
      throw new Error('not used');
    },
  };
}

describe('createProviderRegistry', () => {
  it('lists providers in registration order', () => {
    const a = provider('b');
    const b = provider('a');
    const c = provider('c');
    expect(createProviderRegistry([a, b, c]).list()).toEqual([a, b, c]);
  });

  it('returns a copy from list', () => {
    const registry = createProviderRegistry([provider('a')]);
    registry.list().pop();
    expect(registry.list()).toHaveLength(1);
  });

  it('gets a provider by id and returns undefined for an unknown id', () => {
    const a = provider('a');
    const registry = createProviderRegistry([a, provider('b')]);
    expect(registry.get('a')).toBe(a);
    expect(registry.get('zzz')).toBeUndefined();
  });

  it('throws at creation for a duplicate id', () => {
    expect(() => createProviderRegistry([provider('a'), provider('a')])).toThrow(/a/);
  });

  it('accepts an empty list', () => {
    const registry = createProviderRegistry([]);
    expect(registry.list()).toEqual([]);
    expect(registry.get('a')).toBeUndefined();
  });
});
