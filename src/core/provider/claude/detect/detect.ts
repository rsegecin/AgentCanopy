import { homedir } from 'node:os';
import { z } from 'zod';
import type { CredentialKind, ProviderCapabilities, ProviderStatus } from '../../../../shared';
import { EXEC_TIMEOUT_MS, defaultExec } from './exec';
import type { ExecFn } from './exec';
import { locateClaude } from './locate';
import { MINIMUM_CLAUDE_VERSION, compareVersions, parseVersion } from './version';

export interface ClaudeLaunch {
  command: string;
  prefixArgs: string[];
}

export interface DetectClaudeOptions {
  /** Explicit path from the settings. Empty means search. */
  claudePath: string;
  env: NodeJS.ProcessEnv;
  /** Test hook and escape hatch: run this command instead of locating the executable. */
  launchOverride?: ClaudeLaunch;
  platform?: NodeJS.Platform;
  homeDir?: string;
  exec?: ExecFn;
  signal?: AbortSignal;
}

export interface DetectClaudeResult {
  status: ProviderStatus;
  /** How to start Claude Code. Present only when it is installed and meets the minimum version. */
  launch?: ClaudeLaunch;
}

const PROVIDER_ID = 'claude-code';
const DISPLAY_NAME = 'Claude Code';

const NOT_FOUND =
  'Claude Code was not found. Install it, or set the path in the AgentCanopy settings.';
const SHIM_FOUND =
  'AgentCanopy needs the native Claude Code install (claude.exe). An npm shim was found instead.';
const SIGNED_OUT =
  'Claude Code is not signed in. Use Sign in to open a terminal and run its login.';
const API_KEY_SET =
  'An ANTHROPIC_API_KEY environment variable is set, so Claude Code bills the API account instead of your subscription.';

/** Only these two fields of `auth status` are ever read. */
const AuthStatusSchema = z.looseObject({
  loggedIn: z.boolean().optional(),
  authMethod: z.string().optional(),
});

function noCapabilities(): ProviderCapabilities {
  return {
    streaming: false,
    resume: false,
    forkWhole: false,
    forkAtMessage: 'none',
    modelSelection: false,
    interactiveApproval: false,
    readOnlyEnforcement: 'none',
    cancellation: 'none',
    toolEvents: false,
    interactiveQuestions: false,
    usage: false,
    hostTools: false,
    sandbox: false,
    sessionHistory: false,
  };
}

function fullCapabilities(
  platform: NodeJS.Platform,
  forkAtMessage: 'exact' | 'none',
): ProviderCapabilities {
  return {
    streaming: true,
    resume: true,
    forkWhole: true,
    forkAtMessage,
    modelSelection: true,
    interactiveApproval: true,
    readOnlyEnforcement: 'tool-layer',
    cancellation: platform === 'win32' ? 'hard' : 'graceful',
    toolEvents: true,
    interactiveQuestions: true,
    usage: true,
    hostTools: true,
    sandbox: platform === 'darwin' || platform === 'linux',
    sessionHistory: false,
  };
}

function credentialFromAuthMethod(method: string | undefined): CredentialKind {
  switch (method) {
    case 'claude.ai':
    case 'oauth_token':
      return 'subscription';
    case 'api_key':
    case 'api_key_helper':
      return 'api-key';
    case 'third_party':
      return 'other';
    default:
      return 'unknown';
  }
}

function baseStatus(): ProviderStatus {
  return {
    providerId: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    installed: false,
    meetsMinimum: false,
    minimumVersion: MINIMUM_CLAUDE_VERSION,
    auth: 'unknown',
    credential: 'unknown',
    capabilities: noCapabilities(),
    problems: [],
  };
}

/**
 * Finds Claude Code and reports its version, sign-in state and capabilities.
 * It never throws, and it never copies account details from `auth status` into its result.
 */
export async function detectClaude(options: DetectClaudeOptions): Promise<DetectClaudeResult> {
  try {
    return await detect(options);
  } catch {
    return {
      status: {
        ...baseStatus(),
        problems: ['Claude Code could not be checked because of an unexpected error.'],
      },
    };
  }
}

