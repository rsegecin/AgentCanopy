import { useSyncExternalStore } from 'react';
import { applyPatch, EMPTY_VIEW_STATE } from '../../shared';
import type { HostMessage, ViewEvent, ViewState } from '../../shared';
import type { Host } from './host';
import { useApp } from './context';

export interface StoreSnapshot {
  state: ViewState | null;
  seq: number;
}

/**
 * The webview's copy of the host's state. `init` replaces it; `patch` messages must arrive in order.
 * A gap or a patch that cannot be applied asks the host for a resync once, then patches are ignored
 * until the new `init` arrives.
 */
export class Store {
  private snapshot: StoreSnapshot = { state: null, seq: 0 };
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: ViewEvent) => void>();
  private waitingForInit = false;
  private unsubscribeHost: (() => void) | null = null;

  constructor(private readonly host: Host) {}

  /** Starts listening, then tells the host the view is ready. */
  start(): void {
    if (this.unsubscribeHost) return;
    this.unsubscribeHost = this.host.subscribe((message) => {
      this.handle(message);
    });
    this.host.post({ type: 'ready' });
  }

  dispose(): void {
    this.unsubscribeHost?.();
    this.unsubscribeHost = null;
    this.listeners.clear();
    this.eventListeners.clear();
  }

  getSnapshot = (): StoreSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** One-off events (focus the composer, show a tab, toasts). */
  onEvent(listener: (event: ViewEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private handle(message: HostMessage): void {
    switch (message.type) {
      case 'init':
        this.waitingForInit = false;
        this.snapshot = { state: message.state, seq: message.seq };
        this.notify();
        return;
      case 'patch': {
        if (this.waitingForInit) return;
        const { state, seq } = this.snapshot;
        if (state === null || message.seq !== seq + 1) {
          this.requestResync();
          return;
        }
        try {
          this.snapshot = { state: applyPatch(state, message.ops), seq: message.seq };
        } catch {
          this.requestResync();
          return;
        }
        this.notify();
        return;
      }
      case 'event':
        for (const listener of [...this.eventListeners]) listener(message.event);
        return;
    }
  }

  private requestResync(): void {
    if (this.waitingForInit) return;
    this.waitingForInit = true;
    this.host.post({ type: 'resync' });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * Reads a part of the view state. Before the first `init` the selector sees the empty state.
 * The selector must return values that stay referentially equal while the part is unchanged
 * (select existing sub-objects, do not build new arrays).
 */
export function useViewState<T>(selector: (state: ViewState) => T): T {
  const { store } = useApp();
  return useSyncExternalStore(store.subscribe, () =>
    selector(store.getSnapshot().state ?? EMPTY_VIEW_STATE),
  );
}

/** False until the first `init` has arrived. */
export function useStoreReady(): boolean {
  const { store } = useApp();
  return useSyncExternalStore(store.subscribe, () => store.getSnapshot().state !== null);
}
