import { Fragment, memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UIEvent } from 'react';
import type {
  ConversationId,
  ConversationSummary,
  Message,
  MessageId,
  ViewState,
} from '../../../shared';
import { Icon, IconButton, VisuallyHidden } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useViewState } from '../../app/store';
import { BranchHeader } from '../branches/BranchHeader';
import { BranchMarker } from '../branches/BranchMarker';
import { SyntheticPlanCard } from '../plan/PlanUpdateCard';
import { AsideCard } from './AsideCard';
import { AttachmentChip } from './AttachmentChip';
import { PartView } from './parts';

const NEAR_BOTTOM_PX = 80;

const MODE_LABEL = { ask: 'Ask', plan: 'Plan', agent: 'Agent' } as const;

/** Where one side question's card sits in the log. What `Log` needs of an aside, and nothing that streams. */
interface AsideSlot {
  conversationId: ConversationId;
  messageId: MessageId;
  afterParts: number;
}

function sameSlots(a: readonly AsideSlot[], b: readonly AsideSlot[]): boolean {
  return (
    a.length === b.length &&
    a.every((slot, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        slot.conversationId === other.conversationId &&
        slot.messageId === other.messageId &&
        slot.afterParts === other.afterParts
      );
    })
  );
}

/**
 * A selector for the side questions' positions. It returns the same array while the positions are
 * unchanged, so the answer of a side question streaming in does not re-render the log.
 */
function asideSlotsSelector() {
  let last: readonly AsideSlot[] = [];
  return (state: ViewState): readonly AsideSlot[] => {
    const next = (state.active?.asides ?? []).map((a) => ({
      conversationId: a.conversationId,
      messageId: a.anchor.messageId,
      afterParts: a.anchor.afterParts,
    }));
    if (sameSlots(last, next)) return last;
    last = next;
    return next;
  };
}

function messageText(message: Message): string {
  if (message.role === 'user') return message.text;
  return message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n\n');
}

const MessageItem = memo(function MessageItem({
  message,
  conversationId,
  branches,
  asides,
}: {
  message: Message;
  conversationId: ConversationId;
  /** Conversations that were branched from this message. */
  branches?: readonly ConversationSummary[];
  /** The side questions asked under this message, oldest first. */
  asides?: readonly AsideSlot[];
}) {
  const post = usePost();
  // The execution message of an approved plan is told by the approval that started its turn, never
  // by its text.
  const executingVersion = useViewState((s) =>
    message.role === 'user'
      ? s.active?.plan?.approvals.find((a) => a.executionTurnId === message.turnId)?.version
      : undefined,
  );
  const actions = (
    <div className="message-actions">
      <IconButton
        icon="copy"
        label="Copy message"
        onClick={() => {
          post({ type: 'clipboard.copy', text: messageText(message) });
        }}
      />
      <IconButton
        icon="repo-forked"
        label="Fork from here"
        onClick={() => {
          post({ type: 'conversation.fork', conversationId, messageId: message.id });
        }}
      />
    </div>
  );

  if (message.role === 'user') {
    return (
      <>
        <article className="message message--user" aria-label="You">
          <div className="message-meta">
            {executingVersion !== undefined ? (
              <span className="plan-label-line">
                <Icon name="play" />
                <span>{`Plan approved: executing version ${String(executingVersion)}`}</span>
              </span>
            ) : message.mode === 'plan' ? (
              <span className="plan-label-line">
                <Icon name="checklist" />
                <span>Plan request</span>
              </span>
            ) : (
              <span className="badge">{MODE_LABEL[message.mode]}</span>
            )}
            {actions}
          </div>
          {executingVersion === undefined && <div className="user-text">{message.text}</div>}
          {message.attachments.length > 0 && (
            <ul className="chips" aria-label="Attachments">
              {message.attachments.map((attachment, index) => (
                <AttachmentChip key={index} attachment={attachment} />
              ))}
            </ul>
          )}
          {branches && <BranchMarker branches={branches} />}
        </article>
        {asides?.map((slot) => (
          <AsideCard key={slot.conversationId} conversationId={slot.conversationId} />
        ))}
      </>
    );
  }

  // A card sits after `afterParts` of the parts, and at the end when the message has fewer.
  const count = message.parts.length;
  const cardsAfter = (n: number) =>
    asides
      ?.filter((slot) => Math.min(slot.afterParts, count) === n)
      .map((slot) => <AsideCard key={slot.conversationId} conversationId={slot.conversationId} />);

  return (
    <article className="message message--assistant" aria-label="Assistant">
      <div className="message-meta">
        <span className="message-author">Assistant</span>
        {actions}
      </div>
      {cardsAfter(0)}
      {message.parts.map((part, index) => (
        <Fragment key={index}>
          <PartView
            part={part}
            messageId={message.id}
            turnId={message.turnId}
            conversationId={conversationId}
          />
          {cardsAfter(index + 1)}
        </Fragment>
      ))}
      {branches && <BranchMarker branches={branches} />}
    </article>
  );
});

