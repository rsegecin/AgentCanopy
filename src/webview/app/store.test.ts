// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  assistantMessage,
  convId,
  FakeHost,
  makeActive,
  makeState,
} from '../test-support/fixtures';
import type { ViewEvent } from '../../shared';
import { createHost } from './host';
import { Store } from './store';

function setup() {
  const host = new FakeHost();
  const store = new Store(host);
  store.start();
  return { host, store };
}

const textPart = { kind: 'text' as const, text: 'Hel' };
const stateWithMessage = () =>
  makeState({
    active: makeActive('c1', { messages: [assistantMessage('m1', [textPart])] }),
  });

describe('Store', () => {
  it('posts ready on start, once', () => {
    const { host, store } = setup();
    store.start();
    expect(host.posted).toEqual([{ type: 'ready' }]);
    expect(store.getSnapshot()).toEqual({ state: null, seq: 0 });
  });

  it('replaces state and seq on init, then applies in-order patches', () => {
    const { host, store } = setup();
    host.emit({ type: 'init', seq: 4, state: stateWithMessage() });
    expect(store.getSnapshot().seq).toBe(4);

    host.emit({
      type: 'patch',
      seq: 5,
      ops: [{ op: 'appendText', path: ['active', 'messages', 0, 'parts', 0, 'text'], text: 'lo' }],
    });
    host.emit({
      type: 'patch',
      seq: 6,
      ops: [{ op: 'set', path: ['trusted'], value: false }],
    });

    const { state, seq } = store.getSnapshot();
    expect(seq).toBe(6);
    expect(state?.trusted).toBe(false);
    const message = state?.active?.messages[0];
    expect(message?.role === 'assistant' && message.parts[0]).toEqual({
      kind: 'text',
      text: 'Hello',
    });
    expect(host.postedOf('resync')).toHaveLength(0);
  });

  it('notifies subscribers on init and on each applied patch', () => {
    const { host, store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    host.emit({ type: 'init', seq: 0, state: makeState() });
    host.emit({ type: 'patch', seq: 1, ops: [{ op: 'set', path: ['trusted'], value: false }] });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('posts one resync on a gap and ignores patches until the next init', () => {
    const { host, store } = setup();
    host.emit({ type: 'init', seq: 1, state: makeState() });
    const set = (value: boolean) => [{ op: 'set' as const, path: ['trusted'], value }];

    host.emit({ type: 'patch', seq: 3, ops: set(false) }); // gap: 2 is missing
    host.emit({ type: 'patch', seq: 2, ops: set(false) }); // would now be in order, still ignored
    host.emit({ type: 'patch', seq: 4, ops: set(false) });

    expect(host.postedOf('resync')).toHaveLength(1);
    expect(store.getSnapshot().state?.trusted).toBe(true);
    expect(store.getSnapshot().seq).toBe(1);

    host.emit({ type: 'init', seq: 4, state: makeState({ trusted: true }) });
    host.emit({ type: 'patch', seq: 5, ops: set(false) });
    expect(store.getSnapshot()).toMatchObject({ seq: 5, state: { trusted: false } });

    // A new gap after the resync completed asks again.
    host.emit({ type: 'patch', seq: 9, ops: set(true) });
    expect(host.postedOf('resync')).toHaveLength(2);
  });

  it('treats a repeated seq as a gap', () => {
    const { host, store } = setup();
    host.emit({ type: 'init', seq: 1, state: makeState() });
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'set', path: ['trusted'], value: false }],
    });
    expect(host.postedOf('resync')).toHaveLength(1);
    expect(store.getSnapshot().state?.trusted).toBe(true);
  });

  it('posts one resync when a patch throws, and ignores patches until init', () => {
    const { host, store } = setup();
    host.emit({ type: 'init', seq: 0, state: makeState() });
    host.emit({
      type: 'patch',
      seq: 1,
      ops: [{ op: 'appendText', path: ['trusted'], text: 'x' }], // trusted is not text
    });
    host.emit({
      type: 'patch',
      seq: 2,
      ops: [{ op: 'set', path: ['trusted'], value: false }],
    });
    expect(host.postedOf('resync')).toHaveLength(1);
    expect(store.getSnapshot()).toMatchObject({ seq: 0, state: { trusted: true } });

    host.emit({ type: 'init', seq: 2, state: makeState() });
    host.emit({
      type: 'patch',
      seq: 3,
      ops: [{ op: 'set', path: ['trusted'], value: false }],
    });
    expect(store.getSnapshot().state?.trusted).toBe(false);
  });

  it('asks for a resync when a patch arrives before any init', () => {
    const { host } = setup();
    host.emit({ type: 'patch', seq: 1, ops: [{ op: 'set', path: ['trusted'], value: true }] });
    expect(host.postedOf('resync')).toHaveLength(1);
  });

  it('drops an invalid host message without changing state or asking for a resync', () => {
    const target = new EventTarget();
    const posted: unknown[] = [];
    const store = new Store(
      createHost({
        postMessage: (m) => posted.push(m),
        getState: () => undefined,
        setState: () => undefined,
        target: target,
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    store.start();
    const send = (data: unknown) => target.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: 'init', seq: 0, state: makeState() });
    send({ type: 'patch', seq: 1, ops: [{ op: 'explode', path: ['trusted'] }] });
    send({ type: 'nope' });
    send({ type: 'patch', seq: 1, ops: [{ op: 'set', path: ['trusted'], value: false }] });
    warn.mockRestore();
    expect(posted).toEqual([{ type: 'ready' }]);
    // The invalid patch never counted, so seq 1 still applies.
    expect(store.getSnapshot()).toMatchObject({ seq: 1, state: { trusted: false } });
  });

  it('forwards events to listeners without touching the state', () => {
    const { host, store } = setup();
    host.emit({ type: 'init', seq: 0, state: makeState({ active: makeActive('c1') }) });
    const seen: ViewEvent[] = [];
    const off = store.onEvent((e) => seen.push(e));
    host.emit({ type: 'event', event: { kind: 'focus-composer' } });
    off();
    host.emit({ type: 'event', event: { kind: 'focus-composer' } });
    expect(seen).toEqual([{ kind: 'focus-composer' }]);
    expect(store.getSnapshot().state?.active?.meta.id).toBe(convId('c1'));
  });
});
