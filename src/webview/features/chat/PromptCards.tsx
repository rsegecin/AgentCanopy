import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AlwaysRuleKind,
  PermissionChoice,
  PermissionPrompt,
  Prompt,
  Question,
  QuestionPrompt,
} from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { useUi } from '../../app/ui-state';
import type { QuestionDraft } from '../../app/ui-state';
import { CommandLinesWarning, CommandText } from './CommandText';
import { commandLines } from './command-lines';
import { PromptPlaceholder } from './parts';
import { PromptScope } from './prompt-scope';
import type { PartRendererProps } from './registry';

const MAX_ANSWER = 4000;
const NO_DRAFT: QuestionDraft = { labels: [], other: '', otherOn: false };

/** The card around a prompt: a named group, the "needs your answer" marker and scroll-into-view. */
function PromptShell({
  prompt,
  label,
  plan = false,
  children,
}: {
  prompt: Prompt;
  label: string;
  /** The card belongs to a Plan-mode turn and is presented as "Plan options". */
  plan?: boolean;
  children: ReactNode;
}) {
  const scope = useContext(PromptScope);
  const first = useViewState(
    (s) => (scope ?? s.active?.prompts)?.find((p) => p.state === 'pending')?.id === prompt.id,
  );
  const needsAnswer = first && prompt.state === 'pending';
  const root = useRef<HTMLDivElement>(null);
  // Answering turns the form into a read-only card: keep focus on the card instead of losing it.
  useFocusRecovery(root);

  // Bring a new question into view. Scrolling never moves keyboard focus, so typing in the composer goes on.
  useEffect(() => {
    if (needsAnswer) root.current?.scrollIntoView?.({ block: 'nearest' });
  }, [needsAnswer]);

  return (
    <div
      ref={root}
      role="group"
      tabIndex={-1}
      aria-label={label}
      className={`prompt-card prompt-card--${prompt.state}${needsAnswer ? ' prompt-card--needs-answer' : ''}${plan ? ' prompt-card--plan' : ''}`}
    >
      {needsAnswer && (
        <div className="prompt-marker">
          <Icon name="bell" />
          <span>Needs your answer</span>
        </div>
      )}
      {plan && (
        <p className="plan-label-line">
          <Icon name="checklist" />
          <span>Plan options</span>
        </p>
      )}
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ questions */

/** The answer for one question, or null while it has none. */
export function answerFor(question: Question, draft: QuestionDraft): string[] | null {
  const labels = question.options
    .map((o) => o.label)
    .filter((label) => draft.labels.includes(label));
  const other = draft.otherOn ? draft.other.trim() : '';
  if (question.multiSelect) {
    const all = other !== '' ? [...labels, other] : labels;
    return all.length > 0 ? all : null;
  }
  if (draft.otherOn) return other !== '' ? [other] : null;
  const [chosen] = labels;
  return chosen !== undefined ? [chosen] : null;
}

function QuestionBlock({
  question,
  index,
  idPrefix,
  draft,
  disabled,
  onChange,
}: {
  question: Question;
  index: number;
  idPrefix: string;
  draft: QuestionDraft;
  disabled: boolean;
  onChange: (draft: QuestionDraft) => void;
}) {
  const multi = question.multiSelect;
  const type = multi ? 'checkbox' : 'radio';
  const base = `${idPrefix}-q${String(index)}`;
  const toggle = (label: string) => {
    if (multi) {
      const labels = draft.labels.includes(label)
        ? draft.labels.filter((l) => l !== label)
        : [...draft.labels, label];
      onChange({ ...draft, labels });
    } else onChange({ labels: [label], other: draft.other, otherOn: false });
  };

  return (
    <div className="prompt-question">
      {question.header !== '' && <div className="prompt-header">{question.header}</div>}
      <div id={`${base}-label`} className="prompt-question-text">
        {question.question}
      </div>
      <div role={multi ? 'group' : 'radiogroup'} aria-labelledby={`${base}-label`}>
        {question.options.map((option, optionIndex) => {
          const id = `${base}-o${String(optionIndex)}`;
          return (
            <label key={option.label} className="prompt-option">
              <input
                type={type}
                name={base}
                checked={draft.labels.includes(option.label)}
                disabled={disabled}
                aria-labelledby={`${id}-label`}
                aria-describedby={option.description !== '' ? `${id}-desc` : undefined}
                onChange={() => {
                  toggle(option.label);
                }}
              />
              <span>
                <span id={`${id}-label`} className="prompt-option-label">
                  {option.label}
                </span>
                {option.description !== '' && (
                  <span id={`${id}-desc`} className="prompt-option-desc">
                    {option.description}
                  </span>
                )}
              </span>
            </label>
          );
        })}
        <div className="prompt-option prompt-option--other">
          <label className="prompt-other-choice">
            <input
              type={type}
              name={base}
              checked={draft.otherOn}
              disabled={disabled}
              onChange={() => {
                if (multi) onChange({ ...draft, otherOn: !draft.otherOn });
                else onChange({ labels: [], other: draft.other, otherOn: true });
              }}
            />
            <span className="prompt-option-label">Other</span>
          </label>
          <input
            type="text"
            className="text-input prompt-other-text"
            aria-label={`Other answer for: ${question.question}`}
            maxLength={MAX_ANSWER}
            disabled={disabled}
            value={draft.other}
            onChange={(event) => {
              // Typing in the field chooses "Other"; a single-choice question drops its option.
              onChange({
                labels: multi ? draft.labels : [],
                other: event.target.value,
                otherOn: true,
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}

function cardLabel(prompt: QuestionPrompt, plan: boolean): string {
  const first = prompt.questions[0]?.question ?? '';
  const more =
    prompt.questions.length > 1 ? ` (and ${String(prompt.questions.length - 1)} more)` : '';
  return `${plan ? 'Plan options' : 'Question from the agent'}: ${first}${more}`;
}

function QuestionCard({ prompt }: { prompt: QuestionPrompt }) {
  const { ui } = useApp();
  const post = usePost();
  const drafts = useUi((s) => s.questions[prompt.id]);
  // The agent asks its choices during a Plan turn: those cards are the "Plan options".
  const plan = useViewState(
    (s) => s.active?.turns.find((t) => t.id === prompt.turnId)?.mode === 'plan',
  );
  const idPrefix = useId();
  const hintId = useId();
  // The form stays locked after posting until the prompt changes in the state.
  const [sent, setSent] = useState<QuestionPrompt | null>(null);
  const locked = sent === prompt;

  const answers = prompt.questions.map((q, i) => answerFor(q, drafts?.[i] ?? NO_DRAFT));
  const complete = answers.every((a) => a !== null);

  const submit = () => {
    if (!complete || locked) return;
    const record: Record<string, string[]> = {};
    prompt.questions.forEach((q, i) => {
      const answer = answers[i];
      if (answer) record[q.question] = answer;
    });
    post({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: { kind: 'question', answers: record },
    });
    setSent(prompt);
  };

  if (prompt.state !== 'pending') {
    return (
      <PromptShell prompt={prompt} label={cardLabel(prompt, plan)} plan={plan}>
        {prompt.state === 'answered' ? (
          <dl className={`prompt-answers${plan ? ' plan-decision-record' : ''}`}>
            {prompt.questions.map((q) => (
              <div key={q.question} className="prompt-answer">
                <dt>{q.question}</dt>
                <dd>{prompt.answered?.[q.question] ?? 'No answer recorded'}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="prompt-outcome">
            <Icon name={prompt.state === 'expired' ? 'history' : 'circle-slash'} />
            <span>
              {prompt.state === 'expired'
                ? 'This question expired because the turn ended.'
                : 'This question was cancelled.'}
            </span>
          </p>
        )}
      </PromptShell>
    );
  }

  return (
    <PromptShell prompt={prompt} label={cardLabel(prompt, plan)} plan={plan}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {prompt.questions.map((question, index) => (
          <QuestionBlock
            key={index}
            question={question}
            index={index}
            idPrefix={idPrefix}
            draft={drafts?.[index] ?? NO_DRAFT}
            disabled={locked}
            onChange={(draft) => {
              ui.setQuestionDraft(prompt.id, index, draft);
            }}
          />
        ))}
        <div className="prompt-actions">
          <button
            type="submit"
            className="button"
            disabled={!complete || locked}
            aria-describedby={!complete && !locked ? hintId : undefined}
          >
            Submit
          </button>
          {!complete && !locked && (
            <span id={hintId} className="prompt-hint muted">
              Answer every question to submit.
            </span>
          )}
        </div>
      </form>
    </PromptShell>
  );
}

/* ------------------------------------------------------------------ permissions */

const CHOICES: { choice: PermissionChoice; label: string }[] = [
  { choice: 'allow-once', label: 'Allow once' },
  { choice: 'allow-always', label: 'Always allow' },
  { choice: 'deny', label: 'Deny' },
];

const ANSWERED_TEXT: Record<PermissionChoice, string> = {
  'allow-once': 'You allowed this once',
  'allow-always': 'You always allow this',
  deny: 'You denied this',
};

/** What "Always allow" would do, in words, by the kind of rule. A command or tool rule is a rule in the CLI's syntax. */
function alwaysRuleLead(kind: AlwaysRuleKind | undefined): string {
  switch (kind) {
    case 'read-directory':
      return 'Always allow would allow reads and searches in this folder and below:';
    case 'web-site':
      return 'Always allow would allow fetching any address on:';
    default:
      return 'Always allow would add the rule:';
  }
}

function PermissionCard({ prompt }: { prompt: PermissionPrompt }) {
  const post = usePost();
  const feedbackId = useId();
  const [feedback, setFeedback] = useState('');
  const [sent, setSent] = useState<PermissionPrompt | null>(null);
  const locked = sent === prompt;
  const label = `Permission request: ${prompt.title}`;

  // Shown in full, with every line break marked, and never in a box of its own that scrolls: a
  // second command must not be able to hide below the first.
  const lineCount = commandLines(prompt.detail).length;
  const detail = (
    <>
      <pre className="prompt-detail" role="region" aria-label="Full text of the request">
        <CommandText text={prompt.detail} />
      </pre>
      <CommandLinesWarning text={prompt.detail} />
    </>
  );
  const title = (
    <div className="prompt-title">
      {prompt.title}
      {lineCount > 1 && (
        <span className="cmd-lines muted">{` \u00B7 ${String(lineCount)} lines`}</span>
      )}
    </div>
  );

  if (prompt.state !== 'pending') {
    return (
      <PromptShell prompt={prompt} label={label}>
        {title}
        {detail}
        <p className="prompt-outcome">
          <Icon
            name={
              prompt.state === 'answered'
                ? 'check'
                : prompt.state === 'expired'
                  ? 'history'
                  : 'circle-slash'
            }
          />
          <span>
            {prompt.state === 'answered'
              ? prompt.answered !== undefined
                ? ANSWERED_TEXT[prompt.answered]
                : 'You answered this'
              : prompt.state === 'expired'
                ? 'This request expired because the turn ended.'
                : 'This request was cancelled.'}
          </span>
        </p>
      </PromptShell>
    );
  }

  const answer = (choice: PermissionChoice) => {
    if (locked) return;
    const note = feedback.trim();
    post({
      type: 'prompt.answer',
      promptId: prompt.id,
      displayHash: prompt.displayHash,
      answer: {
        kind: 'permission',
        choice,
        ...(choice === 'deny' && note !== '' ? { feedback: note } : {}),
      },
    });
    setSent(prompt);
  };

  return (
    <PromptShell prompt={prompt} label={label}>
      {title}
      {detail}
      {prompt.inputPreview.trim() !== '' && (
        <details className="prompt-details">
          <summary>Details</summary>
          <pre className="tool-card-pre" role="group" aria-label="Input preview" tabIndex={0}>
            {prompt.inputPreview}
          </pre>
        </details>
      )}
      <label className="prompt-feedback" htmlFor={feedbackId}>
        Tell the agent what to do instead (optional)
      </label>
      <input
        id={feedbackId}
        type="text"
        className="text-input prompt-feedback-input"
        maxLength={MAX_ANSWER}
        disabled={locked}
        value={feedback}
        onChange={(event) => {
          setFeedback(event.target.value);
        }}
      />
      <div className="prompt-actions">
        {CHOICES.filter((c) => prompt.choices.includes(c.choice)).map((c) => (
          <button
            key={c.choice}
            type="button"
            className={`button${c.choice === 'allow-once' ? '' : ' button--secondary'}`}
            disabled={locked}
            onClick={() => {
              answer(c.choice);
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      {prompt.alwaysRule && (
        <div className="prompt-rule">
          <p>
            {alwaysRuleLead(prompt.alwaysRule.kind)} <code>{prompt.alwaysRule.rule}</code>
          </p>
          {prompt.alwaysRule.runsProjectCode && (
            <p className="prompt-warning">
              <Icon name="warning" />
              <span>
                <VisuallyHidden>Warning: </VisuallyHidden>
                This command runs code from the project, which can do anything you can do.
              </span>
            </p>
          )}
        </div>
      )}
    </PromptShell>
  );
}

/** The card for a `prompt` message part: a question form or a permission request. */
export function PromptPart(props: PartRendererProps<'prompt'>) {
  const scope = useContext(PromptScope);
  const fromActive = useViewState((s) =>
    scope === null ? s.active?.prompts.find((p) => p.id === props.part.promptId) : undefined,
  );
  const prompt = scope === null ? fromActive : scope.find((p) => p.id === props.part.promptId);
  if (!prompt) return <PromptPlaceholder {...props} />;
  return prompt.kind === 'question' ? (
    <QuestionCard prompt={prompt} />
  ) : (
    <PermissionCard prompt={prompt} />
  );
}
