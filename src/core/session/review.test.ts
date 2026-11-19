import { promises as fs, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type { AssistantMessage, ChangesPart, FolderKey, ReviewEntry } from '../../shared';
import type { OperationRecord, ReviewService } from '../contracts';
import {
  FOLDER_KEY,
  FakeEditor,
  assistantText,
  assistantToolUse,
  createHarness,
  finishedTurn,
  resultStep,
  sleep,
  stateEvent,
  streamedText,
  textScenario,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type HarnessOptions,
  type ScenarioSpec,
  type TestView,
} from './test-support';

// A real tracker and review engine read the folder, and the machine may be busy: allow more time.
vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const allowed = { decision: 'accept', source: 'user_temporary' } as const;
const SECOND_FOLDER = 'folder-2' as FolderKey;

const ORIGINAL_B = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
const AGENT_B = 'one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nNINE\nten\n';

// ---- scenarios ---------------------------------------------------------------------------------------

interface Edit {
  name: string;
  content: string;
}

/** An Agent turn that writes each file after an allowed permission request. */
function editsScenario(edits: Edit[], extra: object[] = []): ScenarioSpec {
  const steps: object[] = [stateEvent('running'), initEvent()];
  edits.forEach((edit, index) => {
    const toolUseId = `toolu_${index}`;
    const input = { file_path: `$CWD/${edit.name}`, content: edit.content };
    steps.push(assistantToolUse(toolUseId, 'Write', input), {
      permission: {
        toolName: 'Write',
        input,
        toolUseId,
        onAllow: [
          { writeFile: { path: `$CWD/${edit.name}`, content: edit.content } },
          userToolResult(toolUseId, 'written', { decision: allowed }),
        ],
        onDeny: [],
      },
    });
  });
  steps.push(...extra, assistantText('done'), ...resultStep('done'));
  return { record: true, scenario: { steps } };
}

const DEFAULT_EDITS: Edit[] = [
  { name: 'a.txt', content: 'brand new\n' },
  { name: 'b.txt', content: AGENT_B },
];

function textSpec(): ScenarioSpec {
  return { record: true, scenario: textScenario('ok') };
}

const hanging: ScenarioSpec = {
  record: true,
  scenario: { steps: [...streamedText(['working']), { hang: true }] },
};

// ---- helpers -----------------------------------------------------------------------------------------

/** A started application over a folder that holds `b.txt`, with a view attached and the baseline ready. */
async function reviewHarness(
  sequence: ScenarioSpec[],
  options: HarnessOptions & { files?: Record<string, string> } = {},
): Promise<{ h: Harness; view: TestView }> {
  const { files = { 'b.txt': ORIGINAL_B }, ...rest } = options;
  const h = await createHarness({ realDefaults: true, noStart: true, sequence, ...rest });
  harnesses.push(h);
  h.env.settingsValue = { ...DEFAULT_SETTINGS, editApproval: 'auto' };
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(join(h.workspace, name, '..'), { recursive: true });
    await fs.writeFile(join(h.workspace, name), content);
  }
  const second = join(h.root, 'second');
  await fs.mkdir(second);
  h.env.folderList = [...h.env.folderList, { key: SECOND_FOLDER, name: 'second', path: second }];
  await h.controller.start();
  await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
  return { h, view: h.attach() };
}

async function agentTurn(h: Harness, view: TestView, text = 'go') {
  const active = view.state?.active;
  view.send({
    type: 'turn.send',
    ...(active ? { conversationId: active.meta.id } : {}),
    text,
    mode: 'agent',
    model: 'default',
  });
  await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > 0);
  return finishedTurn(h, view);
}

function entriesOf(view: TestView): ReviewEntry[] {
  return view.current().review.entries;
}

function entry(view: TestView, path: string): ReviewEntry | undefined {
  return entriesOf(view).find((candidate) => candidate.path === path);
}

async function pendingEntries(view: TestView, count: number): Promise<void> {
  await until(`${count} pending entries`, () => {
    return entriesOf(view).filter((item) => item.status === 'pending').length === count;
  });
}

function operations(h: Harness): OperationRecord[] {
  const records = h.tracker()?.folder(FOLDER_KEY)?.log.records() ?? [];
  return records.filter((record): record is OperationRecord => record.type === 'operation');
}

async function read(h: Harness, name: string): Promise<string> {
  return fs.readFile(join(h.workspace, name), 'utf8');
}

/** The review service the editor integration uses: hunk review no longer goes through the view. */
function reviewService(h: Harness): ReviewService {
  const service = h.controller.review();
  if (!service) throw new Error('no review service');
  return service;
}

function assistantOf(view: TestView): AssistantMessage | undefined {
  return view.active().messages.find((m): m is AssistantMessage => m.role === 'assistant');
}

function noticesOf(view: TestView): string[] {
  return (assistantOf(view)?.parts ?? []).flatMap((part) =>
    part.kind === 'notice' ? [part.text] : [],
  );
}

function changesPartsOf(view: TestView): ChangesPart[] {
  return (assistantOf(view)?.parts ?? []).flatMap((part) =>
    part.kind === 'changes' ? [part] : [],
  );
}

/** The review records the folder's log holds. */
function reviewRecords(h: Harness): number {
  const records = h.tracker()?.folder(FOLDER_KEY)?.log.records() ?? [];
  return records.filter((record) => record.type === 'review').length;
}

const UNSAVED = 'Save or discard your unsaved changes in this file first.';

// ---- the tests -----------------------------------------------------------------------------------------

