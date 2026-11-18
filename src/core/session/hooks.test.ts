import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type { AssistantMessage } from '../../shared';
import type { PermissionRequest, TurnContext, TurnObserver, TurnPolicy } from '../contracts';
import {
  FakeEditor,
  assistantText,
  assistantToolUse,
  createHarness,
  createPlanTestPolicy,
  finishedTurn,
  resultStep,
  sendAndFinish,
  sleep,
  stateEvent,
  textScenario,
  until,
  userToolResult,
  type Harness,
  type TestView,
} from './test-support';

const harnesses: Harness[] = [];
async function harness(...args: Parameters<typeof createHarness>): Promise<Harness> {
  const h = await createHarness(...args);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sendAgent(view: TestView, text = 'go'): void {
  view.send({ type: 'turn.send', text, mode: 'agent', model: 'default' });
}

const PRE = { phase: 'pre', toolName: 'Write', input: { file_path: 'a.txt' }, toolUseId: 't1' };
const POST = { phase: 'post', toolName: 'Write', input: { file_path: 'a.txt' }, toolUseId: 't1' };

function hookScenario(): object {
  return {
    steps: [
      stateEvent('running'),
      initEvent(),
      { hook: PRE },
      { writeFile: { path: 'after-pre.txt', content: 'x' } },
      { hook: POST },
      { writeFile: { path: 'after-post.txt', content: 'x' } },
      assistantText('done'),
      ...resultStep('done'),
    ],
  };
}

const exists = (path: string): Promise<boolean> =>
  fs.access(path).then(
    () => true,
    () => false,
  );

describe('tool hooks', () => {
  it('reach the observers in order, and the provider waits for them', async () => {
    const calls: string[] = [];
    const gate = deferred();
    const contexts: TurnContext[] = [];
    const observer: TurnObserver = {
      wantsToolHooks: (context) => {
        contexts.push(context);
        return true;
      },
      onToolHook: async (_context, event) => {
        calls.push(`${event.phase}:${event.toolCallId}`);
        if (event.phase === 'pre') await gate.promise;
      },
    };
    const second: TurnObserver = {
      onToolHook: (_context, event) => {
        calls.push(`second ${event.phase}`);
        return Promise.resolve();
      },
    };
    const h = await harness({
      scenario: hookScenario(),
      policy: createPlanTestPolicy(),
      observers: [observer, second],
    });
    const view = h.attach();
    sendAgent(view);
    await until('the pre hook', () => calls.length === 1);
    await sleep(150);
    // The fake CLI is stuck inside its pre hook call: nothing after it ran.
    expect(calls).toEqual(['pre:t1']);
    expect(await exists(join(h.workspace, 'after-pre.txt'))).toBe(false);

    gate.resolve();
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(calls).toEqual(['pre:t1', 'second pre', 'post:t1', 'second post']);
    expect(await exists(join(h.workspace, 'after-post.txt'))).toBe(true);
    expect(h.requests[0]?.host.hookUrl).toBeDefined();
    expect(contexts[0]?.turnId).toBe(turn.id);
    expect(contexts[0]?.mode).toBe('agent');
    view.expectMirror();
  });

  it('are not requested when no observer wants them', async () => {
    const h = await harness({
      scenario: textScenario('done'),
      policy: createPlanTestPolicy(),
      observers: [{ wantsToolHooks: () => false, onToolHook: () => Promise.resolve() }],
    });
    const view = h.attach();
    sendAgent(view);
    await finishedTurn(h, view);
    expect(h.requests[0]?.host.hookUrl).toBeUndefined();
    view.expectMirror();
  });

  it('are skipped for an observer that throws, and the turn goes on', async () => {
    const calls: string[] = [];
    const broken: TurnObserver = {
      wantsToolHooks: () => true,
      onToolHook: () => Promise.reject(new Error('the tracker broke')),
    };
    const fine: TurnObserver = {
      onToolHook: (_context, event) => {
        calls.push(event.phase);
        return Promise.resolve();
      },
    };
    const h = await harness({
      scenario: hookScenario(),
      policy: createPlanTestPolicy(),
      observers: [broken, fine],
    });
    const view = h.attach();
    sendAgent(view);
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(calls).toEqual(['pre', 'post']);
    expect(h.logger.has('warn', 'an observer failed on a tool hook')).toBe(true);
    view.expectMirror();
  });

  it('are not asked about when wantsToolHooks throws', async () => {
    const h = await harness({
      scenario: textScenario('done'),
      policy: createPlanTestPolicy(),
      observers: [
        {
          wantsToolHooks: () => {
            throw new Error('no idea');
          },
        },
      ],
    });
    const view = h.attach();
    sendAgent(view);
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(h.requests[0]?.host.hookUrl).toBeUndefined();
  });
});

function permissionScenario(): object {
  return {
    steps: [
      stateEvent('running'),
      initEvent(),
      {
        permission: {
          toolName: 'Write',
          input: { file_path: 'a.txt', content: 'hello' },
          toolUseId: 'toolu_w',
          onAllow: [
            { writeFile: { path: 'a.txt', content: 'hello' } },
            userToolResult('toolu_w', 'written', {
              decision: { decision: 'accept', source: 'user_temporary' },
            }),
          ],
          onDeny: [],
        },
      },
      assistantText('done'),
      ...resultStep('done'),
    ],
  };
}

describe('permission requests', () => {
  it('reach the observers before the policy decides, and the policy waits for them', async () => {
    const calls: string[] = [];
    const gate = deferred();
    const requests: PermissionRequest[] = [];
    const base = createPlanTestPolicy();
    const policy: TurnPolicy = {
      ...base,
      decide: () => {
        calls.push('decide');
        return Promise.resolve({ response: { behavior: 'allow' }, approval: 'policy' });
      },
    };
    const first: TurnObserver = {
      onPermissionRequest: async (_context, request) => {
        calls.push('first');
        requests.push(request);
        await gate.promise;
      },
    };
    const second: TurnObserver = {
      onPermissionRequest: () => {
        calls.push('second');
        return Promise.resolve();
      },
    };
    const h = await harness({
      scenario: permissionScenario(),
      policy,
      observers: [first, second],
    });
    const view = h.attach();
    sendAgent(view);
    await until('the first observer', () => calls.length === 1);
    await sleep(100);
    expect(calls).toEqual(['first']);

    gate.resolve();
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(calls).toEqual(['first', 'second', 'decide']);
    expect(requests[0]).toMatchObject({ toolName: 'Write', toolCallId: 'toolu_w' });
    expect(await fs.readFile(join(h.workspace, 'a.txt'), 'utf8')).toBe('hello');
    view.expectMirror();
  });

  it('are still decided when an observer throws', async () => {
    const calls: string[] = [];
    const policy: TurnPolicy = {
      ...createPlanTestPolicy(),
      decide: () => {
        calls.push('decide');
        return Promise.resolve({ response: { behavior: 'allow' }, approval: 'policy' });
      },
    };
    const h = await harness({
      scenario: permissionScenario(),
      policy,
      observers: [
        { onPermissionRequest: () => Promise.reject(new Error('could not capture')) },
        {
          onPermissionRequest: () => {
            calls.push('second');
            return Promise.resolve();
          },
        },
      ],
    });
    const view = h.attach();
    sendAgent(view);
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(calls).toEqual(['second', 'decide']);
    expect(h.logger.has('warn', 'an observer failed on a permission request')).toBe(true);
    view.expectMirror();
  });
});

describe('hook facts on permission requests', () => {
  const input = { command: 'ls' };
  const pre = (id: string, extra: Record<string, unknown> = {}) => ({
    hook: { phase: 'pre', toolName: 'Bash', input, toolUseId: id, ...extra },
  });
  const post = (id: string) => ({
    hook: { phase: 'post', toolName: 'Bash', input, toolUseId: id },
  });
  const ask = (id: string) => ({
    permission: { toolName: 'Bash', input, toolUseId: id, onAllow: [], onDeny: [] },
  });

  async function run(steps: object[]): Promise<{
    byId: Map<string, PermissionRequest>;
    seenByObserver: Map<string, PermissionRequest>;
  }> {
    const byId = new Map<string, PermissionRequest>();
    const seenByObserver = new Map<string, PermissionRequest>();
    const policy: TurnPolicy = {
      ...createPlanTestPolicy(),
      decide: (request) => {
        byId.set(request.toolCallId, request);
        return Promise.resolve({ response: { behavior: 'allow' }, approval: 'policy' });
      },
    };
    const observer: TurnObserver = {
      wantsToolHooks: () => true,
      onPermissionRequest: (_context, request) => {
        seenByObserver.set(request.toolCallId, request);
        return Promise.resolve();
      },
    };
    const h = await harness({
      policy,
      observers: [observer],
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          ...steps,
          assistantText('done'),
          ...resultStep('done'),
        ],
      },
    });
    const view = h.attach();
    sendAgent(view);
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    return { byId, seenByObserver };
  }

  it('hands the policy what the pre-hook of the same call reported', async () => {
    const { byId, seenByObserver } = await run([
      pre('t_cwd', { cwd: '/the/folder' }),
      ask('t_cwd'),
      pre('t_agent', { cwd: '/the/folder', agentId: 'agent-1' }),
      ask('t_agent'),
      pre('t_only_agent', { cwd: null, agentId: 'agent-2' }),
      ask('t_only_agent'),
      ask('t_none'),
    ]);
    expect(byId.get('t_cwd')?.hook).toEqual({ cwd: '/the/folder' });
    expect(byId.get('t_agent')?.hook).toEqual({ cwd: '/the/folder', agentId: 'agent-1' });
    expect(byId.get('t_only_agent')?.hook).toEqual({ agentId: 'agent-2' });
    expect(byId.get('t_none')).toBeDefined();
    expect(byId.get('t_none')).not.toHaveProperty('hook');
    // The observers see the same enriched request, and the provider's own abort signal.
    expect(seenByObserver.get('t_cwd')?.hook).toEqual({ cwd: '/the/folder' });
    const signal = byId.get('t_cwd')?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(seenByObserver.get('t_cwd')?.signal).toBe(signal);
  });

  it('forgets a call at its post hook, and uses each record once', async () => {
    const { byId } = await run([
      pre('t_post', { cwd: '/the/folder' }),
      post('t_post'),
      ask('t_post'),
      pre('t_twice', { cwd: '/the/folder' }),
      ask('t_twice'),
      ask('t_twice'),
    ]);
    expect(byId.get('t_post')).not.toHaveProperty('hook');
    // The map holds the later of the two requests: it came after the record was taken.
    expect(byId.get('t_twice')).toBeDefined();
    expect(byId.get('t_twice')).not.toHaveProperty('hook');
  });

  it('keeps at most 256 records, dropping the oldest', async () => {
    const steps: object[] = [];
    for (let i = 0; i < 300; i += 1) steps.push(pre(`c${i}`, { cwd: `/dir/${i}` }));
    for (const id of ['c0', 'c43', 'c44', 'c299']) steps.push(ask(id));
    const { byId } = await run(steps);
    expect(byId.get('c0')).not.toHaveProperty('hook');
    expect(byId.get('c43')).not.toHaveProperty('hook');
    expect(byId.get('c44')?.hook).toEqual({ cwd: '/dir/44' });
    expect(byId.get('c299')?.hook).toEqual({ cwd: '/dir/299' });
  });
});

