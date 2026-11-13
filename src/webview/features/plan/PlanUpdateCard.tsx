import { Icon } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useViewState } from '../../app/store';
import type { PartRendererProps } from '../chat/registry';
import { latestVersion } from './plan-model';

/** The chat card for a new plan version: what changed, and the ways to look at it or undo it. */
export function PlanUpdateCard({ part }: PartRendererProps<'plan-update'>) {
  const { ui } = useApp();
  const post = usePost();
  const plan = useViewState((s) => {
    const p = s.active?.plan ?? null;
    return p !== null && p.id === part.planId ? p : null;
  });
  const n = part.version;
  const summary = plan?.versions.find((v) => v.version === n)?.content.changeSummary.trim() ?? '';
  const isLatest = plan !== null && latestVersion(plan)?.version === n;

  return (
    <div className="plan-update" role="group" aria-label={`Plan update: version ${String(n)}`}>
      <div className="part-line">
        <Icon name="checklist" />
        <span>Plan updated to version {n}</span>
      </div>
      {summary !== '' && <p className="plan-update-summary">{summary}</p>}
      {plan !== null && (
        <div className="plan-update-actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              ui.setTab('plan');
            }}
          >
            Open plan
          </button>
          {n > 1 && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                post({ type: 'plan.compare', planId: plan.id, left: n - 1, right: n });
              }}
            >
              View changes
            </button>
          )}
          {n > 1 && isLatest && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                post({ type: 'plan.revert', planId: plan.id, version: n - 1 });
              }}
            >
              Revert to version {n - 1}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
