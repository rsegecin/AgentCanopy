import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConversationId, ConversationSummary } from '../../../shared';
import { Icon, IconButton, VisuallyHidden } from '../../app/components';
import { usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { forkStatusText } from '../branches/branch-model';
import { groupByDay, isNestedAside } from './grouping';

const SEARCH_DEBOUNCE_MS = 250;
const MODE_LABEL = { ask: 'Ask', plan: 'Plan', agent: 'Agent' } as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Wraps every occurrence of a query word in `<mark>`. Text only: nothing is parsed as HTML. */
export function highlightTerms(text: string, query: string): ReactNode[] {
  const terms = query
    .split(/\s+/)
    .filter((t) => t !== '')
    .map(escapeRegExp);
  if (terms.length === 0) return [text];
  const parts = text.split(new RegExp(`(${terms.join('|')})`, 'gi'));
  return parts.map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : <span key={index}>{part}</span>,
  );
}

/** Marks a side question: an icon and the words, with the parent named for screen readers. */
function AsideFlag({ parentTitle }: { parentTitle: string | undefined }) {
  return (
    <span className="history-flag">
      <Icon name="comment" />
      <span>Side question</span>
      <VisuallyHidden>
        {parentTitle !== undefined
          ? `. Asked while the agent was working in ${parentTitle}.`
          : '. Asked while the agent was working in another conversation.'}
      </VisuallyHidden>
    </span>
  );
}

type RowMode = 'idle' | 'renaming' | 'confirming-delete';

function Row({
  conversation,
  parentTitle,
  nested,
  active,
  onOpened,
}: {
  conversation: ConversationSummary;
  parentTitle: string | undefined;
  /** A side question listed under its parent. */
  nested: boolean;
  active: boolean;
  onOpened: () => void;
}) {
  const post = usePost();
  const autoOffered = useViewState((s) => s.agentAuto.offered);
  const [mode, setMode] = useState<RowMode>('idle');
  const [title, setTitle] = useState(conversation.title);
  const renameInput = useRef<HTMLInputElement>(null);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (mode === 'renaming') {
      renameInput.current?.focus();
      renameInput.current?.select();
    } else if (mode === 'confirming-delete') cancelDelete.current?.focus();
  }, [mode]);

  const finish = (next: 'rename' | 'delete') => {
    setMode('idle');
    // Put focus back on the action that was used, since the controls it replaced are gone.
    setTimeout(() => {
      (next === 'rename' ? renameButton : deleteButton).current?.focus();
    }, 0);
  };

  const confirmRename = () => {
    const next = title.trim();
    if (next !== '' && next !== conversation.title) {
      post({ type: 'conversation.rename', conversationId: conversation.id, title: next });
    }
    setTitle(next === '' ? conversation.title : next);
    finish('rename');
  };

  if (mode === 'renaming') {
    return (
      <li className="history-row history-row--editing">
        <input
          ref={renameInput}
          className="text-input"
          aria-label="Conversation title"
          value={title}
          maxLength={200}
          onChange={(event) => {
            setTitle(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              confirmRename();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setTitle(conversation.title);
              finish('rename');
            }
          }}
        />
        <IconButton icon="check" label="Save title" onClick={confirmRename} />
        <IconButton
          icon="close"
          label="Cancel rename"
          onClick={() => {
            setTitle(conversation.title);
            finish('rename');
          }}
        />
      </li>
    );
  }

  if (mode === 'confirming-delete') {
    return (
      <li
        className="history-row history-row--confirm"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            finish('delete');
          }
        }}
      >
        <p role="alert">Delete “{conversation.title}”? This cannot be undone.</p>
        <div className="row-buttons">
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              post({ type: 'conversation.delete', conversationId: conversation.id });
            }}
          >
            Delete
          </button>
          <button
            ref={cancelDelete}
            type="button"
            className="button button--secondary"
            onClick={() => {
              finish('delete');
            }}
          >
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`history-row${active ? ' history-row--active' : ''}${nested ? ' history-row--aside' : ''}`}
    >
      <button
        type="button"
        className="history-open"
        aria-current={active ? 'true' : undefined}
        onClick={() => {
          post({ type: 'conversation.open', conversationId: conversation.id });
          onOpened();
        }}
      >
        <span className="history-title" title={conversation.title}>
          {conversation.title || 'Untitled conversation'}
        </span>
        {conversation.preview !== '' && (
          <span className="history-preview" title={conversation.preview}>
            {conversation.preview}
          </span>
        )}
        <span className="history-meta">
          <span className="badge">{MODE_LABEL[conversation.mode]}</span>
          {conversation.running && (
            <span className="history-flag">
              <Icon name="loading" spin />
              <span>Running</span>
            </span>
          )}
          {conversation.pendingPrompts > 0 && (
            <span className="badge badge--attention">
              <Icon name="bell" />
              <span>{conversation.pendingPrompts} waiting for your answer</span>
            </span>
          )}
          {autoOffered && conversation.agentAuto === true && (
            <span className="history-flag">
              <Icon name="pass-filled" />
              <span>Auto</span>
              <VisuallyHidden>. Auto is on for this conversation's Agent turns.</VisuallyHidden>
            </span>
          )}
          {conversation.aside !== undefined && <AsideFlag parentTitle={parentTitle} />}
          {conversation.fork && conversation.aside === undefined && (
            <span className="history-flag" title={forkStatusText(conversation.fork)}>
              <Icon name="repo-forked" />
              <span>{parentTitle !== undefined ? `Branch of ${parentTitle}` : 'Branch'}</span>
              <VisuallyHidden>{`. ${forkStatusText(conversation.fork)}`}</VisuallyHidden>
            </span>
          )}
        </span>
      </button>
      <div className="row-actions">
        <IconButton
          ref={renameButton}
          icon="edit"
          label={`Rename ${conversation.title}`}
          onClick={() => {
            setTitle(conversation.title);
            setMode('renaming');
          }}
        />
        <IconButton
          ref={deleteButton}
          icon="trash"
          label={`Delete ${conversation.title}`}
          onClick={() => {
            setMode('confirming-delete');
          }}
        />
      </div>
    </li>
  );
}

