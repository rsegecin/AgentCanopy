import type { AppServices } from './context';
import type { Host } from './host';
import { Store } from './store';
import { UiState } from './ui-state';

/** Builds the store and the local UI state around a host. Does not start anything. */
export function createServices(host: Host): AppServices {
  return { host, store: new Store(host), ui: new UiState(host) };
}