describe('review of agent changes', () => {
  it('lists what a turn changed in every view of the folder, and says so in the turn', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    const other = h.attach();
    const elsewhere = h.attach();
    elsewhere.send({ type: 'conversation.new', folder: SECOND_FOLDER });
    expect(entriesOf(view)).toEqual([]);

    await agentTurn(h, view);
    await pendingEntries(view, 2);
    expect(entriesOf(view).map((item) => [item.path, item.changeType, item.status])).toEqual([
      ['a.txt', 'created', 'pending'],
      ['b.txt', 'modified', 'pending'],
    ]);
    // The turn ends with one structured part, not a notice.
    const parts = assistantOf(view)?.parts ?? [];
    expect(parts[parts.length - 1]).toEqual({
      kind: 'changes',
      operationIds: operations(h).map((op) => op.id),
      files: [
        { path: 'a.txt', changeType: 'created' },
        { path: 'b.txt', changeType: 'modified' },
      ],
      more: 0,
    });
    expect(operations(h)).toHaveLength(1);
    expect(changesPartsOf(view)).toHaveLength(1);
    expect(noticesOf(view)).toEqual([]);
    expect(JSON.stringify(parts)).not.toContain('This turn changed');

    // A second view of the same folder (not showing the conversation) sees the same entries.
    other.send({ type: 'resync' });
    await sleep(50);
    expect(entriesOf(other)).toEqual(entriesOf(view));
    // A view on another folder shows nothing.
    expect(entriesOf(elsewhere)).toEqual([]);
    view.expectMirror();
    other.expectMirror();
    elsewhere.expectMirror();
  });

  it('reads the hunks of a file from the service, accepts one without writing, and has none once the file is accepted', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);
    const service = reviewService(h);

    const hunks = await service.hunks(FOLDER_KEY, 'b.txt');
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.currentLines.join('')).toContain('TWO');

    const before = entry(view, 'b.txt');
    const result = await service.acceptHunk(FOLDER_KEY, 'b.txt', hunks[0]?.id ?? '');
    expect(result).toEqual({ status: 'done' });
    await until(
      'the view to follow the accepted hunk',
      () => JSON.stringify(entry(view, 'b.txt')?.baseline) !== JSON.stringify(before?.baseline),
    );
    expect(await service.hunks(FOLDER_KEY, 'b.txt')).toHaveLength(1);
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(entry(view, 'b.txt')?.status).toBe('pending');

    view.send({ type: 'review.acceptFile', path: 'b.txt' });
    await until('the file to be accepted', () => entry(view, 'b.txt')?.status === 'accepted');
    expect(await service.hunks(FOLDER_KEY, 'b.txt')).toEqual([]);
    view.expectMirror();
  });

  it('rejects a hunk through the service: the file changes on disk and the view follows', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);
    const service = reviewService(h);
    const hunks = await service.hunks(FOLDER_KEY, 'b.txt');
    expect(hunks).toHaveLength(2);

    const before = entry(view, 'b.txt');
    expect(await service.rejectHunk(FOLDER_KEY, 'b.txt', hunks[0]?.id ?? '')).toEqual({
      status: 'done',
    });
    await until(
      'the view to follow the rejected hunk',
      () => JSON.stringify(entry(view, 'b.txt')?.current) !== JSON.stringify(before?.current),
    );
    expect(await read(h, 'b.txt')).toBe(AGENT_B.replace('TWO', 'two'));
    expect(await service.hunks(FOLDER_KEY, 'b.txt')).toHaveLength(1);
    expect(entry(view, 'b.txt')?.status).toBe('pending');
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('accepts a file and then everything, and leaves the files alone', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);

    view.send({ type: 'review.acceptFile', path: 'a.txt' });
    await pendingEntries(view, 1);
    expect(entry(view, 'a.txt')?.status).toBe('accepted');
    expect(entry(view, 'b.txt')?.status).toBe('pending');

    view.send({ type: 'review.acceptAll' });
    await pendingEntries(view, 0);
    expect(entriesOf(view).every((item) => item.status === 'accepted')).toBe(true);
    expect(await read(h, 'a.txt')).toBe('brand new\n');
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('rejects an unchanged file: it is restored, its entry goes, and a reject operation is logged', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);

    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('the entry to go', () => entry(view, 'b.txt') === undefined);
    expect(await read(h, 'b.txt')).toBe(ORIGINAL_B);
    expect(h.ui.callsOf('choose')).toEqual([]);
    expect(operations(h).map((op) => op.kind)).toEqual(['agent-turn', 'reject']);

    view.send({ type: 'review.rejectFile', path: 'a.txt' });
    await until('the entry to go', () => entry(view, 'a.txt') === undefined);
    await expect(fs.access(join(h.workspace, 'a.txt'))).rejects.toThrow();
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('opens the diff of a file and of all changes through the UI', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    view.send({ type: 'review.openDiff', path: 'b.txt' });
    view.send({ type: 'review.openAll' });
    await until('the UI calls', () => h.ui.callsOf('openAllChanges').length === 1);
    expect(h.ui.callsOf('openChangeDiff')).toEqual([[FOLDER_KEY, 'b.txt']]);
    expect(h.ui.callsOf('openAllChanges')).toEqual([[FOLDER_KEY]]);
  });
});