describe('the provider process', () => {
  it('is reported to the observers once, with its process id', async () => {
    const started: { pid: number; turnId: string }[] = [];
    const h = await harness({
      scenario: textScenario('done'),
      observers: [
        {
          onProcessStarted: (context, pid) => {
            started.push({ pid, turnId: context.turnId });
          },
        },
        {
          onProcessStarted: () => {
            throw new Error('this one throws');
          },
        },
      ],
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('completed');
    expect(h.handles[0]?.pid).toBeDefined();
    expect(started).toEqual([{ pid: h.handles[0]?.pid, turnId: turn.id }]);
    expect(h.logger.has('warn', 'an observer failed when the process started')).toBe(true);
    view.expectMirror();
  });
});

describe('the process id', () => {
  it('reaches the observers at spawn, even when the process is slow to print anything', async () => {
    const started: number[] = [];
    const h = await harness({
      scenario: {
        steps: [{ sleep: 1500 }, ...textScenario('done').steps],
      },
      observers: [
        {
          onProcessStarted: () => {
            started.push(Date.now());
          },
        },
      ],
    });
    const view = h.attach();
    const begun = Date.now();
    view.send({ type: 'turn.send', text: 'go', mode: 'ask', model: 'default' });
    await until('the observer to hear about the process', () => started.length === 1, 5000);
    expect((started[0] ?? Number.POSITIVE_INFINITY) - begun).toBeLessThan(500);
    await finishedTurn(h, view);
    expect(started).toHaveLength(1);
    view.expectMirror();
  });
});

describe('tool results', () => {
  function recorder(calls: string[]): TurnObserver {
    return {
      wantsToolHooks: () => true,
      onToolHook: (_context, event) => {
        calls.push(event.phase);
        return Promise.resolve();
      },
      onPermissionRequest: () => {
        calls.push('permission');
        return Promise.resolve();
      },
      onToolResult: (_context, result) => {
        calls.push(`result:${result.toolCallId}:${result.executed ? 'ran' : 'not-run'}`);
      },
      afterTurn: () => {
        calls.push('afterTurn');
        return Promise.resolve([]);
      },
    };
  }

  const input = { command: 'ls' };
  const allow: TurnPolicy = {
    ...createPlanTestPolicy(),
    decide: () => Promise.resolve({ response: { behavior: 'allow' }, approval: 'policy' }),
  };

  it('come after the post hook for a call that ran', async () => {
    const calls: string[] = [];
    const h = await harness({
      policy: allow,
      observers: [recorder(calls)],
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          assistantToolUse('toolu_a', 'Bash', input),
          { hook: { phase: 'pre', toolName: 'Bash', input, toolUseId: 'toolu_a' } },
          {
            permission: {
              toolName: 'Bash',
              input,
              toolUseId: 'toolu_a',
              onAllow: [
                { hook: { phase: 'post', toolName: 'Bash', input, toolUseId: 'toolu_a' } },
                userToolResult('toolu_a', 'ok', {
                  decision: { decision: 'accept', source: 'user_temporary' },
                }),
              ],
              onDeny: [],
            },
          },
          assistantText('done'),
          ...resultStep('done'),
        ],
      },
    });
    const view = h.attach();
    sendAgent(view);
    await finishedTurn(h, view);
    expect(calls).toEqual(['pre', 'permission', 'post', 'result:toolu_a:ran', 'afterTurn']);
    view.expectMirror();
  });

  it('say that a denied call did not run, and no post hook comes', async () => {
    const calls: string[] = [];
    const h = await harness({
      policy: createPlanTestPolicy(),
      observers: [recorder(calls)],
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          assistantToolUse('toolu_d', 'Bash', input),
          { hook: { phase: 'pre', toolName: 'Bash', input, toolUseId: 'toolu_d' } },
          {
            permission: {
              toolName: 'Bash',
              input,
              toolUseId: 'toolu_d',
              onAllow: [],
              onDeny: [
                userToolResult('toolu_d', 'denied', {
                  isError: true,
                  decision: { decision: 'reject', source: 'user_reject' },
                  nonExecutionKind: 'permission-rule',
                }),
              ],
            },
          },
          assistantText('done'),
          ...resultStep('done'),
        ],
      },
    });
    const view = h.attach();
    sendAgent(view);
    await finishedTurn(h, view);
    expect(calls).toEqual(['pre', 'permission', 'result:toolu_d:not-run', 'afterTurn']);
    view.expectMirror();
  });

  it('are reported as not run for every call still open when the turn ends', async () => {
    const calls: string[] = [];
    const h = await harness({
      policy: createPlanTestPolicy(),
      observers: [recorder(calls)],
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          assistantToolUse('toolu_x', 'Bash', input),
          assistantToolUse('toolu_y', 'Read', { file_path: 'a.txt' }),
          { hang: true },
        ],
      },
    });
    const view = h.attach();
    sendAgent(view);
    await until(
      'both calls to show',
      () => (view.state?.active?.messages[1] as AssistantMessage | undefined)?.parts.length === 2,
    );
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await finishedTurn(h, view);
    expect(calls).toEqual(['result:toolu_x:not-run', 'result:toolu_y:not-run', 'afterTurn']);
    view.expectMirror();
  });

  it('skip an observer that throws', async () => {
    const calls: string[] = [];
    const h = await harness({
      scenario: textScenario('ok'),
      policy: createPlanTestPolicy(),
      observers: [
        {
          onToolResult: () => {
            throw new Error('broken');
          },
        },
        recorder(calls),
      ],
    });
    const view = h.attach();
    sendAgent(view);
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(calls).toEqual(['afterTurn']);
  });
});

