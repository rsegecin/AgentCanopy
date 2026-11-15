// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViewState } from '../../../shared';
import {
  makeActive,
  makePermissionPrompt,
  makeQuestionPrompt,
  makeState,
  makeTurn,
} from '../../test-support/fixtures';
import { renderWithHost } from '../../test-support/harness';
import type { Harness } from '../../test-support/harness';
import { Composer } from './Composer';
import { findMention } from './reference-picker';

const box = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message' });

/** Sets the value the way the browser does, without going through React's value tracking. */
function setNativeValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(el, value);
}

/** Types `text` with the caret at `caret` (the end by default), the way the browser reports it. */
function typeText(text: string, caret = text.length) {
  const el = box();
  act(() => {
    setNativeValue(el, text);
    el.setSelectionRange(caret, caret);
    fireEvent.input(el);
  });
}

/** Moves the caret without changing the text (arrow keys, a click). */
function moveCaret(caret: number) {
  const el = box();
  el.setSelectionRange(caret, caret);
  fireEvent.keyUp(el, { key: 'ArrowLeft' });
}

const results = [
  { path: 'src/app/main.ts', kind: 'file' as const },
  { path: 'src/app', kind: 'folder' as const },
  { path: 'README.md', kind: 'file' as const },
];

function withSearch(query: string, found = results): ViewState {
  return makeState({ fileSearch: { query, results: found } });
}

/** Delivers a new state, as the host does after a search. */
function deliver(h: Harness, state: ViewState) {
  h.init(state, 1);
}

/** The picker's options (the model select has options of its own). */
const options = () => within(screen.getByRole('listbox')).getAllByRole('option');

const searches = (h: Harness) => h.host.postedOf('context.search').map((m) => m.query);

afterEach(() => {
  vi.useRealTimers();
});

describe('findMention', () => {
  it.each([
    ['@', 1, { start: 0, query: '' }],
    ['@src', 4, { start: 0, query: 'src' }],
    ['@src', 2, { start: 0, query: 'src' }],
    ['look at @sr now', 11, { start: 8, query: 'sr' }],
    ['a\n@x', 4, { start: 2, query: 'x' }],
    ['a\t@x', 4, { start: 2, query: 'x' }],
  ])('finds the mention in %j with the caret at %i', (text, caret, expected) => {
    expect(findMention(text, caret)).toEqual(expected);
  });

  it.each([
    ['a@b', 3],
    ['user@example.com', 16],
    ['@src now', 8],
    ['@src', 0],
    ['hello', 5],
    ['', 0],
    ['x @', 1],
  ])('finds no mention in %j with the caret at %i', (text, caret) => {
    expect(findMention(text, caret)).toBeNull();
  });
});

