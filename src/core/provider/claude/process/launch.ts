/** How to start the Claude Code CLI: the executable and any arguments that come before ours. */
export interface ClaudeLaunch {
  command: string;
  prefixArgs: string[];
}

const REMOVED = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  // Markers that make a CLI believe it runs nested inside another Claude Code session.
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
]);

/**
 * The environment for a CLI child: the caller's environment without editor and nesting markers,
 * plus the switches the adapter depends on. Other CLAUDE_CODE_* and ANTHROPIC_* variables are the
 * user's configuration and stay.
 */
export function buildChildEnv(base: NodeJS.ProcessEnv, readOnly: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (REMOVED.has(key) || key.startsWith('VSCODE_')) delete env[key];
  }
  env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
  env.CLAUDE_CODE_STARTUP_FAILURE_RESULTS = '1';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  if (readOnly) env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return env;
}
