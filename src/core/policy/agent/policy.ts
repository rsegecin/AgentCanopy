import { promises as fs } from 'node:fs';
import { relative, sep } from 'node:path';
import type { FolderKey, PermissionPrompt, PromptAnswer } from '../../../shared';
import {
  HOST_SERVER_NAME,
  silentLogger,
  type Logger,
  type NewPrompt,
  type PermissionRequest,
  type PolicyContext,
  type PolicyDecision,
  type TurnPolicy,
} from '../../contracts';
import { decideQuestion, decideRead, deny, isRecord, previewOf } from '../readonly/decide';
import { escapeForDisplay } from '../readonly/escape';
import { sameFolder } from '../readonly/guard';
import { realFolderPath, checkPath } from '../readonly/targets';
import { exactCommandRule, runsProjectCode } from './commands';
import { isProtectedPath } from './protected';
import { isValidRule, type RuleStore } from './rules';

type Decision = PolicyDecision;
type Choice = PermissionPrompt['choices'][number];

const NOT_CHECKED = 'The request could not be checked.';
const OWN_TOOL_PREFIX = `mcp__${HOST_SERVER_NAME}__`;
const ASK_ALLOW: Choice[] = ['allow-once', 'deny'];

function allow(): Decision {
  return { response: { behavior: 'allow' }, approval: 'user' };
}

/** What the user answered, and whether they asked for an "always" rule. */
function interpret(
  answer: PromptAnswer | undefined,
  offered: readonly Choice[],
): { decision: Decision; always: boolean } {
  if (answer?.kind !== 'permission') {
    return { decision: deny('The user did not answer.'), always: false };
  }
  if (!offered.includes(answer.choice)) {
    return { decision: deny('That answer was not one the prompt offered.'), always: false };
  }
  if (answer.choice === 'deny') {
    const feedback = answer.feedback?.trim();
    const message =
      feedback !== undefined && feedback !== ''
        ? `The user declined: ${feedback}`
        : 'The user declined.';
    return {
      decision: { response: { behavior: 'deny', message }, approval: 'user' },
      always: false,
    };
  }
  return { decision: allow(), always: answer.choice === 'allow-always' };
}