describe('reference picker opening and closing', () => {
  it('opens for an @ at the start of the text, with a hint while the query is empty', () => {
    const h = renderWithHost(<Composer />);
    expect(screen.queryByRole('listbox')).toBeNull();
    typeText('@');
    expect(screen.getByRole('status').textContent).toBe('Type to search files and folders');
    expect(searches(h)).toEqual([]);
  });

  it('opens for an @ after whitespace', () => {
    renderWithHost(<Composer />, withSearch('sr'));
    typeText('look at @sr');
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('does not open for an email-like word', () => {
    const h = renderWithHost(<Composer />, withSearch('b'));
    typeText('write to a@b');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(searches(h)).toEqual([]);
  });

  it('closes when the @ is deleted, and posts the empty search once', () => {
    const h = renderWithHost(<Composer />, withSearch('sr'));
    typeText('see @sr');
    typeText('see sr');
    expect(screen.queryByRole('listbox')).toBeNull();
    typeText('see s');
    expect(searches(h)).toEqual(['']);
  });

  it('closes on Escape and posts the empty search once', () => {
    const h = renderWithHost(<Composer />, withSearch('sr'));
    typeText('@sr');
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyUp(box(), { key: 'Escape' });
    fireEvent.blur(box());
    expect(searches(h)).toEqual(['']);
    expect(box().value).toBe('@sr');
  });

  it('closes when the caret leaves the token', () => {
    const h = renderWithHost(<Composer />, withSearch('sr'));
    typeText('see @sr');
    moveCaret(2);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(searches(h)).toEqual(['']);
  });

  it('stays open while the caret moves inside the token', () => {
    renderWithHost(<Composer />, withSearch('sr'));
    typeText('see @sr');
    moveCaret(6);
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('closes on blur and posts the empty search once', () => {
    const h = renderWithHost(<Composer />, withSearch('sr'));
    typeText('@sr');
    fireEvent.blur(box());
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(searches(h)).toEqual(['']);
  });

  it('closes the search when the composer goes away while open', () => {
    const h = renderWithHost(<Composer />, withSearch('sr'));
    typeText('@sr');
    h.unmount();
    expect(searches(h)).toEqual(['']);
  });

  it('closes when the whitespace ends the token', () => {
    const h = renderWithHost(<Composer />, withSearch('sr'));
    typeText('@sr');
    typeText('@sr ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(searches(h)).toEqual(['']);
  });
});

describe('reference picker search', () => {
  it('posts context.search once, 150 ms after the last keystroke', () => {
    vi.useFakeTimers();
    const h = renderWithHost(<Composer />);
    typeText('@s');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    typeText('@sr');
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(searches(h)).toEqual([]);
    typeText('@src');
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(searches(h)).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(searches(h)).toEqual(['src']);
  });

  it('does not search after the picker closed within the delay', () => {
    vi.useFakeTimers();
    const h = renderWithHost(<Composer />);
    typeText('@sr');
    fireEvent.keyDown(box(), { key: 'Escape' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(searches(h)).toEqual(['']);
  });

  it('shows Searching… until results for the current query arrive', () => {
    const h = renderWithHost(<Composer />);
    typeText('@src');
    expect(screen.getByRole('status').textContent).toBe('Searching…');
    expect(screen.queryByRole('listbox')).toBeNull();

    // Results for an older query are stale.
    deliver(h, withSearch('sr'));
    expect(screen.getByRole('status').textContent).toBe('Searching…');
    expect(screen.queryByRole('listbox')).toBeNull();

    deliver(h, withSearch('src'));
    expect(options()).toHaveLength(3);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows stale results as soon as the query changes again', () => {
    const h = renderWithHost(<Composer />, withSearch('src'));
    typeText('@src');
    expect(options()).toHaveLength(3);
    typeText('@srcx');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Searching…');
    deliver(h, withSearch('srcx', []));
    expect(screen.getByRole('status').textContent).toBe('No matches');
  });

  it('ignores results of a search that is not open', () => {
    renderWithHost(<Composer />, withSearch('src'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('reference picker keyboard and roles', () => {
  const open = () => {
    const h = renderWithHost(<Composer />, withSearch('src'));
    typeText('@src');
    return h;
  };
  const active = () => options().findIndex((o) => o.ariaSelected === 'true');

  it('is a listbox of options with file and folder icons, names and directories', () => {
    const { container } = open();
    const list = screen.getByRole('listbox', { name: 'Files and folders' });
    const items = within(list).getAllByRole('option');
    expect(items).toHaveLength(3);
    expect(items[0]?.textContent).toContain('main.ts');
    expect(items[0]?.querySelector('.reference-dir')?.textContent).toBe('src/app');
    expect(items[0]?.querySelector('.codicon-file')).not.toBeNull();
    expect(items[1]?.querySelector('.codicon-folder')).not.toBeNull();
    expect(items[1]?.querySelector('.reference-name')?.textContent).toBe('app');
    // A root-level file has no directory.
    expect(items[2]?.querySelector('.reference-dir')).toBeNull();
    expect(container.querySelector('.composer-input-wrap')?.contains(list)).toBe(true);
  });

  it('points aria-activedescendant at the highlighted option', () => {
    open();
    const items = options();
    expect(box().getAttribute('aria-activedescendant')).toBe(items[0]?.id);
    expect(box().getAttribute('aria-controls')).toBe(
      screen.getByRole('listbox').getAttribute('id'),
    );
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(box().getAttribute('aria-activedescendant')).toBe(items[1]?.id);
    expect(items[1]?.getAttribute('aria-selected')).toBe('true');
    expect(items[0]?.getAttribute('aria-selected')).toBe('false');
  });

  it('has no active descendant while closed', () => {
    renderWithHost(<Composer />);
    expect(box().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('moves the highlight with Down and Up, wrapping at both ends', () => {
    open();
    expect(active()).toBe(0);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(active()).toBe(2);
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    expect(active()).toBe(0);
    fireEvent.keyDown(box(), { key: 'ArrowUp' });
    expect(active()).toBe(2);
  });

  it('prevents the default of the keys it handles', () => {
    open();
    expect(fireEvent.keyDown(box(), { key: 'ArrowDown' })).toBe(false);
    expect(fireEvent.keyDown(box(), { key: 'Enter' })).toBe(false);
  });

  it('selects the highlighted option with Enter', () => {
    const h = open();
    fireEvent.keyDown(box(), { key: 'ArrowDown' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(h.host.postedOf('context.add')).toEqual([
      { type: 'context.add', path: 'src/app', kind: 'folder' },
    ]);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('selects the highlighted option with Tab', () => {
    const h = open();
    fireEvent.keyDown(box(), { key: 'Tab' });
    expect(h.host.postedOf('context.add')).toEqual([
      { type: 'context.add', path: 'src/app/main.ts', kind: 'file' },
    ]);
  });

  it('selects an option with a click', () => {
    const h = open();
    fireEvent.click(options()[2] as HTMLElement);
    expect(h.host.postedOf('context.add')).toEqual([
      { type: 'context.add', path: 'README.md', kind: 'file' },
    ]);
  });

  it('highlights the option under the pointer', () => {
    open();
    fireEvent.mouseMove(options()[1] as HTMLElement);
    expect(active()).toBe(1);
  });

  it('keeps focus in the textarea when the popup is pressed', () => {
    open();
    const option = options()[0] as HTMLElement;
    expect(fireEvent.mouseDown(option)).toBe(false);
  });

  it('does not send on Enter while open, with or without results', () => {
    const h = renderWithHost(<Composer />);
    typeText('explain @sr');
    expect(screen.getByRole('status').textContent).toBe('Searching…');
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(h.host.postedOf('turn.send')).toEqual([]);
    expect(box().value).toBe('explain @sr');

    deliver(h, withSearch('sr'));
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(h.host.postedOf('turn.send')).toEqual([]);
    expect(h.host.postedOf('context.add')).toHaveLength(1);
  });

  it('sends on Enter again once the picker is closed', () => {
    const h = renderWithHost(<Composer />, withSearch('sr'));
    typeText('explain @sr');
    fireEvent.keyDown(box(), { key: 'Escape' });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(h.host.postedOf('turn.send')).toHaveLength(1);
  });

  it('leaves Escape to the running-turn handling when the picker is closed', () => {
    renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1', { turns: [makeTurn({ status: 'running' })] }),
      }),
    );
    box().focus();
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop' }));
  });

  it('keeps the arrow keys for the caret while there are no results', () => {
    renderWithHost(<Composer />);
    typeText('@sr');
    expect(fireEvent.keyDown(box(), { key: 'ArrowDown' })).toBe(true);
  });
});

describe('reference picker selection', () => {
  function pick(text: string, caret: number, query: string, index = 0) {
    const h = renderWithHost(<Composer />, withSearch(query));
    typeText(text, caret);
    fireEvent.click(options()[index] as HTMLElement);
    return h;
  }

  it('removes an @query at the start and leaves the cursor there', () => {
    const h = pick('@src', 4, 'src');
    expect(box().value).toBe('');
    expect(box().selectionStart).toBe(0);
    expect(h.host.postedOf('context.add')).toEqual([
      { type: 'context.add', path: 'src/app/main.ts', kind: 'file' },
    ]);
  });

  it('removes an @query after a space, in the middle of the text', () => {
    // "explain @sr please": the caret is after "sr".
    pick('explain @sr please', 11, 'sr');
    expect(box().value).toBe('explain  please');
    expect(box().selectionStart).toBe(8);
    expect(box().selectionEnd).toBe(8);
  });

  it('removes the whole token even when the caret is inside it', () => {
    pick('see @src/ap now', 7, 'src/ap');
    expect(box().value).toBe('see  now');
    expect(box().selectionStart).toBe(4);
  });

  it('removes an @query at the end of a line', () => {
    pick('first\n@src\nlast', 10, 'src');
    expect(box().value).toBe('first\n\nlast');
    expect(box().selectionStart).toBe(6);
  });

  it('keeps the focus in the textarea', () => {
    pick('@src', 4, 'src');
    expect(document.activeElement).toBe(box());
  });

  it('posts context.add and then the empty search, each once', () => {
    const h = pick('look @src', 9, 'src');
    expect(h.host.posted.filter((m) => m.type.startsWith('context.'))).toEqual([
      { type: 'context.add', path: 'src/app/main.ts', kind: 'file' },
      { type: 'context.search', query: '' },
    ]);
  });

  it('persists the edited draft', () => {
    const h = pick('look @src', 9, 'src');
    expect(h.services.ui.getSnapshot().drafts['__new__']).toBe('look ');
  });
});

describe('reference picker and the rest of the composer', () => {
  it('keeps the file, folder, selection and diagnostics buttons', () => {
    renderWithHost(<Composer />);
    for (const name of ['Add a file', 'Add a folder', 'Add the editor selection', /Add problems/]) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('shows a note while a prompt of the open conversation waits for an answer', () => {
    renderWithHost(
      <Composer />,
      makeState({
        active: makeActive('c1', {
          turns: [makeTurn({ status: 'running' })],
          prompts: [makeQuestionPrompt('p1')],
        }),
      }),
    );
    expect(screen.getByText('The agent is waiting for your answer above.')).toBeTruthy();
    // Stop is offered next to Send, and an Ask message sent while the turn runs is a side question.
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy();
    typeText('next');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send' }).disabled).toBe(false);
  });

  it.each([
    ['no prompt', []],
    ['an answered prompt', [makeQuestionPrompt('p1', { state: 'answered' })]],
    ['an expired permission prompt', [makePermissionPrompt('p2', { state: 'expired' })]],
  ])('shows no waiting note with %s', (_name, prompts) => {
    renderWithHost(<Composer />, makeState({ active: makeActive('c1', { prompts }) }));
    expect(screen.queryByText('The agent is waiting for your answer above.')).toBeNull();
  });

  it('shows the note for a pending permission prompt too', () => {
    renderWithHost(
      <Composer />,
      makeState({ active: makeActive('c1', { prompts: [makePermissionPrompt('p2')] }) }),
    );
    expect(screen.getByText('The agent is waiting for your answer above.')).toBeTruthy();
  });
});
