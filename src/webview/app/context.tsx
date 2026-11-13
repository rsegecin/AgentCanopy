import { createContext, useContext } from 'react';
import type { WebviewMessage } from '../../shared';
import type { Host } from './host';
import type { Store } from './store';
import type { UiState } from './ui-state';

export interface AppServices {
  host: Host;
  store: Store;
  ui: UiState;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const services = useContext(AppContext);
  if (!services) throw new Error('AppContext is missing');
  return services;
}

/** Returns the function that sends a message to the extension host. */
export function usePost(): (message: WebviewMessage) => void {
  return useApp().host.post;
}
