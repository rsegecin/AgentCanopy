import { memo, useId, useMemo } from 'react';
import type {
  ApprovalSource,
  MessageId,
  MessagePart,
  ToolCallStatus,
  ToolCallView,
  ViewState,
} from '../../../shared';
import { Icon, VisuallyHidden } from '../../app/components';
import { useApp } from '../../app/context';
import { useViewState } from '../../app/store';
import { useUi } from '../../app/ui-state';
import { DIFF_MAX_LINES, describeInput, presentTool } from './tool-present';
import { CommandLinesWarning, CommandText } from './CommandText';
import { FileLink } from './FileLink';
import type { ToolBody } from './tool-present';

export { summarizeToolInput } from './tool-present';

const STATUS: Record<ToolCallStatus, { icon: string; label: string; spin?: boolean }> = {
  running: { icon: 'loading', label: 'Running', spin: true },
  'awaiting-approval': { icon: 'bell', label: 'Waiting for approval' },
  done: { icon: 'check', label: 'Done' },
  error: { icon: 'error', label: 'Failed' },
  denied: { icon: 'circle-slash', label: 'Denied' },
  'not-run': { icon: 'debug-step-over', label: 'Not run' },
};

const APPROVAL: Record<ApprovalSource, string> = {
  user: 'Approved by you',
  policy: 'Allowed by AgentCanopy',
  provider: 'Allowed by Claude Code',
  auto: 'Auto-approved',
  unverified: 'Not verified by AgentCanopy',
};

/** Nested calls deeper than this are not drawn (a guard against a malformed parent chain). */
const MAX_NESTING = 6;

const EMPTY_CALLS: readonly ToolCallView[] = [];
const NO_ANCESTORS: readonly string[] = [];

type ToolPart = Extract<MessagePart, { kind: 'tool' }>;

function messageToolParts(state: ViewState, messageId: MessageId | undefined): ToolPart[] | null {
  if (messageId === undefined) return null;
  const messages = state.active?.messages;
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.id !== messageId) continue;
    return message.role === 'assistant'
      ? message.parts.filter((p): p is ToolPart => p.kind === 'tool')
      : null;
  }
  return null;
}

function sameCalls(a: readonly ToolCallView[], b: readonly ToolCallView[]): boolean {
  return a.length === b.length && a.every((call, index) => call === b[index]);
}

/** A selector for the calls whose `parentId` is `parentId`. It returns the same array while those calls are unchanged. */
function childCallsSelector(messageId: MessageId | undefined, parentId: string) {
  let last: readonly ToolCallView[] = EMPTY_CALLS;
  return (state: ViewState): readonly ToolCallView[] => {
    const parts = messageToolParts(state, messageId);
    const next = parts
      ? parts.filter((p) => p.call.parentId === parentId).map((p) => p.call)
      : EMPTY_CALLS;
    if (sameCalls(last, next)) return last;
    last = next;
    return next;
  };
}

function useChildCalls(
  messageId: MessageId | undefined,
  parentId: string,
): readonly ToolCallView[] {
  const select = useMemo(() => childCallsSelector(messageId, parentId), [messageId, parentId]);
  return useViewState(select);
}

/**
 * True when the call is drawn inside its parent's card: the parent is a tool call of the same
 * message and the chain of parents ends. An orphan (or a loop) is drawn at top level.
 */
export function useIsNested(messageId: MessageId, call: ToolCallView): boolean {
  const parentId = call.parentId;
  const id = call.id;
  return useViewState((state) => {
    if (parentId === null) return false;
    const parts = messageToolParts(state, messageId);
    if (!parts) return false;
    const byId = new Map(parts.map((p) => [p.call.id, p.call] as const));
    const seen = new Set<string>([id]);
    let current: string | null = parentId;
    while (current !== null) {
      if (seen.has(current)) return false;
      const parent = byId.get(current);
      if (!parent) return current !== parentId;
      seen.add(current);
      current = parent.parentId;
    }
    return true;
  });
}

