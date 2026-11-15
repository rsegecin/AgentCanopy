import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  QuestionSchema,
  type FolderKey,
  type PermissionPrompt,
  type PromptAnswer,
} from '../../../shared';
import type {
  Logger,
  NewPrompt,
  PermissionRequest,
  PolicyContext,
  PolicyDecision,
} from '../../contracts';
import type { PolicyAccess } from '../grants';
import {
  canGrantDirectory,
  containsSensitive,
  isSensitivePath,
  resolveSensitiveEnv,
  type SensitiveEnv,
} from '../grants/sensitive';
import { isValidGrant, type Grant } from '../grants/store';
import { fetchSite, webCovered } from '../grants/web';
import { escapeForDisplay } from './escape';
import { isInside } from './paths';
import { PLAN_TOOL_NAME } from './tools';
import { checkPath, checkPattern, splitPattern, type TargetCheck } from './targets';

/** The mode's name as it appears in messages. Only Ask and Plan run under this policy. */
function modeName(context: PolicyContext): string {
  return context.mode === 'plan' ? 'Plan' : 'Ask';
}

function readOnlyDenial(context: PolicyContext): string {
  return `This action is not allowed in ${modeName(context)} mode because the mode is read-only.`;
}

const MAX_PREVIEW_CHARS = 4000;
const QuestionsSchema = z.array(QuestionSchema).min(1).max(4);

type Decision = PolicyDecision;

