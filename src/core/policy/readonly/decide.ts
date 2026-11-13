import { z } from 'zod';
import { QuestionSchema, type PermissionPrompt, type PromptAnswer } from '../../../shared';
import type {
  Logger,
  NewPrompt,
  PermissionRequest,
  PolicyContext,
  PolicyDecision,
} from '../../contracts';
import { escapeForDisplay } from './escape';
import { PLAN_TOOL_NAME } from './tools';
import { checkPath, checkPattern, type TargetCheck } from './targets';

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

/** What the user chose on a permission prompt that offers allow-once and deny. */
function fromPermissionAnswer(answer: PromptAnswer | undefined): Decision {
  if (answer?.kind !== 'permission') return deny('The user did not answer.');
  if (answer.choice === 'allow-once') return { response: { behavior: 'allow' }, approval: 'user' };
  const feedback = answer.feedback?.trim();
  return {
    response: {
      behavior: 'deny',
      message: feedback !== undefined && feedback !== '' ? feedback : 'The user declined.',
    },
    approval: 'user',
  };
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

export async function decideRead(
  request: PermissionRequest,
  context: PolicyContext,
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
  let outside: TargetCheck | undefined = pathCheck?.inside === false ? pathCheck : undefined;
  if (typeof patternValue === 'string') {
    // A pattern is relative to the tool's own path when one was given.
    const base = pathCheck?.real ?? folderPath;
    const patternCheck = await checkPattern(patternValue, base, folderPath);
    // One prompt, showing the pattern when both leave the folder.
    if (!patternCheck.inside) outside = patternCheck;
  }
  if (outside === undefined) return { response: { behavior: 'allow' }, approval: 'policy' };

  const search = toolName !== 'Read';
  const prompt: NewPrompt = {
    kind: 'permission',
    toolCallId: request.toolCallId,
    toolName,
    category: 'read-outside',
    title: search ? 'Search outside the workspace' : 'Read a file outside the workspace',
    detail: escapeForDisplay(outside.shown),
    inputPreview: previewOf(input),
    choices: ['allow-once', 'deny'] satisfies PermissionPrompt['choices'],
  };
  return fromPermissionAnswer(await context.askUser(prompt));
}

async function decideWeb(request: PermissionRequest, context: PolicyContext): Promise<Decision> {
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
  return fromPermissionAnswer(await context.askUser(prompt));
}

/**
 * Default deny. Only the read tools, the web tools (when the setting is on) and questions to the user
 * can pass; nothing the user clicks can make a read-only mode write.
 */
export async function decideReadOnly(
  request: PermissionRequest,
  context: PolicyContext,
  logger: Logger,
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
        return await decideRead(request, context);
      case 'WebFetch':
      case 'WebSearch':
        return await decideWeb(request, context);
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
