import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ConfigChange } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useStoreReady, useViewState } from '../../app/store';
import { useUi } from '../../app/ui-state';
import { ReviewFiles } from './ReviewFiles';
import { cardOperationsSelector, elsewhere, groupEntries } from './review-model';

/** Progress is announced at most this often, not on every file. */
export const SNAPSHOT_ANNOUNCE_MS = 5000;

export const CONFIG_WARNING =
  'The last turn changed tool or editor configuration. Such files can make later commands run without asking. Keep or revert each one before the next Agent turn.';

/** The `ui.expanded` map stores only `true`, so the dock is open unless this key is set. */
const COLLAPSED_KEY = 'changes-dock-collapsed';

const TYPE_LABEL = { created: 'Created', modified: 'Modified', deleted: 'Deleted' } as const;
const TYPE_ICON = {
  created: 'diff-added',
  modified: 'diff-modified',
  deleted: 'diff-removed',
} as const;

/** Where focus goes when the card loses it: the textarea, or the composer form while it is disabled. */
export function composerInput(): HTMLElement | null {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (textarea && !textarea.disabled) return textarea;
  return document.querySelector<HTMLElement>('form.composer');
}

/**
 * The strip between the chat log and the composer: configuration changes the user must decide on,
 * and the pending files no card of the open conversation acts on (changes of another conversation,
 * of an earlier session, or made outside a turn of this one). The files of a turn are in the card
 * where the turn ended. It renders nothing when there is nothing to decide.
 * The configuration section is always shown; the header collapses what is below it.
 */