function stringInput(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toRelative(root: string, real: string): string {
  return relative(root, real).split(sep).join('/');
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The policy of Agent mode. Edits inside the folder go through (and are reviewed afterwards) except
 * protected files; everything with side effects outside the folder, commands, network and external
 * tools ask the user. Nothing is approved silently except what the user chose "always" for.
 */
export function createAgentPolicy(options: { rules: RuleStore; logger?: Logger }): TurnPolicy {
  const { rules } = options;
  const logger = options.logger ?? silentLogger;

  /**
   * True when the rule is in the store for this folder right now. The provider only learns a new
   * rule on the next turn, so a call that repeats it within the turn is allowed from here; removing
   * the rule from the store ends that at once.
   */
  function isStored(folder: FolderKey, rule: string): boolean {
    return rules.list(folder).includes(rule);
  }

  async function ask(
    context: PolicyContext,
    prompt: NewPrompt,
    offered: readonly Choice[],
  ): Promise<{ decision: Decision; always: boolean }> {
    return interpret(await context.askUser(prompt), offered);
  }

  function permissionPrompt(
    request: PermissionRequest,
    fields: Pick<PermissionPrompt, 'category' | 'title' | 'detail' | 'choices'> &
      Partial<Pick<PermissionPrompt, 'alwaysRule'>>,
  ): NewPrompt {
    return {
      kind: 'permission',
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      inputPreview: previewOf(request.input),
      ...fields,
    };
  }

  async function decideEdit(request: PermissionRequest, context: PolicyContext): Promise<Decision> {
    const { toolName, input } = request;
    const value =
      toolName === 'NotebookEdit'
        ? (stringInput(input, 'notebook_path') ?? stringInput(input, 'file_path'))
        : stringInput(input, 'file_path');
    if (value === undefined) return deny(NOT_CHECKED);

    const folderPath = context.folder.path;
    const target = await checkPath(value, folderPath, folderPath);
    if (!target.inside || target.real === undefined) {
      const prompt = permissionPrompt(request, {
        category: 'outside-workspace',
        title: 'Edit a file outside the workspace',
        detail: escapeForDisplay(target.shown),
        choices: ASK_ALLOW,
      });
      return (await ask(context, prompt, ASK_ALLOW)).decision;
    }

    const rel = toRelative(await realFolderPath(folderPath), target.real);
    if (isProtectedPath(rel)) {
      const prompt = permissionPrompt(request, {
        category: 'protected-path',
        title: 'Edit a protected file',
        detail: escapeForDisplay(rel),
        choices: ASK_ALLOW,
      });
      return (await ask(context, prompt, ASK_ALLOW)).decision;
    }
    if (context.settings.editApproval === 'auto') {
      return { response: { behavior: 'allow' }, approval: 'policy' };
    }
    const verb = toolName === 'Write' ? ((await exists(target.real)) ? 'Write' : 'Create') : 'Edit';
    const prompt = permissionPrompt(request, {
      category: 'edit',
      title: `${verb} ${escapeForDisplay(rel)}`,
      detail: escapeForDisplay(rel),
      choices: ASK_ALLOW,
    });
    return (await ask(context, prompt, ASK_ALLOW)).decision;
  }

  async function decideCommand(
    request: PermissionRequest,
    context: PolicyContext,
  ): Promise<Decision> {
    const command = stringInput(request.input, 'command');
    if (command === undefined) return deny(NOT_CHECKED);
    const folder = context.conversation.folder;
    const alwaysAsk = context.settings.alwaysAskCommands;
    // Only a Bash rule can be built; a PowerShell command always asks.
    const rule = request.toolName === 'Bash' && !alwaysAsk ? exactCommandRule(command) : undefined;

    if (rule !== undefined && isStored(folder, rule)) return allow();

    const choices: Choice[] =
      rule !== undefined && isValidRule(rule) ? ['allow-once', 'allow-always', 'deny'] : ASK_ALLOW;
    const prompt = permissionPrompt(request, {
      category: 'command',
      title: 'Run a terminal command',
      detail: escapeForDisplay(command),
      choices,
      ...(rule !== undefined && choices.includes('allow-always')
        ? { alwaysRule: { rule, runsProjectCode: runsProjectCode(command) } }
        : {}),
    });
    const { decision, always } = await ask(context, prompt, choices);
    if (always && rule !== undefined) await saveRule(folder, rule);
    return decision;
  }

  /** Saves a rule the user chose. A failure is logged; the call they approved still goes ahead. */
  async function saveRule(folder: FolderKey, rule: string): Promise<void> {
    try {
      await rules.add(folder, rule);
    } catch (error) {
      logger.warn('An always-allow rule could not be saved.', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function decideWeb(request: PermissionRequest, context: PolicyContext): Promise<Decision> {
    const fetchTool = request.toolName === 'WebFetch';
    const value = stringInput(request.input, fetchTool ? 'url' : 'query');
    if (value === undefined) return deny(NOT_CHECKED);
    const prompt = permissionPrompt(request, {
      category: 'network',
      title: fetchTool ? 'Fetch a web page' : 'Search the web',
      detail: escapeForDisplay(value),
      choices: ASK_ALLOW,
    });
    return (await ask(context, prompt, ASK_ALLOW)).decision;
  }

  async function decideMcp(request: PermissionRequest, context: PolicyContext): Promise<Decision> {
    const name = request.toolName;
    const folder = context.conversation.folder;
    const offerAlways = !context.settings.alwaysAskCommands && isValidRule(name);
    if (offerAlways && isStored(folder, name)) return allow();

    const rest = name.slice('mcp__'.length);
    const split = rest.indexOf('__');
    const title =
      split > 0 && split < rest.length - 2
        ? `Use the tool ${escapeForDisplay(rest.slice(split + 2))} from ${escapeForDisplay(rest.slice(0, split))}`
        : `Use the tool ${escapeForDisplay(name)}`;
    const choices: Choice[] = offerAlways ? ['allow-once', 'allow-always', 'deny'] : ASK_ALLOW;
    const prompt = permissionPrompt(request, {
      category: 'external',
      title,
      detail: escapeForDisplay(name),
      choices,
      ...(offerAlways ? { alwaysRule: { rule: name, runsProjectCode: false } } : {}),
    });
    const { decision, always } = await ask(context, prompt, choices);
    if (always && offerAlways) await saveRule(folder, name);
    return decision;
  }

  async function decideOther(
    request: PermissionRequest,
    context: PolicyContext,
  ): Promise<Decision> {
    const prompt = permissionPrompt(request, {
      category: 'external',
      title: `Use the tool ${escapeForDisplay(request.toolName.slice(0, 100))}`,
      detail: escapeForDisplay(request.toolName),
      choices: ASK_ALLOW,
    });
    return (await ask(context, prompt, ASK_ALLOW)).decision;
  }

  return {
    profile({ mode, settings, conversation }) {
      if (mode !== 'agent') return { unavailable: 'This policy only handles Agent mode.' };
      return {
        kind: 'agent',
        allowRules: settings.alwaysAskCommands ? [] : rules.list(conversation.folder),
        alwaysAskCommands: settings.alwaysAskCommands,
        sandbox: settings.sandbox,
      };
    },

    async decide(request, context) {
      try {
        if (
          !isRecord(request) ||
          typeof request.toolName !== 'string' ||
          !isRecord(request.input)
        ) {
          return deny(NOT_CHECKED);
        }
        const name = request.toolName;
        switch (name) {
          case 'AskUserQuestion':
            return await decideQuestion(request, context);
          case 'Edit':
          case 'Write':
          case 'NotebookEdit':
            return await decideEdit(request, context);
          case 'Bash':
          case 'PowerShell':
            return await decideCommand(request, context);
          case 'Read':
          case 'Grep':
          case 'Glob':
            return await decideRead(request, context);
          case 'WebFetch':
          case 'WebSearch':
            return await decideWeb(request, context);
          default:
            if (name.startsWith(OWN_TOOL_PREFIX)) {
              return deny('This tool cannot be approved through a permission request.');
            }
            if (name.startsWith('mcp__')) return await decideMcp(request, context);
            return await decideOther(request, context);
        }
      } catch (error) {
        logger.warn('The agent policy could not decide on a request; it was denied.', {
          reason: error instanceof Error ? error.message : String(error),
        });
        return deny(NOT_CHECKED);
      }
    },

    inspect(event, context) {
      if (event.type !== 'session') return undefined;
      if (event.permissionMode !== 'default') {
        return {
          stop: 'Claude Code did not start in its default permission mode, so the turn was stopped.',
        };
      }
      if (!sameFolder(event.cwd, context.folder.path)) {
        return { stop: 'Claude Code started in a different folder, so the turn was stopped.' };
      }
      // A project's own tool servers run code at session start. They are allowed only when the
      // user chose to use them.
      if (
        context.projectConfig?.mcp !== 'use' &&
        event.mcpServers.some((server) => server.name !== HOST_SERVER_NAME)
      ) {
        return {
          stop: 'Claude Code started a tool server the project configured although it was set to be ignored, so the turn was stopped.',
        };
      }
      return undefined;
    },
  };
}