export function HistoryList({
  onOpened,
  now,
}: {
  /** Called after a conversation was opened, so the app can switch to the chat tab. */
  onOpened: () => void;
  /** Injectable clock for the day groups. */
  now?: number;
}) {
  const post = usePost();
  const conversations = useViewState((s) => s.conversations);
  const search = useViewState((s) => s.search);
  const activeId = useViewState((s) => s.active?.meta.id);

  const [query, setQuery] = useState(search?.query ?? '');
  const [mountedAt] = useState(() => Date.now());
  const searchId = useId();
  const lastSent = useRef(search?.query ?? '');
  const root = useRef<HTMLDivElement>(null);
  // Deleting a conversation removes the row that had focus: move to its neighbour.
  useFocusRecovery(root, { fallback: 'input[type="search"]' });

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === lastSent.current) return;
    const timer = setTimeout(() => {
      lastSent.current = trimmed;
      post({ type: 'conversation.search', query: trimmed });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [query, post]);

  const trimmedQuery = query.trim();
  const searching = trimmedQuery !== '';
  const titles = new Map<ConversationId, string>(conversations.map((c) => [c.id, c.title]));
  const byId = new Map(conversations.map((c) => [c.id as string, c]));
  const parentTitleOf = (c: ConversationSummary): string | undefined => {
    const parentId = c.fork?.parentId ?? c.aside?.parentId;
    return parentId === undefined ? undefined : titles.get(parentId);
  };
  const groups = groupByDay(conversations, now ?? mountedAt);

  return (
    <div ref={root} className="history" tabIndex={-1}>
      <div className="column">
        <div className="search">
          <label htmlFor={searchId} className="visually-hidden">
            Search conversations
          </label>
          <Icon name="search" />
          <input
            id={searchId}
            type="search"
            className="text-input"
            placeholder="Search conversations"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
        </div>

        {searching ? (
          <div
            className="search-results"
            aria-busy={search?.query !== trimmedQuery}
            role="region"
            aria-label="Search results"
          >
            {search?.results.length === 0 && (
              <p className="muted" role="status">
                No conversations match “{search.query}”.
              </p>
            )}
            {search === null && (
              <p className="muted" role="status">
                Searching…
              </p>
            )}
            {search && search.results.length > 0 && (
              <ul className="history-list">
                {search.results.map((result, index) => {
                  const summary = byId.get(result.conversationId);
                  return (
                    <li key={`${result.conversationId}:${String(index)}`} className="history-row">
                      <button
                        type="button"
                        className="history-open"
                        onClick={() => {
                          post({
                            type: 'conversation.open',
                            conversationId: result.conversationId,
                          });
                          onOpened();
                        }}
                      >
                        <span className="history-title">{result.title}</span>
                        {summary?.aside !== undefined && (
                          <span className="history-meta">
                            <AsideFlag parentTitle={parentTitleOf(summary)} />
                          </span>
                        )}
                        <span className="history-preview history-snippet">
                          {highlightTerms(result.snippet, trimmedQuery)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : conversations.length === 0 ? (
          <p className="muted">No conversations yet. Start one with the + button.</p>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="history-group" aria-label={group.label}>
              <h2 className="group-heading">{group.label}</h2>
              <ul className="history-list">
                {group.conversations.map((conversation) => (
                  <Row
                    key={conversation.id}
                    conversation={conversation}
                    parentTitle={parentTitleOf(conversation)}
                    nested={isNestedAside(conversation, byId)}
                    active={conversation.id === activeId}
                    onOpened={onOpened}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
