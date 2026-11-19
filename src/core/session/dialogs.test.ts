import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initEvent } from '../../../test/fake-cli';
import { DEFAULT_SETTINGS } from '../../shared';
import type { PermissionPrompt } from '../../shared';
import { alwaysAllowDetail, directoryDialog, editDirectoryDialog, switchDialog } from './prompts';
import {
  FOLDER_KEY,
  assistantText,
  assistantToolUse,
  createHarness,
  createPlanTestPolicy,
  finishedTurn,
  resultStep,
  sendAndFinish,
  stateEvent,
  textScenario,
  until as untilQuickly,
  userToolResult,
  type Harness,
  type ScenarioSpec,
} from './test-support';

vi.setConfig({ testTimeout: 30_000 });
const until = (description: string, condition: () => boolean, timeoutMs = 20_000): Promise<void> =>
  untilQuickly(description, condition, timeoutMs);

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const allowed = { decision: 'accept', source: 'user_temporary' } as const;
const LRO = '‮';

/** Nothing in a dialog may still hold a line break or a direction override from outside text. */
function expectPlain(text: string, allowedBreaks = true): void {
  expect(text).not.toContain(LRO);
  if (!allowedBreaks) expect(text).not.toContain('\n');
}

describe('text from the model and the workspace in native dialogs', () => {
  it('shows a plan title on one line with its control characters written out', async () => {
    const title = `Evil\nSecond line${LRO}gnp.txt`;
    const plan = {
      title,
      objective: 'Do it.',
      stages: [{ id: 's1', title: 'Do', description: 'Do it.' }],
    };
    const submit: ScenarioSpec = {
      scenario: {
        steps: [
          stateEvent('running'),
          initEvent(),
          { callTool: { name: 'submit_plan', arguments: plan, saveAs: 'r' } },
          assistantText('done'),
          ...resultStep('done'),
        ],
      },
    };
    const h = await createHarness({
      policy: createPlanTestPolicy(),
      sequence: [submit, { scenario: textScenario('ok') }],
    });
    harnesses.push(h);
    const view = h.attach();
    await sendAndFinish(h, view, 'plan it', { mode: 'plan' });
    const saved = view.active().plan;
    if (!saved) throw new Error('no plan');
    view.send({
      type: 'plan.approve',
      planId: saved.id,
      version: 1,
      contentHash: saved.versions[0]?.contentHash,
    });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    const { detail } = h.ui.callsOf('confirm')[0]?.[0] as { detail: string };
    expect(detail).toContain('"Evil Second line\\u{202E}gnp.txt"');
    expectPlain(detail);
    expect(detail.split('\n')[0]).toContain('Version 1 of');
    view.expectMirror();
  });

  async function reviewable(files: string[], extra: object[] = []) {
    const steps: object[] = [stateEvent('running'), initEvent()];
    files.forEach((name, index) => {
      const id = `toolu_${index}`;
      const input = { file_path: `$CWD/${name}`, content: `${name}\n` };
      steps.push(assistantToolUse(id, 'Write', input), {
        permission: {
          toolName: 'Write',
          input,
          toolUseId: id,
          onAllow: [
            { writeFile: { path: `$CWD/${name}`, content: `${name}\n` } },
            userToolResult(id, 'ok', { decision: allowed }),
          ],
          onDeny: [],
        },
      });
    });
    steps.push(...extra, assistantText('done'), ...resultStep('done'));
    const h = await createHarness({
      realDefaults: true,
      noStart: true,
      sequence: [{ scenario: { steps } }],
    });
    harnesses.push(h);
    h.env.settingsValue = { ...DEFAULT_SETTINGS, editApproval: 'auto' };
    await h.controller.start();
    await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
    const view = h.attach();
    view.send({ type: 'turn.send', text: 'go', mode: 'agent', model: 'default' });
    await until('the turn to exist', () => (view.state?.active?.turns.length ?? 0) > 0);
    await finishedTurn(h, view);
    return { h, view };
  }

  it('writes out the paths in the reject dialogs', async () => {
    const weird = `ev${LRO}il.txt`;
    const { h, view } = await reviewableWithBare(weird);
    // Reject all lists files that were not made by a tool call, and the path is written out.
    h.ui.confirmAnswer = false;
    view.send({ type: 'review.rejectAll', includePaths: [weird, 'line\nbreak.txt'] });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    const { detail } = h.ui.callsOf('confirm')[0]?.[0] as { detail: string };
    expect(detail).toContain('- ev\\u{202E}il.txt');
    expect(detail).toContain('- line break.txt');
    expectPlain(detail);
    view.expectMirror();

    // A file that changed after the agent left it: the choice dialog names it safely too.
    const { h: second, view: other } = await reviewable([weird]);
    await fs.writeFile(join(second.workspace, weird), 'edited by the user\n');
    second.ui.chooseAnswers = [undefined];
    other.send({ type: 'review.rejectFile', path: weird });
    await until('the choice', () => second.ui.callsOf('choose').length === 1);
    const asked = second.ui.callsOf('choose')[0]?.[0] as { detail: string };
    expect(asked.detail.startsWith('ev\\u{202E}il.txt is no longer')).toBe(true);
    expectPlain(asked.detail);
    other.expectMirror();
  });

  async function reviewableWithBare(weird: string) {
    return reviewable(
      [],
      [
        { writeFile: { path: `$CWD/${weird}`, content: 'bare\n' } },
        { writeFile: { path: '$CWD/line\nbreak.txt', content: 'bare\n' } },
      ],
    );
  }

  it('writes out the name of a folder in the confirmation to delete stored data', async () => {
    const h = await createHarness({
      realDefaults: true,
      noStart: true,
      sequence: [{ scenario: textScenario('ok') }],
    });
    harnesses.push(h);
    h.env.folderList = [{ key: FOLDER_KEY, name: `wo\nrk${LRO}`, path: h.workspace }];
    await h.controller.start();
    await until('the baseline', () => h.tracker()?.status(FOLDER_KEY).state === 'ready');
    h.ui.confirmAnswer = false;
    await h.controller.purgeStoredFileData(FOLDER_KEY);
    const { detail } = h.ui.callsOf('confirm')[0]?.[0] as { detail: string };
    expect(detail.startsWith('For wo rk\\u{202E}: ')).toBe(true);
    expectPlain(detail);
  });
});

