import type { AgentEvent, ImageMediaType, Mode, ModelInfo, ProviderStatus } from '../../shared';

/** An image sent with the turn's user message. */
export interface TurnImage {
  mediaType: ImageMediaType;
  data: Uint8Array;
}

/** Which provider session a turn runs on. */
export type SessionRef =
  | { kind: 'new'; sessionId: string }
  | { kind: 'resume'; sessionId: string }
  | {
      kind: 'fork';
      fromSessionId: string;
      newSessionId: string;
      /** Keep history up to and including this provider event. Absent: keep everything. */
      atProviderEventId?: string;
    };

/**
 * What a turn is allowed to do, in provider-neutral terms. The adapter translates it into
 * flags and settings; the host policy enforces the rest when the provider asks for permission.
 */
/**
 * Whether a turn uses the Claude Code configuration that comes with the project (its
 * `.claude/settings*.json` and `.mcp.json`). That configuration can start programs (tool servers,
 * hooks, helper commands) and change the environment, so it is used only after the user agreed to it
 * for that folder. Absent means "ignore both".
 */
export interface ProjectConfigChoice {
  /** `ignore`: load only the user's own settings (project settings, their CLAUDE.md included, are skipped). */
  settings: 'use' | 'ignore';
  /** `ignore`: start only AgentCanopy's tool server. Read-only turns always ignore project servers. */
  mcp: 'use' | 'ignore';
  /**
   * True when `settings` is `use` and the project's settings hold more than the safe set: environment
   * variables, hooks, helper commands, allow rules, extra directories, or a file that could not be
   * read. Such settings can change what a command runs (`PATH`, `BASH_ENV`), so Agent mode then
   * stops treating any command as read-only.
   */
  settingsBeyondSafeSet?: boolean;
}

export type ExecutionProfile =
  | {
      kind: 'read-only';
      projectConfig?: ProjectConfigChoice;
      /** Offer web search and fetch tools. */
      webTools: boolean;
      /** Offer the plan submission tool (Plan mode with an unlocked plan). */
      planTool: boolean;
    }
  | {
      kind: 'agent';
      projectConfig?: ProjectConfigChoice;
      /** Rules in the provider's own syntax that pre-approve calls (for Claude Code: `Bash(npm test)`). */
      allowRules: string[];
      /** Ask the host before every terminal command, ignoring allow rules. */
      alwaysAskCommands: boolean;
      sandbox: boolean;
      /**
       * A command may not leave the sandbox, not even behind a prompt. Set for a turn that starts
       * with Auto, so a command approved without a prompt always ran sandboxed. Only means something
       * with `sandbox`.
       */
      sandboxLocked: boolean;
    };

/** Where the provider reaches the host's tool server for this turn. */
export interface HostEndpoint {
  serverName: string;
  url: string;
  bearerToken: string;
  permissionToolName: string;
  /** Present when the plan tool is exposed for this turn. */
  planToolName?: string;
  /** Present when the host wants a call before and after every tool call. */
  hookUrl?: string;
}

export interface TurnRequest {
  /** Absolute path of the workspace folder. */
  cwd: string;
  /** The full prompt, including the mode block. Sent on stdin. */
  prompt: string;
  /**
   * Images sent before the prompt, in the same user message. Absent (never empty) for a turn
   * without images, so that turn is sent exactly as a text-only turn.
   */
  images?: TurnImage[];
  mode: Mode;
  model: string;
  session: SessionRef;
  profile: ExecutionProfile;
  host: HostEndpoint;
  /** Constant text appended to the provider's system prompt. */
  systemPromptAppend: string;
  /** An existing private directory (mode 0700) where the adapter writes this turn's config files. */
  runDir: string;
}

export interface TurnExit {
  exitCode: number | null;
  signal: string | null;
  /** Whether a result event was seen before the process ended. */
  sawResult: boolean;
  /** Last part of stderr, redacted, for error reports. */
  stderrTail: string;
}

export interface TurnHandle {
  /** Process id, once spawned. Used by the turn journal for crash recovery. */
  readonly pid: number | undefined;
  /** Resolves with the process id as soon as the process exists, or undefined when it never started. */
  readonly started: Promise<number | undefined>;
  /** Ends when the process has exited and all output was consumed. Never throws: failures arrive as events. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Ask the provider to end the turn, escalating to a hard stop after grace periods. Idempotent. */
  cancel(): Promise<void>;
  /** Stop the process group immediately. Used when a safety guard fails. */
  kill(): void;
  readonly done: Promise<TurnExit>;
}

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  /** Finds the provider and reports version, sign-in state and capabilities. Never throws. */
  detect(signal?: AbortSignal): Promise<ProviderStatus>;
  listModels(customModels: readonly string[]): ModelInfo[];
  /**
   * The command a user runs to sign in to this provider, using the executable found by the last
   * detection. Undefined when the provider was not found. Nothing here touches credentials.
   */
  signInCommand?(): { executable: string; args: string[] } | undefined;
  startTurn(request: TurnRequest): TurnHandle;
}

export interface ProviderRegistry {
  list(): AgentProvider[];
  get(id: string): AgentProvider | undefined;
}
