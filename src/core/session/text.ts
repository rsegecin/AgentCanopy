import type { ErrorCategory, ResultEvent } from '../../shared';
import { escapeForDisplay } from '../policy/readonly';

/** Plain-language sentences the controller shows to the user. Kept in one place so they are easy to review. */

export const TEXT = {
  notAvailableYet: 'This is not available yet.',
  untrusted:
    'This workspace is not trusted, so AgentCanopy will not run agents here. Your conversation history stays readable.',
  untrustedRefusal: 'This workspace is not trusted, so AgentCanopy will not run agents here.',
  noFolder: 'Open a folder to start a conversation.',
  noStorage: 'AgentCanopy could not open its storage for this workspace.',
  noProvider: 'No agent provider is available.',
  checkingProvider: 'AgentCanopy is still checking Claude Code. Try again in a moment.',
  turnRunning: 'A turn is already running in this conversation.',
  messageAlreadyQueued: 'A message is already waiting for this turn. Edit or remove it first.',
  conversationGone: 'That conversation no longer exists.',
  conversationFolderClosed:
    'This conversation belongs to a folder that is not open in this window.',
  waitForTurn: 'Wait for the current turn to finish before changing this.',
  handlerFailed: 'Something went wrong. The AgentCanopy log has the details.',
  turnFailed: 'AgentCanopy could not complete this turn.',
  noResult: 'Claude Code ended without finishing the turn.',
  closedWhileRunning: 'AgentCanopy was closed while this turn was running.',
  guardFailed: 'AgentCanopy could not check this turn and stopped it.',
  sessionLost:
    'Claude Code no longer has this session, so the conversation continues with its visible messages as context.',
  policyFailed: 'AgentCanopy could not decide on this request.',
  pathOutside: 'AgentCanopy only opens files inside the workspace folders.',
  pathNotInFolder: 'That path is not inside the workspace folder.',
  turnEnded: 'The turn has already ended.',
  noPlanSaved:
    'No plan was saved in this turn. Ask for the plan again, or switch to Ask mode if you only wanted an answer.',
  planGone: 'That plan no longer exists.',
  planVersionGone: 'That version of the plan no longer exists.',
  planChanged: 'The plan changed since it was shown. Review the current version and approve again.',
  decisionFailed:
    'That answer could not be saved. The plan may have changed; review it and try again.',
  revertFailed: 'That version of the plan could not be restored.',
  configChangeGone: 'That configuration change was already resolved.',
  configTextsGone: "This file's content was not kept, so it cannot be shown.",
  unsavedInEditor: 'Save or discard your unsaved changes in this file first.',
  changedSinceAgent: 'This file changed after the agent edited it, so it could not be rejected.',
  nothingToReject: 'There is nothing to reject.',
  exactForkUnavailable:
    'An exact copy of the conversation at an earlier message is turned off or not supported, so this branch continues from its visible messages as context.',
  branchWhileRunning: 'Wait for the turn to finish before branching from its last message.',
  filesNewerThanBranch:
    'The files in the workspace include changes made after this point in the conversation. Branching does not change files; use the checkpoint history to restore them.',
  checkpointNotText: 'This file cannot be shown as text.',
  previewStale: 'That preview is out of date. Preview the checkpoint again.',
  restoredWithoutBranch:
    'The files were restored. The conversation of that checkpoint no longer exists, so no branch was created.',
  notSelectable: 'One of the chosen files cannot be restored from this preview.',
  waitBeforeAccepting: 'Wait for the turn to finish before accepting changes.',
  ruleNotSaved:
    'The command was allowed this once, but the rule to always allow it could not be saved.',
  storedDataDeleted: 'Stored file contents and change history were deleted.',
  projectConfigIgnored:
    "The project's own Claude Code settings are ignored. Use the command \u201cAsk Again About This Folder's Claude Code Project Settings\u201d to change this.",
  projectConfigReset: 'AgentCanopy will ask again before the next turn.',
  linkRefused: 'AgentCanopy only opens web and email links.',
  noSelection: 'There is no selection to add.',
  noDiagnostics: 'There are no problems to add.',
  attachmentLimit: 'You can attach at most 50 items to a message.',
  imageInvalid: 'The pasted image could not be read. Paste a PNG, JPEG, GIF or WebP image.',
  imageTooLarge: 'The pasted image is larger than 5 MB.',
  imagesTooLarge: 'Images in one message can be at most 5 MB together.',
  imageLimit: 'A message can have at most 5 images.',
  imageGone: 'An attached image was no longer available and was left out.',
  earlierImagesLost:
    'Claude Code no longer has the earlier images of this conversation: only their mention was carried into the new session.',
  branchFailed: 'A branch could not be created from that message.',
  openFailed: 'That conversation could not be opened.',
  renameFailed: 'That conversation could not be renamed.',
} as const;

