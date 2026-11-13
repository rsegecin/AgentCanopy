import { useId, useState } from 'react';
import type { ConversationSummary } from '../../../shared';
import { Icon } from '../../app/components';
import { usePost } from '../../app/context';

/** On a message that branches were taken from: how many, and a way to open each. */
export function BranchMarker({ branches }: { branches: readonly ConversationSummary[] }) {
  const post = usePost();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const n = branches.length;
  return (
    <div className="branch-marker">
      <button
        type="button"
        className="branch-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <Icon name="repo-forked" />
        <span>
          {n} {n === 1 ? 'branch' : 'branches'}
        </span>
      </button>
      <ul
        id={listId}
        className="branch-list"
        aria-label="Branches from this message"
        hidden={!open}
      >
        {open &&
          branches.map((branch) => (
            <li key={branch.id}>
              <button
                type="button"
                className="branch-link"
                aria-label={`Open branch ${branch.title}`}
                onClick={() => {
                  post({ type: 'conversation.open', conversationId: branch.id });
                }}
              >
                {branch.title || 'Untitled conversation'}
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}
