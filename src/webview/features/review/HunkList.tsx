import type { Hunk } from '../../../shared';
import { VisuallyHidden } from '../../app/components';
import { usePost } from '../../app/context';
import { hunkLines } from './review-model';

/** The line-level changes of one file. Accept and reject buttons are left out for accepted entries. */
export function HunkList({
  path,
  hunks,
  actions,
  busy,
  busyHintId,
}: {
  path: string;
  /** Undefined until the host has sent them. */
  hunks: readonly Hunk[] | undefined;
  /** False for an accepted entry: there is nothing to decide. */
  actions: boolean;
  /** True while a turn runs: accepting and rejecting wait. */
  busy: boolean;
  busyHintId: string;
}) {
  const post = usePost();
  if (hunks === undefined) {
    return (
      <p className="review-hunks-note muted" role="status">
        Loading changes…
      </p>
    );
  }
  if (hunks.length === 0) {
    return <p className="review-hunks-note muted">No line-level changes to show</p>;
  }
  return (
    <ul className="review-hunks" aria-label={`Changes in ${path}`}>
      {hunks.map((hunk) => {
        const { lines, hidden } = hunkLines(hunk);
        const n = hunk.index + 1;
        return (
          <li key={hunk.id} className="review-hunk">
            <div className="review-hunk-head">
              <span className="plan-label">
                Change {n}, line {hunk.currentStart + 1}
              </span>
              {actions && (
                <span className="review-hunk-actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    aria-label={`Accept Change ${String(n)} in ${path}`}
                    disabled={busy}
                    aria-describedby={busy ? busyHintId : undefined}
                    onClick={() => {
                      post({ type: 'review.acceptHunk', path, hunkId: hunk.id });
                    }}
                  >
                    Accept Change
                  </button>
                  <button
                    type="button"
                    className="button button--secondary"
                    aria-label={`Reject Change ${String(n)} in ${path}`}
                    disabled={busy}
                    aria-describedby={busy ? busyHintId : undefined}
                    onClick={() => {
                      post({ type: 'review.rejectHunk', path, hunkId: hunk.id });
                    }}
                  >
                    Reject Change
                  </button>
                </span>
              )}
            </div>
            <div
              className="tool-card-pre review-hunk-lines"
              role="group"
              aria-label={`Lines of change ${String(n)} in ${path}`}
              tabIndex={0}
            >
              {lines.map((line, index) => {
                const removed = line.sign === '-';
                return (
                  <div
                    key={index}
                    className={`diff-line ${removed ? 'diff-line--removed' : 'diff-line--added'}`}
                  >
                    <VisuallyHidden>{removed ? 'removed' : 'added'} </VisuallyHidden>
                    <span className="diff-sign" aria-hidden="true">
                      {line.sign}
                    </span>
                    <span className="diff-text">{line.text}</span>
                    {line.noEol && (
                      <span className="review-no-eol"> No newline at end of file</span>
                    )}
                  </div>
                );
              })}
            </div>
            {hidden > 0 && (
              <p className="tool-card-note">
                {hidden} more {hidden === 1 ? 'line' : 'lines'}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
