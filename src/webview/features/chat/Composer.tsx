import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ClipboardEvent, KeyboardEvent } from 'react';
import { ImageMediaTypeSchema, MAX_IMAGE_BYTES, MODES } from '../../../shared';
import type { Mode, ProviderStatus } from '../../../shared';
import { Icon, IconButton } from '../../app/components';
import { useApp, usePost } from '../../app/context';
import { useFocusRecovery } from '../../app/focus';
import { useViewState } from '../../app/store';
import { NEW_CONVERSATION_KEY, useUi } from '../../app/ui-state';
import { LOCK_HINT } from '../plan/lock-hint';
import { AttachmentChip } from './AttachmentChip';
import { pastedImage, toBase64 } from './paste-image';
import { ReferencePicker, useReferencePicker } from './reference-picker';

const MODE_INFO: Record<Mode, { label: string; description: string }> = {
  ask: { label: 'Ask', description: 'Read-only. Ask about your code; nothing is changed.' },
  plan: { label: 'Plan', description: 'Read-only. Build a plan to review before any change.' },
  agent: { label: 'Agent', description: 'Can edit files and run tools, with your approval.' },
};

const MAX_DRAFT = 200_000;

interface Blocker {
  message: string;
  details: string[];
  signIn: boolean;
}

/** Why the composer cannot send right now, or null when it can. */
function findBlocker(
  trusted: boolean,
  folderCount: number,
  provider: ProviderStatus | null,
): Blocker | null {
  if (!trusted) {
    return {
      message:
        'This workspace is not trusted, so agents are turned off. Trust the workspace to send messages.',
      details: [],
      signIn: false,
    };
  }
  if (folderCount === 0) {
    return { message: 'Open a folder to start a conversation.', details: [], signIn: false };
  }
  if (provider === null) {
    return { message: 'Checking the provider…', details: [], signIn: false };
  }
  const name = provider.displayName;
  if (!provider.installed) {
    return { message: `${name} is not installed.`, details: provider.problems, signIn: false };
  }
  if (!provider.meetsMinimum) {
    const found = provider.version ? ` ${provider.version}` : '';
    return {
      message: `${name}${found} is older than the minimum supported version ${provider.minimumVersion}. Update it to continue.`,
      details: provider.problems,
      signIn: false,
    };
  }
  if (provider.auth === 'signed-out') {
    return {
      message: `You are signed out of ${name}. Sign in to send messages.`,
      details: provider.problems,
      signIn: true,
    };
  }
  return null;
}