/** The scrolling log for one conversation. Keyed by conversation id so scroll state starts fresh. */
function Log({ conversationId }: { conversationId: ConversationId }) {
  const { ui } = useApp();
  const messages = useViewState((s) => s.active?.messages);
  const turns = useViewState((s) => s.active?.turns);
  const activity = useViewState((s) => s.active?.activity ?? null);
  const planVersions = useViewState((s) => s.active?.plan?.versions.length ?? 0);
  const conversations = useViewState((s) => s.conversations);
  const branchesAt = useMemo(() => {
    const map = new Map<string, ConversationSummary[]>();
    for (const c of conversations) {
      // A side question is marked by its own card, not by a branch marker.
      if (c.fork?.parentId !== conversationId || c.aside !== undefined) continue;
      const list = map.get(c.fork.atMessageId) ?? [];
      list.push(c);
      map.set(c.fork.atMessageId, list);
    }
    return map;
  }, [conversations, conversationId]);

  const asideSelector = useMemo(() => asideSlotsSelector(), []);
  const asideSlots = useViewState(asideSelector);
  const asidesAt = useMemo(() => {
    const map = new Map<MessageId, AsideSlot[]>();
    for (const slot of asideSlots) {
      const list = map.get(slot.messageId) ?? [];
      list.push(slot);
      map.set(slot.messageId, list);
    }
    return map;
  }, [asideSlots]);
  // Side questions whose message is not in the transcript (any more) go to the end of the log.
  const stranded: AsideSlot[] = [];
  if (asideSlots.length > 0) {
    const known = new Set((messages ?? []).map((m) => m.id));
    for (const slot of asideSlots) if (!known.has(slot.messageId)) stranded.push(slot);
  }

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(ui.getScroll(conversationId)?.atBottom ?? true);
  const initialised = useRef(false);
  const previousLength = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const lastTurn = turns?.[turns.length - 1];
  const running = lastTurn?.status === 'running' || lastTurn?.status === 'preparing';
  const failure =
    lastTurn && !running && lastTurn.status === 'error'
      ? (lastTurn.error ?? 'The turn failed.')
      : null;
  const interrupted = lastTurn?.status === 'interrupted';

  // What a screen reader hears: a turn starting or ending, and a question needing an answer. Once
  // each, never the activity line or the streaming text. Worked out while rendering, from changes.
  // The prompts of the side questions count too: they wait for an answer just the same.
  const pendingPrompts = useViewState((s) => {
    const active = s.active;
    if (!active) return 0;
    const pending = (prompts: readonly { state: string }[]) =>
      prompts.filter((p) => p.state === 'pending').length;
    return pending(active.prompts) + active.asides.reduce((sum, a) => sum + pending(a.prompts), 0);
  });
  const [heard, setHeard] = useState({ running, pending: pendingPrompts, text: '' });
  if (heard.running !== running || heard.pending !== pendingPrompts) {
    let text = heard.text;
    if (running && !heard.running) text = 'The agent is working.';
    else if (!running && heard.running) {
      text =
        lastTurn?.status === 'error'
          ? 'The turn failed.'
          : interrupted
            ? 'The turn was stopped.'
            : 'The agent finished.';
    }
    if (pendingPrompts > heard.pending) {
      text =
        pendingPrompts === 1
          ? 'The agent is waiting for your answer.'
          : `The agent is waiting for ${String(pendingPrompts)} answers.`;
    }
    setHeard({ running, pending: pendingPrompts, text });
  }

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const list = messages ?? [];
    if (!initialised.current) {
      initialised.current = true;
      const saved = ui.getScroll(conversationId);
      if (saved && !saved.atBottom) el.scrollTop = saved.top;
      else el.scrollTop = el.scrollHeight;
    } else {
      const last = list[list.length - 1];
      // Sending a message always brings you to it.
      if (list.length > previousLength.current && last?.role === 'user') stick.current = true;
      if (stick.current) el.scrollTop = el.scrollHeight;
    }
    previousLength.current = list.length;
  }, [messages, activity, failure, planVersions, ui, conversationId]);

  // The changes card (or anything else beside the log) can appear, grow or collapse, which changes
  // the log's height without a scroll: a log that was at the bottom stays there.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    // A card in the middle of the log (a side question streaming) grows the content, not the log.
    const contentObserver = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    if (content.current) contentObserver.observe(content.current);
    return () => {
      observer.disconnect();
      contentObserver.disconnect();
    };
  }, []);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    stick.current = near;
    setShowJump(!near);
    ui.setScroll(conversationId, { top: el.scrollTop, atBottom: near });
  };

  const jump = () => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    stick.current = true;
    setShowJump(false);
  };

  return (
    <div className="log-wrap">
      <div
        ref={scroller}
        className="log"
        role="log"
        aria-live="off"
        aria-label="Conversation"
        tabIndex={0}
        onScroll={onScroll}
      >
        <div ref={content} className="column">
          <BranchHeader />
          {(messages ?? []).map((message) => (
            <MessageItem
              key={message.id}
              message={message}
              conversationId={conversationId}
              branches={branchesAt.get(message.id)}
              asides={asidesAt.get(message.id)}
            />
          ))}
          <SyntheticPlanCard />
          {failure !== null && (
            <div className="notice notice--error">
              <Icon name="error" />
              <span>
                <VisuallyHidden>Error: </VisuallyHidden>
                {failure}
              </span>
            </div>
          )}
          {interrupted && (
            <div className="notice notice--info">
              <Icon name="debug-stop" />
              <span>Stopped before the turn finished.</span>
            </div>
          )}
          {stranded.map((slot) => (
            <AsideCard key={slot.conversationId} conversationId={slot.conversationId} />
          ))}
        </div>
      </div>
      {showJump && (
        <button type="button" className="jump-latest" onClick={jump}>
          <Icon name="arrow-down" />
          <span>Jump to latest</span>
        </button>
      )}
      <div className="visually-hidden" role="status" aria-live="polite">
        {heard.text}
      </div>
      <div className="activity">
        {running && (
          <div className="column activity-line">
            <Icon name="loading" spin />
            <span>{activity ?? (lastTurn.status === 'preparing' ? 'Preparing…' : 'Working…')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageList() {
  const conversationId = useViewState((s) => s.active?.meta.id);
  if (conversationId === undefined) {
    return (
      <div className="empty-state">
        <Icon name="comment-discussion" />
        <p>Ask a question, plan a change, or let the agent work.</p>
      </div>
    );
  }
  return <Log key={conversationId} conversationId={conversationId} />;
}
