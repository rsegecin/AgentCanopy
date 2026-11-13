import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BASELINE_SCHEME } from '../../src/vscode/review/baseline-documents';
import { runTurn, useScenario, writeFilesScenario } from './support/agent-turns';
import { activateExtension, waitFor, waitForAsync } from './support/host';
import type { FolderKey } from '../../src/shared';
import type { HostTestApi } from '../../src/vscode/host';

const lines = (...text: string[]): string => text.map((t) => `${t}\n`).join('');
const ORIGINAL = lines(
  'line 1',
  'line 2',
  'line 3',
  'line 4',
  'line 5',
  'line 6',
  'line 7',
  'line 8',
);
/** Lines 2 and 7 changed: two separate hunks. */
const CHANGED = lines(
  'line 1',
  'line 2 by the agent',
  'line 3',
  'line 4',
  'line 5',
  'line 6',
  'line 7 by the agent',
  'line 8',
);
const HELLO = 'hello\n';
const CREATED = 'created-by-agent.txt';

async function lensesOf(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  return (
    await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri)
  ).filter(
    (lens) =>
      lens.command?.command.startsWith('agentcanopy.review.') ||
      lens.command?.command === 'workbench.action.files.save',
  );
}

const titles = (lenses: vscode.CodeLens[]): string[] =>
  lenses.map((lens) => lens.command?.title ?? '');

