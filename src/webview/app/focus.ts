import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

interface Options {
  /** Where focus goes when the element that had it is gone and has no neighbour: a selector inside the container, or a function. The container itself is the last resort. */
  fallback?: string | (() => HTMLElement | null);
}

interface Remembered {
  element: Element;
  /** The list the element's row was in, and the row's position, to find a neighbour afterwards. */
  list: Element | null;
  index: number;
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]';

function isGone(element: Element): boolean {
  if (!element.isConnected) return true;
  return (
    (element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement) &&
    element.disabled
  );
}

/**
 * Keeps keyboard focus from being lost to the page when the control that had it is removed or
 * disabled by an update (accepting a file, answering a question, leaving a preview). Focus moves to
 * the control at the same position in the same list, or to the fallback, or to the container.
 * Call it in a component that re-renders when the content changes; the container needs `tabIndex={-1}`.
 */
export function useFocusRecovery(
  container: RefObject<HTMLElement | null>,
  options: Options = {},
): void {
  const remembered = useRef<Remembered | null>(null);
  const fallback = options.fallback;

  // Listen on the document: the container may only appear later (an empty state turns into a list).
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const element = event.target as Element;
      if (!container.current?.contains(element)) return;
      const row = element.closest('li');
      const list = row?.parentElement ?? null;
      remembered.current = {
        element,
        list,
        index: list && row ? Array.from(list.children).indexOf(row) : -1,
      };
    };
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [container]);

  useLayoutEffect(() => {
    const info = remembered.current;
    if (!info || !isGone(info.element)) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== info.element) {
      remembered.current = null;
      return;
    }
    remembered.current = null;
    const root = container.current;
    let target: HTMLElement | null = null;
    if (info.list?.isConnected && info.index >= 0) {
      const rows = Array.from(info.list.children);
      const row = rows[Math.min(info.index, rows.length - 1)];
      target = row?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
    }
    if (!target && typeof fallback === 'string')
      target = root?.querySelector<HTMLElement>(fallback) ?? null;
    if (!target && typeof fallback === 'function') target = fallback();
    (target ?? root)?.focus();
  });
}
