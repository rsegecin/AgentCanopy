import { homedir } from 'node:os';
import type { ErrorCategory, ResultEvent } from '../../shared';
import { escapeForDisplay, escapeOneLine } from '../policy/readonly';

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
  queuedImagesFull:
    'Too many images are waiting in queued messages. Send or remove a queued message first.',
  asideRunning: 'A side question is already running. Wait for it or stop it.',
  asideFailed: 'The side question could not be started.',
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
  autoNotOffered: 'Auto is turned off in the settings (agentCanopy.agent.auto.enabled).',
  autoWaitForTurn: 'Wait for the current turn to finish before turning on Auto.',
  autoDialogOpen: 'The dialog to turn on Auto is already open.',
  autoDraftGone: 'Auto can be turned on for a new conversation only before its first message.',
  autoNotShown: 'Open the conversation to turn Auto on.',
  autoChangedDuringDialog:
    'Auto was not turned on: the conversation changed while the dialog was open.',
  autoNotSaved: 'Auto could not be turned on. The AgentCanopy log has the details.',
  autoOffNotSaved:
    'Auto is off for now, but that could not be saved: after a reload it may be on again. Turn it off again later.',
  autoResetNotSaved:
    'Auto is off in this window, but that could not be saved for other workspaces on this machine. AgentCanopy will try again.',
  permissionNotSaved:
    'It was allowed this once, but the permission to always allow it could not be saved.',
  permissionNotRemoved: 'The permission could not be removed.',
  switchNotChanged: 'The switch could not be changed.',
  permissionDialogOpen: 'A permissions dialog is already open.',
  permissionChangedDuringDialog:
    'The folder or the trust of the workspace changed while the dialog was open, so nothing was changed.',
  /** Why a folder picked in the Permissions view cannot be saved, by the policy's reason. */
  directoryRefusal: {
    'not-a-directory': 'That folder could not be read.',
    'inside-folder': 'That folder is inside the workspace folder, where reads never ask.',
    sensitive:
      "That folder is a credential location, AgentCanopy's own storage or on a network share. Reads there always ask.",
    protected:
      'That folder is in a protected location (such as .git, .vscode or .claude). Edits there always ask.',
    'too-broad':
      'That folder is too broad to allow: a drive or filesystem root, your home folder, or a folder that holds it or a credential location.',
    covered: 'That folder is already inside a saved folder.',
  },
  /** Why a folder picked for edits in the Permissions view cannot be saved, by the policy's reason. */
  editDirectoryRefusal: {
    'not-a-directory': 'That folder could not be read.',
    'inside-folder':
      'That folder is inside the workspace folder, where edits are reviewed and need no saved folder.',
    sensitive:
      "That folder is a credential location, AgentCanopy's own storage or on a network share. Edits there always ask.",
    protected:
      'That folder is in a protected location (such as .git, .vscode or .claude). Edits there always ask.',
    'too-broad':
      'That folder is too broad to allow: a drive or filesystem root, your home folder, or a folder that holds it or a credential location.',
    covered: 'That folder is already inside a folder saved for edits.',
  },
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

/** The user's home directory, or '' when it cannot be told. */
export function homeDirectory(): string {
  try {
    return homedir();
  } catch {
    return '';
  }
}

/** How many code points of a folder's path the dialog that turns Auto on shows at most. */
const SHOWN_PATH_LENGTH = 120;
/** A longer path is cut in the middle: this many code points of its start, then `…`, then the rest. */
const SHOWN_PATH_HEAD = 40;
const SHOWN_PATH_TAIL = SHOWN_PATH_LENGTH - SHOWN_PATH_HEAD - 1;

/** A drive letter and a separator: a Windows path, whose letter case does not matter. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** The part of `path` that follows `home` when `home` is its directory at a path boundary. */
function belowHome(path: string, home: string): string | undefined {
  const windows = DRIVE_PATH.test(home);
  const same = (a: string, b: string): boolean =>
    windows ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(path.slice(0, home.length), home)) return undefined;
  const rest = path.slice(home.length);
  return rest === '' || rest.startsWith('/') || rest.startsWith('\\') ? rest : undefined;
}

/**
 * A folder's path as a dialog shows it, before it is escaped: the user's home directory as `~`
 * (without regard to the case of a drive letter), and a path longer than 120 code points cut in the
 * middle with an ellipsis, so that both its root and its end stay visible.
 */
export function shownPath(path: string, home: string): string {
  let shown = path;
  // A home that is only a root (`/`, `C:\`) says nothing, so it is not shown as `~`.
  if (home.length > 0 && home !== '/' && home !== '\\' && !/^[A-Za-z]:[\\/]?$/.test(home)) {
    const rest = belowHome(path, home);
    if (rest !== undefined) shown = `~${rest}`;
  }
  const chars = Array.from(shown);
  return chars.length > SHOWN_PATH_LENGTH
    ? `${chars.slice(0, SHOWN_PATH_HEAD).join('')}…${chars.slice(chars.length - SHOWN_PATH_TAIL).join('')}`
    : shown;
}

/**
 * Text from the workspace or the webview (a path, a title) for one line of a native dialog: line
 * breaks, tabs, control and direction-changing characters are written out rather than dropped, so it
 * cannot add a line and two texts that differ only by such a character show differently.
 */
export function oneLineText(text: string): string {
  return escapeOneLine(text);
}

/**
 * Text from the model or the workspace (a title, a path, a command) for a native dialog: line breaks
 * become spaces, and control and direction-changing characters are written out, so it cannot hide
 * the end of a name or look like part of the dialog's own wording.
 */
export function safeText(text: string): string {
  return escapeForDisplay(text.replace(/[\r\n\u2028\u2029]+/g, ' '));
}
