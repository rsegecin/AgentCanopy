import { describe, expect, it } from 'vitest';
import {
  assistantMessage,
  makeActive,
  makeChangesPart,
  makeReviewEntry,
  makeState,
  opId,
  userMessage,
} from '../../test-support/fixtures';
import { cardOperationsSelector, cardRows, elsewhere, ownerOf } from './review-model';

const entry = (path: string, operations: string[], over = {}) =>
  makeReviewEntry(path, { operationIds: operations.map(opId), ...over });

describe('ownerOf', () => {
  it('is the last operation that touched the path', () => {
    expect(ownerOf(entry('a.ts', ['op1', 'op2', 'op3']))).toBe('op3');
    expect(ownerOf(entry('a.ts', ['op1']))).toBe('op1');
  });

  it('is undefined without operations', () => {
    expect(ownerOf(entry('a.ts', []))).toBeUndefined();
  });
});

describe('cardRows', () => {
  it('lists the pending and accepted entries the card owns, in the order of the entries', () => {
    const part = makeChangesPart(['op1'], ['a.ts', 'b.ts', 'c.ts']);
    const rows = cardRows(part, [
      entry('c.ts', ['op1']),
      entry('x.ts', ['op9']),
      entry('a.ts', ['op1'], { status: 'accepted' }),
    ]);
    expect(rows.live.map((e) => e.path)).toEqual(['c.ts', 'a.ts']);
    expect(rows.record).toEqual([{ path: 'b.ts', changeType: 'modified', state: 'settled' }]);
    expect(rows.moreSettled).toBe(0);
  });

  it('owns a card with any of its operations', () => {
    const part = makeChangesPart(['op1', 'op2'], ['a.ts', 'b.ts']);
    const rows = cardRows(part, [entry('a.ts', ['op1']), entry('b.ts', ['op0', 'op2'])]);
    expect(rows.live.map((e) => e.path)).toEqual(['a.ts', 'b.ts']);
    expect(rows.record).toEqual([]);
  });

  it('gives a file changed by two turns to the second card, and a later row to the first', () => {
    const changed = entry('a.ts', ['op1', 'op2']);
    const first = cardRows(makeChangesPart(['op1'], ['a.ts']), [changed]);
    const second = cardRows(makeChangesPart(['op2'], ['a.ts']), [changed]);
    expect(first.live).toEqual([]);
    expect(first.record).toEqual([{ path: 'a.ts', changeType: 'modified', state: 'later' }]);
    expect(second.live).toEqual([changed]);
    expect(second.record).toEqual([]);
  });

  it('calls a file with no entry, or an entry of other operations, settled', () => {
    const part = makeChangesPart(['op1'], [['gone.ts', 'deleted'], 'other.ts', 'rejected.ts']);
    const rows = cardRows(part, [entry('other.ts', ['op7'])]);
    expect(rows.live).toEqual([]);
    expect(rows.record).toEqual([
      { path: 'gone.ts', changeType: 'deleted', state: 'settled' },
      { path: 'other.ts', changeType: 'modified', state: 'settled' },
      { path: 'rejected.ts', changeType: 'modified', state: 'settled' },
    ]);
  });

  it('keeps the order of the part for the record', () => {
    const part = makeChangesPart(['op1'], ['b.ts', 'a.ts']);
    expect(cardRows(part, []).record.map((r) => r.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('counts the files beyond the list that are not live, and shows those that are live as rows', () => {
    const part = makeChangesPart(['op1'], ['a.ts'], 5);
    const rows = cardRows(part, [entry('a.ts', ['op1']), entry('beyond1.ts', ['op1'])]);
    expect(rows.live.map((e) => e.path)).toEqual(['a.ts', 'beyond1.ts']);
    expect(rows.moreSettled).toBe(4);
  });

  it('never counts fewer than none beyond the list', () => {
    const part = makeChangesPart(['op1'], ['a.ts'], 1);
    const rows = cardRows(part, [entry('b.ts', ['op1']), entry('c.ts', ['op1'])]);
    expect(rows.moreSettled).toBe(0);
  });

  it('counts all of `more` when none of the extra files is live', () => {
    expect(cardRows(makeChangesPart(['op1'], ['a.ts'], 3), []).moreSettled).toBe(3);
  });
});

describe('elsewhere', () => {
  const entries = [
    entry('a.ts', ['op1']),
    entry('b.ts', ['op1', 'op2']),
    entry('c.ts', ['op9']),
    entry('d.ts', []),
  ];

  it('is every entry when no card exists', () => {
    expect(elsewhere(entries, new Set())).toEqual(entries);
  });

  it('keeps the entries whose owner is in no card, and those without an owner', () => {
    expect(elsewhere(entries, new Set(['op1'])).map((e) => e.path)).toEqual([
      'b.ts',
      'c.ts',
      'd.ts',
    ]);
    expect(elsewhere(entries, new Set(['op1', 'op2'])).map((e) => e.path)).toEqual([
      'c.ts',
      'd.ts',
    ]);
  });
});

describe('cardOperationsSelector', () => {
  const withMessages = (...texts: string[]) =>
    makeState({
      active: makeActive('c1', {
        messages: [
          userMessage('u1', 'go'),
          assistantMessage('a1', [makeChangesPart(['op1', 'op2'])]),
          assistantMessage('a2', [{ kind: 'text', text: texts.join('') }]),
        ],
      }),
    });

  it('collects the operations of every changes part', () => {
    const select = cardOperationsSelector();
    expect([...select(withMessages('x'))].sort()).toEqual(['op1', 'op2']);
  });

  it('is empty without an open conversation', () => {
    expect(cardOperationsSelector()(makeState()).size).toBe(0);
  });

  it('returns the same set while text streams into the last message', () => {
    const select = cardOperationsSelector();
    const before = withMessages('x');
    const first = select(before);
    // Only the last message changes; the others keep their identity, as after a patch.
    const active = before.active;
    if (!active) throw new Error('no active conversation');
    const after = {
      ...before,
      active: {
        ...active,
        messages: [
          ...active.messages.slice(0, 2),
          assistantMessage('a2', [{ kind: 'text', text: 'xyz' }]),
        ],
      },
    };
    expect(select(after)).toBe(first);
  });

  it('returns a new set when a changes part arrives or goes away', () => {
    const select = cardOperationsSelector();
    const first = select(withMessages('x'));
    const base = makeState({
      active: makeActive('c1', { messages: [userMessage('u1', 'go')] }),
    });
    const none = select(base);
    expect(none).not.toBe(first);
    expect(none.size).toBe(0);
    expect(select(base)).toBe(none);
  });
});
