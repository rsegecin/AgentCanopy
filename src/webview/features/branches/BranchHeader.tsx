import { Icon } from '../../app/components';
import { usePost } from '../../app/context';
import { useViewState } from '../../app/store';
import { FORK_ICON, forkStatusText } from './branch-model';

/** At the top of a branch: which conversation it came from, and how exact its context is. */
export function BranchHeader() {
  const post = usePost();
  const fork = useViewState((s) => s.active?.meta.fork);
  const parentTitle = useViewState((s) => {
    const parent = s.active?.meta.fork?.parentId;
    return parent === undefined ? undefined : s.conversations.find((c) => c.id === parent)?.title;
  });
  if (!fork) return null;
  const parentId = fork.parentId;
  return (
    <div className="branch-header" role="group" aria-label="Branch information">
      <p className="branch-parent">
        <Icon name="repo-forked" />
        <span>Branch of </span>
        {parentTitle !== undefined ? (
          <button
            type="button"
            className="branch-link"
            aria-label={`Open the parent conversation: ${parentTitle}`}
            onClick={() => {
              post({ type: 'conversation.open', conversationId: parentId });
            }}
          >
            {parentTitle || 'Untitled conversation'}
          </button>
        ) : (
          <span>a conversation that was deleted</span>
        )}
      </p>
      <p className={`branch-status branch-status--${fork.exactness}`}>
        <Icon name={FORK_ICON[fork.exactness]} />
        <span>{forkStatusText(fork)}</span>
      </p>
    </div>
  );
}