async function detect(options: DetectClaudeOptions): Promise<DetectClaudeResult> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  // Probes run from the home directory, so nothing in the workspace can shadow the executable.
  const probeCwd = options.homeDir ?? homedir();
  const status = baseStatus();
  const run = (launch: ClaudeLaunch, args: string[]) =>
    exec(launch.command, [...launch.prefixArgs, ...args], {
      timeoutMs: EXEC_TIMEOUT_MS,
      env: options.env,
      cwd: probeCwd,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  const aborted = () => options.signal?.aborted === true;

  // 1. Locate.
  let launch: ClaudeLaunch;
  if (options.launchOverride) {
    launch = {
      command: options.launchOverride.command,
      prefixArgs: [...options.launchOverride.prefixArgs],
    };
  } else {
    const located = await locateClaude({
      claudePath: options.claudePath,
      env: options.env,
      platform,
      homeDir: probeCwd,
    });
    if (located.kind === 'shim') {
      status.problems.push(SHIM_FOUND);
      return { status };
    }
    if (located.kind === 'missing') {
      status.problems.push(NOT_FOUND);
      return { status };
    }
    launch = { command: located.command, prefixArgs: [] };
  }
  if (aborted())
    return { status: { ...status, problems: ['Checking Claude Code was cancelled.'] } };

  // 2. Version.
  const versionRun = await run(launch, ['--version']);
  status.installed = true;
  if (versionRun.error !== undefined) {
    status.problems.push('Claude Code was found but could not be run.');
    return { status };
  }
  if (versionRun.exitCode !== 0) {
    status.problems.push('Claude Code was found but did not report a version.');
    return { status };
  }
  const version = parseVersion(versionRun.stdout);
  if (version === undefined) {
    status.problems.push('Claude Code was found but its version could not be read.');
    return { status };
  }
  status.version = version;
  if (compareVersions(version, MINIMUM_CLAUDE_VERSION) < 0) {
    status.problems.push(
      `Claude Code ${version} is older than the minimum supported version ${MINIMUM_CLAUDE_VERSION}. Update Claude Code.`,
    );
    return { status };
  }
  status.meetsMinimum = true;
  if (aborted()) {
    status.problems.push('Checking Claude Code was cancelled.');
    return { status };
  }

  // 3. Sign-in state and the fork probe, which do not depend on each other.
  const [authRun, probeRun] = await Promise.all([
    run(launch, ['auth', 'status']),
    run(launch, ['--resume-session-at']),
  ]);

  const authInfo = parseAuth(authRun.stdout);
  status.auth = authInfo.auth;
  status.credential = authInfo.credential;

  const forkAtMessage =
    probeRun.error === undefined &&
    /argument missing/i.test(`${probeRun.stdout}\n${probeRun.stderr}`)
      ? 'exact'
      : 'none';
  status.capabilities = fullCapabilities(platform, forkAtMessage);

  if (status.auth === 'signed-out') status.problems.push(SIGNED_OUT);
  else if (status.auth === 'unknown') {
    status.problems.push('Claude Code sign-in state could not be checked.');
  }
  if (
    typeof options.env['ANTHROPIC_API_KEY'] === 'string' &&
    options.env['ANTHROPIC_API_KEY'] !== ''
  ) {
    status.credential = 'api-key';
    status.problems.push(API_KEY_SET);
  }

  return { status, launch };
}

function parseAuth(stdout: string): { auth: ProviderStatus['auth']; credential: CredentialKind } {
  try {
    const parsed = AuthStatusSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success || parsed.data.loggedIn === undefined) {
      return { auth: 'unknown', credential: 'unknown' };
    }
    if (!parsed.data.loggedIn) return { auth: 'signed-out', credential: 'unknown' };
    return { auth: 'signed-in', credential: credentialFromAuthMethod(parsed.data.authMethod) };
  } catch {
    return { auth: 'unknown', credential: 'unknown' };
  }
}
