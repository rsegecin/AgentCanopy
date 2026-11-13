import { HostMessageSchema, WebviewMessageSchema } from '../../shared';
import type { HostMessage, WebviewMessage } from '../../shared';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};
declare const process: { env: { NODE_ENV?: string } };

/** What the app needs from the outside world. Tests pass a fake. */
export interface Host {
  /** Validates the message, then sends it to the extension host. */
  post: (message: WebviewMessage) => void;
  /** Calls `listener` with every valid message from the extension host. Returns an unsubscribe function. */
  subscribe: (listener: (message: HostMessage) => void) => () => void;
  /** The state saved with `setState` before a reload. */
  getState: () => unknown;
  setState: (state: unknown) => void;
}

export interface HostTransport {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
  /** Where `message` events arrive. */
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/** Wraps a transport with validation in both directions. Exported for tests. */
export function createHost(transport: HostTransport): Host {
  return {
    post(message) {
      const result = WebviewMessageSchema.safeParse(message);
      if (!result.success) {
        const type = typeof (message as { type?: unknown }).type === 'string' ? message.type : '?';
        if (process.env.NODE_ENV !== 'production') {
          throw new Error(`Invalid webview message "${type}": ${result.error.message}`);
        }
        console.warn(`AgentCanopy: dropped an invalid outgoing message (${type})`);
        return;
      }
      transport.postMessage(result.data);
    },
    subscribe(listener) {
      const handler = (event: Event) => {
        const parsed = HostMessageSchema.safeParse((event as MessageEvent).data);
        if (!parsed.success) {
          // Never log the content: it may hold conversation text.
          console.warn('AgentCanopy: dropped an invalid message from the extension host');
          return;
        }
        listener(parsed.data);
      };
      transport.target.addEventListener('message', handler);
      return () => {
        transport.target.removeEventListener('message', handler);
      };
    },
    getState: () => transport.getState(),
    setState: (state) => {
      transport.setState(state);
    },
  };
}

let api: ReturnType<typeof acquireVsCodeApi> | undefined;

/** The real host. `acquireVsCodeApi` may only be called once per page, so the result is kept. */
export function createVsCodeHost(): Host {
  api ??= acquireVsCodeApi();
  return createHost({
    postMessage: (m) => {
      api?.postMessage(m);
    },
    getState: () => api?.getState(),
    setState: (s) => {
      api?.setState(s);
    },
    target: window,
  });
}
