// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createHost } from './host';
import type { HostTransport } from './host';

function setup() {
  const posted: unknown[] = [];
  const target = new EventTarget();
  const transport: HostTransport = {
    postMessage: (m) => posted.push(m),
    getState: () => undefined,
    setState: () => undefined,
    target: target,
  };
  return { host: createHost(transport), posted, target };
}

const send = (target: EventTarget, data: unknown) => {
  target.dispatchEvent(new MessageEvent('message', { data }));
};

describe('createHost', () => {
  it('posts valid messages and throws on invalid ones in development', () => {
    const { host, posted } = setup();
    host.post({ type: 'ready' });
    expect(posted).toEqual([{ type: 'ready' }]);
    expect(() => host.post({ type: 'turn.send', text: '', mode: 'ask', model: 'x' })).toThrow(
      /Invalid webview message "turn.send"/,
    );
    expect(posted).toHaveLength(1);
  });

  it('drops invalid incoming messages with a content-free warning', () => {
    const { host, target } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listener = vi.fn();
    host.subscribe(listener);
    send(target, { type: 'init', seq: 0, state: { secret: 'conversation text' } });
    send(target, 'garbage');
    send(target, { type: 'patch', seq: 1, ops: [] });
    expect(listener).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('conversation text');
    warn.mockRestore();
  });

  it('delivers valid messages and stops after unsubscribe', () => {
    const { host, target } = setup();
    const listener = vi.fn();
    const off = host.subscribe(listener);
    send(target, { type: 'event', event: { kind: 'focus-composer' } });
    expect(listener).toHaveBeenCalledWith({ type: 'event', event: { kind: 'focus-composer' } });
    off();
    send(target, { type: 'event', event: { kind: 'focus-composer' } });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
