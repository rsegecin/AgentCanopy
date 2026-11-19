import { createElement, memo, useContext } from 'react';
import type { ComponentType } from 'react';
import type { MessagePart } from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useViewState } from '../../app/store';
import { Markdown } from './Markdown';
import { ToolCard, useIsNested } from './ToolCard';
import { PromptScope } from './prompt-scope';
import { getPartRenderer } from './registry';
import { SUBMIT_PLAN_TOOL } from './tool-present';
import type { PartKind, PartRendererProps } from './registry';

type Of<K extends MessagePart['kind']> = PartRendererProps<K>;

function TextPart({ part }: Of<'text'>) {
  return <Markdown text={part.text} />;
}

function ThinkingPart({ part }: Of<'thinking'>) {
  return (
    <details className="thinking">
      <summary>Thinking</summary>
      <div className="thinking-text">{part.text}</div>
    </details>
  );
}

const NOTICE: Record<'info' | 'warning' | 'error', { icon: string; label: string }> = {
  info: { icon: 'info', label: 'Note' },
  warning: { icon: 'warning', label: 'Warning' },
  error: { icon: 'error', label: 'Error' },
};

function NoticePart({ part }: Of<'notice'>) {
  const level = NOTICE[part.level];
  return (
    <div className={`notice notice--${part.level}`}>
      <Icon name={level.icon} />
      <span>
        <VisuallyHidden>{level.label}: </VisuallyHidden>
        {part.text}
      </span>
    </div>
  );
}

function PlanUpdatePart({ part }: Of<'plan-update'>) {
  return (
    <div className="part-line">
      <Icon name="checklist" />
      <span>Plan updated to version {part.version}</span>
    </div>
  );
}

const PROMPT_TEXT = {
  pending: 'Waiting for your answer',
  answered: 'Answered',
  expired: 'Expired without an answer',
  cancelled: 'Cancelled',
} as const;

/** The one-line stand-in for a prompt part: used when no prompt card is registered or the prompt is gone. */
export function PromptPlaceholder({ part }: Of<'prompt'>) {
  const scope = useContext(PromptScope);
  const activeState = useViewState((s) =>
    scope === null ? s.active?.prompts.find((p) => p.id === part.promptId)?.state : undefined,
  );
  const state =
    (scope === null ? activeState : scope.find((p) => p.id === part.promptId)?.state) ?? 'pending';
  return (
    <div className="part-line">
      <Icon name="comment-discussion" />
      <span>{PROMPT_TEXT[state]}</span>
    </div>
  );
}

function ToolPart({ part, messageId }: Of<'tool'>) {
  // A call made by another call of the same message is drawn inside that call's card.
  const nested = useIsNested(messageId, part.call);
  if (nested) return null;
  // A submitted plan is shown by the plan card that follows it; only a call that is still running,
  // failed or was denied has something the card does not say.
  if (part.call.name === SUBMIT_PLAN_TOOL && part.call.status === 'done') return null;
  return <ToolCard call={part.call} messageId={messageId} />;
}

const DEFAULTS: { [K in PartKind]: ComponentType<PartRendererProps<K>> } = {
  text: TextPart,
  thinking: ThinkingPart,
  tool: ToolPart,
  notice: NoticePart,
  'plan-update': PlanUpdatePart,
  prompt: PromptPlaceholder,
  // The card is added in the next stage.
  changes: () => null,
};

/** Renders one part, through a registered override when there is one. Memoised on the part object. */
export const PartView = memo(function PartView(props: PartRendererProps) {
  const kind = props.part.kind;
  const renderer = getPartRenderer(kind) ?? (DEFAULTS[kind] as ComponentType<PartRendererProps>);
  // Both candidates are stable module-level components, so there is no remounting; createElement
  // keeps the react-hooks "components created during render" rule from misreading the lookup.
  return createElement(renderer, props);
});
