import { useId, useRef, useState } from 'react';
import type { PlanDoc, PlanVersion } from '../../../shared';
import { Icon } from '../../app/components';
import { usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { isTurnRunning } from '../../app/turns';
import { FileLink } from '../chat/FileLink';
import { Markdown } from '../chat/Markdown';
import { Diagram } from '../diagram/Diagram';
import { DecisionPointCard, OpenQuestionCard } from './PlanDecisions';
import { LOCK_HINT } from './lock-hint';
import { PlanSection } from './PlanSection';
import {
  countUnanswered,
  currentDecision,
  formatTime,
  hasStageDependencies,
  latestVersion,
  stageDiagramSource,
  summarizeDecisions,
} from './plan-model';

function versionLabel(version: PlanVersion): string {
  const author = version.author === 'agent' ? 'Agent' : 'You';
  const restored =
    version.restoredFrom !== undefined ? `, restored from ${String(version.restoredFrom)}` : '';
  return `Version ${String(version.version)} (${author}${restored}, ${formatTime(version.createdAt)})`;
}

const ACTION_LABEL = {
  create: 'Create',
  modify: 'Modify',
  delete: 'Delete',
  read: 'Read',
} as const;

/** The Plan tab: the plan of the open conversation, or a note that there is none. */
export function PlanView() {
  const plan = useViewState((s) => s.active?.plan ?? null);
  const meta = useViewState((s) => s.active?.meta);
  const turns = useViewState((s) => s.active?.turns);
  if (plan === null || meta === undefined || latestVersion(plan) === undefined) {
    return (
      <div className="empty-state">
        <Icon name="checklist" />
        <p>This conversation has no plan yet. Switch to Plan mode and ask for one.</p>
      </div>
    );
  }
  return (
    <PlanDocView
      key={plan.id}
      plan={plan}
      locked={meta.planLocked}
      running={isTurnRunning(turns)}
    />
  );
}

function PlanDocView({
  plan,
  locked,
  running,
}: {
  plan: PlanDoc;
  locked: boolean;
  running: boolean;
}) {
  const post = usePost();
  const [selected, setSelected] = useState<number | null>(null);
  const [compareKey, setCompareKey] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  // Answering a question or reverting replaces controls: keep focus in the view.
  useFocusRecovery(scroller, { fallback: 'h1' });
  const stageListId = useId();
  const warningId = useId();
  const runningId = useId();

  const latest = latestVersion(plan) as PlanVersion;
  const shown = plan.versions.find((v) => v.version === selected) ?? latest;
  const isLatest = shown.version === latest.version;
  const content = shown.content;
  const versions = [...plan.versions].sort((a, b) => b.version - a.version);
  const others = versions.filter((v) => v.version !== shown.version);
  const readOnly = !isLatest;
  const stageTitles = new Map(content.stages.map((s) => [s.id, s.title] as const));
  const unanswered = countUnanswered(content, plan.decisions);
  const approvals = plan.approvals.filter((a) => a.version === shown.version);
  // Decisions are summarised with the wording of the newest version.
  const summary = summarizeDecisions(latest.content, plan.decisions);
  const current = summary.filter((d) => !d.orphan);
  const orphans = summary.filter((d) => d.orphan);
  const inPanel = document.body.dataset.viewKind === 'panel';
  const section = (id: string) => ({ planId: plan.id, section: id });

  return (
    <div className="plan-view">
      <div ref={scroller} className="plan-scroll" tabIndex={-1}>
        <div className="column">
          <header className="plan-header">
            <h1 className="plan-title" tabIndex={-1}>
              {content.title}
            </h1>
            <div className="plan-toolbar">
              <label className="plan-field">
                <span>Version</span>
                <select
                  value={shown.version}
                  onChange={(event) => {
                    setSelected(Number(event.target.value));
                  }}
                >
                  {versions.map((v) => (
                    <option key={v.version} value={v.version}>
                      {versionLabel(v)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={`button button--secondary plan-lock${locked ? ' plan-lock--on' : ''}`}
                aria-pressed={locked}
                title={LOCK_HINT}
                onClick={() => {
                  post({
                    type: 'plan.setLocked',
                    conversationId: plan.conversationId,
                    locked: !locked,
                  });
                }}
              >
                <Icon name={locked ? 'lock' : 'unlock'} />
                <span>Locked</span>
              </button>
            </div>
            <p className="plan-hint muted">{LOCK_HINT}</p>
            <div className="plan-actions">
              {others.length > 0 && (
                <label className="plan-field">
                  <span className="visually-hidden">Compare with…</span>
                  <select
                    key={compareKey}
                    defaultValue=""
                    aria-label="Compare with…"
                    onChange={(event) => {
                      const left = Number(event.target.value);
                      if (!Number.isInteger(left) || left <= 0) return;
                      post({
                        type: 'plan.compare',
                        planId: plan.id,
                        left,
                        right: shown.version,
                      });
                      setCompareKey((k) => k + 1);
                    }}
                  >
                    <option value="" disabled>
                      Compare with…
                    </option>
                    {others.map((v) => (
                      <option key={v.version} value={v.version}>
                        Version {v.version}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {readOnly && (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => {
                    post({ type: 'plan.revert', planId: plan.id, version: shown.version });
                  }}
                >
                  Revert to this version
                </button>
              )}
              <button
                type="button"
                className="button button--secondary"
                onClick={() => {
                  post({ type: 'plan.export', planId: plan.id, version: shown.version });
                }}
              >
                Export
              </button>
              {!inPanel && (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => {
                    post({ type: 'plan.openInEditor', planId: plan.id });
                  }}
                >
                  Open in editor
                </button>
              )}
            </div>
            {readOnly && (
              <div className="notice notice--info" role="note">
                <Icon name="info" />
                <span>
                  You are viewing version {shown.version}. The latest is version {latest.version}.
                </span>
              </div>
            )}
          </header>

          <PlanSection {...section('objective')} title="Objective">
            <Markdown text={content.objective} />
          </PlanSection>

          {content.requirements.length > 0 && (
            <PlanSection {...section('requirements')} title="Requirements">
              <ul className="plan-list">
                {content.requirements.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </PlanSection>
          )}

          {content.analysis.trim() !== '' && (
            <PlanSection {...section('analysis')} title="Analysis">
              <Markdown text={content.analysis} />
            </PlanSection>
          )}

          {content.architecture.trim() !== '' && (
            <PlanSection {...section('architecture')} title="Architecture">
              <Markdown text={content.architecture} />
            </PlanSection>
          )}

          {content.relevantFiles.length > 0 && (
            <PlanSection {...section('files')} title="Relevant files">
              <div
                className="plan-table-wrap"
                role="region"
                aria-label="Relevant files table"
                tabIndex={0}
              >
                <table className="plan-table">
                  <thead>
                    <tr>
                      <th scope="col">Path</th>
                      <th scope="col">Action</th>
                      <th scope="col">Role</th>
                    </tr>
                  </thead>
                  <tbody>
                    {content.relevantFiles.map((file, i) => (
                      <tr key={i}>
                        <td>
                          <FileLink target={{ path: file.path }} />
                        </td>
                        <td>{ACTION_LABEL[file.action]}</td>
                        <td>{file.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </PlanSection>
          )}

          <PlanSection {...section('stages')} title="Stages">
            {hasStageDependencies(content.stages) && (
              <Diagram
                source={stageDiagramSource(content.stages)}
                title="Stage dependencies"
                describedBy={stageListId}
              />
            )}
            <ol id={stageListId} className="plan-stages">
              {content.stages.map((stage) => (
                <li key={stage.id} className="plan-stage">
                  <h3 className="plan-stage-title">{stage.title}</h3>
                  {stage.description.trim() !== '' && <Markdown text={stage.description} />}
                  {stage.dependsOn.length > 0 && (
                    <div className="plan-stage-meta">
                      <span className="plan-label">Depends on</span>
                      <ul className="chips" aria-label={`Stages that ${stage.title} depends on`}>
                        {stage.dependsOn.map((id) => (
                          <li key={id} className="chip">
                            <span className="chip-text">{stageTitles.get(id) ?? id}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {stage.files.length > 0 && (
                    <div className="plan-stage-meta">
                      <span className="plan-label">Files</span>
                      <ul className="plan-list plan-list--plain">
                        {stage.files.map((file, i) => (
                          <li key={i}>
                            <FileLink target={{ path: file }} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {stage.acceptance.length > 0 && (
                    <div className="plan-stage-meta">
                      <span className="plan-label">Acceptance</span>
                      <ul className="plan-list">
                        {stage.acceptance.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </PlanSection>

          {content.dependencies.length > 0 && (
            <PlanSection {...section('dependencies')} title="Dependencies">
              <ul className="plan-list">
                {content.dependencies.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </PlanSection>
          )}

          {content.diagrams.length > 0 && (
            <PlanSection {...section('diagrams')} title="Diagrams">
              {content.diagrams.map((diagram) => (
                <div key={diagram.id} className="plan-diagram">
                  <h3 className="plan-subtitle">{diagram.title}</h3>
                  <Diagram source={diagram.mermaid} title={diagram.title} />
                </div>
              ))}
            </PlanSection>
          )}

          {content.alternatives.length > 0 && (
            <PlanSection {...section('alternatives')} title="Alternatives considered">
              {content.alternatives.map((alt) => (
                <div key={alt.id} className="plan-alternative">
                  <h3 className="plan-subtitle">
                    {alt.title}
                    {alt.chosen && (
                      <span className="plan-tag plan-tag--chosen">Followed by the plan</span>
                    )}
                  </h3>
                  {alt.summary.trim() !== '' && <Markdown text={alt.summary} />}
                  {alt.pros.length > 0 && (
                    <div className="plan-stage-meta">
                      <span className="plan-label">Pros</span>
                      <ul className="plan-list">
                        {alt.pros.map((p, i) => (
                          <li key={i}>{p}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {alt.cons.length > 0 && (
                    <div className="plan-stage-meta">
                      <span className="plan-label">Cons</span>
                      <ul className="plan-list">
                        {alt.cons.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </PlanSection>
          )}

          {content.decisionPoints.length > 0 && (
            <PlanSection {...section('decisions')} title="Decisions to make">
              {content.decisionPoints.map((point) => (
                <DecisionPointCard
                  key={point.id}
                  planId={plan.id}
                  point={point}
                  recorded={currentDecision(plan.decisions, 'decision-point', point.id)}
                  readOnly={readOnly}
                />
              ))}
            </PlanSection>
          )}

          {content.openQuestions.length > 0 && (
            <PlanSection {...section('questions')} title="Open questions">
              {content.openQuestions.map((question) => (
                <OpenQuestionCard
                  key={question.id}
                  planId={plan.id}
                  question={question}
                  recorded={currentDecision(plan.decisions, 'open-question', question.id)}
                  readOnly={readOnly}
                />
              ))}
            </PlanSection>
          )}

          {content.testingStrategy.trim() !== '' && (
            <PlanSection {...section('testing')} title="Testing strategy">
              <Markdown text={content.testingStrategy} />
            </PlanSection>
          )}

          {content.acceptanceCriteria.length > 0 && (
            <PlanSection {...section('acceptance')} title="Acceptance criteria">
              <ul className="plan-list">
                {content.acceptanceCriteria.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </PlanSection>
          )}

          {summary.length > 0 && (
            <PlanSection {...section('your-decisions')} title="Your decisions">
              {current.length > 0 && <DecisionList items={current} />}
              {orphans.length > 0 && (
                <>
                  <h3 className="plan-subtitle">No longer in the plan</h3>
                  <DecisionList items={orphans} />
                </>
              )}
            </PlanSection>
          )}
        </div>
      </div>

      {isLatest && (
        <footer className="plan-footer">
          <div className="column">
            <div className="plan-approve">
              <button
                type="button"
                className="button"
                disabled={running}
                aria-describedby={
                  [running ? runningId : null, unanswered > 0 ? warningId : null]
                    .filter((x) => x !== null)
                    .join(' ') || undefined
                }
                onClick={() => {
                  post({
                    type: 'plan.approve',
                    planId: plan.id,
                    version: shown.version,
                    contentHash: shown.contentHash,
                  });
                }}
              >
                Approve and execute version {shown.version}
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
            {running && (
              <p id={runningId} className="plan-hint muted">
                A turn is running in this conversation. Approve the plan once it has finished or
                been stopped.
              </p>
            )}
            {approvals.length > 0 && (
              <ul className="plan-approvals">
                {approvals.map((a, i) => (
                  <li key={i}>Approved on {formatTime(a.approvedAt)}</li>
                ))}
              </ul>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}

function DecisionList({ items }: { items: ReturnType<typeof summarizeDecisions> }) {
  return (
    <ul className="plan-decisions-list">
      {items.map((item, i) => (
        <li key={i}>
          <span className="plan-question">{item.question}</span>
          <span className="plan-decision-values">{item.values.join(', ')}</span>
          <span className="muted"> {formatTime(item.decision.decidedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
