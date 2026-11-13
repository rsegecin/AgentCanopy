import { useId } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../../app/components';
import { useApp } from '../../app/context';
import { useUi } from '../../app/ui-state';

/** A collapsible region of the plan view with its own `h2`. Open by default; the choice is remembered per plan. */
export function PlanSection({
  planId,
  section,
  title,
  children,
}: {
  planId: string;
  section: string;
  title: string;
  children: ReactNode;
}) {
  const { ui } = useApp();
  const open = useUi((s) => s.planClosed[planId]?.[section] !== true);
  const headingId = useId();
  const bodyId = useId();
  return (
    <section className="plan-section" aria-labelledby={headingId}>
      <h2 id={headingId} className="plan-section-heading">
        <button
          type="button"
          className="plan-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            ui.setPlanSectionOpen(planId, section, !open);
          }}
        >
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <span>{title}</span>
        </button>
      </h2>
      <div id={bodyId} className="plan-section-body" hidden={!open}>
        {open && children}
      </div>
    </section>
  );
}
