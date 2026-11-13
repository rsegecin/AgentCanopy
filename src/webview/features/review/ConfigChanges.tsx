import { useId } from 'react';
import type { ConfigChange } from '../../../shared';
import { Icon } from '../../app/components';
import { usePost } from '../../app/context';

const TYPE_LABEL = { created: 'Created', modified: 'Modified', deleted: 'Deleted' } as const;

export const CONFIG_WARNING =
  'The last turn changed tool or editor configuration. Such files can make later commands run without asking. Decide for each before the next Agent turn.';

/** Configuration files a turn changed. Each must be kept or reverted before the next Agent turn. */
export function ConfigChanges({ changes }: { changes: readonly ConfigChange[] }) {
  const post = usePost();
  const headingId = useId();
  const reasonId = useId();
  return (
    <section className="review-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="review-heading">
        Configuration changes
      </h2>
      <div className="notice notice--warning" role="note">
        <Icon name="warning" />
        <span>{CONFIG_WARNING}</span>
      </div>
      <ul className="review-list">
        {changes.map((change) => (
          <li key={change.id} className="review-entry">
            <div className="review-entry-head">
              <span className={`review-marker review-marker--${change.changeType}`}>
                <Icon
                  name={
                    change.changeType === 'created'
                      ? 'diff-added'
                      : change.changeType === 'deleted'
                        ? 'diff-removed'
                        : 'diff-modified'
                  }
                />
                <span>{TYPE_LABEL[change.changeType]}</span>
              </span>
              <span className="review-path-text">{change.displayPath}</span>
            </div>
            <div className="review-entry-actions">
              <button
                type="button"
                className="button button--secondary"
                aria-label={`Show Changes to ${change.displayPath}`}
                onClick={() => {
                  post({ type: 'config.openDiff', changeId: change.id });
                }}
              >
                Show Changes
              </button>
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
