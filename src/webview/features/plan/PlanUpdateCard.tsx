import { useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { PlanDoc, PlanId, PlanVersion, ViewState } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { isTurnRunning } from '../../app/turns';
import type { PartRendererProps } from '../chat/registry';
import { DecisionList, DecisionPointCard, OpenQuestionCard } from './PlanDecisions';
import {
  countUnanswered,
  currentDecision,
  formatTime,
  latestVersion,
  summarizeDecisions,
} from './plan-model';

/** The title button of a card: where focus goes when the control that had it is gone. */
const TITLE_BUTTON = '.plan-card-open';
const RUNNING_HINT = 'Wait for the current turn to finish.';
const FOLDER_HINT = 'Another agent turn is running in this folder.';
const CONFIG_HINT = 'Keep or revert the configuration changes below the chat first.';

/**
 * The highest version among the `plan-update` parts of the open conversation for this plan, or 0
 * when there is none. A number, so a card re-renders only when the answer changes, not with every
 * streamed token.
 */
function highestPartVersion(state: ViewState, planId: PlanId): number {
  let highest = 0;
  for (const message of state.active?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.kind === 'plan-update' && part.planId === planId && part.version > highest) {
        highest = part.version;
      }
    }
  }
  return highest;
}

/** The plan of the open conversation when it is this one. */
function planOf(state: ViewState, planId: PlanId): PlanDoc | null {
  const plan = state.active?.plan ?? null;
  return plan !== null && plan.id === planId ? plan : null;
}

/** The one-line stand-in, for a card whose plan is not in the state. */
function PlanLine({ version }: { version: number }) {
  return (
    <div className="part-line">
      <Icon name="checklist" />
      <span>Plan updated to version {version}</span>
    </div>
  );
}

/**
 * The chat card for a plan version. The current card (the part with the highest version for the
 * plan) is the working one; every other part is an older, read-only card.
 *
 * One wrapper stays mounted while the card inside it changes kind (current, older, one-line stand-in),
 * so focus recovery lives here: when a newer part arrives or a button goes away, focus moves to the
 * title button of the card that is shown instead of falling to the page.
 */
export function PlanUpdateCard({ part }: PartRendererProps<'plan-update'>) {
  const plan = useViewState((s) => planOf(s, part.planId));
  const highest = useViewState((s) => highestPartVersion(s, part.planId));
  const slot = useRef<HTMLDivElement>(null);
  useFocusRecovery(slot, { fallback: TITLE_BUTTON });
  const latest = plan !== null ? latestVersion(plan) : undefined;
  const shown = plan?.versions.find((v) => v.version === part.version);
  let card: ReactNode;
  if (plan === null || latest === undefined) card = <PlanLine version={part.version} />;
  else if (part.version >= highest) card = <CurrentPlanCard plan={plan} latest={latest} />;
  else if (shown === undefined) card = <PlanLine version={part.version} />;
  else card = <OlderPlanCard plan={plan} shown={shown} latest={latest} />;
  return (
    <div ref={slot} className="plan-card-slot" tabIndex={-1}>
      {card}
    </div>
  );
}

/**
 * The current card for a plan that no message mentions: it ends the log. When a real part for the
 * plan arrives this component renders nothing, and focus that was inside moves to the real card.
 */
export function SyntheticPlanCard() {
  const plan = useViewState((s) => {
    const p = s.active?.plan ?? null;
    return p !== null && highestPartVersion(s, p.id) === 0 ? p : null;
  });
  const root = useRef<HTMLElement>(null);
  useFocusRecovery(root, {
    fallback: () => document.querySelector<HTMLElement>(`.plan-card--current ${TITLE_BUTTON}`),
  });
  const latest = plan !== null ? latestVersion(plan) : undefined;
  if (plan === null || latest === undefined) return null;
  return <CurrentPlanCard plan={plan} latest={latest} rootRef={root} />;
}

