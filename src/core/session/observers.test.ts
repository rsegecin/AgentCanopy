import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantMessage, MessagePart, TurnOutcome } from '../../shared';
import type { TurnContext, TurnNotice, TurnObserver, TurnPolicy } from '../contracts';
import {
  createHarness,
  createTestPolicy,
  finishedTurn,
  sendAndFinish,
  sleep,
  streamedText,
  textScenario,
  until,
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

function assistantOf(view: TestView): AssistantMessage {
  const found = view.active().messages.find((m): m is AssistantMessage => m.role === 'assistant');
  if (!found) throw new Error('no assistant message');
  return found;
}

function noticesOf(view: TestView): MessagePart[] {
  return assistantOf(view).parts.filter((part) => part.kind === 'notice');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function send(view: TestView, text = 'go'): void {
  view.send({ type: 'turn.send', text, mode: 'ask', model: 'default' });
}

const hangingScenario = {
  steps: [...streamedText(['x']), { hang: true }],
  onSigint: 'ignore',
  onSigterm: 'ignore',
};

describe('policy findings', () => {
  const withInspect = (inspect: NonNullable<TurnPolicy['inspect']>): TurnPolicy => ({
    ...createTestPolicy(),
    inspect,
  });

  it('adds a notice as a warning and lets the turn complete', async () => {
    const h = await harness({
      scenario: textScenario('fine'),
      policy: withInspect((event) =>
        event.type === 'session' ? { notice: 'Something looks odd.' } : undefined,
      ),
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('completed');
    expect(turn.error).toBeUndefined();
    expect(noticesOf(view)).toEqual([
      { kind: 'notice', level: 'warning', text: 'Something looks odd.' },
    ]);
    expect(assistantOf(view).parts).toContainEqual({ kind: 'text', text: 'fine' });
    view.expectMirror();
  });

  it('shows the same notice once per turn, and again in the next turn', async () => {
    const h = await harness({
      scenario: textScenario('fine'),
      policy: withInspect(() => ({ notice: 'Same words.' })),
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('completed');
    expect(noticesOf(view)).toEqual([{ kind: 'notice', level: 'warning', text: 'Same words.' }]);

    await sendAndFinish(h, view, 'again');
    const second = view.active().messages.filter((m) => m.role === 'assistant')[1];
    expect(
      second?.role === 'assistant' && second.parts.filter((part) => part.kind === 'notice'),
    ).toEqual([{ kind: 'notice', level: 'warning', text: 'Same words.' }]);
    view.expectMirror();
  });

  it('still stops the turn for a stop', async () => {
    const h = await harness({
      scenario: hangingScenario,
      policy: withInspect((event) =>
        event.type === 'session' ? { stop: 'Stop now.' } : undefined,
      ),
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('Stop now.');
    expect(noticesOf(view)).toEqual([{ kind: 'notice', level: 'error', text: 'Stop now.' }]);
    view.expectMirror();
  });

  it('adds the notice and stops when a finding has both', async () => {
    const h = await harness({
      scenario: hangingScenario,
      policy: withInspect((event) =>
        event.type === 'session' ? { notice: 'A warning.', stop: 'Stop now.' } : undefined,
      ),
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('Stop now.');
    expect(noticesOf(view)).toEqual([
      { kind: 'notice', level: 'warning', text: 'A warning.' },
      { kind: 'notice', level: 'error', text: 'Stop now.' },
    ]);
    view.expectMirror();
  });
});

interface Probe {
  observer: TurnObserver;
  calls: string[];
}

/** An observer that writes what it is asked into a shared list. */
function probe(
  name: string,
  calls: string[],
  extra: {
    before?: (context: TurnContext, signal: AbortSignal) => Promise<void>;
    after?: (context: TurnContext, outcome: TurnOutcome) => Promise<TurnNotice[]>;
  } = {},
): Probe {
  return {
    calls,
    observer: {
      async beforeTurn(context, signal) {
        calls.push(`${name}.before`);
        await extra.before?.(context, signal);
      },
      async afterTurn(context, outcome) {
        calls.push(`${name}.after:${outcome}`);
        return (await extra.after?.(context, outcome)) ?? [];
      },
    },
  };
}

describe('observers', () => {
  it('run in order around the turn and see the turn context', async () => {
    const calls: string[] = [];
    const seen: { before?: TurnContext; after?: TurnContext } = {};
    const gate = deferred();
    const a = probe('a', calls, {
      before: async (context) => {
        seen.before = context;
        await gate.promise;
      },
      after: (context) => {
        seen.after = context;
        return Promise.resolve([]);
      },
    });
    const b = probe('b', calls);
    const h = await harness({
      scenario: textScenario('done'),
      observers: [a.observer, b.observer],
    });
    const view = h.attach();
    send(view);

    // While the first observer prepares, the turn exists but no process has started.
    await until('the first observer to start', () => calls.length === 1);
    await until('the turn', () => view.state?.active?.turns.length === 1);
    expect(view.active().turns[0]?.status).toBe('preparing');
    expect(view.active().activity).toBe('Preparing…');
    expect(view.active().messages.map((m) => m.role)).toEqual(['user']);
    expect(h.handles).toHaveLength(0);
    gate.resolve();

    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(calls).toEqual(['a.before', 'b.before', 'a.after:completed', 'b.after:completed']);
    expect(view.active().activity).toBeNull();
    expect(seen.before).toBeDefined();
    expect(seen.before?.mode).toBe('ask');
    expect(seen.before?.folder.path).toBe(h.workspace);
    expect(seen.before?.conversation.id).toBe(view.active().meta.id);
    expect(seen.before?.settings).toEqual(h.env.settings());
    expect(seen.after).toBe(seen.before);
    view.expectMirror();
  });

  it('end the turn with an error when beforeTurn throws, without starting the provider', async () => {
    const calls: string[] = [];
    const a = probe('a', calls);
    const b = probe('b', calls, {
      before: () => Promise.reject(new Error('The baseline could not be taken.')),
    });
    const c = probe('c', calls);
    const h = await harness({
      scenario: textScenario('never'),
      observers: [a.observer, b.observer, c.observer],
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('The baseline could not be taken.');
    expect(noticesOf(view)).toEqual([
      { kind: 'notice', level: 'error', text: 'The baseline could not be taken.' },
    ]);
    // Observers that had finished their preparation are told; the one that threw and the one after it are not.
    expect(calls).toEqual(['a.before', 'b.before', 'a.after:error']);
    expect(h.handles).toHaveLength(0);
    expect(h.requests).toHaveLength(0);
    const runDir = await fs.readdir(join(h.storage, 'run')).catch(() => [] as string[]);
    expect(runDir).toEqual([]);
    expect(view.active().activity).toBeNull();
    view.expectMirror();
  });

  it('end the turn as interrupted when it is cancelled while they prepare', async () => {
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    const slow = probe('slow', calls, {
      before: (_context, abort) => {
        signal = abort;
        return new Promise<void>((_resolve, reject) => {
          abort.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const next = probe('next', calls);
    const h = await harness({
      scenario: textScenario('never'),
      observers: [slow.observer, next.observer],
    });
    const view = h.attach();
    send(view);
    await until('the observer to start', () => calls.length === 1);
    expect(signal?.aborted).toBe(false);
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    const turn = await finishedTurn(h, view);
    expect(signal?.aborted).toBe(true);
    expect(turn.status).toBe('interrupted');
    expect(turn.error).toBeUndefined();
    expect(view.active().messages.filter((m) => m.role === 'assistant')).toEqual([]);
    expect(calls).toEqual(['slow.before']);
    expect(h.handles).toHaveLength(0);
    view.expectMirror();
  });

  it('abort the signal when the application shuts down', async () => {
    const calls: string[] = [];
    let signal: AbortSignal | undefined;
    const slow = probe('slow', calls, {
      before: (_context, abort) => {
        signal = abort;
        return new Promise<void>((_resolve, reject) => {
          abort.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });
    const h = await harness({ scenario: textScenario('never'), observers: [slow.observer] });
    const view = h.attach();
    send(view);
    await until('the observer to start', () => calls.length === 1);
    await h.controller.dispose();
    expect(signal?.aborted).toBe(true);
    expect(h.handles).toHaveLength(0);
  });

  it('add the notices of afterTurn, also to a turn that produced no output', async () => {
    const calls: string[] = [];
    const watcher = probe('watcher', calls, {
      // Waits for the cancel, then lets the turn go on: it stops before the provider starts.
      before: (_context, abort) =>
        new Promise<void>((resolve) => {
          abort.addEventListener('abort', () => resolve(), { once: true });
        }),
      after: () =>
        Promise.resolve([
          { level: 'info', text: 'Saved a snapshot.' },
          { level: 'warning', text: 'Two files changed.' },
        ]),
    });
    const h = await harness({ scenario: textScenario('never'), observers: [watcher.observer] });
    const view = h.attach();
    send(view);
    await until('the observer to start', () => calls.length === 1);
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('interrupted');
    expect(calls).toEqual(['watcher.before', 'watcher.after:interrupted']);
    expect(assistantOf(view).parts).toEqual([
      { kind: 'notice', level: 'info', text: 'Saved a snapshot.' },
      { kind: 'notice', level: 'warning', text: 'Two files changed.' },
    ]);
    expect(h.handles).toHaveLength(0);
    view.expectMirror();
  });

  it('add the notices of afterTurn after the answer', async () => {
    const calls: string[] = [];
    const first = probe('first', calls, {
      after: () => Promise.resolve([{ level: 'info', text: 'One.' }]),
    });
    const second = probe('second', calls, {
      after: () => Promise.resolve([{ level: 'error', text: 'Two.' }]),
    });
    const h = await harness({
      scenario: textScenario('the answer'),
      observers: [first.observer, second.observer],
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    // A notice from an observer does not change the outcome of the turn.
    expect(turn.status).toBe('completed');
    expect(assistantOf(view).parts).toEqual([
      { kind: 'text', text: 'the answer' },
      { kind: 'notice', level: 'info', text: 'One.' },
      { kind: 'notice', level: 'error', text: 'Two.' },
    ]);
    view.expectMirror();
  });

  it('are skipped, with a log entry, when afterTurn throws', async () => {
    const calls: string[] = [];
    const broken = probe('broken', calls, {
      after: () => Promise.reject(new Error('the tracker broke')),
    });
    const fine = probe('fine', calls, {
      after: () => Promise.resolve([{ level: 'info', text: 'Still here.' }]),
    });
    const h = await harness({
      scenario: textScenario('ok'),
      observers: [broken.observer, fine.observer],
    });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('completed');
    expect(calls).toEqual([
      'broken.before',
      'fine.before',
      'broken.after:completed',
      'fine.after:completed',
    ]);
    expect(noticesOf(view)).toEqual([{ kind: 'notice', level: 'info', text: 'Still here.' }]);
    expect(h.logger.has('warn', 'an observer failed after a turn')).toBe(true);
    view.expectMirror();
  });

  it('tell afterTurn that a turn that failed to finish ended in error', async () => {
    const calls: string[] = [];
    const watcher = probe('watcher', calls);
    // The default scenario ends without a result.
    const h = await harness({ observers: [watcher.observer] });
    const view = h.attach();
    const turn = await sendAndFinish(h, view, 'go');
    expect(turn.status).toBe('error');
    expect(calls).toEqual(['watcher.before', 'watcher.after:error']);
  });

  it('hold back the final state of the turn until afterTurn has finished', async () => {
    const gate = deferred();
    let started = false;
    const slow = probe('slow', [], {
      after: async () => {
        started = true;
        await gate.promise;
        return [{ level: 'info', text: 'Done checking.' }];
      },
    });
    const h = await harness({ scenario: textScenario('answer'), observers: [slow.observer] });
    const view = h.attach();
    send(view);
    await until('afterTurn to start', () => started);
    await sleep(100);

    // The process has exited and the answer is shown, but the turn is not over yet.
    expect(h.controller.runningTurns()).toBe(1);
    expect(view.active().turns[0]?.status).toBe('running');
    expect(view.active().turns[0]?.endedAt).toBeUndefined();
    const finalStates = (): unknown[] =>
      view
        .patches()
        .flatMap((patch) => patch.ops)
        .filter(
          (op) =>
            op.op === 'set' &&
            JSON.stringify(op.path) === '["active","turns",0]' &&
            (op.value as { status?: string }).status === 'completed',
        );
    expect(finalStates()).toEqual([]);

    gate.resolve();
    const turn = await finishedTurn(h, view);
    expect(turn.status).toBe('completed');
    expect(turn.endedAt).toBeDefined();
    expect(finalStates()).toHaveLength(1);
    expect(noticesOf(view)).toEqual([{ kind: 'notice', level: 'info', text: 'Done checking.' }]);
    expect(h.controller.runningTurns()).toBe(0);
    view.expectMirror();
  });
});
