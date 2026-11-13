import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { Icon } from '../../app/components';
import { usePost } from '../../app/context';
import { useViewState } from '../../app/store';
import { splitPath } from './paths';

/** `context.search` accepts at most this many characters. */
const MAX_QUERY = 200;
const SEARCH_DELAY_MS = 150;

export interface MentionToken {
  /** Index of the `@` in the text. */
  start: number;
  /** The characters after the `@`, up to the next whitespace. */
  query: string;
}

/**
 * The `@` mention the caret is in, if any: a word that starts with `@`, where that word starts at
 * the beginning of the text or after whitespace. `a@b` (an email address) is not a mention.
 */
export function findMention(text: string, caret: number): MentionToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text.charAt(start - 1))) start--;
  if (text.charAt(start) !== '@' || caret <= start) return null;
  let end = start + 1;
  while (end < text.length && !/\s/.test(text.charAt(end))) end++;
  if (caret > end) return null;
  return { start, query: text.slice(start + 1, end).slice(0, MAX_QUERY) };
}

interface PickerState {
  /** The draft the mention belongs to; a different draft closes the picker. */
  draftKey: string;
  start: number;
  query: string;
}

interface Result {
  path: string;
  kind: 'file' | 'folder';
}

interface Highlight {
  list: readonly Result[] | null;
  index: number;
}

export interface ReferencePickerModel {
  open: boolean;
  /** Props for the textarea. */
  inputProps: {
    'aria-activedescendant': string | undefined;
    'aria-controls': string | undefined;
  };
  /** The text changed (typing, pasting, deleting). */
  onTextChange: (text: string, caret: number) => void;
  /** The caret may have moved. */
  onCaretMove: (caret: number) => void;
  /** Returns true when the key was handled and the composer must ignore it. */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onBlur: () => void;
  view: PickerViewProps | null;
}

/**
 * The `@` reference picker of the composer: finds the mention at the caret, asks the host to search
 * (debounced), and on selection attaches the file or folder and removes the `@query` text.
 */