describe('the changes part at the end of a turn', () => {
  it('is not added by an Agent turn that changed nothing, nor by an Ask turn', async () => {
    const { h, view } = await reviewHarness([textSpec(), textSpec()]);
    await agentTurn(h, view);
    expect(changesPartsOf(view)).toEqual([]);

    view.send({
      type: 'turn.send',
      conversationId: view.active().meta.id,
      text: 'just a question',
      mode: 'ask',
      model: 'default',
    });
    await until('the second turn to exist', () => (view.state?.active?.turns.length ?? 0) === 2);
    await finishedTurn(h, view);
    const parts = view
      .active()
      .messages.flatMap((message) => (message.role === 'assistant' ? message.parts : []));
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.some((part) => part.kind === 'changes')).toBe(false);
    view.expectMirror();
  });

  it('is added when the turn was stopped after it changed files', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS, [{ hang: true }])]);
    view.send({ type: 'turn.send', text: 'go', mode: 'agent', model: 'default' });
    await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > 0);
    await until('both files to be written', () => {
      try {
        return (
          readFileSync(join(h.workspace, 'a.txt'), 'utf8') === 'brand new\n' &&
          readFileSync(join(h.workspace, 'b.txt'), 'utf8') === AGENT_B
        );
      } catch {
        return false;
      }
    });
    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
    const turn = await finishedTurn(h, view);

    expect(turn.status).toBe('interrupted');
    expect(changesPartsOf(view)).toEqual([
      {
        kind: 'changes',
        operationIds: operations(h).map((op) => op.id),
        files: [
          { path: 'a.txt', changeType: 'created' },
          { path: 'b.txt', changeType: 'modified' },
        ],
        more: 0,
      },
    ]);
    view.expectMirror();
  });

  it('lists at most 200 files and counts the rest', async () => {
    const many = Array.from({ length: 201 }, (_, index) => ({
      writeFile: {
        path: `$CWD/f${String(index).padStart(3, '0')}.txt`,
        content: `file ${index}\n`,
      },
    }));
    const { h, view } = await reviewHarness([editsScenario([], many)]);
    await agentTurn(h, view);
    await pendingEntries(view, 201);

    const [part] = changesPartsOf(view);
    expect(changesPartsOf(view)).toHaveLength(1);
    expect(part?.files).toHaveLength(200);
    expect(part?.more).toBe(1);
    expect(part?.files[0]).toEqual({ path: 'f000.txt', changeType: 'created' });
    expect(part?.files[199]).toEqual({ path: 'f199.txt', changeType: 'created' });
    view.expectMirror();
  });
});

describe('a bulk review action limited to some files', () => {
  it('accepts only the named files, in one review record', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);
    const before = reviewRecords(h);

    view.send({ type: 'review.acceptAll', paths: ['a.txt'] });
    await until('a.txt to be accepted', () => entry(view, 'a.txt')?.status === 'accepted');
    expect(entry(view, 'b.txt')?.status).toBe('pending');
    expect(reviewRecords(h)).toBe(before + 1);
    expect(await read(h, 'a.txt')).toBe('brand new\n');
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('rejects only the named files, and counts only those in the confirmation', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);

    h.ui.confirmAnswer = true;
    view.send({ type: 'review.rejectAll', includePaths: [], paths: ['a.txt'] });
    await until('a.txt to go', () => entry(view, 'a.txt') === undefined);
    expect(h.ui.callsOf('confirm')).toHaveLength(1);
    expect(h.ui.callsOf('confirm')[0]?.[0]).toMatchObject({ title: 'Reject 1 change?' });
    await expect(fs.access(join(h.workspace, 'a.txt'))).rejects.toThrow();
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(entry(view, 'b.txt')?.status).toBe('pending');
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('says there is nothing to reject when no named file is pending', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);

    view.send({ type: 'review.rejectAll', includePaths: [], paths: ['c.txt'] });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'info', text: 'There is nothing to reject.' });
    expect(h.ui.callsOf('confirm')).toEqual([]);
    expect(await read(h, 'a.txt')).toBe('brand new\n');
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(entriesOf(view).every((item) => item.status === 'pending')).toBe(true);
    view.expectMirror();
  });

  it('opens only the named files in the diff editor', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(h, view);
    view.send({ type: 'review.openAll', paths: ['a.txt'] });
    await until('the UI call', () => h.ui.callsOf('openAllChanges').length === 1);
    expect(h.ui.callsOf('openAllChanges')).toEqual([[FOLDER_KEY, ['a.txt']]]);
  });
});

