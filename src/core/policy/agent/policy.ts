import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
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
import type { GrantStore, PolicyAccess } from '../grants';
import { coversEdit } from '../grants/directory';
import {
  canGrantDirectory,
  containsSensitive,
  isSensitivePath,
  resolveSensitiveEnv,
} from '../grants/sensitive';
import { isValidGrant } from '../grants/store';
import { fetchSite, webCovered } from '../grants/web';
import {
  decideQuestion,
  decideRead,
  deny,
  isRecord,
  previewOf,
  saveGrant,
} from '../readonly/decide';
import { escapeForDisplay } from '../readonly/escape';
import { sameFolder } from '../readonly/guard';
import { isInside } from '../readonly/paths';
import { realFolderPath, checkPath } from '../readonly/targets';
import {
  exactCommandRule,
  exactPowerShellCommand,
  runsProjectCode,
  runsProjectCodePowerShell,
} from './commands';
import { isProtectedAbsolutePath, isProtectedPath } from './protected';
import { checkReadOnlyCommand } from './readonly-command';
import { isValidRule, type RuleStore } from './rules';

type Decision = PolicyDecision;
type Choice = PermissionPrompt['choices'][number];

const NOT_CHECKED = 'The request could not be checked.';
const OWN_TOOL_PREFIX = `mcp__${HOST_SERVER_NAME}__`;
const ASK_ALLOW: Choice[] = ['allow-once', 'deny'];

function allow(): Decision {
  return { response: { behavior: 'allow' }, approval: 'user' };
}

