import { cleanup, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach } from 'vitest';
import type { ViewState } from '../../shared';
import { AppContext } from '../app/context';
import { createServices } from '../app/services';
import type { AppServices } from '../app/context';
import { FakeHost, makeState } from './fixtures';

afterEach(cleanup);

export interface Harness extends RenderResult {
  host: FakeHost;
  services: AppServices;
  /** Sends `init` with the given state at the next sequence number. */
  init: (state: ViewState, seq?: number) => void;
}

/** Renders `element` inside services backed by a fake host, already initialised with `state`. */
export function renderWithHost(
  element: ReactElement,
  state: ViewState | null = makeState(),
  saved?: unknown,
): Harness {
  const host = new FakeHost(saved);
  const services = createServices(host);
  services.store.start();
  const init = (s: ViewState, seq = 0) => {
    host.emit({ type: 'init', seq, state: s });
  };
  if (state) init(state);
  const result = render(<AppContext.Provider value={services}>{element}</AppContext.Provider>);
  return { ...result, host, services, init };
}
