import { describe, expect, it } from 'vitest';
import { buildChildEnv } from './launch';

describe('buildChildEnv', () => {
  const base: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    ELECTRON_RUN_AS_NODE: '1',
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    VSCODE_PID: '12',
    VSCODE_IPC_HOOK: '/tmp/x',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '5555',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '9000',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'https://example.test',
  };

  it('removes editor and nesting markers', () => {
    const env = buildChildEnv(base, false);
    for (const key of [
      'ELECTRON_RUN_AS_NODE',
      'ELECTRON_NO_ATTACH_CONSOLE',
      'VSCODE_PID',
      'VSCODE_IPC_HOOK',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_SSE_PORT',
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('keeps the user configuration and unrelated variables', () => {
    const env = buildChildEnv(base, false);
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('9000');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.test');
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/u');
  });

  it('sets the three switches, and the connector switch only when read-only', () => {
    const rw = buildChildEnv(base, false);
    expect(rw.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
    expect(rw.CLAUDE_CODE_STARTUP_FAILURE_RESULTS).toBe('1');
    expect(rw.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(rw).not.toHaveProperty('ENABLE_CLAUDEAI_MCP_SERVERS');
    const ro = buildChildEnv(base, true);
    expect(ro.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
    expect(ro.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe('1');
  });

  it('keeps every Bash call of an Agent turn in the folder, whatever was inherited, and only then', () => {
    const rw = buildChildEnv(base, false);
    expect(rw.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe('1');
    const overridden = buildChildEnv(
      { ...base, CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: '0' },
      false,
    );
    expect(overridden.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe('1');
    const ro = buildChildEnv(base, true);
    expect(ro).not.toHaveProperty('CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR');
  });

  it('does not modify the base environment', () => {
    const copy = { ...base };
    buildChildEnv(base, true);
    expect(base).toEqual(copy);
  });
});
