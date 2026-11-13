import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { Banners } from '../features/banners/Banners';
import { Composer, MessageList } from '../features/chat';
import { HistoryList } from '../features/history/HistoryList';
import { PlanView } from '../features/plan';
import { CheckpointsView } from '../features/checkpoints/CheckpointsView';
import { ChangesDock } from '../features/review/ChangesDock';
import { Icon, IconButton } from './components';
import { useApp, usePost } from './context';
import { OverflowMenu } from './OverflowMenu';
import { ProviderIndicator } from './ProviderIndicator';
import { useStoreReady, useViewState } from './store';
import { Toasts } from './Toasts';
import { NEW_CONVERSATION_KEY, useUi } from './ui-state';
import type { Tab } from './ui-state';

const ALL_TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'plan', label: 'Plan' },
  { id: 'checkpoints', label: 'Checkpoints' },
  { id: 'history', label: 'History' },
];

/** Which optional tabs exist, and the tab in use: a tab that has gone away falls back to Chat. */
function useCurrentTab(): { tab: Tab; hasPlan: boolean; hasCheckpoints: boolean } {
  const stored = useUi((s) => s.tab);
  const hasPlan = useViewState((s) => s.active?.plan != null);
  const hasCheckpoints = useViewState((s) => s.checkpoints.length > 0 || s.restorePreview !== null);
  const gone = (stored === 'plan' && !hasPlan) || (stored === 'checkpoints' && !hasCheckpoints);
  return { tab: gone ? 'chat' : stored, hasPlan, hasCheckpoints };
}

function Tabs({ idPrefix }: { idPrefix: string }) {
  const { ui } = useApp();
  const { tab, hasPlan, hasCheckpoints } = useCurrentTab();
  const tabs = ALL_TABS.filter(
    (t) => (t.id !== 'plan' || hasPlan) && (t.id !== 'checkpoints' || hasCheckpoints),
  );

  const select = (next: Tab, focus: boolean) => {
    ui.setTab(next);
    if (focus) document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const index = tabs.findIndex((t) => t.id === tab);
    let target: number | null = null;
    if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = tabs.length - 1;
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    if (next) select(next.id, true);
  };

  return (
    <div className="tabs" role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`${idPrefix}-tab-${t.id}`}
          type="button"
          role="tab"
          className="tab"
          aria-selected={tab === t.id}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={tab === t.id ? 0 : -1}
          onClick={() => {
            select(t.id, false);
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const { store, ui } = useApp();
  const post = usePost();
  const ready = useStoreReady();
  const { tab, hasPlan, hasCheckpoints } = useCurrentTab();
  const idPrefix = useId();

  useEffect(() => {
    return store.onEvent((event) => {
      if (event.kind === 'show-tab') {
        if (event.tab === 'review') {
          // The host may still ask for the Review tab; its content now sits under the chat.
          ui.setTab('chat');
        } else if (
          event.tab === 'chat' ||
          event.tab === 'history' ||
          event.tab === 'plan' ||
          event.tab === 'checkpoints'
        ) {
          ui.setTab(event.tab);
        }
      } else if (event.kind === 'focus-composer' || event.kind === 'prefill-composer') {
        ui.setTab('chat');
        if (event.kind === 'prefill-composer') {
          // The composer is not mounted while another tab is open, so it cannot take this itself.
          const id = store.getSnapshot().state?.active?.meta.id;
          ui.setDraft(id ?? NEW_CONVERSATION_KEY, event.text);
        }
        // Once the chat tab has rendered, the composer is there to take focus.
        setTimeout(() => {
          document.querySelector<HTMLElement>('textarea[aria-label="Message"]')?.focus();
        }, 0);
      }
    });
  }, [store, ui]);

  // When the tab changes and the control that had focus went with the old tab (a button in the chat
  // that opens the plan, say), focus moves to the new panel. It is never moved if the user has put
  // it somewhere that still exists: the composer, or the tab they just pressed.
  const previousTab = useRef(tab);
  useLayoutEffect(() => {
    if (previousTab.current === tab) return;
    previousTab.current = tab;
    const active = document.activeElement;
    if (!active || active === document.body) {
      document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')?.focus();
    }
  }, [tab]);

  useEffect(() => {
    const flush = () => {
      ui.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ui]);

  if (!ready) {
    return (
      <div className="app app--loading" role="status">
        <Icon name="loading" spin />
        <span>Loading…</span>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <IconButton
          icon="add"
          label="New conversation"
          onClick={() => {
            ui.setTab('chat');
            post({ type: 'conversation.new' });
          }}
        />
        <Tabs idPrefix={idPrefix} />
        <ProviderIndicator />
        <OverflowMenu />
      </header>
      <Banners />
      <Toasts />
      <main className="app-main">
        <div
          id={`${idPrefix}-panel-chat`}
          className="tabpanel"
          role="tabpanel"
          tabIndex={-1}
          aria-labelledby={`${idPrefix}-tab-chat`}
          hidden={tab !== 'chat'}
        >
          {tab === 'chat' && (
            <>
              <MessageList />
              <ChangesDock />
              <Composer />
            </>
          )}
        </div>
        {hasPlan && (
          <div
            id={`${idPrefix}-panel-plan`}
            className="tabpanel"
            role="tabpanel"
            tabIndex={-1}
            aria-labelledby={`${idPrefix}-tab-plan`}
            hidden={tab !== 'plan'}
          >
            {tab === 'plan' && <PlanView />}
          </div>
        )}
        {hasCheckpoints && (
          <div
            id={`${idPrefix}-panel-checkpoints`}
            className="tabpanel"
            role="tabpanel"
            tabIndex={-1}
            aria-labelledby={`${idPrefix}-tab-checkpoints`}
            hidden={tab !== 'checkpoints'}
          >
            {tab === 'checkpoints' && <CheckpointsView />}
          </div>
        )}
        <div
          id={`${idPrefix}-panel-history`}
          className="tabpanel"
          role="tabpanel"
          tabIndex={-1}
          aria-labelledby={`${idPrefix}-tab-history`}
          hidden={tab !== 'history'}
        >
          {tab === 'history' && (
            <HistoryList
              onOpened={() => {
                ui.setTab('chat');
              }}
            />
          )}
        </div>
      </main>
    </div>
  );
}