suite('native review of agent changes', () => {
  let api: HostTestApi;
  let folder: string;
  let file: string;
  let key: FolderKey;
  let restoreScenario: (() => void) | undefined;

  suiteSetup(async () => {
    api = await activateExtension();
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace);
    folder = workspace.uri.fsPath;
    file = path.join(folder, 'hello.txt');
    const [info] = api.environment.folders();
    assert.ok(info);
    key = info.key;
  });

  async function review() {
    const service = await waitFor('the review service', () => api.controller.review());
    return service;
  }

  setup(async () => {
    // Earlier tests may have left pending changes behind: accept them so each test starts clean.
    const service = await review();
    await service.acceptAll(key);
    fs.writeFileSync(file, ORIGINAL);
  });

  teardown(async () => {
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (open?.isDirty) await vscode.commands.executeCommand('workbench.action.files.revert');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    restoreScenario?.();
    restoreScenario = undefined;
    fs.writeFileSync(file, HELLO);
    fs.rmSync(path.join(folder, CREATED), { force: true });
    await (await review()).acceptAll(key);
    await api.review.refresh();
  });

  /** Runs an Agent turn that writes the files, and waits until the review lists the changes. */
  async function agentWrites(files: { name: string; content: string }[]): Promise<void> {
    restoreScenario = useScenario(writeFilesScenario(files));
    const state = await runTurn(api, 'change the files');
    assert.ok(
      state.active?.turns.some((turn) => turn.status === 'completed'),
      'the turn completed',
    );
    const service = await review();
    await waitForAsync('pending review entries', async () => {
      const entries = await service.entries(key);
      return files.every((f) => entries.some((e) => e.path === f.name && e.status === 'pending'));
    });
    await api.review.refresh();
  }

  async function openFile(): Promise<vscode.TextEditor> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    return vscode.window.showTextDocument(document);
  }

  async function waitForLenses(expected: number): Promise<vscode.CodeLens[]> {
    const uri = vscode.Uri.file(file);
    return waitForAsync(`${String(expected)} review lenses`, async () => {
      const found = await lensesOf(uri);
      return found.length === expected ? found : undefined;
    });
  }

  test('the baseline is the original, diffs and lenses appear, hunks reject and accept', async () => {
    await agentWrites([{ name: 'hello.txt', content: CHANGED }]);

    // The baseline document and its diff.
    await api.ui.openChangeDiff(key, 'hello.txt');
    const input = await waitFor('the diff tab', () => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff) return tab.input;
        }
      }
      return undefined;
    });
    assert.strictEqual(input.original.scheme, BASELINE_SCHEME);
    assert.strictEqual(input.modified.scheme, 'file');
    assert.strictEqual(input.modified.fsPath, file);
    const baseline = await vscode.workspace.openTextDocument(input.original);
    assert.strictEqual(baseline.getText(), ORIGINAL);
    await assert.rejects(async () => {
      await vscode.workspace.fs.writeFile(input.original, new TextEncoder().encode('x'));
    });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // Lenses: two file-level ones and three per hunk.
    await openFile();
    const lenses = await waitForLenses(2 + 3 * 2);
    const fileUri = vscode.Uri.file(file);
    // The status bar counts the pending entries, and the decorations mark both changed lines.
    assert.strictEqual(api.review.statusText(), '$(diff) 1 agent change');
    const marked = await waitFor('decorations on the open file', () => {
      const applied = api.review.appliedDecorations(fileUri);
      return applied && applied.modified.length > 0 ? applied : undefined;
    });
    assert.deepStrictEqual(marked.modified, [
      { startLine: 1, endLine: 1 },
      { startLine: 6, endLine: 6 },
    ]);
    assert.deepStrictEqual([marked.added, marked.removed, marked.removedAtEnd], [[], [], []]);
    assert.deepStrictEqual(titles(lenses.filter((l) => l.range.start.line === 0)).sort(), [
      'Accept File',
      'Reject File',
    ]);
    const accept = lenses.filter((l) => l.command?.title === 'Accept Change');
    assert.deepStrictEqual(
      accept.map((l) => l.range.start.line),
      [1, 6],
    );

    // Reject the first hunk: its lines come back on disk, the other change stays.
    const rejectFirst = lenses.find(
      (l) => l.command?.title === 'Reject Change' && l.range.start.line === 1,
    );
    assert.ok(rejectFirst?.command);
    await vscode.commands.executeCommand(
      rejectFirst.command.command,
      ...(rejectFirst.command.arguments as unknown[]),
    );
    await waitFor('line 2 restored on disk', () =>
      fs.readFileSync(file, 'utf8') === CHANGED.replace('line 2 by the agent', 'line 2')
        ? true
        : undefined,
    );
    await waitForLenses(2 + 3);

    // Accepting the file removes every lens.
    const acceptFile = (await lensesOf(vscode.Uri.file(file))).find(
      (l) => l.command?.title === 'Accept File',
    );
    assert.ok(acceptFile?.command);
    await vscode.commands.executeCommand(
      acceptFile.command.command,
      ...(acceptFile.command.arguments as unknown[]),
    );
    await waitForLenses(0);
    await waitFor('the status bar to hide', () =>
      api.review.statusText() === undefined ? true : undefined,
    );
    const cleared = api.review.appliedDecorations(fileUri);
    assert.ok(cleared);
    assert.deepStrictEqual(
      [cleared.added, cleared.modified, cleared.removed, cleared.removedAtEnd],
      [[], [], [], []],
    );
  });

  test('rejecting a file the agent created deletes it', async () => {
    await agentWrites([{ name: CREATED, content: 'made by the agent\n' }]);
    const created = path.join(folder, CREATED);
    assert.ok(fs.existsSync(created));
    await vscode.commands.executeCommand('agentcanopy.review.rejectFile', key, CREATED);
    await waitFor('the created file to be deleted', () =>
      !fs.existsSync(created) ? true : undefined,
    );
  });

  test('a file with unsaved changes shows only the save lens', async () => {
    await agentWrites([{ name: 'hello.txt', content: CHANGED }]);
    const editor = await openFile();
    await waitForLenses(2 + 3 * 2);
    await editor.edit((builder) => {
      builder.insert(new vscode.Position(0, 0), 'unsaved ');
    });
    const lenses = await waitForLenses(1);
    assert.deepStrictEqual(titles(lenses), ["Save to review the agent's changes"]);
  });

  test('nextChange and previousChange move the cursor between hunks and wrap', async () => {
    await agentWrites([{ name: 'hello.txt', content: CHANGED }]);
    const editor = await openFile();
    await waitForLenses(2 + 3 * 2);
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const line = (): number => editor.selection.active.line;

    await vscode.commands.executeCommand('agentcanopy.review.nextChange');
    assert.strictEqual(line(), 1);
    await vscode.commands.executeCommand('agentcanopy.review.nextChange');
    assert.strictEqual(line(), 6);
    await vscode.commands.executeCommand('agentcanopy.review.nextChange');
    assert.strictEqual(line(), 1, 'wraps to the first change');
    await vscode.commands.executeCommand('agentcanopy.review.previousChange');
    assert.strictEqual(line(), 6, 'wraps to the last change');
  });
});
