import { useId, useState } from 'react';
import type { PlanContent, PlanUserDecision } from '../../../shared';
import { usePost } from '../../app/context';
import type { PlanId } from '../../../shared';
import { formatTime } from './plan-model';
import type { DecisionSummary } from './plan-model';

type DecisionPoint = PlanContent['decisionPoints'][number];
type OpenQuestion = PlanContent['openQuestions'][number];

const MAX_TEXT = 4000;

interface Common {
  planId: PlanId;
  /** The recorded answer, if any. */
  recorded: PlanUserDecision | undefined;
  /** True when an older version is shown: answers cannot be changed from there. */
  readOnly: boolean;
}

/** A choice between approaches: option cards in a radio group. */
export function DecisionPointCard({
  planId,
  point,
  recorded,
  readOnly,
}: Common & { point: DecisionPoint }) {
  const post = usePost();
  const base = useId();
  const chosen = recorded?.values[0];
  return (
    <div className="plan-decision">
      <div id={`${base}-q`} className="plan-question">
        {point.question}
      </div>
      <div role="radiogroup" aria-labelledby={`${base}-q`} className="plan-options">
        {point.options.map((option) => {
          const id = `${base}-${option.id}`;
          const isChosen = chosen === option.id;
          const recommended = point.recommendedOptionId === option.id;
          return (
            <label
              key={option.id}
              className={`plan-option${isChosen ? ' plan-option--chosen' : ''}`}
            >
              <input
                type="radio"
                name={base}
                checked={isChosen}
                disabled={readOnly}
                aria-labelledby={`${id}-label`}
                aria-describedby={
                  [
                    option.description !== '' ? `${id}-desc` : null,
                    recommended ? `${id}-rec` : null,
                    isChosen ? `${id}-chosen` : null,
                  ]
                    .filter((x) => x !== null)
                    .join(' ') || undefined
                }
                onChange={() => {
                  if (readOnly) return;
                  post({
                    type: 'plan.decide',
                    planId,
                    targetId: point.id,
                    kind: 'decision-point',
                    values: [option.id],
                  });
                }}
              />
              <span className="plan-option-text">
                <span className="plan-option-head">
                  <span id={`${id}-label`} className="plan-option-label">
                    {option.label}
                  </span>
                  {recommended && (
                    <span id={`${id}-rec`} className="plan-tag">
                      Recommended
                    </span>
                  )}
                  {isChosen && (
                    <span id={`${id}-chosen`} className="plan-tag plan-tag--chosen">
                      Your choice
                    </span>
                  )}
                </span>
                {option.description !== '' && (
                  <span id={`${id}-desc`} className="plan-option-desc">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {recorded && <RecordedLine recorded={recorded} />}
    </div>
  );
}

function RecordedLine({ recorded }: { recorded: PlanUserDecision }) {
  return <p className="plan-recorded muted">Answered {formatTime(recorded.decidedAt)}</p>;
}

/** A question for the user: single choice, multiple choice or free text. */
export function OpenQuestionCard({
  planId,
  question,
  recorded,
  readOnly,
}: Common & { question: OpenQuestion }) {
  const post = usePost();
  const base = useId();
  const [picked, setPicked] = useState<string[]>(recorded?.values ?? []);
  const [text, setText] = useState(recorded?.values[0] ?? '');
  // When the host records a different answer, the form starts again from it. This is done while
  // rendering instead of by remounting, so the control that has focus keeps it.
  const recordedKey = recorded
    ? `${String(recorded.decidedAt)}:${recorded.values.join('\u0000')}`
    : 'none';
  const [seenKey, setSeenKey] = useState(recordedKey);
  if (seenKey !== recordedKey) {
    setSeenKey(recordedKey);
    setPicked(recorded?.values ?? []);
    setText(recorded?.values[0] ?? '');
  }

  const decide = (values: string[]) => {
    post({
      type: 'plan.decide',
      planId,
      targetId: question.id,
      kind: 'open-question',
      values,
    });
  };

  const label = (
    <div id={`${base}-q`} className="plan-question">
      {question.question}
    </div>
  );

  if (question.kind === 'text') {
    const value = text.trim();
    return (
      <div className="plan-decision" role="group" aria-labelledby={`${base}-q`}>
        {label}
        <textarea
          className="plan-answer-text"
          rows={3}
          aria-label={`Your answer to: ${question.question}`}
          maxLength={MAX_TEXT}
          disabled={readOnly}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        {!readOnly && (
          <button
            type="button"
            className="button button--secondary"
            aria-label={`Save answer: ${question.question}`}
            disabled={value === ''}
            onClick={() => {
              decide([value]);
            }}
          >
            Save
          </button>
        )}
        {recorded && <RecordedLine recorded={recorded} />}
      </div>
    );
  }

  const multi = question.kind === 'multi';
  return (
    <div className="plan-decision">
      {label}
      <div
        role={multi ? 'group' : 'radiogroup'}
        aria-labelledby={`${base}-q`}
        className="plan-options"
      >
        {question.options.map((option) => {
          const id = `${base}-${option.id}`;
          const checked = multi ? picked.includes(option.id) : recorded?.values[0] === option.id;
          return (
            <label
              key={option.id}
              className={`plan-option${checked ? ' plan-option--chosen' : ''}`}
            >
              <input
                type={multi ? 'checkbox' : 'radio'}
                name={base}
                checked={checked}
                disabled={readOnly}
                aria-labelledby={`${id}-label`}
                aria-describedby={option.description !== '' ? `${id}-desc` : undefined}
                onChange={() => {
                  if (readOnly) return;
                  if (multi) {
                    setPicked((current) =>
                      current.includes(option.id)
                        ? current.filter((v) => v !== option.id)
                        : [...current, option.id],
                    );
                  } else decide([option.id]);
                }}
              />
              <span className="plan-option-text">
                <span id={`${id}-label`} className="plan-option-label">
                  {option.label}
                </span>
                {option.description !== '' && (
                  <span id={`${id}-desc`} className="plan-option-desc">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {multi && !readOnly && (
        <button
          type="button"
          className="button button--secondary"
          aria-label={`Save answer: ${question.question}`}
          disabled={picked.length === 0}
          onClick={() => {
            // Keep the order of the options, whatever order the boxes were ticked in.
            decide(question.options.map((o) => o.id).filter((id) => picked.includes(id)));
          }}
        >
          Save
        </button>
      )}
      {recorded && <RecordedLine recorded={recorded} />}
    </div>
  );
}

/**
 * What the user decided: the question and the chosen values. Answers to questions the newest version
 * no longer asks stay in the list, after the others and marked, so no decision disappears silently.
 */
export function DecisionList({ items }: { items: readonly DecisionSummary[] }) {
  const ordered = [...items.filter((i) => !i.orphan), ...items.filter((i) => i.orphan)];
  return (
    <ul className="plan-decisions-list">
      {ordered.map((item, i) => (
        <li key={i} className={item.orphan ? 'plan-decision-item--orphan' : undefined}>
          <span className="plan-question">{item.question}</span>
          <span className="plan-decision-values">{item.values.join(', ')}</span>
          {item.orphan && <span className="plan-tag">No longer in the plan</span>}
          <span className="muted"> {formatTime(item.decision.decidedAt)}</span>
        </li>
      ))}
    </ul>
  );
}