/** Approved by Agent mode's Auto, which the user turned on for the conversation in a native dialog. */
function allowAuto(): Decision {
  return { response: { behavior: 'allow' }, approval: 'auto' };
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
 * True when the Bash input holds nothing but the command and its harmless companions. Any other key
 * is a field this code does not know, which may change what runs; the two flags count only when off.
 */
function plainBashInput(input: Record<string, unknown>): boolean {
  return Object.entries(input).every(([key, value]) => {
    switch (key) {
      case 'command':
      case 'description':
        return typeof value === 'string';
      case 'timeout':
        return typeof value === 'number';
      case 'run_in_background':
      case 'dangerouslyDisableSandbox':
        return value === false;
      default:
        return false;
    }
  });
}

/** True when the platform compares file names without regard to case. */
function foldsCase(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

/**
 * True when the hook of this call reports a main-session call whose working directory is the
 * folder. The command text says nothing about where it runs; only the hook does.
 */
async function runsInFolder(hook: PermissionRequest['hook'], folderPath: string): Promise<boolean> {
  // No hook arrived: nothing confirms where the command runs.
  if (hook === undefined) return false;
  // A subagent may run in a worktree of its own, whatever its command says.
  if (hook.agentId !== undefined) return false;
  // A relative or missing directory is not one the host can compare.
  if (typeof hook.cwd !== 'string' || !isAbsolute(hook.cwd)) return false;
  // A network path is never the folder, and resolving it would contact that server.
  if (hook.cwd.startsWith('\\\\') || hook.cwd.startsWith('//')) return false;
  const fold = (path: string): string => (foldsCase() ? path.toLowerCase() : path);
  const [cwd, folder] = await Promise.all([realFolderPath(hook.cwd), realFolderPath(folderPath)]);
  // The same folder, through links and in any spelling of the drive letter: a subfolder, or a
  // link into another folder, is not where the checks looked.
  return isInside(fold(cwd), fold(folder)) && isInside(fold(folder), fold(cwd));
}

/**
 * The policy of Agent mode. Edits inside the folder go through (and are reviewed afterwards) except
 * protected files; everything with side effects outside the folder, commands, network and external
 * tools ask the user. Nothing is approved silently except what the user chose "always" for, read-only
 * Bash commands inside the folder (judged by `checkReadOnlyCommand` and confirmed by the hook of the
 * same call: no subagent, working directory is the folder) and, while Auto applies (`context.auto`,
 * which the user turned on in a native dialog), commands, edits inside the folder and, by setting,
 * web tools. Auto never covers protected files, anything outside the folder, MCP tools or any other
 * tool. `context.auto` is live: every Auto approval reads it right before it returns, never from a
 * value kept across an await.
 *
 * With `grants`, the folder's switches and saved permissions (directories, sites, PowerShell
 * commands) also approve, and `sensitiveRoots` (AgentCanopy's storage directories) always ask. A
 * directory saved for edits approves edits outside the folder in it and below, except protected files
 * and sensitive locations. A directory saved for reads never approves an edit. The
 * grant store is live in the same way: every approval from it reads it right before it returns, after
 * the last await, never from a value kept across one, so a removal or a switch turned off during a
 * turn applies to the next request. Without `grants` every decision is the plain one.
 */
export function createAgentPolicy(options: {
  rules: RuleStore;
  logger?: Logger;
  grants?: GrantStore;
  sensitiveRoots?: () => string[];
}): TurnPolicy {
  const { rules } = options;
  const logger = options.logger ?? silentLogger;
  const access: PolicyAccess | undefined =
    options.grants === undefined
      ? undefined
      : { grants: options.grants, sensitiveRoots: options.sensitiveRoots ?? (() => []), logger };

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
      const outsidePrompt = (
        choices: Choice[],
        alwaysRule?: PermissionPrompt['alwaysRule'],
      ): NewPrompt =>
        permissionPrompt(request, {
          category: 'outside-workspace',
          title: 'Edit a file outside the workspace',
          detail: escapeForDisplay(target.shown),
          choices,
          ...(alwaysRule !== undefined ? { alwaysRule } : {}),
        });
      const prompt = outsidePrompt(ASK_ALLOW);
      const real = target.real;
      // Without a grant store, or for a path the host cannot judge, the plain prompt.
      if (access === undefined || real === undefined) {
        return (await ask(context, prompt, ASK_ALLOW)).decision;
      }
      const env = await resolveSensitiveEnv(access.sensitiveRoots);
      // What a saved directory may cover: not a sensitive location, and not a protected file or a
      // file below a protected directory (.git, .claude, .env, ...), wherever the saved directory is.
      const coverable =
        !isSensitivePath(real, env) &&
        !containsSensitive(real, env) &&
        !isProtectedAbsolutePath(real);
      const parent = dirname(real);
      const dir =
        coverable &&
        canGrantDirectory(parent, env) &&
        isValidGrant({ kind: 'edit-directory', path: parent })
          ? parent
          : undefined;
      const folder = context.conversation.folder;
      // Read the store here, after the last await, with nothing awaited in between: a directory the
      // user removed during the awaits above must not still approve.
      if (
        coverable &&
        access.grants.get(folder).grants.some((grant) => coversEdit(grant, real, env))
      ) {
        return allow();
      }
      if (dir === undefined) return (await ask(context, prompt, ASK_ALLOW)).decision;
      const choices: Choice[] = ['allow-once', 'allow-always', 'deny'];
      const answer = await ask(
        context,
        outsidePrompt(choices, { kind: 'edit-directory', rule: dir, runsProjectCode: false }),
        choices,
      );
      if (answer.always) await saveGrant(access, folder, { kind: 'edit-directory', path: dir });
      return answer.decision;
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
    // Read here, after the path checks were awaited: Auto may have been turned off meanwhile.
    if (context.auto) return allowAuto();
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
    // A command that asks to leave the sandbox always asks, once: neither a stored rule nor Auto
    // approves it, and no rule is offered for it.
    if (request.input['dangerouslyDisableSandbox'] === true) {
      const prompt = permissionPrompt(request, {
        category: 'command',
        title: 'Run a terminal command outside the sandbox',
        detail: escapeForDisplay(command),
        choices: ASK_ALLOW,
      });
      return (await ask(context, prompt, ASK_ALLOW)).decision;
    }
    const folder = context.conversation.folder;
    const alwaysAsk = context.settings.alwaysAskCommands;
    // A Bash rule is the CLI's own; a PowerShell command is saved in the grant store, and only when
    // there is one. Without it a PowerShell command always asks.
    const rule = request.toolName === 'Bash' && !alwaysAsk ? exactCommandRule(command) : undefined;
    const exact =
      access !== undefined && request.toolName === 'PowerShell' && !alwaysAsk
        ? exactPowerShellCommand(command)
        : undefined;

    if (rule !== undefined && isStored(folder, rule)) return allow();
    // Read here, with nothing awaited since: a command removed during the turn must ask again.
    if (exact !== undefined && isPowerShellStored(folder, exact)) return allow();
    if (context.auto && !alwaysAsk) return allowAuto();
    if (
      request.toolName === 'Bash' &&
      !alwaysAsk &&
      (await readOnlyAllowed(request, command, context))
    ) {
      return { response: { behavior: 'allow' }, approval: 'policy' };
    }

    const powerShell =
      exact !== undefined && isValidGrant({ kind: 'powershell-command', command: exact })
        ? exact
        : undefined;
    const choices: Choice[] =
      (rule !== undefined && isValidRule(rule)) || powerShell !== undefined
        ? ['allow-once', 'allow-always', 'deny']
        : ASK_ALLOW;
    const prompt = permissionPrompt(request, {
      category: 'command',
      title: 'Run a terminal command',
      detail: escapeForDisplay(command),
      choices,
      ...(rule !== undefined && choices.includes('allow-always')
        ? { alwaysRule: { rule, runsProjectCode: runsProjectCode(command) } }
        : {}),
      ...(powerShell !== undefined
        ? {
            alwaysRule: {
              kind: 'command',
              rule: `PowerShell(${powerShell})`,
              runsProjectCode: runsProjectCodePowerShell(powerShell),
            },
          }
        : {}),
    });
    const { decision, always } = await ask(context, prompt, choices);
    if (always && rule !== undefined) await saveRule(folder, rule);
    if (always && powerShell !== undefined && access !== undefined) {
      await saveGrant(access, folder, { kind: 'powershell-command', command: powerShell });
    }
    return decision;
  }

  /**
   * True when the Bash command may run without asking because it only reads inside the folder. Every
   * condition is a way an injected command could otherwise get through; any doubt asks.
   */
  async function readOnlyAllowed(
    request: PermissionRequest,
    command: string,
    context: PolicyContext,
  ): Promise<boolean> {
    // A field this code does not know may change what runs, or leave the sandbox, or detach it.
    if (!plainBashInput(request.input)) return false;
    // Project environment variables or hooks could change PATH or BASH_ENV, so "ls" runs anything.
    if (
      context.projectConfig?.settings === 'use' &&
      context.projectConfig.settingsBeyondSafeSet === true
    ) {
      return false;
    }
    // The checks judge the command against the folder; only the hook says where it runs.
    if (!(await runsInFolder(request.hook, context.folder.path))) return false;
    const check = await checkReadOnlyCommand(command, {
      folderPath: context.folder.path,
      ...(access !== undefined ? { sensitiveRoots: access.sensitiveRoots } : {}),
    });
    if (!check.readOnly) {
      // The reason only; the command text may hold secrets.
      logger.debug('A command was not treated as read-only.', { reason: check.reason });
      return false;
    }
    // The setting is live and may have been turned on while the checks were awaited.
    return !context.settings.alwaysAskCommands;
  }

  /** True when the PowerShell command is saved for this folder right now. */
  function isPowerShellStored(folder: FolderKey, command: string): boolean {
    return (
      access?.grants
        .get(folder)
        .grants.some((grant) => grant.kind === 'powershell-command' && grant.command === command) ??
      false
    );
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
    const folder = context.conversation.folder;
    const site = access !== undefined && fetchTool ? fetchSite(value) : undefined;
    // Read here, with nothing awaited since: a switch turned off or a site removed during the turn
    // must ask again. Saved permissions come before Auto, so they are labelled as the user's.
    if (access !== undefined && webCovered(access.grants.get(folder), fetchTool, site)) {
      return allow();
    }
    if (context.auto && context.settings.agentAutoWebTools) return allowAuto();
    const choices: Choice[] =
      site === undefined ? ASK_ALLOW : ['allow-once', 'allow-always', 'deny'];
    const prompt = permissionPrompt(request, {
      category: 'network',
      title: fetchTool ? 'Fetch a web page' : 'Search the web',
      detail: escapeForDisplay(value),
      choices,
      ...(site !== undefined
        ? { alwaysRule: { kind: 'web-site', rule: site, runsProjectCode: false } }
        : {}),
    });
    const { decision, always } = await ask(context, prompt, choices);
    if (always && site !== undefined && access !== undefined) {
      await saveGrant(access, folder, { kind: 'web-site', host: site });
    }
    return decision;
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
        // A turn that starts with Auto may not leave the sandbox, so a command approved without a
        // prompt always ran inside it.
        sandboxLocked: settings.sandbox && settings.agentAuto && conversation.agentAuto === true,
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
            return await decideRead(request, context, access);
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
