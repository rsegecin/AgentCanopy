import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type { CheckpointSummary, ConversationId } from '../../shared';
import {
  FOLDER_KEY,
  assistantText,
  assistantToolUse,
  createHarness,
  finishedTurn,
  resultStep,
  sleep,
  stateEvent,
  streamedText,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type TestView,
} from './test-support';
import { formatCheckpointTime } from './text';

vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const allowed = { decision: 'accept', source: 'user_temporary' } as const;

interface Edit {
  name: string;
  content: string;
}

/** An Agent turn that writes each file after an allowed permission request. */
function turnWriting(edits: Edit[]): ScenarioSpec {
  const steps: object[] = [stateEvent('running'), initEvent()];
  edits.forEach((edit, index) => {
    const id = `toolu_${edit.name}_${index}`;
    const input = { file_path: `$CWD/${edit.name}`, content: edit.content };
    steps.push(assistantToolUse(id, 'Write', input), {
      permission: {
        toolName: 'Write',
        input,
        toolUseId: id,
        onAllow: [
          { writeFile: { path: `$CWD/${edit.name}`, content: edit.content } },
          userToolResult(id, 'written', { decision: allowed }),
        ],
        onDeny: [],
      },
    });
  });
  steps.push(assistantText('done'), ...resultStep('done'));
  return { record: true, scenario: { steps } };
}

const hanging: ScenarioSpec = {
  record: true,
  scenario: { steps: [...streamedText(['working']), { hang: true }] },
};

const FIRST: Edit[] = [{ name: 'a.txt', content: 'a, first version\n' }];
const SECOND: Edit[] = [
  { name: 'a.txt', content: 'a, second version\n' },
  { name: 'b.txt', content: 'b after\n' },
];

async function checkpointHarness(
  sequence: ScenarioSpec[],
  options: HarnessOptions & {
    settings?: Partial<typeof DEFAULT_SETTINGS>;
    files?: Record<string, string>;
  } = {},
): Promise<{ h: Harness; view: TestView }> {
  const { settings, files = {}, ...rest } = options;
  const h = await createHarness({ realDefaults: true, noStart: true, sequence, ...rest });
  harnesses.push(h);
  h.env.settingsValue = { ...DEFAULT_SETTINGS, editApproval: 'auto', ...settings };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(h.workspace, name, '..'), { recursive: true });
    await fs.writeFile(join(h.workspace, name), content);
  }
  await h.controller.start();
  await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
  return { h, view: h.attach() };
}

async function agentTurn(h: Harness, view: TestView, text: string): Promise<void> {
  const active = view.state?.active;
  const before = active?.turns.length ?? 0;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'agent',
    model: 'default',
  });
  await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > before);
  await finishedTurn(h, view);
}

/** Two Agent turns: the first creates a.txt, the second changes a.txt and creates b.txt. */
async function twoTurns(options: HarnessOptions = {}) {
  const made = await checkpointHarness([turnWriting(FIRST), turnWriting(SECOND)], options);
  await agentTurn(made.h, made.view, 'step 1');
  await agentTurn(made.h, made.view, 'step 2');
  await until('two checkpoints', () => made.view.current().checkpoints.length === 2);
  return made;
}

const checkpoints = (view: TestView): CheckpointSummary[] => view.current().checkpoints;

async function read(h: Harness, name: string): Promise<string> {
  return fs.readFile(join(h.workspace, name), 'utf8');
}

async function exists(h: Harness, name: string): Promise<boolean> {
  return fs.access(join(h.workspace, name)).then(
    () => true,
    () => false,
  );
}

/** Previews the checkpoint that is `index` places down the list and waits for the preview. */
async function preview(view: TestView, index: number) {
  const target = checkpoints(view)[index];
  if (!target) throw new Error('no such checkpoint');
  view.send({ type: 'checkpoint.preview', operationId: target.operationId });
  await until('the preview', () => view.current().restorePreview !== null);
  const shown = view.current().restorePreview;
  if (!shown) throw new Error('no preview');
  return { target, shown, paths: shown.items.map((item) => item.path) };
}

function restore(view: TestView, token: string, paths: string[], andFork = false): void {
  view.send({ type: 'checkpoint.restore', token, paths, andFork });
}

// ---- the list and the preview -----------------------------------------------------------------------------

