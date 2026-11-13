import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeLaunch } from '../../src/core/provider/claude/process/launch';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.mjs');

export interface FakeClaude {
  launch: ClaudeLaunch;
  env: NodeJS.ProcessEnv;
  /** Where the child writes what it received (argv, stdin, selected env, cwd). Only with `record`. */
  recordPath?: string;
  dispose(): Promise<void>;
}

export interface FakeClaudeRecord {
  argv: string[];
  stdin: string;
  env: Record<string, string | undefined>;
  cwd: string;
}

/** Writes the scenario to a temp directory and returns a launch spec that runs the fake CLI. */
export async function fakeClaude(
  scenario: object,
  options: { record?: boolean; auth?: object } = {},
): Promise<FakeClaude> {
  const dir = await mkdtemp(join(tmpdir(), 'fake-claude-'));
  const scenarioPath = join(dir, 'scenario.json');
  await writeFile(scenarioPath, JSON.stringify(scenario));
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_CLAUDE_SCENARIO: scenarioPath };
  let recordPath: string | undefined;
  if (options.record) {
    recordPath = join(dir, 'record.json');
    env.FAKE_CLAUDE_RECORD = recordPath;
  }
  if (options.auth) env.FAKE_CLAUDE_AUTH = JSON.stringify(options.auth);
  const result: FakeClaude = {
    launch: { command: process.execPath, prefixArgs: [SCRIPT] },
    env,
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
  if (recordPath !== undefined) result.recordPath = recordPath;
  return result;
}

/** `system/init` shaped like a real one (trimmed). `$SESSION` and `$CWD` are filled in by the fake CLI. */
export function initEvent(overrides: Record<string, unknown> = {}): { emit: object } {
  return {
    emit: {
      type: 'system',
      subtype: 'init',
      cwd: '$CWD',
      session_id: '$SESSION',
      tools: ['AskUserQuestion', 'Glob', 'Grep', 'Read'],
      mcp_servers: [{ name: 'agentcanopy', status: 'connected', source: 'dynamic' }],
      model: 'claude-haiku-5-5',
      permissionMode: 'default',
      uuid: randomUUID(),
      ...overrides,
    },
  };
}

/** The stream of events for a plain text answer, from state change to idle, without the result. */
export function textTurn(text: string): { emit: object }[] {
  const base = { session_id: '$SESSION', parent_tool_use_id: null };
  const messageId = 'msg_fake';
  const stream = (event: object) => ({
    emit: { type: 'stream_event', event, ...base, uuid: randomUUID(), api_message_id: messageId },
  });
  return [
    {
      emit: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'running',
        uuid: randomUUID(),
        session_id: '$SESSION',
      },
    },
    initEvent(),
    stream({ type: 'message_start', message: { id: messageId, role: 'assistant', content: [] } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    stream({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    {
      emit: {
        type: 'assistant',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text }],
        },
        ...base,
        uuid: randomUUID(),
      },
    },
    stream({ type: 'content_block_stop', index: 0 }),
    stream({ type: 'message_stop' }),
  ];
}

/** A `result` event (success by default) followed by the idle state change. */
export function resultEvent(
  text = '',
  overrides: Record<string, unknown> = {},
): { emit: object }[] {
  return [
    {
      emit: {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
        num_turns: 1,
        stop_reason: 'end_turn',
        terminal_reason: 'completed',
        session_id: '$SESSION',
        uuid: randomUUID(),
        ...overrides,
      },
    },
    {
      emit: {
        type: 'system',
        subtype: 'session_state_changed',
        state: 'idle',
        uuid: randomUUID(),
        session_id: '$SESSION',
      },
    },
  ];
}
