import { memo, useRef } from 'react';
import type { ConversationId, MessageId, TurnId } from '../../../shared';
import { Icon } from '../../app/components';
import { usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { PartView } from './parts';
import { PromptScope } from './prompt-scope';

const MAX_LABEL = 60;
const NOT_SEEN = 'The agent did not see this question.';

/** The question, shortened for the names of the card and its buttons so that several cards differ. */
function shortQuestion(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

/**
 * One side question in the log: the question, the answer as it streams (drawn by the same part
 * renderers as the transcript), its status and what can be done with it. It reads only its own
 * entry of `active.asides`, so its text growing re-renders this card and nothing else in the log.
 */
export const AsideCard = memo(function AsideCard({
  conversationId,
}: {
  conversationId: ConversationId;
}) {
  const post = usePost();
  const aside = useViewState((s) =>
    s.active?.asides.find((a) => a.conversationId === conversationId),
  );
  const root = useRef<HTMLElement>(null);
  // A card that was already failed when it appeared (the conversation was opened) shows its error as a
  // plain line: an alert would be spoken again at every open. One that fails while shown is an alert.
  const failedAtMount = useRef(aside?.status === 'error');
  // Stop goes away when the side question ends: keep focus on the card instead of losing it.
  useFocusRecovery(root);
  if (!aside) return null;

  const running = aside.status === 'running' || aside.status === 'preparing';
  // Each line is worked out from the status alone, so it changes (and is spoken) once, when the status
  // does, and never again on later renders. The error is an alert; the rest are status lines.
  const failed = aside.status === 'error';
  const status =
    running && aside.parts.length === 0
      ? 'Answering…'
      : aside.status === 'interrupted'
        ? 'Stopped.'
        : aside.status === 'completed'
          ? 'Answered.'
          : failed
            ? (aside.error ?? 'The side question failed.')
            : null;
  const short = shortQuestion(aside.question);
  // The answer has no message of its own in the open conversation: the parts get stand-in ids.
  const messageId = `aside:${aside.conversationId}` as MessageId;
  const turnId = `aside:${aside.conversationId}` as TurnId;

  return (
    <section
      ref={root}
      tabIndex={-1}
      className={`aside-card aside-card--${aside.status}`}
      aria-label={`Side question: ${short}`}
    >
      <div className="aside-head">
        <Icon name="comment" />
        <span className="aside-label">Side question</span>
      </div>
      <p className="aside-question">{aside.question}</p>
      {aside.parts.length > 0 && (
        <PromptScope.Provider value={aside.prompts}>
          <div className="aside-answer">
            {aside.parts.map((part, index) => (
              <PartView
                key={index}
                part={part}
                messageId={messageId}
                turnId={turnId}
                conversationId={aside.conversationId}
              />
            ))}
          </div>
        </PromptScope.Provider>
      )}
      {status !== null && (
        <p
          className={`aside-status aside-status--${aside.status}`}
          role={failed ? (failedAtMount.current ? undefined : 'alert') : 'status'}
        >
          <Icon
            name={
              running
                ? 'loading'
                : failed
                  ? 'error'
                  : aside.status === 'completed'
                    ? 'check'
                    : 'debug-stop'
            }
            spin={running}
          />
          <span>{status}</span>
        </p>
      )}
      <p className="aside-note">{NOT_SEEN}</p>
      <div className="aside-actions">
        {running && (
          <button
            type="button"
            className="button button--stop"
            aria-label={`Stop side question: ${short}`}
            onClick={() => {
              post({ type: 'turn.cancel', conversationId: aside.conversationId });
            }}
          >
            <Icon name="debug-stop" />
            <span>Stop</span>
          </button>
        )}
        <button
          type="button"
          className="button button--secondary"
          aria-label={`Open as conversation: ${short}`}
          onClick={() => {
            post({ type: 'conversation.open', conversationId: aside.conversationId });
          }}
        >
          <Icon name="link-external" />
          <span>Open as conversation</span>
        </button>
      </div>
    </section>
  );
});