describe('the checkpoint list', () => {
  it('shows every operation of the folder, newest first, with the conversation title', async () => {
    const { view } = await twoTurns();
    const [newest, oldest] = checkpoints(view);
    expect(newest).toMatchObject({
      kind: 'agent-turn',
      filesChanged: 2,
      conversationTitle: 'step 1',
    });
    expect(oldest).toMatchObject({
      kind: 'agent-turn',
      filesChanged: 1,
      conversationTitle: 'step 1',
    });
    expect(newest?.at ?? 0).toBeGreaterThanOrEqual(oldest?.at ?? 0);
    view.expectMirror();
  });

  it('follows a rename, and leaves the title out once the conversation is deleted', async () => {
    const { view } = await twoTurns();
    const id = view.active().meta.id;
    view.send({ type: 'conversation.rename', conversationId: id, title: 'Renamed' });
    await until('the new title', () => checkpoints(view)[0]?.conversationTitle === 'Renamed');
    view.send({ type: 'conversation.delete', conversationId: id });
    await until('the title to go', () =>
      checkpoints(view).every((c) => c.conversationTitle === undefined),
    );
    expect(checkpoints(view)).toHaveLength(2);
    view.expectMirror();
  });
});

describe('previewing a checkpoint', () => {
  it('is shown in the view that asked and nowhere else, and can be cancelled', async () => {
    const { h, view } = await twoTurns();
    const other = h.attach();
    const { target, shown } = await preview(view, 0);
    expect(shown.targetOperationId).toBe(target.operationId);
    expect(shown.items.map((item) => item.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(other.current().restorePreview).toBeNull();

    view.send({ type: 'checkpoint.cancelPreview' });
    expect(view.current().restorePreview).toBeNull();
    view.expectMirror();
    other.expectMirror();
  });

  it('is dropped when the view opens another conversation or starts a new one', async () => {
    const { view } = await twoTurns();
    await preview(view, 0);
    view.send({ type: 'conversation.new' });
    expect(view.current().restorePreview).toBeNull();
    view.expectMirror();
  });

  it('opens a diff of one item, and says so when it cannot be shown as text', async () => {
    const { h, view } = await twoTurns();
    const { shown } = await preview(view, 0);
    view.send({ type: 'checkpoint.openDiff', token: shown.token, path: 'a.txt' });
    await until('the diff', () => h.ui.callsOf('showDiff').length === 1);
    expect(h.ui.callsOf('showDiff')[0]?.[0]).toEqual({
      title: 'a.txt (now ↔ after restore)',
      leftLabel: 'Now',
      leftText: 'a, second version\n',
      rightLabel: 'After Restore',
      rightText: 'a, first version\n',
    });

    view.send({ type: 'checkpoint.openDiff', token: shown.token, path: 'not-in-the-preview.txt' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({
      level: 'warning',
      text: 'This file cannot be shown as text.',
    });
    expect(h.ui.callsOf('showDiff')).toHaveLength(1);
  });
});

// ---- restoring --------------------------------------------------------------------------------------------

describe('restoring files', () => {
  it('does nothing when the confirmation is declined', async () => {
    const { h, view } = await twoTurns();
    const { shown, paths } = await preview(view, 0);
    h.ui.confirmAnswer = false;
    restore(view, shown.token, paths);
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    await sleep(80);
    expect(await read(h, 'a.txt')).toBe('a, second version\n');
    expect(view.current().restorePreview).not.toBeNull();
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('puts the files back after a confirmation, and records the restore', async () => {
    const { h, view } = await twoTurns();
    const { target, shown, paths } = await preview(view, 0);
    restore(view, shown.token, paths);
    await until('the toast', () => view.toasts.length === 1);
    expect(h.ui.callsOf('confirm')[0]?.[0]).toEqual({
      title: 'Restore 2 files?',
      detail: `They go back to what they were before the agent turn of ${formatCheckpointTime(target.at)}. You can undo this from the checkpoint history.`,
      confirmLabel: 'Restore Files',
    });
    expect(view.toasts[0]).toEqual({ level: 'info', text: 'Restored 2 files.' });
    expect(await read(h, 'a.txt')).toBe('a, first version\n');
    expect(await exists(h, 'b.txt')).toBe(false);
    expect(view.current().restorePreview).toBeNull();
    await until('the restore in the list', () => checkpoints(view)[0]?.kind === 'restore');
    // What the agent changed in the last turn is no longer pending review.
    await until('the entries to settle', () =>
      view.current().review.entries.every((entry) => entry.path !== 'b.txt'),
    );
    view.expectMirror();
  });

  it("counts the files with changes that were not the agent's", async () => {
    const { h, view } = await twoTurns();
    await fs.writeFile(join(h.workspace, 'a.txt'), 'a, edited by the user\n');
    const { shown, paths } = await preview(view, 0);
    const conflicted = shown.items.filter((item) => item.conflict !== undefined);
    expect(conflicted.length).toBeGreaterThan(0);
    const choosable = paths.filter(
      (path) => shown.items.find((item) => item.path === path)?.selectable === true,
    );
    restore(view, shown.token, choosable);
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    const detail = (h.ui.callsOf('confirm')[0]?.[0] as { detail: string }).detail;
    const chosenConflicts = shown.items.filter(
      (item) => item.conflict !== undefined && choosable.includes(item.path),
    ).length;
    expect(chosenConflicts).toBeGreaterThan(0);
    expect(detail).toContain(
      `${chosenConflicts} of them contain changes that were not the agent's, which will be discarded. `,
    );
    view.expectMirror();
  });

  it('refuses a token that is not the current preview', async () => {
    const { h, view } = await twoTurns();
    const { paths } = await preview(view, 0);
    restore(view, 'not-the-token', paths);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({
      level: 'warning',
      text: 'That preview is out of date. Preview the checkpoint again.',
    });
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(await read(h, 'a.txt')).toBe('a, second version\n');
  });

  it("shows the service's refusal and a fresh preview when the files changed after the preview", async () => {
    const { h, view } = await twoTurns();
    const { shown, paths } = await preview(view, 0);
    await fs.writeFile(join(h.workspace, 'b.txt'), 'b, edited after the preview\n');
    restore(view, shown.token, paths);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.level).toBe('warning');
    expect(view.toasts[0]?.text.length).toBeGreaterThan(0);
    expect(await read(h, 'a.txt')).toBe('a, second version\n');
    await until('a new preview', () => {
      const now = view.current().restorePreview;
      return now !== null && now.token !== shown.token;
    });
    view.expectMirror();
  });

  it("is refused with the service's message while an Agent turn runs", async () => {
    const { h, view } = await checkpointHarness([turnWriting(FIRST), hanging]);
    await agentTurn(h, view, 'step 1');
    await until('a checkpoint', () => checkpoints(view).length === 1);
    view.send({
      type: 'turn.send',
      conversationId: view.active().meta.id,
      text: 'keep going',
      mode: 'agent',
      model: 'default',
    });
    await until('the turn to run', () => h.requests.length === 2);
    view.send({ type: 'checkpoint.preview', operationId: checkpoints(view)[0]?.operationId });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({
      level: 'warning',
      text: 'An agent turn is running in this folder. Wait for it to finish.',
    });
    expect(view.current().restorePreview).toBeNull();
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
    view.expectMirror();
  });
});

describe('restoring and branching', () => {
  it('restores the files and branches the conversation at the message that started the turn', async () => {
    const { h, view } = await twoTurns();
    const parentId: ConversationId = view.active().meta.id;
    const { shown, paths } = await preview(view, 0);
    restore(view, shown.token, paths, true);
    await until('the branch', () => view.state?.active?.meta.id !== parentId);

    expect(await read(h, 'a.txt')).toBe('a, first version\n');
    expect(await exists(h, 'b.txt')).toBe(false);
    const branch = view.active();
    expect(branch.meta.fork?.parentId).toBe(parentId);
    // The branch keeps the first turn only, and the composer gets the message of the second back.
    expect(branch.turns).toHaveLength(1);
    expect(
      branch.messages.filter((m) => m.role === 'user').map((m) => m.role === 'user' && m.text),
    ).toEqual(['step 1']);
    await until('the prefill', () =>
      view.events.some((event) => event.kind === 'prefill-composer' && event.text === 'step 2'),
    );
    // The files are exactly as they were at that point, so the branch has nothing newer to warn about.
    expect(
      branch.messages.flatMap((m) =>
        m.role === 'assistant'
          ? m.parts.filter(
              (part) =>
                part.kind === 'notice' &&
                part.text.startsWith('The files in the workspace include changes'),
            )
          : [],
      ),
    ).toEqual([]);
    view.expectMirror();
  });

  it('restores only, and says so, when the conversation of the checkpoint is gone', async () => {
    const { h, view } = await twoTurns();
    await preview(view, 0);
    // Deleting the conversation clears the view's preview, so ask again afterwards.
    view.send({ type: 'conversation.delete', conversationId: view.active().meta.id });
    await until('the conversation to go', () => view.current().conversations.length === 0);
    const again = await preview(view, 0);
    expect(again.shown.token).not.toBe('');
    restore(view, again.shown.token, again.paths, true);
    await until('both messages', () => view.toasts.length === 2);
    expect(view.toasts.map((toast) => toast.text)).toEqual([
      'Restored 2 files.',
      'The files were restored. The conversation of that checkpoint no longer exists, so no branch was created.',
    ]);
    expect(await read(h, 'a.txt')).toBe('a, first version\n');
    expect(view.current().conversations).toHaveLength(0);
    view.expectMirror();
  });
});

describe('previews of several views', () => {
  it('belong to the view that asked: each restores from its own', async () => {
    const { h, view } = await twoTurns();
    const other = h.attach();
    const [newest, oldest] = checkpoints(view);
    view.send({ type: 'checkpoint.preview', operationId: newest?.operationId });
    other.send({ type: 'checkpoint.preview', operationId: oldest?.operationId });
    await until(
      'both previews',
      () => view.current().restorePreview !== null && other.current().restorePreview !== null,
    );
    const mine = view.current().restorePreview;
    const theirs = other.current().restorePreview;
    expect(mine?.token).not.toBe(theirs?.token);

    // A token that belongs to another view's preview is not this view's to use.
    restore(view, theirs?.token ?? '', ['a.txt']);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('That preview is out of date. Preview the checkpoint again.');
    expect(h.ui.callsOf('confirm')).toEqual([]);

    // The view's own preview still works after the other view asked for one.
    restore(view, mine?.token ?? '', mine?.items.map((item) => item.path) ?? []);
    await until('the restore', () => view.toasts.length === 2);
    expect(view.toasts[1]).toEqual({ level: 'info', text: 'Restored 2 files.' });
    expect(await read(h, 'a.txt')).toBe('a, first version\n');
    view.expectMirror();
    other.expectMirror();
  });

  it("only lets the chosen paths be items of the view's preview", async () => {
    const { h, view } = await twoTurns();
    const { shown } = await preview(view, 0);
    restore(view, shown.token, ['a.txt', 'not-in-the-preview.txt']);
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({
      level: 'warning',
      text: 'One of the chosen files cannot be restored from this preview.',
    });
    restore(view, shown.token, []);
    await until('a second toast', () => view.toasts.length === 2);
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(await read(h, 'a.txt')).toBe('a, second version\n');
    view.expectMirror();
  });

  it('is not shown in a view that moved on while it was being made', async () => {
    const { h, view } = await twoTurns();
    const service = h.checkpoints();
    if (!service) throw new Error('no service');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = service.preview.bind(service);
    service.preview = async (folderKey, operationId) => {
      await gate;
      return real(folderKey, operationId);
    };
    view.send({ type: 'checkpoint.preview', operationId: checkpoints(view)[0]?.operationId });
    view.send({ type: 'conversation.new' });
    release();
    await sleep(200);
    expect(view.current().restorePreview).toBeNull();
    view.expectMirror();
  });
});

describe('what a restore tells the rest of the application', () => {
  it("reaches the review service's listeners", async () => {
    const { h, view } = await twoTurns();
    const engine = h.engine();
    if (!engine) throw new Error('no engine');
    let heard = 0;
    engine.onDidChange(() => {
      heard += 1;
    });
    const { shown, paths } = await preview(view, 0);
    restore(view, shown.token, paths);
    await until('the restore', () => view.toasts.length === 1);
    await until('the review service to hear of it', () => heard > 0);
    view.expectMirror();
  });
});

describe('restoring after "Undo Only the Agent\'s Changes"', () => {
  it("counts the hand edit it kept as a change that is not the agent's", async () => {
    const original = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
    const agent = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
    const { h, view } = await checkpointHarness(
      [turnWriting([{ name: 'b.txt', content: agent }])],
      { files: { 'b.txt': original } },
    );
    await agentTurn(h, view, 'step 1');
    await until('a checkpoint', () => checkpoints(view).length === 1);
    // The user adds a line, then rejects only what the agent did: their line stays.
    await fs.writeFile(join(h.workspace, 'b.txt'), `${agent}eleven, by the user\n`);
    h.ui.chooseAnswers = ['agent-only'];
    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await sleep(300);
    expect(await read(h, 'b.txt')).toBe(`${original}eleven, by the user\n`);

    // The list is newest first and the rejection is now a checkpoint too: preview the agent turn,
    // the step whose undoing would write the file from before the user's line existed.
    await until('the rejection to be listed', () => checkpoints(view).length === 2);
    const turnIndex = checkpoints(view).findIndex((entry) => entry.kind === 'agent-turn');
    const { shown } = await preview(view, turnIndex);
    const item = shown.items.find((candidate) => candidate.path === 'b.txt');
    expect(item?.conflict).toBeDefined();
    restore(view, shown.token, ['b.txt']);
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    expect((h.ui.callsOf('confirm')[0]?.[0] as { detail: string }).detail).toContain(
      "1 of them contain changes that were not the agent's, which will be discarded. ",
    );
    view.expectMirror();
  });
});

describe('restoring and branching when the restore is not complete', () => {
  it('stays where the user is, and says which files were not restored', async () => {
    const { h, view } = await checkpointHarness([
      turnWriting([
        { name: 'sub/one.txt', content: 'one\n' },
        { name: 'a.txt', content: 'a\n' },
      ]),
    ]);
    await agentTurn(h, view, 'step 1');
    await until('a checkpoint', () => checkpoints(view).length === 1);
    const id = view.active().meta.id;
    const { shown, paths } = await preview(view, 0);
    const sub = join(h.workspace, 'sub');
    await fs.chmod(sub, 0o500);
    try {
      restore(view, shown.token, paths, true);
      await until('the toasts', () => view.toasts.length >= 2);
    } finally {
      await fs.chmod(sub, 0o700);
    }
    expect(view.toasts[0]?.level).toBe('warning');
    expect(view.toasts[0]?.text).toMatch(/^Restored 1 of 2 files\./);
    expect(view.toasts[1]?.level).toBe('warning');
    expect(view.toasts[1]?.text).toContain('No branch was created');
    expect(view.toasts[1]?.text).toContain('sub/one.txt: ');
    expect(view.active().meta.id).toBe(id);
    expect(view.current().conversations).toHaveLength(1);
    expect(view.events.some((event) => event.kind === 'prefill-composer')).toBe(false);
    view.expectMirror();
  });
});

describe('keeping the history short', () => {
  it('prunes after a turn, and the list shrinks to what retention keeps', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    let now = Date.now();
    const clock = { now: () => now };
    const turns = 8;
    const specs = Array.from({ length: turns }, (_, index) =>
      turnWriting([{ name: 'a.txt', content: `version ${index + 1}\n` }]),
    );
    const { h, view } = await checkpointHarness(specs, {
      clock,
      settings: { retentionOperations: 1, retentionDays: 1 },
    });
    const service = h.checkpoints();
    if (!service) throw new Error('no checkpoint service');
    const calls: string[] = [];
    const prune = service.prune.bind(service);
    service.prune = (folderKey, settings) => {
      calls.push(folderKey);
      return prune(folderKey, settings);
    };

    for (let index = 0; index < turns; index += 1) {
      await agentTurn(h, view, `step ${index + 1}`);
      view.send({ type: 'review.acceptAll' });
      await until('the entries to be accepted', () =>
        view.current().review.entries.every((entry) => entry.status === 'accepted'),
      );
      // Everything so far is a long time ago.
      now += 3 * DAY;
    }
    await until('prune to have been asked for every turn', () => calls.length >= turns);
    expect(new Set(calls)).toEqual(new Set([FOLDER_KEY]));
    // Only the newest few operations are always kept, whatever the settings say.
    await until('the list to shrink', () => checkpoints(view).length < turns);
    expect(checkpoints(view).length).toBeGreaterThanOrEqual(1);
    view.expectMirror();
  });
});
