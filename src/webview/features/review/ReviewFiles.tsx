import { useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ReviewEntry } from '../../../shared';
import { Icon } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useUi } from '../../app/ui-state';
import { ReviewEntryRow } from './ReviewEntryRow';
import { countFiles, groupEntries } from './review-model';

/** The key of the Accepted toggle in `ui.expanded`: one per card, and one for the strip. */
const ACCEPTED_KEY = 'review:accepted';

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h4 id={headingId} className="review-heading">
        {title} <span className="review-count muted">{count}</span>
      </h4>
      {children}
    </section>
  );
}

/**
 * The files of a review: the toolbar, the pending files by who changed them, and the accepted ones
 * collapsed. Used by the strip below the chat and by the card of a turn.
 */
export function ReviewFiles({
  entries,
  title,
  scopeKey,
  readOnly = false,
  wholeFolder = false,
}: {
  /** What to list. */
  entries: readonly ReviewEntry[];
  /** A heading for the section. Without it the section is named "Files" (the card has its own heading). */
  title?: string;
  /** Keeps the open state of the Accepted group apart from other lists (a card passes its message id). */
  scopeKey?: string;
  /** No buttons that change anything: an Agent turn is running. */
  readOnly?: boolean;
  /** The toolbar acts on the whole folder, not only on the files listed. */
  wholeFolder?: boolean;
}) {
  const { ui } = useApp();
  const post = usePost();
  const include = useUi((s) => s.reviewInclude);
  const acceptedKey = scopeKey === undefined ? ACCEPTED_KEY : `${ACCEPTED_KEY}:${scopeKey}`;
  const acceptedOpen = useUi((s) => s.expanded[acceptedKey] === true);
  const headingId = useId();
  const acceptedId = useId();
  const acceptedHeadingId = useId();

  const groups = useMemo(() => groupEntries(entries), [entries]);
  const pending: ReviewEntry[] = [...groups.agent, ...groups.uncertain];
  const files = countFiles(pending);
  const includePaths = groups.uncertain.filter((e) => include[e.path] === true).map((e) => e.path);
  const acceptedCount = groups.accepted.length;
  // A card acts on its own files only; the strip acts on the whole folder when it lists all of it.
  const scope = wholeFolder ? {} : { paths: pending.map((e) => e.path) };

  const summary = (
    <p className="review-summary" tabIndex={-1}>
      {pending.length} pending {pending.length === 1 ? 'change' : 'changes'} in {files}{' '}
      {files === 1 ? 'file' : 'files'}
    </p>
  );

  return (
    <section
      className="review-section"
      aria-labelledby={title !== undefined ? headingId : undefined}
      aria-label={title === undefined ? 'Files' : undefined}
    >
      {title !== undefined && (
        <h3 id={headingId} className="review-heading">
          {title}
        </h3>
      )}

      {pending.length > 0 &&
        (readOnly ? (
          summary
        ) : (
          <div className="review-toolbar" role="group" aria-label="Review actions">
            {summary}
            <div className="review-toolbar-buttons">
              <button
                type="button"
                className="button"
                onClick={() => {
                  post({ type: 'review.acceptAll', ...scope });
                }}
              >
                Accept All
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  post({ type: 'review.rejectAll', includePaths, ...scope });
                }}
              >
                Reject All
              </button>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  post({ type: 'review.openAll', ...scope });
                }}
              >
                Open All in Diff Editor
              </button>
            </div>
          </div>
        ))}

      {groups.agent.length > 0 && (
        <Group title="Agent changes" count={groups.agent.length}>
          <ul className="review-list">
            {groups.agent.map((entry) => (
              <ReviewEntryRow
                key={entry.path}
                entry={entry}
                uncertain={false}
                readOnly={readOnly}
              />
            ))}
          </ul>
        </Group>
      )}

      {groups.uncertain.length > 0 && (
        <Group title="Changed during a turn, source uncertain" count={groups.uncertain.length}>
          {!readOnly && (
            <p className="review-note muted">
              Reject All leaves these files alone unless you tick them.
            </p>
          )}
          <ul className="review-list">
            {groups.uncertain.map((entry) => (
              <ReviewEntryRow key={entry.path} entry={entry} uncertain readOnly={readOnly} />
            ))}
          </ul>
        </Group>
      )}

      {acceptedCount > 0 && (
        <section className="review-section" aria-labelledby={acceptedHeadingId}>
          <h4 id={acceptedHeadingId} className="review-heading">
            <button
              type="button"
              className="plan-section-toggle"
              aria-expanded={acceptedOpen}
              aria-controls={acceptedId}
              onClick={() => {
                ui.setExpanded(acceptedKey, !acceptedOpen);
              }}
            >
              <Icon name={acceptedOpen ? 'chevron-down' : 'chevron-right'} />
              {pending.length === 0 ? (
                <span>{`No pending changes, ${String(acceptedCount)} accepted`}</span>
              ) : (
                <>
                  <span>Accepted</span>
                  <span className="review-count muted">{acceptedCount}</span>
                </>
              )}
            </button>
          </h4>
          <div id={acceptedId} hidden={!acceptedOpen}>
            {acceptedOpen && (
              <ul className="review-list">
                {groups.accepted.map((entry) => (
                  <ReviewEntryRow key={entry.path} entry={entry} uncertain={false} />
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
