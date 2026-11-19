import { useId, useMemo, useRef } from 'react';
import { Icon } from '../../app/components';
import { useApp } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { useUi } from '../../app/ui-state';
import { FileLink } from '../chat/FileLink';
import type { PartRendererProps } from '../chat/registry';
import { SnapshotWarning, composerInput } from './ChangesDock';
import { ReviewFiles } from './ReviewFiles';
import { CHANGE_LABEL, cardRows, groupEntries } from './review-model';

/**
 * The files an Agent turn left pending, drawn where the turn ended. It is the record of the turn:
 * it always renders. The files it still acts on have Accept and Reject; the others are listed
 * under a collapsed line.
 */
export function TurnChangesCard({ part, messageId }: PartRendererProps<'changes'>) {
  const { ui } = useApp();
  const entries = useViewState((s) => s.review.entries);
  const busy = useViewState((s) => s.review.busy);
  const degraded = useViewState((s) => s.baseline.state === 'degraded');
  const recordKey = `review:record:${messageId}`;
  const recordOpen = useUi((s) => s.expanded[recordKey] === true);
  const root = useRef<HTMLElement>(null);
  const titleId = useId();
  const recordId = useId();
  const recordHeadingId = useId();
  // Accepting the last file or a turn starting removes the control that had focus: keep it in the page.
  useFocusRecovery(root, { fallback: composerInput });

  const { live, record, moreSettled } = useMemo(() => cardRows(part, entries), [part, entries]);
  const groups = useMemo(() => groupEntries(live), [live]);
  const pending = groups.agent.length + groups.uncertain.length;
  const accepted = groups.accepted.length;
  const summary =
    pending > 0
      ? `${String(pending)} pending`
      : accepted > 0
        ? `${String(accepted)} accepted`
        : 'No pending changes';
  const recordCount = record.length + moreSettled;

  return (
    <section ref={root} className="changes-card" aria-labelledby={titleId} tabIndex={-1}>
      <h3 className="changes-card-heading">
        <Icon name="diff" />
        <span id={titleId}>Changed files</span>
        <span className="changes-card-summary muted">{summary}</span>
      </h3>
      {busy && pending > 0 && (
        <p className="review-note muted">File changes can be reviewed when the turn ends.</p>
      )}
      {degraded && pending > 0 && <SnapshotWarning />}
      {live.length > 0 && (
        <div
          className="changes-card-body"
          role="group"
          aria-label="Changed files details"
          tabIndex={0}
        >
          <ReviewFiles entries={live} scopeKey={messageId} readOnly={busy} />
        </div>
      )}
      {recordCount > 0 && (
        <section className="review-section" aria-labelledby={recordHeadingId}>
          <h4 id={recordHeadingId} className="review-heading">
            <button
              type="button"
              className="plan-section-toggle"
              aria-expanded={recordOpen}
              aria-controls={recordId}
              onClick={() => {
                ui.setExpanded(recordKey, !recordOpen);
              }}
            >
              <Icon name={recordOpen ? 'chevron-down' : 'chevron-right'} />
              <span>
                {recordCount === 1
                  ? '1 file no longer pending'
                  : `${String(recordCount)} files no longer pending`}
              </span>
            </button>
          </h4>
          {/* A turn can list 200 files: the open list scrolls inside itself, like the files above. */}
          <div
            id={recordId}
            hidden={!recordOpen}
            {...(recordOpen
              ? {
                  className: 'changes-card-body',
                  role: 'group',
                  'aria-label': 'Files no longer pending',
                  tabIndex: 0,
                }
              : {})}
          >
            {recordOpen && (
              <>
                {record.length > 0 && (
                  <ul className="review-list">
                    {record.map((row) => {
                      const change = CHANGE_LABEL[row.changeType];
                      return (
                        <li key={row.path} className="review-entry review-entry--record">
                          <div className="review-entry-head">
                            <span className={`review-marker review-marker--${row.changeType}`}>
                              <Icon name={change.icon} />
                              <span>{change.label}</span>
                            </span>
                            {row.changeType === 'deleted' ? (
                              <span className="review-path-text">{row.path}</span>
                            ) : (
                              <FileLink target={{ path: row.path }} className="review-path" />
                            )}
                            {row.state === 'later' && (
                              <span className="review-meta muted">
                                Changed again in a later turn
                              </span>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {moreSettled > 0 && (
                  <p className="review-note muted">{`and ${String(moreSettled)} more`}</p>
                )}
              </>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
