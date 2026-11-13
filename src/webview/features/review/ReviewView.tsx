import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReviewEntry } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { isTurnRunning } from '../../app/turns';
import { useUi } from '../../app/ui-state';
import { ConfigChanges } from './ConfigChanges';
import { ReviewEntryRow } from './ReviewEntryRow';
import { countFiles, groupEntries } from './review-model';

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="review-heading">
        {title} <span className="review-count muted">{count}</span>
      </h2>
      {children}
    </section>
  );
}

const ACCEPTED_KEY = 'review:accepted';

/** The Review tab: configuration changes, pending changes, accepted changes and the snapshot status. */
export function ReviewView() {
  const { ui } = useApp();
  const post = usePost();
  const review = useViewState((s) => s.review);
  const turns = useViewState((s) => s.active?.turns);
  const include = useUi((s) => s.reviewInclude);
  const acceptedOpen = useUi((s) => s.expanded[ACCEPTED_KEY] === true);
  const hintId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  useFocusRecovery(scroller, { fallback: '.review-summary' });
  const acceptedId = useId();
  const acceptedHeadingId = useId();

  const groups = useMemo(() => groupEntries(review.entries), [review.entries]);
  const busy = isTurnRunning(turns);
  const pending: ReviewEntry[] = [...groups.agent, ...groups.uncertain];
  const empty = review.entries.length === 0 && review.configChanges.length === 0;

  if (empty) {
    return (
      <div className="empty-state">
        <Icon name="diff" />
        <p>No agent changes to review.</p>
      </div>
    );
  }

  const files = countFiles(pending);
  const includePaths = groups.uncertain.filter((e) => include[e.path] === true).map((e) => e.path);
  const busyProps = {
    disabled: busy,
    ...(busy ? { 'aria-describedby': hintId } : {}),
  };

  return (
    <div className="review-view">
      <div ref={scroller} className="review-scroll" tabIndex={-1}>
        <div className="column">
          {review.configChanges.length > 0 && <ConfigChanges changes={review.configChanges} />}

          {pending.length > 0 ? (
            <div className="review-toolbar" role="group" aria-label="Review actions">
              <p className="review-summary" tabIndex={-1}>
                {pending.length} pending {pending.length === 1 ? 'change' : 'changes'} in {files}{' '}
                {files === 1 ? 'file' : 'files'}
              </p>
              <div className="review-toolbar-buttons">
                <button
                  type="button"
                  className="button"
                  {...busyProps}
                  onClick={() => {
                    post({ type: 'review.acceptAll' });
                  }}
                >
                  Accept All
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  {...busyProps}
                  onClick={() => {
                    post({ type: 'review.rejectAll', includePaths });
                  }}
                >
                  Reject All
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => {
                    post({ type: 'review.openAll' });
                  }}
                >
                  Open All in Diff Editor
                </button>
              </div>
              {busy && (
                <p id={hintId} className="review-hint muted">
                  Wait for the turn to finish.
                </p>
              )}
            </div>
          ) : (
            <p className="review-summary muted" tabIndex={-1}>
              No pending changes
            </p>
          )}

          {groups.agent.length > 0 && (
            <Group title="Agent changes" count={groups.agent.length}>
              <ul className="review-list">
                {groups.agent.map((entry) => (
                  <ReviewEntryRow
                    key={entry.path}
                    entry={entry}
                    busy={busy}
                    busyHintId={hintId}
                    uncertain={false}
                  />
                ))}
              </ul>
            </Group>
          )}

          {groups.uncertain.length > 0 && (
            <Group title="Changed during a turn, source uncertain" count={groups.uncertain.length}>
              <p className="review-note muted">
                Reject All leaves these files alone unless you tick them.
              </p>
              <ul className="review-list">
                {groups.uncertain.map((entry) => (
                  <ReviewEntryRow
                    key={entry.path}
                    entry={entry}
                    busy={busy}
                    busyHintId={hintId}
                    uncertain
                  />
                ))}
              </ul>
            </Group>
          )}

          {groups.accepted.length > 0 && (
            <section className="review-section" aria-labelledby={acceptedHeadingId}>
              <h2 id={acceptedHeadingId} className="review-heading">
                <button
                  type="button"
                  className="plan-section-toggle"
                  aria-expanded={acceptedOpen}
                  aria-controls={acceptedId}
                  onClick={() => {
                    ui.setExpanded(ACCEPTED_KEY, !acceptedOpen);
                  }}
                >
                  <Icon name={acceptedOpen ? 'chevron-down' : 'chevron-right'} />
                  <span>Accepted</span>
                  <span className="review-count muted">{groups.accepted.length}</span>
                </button>
              </h2>
              <div id={acceptedId} hidden={!acceptedOpen}>
                {acceptedOpen && (
                  <ul className="review-list">
                    {groups.accepted.map((entry) => (
                      <ReviewEntryRow
                        key={entry.path}
                        entry={entry}
                        busy={busy}
                        busyHintId={hintId}
                        uncertain={false}
                      />
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          <SnapshotStatus />
        </div>
      </div>
    </div>
  );
}

/** Progress is announced at most this often, not on every file. */
export const SNAPSHOT_ANNOUNCE_MS = 5000;

function SnapshotStatus() {
  const baseline = useViewState((s) => s.baseline);
  const labelId = useId();
  const capturing = baseline.state === 'capturing';
  const text = `Preparing the workspace snapshot: ${String(baseline.filesDone)} of ${String(baseline.filesTotal)} files`;
  const latest = useRef(text);
  const [announced, setAnnounced] = useState(text);
  useEffect(() => {
    latest.current = text;
  }, [text]);
  useEffect(() => {
    if (!capturing) return;
    const timer = setInterval(() => {
      setAnnounced(latest.current);
    }, SNAPSHOT_ANNOUNCE_MS);
    return () => {
      clearInterval(timer);
    };
  }, [capturing]);

  if (capturing) {
    return (
      <div className="review-snapshot">
        <p id={labelId}>{text}</p>
        <progress
          aria-labelledby={labelId}
          max={baseline.filesTotal > 0 ? baseline.filesTotal : undefined}
          value={baseline.filesTotal > 0 ? baseline.filesDone : undefined}
        />
        <div className="visually-hidden" role="status" aria-live="polite">
          {announced}
        </div>
      </div>
    );
  }
  if (baseline.state === 'degraded') {
    return (
      <div className="notice notice--warning review-snapshot" role="note">
        <Icon name="warning" />
        <span>
          <VisuallyHidden>Warning: </VisuallyHidden>
          {baseline.note ??
            'The workspace snapshot is incomplete, so some changes cannot be restored.'}
        </span>
      </div>
    );
  }
  return null;
}
