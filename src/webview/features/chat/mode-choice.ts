import type { ConversationId, Mode, WebviewMessage } from '../../../shared';
import type { UiState } from '../../app/ui-state';

/**
 * Makes `next` the mode of the next send in an open conversation. The host refuses to change the
 * conversation's mode under a running turn, so then the choice stays in the view (`sendMode`) and
 * `turn.send` carries it; when no turn runs the host is asked, and the view-local choice is dropped.
 */
export function chooseConversationMode(
  ui: UiState,
  post: (message: WebviewMessage) => void,
  conversationId: ConversationId,
  storedMode: Mode,
  running: boolean,
  next: Mode,
): void {
  if (running) {
    if (next === storedMode) ui.clearSendMode(conversationId);
    else ui.setSendMode(conversationId, next);
    return;
  }
  post({ type: 'conversation.setMode', conversationId, mode: next });
  ui.clearSendMode(conversationId);
}
