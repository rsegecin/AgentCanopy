import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CheckpointSummary, RestoreItem, RestorePreview } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { isTurnRunning } from '../../app/turns';
import { useUi } from '../../app/ui-state';
import {
  ACTION_LABEL,
  KIND_LABEL,
  formatClock,
  formatFull,
  formatRelative,
  groupItems,
} from './checkpoint-model';

export const WAIT_HINT = 'Wait for the turn to finish.';

/** The Checkpoints tab: the history of file operations, or the preview of one restore. */
export function CheckpointsView({ now }: { now?: number }) {
  const preview = useViewState((s) => s.restorePreview);
  const checkpoints = useViewState((s) => s.checkpoints);
  const turns = useViewState((s) => s.active?.turns);
  const hintId = useId();
  const busy = isTurnRunning(turns);
  const scroller = useRef<HTMLDivElement>(null);
  // Opening or leaving a preview removes the button that had focus: land on the new heading.
  useFocusRecovery(scroller, { fallback: 'h2' });
  return (
    <div className="checkpoints">
      <div ref={scroller} className="checkpoints-scroll" tabIndex={-1}>
        <div className="column">
          {preview !== null ? (
            <PreviewPanel
              preview={preview}
              target={
                checkpoints.find((c) => c.operationId === preview.targetOperationId) ??
                preview.affectedOperations.find((c) => c.operationId === preview.targetOperationId)
              }
              busy={busy}
              hintId={hintId}
            />
          ) : (
            <HistoryPanel checkpoints={checkpoints} busy={busy} hintId={hintId} now={now} />
          )}
          {busy && (
            <p id={hintId} className="muted checkpoints-hint">
              {WAIT_HINT}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Time({ at, now }: { at: number; now: number }) {
  const full = formatFull(at);
  return (
    <time dateTime={new Date(at).toISOString()} title={full}>
      {formatRelative(at, now)}
      <VisuallyHidden>{`, ${full}`}</VisuallyHidden>
    </time>
  );
}

function HistoryPanel({
  checkpoints,
  busy,
  hintId,
  now,
}: {
  checkpoints: readonly CheckpointSummary[];
  busy: boolean;
  hintId: string;
  now: number | undefined;
}) {
  const post = usePost();
  const headingId = useId();
  const [mountedAt] = useState(() => Date.now());
  const clock = now ?? mountedAt;
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="checkpoints-heading" tabIndex={-1}>
        Checkpoint history
      </h2>
      <p className="checkpoints-intro">
        Restoring puts files back to what they were before the chosen step. Nothing changes until
        you confirm.
      </p>
      <ul className="checkpoint-list">
        {checkpoints.map((checkpoint) => {
          const kind = KIND_LABEL[checkpoint.kind];
          return (
            <li key={checkpoint.operationId} className="checkpoint-row">
              <div className="checkpoint-main">
                <span className="checkpoint-kind">{kind}</span>
                <Time at={checkpoint.at} now={clock} />
                {checkpoint.conversationTitle !== undefined && (
                  <span className="checkpoint-title">{checkpoint.conversationTitle}</span>
                )}
                <span className="muted">
                  {checkpoint.filesChanged} {checkpoint.filesChanged === 1 ? 'file' : 'files'}
                </span>
                {checkpoint.interrupted && (
                  <span className="badge badge--warning">
                    <Icon name="warning" />
                    <span>Interrupted</span>
                  </span>
                )}
              </div>
              <button
                type="button"
                className="button button--secondary"
                aria-label={`Preview restore to before ${kind}, ${formatClock(checkpoint.at)}`}
                disabled={busy}
                aria-describedby={busy ? hintId : undefined}
                onClick={() => {
                  post({ type: 'checkpoint.preview', operationId: checkpoint.operationId });
                }}
              >
                Preview Restore
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PreviewPanel({
  preview,
  target,
  busy,
  hintId,
}: {
  preview: RestorePreview;
  target: CheckpointSummary | undefined;
  busy: boolean;
  hintId: string;
}) {
  const { ui } = useApp();
  const post = usePost();
  const headingId = useId();
  const forkHintId = useId();
  const summaryId = useId();
  const override = useUi((s) => s.restoreSelection[preview.token]);

  const isSelected = (item: RestoreItem): boolean =>
    item.selectable && (override?.[item.path] ?? item.selectedByDefault);
  const groups = groupItems(preview.items);
  const selectable = [...groups.ready, ...groups.decision];
  const selectedItems = selectable.filter(isSelected);
  const selectedPaths = preview.items.filter(isSelected).map((i) => i.path);
  const risky = selectedItems.filter((i) => i.conflict !== undefined).length;
  const steps = preview.affectedOperations.length;

  const heading =
    target !== undefined
      ? `Restore to before ${KIND_LABEL[target.kind]} of ${formatFull(target.at)}`
      : 'Restore to before that step';

  const restore = (andFork: boolean) => {
    post({
      type: 'checkpoint.restore',
      token: preview.token,
      paths: selectedPaths,
      andFork,
    });
  };

  const cancel = () => {
    post({ type: 'checkpoint.cancelPreview' });
  };

  const renderItem = (item: RestoreItem) => {
    // Paths may contain spaces, which an id list cannot: number the items instead.
    const noteId = `${headingId}-note-${String(preview.items.indexOf(item))}`;
    const action = ACTION_LABEL[item.action];
    return (
      <li key={item.path} className="restore-item">
        <div className="restore-item-main">
          {item.selectable ? (
            <label className="restore-item-label">
              <input
                type="checkbox"
                checked={isSelected(item)}
                aria-label={`${action} ${item.path}`}
                aria-describedby={item.note ? noteId : undefined}
                onChange={(event) => {
                  ui.setRestoreSelection(preview.token, item.path, event.target.checked);
                }}
              />
              <span className="restore-action">{action}</span>
              <span className="review-path-text">{item.path}</span>
            </label>
          ) : (
            <span className="restore-item-label">
              <span className="restore-action">{action}</span>
              <span className="review-path-text">{item.path}</span>
            </span>
          )}
          <button
            type="button"
            className="button button--secondary"
            aria-label={`Diff ${item.path}`}
            onClick={() => {
              post({ type: 'checkpoint.openDiff', token: preview.token, path: item.path });
            }}
          >
            Diff
          </button>
        </div>
        {item.note !== undefined && item.note !== '' && (
          <p id={noteId} className="review-note muted">
            {item.note}
          </p>
        )}
      </li>
    );
  };

  const group = (title: string, items: RestoreItem[]) =>
    items.length > 0 && (
      <GroupSection title={title} count={items.length}>
        <ul className="restore-list">{items.map(renderItem)}</ul>
      </GroupSection>
    );

  return (
    <section aria-labelledby={headingId} className="restore-preview">
      <div className="restore-top">
        <button type="button" className="button button--secondary" onClick={cancel}>
          <Icon name="arrow-left" />
          <span>Back to history</span>
        </button>
      </div>
      <h2 id={headingId} className="checkpoints-heading" tabIndex={-1}>
        {heading}
      </h2>
      {steps > 0 && (
        <div className="restore-steps">
          <p>{steps === 1 ? 'This undoes 1 step:' : `This undoes ${String(steps)} steps:`}</p>
          <ul className="checkpoint-list">
            {preview.affectedOperations.map((op) => (
              <li key={op.operationId} className="checkpoint-row">
                <span className="checkpoint-kind">{KIND_LABEL[op.kind]}</span>
                <span>{formatFull(op.at)}</span>
                {op.conversationTitle !== undefined && (
                  <span className="checkpoint-title">{op.conversationTitle}</span>
                )}
                <span className="muted">
                  {op.filesChanged} {op.filesChanged === 1 ? 'file' : 'files'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview.items.length === 0 ? (
        <p className="restore-empty">The files are already as they were before that step.</p>
      ) : (
        <>
          {group('Will be restored', groups.ready)}
          {group('Needs your decision', groups.decision)}
          {group('Cannot be restored', groups.blocked)}

          <p id={summaryId} className="restore-summary">
            {selectedItems.length} of {selectable.length}{' '}
            {selectable.length === 1 ? 'file' : 'files'} selected
          </p>
          {risky > 0 && (
            <p className="restore-warning" role="status">
              <Icon name="warning" />
              <span>
                {risky === 1
                  ? '1 selected file contains changes that were not the agent’s. Restoring discards them.'
                  : `${String(risky)} selected files contain changes that were not the agent’s. Restoring discards them.`}
              </span>
            </p>
          )}

          <div className="restore-actions">
            <button
              type="button"
              className="button"
              disabled={busy || selectedPaths.length === 0}
              aria-describedby={busy ? hintId : selectedPaths.length === 0 ? summaryId : undefined}
              onClick={() => {
                restore(false);
              }}
            >
              Restore Selected Files
            </button>
            {target?.conversationId !== undefined && (
              <button
                type="button"
                className="button button--secondary"
                disabled={busy || selectedPaths.length === 0}
                aria-describedby={
                  busy
                    ? `${hintId} ${forkHintId}`
                    : selectedPaths.length === 0
                      ? `${summaryId} ${forkHintId}`
                      : forkHintId
                }
                onClick={() => {
                  restore(true);
                }}
              >
                Restore and Branch From Here
              </button>
            )}
            <button type="button" className="button button--secondary" onClick={cancel}>
              Cancel
            </button>
          </div>
          {target?.conversationId !== undefined && (
            <p id={forkHintId} className="review-note muted">
              Also starts a branch of that conversation from just before that turn
            </p>
          )}
        </>
      )}
      {preview.items.length === 0 && (
        <div className="restore-actions">
          <button type="button" className="button button--secondary" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
    </section>
  );
}

function GroupSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="restore-group" aria-labelledby={id}>
      <h3 id={id} className="review-heading">
        {title} <span className="review-count muted">{count}</span>
      </h3>
      {children}
    </section>
  );
}