export function ChangesDock() {
  const { ui } = useApp();
  const ready = useStoreReady();
  const review = useViewState((s) => s.review);
  const baseline = useViewState((s) => s.baseline);
  const conversationOpen = useViewState((s) => s.active !== null);
  const cardSelector = useMemo(() => cardOperationsSelector(), []);
  const cardOperations = useViewState(cardSelector);
  const collapsedStored = useUi((s) => s.expanded[COLLAPSED_KEY] === true);
  const dock = useRef<HTMLElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const regionId = useId();
  // The row or the whole card can go away after an action: keep focus in the page.
  useFocusRecovery(dock, { fallback: composerInput });

  const groups = useMemo(() => groupEntries(review.entries), [review.entries]);
  const outside = useMemo(
    () => elsewhere(review.entries, cardOperations),
    [review.entries, cardOperations],
  );
  const outsideGroups = useMemo(() => groupEntries(outside), [outside]);

  // A tick only means something while its file is pending and uncertain, wherever the file is
  // listed. Not before the host state has arrived: the entries are empty until then, and every
  // saved tick would be dropped.
  useEffect(() => {
    if (!ready) return;
    ui.pruneReviewInclude(groups.uncertain.map((entry) => entry.path));
  }, [ready, ui, groups]);

  const configCount = review.configChanges.length;
  const outsidePending = outsideGroups.agent.length + outsideGroups.uncertain.length;
  // While an Agent turn runs, file changes cannot be acted on. At the end of a turn the new entries
  // reach the view a moment before the turn's `changes` part: pending files shown while busy would
  // flash here and then move into the card.
  if (configCount === 0 && !(outsidePending > 0 && !review.busy)) return null;

  const degraded = baseline.state === 'degraded';
  // Only the files can be collapsed, whether or not a turn runs, so the header keeps its shape when
  // one starts. The snapshot progress comes and goes with every turn: it must not turn the header
  // into a button and back.
  const collapsible = outsidePending > 0;
  const collapsed = collapsible && collapsedStored;
  const bodyShown = configCount > 0 || !collapsed;

  const summary: string[] = [];
  if (configCount > 0) {
    summary.push(
      `${String(configCount)} configuration ${configCount === 1 ? 'change' : 'changes'}`,
    );
  }
  if (outsidePending > 0) {
    summary.push(review.busy ? 'file changes after the turn' : `${String(outsidePending)} pending`);
  }
  if (baseline.state === 'capturing') summary.push('preparing snapshot');
  if (degraded) summary.push('snapshot incomplete');
  const summaryView = summary.length > 0 && (
    <span className="changes-dock-summary muted">
      {(configCount > 0 || degraded) && <Icon name="warning" />}
      <span>{summary.join(' · ')}</span>
    </span>
  );

  return (
    <section ref={dock} className="changes-dock" aria-labelledby={titleId} tabIndex={-1}>
      <div className="column">
        <h2 className="changes-dock-heading">
          {collapsible ? (
            <button
              type="button"
              className="plan-section-toggle changes-dock-toggle"
              aria-expanded={!collapsed}
              aria-controls={regionId}
              onClick={() => {
                ui.setExpanded(COLLAPSED_KEY, !collapsed);
              }}
            >
              <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} />
              <span id={titleId}>Changes</span>
              {summaryView}
            </button>
          ) : (
            <span className="changes-dock-toggle changes-dock-toggle--plain">
              <span id={titleId}>Changes</span>
              {summaryView}
            </span>
          )}
        </h2>
      </div>
      <div
        id={bodyId}
        className="changes-dock-body"
        hidden={!bodyShown}
        {...(bodyShown ? { tabIndex: 0, role: 'group', 'aria-label': 'Changes details' } : {})}
      >
        <div className="column changes-dock-content">
          {configCount > 0 && <ConfigSection changes={review.configChanges} />}
          <div id={regionId} className="changes-dock-content" hidden={collapsed}>
            {!collapsed && (
              <>
                {outsidePending > 0 && review.busy && (
                  <p className="review-note muted">
                    File changes can be reviewed when the turn ends.
                  </p>
                )}
                {outsidePending > 0 && !review.busy && (
                  <ReviewFiles
                    entries={outside}
                    title={
                      conversationOpen
                        ? 'Pending changes outside this conversation'
                        : 'Pending changes'
                    }
                    wholeFolder={outside.length === review.entries.length}
                  />
                )}
                <SnapshotStatus />
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ConfigSection({ changes }: { changes: readonly ConfigChange[] }) {
  const post = usePost();
  const headingId = useId();
  const reasonId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h3 id={headingId} className="review-heading">
        Configuration changes
      </h3>
      <div className="notice notice--warning" role="note">
        <Icon name="warning" />
        <span>{CONFIG_WARNING}</span>
      </div>
      <ul className="review-list">
        {changes.map((change) => (
          <li key={change.id} className="review-entry review-entry--config">
            <div className="review-entry-head">
              <span className={`review-marker review-marker--${change.changeType}`}>
                <Icon name={TYPE_ICON[change.changeType]} />
                <span>{TYPE_LABEL[change.changeType]}</span>
              </span>
              <button
                type="button"
                className="review-path"
                aria-label={`Open diff of ${change.displayPath}`}
                title={`Open diff of ${change.displayPath}`}
                onClick={() => {
                  post({ type: 'config.openDiff', changeId: change.id });
                }}
              >
                {change.displayPath}
              </button>
            </div>
            <div className="review-entry-actions">
              <button
                type="button"
                className="button button--secondary"
                aria-label={`Keep ${change.displayPath}`}
                onClick={() => {
                  post({ type: 'config.keep', changeId: change.id });
                }}
              >
                Keep
              </button>
              <button
                type="button"
                className="button button--secondary"
                aria-label={`Revert ${change.displayPath}`}
                disabled={!change.revertible}
                aria-describedby={change.revertible ? undefined : `${reasonId}-${change.id}`}
                onClick={() => {
                  post({ type: 'config.revert', changeId: change.id });
                }}
              >
                Revert
              </button>
            </div>
            {!change.revertible && (
              <p id={`${reasonId}-${change.id}`} className="review-note muted">
                The earlier content was not kept
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The warning for a snapshot that could not cover everything: some changes cannot be restored. */
export function SnapshotWarning() {
  const note = useViewState((s) => s.baseline.note);
  return (
    <div className="notice notice--warning review-snapshot" role="note">
      <Icon name="warning" />
      <span>
        <VisuallyHidden>Warning: </VisuallyHidden>
        {note ?? 'The workspace snapshot is incomplete, so some changes cannot be restored.'}
      </span>
    </div>
  );
}

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
  if (baseline.state === 'degraded') return <SnapshotWarning />;
  return null;
}