export function deny(message: string): Decision {
  return { response: { behavior: 'deny', message }, approval: 'policy' };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The input as pretty JSON, escaped for display and cut to a fixed length. */
export function previewOf(input: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    json = undefined;
  }
  const text = escapeForDisplay(json ?? '(the input cannot be shown)');
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  let cut = text.slice(0, MAX_PREVIEW_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  // Do not end on half of a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

type Choice = PermissionPrompt['choices'][number];

function allowByUser(): Decision {
  return { response: { behavior: 'allow' }, approval: 'user' };
}

/** The user said no, with their reason when they gave one. */
function declined(answer: Extract<PromptAnswer, { kind: 'permission' }>): Decision {
  const feedback = answer.feedback?.trim();
  return {
    response: {
      behavior: 'deny',
      message: feedback !== undefined && feedback !== '' ? feedback : 'The user declined.',
    },
    approval: 'user',
  };
}

/** What the user chose on a permission prompt that offers allow-once and deny. */
function fromPermissionAnswer(answer: PromptAnswer | undefined): Decision {
  if (answer?.kind !== 'permission') return deny('The user did not answer.');
  if (answer.choice === 'allow-once') return allowByUser();
  return declined(answer);
}

/**
 * What the user chose on a prompt that may offer allow-always. A choice the prompt did not offer is
 * denied. `save` runs for allow-always; it must not throw (see `saveGrant`).
 */
async function fromOfferedAnswer(
  answer: PromptAnswer | undefined,
  offered: readonly Choice[],
  save: () => Promise<void>,
): Promise<Decision> {
  if (answer?.kind !== 'permission') return deny('The user did not answer.');
  if (!offered.includes(answer.choice)) {
    return deny('That answer was not one the prompt offered.');
  }
  if (answer.choice === 'deny') return declined(answer);
  if (answer.choice === 'allow-always') await save();
  return allowByUser();
}

/** Saves a grant the user chose. A failure is logged; the call they approved still goes ahead. */
export async function saveGrant(
  access: PolicyAccess,
  folder: FolderKey,
  grant: Grant,
): Promise<void> {
  try {
    await access.grants.add(folder, grant);
  } catch (error) {
    access.logger.warn('A saved permission could not be saved.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A target that lies outside the folder: a path, or a glob pattern (with the text as given). */
interface OutsideTarget {
  check: TargetCheck;
  pattern?: string;
}

/** `..` as a whole component of a glob, also inside braces, groups and alternatives. */
const PARENT_COMPONENT = /(^|[/\\{},()|!@+?*[\]])\.\.($|[/\\{},()|!@+?*[\]])/;

/**
 * An alternative in braces that starts at a root, at a drive or at the home folder. Braces are
 * expanded into separate patterns before anything is matched, so such an alternative can be a
 * pattern of its own that starts somewhere else.
 */
const ROOTED_ALTERNATIVE = /[{,]\s*(?:[/\\~]|[A-Za-z]:)/;

/**
 * The real path of an outside target when a switch or a saved directory may cover it, else
 * `undefined`: its real path is known, it is not sensitive and holds nothing sensitive, and, for a
 * pattern, the part after the literal prefix neither climbs out with `..` nor has an alternative that
 * starts somewhere else (`{a,/etc/*}`). That part is not analysed for where it points.
 */
function coverablePath(target: OutsideTarget, env: SensitiveEnv): string | undefined {
  const real = target.check.real;
  if (real === undefined) return undefined;
  if (isSensitivePath(real, env) || containsSensitive(real, env)) return undefined;
  if (target.pattern !== undefined) {
    const { rest } = splitPattern(target.pattern);
    if (PARENT_COMPONENT.test(rest) || ROOTED_ALTERNATIVE.test(rest)) return undefined;
  }
  return real;
}

async function directoryOf(real: string): Promise<string> {
  try {
    if ((await fs.stat(real)).isDirectory()) return real;
  } catch {
    // Not there (yet): its parent is what would be allowed.
  }
  return dirname(real);
}

/**
 * The one directory "Always allow" would save for these targets, or `undefined` when there is none
 * or it may not be granted. Each target gives itself when it is a directory, else its parent; of two
 * the one that holds the other.
 */
async function directoryToOffer(
  targets: readonly OutsideTarget[],
  env: SensitiveEnv,
): Promise<string | undefined> {
  const dirs: string[] = [];
  for (const target of targets) {
    const real = coverablePath(target, env);
    if (real === undefined) return undefined;
    dirs.push(await directoryOf(real));
  }
  let dir = dirs[0];
  for (const other of dirs.slice(1)) {
    if (dir === undefined) return undefined;
    if (isInside(dir, other)) continue;
    dir = isInside(other, dir) ? other : undefined;
  }
  if (dir === undefined || !canGrantDirectory(dir, env)) return undefined;
  return isValidGrant({ kind: 'read-directory', path: dir }) ? dir : undefined;
}

export async function decideQuestion(
  request: PermissionRequest,
  context: PolicyContext,
): Promise<Decision> {
  const parsed = QuestionsSchema.safeParse(request.input['questions']);
  if (!parsed.success) return deny('The question could not be shown.');
  const questions = parsed.data;
  const answer = await context.askUser({
    kind: 'question',
    toolCallId: request.toolCallId,
    questions,
  });
  if (answer?.kind !== 'question') return deny('The user did not answer.');
  const answers: Record<string, string> = {};
  for (const question of questions) {
    const values = answer.answers[question.question];
    if (values !== undefined) answers[question.question] = values.join(', ');
  }
  return {
    response: { behavior: 'allow', updatedInput: { ...request.input, answers } },
    approval: 'user',
  };
}

/**
 * Reads and searches. Inside the folder they pass. Outside, they ask, unless `access` is given and
 * every outside target is covered by the folder's `read-outside` switch or by a saved directory. What
 * is sensitive (credential locations, AgentCanopy's storage) is never covered and never offered.
 */
export async function decideRead(
  request: PermissionRequest,
  context: PolicyContext,
  access?: PolicyAccess,
): Promise<Decision> {
  const { toolName, input } = request;
  const folderPath = context.folder.path;
  const pathValue = input[toolName === 'Read' ? 'file_path' : 'path'];
  const patternValue = toolName === 'Glob' ? input['pattern'] : input['glob'];

  // Grep and Glob search the folder itself when they are given no path. Read needs one.
  if (pathValue === undefined ? toolName === 'Read' : typeof pathValue !== 'string') {
    return deny('The request could not be checked.');
  }
  // Glob needs a pattern; Grep's glob filter is checked only when it is a string.
  if (toolName === 'Glob' && typeof patternValue !== 'string') {
    return deny('The request could not be checked.');
  }

  const pathCheck =
    typeof pathValue === 'string' ? await checkPath(pathValue, folderPath, folderPath) : undefined;
  // Every target outside the folder, the pattern last. All of them must be covered to skip the prompt.
  const targets: OutsideTarget[] = [];
  if (pathCheck?.inside === false) targets.push({ check: pathCheck });
  if (typeof patternValue === 'string') {
    // A pattern is relative to the tool's own path when one was given.
    const base = pathCheck?.real ?? folderPath;
    const patternCheck = await checkPattern(patternValue, base, folderPath);
    if (!patternCheck.inside) targets.push({ check: patternCheck, pattern: patternValue });
  }
  // One prompt, showing the pattern when both leave the folder.
  const outside = targets[targets.length - 1];
  if (outside === undefined) return { response: { behavior: 'allow' }, approval: 'policy' };

  const search = toolName !== 'Read';
  const prompt: NewPrompt = {
    kind: 'permission',
    toolCallId: request.toolCallId,
    toolName,
    category: 'read-outside',
    title: search ? 'Search outside the workspace' : 'Read a file outside the workspace',
    detail: escapeForDisplay(outside.check.shown),
    inputPreview: previewOf(input),
    choices: ['allow-once', 'deny'] satisfies PermissionPrompt['choices'],
  };
  if (access === undefined) return fromPermissionAnswer(await context.askUser(prompt));

  const env = await resolveSensitiveEnv(access.sensitiveRoots);
  const dir = await directoryToOffer(targets, env);
  const folder = context.conversation.folder;

  // Read the store here, after the last await, and decide from it with nothing awaited in between: a
  // saved directory or a switch the user removed during the awaits above must not still approve.
  const stored = access.grants.get(folder);
  const covered = targets.every((target) => {
    const real = coverablePath(target, env);
    if (real === undefined) return false;
    if (stored.switches.includes('read-outside')) return true;
    return stored.grants.some(
      (grant) =>
        grant.kind === 'read-directory' &&
        canGrantDirectory(grant.path, env) &&
        isInside(grant.path, real),
    );
  });
  if (covered) return allowByUser();

  const choices: Choice[] =
    dir === undefined ? ['allow-once', 'deny'] : ['allow-once', 'allow-always', 'deny'];
  const offered: NewPrompt =
    dir === undefined
      ? prompt
      : {
          ...prompt,
          choices,
          alwaysRule: { kind: 'read-directory', rule: dir, runsProjectCode: false },
        };
  return fromOfferedAnswer(await context.askUser(offered), choices, async () => {
    if (dir !== undefined) await saveGrant(access, folder, { kind: 'read-directory', path: dir });
  });
}

async function decideWeb(
  request: PermissionRequest,
  context: PolicyContext,
  access?: PolicyAccess,
): Promise<Decision> {
  if (!context.settings.askWebTools) {
    return deny('Web access is turned off for Ask and Plan modes in the AgentCanopy settings.');
  }
  const fetchTool = request.toolName === 'WebFetch';
  const value = request.input[fetchTool ? 'url' : 'query'];
  if (typeof value !== 'string' || value === '') return deny('The request could not be checked.');
  const prompt: NewPrompt = {
    kind: 'permission',
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    category: 'network',
    title: fetchTool ? 'Fetch a web page' : 'Search the web',
    detail: escapeForDisplay(value),
    inputPreview: previewOf(request.input),
    choices: ['allow-once', 'deny'],
  };
  if (access === undefined) return fromPermissionAnswer(await context.askUser(prompt));

  const folder = context.conversation.folder;
  const site = fetchTool ? fetchSite(value) : undefined;
  // Read the store now and decide from it at once; nothing is awaited in between.
  if (webCovered(access.grants.get(folder), fetchTool, site)) return allowByUser();

  const choices: Choice[] =
    site === undefined ? ['allow-once', 'deny'] : ['allow-once', 'allow-always', 'deny'];
  const offered: NewPrompt =
    site === undefined
      ? prompt
      : {
          ...prompt,
          choices,
          alwaysRule: { kind: 'web-site', rule: site, runsProjectCode: false },
        };
  return fromOfferedAnswer(await context.askUser(offered), choices, async () => {
    if (site !== undefined) await saveGrant(access, folder, { kind: 'web-site', host: site });
  });
}

/**
 * Default deny. Only the read tools, the web tools (when the setting is on) and questions to the user
 * can pass; nothing the user clicks can make a read-only mode write.
 */
export async function decideReadOnly(
  request: PermissionRequest,
  context: PolicyContext,
  logger: Logger,
  access?: PolicyAccess,
): Promise<Decision> {
  try {
    if (!isRecord(request) || typeof request.toolName !== 'string' || !isRecord(request.input)) {
      return deny(readOnlyDenial(context));
    }
    switch (request.toolName) {
      case 'AskUserQuestion':
        return await decideQuestion(request, context);
      case 'Read':
      case 'Grep':
      case 'Glob':
        return await decideRead(request, context, access);
      case 'WebFetch':
      case 'WebSearch':
        return await decideWeb(request, context, access);
      case PLAN_TOOL_NAME:
        // Pre-allowed by rule, so it should never arrive here. Nothing approves it from here.
        return deny(
          'Plans are saved through the plan tool directly; this request was not expected.',
        );
      default:
        return deny(readOnlyDenial(context));
    }
  } catch (error) {
    logger.warn('The read-only policy could not decide on a request; it was denied.', {
      reason: error instanceof Error ? error.message : String(error),
    });
    return deny('AgentCanopy could not decide on this request, so it was not allowed.');
  }
}
