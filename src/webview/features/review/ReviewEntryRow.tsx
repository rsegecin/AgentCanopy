import { useId } from 'react';
import type { ReviewEntry } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useUi } from '../../app/ui-state';
import { ATTRIBUTION_NOTE, CHANGE_LABEL } from './review-model';

/** One file of the card of a turn or of the strip. Pending entries have actions; accepted ones are marked. */
export function ReviewEntryRow({
  entry,
  uncertain,
  readOnly = false,
}: {
  entry: ReviewEntry;
  /** Show the explanation and the "Include in Reject All" checkbox. */
  uncertain: boolean;
  /** No Accept, Reject or checkbox: the row only tells what changed (an Agent turn is running). */
  readOnly?: boolean;
}) {
  const { ui } = useApp();
  const post = usePost();
  const path = entry.path;
  const pending = entry.status === 'pending';
  const included = useUi((s) => s.reviewInclude[path] === true);
  const noteId = useId();

  const change = CHANGE_LABEL[entry.changeType];
  const hasCounts = entry.linesAdded !== undefined || entry.linesRemoved !== undefined;

  return (
    <li className={`review-entry review-entry--${entry.status}`}>
      <div className="review-entry-head">
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
          {!readOnly && (
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
          )}
        </div>
      )}

      {pending && !readOnly && (
        <div className="review-entry-actions">
          <button
            type="button"
            className="button button--secondary"
            aria-label={`Accept ${path}`}
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
            disabled={!entry.restorable}
            aria-describedby={!entry.restorable ? noteId : undefined}
            onClick={() => {
              post({ type: 'review.rejectFile', path });
            }}
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}
