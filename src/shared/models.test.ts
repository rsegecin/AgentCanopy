import { describe, expect, it } from 'vitest';
import { DELEGATE_SUFFIX, delegateChoice, delegateLabel, parseModelChoice } from './models';

describe('parseModelChoice', () => {
  it.each([
    ['fable', { model: 'fable', delegate: false }],
    ['default', { model: 'default', delegate: false }],
    ['claude-opus-5-5[1m]', { model: 'claude-opus-5-5[1m]', delegate: false }],
    ['fable+delegate', { model: 'fable', delegate: true }],
    ['default+delegate', { model: 'default', delegate: true }],
    ['claude-opus-5-5[1m]+delegate', { model: 'claude-opus-5-5[1m]', delegate: true }],
  ])('%s', (choice, expected) => {
    expect(parseModelChoice(choice)).toEqual(expected);
  });

  it('strips one suffix only', () => {
    expect(parseModelChoice('x+delegate+delegate')).toEqual({
      model: 'x+delegate',
      delegate: true,
    });
  });

  it('does not take the suffix alone, or in another place or case, for a delegate choice', () => {
    expect(parseModelChoice(DELEGATE_SUFFIX)).toEqual({ model: '+delegate', delegate: false });
    expect(parseModelChoice('+delegate-x')).toEqual({ model: '+delegate-x', delegate: false });
    expect(parseModelChoice('fable+Delegate')).toEqual({
      model: 'fable+Delegate',
      delegate: false,
    });
    expect(parseModelChoice('')).toEqual({ model: '', delegate: false });
  });
});

describe('delegateChoice and delegateLabel', () => {
  it('round-trips through parseModelChoice', () => {
    expect(delegateChoice('opus')).toBe('opus+delegate');
    expect(parseModelChoice(delegateChoice('opus'))).toEqual({ model: 'opus', delegate: true });
  });

  it('labels the choice after its model', () => {
    expect(delegateLabel('Fable 5.2')).toBe('Fable 5.2 · orchestrate and delegate');
  });
});