export function claudeNotInstalled(displayName: string): string {
  return `${displayName} is not installed. Install it, or set its path in the AgentCanopy settings.`;
}

export function claudeTooOld(displayName: string): string {
  return `${displayName} needs to be updated before AgentCanopy can use it.`;
}

export function claudeSignedOut(displayName: string): string {
  return `${displayName} is not signed in. Use Sign in to open a terminal and run its login.`;
}

export function modeUnavailable(mode: string): string {
  return `${mode.charAt(0).toUpperCase()}${mode.slice(1)} mode is not available yet.`;
}

const MAX_PROVIDER_TEXT = 300;

function firstLine(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return line.length > MAX_PROVIDER_TEXT ? `${line.slice(0, MAX_PROVIDER_TEXT - 1)}…` : line;
}

/** The sentence for a failure category. `providerMessage` is used only for categories without a fixed sentence. */
export function errorSentence(
  category: ErrorCategory | undefined,
  model: string,
  providerMessage: string,
): string {
  switch (category) {
    case 'authentication':
      return 'Claude Code is no longer signed in. Sign in and send the message again.';
    case 'rate-limit':
      return "Claude Code's usage limit was reached. Try again later.";
    case 'overloaded':
      return 'Claude Code is overloaded right now. Try again in a moment.';
    case 'model-not-found':
      return `Claude Code does not know the model "${model}".`;
    case 'billing':
      return 'Claude Code reports a billing problem with your account. Check your plan or credits, then try again.';
    case 'startup':
      return 'Claude Code could not be started. Check that it is installed and signed in, then try again.';
    case 'process-crash':
      return 'Claude Code stopped unexpectedly.';
    case 'protocol':
      return 'Claude Code sent output AgentCanopy could not read.';
    case 'session-not-found':
      return 'Claude Code no longer has this session.';
    default: {
      const line = firstLine(providerMessage);
      return line.length > 0 ? line : 'Claude Code reported an error.';
    }
  }
}

/** The sentence stored on a turn that ended with an error or a limit result. */
export function resultSentence(event: ResultEvent, model: string): string {
  if (event.outcome === 'limit') {
    return 'Claude Code stopped because it reached a limit. Send another message to continue.';
  }
  return errorSentence(event.category, model, event.text);
}

/** "3:05 PM" for a time today, otherwise with the date. */
export function formatResetTime(resetsAtMs: number, nowMs: number): string {
  const at = new Date(resetsAtMs);
  if (at.toDateString() === new Date(nowMs).toDateString()) {
    return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "Nov 11, 3:05 PM": the time a checkpoint was made. */
export function formatCheckpointTime(atMs: number): string {
  return new Date(atMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Text from the model or the workspace (a title, a path, a command) for a native dialog: line breaks
 * become spaces, and control and direction-changing characters are written out, so it cannot hide
 * the end of a name or look like part of the dialog's own wording.
 */
export function safeText(text: string): string {
  return escapeForDisplay(text.replace(/[\r\n\u2028\u2029]+/g, ' '));
}
