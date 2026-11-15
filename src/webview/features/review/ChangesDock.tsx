import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConfigChange, ReviewEntry } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useStoreReady, useViewState } from '../../app/store';
import { useUi } from '../../app/ui-state';
import { ReviewEntryRow } from './ReviewEntryRow';
import { countFiles, groupEntries } from './review-model';

/** Progress is announced at most this often, not on every file. */
export const SNAPSHOT_ANNOUNCE_MS = 5000;

export const CONFIG_WARNING =
  'The last turn changed tool or editor configuration. Such files can make later commands run without asking. Keep or revert each one before the next Agent turn.';

/** The `ui.expanded` map stores only `true`, so the dock is open unless this key is set. */
const COLLAPSED_KEY = 'changes-dock-collapsed';
const ACCEPTED_KEY = 'review:accepted';

const TYPE_LABEL = { created: 'Created', modified: 'Modified', deleted: 'Deleted' } as const;
const TYPE_ICON = {
  created: 'diff-added',
  modified: 'diff-modified',
  deleted: 'diff-removed',
} as const;

/** Where focus goes when the card loses it: the textarea, or the composer form while it is disabled. */
function composerInput(): HTMLElement | null {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (textarea && !textarea.disabled) return textarea;
  return document.querySelector<HTMLElement>('form.composer');
}

function Group({
  title,
  count,
  level,
  children,
}: {
  title: string;
  count: number;
  level: 3 | 4;
  children: ReactNode;
}) {
  const headingId = useId();
  const Heading = level === 3 ? 'h3' : 'h4';
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <Heading id={headingId} className="review-heading">
        {title} <span className="review-count muted">{count}</span>
      </Heading>
      {children}
    </section>
  );
}

/**
 * The card between the chat log and the composer: configuration changes the user must decide on,
 * and the files an Agent turn changed. It renders nothing when there is nothing to decide or review.
 * The configuration section is always shown; the header collapses what is below it.
 */
export function ChangesDock() {
  const { ui } = useApp();
  const ready = useStoreReady();
  const review = useViewState((s) => s.review);
  const baseline = useViewState((s) => s.baseline);
  const collapsedStored = useUi((s) => s.expanded[COLLAPSED_KEY] === true);
  const dock = useRef<HTMLElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const regionId = useId();
  // The row or the whole card can go away after an action: keep focus in the page.
  useFocusRecovery(dock, { fallback: composerInput });

  const groups = useMemo(() => groupEntries(review.entries), [review.entries]);

  // A tick only means something while its file is pending and uncertain. Not before the host state
  // has arrived: the entries are empty until then, and every saved tick would be dropped.
  useEffect(() => {
    if (!ready) return;
    ui.pruneReviewInclude(groups.uncertain.map((entry) => entry.path));
  }, [ready, ui, groups]);

  const configCount = review.configChanges.length;
  const hasEntries = review.entries.length > 0;
  if (configCount === 0 && !hasEntries) return null;

  const degraded = baseline.state === 'degraded';
  // Only the files can be collapsed. The snapshot progress comes and goes with every turn: it must
  // not turn the header into a button and back.
  const collapsible = hasEntries;
  const collapsed = collapsible && collapsedStored;
  const bodyShown = configCount > 0 || !collapsed;

  const pending = groups.agent.length + groups.uncertain.length;
  const summary: string[] = [];
  if (configCount > 0) {
    summary.push(
      `${String(configCount)} configuration ${configCount === 1 ? 'change' : 'changes'}`,
    );
  }
  if (hasEntries && review.busy) {
    summary.push('file changes after the turn');
  } else if (pending > 0) {
    summary.push(`${String(pending)} pending`);
  } else if (groups.accepted.length > 0) {
    summary.push(`${String(groups.accepted.length)} accepted`);
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
                {hasEntries && review.busy && (
                  <p className="review-note muted">
                    File changes can be reviewed when the turn ends.
                  </p>
                )}
                {hasEntries && !review.busy && <FilesSection groups={groups} />}
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

function FilesSection({ groups }: { groups: ReturnType<typeof groupEntries> }) {
  const { ui } = useApp();
  const post = usePost();
  const include = useUi((s) => s.reviewInclude);
  const acceptedOpen = useUi((s) => s.expanded[ACCEPTED_KEY] === true);
  const headingId = useId();
  const acceptedId = useId();
  const acceptedHeadingId = useId();

  const pending: ReviewEntry[] = [...groups.agent, ...groups.uncertain];
  const files = countFiles(pending);
  const includePaths = groups.uncertain.filter((e) => include[e.path] === true).map((e) => e.path);
  const acceptedCount = groups.accepted.length;

  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h3 id={headingId} className="review-heading">
        Files
      </h3>

      {pending.length > 0 && (
        <div className="review-toolbar" role="group" aria-label="Review actions">
          <p className="review-summary" tabIndex={-1}>
            {pending.length} pending {pending.length === 1 ? 'change' : 'changes'} in {files}{' '}
            {files === 1 ? 'file' : 'files'}
          </p>
          <div className="review-toolbar-buttons">
            <button
              type="button"
              className="button"
              onClick={() => {
                post({ type: 'review.acceptAll' });
              }}
            >
              Accept All
            </button>
            <button
              type="button"
              className="button button--secondary"
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
        </div>
      )}

      {groups.agent.length > 0 && (
        <Group title="Agent changes" count={groups.agent.length} level={4}>
          <ul className="review-list">
            {groups.agent.map((entry) => (
              <ReviewEntryRow key={entry.path} entry={entry} uncertain={false} />
            ))}
          </ul>
        </Group>
      )}

      {groups.uncertain.length > 0 && (
        <Group
          title="Changed during a turn, source uncertain"
          count={groups.uncertain.length}
          level={4}
        >
          <p className="review-note muted">
            Reject All leaves these files alone unless you tick them.
          </p>
          <ul className="review-list">
            {groups.uncertain.map((entry) => (
              <ReviewEntryRow key={entry.path} entry={entry} uncertain />
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
                ui.setExpanded(ACCEPTED_KEY, !acceptedOpen);
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
