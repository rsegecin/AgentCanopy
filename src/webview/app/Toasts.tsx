import { useEffect, useRef, useState } from 'react';
import { Icon, IconButton } from './components';
import { useApp } from './context';
import { useFocusRecovery } from './focus';
import { VisuallyHidden } from './components';

interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

const TOAST_LABEL = { info: 'Note', warning: 'Warning', error: 'Error' } as const;
const TOAST_MS = 8000;
const MAX_TOASTS = 4;

/** Shows `toast` events from the host for a few seconds. */
export function Toasts() {
  const { store } = useApp();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const root = useRef<HTMLDivElement>(null);
  // Dismissing a notification removes the button that had focus: go back to the composer.
  useFocusRecovery(root, {
    fallback: () => document.querySelector<HTMLElement>('textarea[aria-label="Message"]'),
  });

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = store.onEvent((event) => {
      if (event.kind !== 'toast') return;
      const id = nextId.current++;
      setToasts((list) =>
        [...list, { id, level: event.level, text: event.text }].slice(-MAX_TOASTS),
      );
      const timer = setTimeout(() => {
        timers.delete(timer);
        setToasts((list) => list.filter((t) => t.id !== id));
      }, TOAST_MS);
      timers.add(timer);
    });
    return () => {
      off();
      timers.forEach(clearTimeout);
    };
  }, [store]);

  return (
    <div ref={root} className="toasts" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast--${toast.level}`}
          role={toast.level === 'error' ? 'alert' : undefined}
        >
          <Icon name={toast.level === 'info' ? 'info' : toast.level} />
          <span>
            <VisuallyHidden>{TOAST_LABEL[toast.level]}: </VisuallyHidden>
            {toast.text}
          </span>
          <IconButton
            icon="close"
            label="Dismiss notification"
            onClick={() => {
              setToasts((list) => list.filter((t) => t.id !== toast.id));
            }}
          />
        </div>
      ))}
    </div>
  );
}
