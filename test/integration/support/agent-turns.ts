import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { applyPatch, type HostMessage, type ViewState } from '../../../src/shared';
import type { ViewHandle } from '../../../src/core/contracts';
import type { HostTestApi } from '../../../src/vscode/host';
import { waitFor } from './host';

// The fake CLI reads its scenario file when a turn starts. The tests of the extension host cannot
// import `test/fake-cli` (it needs `import.meta.url`), so the few steps they need are built here.

type Step = Record<string, unknown>;

const BASE = { session_id: '$SESSION', parent_tool_use_id: null };

function emit(event: Record<string, unknown>): Step {
  return { emit: { ...event, uuid: randomUUID() } };
}

const stateEvent = (state: 'running' | 'idle'): Step =>
  emit({ type: 'system', subtype: 'session_state_changed', state, session_id: '$SESSION' });

const initEvent = (): Step =>
  emit({
    type: 'system',
    subtype: 'init',
    cwd: '$CWD',
    session_id: '$SESSION',
    tools: ['AskUserQuestion', 'Glob', 'Grep', 'Read'],
    mcp_servers: [{ name: 'agentcanopy', status: 'connected', source: 'dynamic' }],
    model: 'claude-haiku-5-5',
    permissionMode: 'default',
  });

const assistantText = (text: string): Step =>
  emit({
    type: 'assistant',
    message: {
      id: 'msg_fake',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    ...BASE,
  });

const assistantToolUse = (id: string, name: string, input: object): Step =>
  emit({
    type: 'assistant',
    message: {
      id: 'msg_tool',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
    ...BASE,
  });

const toolResult = (id: string, text: string, accepted: boolean): Step =>
  emit({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content: text,
          ...(accepted ? {} : { is_error: true }),
        },
      ],
    },
    ...BASE,
    tool_result_meta: [
      {
        id,
        permission_decision: accepted
          ? { decision: 'accept', source: 'user_temporary' }
          : { decision: 'reject', source: 'user_reject' },
        ...(accepted ? {} : { non_execution_kind: 'permission-rule' }),
      },
    ],
  });

const resultSteps = (): Step[] => [
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    num_turns: 1,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    session_id: '$SESSION',
  }),
  stateEvent('idle'),
];

/** An Agent turn that writes each file with the `Write` tool: permission, hooks, the write itself. */
export function writeFilesScenario(files: { name: string; content: string }[]): object {
  const steps: Step[] = [stateEvent('running'), initEvent()];
  files.forEach((file, index) => {
    const id = `toolu_w${String(index)}`;
    const path = `$CWD/${file.name}`;
    const input = { file_path: path, content: file.content };
    steps.push(assistantToolUse(id, 'Write', input), {
      permission: {
        toolName: 'Write',
        input,
        toolUseId: id,
        onAllow: [
          { hook: { phase: 'pre', toolName: 'Write', input, toolUseId: id } },
          { writeFile: { path, content: file.content } },
          { hook: { phase: 'post', toolName: 'Write', input, toolUseId: id } },
          toolResult(id, 'written', true),
        ],
        onDeny: [toolResult(id, 'denied', false)],
      },
    });
  });
  steps.push(assistantText('done'), ...resultSteps());
  return { steps };
}

/** Where the extension host's fake CLI reads its scenario from. */
export function scenarioPath(): string {
  const path = process.env.FAKE_CLAUDE_SCENARIO;
  if (!path) throw new Error('FAKE_CLAUDE_SCENARIO is not set: is the suite run by vscode-test?');
  return path;
}

/** Replaces the scenario for the next turns and returns a function that puts the old one back. */
export function useScenario(scenario: object): () => void {
  const path = scenarioPath();
  const previous = fs.readFileSync(path, 'utf8');
  fs.writeFileSync(path, JSON.stringify(scenario));
  return () => {
    fs.writeFileSync(path, previous);
  };
}

/** A view attached to the controller that mirrors the state and allows permission prompts once. */
export interface ViewSession {
  state(): ViewState;
  send(message: object): void;
  /** Waits until no turn of the active conversation is preparing or running, and `turns` have run. */
  waitForTurns(turns: number): Promise<ViewState>;
  dispose(): void;
}

export async function openViewSession(api: HostTestApi): Promise<ViewSession> {
  let state: ViewState | undefined;
  let answered = '';
  const ref: { handle?: ViewHandle } = {};
  const handle = api.controller.attachView('panel', {
    post(message: HostMessage) {
      if (message.type === 'init') state = message.state;
      else if (message.type === 'patch' && state) state = applyPatch(state, message.ops);
      const prompt = state?.active?.prompts.find((p) => p.state === 'pending');
      if (prompt?.kind === 'permission' && answered !== prompt.id) {
        answered = prompt.id;
        ref.handle?.receive({
          type: 'prompt.answer',
          promptId: prompt.id,
          displayHash: prompt.displayHash,
          answer: { kind: 'permission', choice: 'allow-once' },
        });
      }
    },
  });
  ref.handle = handle;
  handle.receive({ type: 'ready' });
  await waitFor('the initial state', () => state);
  const current = (): ViewState => {
    if (!state) throw new Error('no state yet');
    return state;
  };
  return {
    state: current,
    send: (message) => {
      handle.receive(message);
    },
    waitForTurns: (turns) =>
      waitFor(
        `${String(turns)} finished turns`,
        () => {
          const list = state?.active?.turns ?? [];
          return list.length >= turns &&
            list.every((t) => t.status !== 'preparing' && t.status !== 'running') &&
            state
            ? state
            : undefined;
        },
        30_000,
      ),
    dispose: () => {
      handle.dispose();
    },
  };
}

/** Sends one message in a new conversation and waits until its turn is completed. */
export async function runTurn(
  api: HostTestApi,
  text: string,
  mode: 'ask' | 'agent' = 'agent',
): Promise<ViewState> {
  const session = await openViewSession(api);
  try {
    session.send({ type: 'turn.send', text, mode, model: 'default' });
    return await session.waitForTurns(1);
  } finally {
    session.dispose();
  }
}
