import type { PermissionSwitch, Prompt, PromptAnswer } from '../../shared';
import type { NewPrompt } from '../contracts';
import { sha256Hex } from '../util';
import { homeDirectory, oneLineText, safeText, shownPath } from './text';

/** JSON with object keys in sorted order, so equal values always give equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`);
    }
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Hash of the fields the user sees. An answer must echo it. */
export function displayHashOf(prompt: NewPrompt): string {
  if (prompt.kind === 'permission') {
    return sha256Hex(
      canonicalJson({
        kind: prompt.kind,
        toolName: prompt.toolName,
        category: prompt.category,
        title: prompt.title,
        detail: prompt.detail,
        inputPreview: prompt.inputPreview,
        choices: prompt.choices,
        alwaysRule: prompt.alwaysRule,
      }),
    );
  }
  return sha256Hex(canonicalJson({ kind: prompt.kind, questions: prompt.questions }));
}

/** A prompt that is waiting for an answer. The turn that asked owns it. */
export interface PendingPrompt {
  readonly prompt: Prompt;
  /** True while a native confirmation for "allow always" is open; no other answer is accepted then. */
  answering: boolean;
  settled: boolean;
  /** Ends the prompt: updates and persists its state, then resolves the waiting policy. */
  settle(state: 'answered' | 'expired' | 'cancelled', answer?: PromptAnswer): void;
}

/** Why an answer cannot be accepted, or undefined when it can. The text is for the log only. */
export function answerProblem(
  entry: PendingPrompt,
  displayHash: string,
  answer: PromptAnswer,
): string | undefined {
  const { prompt } = entry;
  if (entry.settled) return 'the prompt is not pending';
  if (entry.answering) return 'another answer is being confirmed';
  if (displayHash !== prompt.displayHash) return 'the display hash does not match';
  if (answer.kind !== prompt.kind) return 'the answer is of a different kind';
  if (prompt.kind === 'permission' && answer.kind === 'permission') {
    if (!prompt.choices.includes(answer.choice)) return 'the choice is not offered';
  }
  if (prompt.kind === 'question' && answer.kind === 'question') {
    const known = new Set(prompt.questions.map((question) => question.question));
    const keys = Object.keys(answer.answers);
    if (keys.length === 0) return 'no question was answered';
    if (keys.some((key) => !known.has(key))) return 'the answer names an unknown question';
  }
  return undefined;
}

const PROJECT_CODE_SENTENCE =
  'This command runs code from the project, which can do anything you can do.';

/** The workspace folder's path as the dialogs show it: on one line, home as `~`, cut in the middle. */
function folderLine(folderPath: string): string {
  return oneLineText(shownPath(folderPath, homeDirectory()));
}

/** The text for a directory that is allowed to be read: the card's dialog and the Permissions view's. */
export function directoryDetail(dir: string, folderPath: string): string {
  return [
    `Directory: ${oneLineText(dir)}\nWorkspace folder: ${folderLine(folderPath)}`,
    'Reads and searches in this directory and below will no longer ask, in Ask, Plan and Agent mode, for this workspace folder. What is read is sent to the model.',
    'You can remove this under Permissions.',
  ].join('\n\n');
}

/** The text for a site that is allowed to be fetched, from the card. */
export function siteDetail(host: string, folderPath: string): string {
  return [
    `Site: ${oneLineText(host)}\nWorkspace folder: ${folderLine(folderPath)}`,
    'Any address on this site will be fetched without asking, for this workspace folder. An address can carry file contents to the site. A redirect to another site is reported to the agent, and its next request is judged on its own.',
    'You can remove this under Permissions.',
  ].join('\n\n');
}

/** What the dialog that adds a folder in the Permissions view says and what it is called. */
export function directoryDialog(
  dir: string,
  folderPath: string,
): { title: string; detail: string; confirmLabel: string } {
  return {
    title: 'Always allow reads in this folder?',
    detail: directoryDetail(dir, folderPath),
    confirmLabel: 'Always allow',
  };
}

const WEB_TOOLS_NOTE =
  'In Ask and Plan mode this applies only while agentCanopy.ask.webTools is on.';

const SWITCH_BODY: Record<PermissionSwitch, { title: string; paragraphs: string[] }> = {
  'read-outside': {
    title: 'Allow reads outside the folder without asking?',
    paragraphs: [
      'In this workspace folder the agent will read and search files anywhere on this machine without asking, in Ask, Plan and Agent mode. What it reads is sent to the model.',
      "Credential locations (except Claude Code's own memory for this folder) and AgentCanopy's own storage still ask. Edits outside the folder still ask.",
    ],
  },
  'web-fetch': {
    title: 'Allow web fetches without asking?',
    paragraphs: [
      'In this workspace folder any web address will be fetched without asking. A page can carry instructions for the agent, and an address can carry file contents out.',
      WEB_TOOLS_NOTE,
    ],
  },
  'web-search': {
    title: 'Allow web searches without asking?',
    paragraphs: [
      'In this workspace folder every web search will run without asking. The query leaves this machine.',
      WEB_TOOLS_NOTE,
    ],
  },
};

/** The dialog that turns a switch on: what it lets through for the workspace folder, and how to undo it. */
export function switchDialog(
  name: PermissionSwitch,
  folderPath: string,
): { title: string; detail: string; confirmLabel: string } {
  const body = SWITCH_BODY[name];
  return {
    title: body.title,
    detail: [
      `Workspace folder: ${folderLine(folderPath)}`,
      ...body.paragraphs,
      'You can turn this off under Permissions.',
    ].join('\n\n'),
    confirmLabel: 'Allow',
  };
}

/**
 * The text of the native confirmation shown before an "allow always" answer takes effect. For a
 * directory or a site it names the workspace folder (`folderPath`) and shows the directory or host in
 * full; for a command or tool it is the rule.
 */
export function alwaysAllowDetail(prompt: Prompt, folderPath?: string): string {
  if (prompt.kind !== 'permission') return '';
  const rule = prompt.alwaysRule;
  if (rule === undefined) return prompt.detail;
  if (rule.kind === 'read-directory') return directoryDetail(rule.rule, folderPath ?? '');
  if (rule.kind === 'web-site') return siteDetail(rule.rule, folderPath ?? '');
  const shown = safeText(rule.rule);
  return rule.runsProjectCode ? `${shown}\n\n${PROJECT_CODE_SENTENCE}` : shown;
}