function CurrentPlanCard({
  plan,
  latest,
  rootRef,
}: {
  plan: PlanDoc;
  latest: PlanVersion;
  /** The synthetic card keeps its own recovery hook and needs the card element. */
  rootRef?: RefObject<HTMLElement | null>;
}) {
  const post = usePost();
  const ownRoot = useRef<HTMLElement>(null);
  const root = rootRef ?? ownRoot;
  // Answering a question or approving replaces or disables controls without the wrapper above
  // re-rendering (the running state and the pending configuration changes are read here).
  // When both hooks run in one commit this one moves focus first and the other finds it settled.
  useFocusRecovery(root, { fallback: TITLE_BUTTON });
  const running = useViewState((s) => isTurnRunning(s.active?.turns));
  const configPending = useViewState((s) => s.review.configChanges.length > 0);
  // An Agent turn of another conversation holds the folder (while this one runs, the running hint says it).
  const folderBusy = useViewState((s) => s.review.busy && !isTurnRunning(s.active?.turns));
  // Auto offered: the hint says whether the execution runs with it (it is on) or whether approving
  // turns it on (it is off, and the approval dialog says so in full).
  const autoOffered = useViewState((s) => s.agentAuto.offered);
  const autoOn = useViewState((s) => s.agentAuto.offered && s.active?.meta.agentAuto === true);
  const autoCommands = useViewState((s) => s.agentAuto.commands);
  const titleId = useId();
  const decisionsId = useId();
  const stillId = useId();
  const warningId = useId();
  const runningId = useId();
  const configId = useId();
  const folderId = useId();

  const { content } = latest;
  const unanswered = countUnanswered(content, plan.decisions);
  const summary = summarizeDecisions(content, plan.decisions);
  const approvals = plan.approvals.filter((a) => a.version === latest.version);
  const summaryText = content.changeSummary.trim();
  const hasChoices = content.decisionPoints.length > 0 || content.openQuestions.length > 0;
  const previous = latest.version - 1;
  const blocked = running || configPending || folderBusy;
  const describedBy =
    [
      running ? runningId : null,
      folderBusy ? folderId : null,
      configPending ? configId : null,
      unanswered > 0 ? warningId : null,
    ]
      .filter((id) => id !== null)
      .join(' ') || undefined;

  return (
    <section
      ref={root}
      className="plan-card plan-card--current"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <h2 className="plan-card-title">
        <Icon name="checklist" />
        <button
          type="button"
          className="plan-card-open"
          title={`Open version ${String(latest.version)} as a read-only document`}
          onClick={() => {
            post({ type: 'plan.open', planId: plan.id, version: latest.version });
          }}
        >
          <span id={titleId}>{content.title}</span>
          <VisuallyHidden>{`, open version ${String(latest.version)}`}</VisuallyHidden>
        </button>
      </h2>
      <p className="plan-card-version muted">
        {`Version ${String(latest.version)}`}
        {latest.restoredFrom !== undefined &&
          `, restored by you from version ${String(latest.restoredFrom)}`}
      </p>
      {summaryText !== '' && <p className="plan-update-summary">{summaryText}</p>}

      {summary.length > 0 && (
        <div role="group" aria-labelledby={decisionsId} className="plan-card-section">
          <h3 id={decisionsId} className="plan-card-heading">
            Your decisions
          </h3>
          <DecisionList items={summary} />
        </div>
      )}

      {hasChoices && (
        <div role="group" aria-labelledby={stillId} className="plan-card-section">
          <h3 id={stillId} className="plan-card-heading">
            {unanswered > 0 ? `Still to decide (${String(unanswered)})` : 'Decision points'}
          </h3>
          {content.decisionPoints.map((point) => (
            <DecisionPointCard
              key={point.id}
              planId={plan.id}
              point={point}
              recorded={currentDecision(plan.decisions, 'decision-point', point.id)}
              readOnly={false}
            />
          ))}
          {content.openQuestions.map((question) => (
            <OpenQuestionCard
              key={question.id}
              planId={plan.id}
              question={question}
              recorded={currentDecision(plan.decisions, 'open-question', question.id)}
              readOnly={false}
            />
          ))}
        </div>
      )}

      <div className="plan-approve">
        <button
          type="button"
          className="button"
          disabled={blocked}
          aria-describedby={describedBy}
          onClick={() => {
            post({
              type: 'plan.approve',
              planId: plan.id,
              version: latest.version,
              contentHash: latest.contentHash,
            });
          }}
        >
          Approve and Execute
        </button>
        {unanswered > 0 && (
          <p id={warningId} className="plan-warning">
            <Icon name="warning" />
            <span>
              {unanswered === 1
                ? '1 question or decision has no answer yet'
                : `${String(unanswered)} questions or decisions have no answer yet`}
            </span>
          </p>
        )}
      </div>
      {autoOffered && (
        <p className="plan-hint muted plan-auto">
          <Icon name={autoOn ? 'pass-filled' : 'circle-large-outline'} />
          <span>
            {autoOn
              ? autoCommands
                ? 'Runs with Auto: commands and edits run without asking.'
                : 'Runs with Auto: edits run without asking. Commands still ask.'
              : autoCommands
                ? 'Approving turns on Auto for this conversation: commands and edits run without asking.'
                : 'Approving turns on Auto for this conversation: edits run without asking. Commands still ask.'}
          </span>
        </p>
      )}
      {running && (
        <p id={runningId} className="plan-hint muted">
          {RUNNING_HINT}
        </p>
      )}
      {folderBusy && (
        <p id={folderId} className="plan-hint muted">
          {FOLDER_HINT}
        </p>
      )}
      {configPending && (
        <p id={configId} className="plan-hint muted">
          {CONFIG_HINT}
        </p>
      )}

      {latest.version > 1 && (
        <div className="plan-card-actions">
          <CompareButton planId={plan.id} left={previous} right={latest.version} />
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              post({ type: 'plan.revert', planId: plan.id, version: previous });
            }}
          >
            {`Revert to version ${String(previous)}`}
          </button>
        </div>
      )}

      {approvals.length > 0 && (
        <ul className="plan-approvals">
          {approvals.map((a, i) => (
            <li key={i}>Approved on {formatTime(a.approvedAt)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CompareButton({ planId, left, right }: { planId: PlanId; left: number; right: number }) {
  const post = usePost();
  return (
    <button
      type="button"
      className="button button--secondary"
      onClick={() => {
        post({ type: 'plan.compare', planId, left, right });
      }}
    >
      View changes{' '}
      <VisuallyHidden>{`between version ${String(left)} and ${String(right)}`}</VisuallyHidden>
    </button>
  );
}

function OlderPlanCard({
  plan,
  shown,
  latest,
}: {
  plan: PlanDoc;
  shown: PlanVersion;
  latest: PlanVersion;
}) {
  const post = usePost();
  const n = shown.version;
  const label = `Plan version ${String(n)}`;
  return (
    <div className="plan-card plan-card--older" role="group" aria-label={label}>
      <div className="plan-card-line">
        <Icon name="checklist" />
        <span className="muted">{label}</span>
        <button
          type="button"
          className="plan-card-open"
          title={`Open version ${String(n)} as a read-only document`}
          onClick={() => {
            post({ type: 'plan.open', planId: plan.id, version: n });
          }}
        >
          {shown.content.title}
          <VisuallyHidden>{`, open version ${String(n)}`}</VisuallyHidden>
        </button>
      </div>
      {(n > 1 || shown.contentHash !== latest.contentHash) && (
        <div className="plan-card-actions">
          {n > 1 && <CompareButton planId={plan.id} left={n - 1} right={n} />}
          {shown.contentHash !== latest.contentHash && (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                post({ type: 'plan.revert', planId: plan.id, version: n });
              }}
            >
              Restore this version <VisuallyHidden>{`(version ${String(n)})`}</VisuallyHidden>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
