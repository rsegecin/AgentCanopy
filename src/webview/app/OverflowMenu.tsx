import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { IconButton } from './components';
import { useApp, usePost } from './context';
import { useViewState } from './store';

export function OverflowMenu() {
  const { ui } = useApp();
  const post = usePost();
  const activeId = useViewState((s) => s.active?.meta.id);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => {
      event.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown':
        focus(index + 1);
        break;
      case 'ArrowUp':
        focus(index - 1);
        break;
      case 'Home':
        focus(0);
        break;
      case 'End':
        focus(list.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  const choose = (action: () => void) => {
    action();
    close(true);
  };

  return (
    <div className="overflow">
      <IconButton
        ref={trigger}
        icon="ellipsis"
        label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setOpen((o) => !o);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      {open && (
        <div
          id={menuId}
          ref={menu}
          className="menu"
          role="menu"
          aria-label="More actions"
          onKeyDown={onMenuKeyDown}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              choose(() => {
                post({
                  type: 'conversation.openInEditor',
                  ...(activeId !== undefined ? { conversationId: activeId } : {}),
                });
              });
            }}
          >
            Open in editor area
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              choose(() => {
                ui.setTab('permissions');
              });
            }}
          >
            Permissions
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              choose(() => {
                post({ type: 'logs.show' });
              });
            }}
          >
            Show logs
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              choose(() => {
                post({ type: 'provider.refresh' });
              });
            }}
          >
            Refresh provider
          </button>
        </div>
      )}
    </div>
  );
}
