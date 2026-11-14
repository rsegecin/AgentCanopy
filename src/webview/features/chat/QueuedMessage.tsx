import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { isTurnRunning } from '../../app/turns';
import { chooseConversationMode } from './mode-choice';

const MODE_LABEL = { ask: 'Ask', plan: 'Plan', agent: 'Agent' } as const;

/** Where focus goes when the chip goes away: the composer's textarea, or the form while it is disabled. */
function composerInput(): HTMLElement | null {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  if (textarea && !textarea.disabled) return textarea;
  return document.querySelector<HTMLElement>('form.composer');
}

/**
 * The message the user sent while a turn was running, shown directly above the composer. It is sent
 * when that turn ends as completed; after a stop or an error it waits here for the user.
 */
export function QueuedMessage() {
  const post = usePost();
  const { ui } = useApp();
  const conversationId = useViewState((s) => s.active?.meta.id);
  const storedMode = useViewState((s) => s.active?.meta.mode);
  const queued = useViewState((s) => s.active?.queued ?? null);
  const turns = useViewState((s) => s.active?.turns);
  const configPending = useViewState((s) => s.review.configChanges.length > 0);
  const reviewBusy = useViewState((s) => s.review.busy);
  const root = useRef<HTMLElement>(null);
  const textBox = useRef<HTMLParagraphElement>(null);
  const statusId = useId();
  const [scrolls, setScrolls] = useState(false);
  useFocusRecovery(root, { fallback: composerInput });

  // The text is clamped to about three lines and scrolls in its own box; the keyboard reaches that
  // box only when there is something to scroll to.
  const text = queued?.text;
  useLayoutEffect(() => {
    const measure = () => {
      const el = textBox.current;
      setScrolls(el !== null && el.scrollHeight > el.clientHeight);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
    };
  }, [text]);

  if (queued === null || conversationId === undefined) return null;

  const running = isTurnRunning(turns);
  const lastStatus = turns?.[turns.length - 1]?.status;
  // Only an Agent message waits for the configuration decision and for the folder. The folder is held
  // by an Agent turn of another conversation, or by this one's own, which is not a blocker for a
  // message that is sent when it ends.
  const isAgent = queued.mode === 'agent';
  const lastTurn = turns?.[turns.length - 1];
  const ownAgentRuns = running && lastTurn?.mode === 'agent';
  const configBlocked = isAgent && configPending;
  const folderBusy = isAgent && reviewBusy && !ownAgentRuns;
  // The host sends a queued message by itself only when this conversation's turn ends as completed, so
  // a blocker that clears later leaves the message for the user to send.
  const status = running
    ? isAgent && configBlocked
      ? 'Sent when the agent finishes if the configuration changes are decided by then. Otherwise press Send afterwards.'
      : isAgent && folderBusy
        ? 'Sent when the agent finishes if the other agent turn in this folder has ended by then. Otherwise press Send afterwards.'
        : 'Sent when the agent finishes.'
    : configBlocked
      ? 'Decide on the configuration changes, then press Send.'
      : folderBusy
        ? 'Another agent turn is running in this folder. Press Send when it has ended.'
        : lastStatus === 'interrupted'
          ? 'Not sent: the turn was stopped.'
          : lastStatus === 'error'
            ? 'Not sent: the turn ended with an error.'
            : 'Not sent yet.';
  const sendDisabled = configBlocked || folderBusy;
  const count = queued.attachments.length;

  // The host answers a successful edit with a prefill-composer event; nothing is written here, so a
  // message the host is already sending cannot end up both sent and in the composer.
  // The host sends back only the text: the composer goes back to the mode the message was queued in,
  // so that sending it again is the same instruction and not whatever mode was picked since.
  const edit = () => {
    if (storedMode !== undefined) {
      if (queued.mode === storedMode) ui.clearSendMode(conversationId);
      else chooseConversationMode(ui, post, conversationId, storedMode, running, queued.mode);
    }
    post({ type: 'queue.edit', conversationId });
  };

  return (
    <section ref={root} tabIndex={-1} className="queued-message" aria-label="Queued message">
      <div className="queued-head">
        <Icon name="clock" />
        <span className="queued-label">Queued</span>
        <span>{MODE_LABEL[queued.mode]}</span>
        {count > 0 && <span>{count === 1 ? '1 attachment' : `${String(count)} attachments`}</span>}
      </div>
      <p
        ref={textBox}
        className="queued-text"
        {...(scrolls ? { tabIndex: 0, role: 'group', 'aria-label': 'Queued message text' } : {})}
      >
        {queued.text}
      </p>
      <p className="queued-status" id={statusId} role="status">
        {status}
      </p>
      <div className="queued-actions">
        <button
          type="button"
          className="button button--secondary"
          aria-label="Edit queued message"
          onClick={edit}
        >
          <Icon name="edit" />
          <span>Edit</span>
        </button>
        <button
          type="button"
          className="button button--secondary"
          aria-label="Remove queued message"
          onClick={() => {
            post({ type: 'queue.remove', conversationId });
          }}
        >
          <Icon name="trash" />
          <span>Remove</span>
        </button>
        <button
          type="button"
          className="button"
          aria-label={running ? 'Send now, queued message' : 'Send queued message'}
          disabled={sendDisabled}
          aria-describedby={sendDisabled ? statusId : undefined}
          onClick={() => {
            post({ type: 'queue.sendNow', conversationId });
          }}
        >
          <Icon name="send" />
          <span>{running ? 'Send now' : 'Send'}</span>
        </button>
      </div>
    </section>
  );
}
