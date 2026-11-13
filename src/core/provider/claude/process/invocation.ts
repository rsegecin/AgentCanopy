import { isAbsolute, join } from 'node:path';
import type { TurnRequest } from '../../../contracts/provider';
import { isUuid, writeNewPrivateFile } from '../../../util';

export interface PreparedInvocation {
  args: string[];
  /** The prompt. It travels on stdin and never in the argument list. */
  stdin: string;
  /** Whether the child environment needs the read-only switches. */
  readOnly: boolean;
  /** The files written into the run directory. */
  files: string[];
}

const MODEL = /^[A-Za-z0-9._:[\]/@-]{1,100}$/;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_RULE = 500;
const HOOK_TIMEOUT_SECONDS = 60;
const MCP_TIMEOUT_MS = 43_200_000;

function requireUuid(value: string, label: string): void {
  if (typeof value !== 'string' || !isUuid(value)) throw new Error(`${label} must be a UUID`);
}

function requireName(value: string, label: string): void {
  if (typeof value !== 'string' || !NAME.test(value)) {
    throw new Error(`${label} must match ${NAME.source}`);
  }
}

function validate(request: TurnRequest): void {
  if (typeof request.runDir !== 'string' || !isAbsolute(request.runDir)) {
    throw new Error('runDir must be an absolute path');
  }
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
    throw new Error('cwd must be an absolute path');
  }
  if (request.model !== 'default' && !MODEL.test(request.model)) {
    throw new Error('model name contains characters that are not allowed');
  }
  const { session, host, profile } = request;
  switch (session.kind) {
    case 'new':
    case 'resume':
      requireUuid(session.sessionId, 'session id');
      break;
    case 'fork':
      requireUuid(session.fromSessionId, 'fork source session id');
      requireUuid(session.newSessionId, 'fork session id');
      if (session.atProviderEventId !== undefined) {
        requireUuid(session.atProviderEventId, 'fork cut event id');
      }
      break;
    default:
      throw new Error('unknown session kind');
  }
  requireName(host.serverName, 'server name');
  requireName(host.permissionToolName, 'permission tool name');
  if (host.planToolName !== undefined) requireName(host.planToolName, 'plan tool name');
  if (profile.kind === 'agent') {
    for (const rule of profile.allowRules) {
      if (
        typeof rule !== 'string' ||
        rule.trim().length === 0 ||
        rule.length > MAX_RULE ||
        /[\r\n\u2028\u2029]/.test(rule)
      ) {
        throw new Error(
          `an allow rule must be a single non-empty line of at most ${MAX_RULE} characters`,
        );
      }
    }
  } else if (profile.kind !== 'read-only') {
    throw new Error('unknown execution profile');
  }
}

function sessionArgs(request: TurnRequest): string[] {
  const { session } = request;
  switch (session.kind) {
    case 'new':
      return ['--session-id', session.sessionId];
    case 'resume':
      return ['--resume', session.sessionId];
    case 'fork': {
      const args = [
        '--resume',
        session.fromSessionId,
        '--fork-session',
        '--session-id',
        session.newSessionId,
      ];
      if (session.atProviderEventId !== undefined) {
        args.push('--resume-session-at', session.atProviderEventId);
      }
      return args;
    }
  }
}

function buildSettings(request: TurnRequest): Record<string, unknown> {
  const { profile, host } = request;
  // Calls that Claude Code would otherwise run without asking must reach the host, which decides.
  if (profile.kind === 'read-only') {
    const ask = ['Read', 'Grep', 'Glob'];
    if (profile.webTools) ask.push('WebFetch', 'WebSearch');
    return { disableAllHooks: true, permissions: { ask } };
  }
  const ask = [
    'Edit',
    'Write',
    'NotebookEdit',
    'Bash',
    'PowerShell',
    'Read',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
  ];
  const permissions: Record<string, string[]> = { ask };
  if (!profile.alwaysAskCommands && profile.allowRules.length > 0) {
    permissions.allow = [...profile.allowRules];
  }
  const settings: Record<string, unknown> = { permissions };
  if (host.hookUrl !== undefined) {
    const entry = (path: string) => [
      {
        matcher: '*',
        hooks: [{ type: 'http', url: `${host.hookUrl}${path}`, timeout: HOOK_TIMEOUT_SECONDS }],
      },
    ];
    // A failing tool call reports through PostToolUseFailure instead of PostToolUse (observed on
    // 2.1.322), and a denied call reports through neither.
    settings.hooks = {
      PreToolUse: entry('/pre'),
      PostToolUse: entry('/post'),
      PostToolUseFailure: entry('/post-failure'),
    };
  }
  if (profile.sandbox) settings.sandbox = { enabled: true, autoAllowBashIfSandboxed: false };
  return settings;
}

/**
 * Validates the request, writes the turn's three config files into its run directory and returns
 * the argument list. Nothing is written when validation fails. Only validated tokens and the
 * three file paths appear in the arguments; the prompt goes to stdin.
 */
export async function prepareInvocation(request: TurnRequest): Promise<PreparedInvocation> {
  validate(request);
  const { host, profile } = request;
  const mcpPath = join(request.runDir, 'mcp.json');
  const settingsPath = join(request.runDir, 'settings.json');
  const promptPath = join(request.runDir, 'system-prompt.txt');

  const mcp = {
    mcpServers: {
      [host.serverName]: {
        type: 'http',
        url: host.url,
        headers: { Authorization: `Bearer ${host.bearerToken}` },
        timeout: MCP_TIMEOUT_MS,
      },
    },
  };

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--include-hook-events',
    '--permission-mode',
    'default',
    '--permission-prompt-tool',
    `mcp__${host.serverName}__${host.permissionToolName}`,
    '--mcp-config',
    mcpPath,
    '--settings',
    settingsPath,
    '--append-system-prompt-file',
    promptPath,
  ];
  if (request.model !== 'default') args.push('--model', request.model);
  args.push(...sessionArgs(request));
  if (profile.kind === 'read-only') {
    args.push(
      '--tools',
      profile.webTools
        ? 'Read,Grep,Glob,AskUserQuestion,WebSearch,WebFetch'
        : 'Read,Grep,Glob,AskUserQuestion',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--no-chrome',
    );
    if (profile.planTool && host.planToolName !== undefined) {
      args.push('--allowedTools', `mcp__${host.serverName}__${host.planToolName}`);
    }
  } else if ((profile.projectConfig?.mcp ?? 'ignore') === 'ignore') {
    args.push('--strict-mcp-config');
  }
  // Project settings (env, hooks, helper commands, CLAUDE.md) load only when the user agreed.
  if ((profile.projectConfig?.settings ?? 'ignore') === 'ignore') {
    args.push('--setting-sources', 'user');
  }

  await writeNewPrivateFile(mcpPath, JSON.stringify(mcp, null, 2));
  await writeNewPrivateFile(settingsPath, JSON.stringify(buildSettings(request), null, 2));
  await writeNewPrivateFile(promptPath, request.systemPromptAppend);

  return {
    args,
    stdin: request.prompt,
    readOnly: profile.kind === 'read-only',
    files: [mcpPath, settingsPath, promptPath],
  };
}