export function useReferencePicker({
  draft,
  draftKey,
  setDraft,
  textarea,
}: {
  draft: string;
  draftKey: string;
  setDraft: (text: string) => void;
  textarea: RefObject<HTMLTextAreaElement | null>;
}): ReferencePickerModel {
  const post = usePost();
  const listId = useId();
  const fileSearch = useViewState((s) => s.fileSearch);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [highlight, setHighlight] = useState<Highlight>({ list: null, index: 0 });
  /** True from the moment the picker opens until the empty search that closes it has been posted. */
  const searching = useRef(false);
  const nextCaret = useRef<number | null>(null);

  const open =
    picker !== null &&
    picker.draftKey === draftKey &&
    draft.startsWith(`@${picker.query}`, picker.start);
  const query = open ? picker.query : '';

  const results: readonly Result[] | null =
    open && query !== '' && fileSearch !== null && fileSearch.query === query
      ? fileSearch.results
      : null;
  const activeIndex =
    results !== null && highlight.list === results
      ? Math.min(highlight.index, Math.max(results.length - 1, 0))
      : 0;

  const close = () => {
    setPicker(null);
    if (searching.current) {
      searching.current = false;
      post({ type: 'context.search', query: '' });
    }
  };

  // Search after a pause in typing. An empty query has nothing to search for.
  useEffect(() => {
    if (!open || query === '') return;
    const timer = setTimeout(() => {
      post({ type: 'context.search', query });
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [open, query, post]);

  // The picker can also stop being valid without an event (another conversation's draft appears).
  useEffect(() => {
    if (!open && searching.current) {
      searching.current = false;
      post({ type: 'context.search', query: '' });
    }
  }, [open, post]);

  useEffect(() => {
    return () => {
      if (searching.current) {
        searching.current = false;
        post({ type: 'context.search', query: '' });
      }
    };
  }, [post]);

  // After a selection the cursor goes to where the `@query` text was.
  useLayoutEffect(() => {
    const el = textarea.current;
    const caret = nextCaret.current;
    if (!el || caret === null) return;
    nextCaret.current = null;
    el.focus();
    el.setSelectionRange(caret, caret);
  }, [draft, textarea]);

  const select = (result: Result) => {
    if (picker === null) return;
    const mention = /^@\S*/.exec(draft.slice(picker.start));
    post({ type: 'context.add', path: result.path, kind: result.kind });
    if (mention) {
      nextCaret.current = picker.start;
      setDraft(draft.slice(0, picker.start) + draft.slice(picker.start + mention[0].length));
    }
    close();
  };

  const move = (delta: number) => {
    if (results === null || results.length === 0) return;
    const index = (activeIndex + delta + results.length) % results.length;
    setHighlight({ list: results, index });
  };

  const onTextChange = (text: string, caret: number) => {
    const token = findMention(text, caret);
    if (token === null) {
      close();
      return;
    }
    searching.current = true;
    setPicker({ draftKey, start: token.start, query: token.query });
  };

  const onCaretMove = (caret: number) => {
    if (!open) return;
    const token = findMention(draft, caret);
    if (token === null) close();
    else setPicker({ draftKey, start: token.start, query: token.query });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    const chosen = results?.[activeIndex];
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        if (results === null || results.length === 0) return false;
        event.preventDefault();
        move(event.key === 'ArrowDown' ? 1 : -1);
        return true;
      case 'Enter':
        // Shift+Enter is a line break, which ends the mention by itself.
        if (event.shiftKey) return false;
        event.preventDefault();
        if (chosen) select(chosen);
        return true;
      case 'Tab':
        if (event.shiftKey || !chosen) return false;
        event.preventDefault();
        select(chosen);
        return true;
      case 'Escape':
        event.preventDefault();
        close();
        return true;
      default:
        return false;
    }
  };

  const activeId = results?.[activeIndex] ? `${listId}-option-${String(activeIndex)}` : undefined;

  return {
    open,
    inputProps: {
      'aria-activedescendant': activeId,
      'aria-controls': results !== null && results.length > 0 ? listId : undefined,
    },
    onTextChange,
    onCaretMove,
    onKeyDown,
    onBlur: () => {
      if (open) close();
    },
    view: open
      ? {
          listId,
          query,
          results,
          activeIndex,
          onSelect: select,
          onHover: (index) => {
            if (results) setHighlight({ list: results, index });
          },
        }
      : null,
  };
}

export interface PickerViewProps {
  listId: string;
  query: string;
  /** Results for exactly this query, or null while they have not arrived. */
  results: readonly Result[] | null;
  activeIndex: number;
  onSelect: (result: Result) => void;
  onHover: (index: number) => void;
}

/** The popup under the composer's `@`: a listbox of files and folders, or a line that says why there are none. */
export function ReferencePicker({
  listId,
  query,
  results,
  activeIndex,
  onSelect,
  onHover,
}: PickerViewProps) {
  const status =
    query === ''
      ? 'Type to search files and folders'
      : results === null
        ? 'Searching…'
        : results.length === 0
          ? 'No matches'
          : null;

  return (
    <div
      className="reference-picker"
      // Keep focus in the textarea: a click on the popup must not blur it (which closes the picker).
      onMouseDown={(event) => {
        event.preventDefault();
      }}
    >
      {status !== null ? (
        <div className="reference-status" role="status">
          {status}
        </div>
      ) : (
        <ul id={listId} className="reference-list" role="listbox" aria-label="Files and folders">
          {(results ?? []).map((result, index) => {
            const { name, dir } = splitPath(result.path);
            return (
              <li
                key={`${result.kind}:${result.path}`}
                id={`${listId}-option-${String(index)}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`reference-option${index === activeIndex ? ' reference-option--active' : ''}`}
                title={result.path}
                onClick={() => {
                  onSelect(result);
                }}
                onMouseMove={() => {
                  if (index !== activeIndex) onHover(index);
                }}
              >
                <Icon name={result.kind === 'folder' ? 'folder' : 'file'} />
                <span className="reference-name">{name}</span>
                {dir !== '' && <span className="reference-dir">{dir}</span>}
                <span className="visually-hidden">
                  {result.kind === 'folder' ? ', folder' : ', file'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
