import { useEffect, useId, useRef } from 'react';
import type { ReviewEntry } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useViewState } from '../../app/store';
import { useUi } from '../../app/ui-state';
import { HunkList } from './HunkList';
import { ATTRIBUTION_NOTE, CHANGE_LABEL } from './review-model';

/** One file of the review. Pending entries have actions; accepted ones are marked and can still be read. */
export function ReviewEntryRow({
  entry,
  busy,
  busyHintId,
  uncertain,
}: {
  entry: ReviewEntry;
  busy: boolean;
  busyHintId: string;
  /** Show the explanation and the "Include in Reject All" checkbox. */
  uncertain: boolean;
}) {
  const { ui } = useApp();
  const post = usePost();
  const path = entry.path;
  const pending = entry.status === 'pending';
  const expandedKey = `review:${path}`;
  const expanded = useUi((s) => s.expanded[expandedKey] === true);
  const included = useUi((s) => s.reviewInclude[path] === true);
  const hunks = useViewState((s) => s.review.hunks[path]);
  const bodyId = useId();
  const noteId = useId();
  const requested = useRef(false);

  // Ask for the hunks the first time the entry is opened; the host keeps them up to date afterwards.
  useEffect(() => {
    if (expanded && hunks === undefined && !requested.current) {
      requested.current = true;
      post({ type: 'review.requestHunks', path });
    }
  }, [expanded, hunks, path, post]);

  const change = CHANGE_LABEL[entry.changeType];
  const hasCounts = entry.linesAdded !== undefined || entry.linesRemoved !== undefined;
  const disabledProps = (): { disabled: boolean; 'aria-describedby'?: string } => ({
    disabled: busy,
    ...(busy ? { 'aria-describedby': busyHintId } : {}),
  });

  return (
    <li className={`review-entry review-entry--${entry.status}`}>
      <div className="review-entry-head">
        <button
          type="button"
          className="icon-button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={`Changes in ${path}`}
          title={`Changes in ${path}`}
          onClick={() => {
            ui.setExpanded(expandedKey, !expanded);
          }}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
        </button>
        <span className={`review-marker review-marker--${entry.changeType}`}>
          <Icon name={change.icon} />
          <span>{change.label}</span>
        </span>
        <button
          type="button"
          className="review-path"
          aria-label={`Open diff of ${path}`}
          title={`Open diff of ${path}`}
          onClick={() => {
            post({ type: 'review.openDiff', path });
          }}
        >
          {path}
        </button>
        {entry.renamedFrom !== undefined && (
          <span className="review-meta muted">renamed from {entry.renamedFrom}</span>
        )}
        {hasCounts && (
          <span className="review-counts">
            <span aria-hidden="true">
              {entry.linesAdded !== undefined && `+${String(entry.linesAdded)}`}
              {entry.linesAdded !== undefined && entry.linesRemoved !== undefined && ' '}
              {entry.linesRemoved !== undefined && `−${String(entry.linesRemoved)}`}
            </span>
            <VisuallyHidden>
              {[
                entry.linesAdded !== undefined ? `${String(entry.linesAdded)} lines added` : null,
                entry.linesRemoved !== undefined
                  ? `${String(entry.linesRemoved)} lines removed`
                  : null,
              ]
                .filter((x) => x !== null)
                .join(', ')}
            </VisuallyHidden>
          </span>
        )}
        {!pending && (
          <span className="badge">
            <Icon name="check" />
            <span>Accepted</span>
          </span>
        )}
        {entry.includesUserEdits && <span className="badge">Includes your edits</span>}
        {!entry.restorable && (
          <span className="badge badge--warning" aria-describedby={entry.note ? noteId : undefined}>
            <Icon name="warning" />
            <span>Cannot be restored</span>
          </span>
        )}
      </div>

      {entry.note !== undefined && entry.note !== '' && (
        <p id={noteId} className="review-note muted">
          {entry.note}
        </p>
      )}
      {uncertain && (
        <div className="review-uncertain">
          <p className="review-note muted">{ATTRIBUTION_NOTE[entry.attribution]}</p>
          <label className="review-include">
            <input
              type="checkbox"
              checked={included}
              aria-label={`Include in Reject All: ${path}`}
              onChange={(event) => {
                ui.setReviewInclude(path, event.target.checked);
              }}
            />
            <span>Include in Reject All</span>
          </label>
        </div>
      )}

      {pending && (
        <div className="review-entry-actions">
          <button
            type="button"
            className="button button--secondary"
            aria-label={`Accept ${path}`}
            {...disabledProps()}
            onClick={() => {
              post({ type: 'review.acceptFile', path });
            }}
          >
            Accept
          </button>
          <button
            type="button"
            className="button button--secondary"
            aria-label={`Reject ${path}`}
            disabled={busy || !entry.restorable}
            aria-describedby={busy ? busyHintId : !entry.restorable ? noteId : undefined}
            onClick={() => {
              post({ type: 'review.rejectFile', path });
            }}
          >
            Reject
          </button>
          <button
            type="button"
            className="button button--secondary"
            aria-label={`Diff ${path}`}
            onClick={() => {
              post({ type: 'review.openDiff', path });
            }}
          >
            Diff
          </button>
        </div>
      )}

      <div id={bodyId} className="review-entry-body" hidden={!expanded}>
        {expanded && (
          <HunkList
            path={path}
            hunks={hunks}
            actions={pending}
            busy={busy}
            busyHintId={busyHintId}
          />
        )}
      </div>
    </li>
  );
}