describe('rejecting a file that changed after the agent edited it', () => {
  /** The agent changed lines 2 and 9; the user then edits the last line (not overlapping). */
  async function withLaterEdit(overlap = false) {
    const setup = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(setup.h, setup.view);
    await pendingEntries(setup.view, 2);
    const later = overlap
      ? AGENT_B.replace('TWO', 'TWO and the user')
      : `${AGENT_B}eleven by the user\n`;
    await fs.writeFile(join(setup.h.workspace, 'b.txt'), later);
    return { ...setup, later };
  }

  const askedFor = (h: Harness) => h.ui.callsOf('choose')[0]?.[0];

  it('asks with three options and "diff" opens the diff editor', async () => {
    const { h, view, later } = await withLaterEdit();
    h.ui.chooseAnswers = ['diff'];
    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('the diff', () => h.ui.callsOf('openChangeDiff').length === 1);
    expect(askedFor(h)).toEqual({
      title: 'This file changed after the agent edited it',
      detail: 'b.txt is no longer what the agent left. Choose what to do.',
      options: [
        { id: 'diff', label: 'Review in Diff Editor' },
        { id: 'agent-only', label: "Undo Only the Agent's Changes" },
        { id: 'overwrite', label: 'Discard Later Edits and Restore' },
      ],
    });
    expect(h.ui.callsOf('openChangeDiff')).toEqual([[FOLDER_KEY, 'b.txt']]);
    expect(await read(h, 'b.txt')).toBe(later);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it("undoes only the agent's changes and keeps the user's edit", async () => {
    const { h, view } = await withLaterEdit();
    h.ui.chooseAnswers = ['agent-only'];
    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('the agent changes to be undone', () => {
      try {
        return !readFileSync(join(h.workspace, 'b.txt'), 'utf8').includes('TWO');
      } catch {
        return false;
      }
    });
    expect(await read(h, 'b.txt')).toBe(`${ORIGINAL_B}eleven by the user\n`);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('restores the baseline when the user chooses to discard later edits', async () => {
    const { h, view } = await withLaterEdit();
    h.ui.chooseAnswers = ['overwrite'];
    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('the entry to go', () => entry(view, 'b.txt') === undefined);
    expect(await read(h, 'b.txt')).toBe(ORIGINAL_B);
    view.expectMirror();
  });

  it('changes nothing when the question is dismissed', async () => {
    const { h, view, later } = await withLaterEdit();
    h.ui.chooseAnswers = [undefined];
    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('the question', () => h.ui.callsOf('choose').length === 1);
    await sleep(80);
    expect(await read(h, 'b.txt')).toBe(later);
    expect(entry(view, 'b.txt')?.status).toBe('pending');
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it("refuses with a reason when the later edits overlap the agent's and agent-only is tried", async () => {
    const { h, view, later } = await withLaterEdit(true);
    h.ui.chooseAnswers = ['agent-only'];
    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.level).toBe('warning');
    expect(view.toasts[0]?.text).toContain('overlap');
    expect(await read(h, 'b.txt')).toBe(later);
    expect(entry(view, 'b.txt')?.status).toBe('pending');
    view.expectMirror();
  });

  it('leaves out the agent-only option for a file that cannot be compared line by line', async () => {
    const setup = await reviewHarness(
      [editsScenario([{ name: 'data.bin', content: 'agent\u0000bytes' }])],
      { files: { 'data.bin': 'original\u0000bytes' } },
    );
    await agentTurn(setup.h, setup.view);
    await pendingEntries(setup.view, 1);
    await fs.writeFile(join(setup.h.workspace, 'data.bin'), 'user\u0000edit');
    setup.h.ui.chooseAnswers = [undefined];
    setup.view.send({ type: 'review.rejectFile', path: 'data.bin' });
    await until('the question', () => setup.h.ui.callsOf('choose').length === 1);
    expect((askedFor(setup.h) as { options: { id: string }[] }).options.map((o) => o.id)).toEqual([
      'diff',
      'overwrite',
    ]);
    setup.view.expectMirror();
  });
});

describe('rejecting with unsaved changes', () => {
  it('is refused with a toast and writes nothing', async () => {
    const editor = new FakeEditor();
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)], { editor });
    await agentTurn(h, view);
    await pendingEntries(view, 2);
    editor.dirty = [join(h.workspace, 'b.txt')];

    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]).toEqual({ level: 'warning', text: UNSAVED });
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(h.ui.callsOf('choose')).toEqual([]);

    const service = reviewService(h);
    const hunk = (await service.hunks(FOLDER_KEY, 'b.txt'))[0];
    expect(await service.rejectHunk(FOLDER_KEY, 'b.txt', hunk?.id ?? '')).toEqual({
      status: 'conflict',
      reason: 'unsaved-editor',
      canRevertAgentOnly: false,
    });
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(view.toasts).toHaveLength(1);
    view.expectMirror();
  });
});

