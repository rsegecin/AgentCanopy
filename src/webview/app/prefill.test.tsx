// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeActive, makeState } from '../test-support/fixtures';
import { renderWithHost } from '../test-support/harness';
import { App } from './App';

const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const state = (id: string) => makeState({ active: makeActive(id) });

describe('prefill-composer', () => {
  it('sets an empty draft and focuses the textarea', async () => {
    const { host } = renderWithHost(<App />, state('c1'));
    host.emit({ type: 'event', event: { kind: 'prefill-composer', text: 'from a fork' } });
    expect(box().value).toBe('from a fork');
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
  });

  it('puts the text in front of a typed draft, after a blank line, and focuses the textarea', async () => {
    const { host } = renderWithHost(<App />, state('c1'));
    type('my own draft');
    host.emit({ type: 'event', event: { kind: 'prefill-composer', text: 'queued text' } });
    expect(box().value).toBe('queued text\n\nmy own draft');
    await waitFor(() => {
      expect(document.activeElement).toBe(box());
    });
  });

  it('treats a whitespace-only draft as empty', () => {
    const { host } = renderWithHost(<App />, state('c1'));
    type('  \n ');
    host.emit({ type: 'event', event: { kind: 'prefill-composer', text: 'queued text' } });
    expect(box().value).toBe('queued text');
  });

  it('writes to the conversation that is current when the event arrives, not the one last rendered', () => {
    const { host, init, services } = renderWithHost(<App />, state('c1'));
    type('draft of c1');
    // The patch that shows the new conversation and the event arrive together, before the Composer
    // has re-subscribed with the new draft key.
    act(() => {
      init(state('c2'), 1);
      host.emit({ type: 'event', event: { kind: 'prefill-composer', text: 'forked text' } });
    });
    const drafts = services.ui.getSnapshot().drafts;
    expect(drafts['c2']).toBe('forked text');
    expect(drafts['c1']).toBe('draft of c1');
  });
});
