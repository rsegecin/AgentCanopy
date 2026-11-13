import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentEvent, SessionEvent } from '../../../shared';
import { HOST_SERVER_NAME, type PolicyContext, type PolicyFinding } from '../../contracts';
import { displayName } from './escape';
import { PLAN_TOOL_NAME } from './tools';

/** What the guard remembers about the turn it is watching. */
export interface GuardState {
  sawSession: boolean;
  hookNoticed: boolean;
}

export function newGuardState(): GuardState {
  return { sawSession: false, hookNoticed: false };
}

const BASE_TOOLS = ['Read', 'Grep', 'Glob', 'AskUserQuestion', 'EndConversation'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const MAX_NAMES = 5;
const NO_SESSION =
  'Claude Code started answering before reporting its configuration, so read-only mode could not be verified.';

/** The plan tool belongs to a Plan turn whose plan is not locked, and to no other turn. */
function allowedTools(context: PolicyContext): Set<string> {
  const names = [...BASE_TOOLS];
  if (context.settings.askWebTools) names.push(...WEB_TOOLS);
  if (context.mode === 'plan' && !context.conversation.planLocked) names.push(PLAN_TOOL_NAME);
  return new Set(names);
}

function nameList(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES).map((name) => displayName(name));
  const more = names.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}

export function sameFolder(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return resolve(a) === resolve(b);
  }
}

function stop(text: string): PolicyFinding {
  return { stop: text };
}

function checkSession(event: SessionEvent, context: PolicyContext): PolicyFinding | undefined {
  const allowed = allowedTools(context);
  const extra = event.tools.filter((tool) => !allowed.has(tool));
  const missingRead = !event.tools.includes('Read');
  if (extra.length > 0 || missingRead) {
    const detail = extra.length > 0 ? nameList(extra) : 'Read is missing';
    return stop(
      `Claude Code offered tools that are not allowed in a read-only mode (${detail}), so the turn was stopped.`,
    );
  }

  const [server] = event.mcpServers;
  if (
    event.mcpServers.length !== 1 ||
    server?.name !== HOST_SERVER_NAME ||
    server.status !== 'connected'
  ) {
    return stop(
      'Claude Code loaded tool servers that are not allowed in a read-only mode, so the turn was stopped.',
    );
  }

  if (event.permissionMode !== 'default') {
    return stop(
      'Claude Code did not start in its default permission mode, so the turn was stopped.',
    );
  }

  if (!sameFolder(event.cwd, context.folder.path)) {
    return stop('Claude Code started in a different folder, so the turn was stopped.');
  }

  const plugins = event.plugins.filter((plugin) => !plugin.builtin).map((plugin) => plugin.name);
  if (plugins.length > 0) {
    const names = nameList(plugins);
    if (context.settings.strictReadOnly) {
      return stop(
        `A Claude Code plugin is loaded (${names}). Plugins run outside AgentCanopy's read-only guarantee, and the strict setting is on.`,
      );
    }
    return {
      notice: `A Claude Code plugin is loaded (${names}). Plugins run outside AgentCanopy's read-only guarantee.`,
    };
  }
  return undefined;
}

/** Checks one event of a read-only turn. See `createReadOnlyPolicy` for how the state is kept. */
export function inspectEvent(
  state: GuardState,
  event: AgentEvent,
  context: PolicyContext,
): PolicyFinding | undefined {
  switch (event.type) {
    case 'session': {
      state.sawSession = true;
      return checkSession(event, context);
    }
    case 'assistant-block':
    case 'text-delta':
      if (!state.sawSession) return stop(NO_SESSION);
      return undefined;
    case 'tool-call': {
      if (!state.sawSession) return stop(NO_SESSION);
      if (!allowedTools(context).has(event.name)) {
        return stop(
          `Claude Code tried to use a tool that is not allowed in a read-only mode (${displayName(event.name)}), so the turn was stopped.`,
        );
      }
      return undefined;
    }
    case 'hook': {
      if (event.phase !== 'started') return undefined;
      if (context.settings.strictReadOnly) {
        return stop(
          "A hook ran during a read-only turn. Hooks are outside AgentCanopy's read-only guarantee, and the strict setting is on.",
        );
      }
      if (state.hookNoticed) return undefined;
      state.hookNoticed = true;
      return {
        notice: `A hook ran during this turn (${displayName(event.name)}). Hooks that an administrator configured cannot be turned off and are outside AgentCanopy's read-only guarantee.`,
      };
    }
    default:
      return undefined;
  }
}