describe('rejecting everything', () => {
  it('lists what cannot be rejected, does nothing when declined, and restores when confirmed', async () => {
    const { h, view } = await reviewHarness([
      editsScenario([...DEFAULT_EDITS, { name: 'c.txt', content: 'third\n' }]),
    ]);
    await agentTurn(h, view);
    await pendingEntries(view, 3);
    // The user edits b.txt afterwards, so it cannot be rejected as a whole.
    await fs.writeFile(join(h.workspace, 'b.txt'), `${AGENT_B}by the user\n`);

    h.ui.confirmAnswer = false;
    view.send({ type: 'review.rejectAll', includePaths: [] });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    const asked = h.ui.callsOf('confirm')[0]?.[0] as { title: string; detail: string };
    expect(asked.title).toBe('Reject 2 changes?');
    expect(asked.detail).toContain(
      'The files go back to what they were before the agent changed them.',
    );
    expect(asked.detail).toContain('1 change cannot be rejected and stays as it is:\n- b.txt: ');
    expect(h.ui.callsOf('confirm')[0]?.[0]).toMatchObject({ confirmLabel: 'Reject Changes' });
    await sleep(80);
    expect(await read(h, 'a.txt')).toBe('brand new\n');
    expect(entriesOf(view)).toHaveLength(3);

    h.ui.confirmAnswer = true;
    view.send({ type: 'review.rejectAll', includePaths: [] });
    await until('the files to be restored', () => entry(view, 'a.txt') === undefined);
    await expect(fs.access(join(h.workspace, 'a.txt'))).rejects.toThrow();
    await expect(fs.access(join(h.workspace, 'c.txt'))).rejects.toThrow();
    expect(await read(h, 'b.txt')).toBe(`${AGENT_B}by the user\n`);
    // What the confirmation said cannot be rejected is not touched, and is not a failure either.
    await sleep(100);
    expect(view.toasts).toEqual([]);
    expect(entry(view, 'b.txt')?.status).toBe('pending');
    view.expectMirror();
  });

  it('leaves entries that were not attributed to the agent unless they are named', async () => {
    const { h, view } = await reviewHarness([
      // The file appears with no permission request and no hook around it.
      editsScenario(
        [{ name: 'a.txt', content: 'by a tool\n' }],
        [{ writeFile: { path: '$CWD/unknown.txt', content: 'who wrote this\n' } }],
      ),
    ]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);
    expect(entry(view, 'unknown.txt')?.attribution).not.toMatch(/^agent-/);

    h.ui.confirmAnswer = true;
    view.send({ type: 'review.rejectAll', includePaths: [] });
    await until('the agent file to go', () => entry(view, 'a.txt') === undefined);
    expect(await read(h, 'unknown.txt')).toBe('who wrote this\n');
    expect(entry(view, 'unknown.txt')?.status).toBe('pending');
    expect(h.ui.callsOf('confirm')[0]?.[0]).toMatchObject({ title: 'Reject 1 change?' });

    view.send({ type: 'review.rejectAll', includePaths: ['unknown.txt'] });
    await until('the other file to go', () => entry(view, 'unknown.txt') === undefined);
    await expect(fs.access(join(h.workspace, 'unknown.txt'))).rejects.toThrow();
    view.expectMirror();
  });

  it("says in the confirmation which files were not made by one of the agent's tool calls", async () => {
    const bare = Array.from({ length: 10 }, (_, index) => ({
      writeFile: { path: `$CWD/stray${index}.txt`, content: `stray ${index}\n` },
    }));
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS, bare)]);
    await agentTurn(h, view);
    await pendingEntries(view, 12);

    // The webview names the strays; the confirmation must not call them the agent's changes.
    const named = Array.from({ length: 10 }, (_, index) => `stray${index}.txt`);
    h.ui.confirmAnswer = false;
    view.send({ type: 'review.rejectAll', includePaths: named });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    const detail = (h.ui.callsOf('confirm')[0]?.[0] as { detail: string }).detail;
    expect(detail).toContain(
      "10 of them were not made by one of the agent's tool calls and may include your own work:\n- stray0.txt\n",
    );
    expect(detail).toContain('- stray7.txt\nand 2 more');
    expect(detail).not.toContain('stray8.txt');
    expect(detail).not.toContain('- a.txt');
    view.expectMirror();
  });

  it('only rejects what the confirmation counted', async () => {
    const { h, view } = await reviewHarness([
      editsScenario(DEFAULT_EDITS),
      editsScenario([{ name: 'late.txt', content: 'appeared while the question was open\n' }]),
    ]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);

    // While the user reads the confirmation, another conversation's turn leaves a new pending file.
    const other = h.attach();
    h.ui.onConfirm = async () => {
      h.ui.onConfirm = undefined;
      other.send({ type: 'turn.send', text: 'meanwhile', mode: 'agent', model: 'default' });
      await until('the other turn to start', () => h.requests.length === 2);
      await until('the other turn to end', () => h.controller.runningTurns() === 0);
    };
    view.send({ type: 'review.rejectAll', includePaths: [] });
    await until('the files to be restored', () => entry(view, 'a.txt') === undefined);

    expect(h.ui.callsOf('confirm')[0]?.[0]).toMatchObject({ title: 'Reject 2 changes?' });
    expect(await read(h, 'b.txt')).toBe(ORIGINAL_B);
    expect(await read(h, 'late.txt')).toBe('appeared while the question was open\n');
    await until('the late entry', () => entry(view, 'late.txt')?.status === 'pending');
    view.expectMirror();
    other.expectMirror();
  });

  it('says so when there is nothing to reject', async () => {
    const { h, view } = await reviewHarness([textSpec()]);
    view.send({ type: 'review.rejectAll', includePaths: [] });
    await until('a toast', () => view.toasts.length === 1);
    expect(view.toasts[0]?.text).toBe('There is nothing to reject.');
    expect(h.ui.callsOf('confirm')).toEqual([]);
  });

  it('tells the user about files it could not reject', async () => {
    const { h, view } = await reviewHarness([
      editsScenario([{ name: 'sub/new.txt', content: 'made by the agent\n' }]),
    ]);
    await agentTurn(h, view);
    await pendingEntries(view, 1);
    const sub = join(h.workspace, 'sub');
    await fs.chmod(sub, 0o500);
    try {
      view.send({ type: 'review.rejectAll', includePaths: [] });
      await until('a toast', () => view.toasts.length === 1);
      expect(view.toasts[0]).toEqual({
        level: 'warning',
        text: '1 change could not be rejected. It is still listed for review.',
      });
      expect(entry(view, 'sub/new.txt')?.status).toBe('pending');
    } finally {
      await fs.chmod(sub, 0o700);
    }
    view.expectMirror();
  });
});

describe('telling the agent what was reverted', () => {
  it('names the reverted paths in the next prompt, and not after an accept', async () => {
    const rejected = await reviewHarness([editsScenario(DEFAULT_EDITS), textSpec()]);
    await agentTurn(rejected.h, rejected.view);
    await pendingEntries(rejected.view, 2);
    rejected.view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('the entry to go', () => entry(rejected.view, 'b.txt') === undefined);
    await agentTurn(rejected.h, rejected.view, 'carry on');
    const prompt = (await rejected.h.record(1)).stdin;
    expect(prompt).toContain(
      'The user reverted these files since the last turn, so earlier edits to them no longer exist on disk:',
    );
    expect(prompt).toContain('- b.txt');

    const accepted = await reviewHarness([editsScenario(DEFAULT_EDITS), textSpec()]);
    await agentTurn(accepted.h, accepted.view);
    await pendingEntries(accepted.view, 2);
    accepted.view.send({ type: 'review.acceptAll' });
    await pendingEntries(accepted.view, 0);
    await agentTurn(accepted.h, accepted.view, 'carry on');
    expect((await accepted.h.record(1)).stdin).not.toContain('The user reverted these files');
  });
});

describe('cleaning up stored file contents', () => {
  it('removes a blob nothing refers to after a turn, and keeps everything that is referenced', async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    const folder = h.tracker()?.folder(FOLDER_KEY);
    if (!folder) throw new Error('no folder');
    // Let any clean-up from start-up finish first.
    await sleep(200);
    const junk = await folder.blobs.put(Buffer.from('nobody refers to this'));
    expect(await folder.blobs.has(junk)).toBe(true);

    await agentTurn(h, view);
    await pendingEntries(view, 2);
    for (let attempt = 0; attempt < 200 && (await folder.blobs.has(junk)); attempt += 1) {
      await sleep(25);
    }
    const referenced = await h.controller.review()?.entries(FOLDER_KEY);
    expect(referenced?.length).toBe(2);
    const kept = new Set(await folder.blobs.list());
    expect(kept.has(junk)).toBe(false);
    for (const hash of (await h.engine()?.referencedHashes(FOLDER_KEY)) ?? []) {
      expect(kept.has(hash)).toBe(true);
    }
    // The baseline of the file the agent changed is still there, so it can be rejected.
    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    await until('the entry to go', () => entry(view, 'b.txt') === undefined);
    expect(await read(h, 'b.txt')).toBe(ORIGINAL_B);
  });
});