describe('unsaved files', () => {
  const settingsWith = (unsavedFiles: 'warn' | 'ignore') => ({ ...DEFAULT_SETTINGS, unsavedFiles });

  function noticesOf(view: TestView): string[] {
    const message = view
      .active()
      .messages.find((m): m is AssistantMessage => m.role === 'assistant');
    return (message?.parts ?? []).flatMap((part) =>
      part.kind === 'notice' ? [`${part.level}: ${part.text}`] : [],
    );
  }

  it('are announced before the provider starts, with at most five names', async () => {
    const editor = new FakeEditor();
    const h = await harness({ scenario: textScenario('ok'), editor });
    const view = h.attach();
    editor.dirty = ['b.ts', 'src/a.ts', 'c.ts'].map((file) => join(h.workspace, file));
    await sendAndFinish(h, view, 'first');
    expect(noticesOf(view)).toEqual([
      'warning: 3 files have unsaved changes. The agent only sees what is saved on disk: b.ts, c.ts, src/a.ts.',
    ]);

    editor.dirty = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((file) => join(h.workspace, file));
    await sendAndFinish(h, view, 'second');
    const second = view
      .active()
      .messages.filter((m): m is AssistantMessage => m.role === 'assistant')[1];
    expect(second?.parts[0]).toEqual({
      kind: 'notice',
      level: 'warning',
      text: '7 files have unsaved changes. The agent only sees what is saved on disk: a, b, c, d, e and 2 more.',
    });

    editor.dirty = [join(h.workspace, 'only.ts')];
    await sendAndFinish(h, view, 'third');
    const third = view
      .active()
      .messages.filter((m): m is AssistantMessage => m.role === 'assistant')[2];
    expect(third?.parts[0]).toMatchObject({
      text: '1 file has unsaved changes. The agent only sees what is saved on disk: only.ts.',
    });
    view.expectMirror();
  });

  it('are not announced when the setting says ignore, or when they lie outside the folder', async () => {
    const editor = new FakeEditor();
    const h = await harness({ scenario: textScenario('ok'), editor });
    const view = h.attach();
    editor.dirty = [join(h.workspace, 'a.ts')];
    h.env.settingsValue = settingsWith('ignore');
    await sendAndFinish(h, view, 'one');
    expect(noticesOf(view)).toEqual([]);

    h.env.settingsValue = settingsWith('warn');
    editor.dirty = [join(h.root, 'elsewhere.ts'), join(h.root, 'work-other', 'x.ts')];
    await sendAndFinish(h, view, 'two');
    expect(noticesOf(view)).toEqual([]);
    view.expectMirror();
  });

  it('are announced in Agent mode as well', async () => {
    const editor = new FakeEditor();
    editor.dirty = [];
    const h = await harness({
      scenario: textScenario('ok'),
      editor,
      policy: createPlanTestPolicy(),
    });
    const view = h.attach();
    editor.dirty = [join(h.workspace, 'a.ts')];
    sendAgent(view);
    await finishedTurn(h, view);
    expect(noticesOf(view)).toEqual([
      'warning: 1 file has unsaved changes. The agent only sees what is saved on disk: a.ts.',
    ]);
  });
});