export function Composer() {
  const { ui, store } = useApp();
  const post = usePost();
  const trusted = useViewState((s) => s.trusted);
  const folderCount = useViewState((s) => s.folders.length);
  const provider = useViewState((s) => s.provider);
  const models = useViewState((s) => s.models);
  const defaults = useViewState((s) => s.defaults);
  const meta = useViewState((s) => s.active?.meta);
  const attachments = useViewState((s) => s.draftAttachments);
  const hasPlan = useViewState((s) => s.active?.plan != null);
  const hasPendingPrompt = useViewState(
    (s) => s.active?.prompts.some((p) => p.state === 'pending') ?? false,
  );
  const turns = useViewState((s) => s.active?.turns);

  const conversationId = meta?.id;
  const draftKey = conversationId ?? NEW_CONVERSATION_KEY;
  const draft = useUi((s) => s.drafts[draftKey] ?? '');
  const newMode = useUi((s) => s.newMode);
  const newModel = useUi((s) => s.newModel);

  const lastTurn = turns?.[turns.length - 1];
  const running = lastTurn?.status === 'running' || lastTurn?.status === 'preparing';
  const blocker = findBlocker(trusted, folderCount, provider);

  const mode: Mode = meta?.mode ?? newMode ?? defaults.mode;
  const model = meta?.model ?? newModel ?? defaults.model;
  const modelOptions = models.some((m) => m.id === model)
    ? models
    : [...models, { id: model, label: model, custom: true }];

  const textarea = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  // Send turns into Stop (and back) while the focused button is replaced: keep focus in the composer.
  useFocusRecovery(form, { fallback: 'textarea' });
  const stopButton = useRef<HTMLButtonElement>(null);
  const radioName = useId();
  const noticeId = useId();

  const picker = useReferencePicker({
    draft,
    draftKey,
    setDraft: (text) => {
      ui.setDraft(draftKey, text);
    },
    textarea,
  });

  // Grow with the content, up to the CSS max-height (about 12 lines).
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${String(el.scrollHeight)}px`;
  }, [draft]);

  useEffect(() => {
    return store.onEvent((event) => {
      if (event.kind === 'focus-composer') textarea.current?.focus();
      else if (event.kind === 'prefill-composer') {
        ui.setDraft(draftKey, event.text);
        textarea.current?.focus();
      }
    });
  }, [store, ui, draftKey]);

  // Images being read from a paste. Send waits for them, so the message does not leave without its image.
  const [pendingPastes, setPendingPastes] = useState(0);
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = pastedImage(event.clipboardData);
    const mediaType = ImageMediaTypeSchema.safeParse(file?.type);
    if (!file || !mediaType.success) return;
    event.preventDefault();
    if (file.size > MAX_IMAGE_BYTES) {
      setPasteProblem('The image is larger than 5 MB.');
      return;
    }
    setPendingPastes((n) => n + 1);
    void (async () => {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        post({ type: 'context.pasteImage', mediaType: mediaType.data, data: toBase64(bytes) });
        setPasteProblem(null);
      } catch {
        setPasteProblem('The image could not be read.');
      } finally {
        setPendingPastes((n) => n - 1);
      }
    })();
  };

  const send = () => {
    const text = draft.trim();
    if (blocker !== null || running || text === '' || pendingPastes > 0) return;
    setPasteProblem(null);
    post({
      type: 'turn.send',
      ...(conversationId !== undefined ? { conversationId } : {}),
      text,
      mode,
      model: model === '' ? 'default' : model,
    });
    ui.setDraft(draftKey, '');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker.onKeyDown(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape' && running) {
      event.preventDefault();
      stopButton.current?.focus();
    }
  };

  const changeMode = (next: Mode) => {
    if (conversationId !== undefined) {
      post({ type: 'conversation.setMode', conversationId, mode: next });
    } else ui.setNewMode(next);
  };

  const changeModel = (next: string) => {
    if (conversationId !== undefined) {
      post({ type: 'conversation.setModel', conversationId, model: next });
    } else ui.setNewModel(next);
  };

  const planLocked = meta?.planLocked === true;
  const planHint =
    mode === 'plan'
      ? planLocked
        ? 'The plan is locked. The agent can only answer questions about it.'
        : 'The agent may revise the plan.'
      : mode === 'ask'
        ? 'The plan is attached read-only.'
        : null;

  const contextTarget = conversationId !== undefined ? { conversationId } : {};
  const contextDisabled = blocker !== null;

  const imageWithoutText =
    draft.trim() === '' && attachments.some((attachment) => attachment.kind === 'image');
  const attachmentStatus =
    pasteProblem ?? (imageWithoutText ? 'Add a message to send with the image.' : null);

  return (
    <form
      ref={form}
      tabIndex={-1}
      className="composer"
      aria-label="Message composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="column">
        {blocker !== null && (
          <div className="composer-notice" id={noticeId} role="status">
            <Icon name="info" />
            <div>
              <p>{blocker.message}</p>
              {blocker.details.length > 0 && (
                <ul>
                  {blocker.details.map((detail, index) => (
                    <li key={index}>{detail}</li>
                  ))}
                </ul>
              )}
              {blocker.signIn && (
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    post({ type: 'provider.signIn' });
                  }}
                >
                  Sign in
                </button>
              )}
            </div>
          </div>
        )}

        {hasPendingPrompt && (
          <p className="composer-note">
            <Icon name="comment-discussion" />
            <span>The agent is waiting for your answer above.</span>
          </p>
        )}

        {attachmentStatus !== null && (
          <p className="composer-note">
            <Icon name="info" />
            <span role="status">{attachmentStatus}</span>
          </p>
        )}

        {attachments.length > 0 && (
          <ul className="chips" aria-label="Attached context">
            {attachments.map((attachment, index) => (
              <AttachmentChip
                key={
                  attachment.kind === 'image'
                    ? `image:${attachment.id}:${String(index)}`
                    : `${attachment.kind}:${attachment.path}:${String(index)}`
                }
                attachment={attachment}
                onRemove={() => {
                  post({ type: 'context.remove', ...contextTarget, attachment });
                }}
              />
            ))}
          </ul>
        )}

        <div className="composer-input-wrap">
          {picker.view && <ReferencePicker {...picker.view} />}
          <textarea
            ref={textarea}
            className="composer-input"
            rows={2}
            aria-label="Message"
            aria-describedby={blocker !== null ? noticeId : undefined}
            {...picker.inputProps}
            placeholder={running ? 'The agent is working. Type your next message…' : 'Message'}
            maxLength={MAX_DRAFT}
            disabled={blocker !== null}
            value={draft}
            onChange={(event) => {
              ui.setDraft(draftKey, event.target.value);
              picker.onTextChange(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onKeyUp={(event) => {
              picker.onCaretMove(event.currentTarget.selectionStart);
            }}
            onClick={(event) => {
              picker.onCaretMove(event.currentTarget.selectionStart);
            }}
            onSelect={(event) => {
              picker.onCaretMove(event.currentTarget.selectionStart);
            }}
            onBlur={picker.onBlur}
          />
        </div>

        <div className="composer-modes">
          <div className="segmented" role="radiogroup" aria-label="Mode">
            {MODES.map((value) => (
              <label key={value} className="segmented-option">
                <input
                  type="radio"
                  name={radioName}
                  value={value}
                  checked={mode === value}
                  aria-describedby={`${radioName}-${value}`}
                  onChange={() => {
                    changeMode(value);
                  }}
                />
                <span>{MODE_INFO[value].label}</span>
              </label>
            ))}
          </div>
          {hasPlan && mode === 'plan' && conversationId !== undefined && (
            <button
              type="button"
              className={`button button--secondary plan-lock${planLocked ? ' plan-lock--on' : ''}`}
              aria-pressed={planLocked}
              title={LOCK_HINT}
              onClick={() => {
                post({ type: 'plan.setLocked', conversationId, locked: !planLocked });
              }}
            >
              <Icon name={planLocked ? 'lock' : 'unlock'} />
              <span>Lock plan</span>
            </button>
          )}
          {MODES.map((value) => (
            <span
              key={value}
              id={`${radioName}-${value}`}
              className="mode-description"
              hidden={mode !== value}
            >
              {MODE_INFO[value].description}
            </span>
          ))}
        </div>

        {hasPlan && planHint !== null && <p className="composer-hint muted">{planHint}</p>}

        <div className="composer-bar">
          <label className="select-label">
            <span className="visually-hidden">Model</span>
            <select
              value={model}
              onChange={(event) => {
                changeModel(event.target.value);
              }}
            >
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <div className="composer-context" role="group" aria-label="Add context">
            <IconButton
              icon="file-add"
              label="Add a file"
              disabled={contextDisabled}
              aria-describedby={contextDisabled ? noticeId : undefined}
              onClick={() => {
                post({ type: 'context.pick', ...contextTarget, what: 'file' });
              }}
            />
            <IconButton
              icon="new-folder"
              label="Add a folder"
              disabled={contextDisabled}
              aria-describedby={contextDisabled ? noticeId : undefined}
              onClick={() => {
                post({ type: 'context.pick', ...contextTarget, what: 'folder' });
              }}
            />
            <IconButton
              icon="selection"
              label="Add the editor selection"
              disabled={contextDisabled}
              aria-describedby={contextDisabled ? noticeId : undefined}
              onClick={() => {
                post({ type: 'context.addSelection', ...contextTarget });
              }}
            />
            <IconButton
              icon="warning"
              label="Add problems (diagnostics)"
              disabled={contextDisabled}
              aria-describedby={contextDisabled ? noticeId : undefined}
              onClick={() => {
                post({ type: 'context.addDiagnostics', ...contextTarget });
              }}
            />
          </div>

          {running && conversationId !== undefined ? (
            <button
              ref={stopButton}
              type="button"
              className="button button--stop"
              onClick={() => {
                post({ type: 'turn.cancel', conversationId });
              }}
            >
              <Icon name="debug-stop" />
              <span>Stop</span>
            </button>
          ) : (
            <button
              type="submit"
              className="button"
              disabled={blocker !== null || draft.trim() === '' || pendingPastes > 0}
              aria-describedby={blocker !== null ? noticeId : undefined}
            >
              <Icon name="send" />
              <span>Send</span>
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
