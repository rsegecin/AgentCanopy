import { describe, expect, it } from 'vitest';
import { applyPatch } from './patch';

describe('applyPatch', () => {
  const base = { a: { list: [{ text: 'x' }, { text: 'y' }], n: 1 }, b: 'keep' };

  it('sets, pushes, appends and deletes without mutating the input', () => {
    const frozen = structuredClone(base);
    const next = applyPatch(base, [
      { op: 'set', path: ['a', 'n'], value: 2 },
      { op: 'push', path: ['a', 'list'], value: { text: 'z' } },
      { op: 'appendText', path: ['a', 'list', 0, 'text'], text: '!' },
      { op: 'delete', path: ['a', 'list', 1] },
    ]);
    expect(next).toEqual({ a: { list: [{ text: 'x!' }, { text: 'z' }], n: 2 }, b: 'keep' });
    expect(base).toEqual(frozen);
    expect(next.a.list).not.toBe(base.a.list);
  });

  it('replaces the root with set', () => {
    expect(applyPatch(base, [{ op: 'set', path: [], value: { fresh: true } }])).toEqual({
      fresh: true,
    });
  });

  it('deletes object keys', () => {
    expect(applyPatch({ a: 1, b: 2 }, [{ op: 'delete', path: ['a'] }])).toEqual({ b: 2 });
  });

  it('refuses prototype keys, wrong container kinds and missing parents', () => {
    expect(() => applyPatch(base, [{ op: 'set', path: ['__proto__', 'x'], value: 1 }])).toThrow();
    expect(() => applyPatch(base, [{ op: 'set', path: ['a', 'constructor'], value: 1 }])).toThrow();
    expect(() => applyPatch(base, [{ op: 'set', path: ['a', 'list', 'k'], value: 1 }])).toThrow();
    expect(() => applyPatch(base, [{ op: 'set', path: ['missing', 'x'], value: 1 }])).toThrow();
    expect(() => applyPatch(base, [{ op: 'push', path: ['b'], value: 1 }])).toThrow();
    expect(() => applyPatch(base, [{ op: 'appendText', path: ['a', 'n'], text: 'x' }])).toThrow();
    expect(() => applyPatch(base, [{ op: 'set', path: ['a', 'list', 9], value: 1 }])).toThrow();
    expect(() => applyPatch(base, [{ op: 'delete', path: [] }])).toThrow();
  });
});