function Body({ body }: { body: ToolBody }) {
  switch (body.kind) {
    case 'command':
      return (
        <>
          <pre className="tool-card-pre tool-card-command" role="group" aria-label="Command">
            <CommandText text={body.text} />
          </pre>
          <CommandLinesWarning text={body.text} />
        </>
      );
    case 'fields':
      return (
        <dl className="tool-card-fields">
          {body.fields.map((field) => (
            <div key={field.label}>
              <dt className="tool-card-label">{field.label}</dt>
              <dd>{field.text}</dd>
            </div>
          ))}
        </dl>
      );
    case 'diff':
      return (
        <div className="tool-card-diff">
          <div className="tool-card-label">Changes</div>
          <div
            className="tool-card-pre tool-card-diff-lines"
            role="group"
            aria-label="Changes"
            tabIndex={0}
          >
            {body.lines.map((line, index) => {
              const removed = line.sign === '-';
              return (
                <div
                  key={index}
                  className={`diff-line ${removed ? 'diff-line--removed' : 'diff-line--added'}`}
                >
                  <VisuallyHidden>{removed ? 'removed' : 'added'} </VisuallyHidden>
                  <span className="diff-sign" aria-hidden="true">
                    {line.sign}
                  </span>
                  <span className="diff-text">{line.text}</span>
                </div>
              );
            })}
          </div>
          {body.total > body.lines.length && (
            <p className="tool-card-note">
              Showing the first {DIFF_MAX_LINES} of {body.total} lines.
            </p>
          )}
        </div>
      );
  }
}

interface ToolCardProps {
  call: ToolCallView;
  /** The message the call belongs to. Needed to draw the calls this one made inside it. */
  messageId?: MessageId;
  /** Ids of the cards this one is drawn inside, outermost first. */
  ancestors?: readonly string[];
}

/**
 * A tool call: icon, title, status and approval source, and a disclosure with the specialised
 * view for its tool, the raw input, the result and any calls it made itself.
 */
export const ToolCard = memo(function ToolCard({
  call,
  messageId,
  ancestors = NO_ANCESTORS,
}: ToolCardProps) {
  const { ui } = useApp();
  const expanded = useUi((s) => s.expanded[call.id] === true);
  const bodyId = useId();
  const metaId = useId();
  const status = STATUS[call.status];
  const present = useMemo(() => presentTool(call), [call]);
  const children = useChildCalls(messageId, call.id);
  const nested = ancestors.length > 0;
  const visibleChildren =
    ancestors.length < MAX_NESTING ? children.filter((c) => !ancestors.includes(c.id)) : [];
  const childAncestors = useMemo(() => [...ancestors, call.id], [ancestors, call.id]);
  const input = expanded ? describeInput(call) : null;

  return (
    <div className={`tool-card tool-card--${call.status}${nested ? ' tool-card--nested' : ''}`}>
      <div className="tool-card-header">
        <button
          type="button"
          className="tool-card-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-describedby={metaId}
          onClick={() => {
            ui.setExpanded(call.id, !expanded);
          }}
        >
          <Icon name={expanded ? 'chevron-down' : 'chevron-right'} />
          <Icon name={present.icon} />
          <span className="tool-card-name" title={present.title}>
            {present.title}
          </span>
          {present.lines !== undefined && ' '}
          {present.lines !== undefined && (
            <span className="cmd-lines muted">{`${String(present.lines)} lines`}</span>
          )}
        </button>
        {present.link && <FileLink target={present.link} className="tool-card-path" />}
        {present.detail !== undefined && (
          <span className="tool-card-summary" title={present.detail}>
            {present.detail}
          </span>
        )}
        <span id={metaId} className="tool-card-meta">
          <span className="tool-card-status">
            <Icon name={status.icon} spin={status.spin === true} />
            <span>{status.label}</span>
          </span>
          {call.approval && (
            <span className="tool-card-approval">
              <VisuallyHidden>, </VisuallyHidden>
              {APPROVAL[call.approval]}
            </span>
          )}
        </span>
      </div>
      <div id={bodyId} className="tool-card-body" hidden={!expanded}>
        {expanded && input && (
          <>
            {present.body && <Body body={present.body} />}
            <div className="tool-card-label">
              Input
              {input.truncated && <span className="tool-card-note"> Input truncated</span>}
            </div>
            <pre className="tool-card-pre" role="group" aria-label="Input" tabIndex={0}>
              {input.text}
            </pre>
            {call.resultPreview !== undefined && (
              <>
                <div className="tool-card-label">
                  Result
                  {call.resultTruncated === true && (
                    <span className="tool-card-note"> Output truncated</span>
                  )}
                </div>
                <pre className="tool-card-pre" role="group" aria-label="Result" tabIndex={0}>
                  {call.resultPreview}
                </pre>
              </>
            )}
            {visibleChildren.length > 0 && (
              <div className="tool-card-children" role="group" aria-label="Calls made by this one">
                {visibleChildren.map((child) => (
                  <ToolCard
                    key={child.id}
                    call={child}
                    {...(messageId !== undefined ? { messageId } : {})}
                    ancestors={childAncestors}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
});