describe('text from the workspace and the model in the confirmations of permissions', () => {
  const weirdFolder = `D:\\wo\nrk${LRO}\\app`;
  const prompt = (
    kind: 'read-directory' | 'edit-directory' | 'web-site',
    rule: string,
  ): PermissionPrompt => ({
    id: 'p' as PermissionPrompt['id'],
    conversationId: 'c' as PermissionPrompt['conversationId'],
    turnId: 't' as PermissionPrompt['turnId'],
    toolCallId: 'tool',
    createdAt: 0,
    state: 'pending',
    displayHash: 'h',
    kind: 'permission',
    toolName: 'Read',
    category: 'read-outside',
    title: 'Read',
    detail: 'the detail',
    inputPreview: '',
    choices: ['allow-once', 'allow-always', 'deny'],
    alwaysRule: { kind, rule, runsProjectCode: false },
  });

  it('writes out line breaks and direction overrides in the folder, the directory and the host', () => {
    const details = [
      alwaysAllowDetail(prompt('read-directory', `E:\\li\nbs${LRO}\\shared`), weirdFolder),
      alwaysAllowDetail(prompt('edit-directory', `E:\\li\nbs${LRO}\\shared`), weirdFolder),
      alwaysAllowDetail(prompt('web-site', `docs${LRO}.example\n.com`), weirdFolder),
      directoryDialog(`E:\\li\nbs${LRO}\\shared`, weirdFolder).detail,
      editDirectoryDialog(`E:\\li\nbs${LRO}\\shared`, weirdFolder).detail,
      ...(['read-outside', 'web-fetch', 'web-search'] as const).map(
        (name) => switchDialog(name, weirdFolder).detail,
      ),
    ];
    for (const detail of details) {
      expectPlain(detail);
      expect(detail).toContain('wo\\u{000A}rk\\u{202E}\\app');
      // The only line breaks are the ones of the dialog's own layout.
      const [first = ''] = detail.split('\n\n');
      expect(first.split('\n').length).toBeLessThanOrEqual(2);
    }
    expect(details[0]).toContain('Directory: E:\\li\\u{000A}bs\\u{202E}\\shared\n');
    expect(details[1]).toContain('Directory: E:\\li\\u{000A}bs\\u{202E}\\shared\n');
    expect(details[2]).toContain('Site: docs\\u{202E}.example\\u{000A}.com\n');
    // Two names that differ only by such a character look different.
    expect(directoryDialog('E:\\a\u200Fb', weirdFolder).detail).not.toBe(
      directoryDialog('E:\\ab', weirdFolder).detail,
    );
    expect(editDirectoryDialog('E:\\a\u200Fb', weirdFolder).detail).not.toBe(
      editDirectoryDialog('E:\\ab', weirdFolder).detail,
    );
  });

  it('shows the whole directory and the whole host, however long', () => {
    const dir = `E:\\${'long-directory-name\\'.repeat(20)}end`;
    const host = `${'a'.repeat(60)}.example.com`;
    expect(directoryDialog(dir, 'D:\\app').detail).toContain(`Directory: ${dir}\n`);
    expect(editDirectoryDialog(dir, 'D:\\app').detail).toContain(`Directory: ${dir}\n`);
    expect(
      alwaysAllowDetail(
        {
          ...prompt('web-site', host),
          alwaysRule: { kind: 'web-site', rule: host, runsProjectCode: false },
        },
        'D:\\app',
      ),
    ).toContain(`Site: ${host}\n`);
  });
});

describe('deleting a conversation', () => {
  async function conversation(first: string) {
    const h = await createHarness({ sequence: [{ scenario: textScenario('ok') }] });
    harnesses.push(h);
    const view = h.attach();
    await sendAndFinish(h, view, first);
    return { h, view };
  }

  it('asks first, and does nothing when declined', async () => {
    const { h, view } = await conversation('my question');
    const id = view.active().meta.id;
    h.ui.confirmAnswer = false;
    view.send({ type: 'conversation.delete', conversationId: id });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    expect(h.ui.callsOf('confirm')[0]?.[0]).toEqual({
      title: 'Delete this conversation?',
      detail:
        '"my question" and its plan are deleted. Files and the checkpoint history are not affected.',
      confirmLabel: 'Delete',
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(view.current().conversations).toHaveLength(1);
    expect(view.current().active?.meta.id).toBe(id);
    view.expectMirror();

    h.ui.confirmAnswer = true;
    view.send({ type: 'conversation.delete', conversationId: id });
    await until('the conversation to go', () => view.current().conversations.length === 0);
    expect(view.current().active).toBeNull();
    view.expectMirror();
  });

  it('writes out the title in the question', async () => {
    const { h, view } = await conversation(`first\nline${LRO}x`);
    h.ui.confirmAnswer = false;
    view.send({ type: 'conversation.delete', conversationId: view.active().meta.id });
    await until('the question', () => h.ui.callsOf('confirm').length === 1);
    const { detail } = h.ui.callsOf('confirm')[0]?.[0] as { detail: string };
    expect(detail.startsWith('"first line\\u{202E}x" and its plan')).toBe(true);
    expectPlain(detail, false);
  });
});