describe('the clean-up of stored file contents is never run without roots', () => {
  async function started() {
    const made = await reviewHarness([editsScenario(DEFAULT_EDITS)]);
    await agentTurn(made.h, made.view);
    await pendingEntries(made.view, 2);
    const folder = made.h.tracker()?.folder(FOLDER_KEY);
    if (!folder) throw new Error('no folder');
    // Let the clean-up that follows the turn finish, then add a blob nothing refers to.
    await sleep(300);
    const junk = await folder.blobs.put(Buffer.from('nobody refers to this either'));
    const before = new Set(await folder.blobs.list());
    expect(before.has(junk)).toBe(true);
    return { ...made, folder, junk, before };
  }

  it('leaves every blob alone when the application is disposed before a queued clean-up runs', async () => {
    const { h, folder, before } = await started();
    let release: () => void = () => undefined;
    const held = folder.exclusive(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const collected = h.collectGarbage(FOLDER_KEY);
    const disposing = h.controller.dispose();
    await sleep(100);
    release();
    await held;
    await collected;
    await disposing;
    expect(new Set(await folder.blobs.list())).toEqual(before);
    expect(h.logger.has('info', 'stored file contents were not cleaned up')).toBe(true);
  });

  it('deletes nothing when the files in use cannot be listed', async () => {
    const { h, folder, before } = await started();
    const engine = h.engine();
    if (!engine) throw new Error('no engine');
    engine.referencedHashes = () => Promise.reject(new Error('the log could not be read'));
    await h.collectGarbage(FOLDER_KEY);
    expect(new Set(await folder.blobs.list())).toEqual(before);
    expect(h.logger.has('info', 'stored file contents were not cleaned up')).toBe(true);
  });

  it('still removes what nothing refers to when the roots are known', async () => {
    const { h, folder, junk, before } = await started();
    await h.collectGarbage(FOLDER_KEY);
    const after = new Set(await folder.blobs.list());
    expect(after.has(junk)).toBe(false);
    for (const hash of before) if (hash !== junk) expect(after.has(hash)).toBe(true);
  });
});

describe('review while an Agent turn runs', () => {
  const BUSY = 'An agent turn is running in this folder. Wait for it to finish.';

  it("refuses rejecting with the engine's message, and refuses accepting in words", async () => {
    const { h, view } = await reviewHarness([editsScenario(DEFAULT_EDITS), hanging]);
    await agentTurn(h, view);
    await pendingEntries(view, 2);
    const service = reviewService(h);
    const hunks = await service.hunks(FOLDER_KEY, 'b.txt');
    expect(hunks).toHaveLength(2);
    const hunkId = hunks[0]?.id ?? '';

    view.send({
      type: 'turn.send',
      conversationId: view.active().meta.id,
      text: 'keep going',
      mode: 'agent',
      model: 'default',
    });
    await until('the turn to run', () => h.requests.length === 2);
    const before = entriesOf(view);

    view.send({ type: 'review.rejectFile', path: 'b.txt' });
    view.send({ type: 'review.rejectAll', includePaths: [] });
    await until('two toasts', () => view.toasts.length === 2);
    expect(view.toasts).toEqual([
      { level: 'warning', text: BUSY },
      { level: 'warning', text: BUSY },
    ]);
    // The editor's hunk commands go to the service, which refuses in the same words.
    expect(await service.rejectHunk(FOLDER_KEY, 'b.txt', hunkId)).toEqual({
      status: 'refused',
      message: BUSY,
    });
    expect(h.ui.callsOf('confirm')).toEqual([]);

    // Accepting is refused in words, not ignored: the engine leaves everything as it is meanwhile.
    view.send({ type: 'review.acceptAll' });
    view.send({ type: 'review.acceptFile', path: 'a.txt' });
    await until('two more toasts', () => view.toasts.length === 4);
    expect(view.toasts.slice(2)).toEqual([
      { level: 'warning', text: 'Wait for the turn to finish before accepting changes.' },
      { level: 'warning', text: 'Wait for the turn to finish before accepting changes.' },
    ]);
    expect(await service.acceptHunk(FOLDER_KEY, 'b.txt', hunkId)).toEqual({
      status: 'refused',
      message: BUSY,
    });
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(entriesOf(view)).toEqual(before);

    view.send({ type: 'turn.cancel', conversationId: view.active().meta.id });
    await until('the turn to end', () => h.controller.runningTurns() === 0);
    view.expectMirror();
  });
});

// ---- the same flows without a view: commands and the review panel -------------------------------------------

describe('rejecting through the controller, without a view message', () => {
  const NOT_PENDING = 'That change is no longer pending.';

  async function setup(options: HarnessOptions & { edits?: Edit[] } = {}) {
    const { edits = DEFAULT_EDITS, ...rest } = options;
    const made = await reviewHarness([editsScenario(edits)], rest);
    await agentTurn(made.h, made.view);
    await pendingEntries(made.view, edits.length);
    return made;
  }

  const reject = (h: Harness, path: string) => h.controller.rejectFileInteractive(FOLDER_KEY, path);
  const rejectAll = (h: Harness, paths: string[] = []) =>
    h.controller.rejectAllInteractive(FOLDER_KEY, paths);

  it('rejects a file that is as the agent left it', async () => {
    const { h, view } = await setup();
    await reject(h, 'b.txt');
    await until('the entry to go', () => entry(view, 'b.txt') === undefined);
    expect(await read(h, 'b.txt')).toBe(ORIGINAL_B);
    expect(h.ui.callsOf('choose')).toEqual([]);
    expect(view.toasts).toEqual([]);
    view.expectMirror();
  });

  it('shows a refusal in every view of the folder and in no other', async () => {
    const { h, view } = await setup();
    const same = h.attach();
    const elsewhere = h.attach();
    elsewhere.send({ type: 'conversation.new', folder: SECOND_FOLDER });
    await reject(h, 'nothing-here.txt');
    expect(view.toasts).toEqual([{ level: 'warning', text: NOT_PENDING }]);
    expect(same.toasts).toEqual([{ level: 'warning', text: NOT_PENDING }]);
    expect(elsewhere.toasts).toEqual([]);
    same.expectMirror();
    elsewhere.expectMirror();
  });

  it('logs the message when no view shows the folder', async () => {
    const { h, view } = await setup();
    view.dispose();
    await reject(h, 'nothing-here.txt');
    expect(h.logger.has('info', 'a review message had no view to show it')).toBe(true);
  });

  it('refuses a path that is not a path of the folder', async () => {
    const { h, view } = await setup();
    await reject(h, '../outside.txt');
    expect(view.toasts).toEqual([
      { level: 'warning', text: 'That path is not inside the workspace folder.' },
    ]);
  });

  it('refuses while the file has unsaved changes in the editor', async () => {
    const editor = new FakeEditor();
    const { h, view } = await setup({ editor });
    editor.dirty = [join(h.workspace, 'b.txt')];
    await reject(h, 'b.txt');
    expect(view.toasts).toEqual([{ level: 'warning', text: UNSAVED }]);
    expect(await read(h, 'b.txt')).toBe(AGENT_B);
    expect(h.ui.callsOf('choose')).toEqual([]);
  });

  describe('for a file that changed after the agent edited it', () => {
    const later = `${AGENT_B}eleven by the user\n`;

    async function withLaterEdit() {
      const made = await setup();
      await fs.writeFile(join(made.h.workspace, 'b.txt'), later);
      return made;
    }

    it('offers the three options, and "diff" opens the diff editor', async () => {
      const { h } = await withLaterEdit();
      h.ui.chooseAnswers = ['diff'];
      await reject(h, 'b.txt');
      expect(h.ui.callsOf('choose')[0]?.[0]).toMatchObject({
        title: 'This file changed after the agent edited it',
        options: [{ id: 'diff' }, { id: 'agent-only' }, { id: 'overwrite' }],
      });
      expect(h.ui.callsOf('openChangeDiff')).toEqual([[FOLDER_KEY, 'b.txt']]);
      expect(await read(h, 'b.txt')).toBe(later);
    });

    it("keeps the user's edit when only the agent's changes are undone", async () => {
      const { h, view } = await withLaterEdit();
      h.ui.chooseAnswers = ['agent-only'];
      await reject(h, 'b.txt');
      expect(await read(h, 'b.txt')).toBe(`${ORIGINAL_B}eleven by the user\n`);
      expect(view.toasts).toEqual([]);
    });

    it('restores the baseline when the user discards later edits', async () => {
      const { h, view } = await withLaterEdit();
      h.ui.chooseAnswers = ['overwrite'];
      await reject(h, 'b.txt');
      await until('the entry to go', () => entry(view, 'b.txt') === undefined);
      expect(await read(h, 'b.txt')).toBe(ORIGINAL_B);
    });

    it('changes nothing when the question is dismissed', async () => {
      const { h, view } = await withLaterEdit();
      h.ui.chooseAnswers = [undefined];
      await reject(h, 'b.txt');
      expect(await read(h, 'b.txt')).toBe(later);
      expect(entry(view, 'b.txt')?.status).toBe('pending');
      expect(view.toasts).toEqual([]);
    });
  });

  describe("for an entry that may include the user's own work", () => {
    const ORIGINAL_U = 'u one\nu two\nu three\n';
    const AGENT_U = 'u one\nu TWO\nu three\n';

    /** The user saves the file in the editor while the agent is still working on it: `mixed`. */
    async function mixedEntry() {
      const editor = new FakeEditor();
      const slow: ScenarioSpec = editsScenario(DEFAULT_EDITS.slice(1), [{ sleep: 1500 }]);
      const made = await reviewHarness([slow], { editor });
      made.view.send({ type: 'turn.send', text: 'go', mode: 'agent', model: 'default' });
      await until('the agent to write', () => {
        try {
          return readFileSync(join(made.h.workspace, 'b.txt'), 'utf8') === AGENT_B;
        } catch {
          return false;
        }
      });
      editor.save(join(made.h.workspace, 'b.txt'));
      await finishedTurn(made.h, made.view);
      await pendingEntries(made.view, 1);
      expect(entry(made.view, 'b.txt')?.attribution).toBe('mixed');
      return { ...made, path: 'b.txt', original: ORIGINAL_B, agent: AGENT_B };
    }

    /** A file written by the fake CLI with no permission request and no hook around it. */
    async function unattributedEntry() {
      const made = await reviewHarness(
        [editsScenario([], [{ writeFile: { path: '$CWD/u.txt', content: AGENT_U } }])],
        { files: { 'u.txt': ORIGINAL_U } },
      );
      await agentTurn(made.h, made.view);
      await pendingEntries(made.view, 1);
      expect(entry(made.view, 'u.txt')?.attribution).toBe('unattributed');
      return { ...made, path: 'u.txt', original: ORIGINAL_U, agent: AGENT_U };
    }

    const kinds = { mixed: mixedEntry, unattributed: unattributedEntry };

    for (const [name, build] of Object.entries(kinds)) {
      describe(`(${name})`, () => {
        it('asks, and "diff" opens the diff editor without writing', async () => {
          const { h, view, path, agent } = await build();
          h.ui.chooseAnswers = ['diff'];
          await reject(h, path);
          expect(h.ui.callsOf('choose')).toEqual([
            [
              {
                title: 'This change may include your own work',
                detail: `${path}: AgentCanopy cannot tell the agent's changes apart from yours in this file. Restoring the earlier version discards everything changed since the turn started.`,
                options: [
                  { id: 'diff', label: 'Review in Diff Editor' },
                  { id: 'overwrite', label: 'Restore the Earlier Version' },
                ],
              },
            ],
          ]);
          expect(h.ui.callsOf('openChangeDiff')).toEqual([[FOLDER_KEY, path]]);
          expect(await read(h, path)).toBe(agent);
          expect(view.toasts).toEqual([]);
          view.expectMirror();
        });

        it('restores the earlier version when the user chooses to', async () => {
          const { h, view, path, original } = await build();
          h.ui.chooseAnswers = ['overwrite'];
          await reject(h, path);
          await until('the entry to go', () => entry(view, path) === undefined);
          expect(await read(h, path)).toBe(original);
          view.expectMirror();
        });

        it('changes nothing when the question is dismissed', async () => {
          const { h, view, path, agent } = await build();
          h.ui.chooseAnswers = [undefined];
          await reject(h, path);
          expect(await read(h, path)).toBe(agent);
          expect(entry(view, path)?.status).toBe('pending');
          expect(view.toasts).toEqual([]);
          view.expectMirror();
        });

        it('does not reject a single hunk, and asks nothing', async () => {
          const { h, view, path, agent } = await build();
          const service = reviewService(h);
          const hunk = (await service.hunks(FOLDER_KEY, path))[0];
          expect(await service.rejectHunk(FOLDER_KEY, path, hunk?.id ?? '')).toEqual({
            status: 'conflict',
            reason: 'uncertain-source',
            canRevertAgentOnly: false,
          });
          expect(view.toasts).toEqual([]);
          expect(await read(h, path)).toBe(agent);
          expect(h.ui.callsOf('choose')).toEqual([]);
          view.expectMirror();
        });
      });
    }
  });

  describe('everything at once', () => {
    const FOUR: Edit[] = [
      { name: 'a.txt', content: 'one\n' },
      { name: 'b.txt', content: AGENT_B },
      { name: 'c.txt', content: 'three\n' },
      { name: 'd.txt', content: 'four\n' },
    ];

    it('does nothing when the confirmation is declined', async () => {
      const { h, view } = await setup();
      h.ui.confirmAnswer = false;
      await rejectAll(h);
      expect(h.ui.callsOf('confirm')).toHaveLength(1);
      expect(await read(h, 'a.txt')).toBe('brand new\n');
      expect(entriesOf(view)).toHaveLength(2);
      expect(view.toasts).toEqual([]);
    });

    it('restores the files when confirmed', async () => {
      const { h, view } = await setup();
      await rejectAll(h);
      await until('the entries to go', () => entriesOf(view).length === 0);
      expect(await read(h, 'b.txt')).toBe(ORIGINAL_B);
      expect(h.ui.callsOf('confirm')[0]?.[0]).toEqual({
        title: 'Reject 2 changes?',
        detail: 'The files go back to what they were before the agent changed them.',
        confirmLabel: 'Reject Changes',
      });
      expect(view.toasts).toEqual([]);
    });

    it('uses the plural wording for several files that cannot be rejected, and stays quiet about them afterwards', async () => {
      const { h, view } = await setup({ edits: FOUR });
      await fs.writeFile(join(h.workspace, 'b.txt'), `${AGENT_B}by the user\n`);
      await fs.writeFile(join(h.workspace, 'd.txt'), 'four\nby the user\n');
      await rejectAll(h);
      const asked = h.ui.callsOf('confirm')[0]?.[0] as { title: string; detail: string };
      expect(asked.title).toBe('Reject 2 changes?');
      expect(asked.detail).toContain('2 changes cannot be rejected and stay as they are:\n- ');
      await until('the files to be restored', () => entry(view, 'a.txt') === undefined);
      await sleep(100);
      expect(view.toasts).toEqual([]);
      expect(entry(view, 'b.txt')?.status).toBe('pending');
      expect(entry(view, 'd.txt')?.status).toBe('pending');
    });

    it('uses the singular wording for a single file', async () => {
      const { h, view } = await setup({ edits: FOUR.slice(0, 3) });
      await fs.writeFile(join(h.workspace, 'b.txt'), `${AGENT_B}by the user\n`);
      await rejectAll(h);
      const asked = h.ui.callsOf('confirm')[0]?.[0] as { title: string; detail: string };
      expect(asked.title).toBe('Reject 2 changes?');
      expect(asked.detail).toContain('1 change cannot be rejected and stays as it is:\n- b.txt: ');
      await until('the files to be restored', () => entry(view, 'a.txt') === undefined);
      expect(view.toasts).toEqual([]);
    });

    it('tells the user when previewed files could not be written, with the plural and the singular wording', async () => {
      const { h, view } = await setup({
        edits: [
          { name: 'sub/one.txt', content: 'one\n' },
          { name: 'sub/two.txt', content: 'two\n' },
        ],
      });
      const sub = join(h.workspace, 'sub');
      await fs.chmod(sub, 0o500);
      try {
        await rejectAll(h);
        await until('the plural toast', () => view.toasts.length === 1);
        expect(view.toasts[0]).toEqual({
          level: 'warning',
          text: '2 changes could not be rejected. They are still listed for review.',
        });
      } finally {
        await fs.chmod(sub, 0o700);
      }
      view.expectMirror();
    });

    it('says so when there is nothing to reject', async () => {
      const { h, view } = await reviewHarness([textSpec()]);
      await rejectAll(h);
      expect(view.toasts).toEqual([{ level: 'info', text: 'There is nothing to reject.' }]);
    });
  });
});
