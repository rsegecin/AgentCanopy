import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateExtension, waitFor } from './support/host';

suite('editor port', () => {
  let file: string;
  let original: string;

  suiteSetup(() => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder);
    file = path.join(folder.uri.fsPath, 'hello.txt');
    original = fs.readFileSync(file, 'utf8');
  });

  teardown(async () => {
    // Restore through the editor, not the disk, so the open document never sees a foreign write.
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    if (document.getText() !== original) {
      const restore = new vscode.WorkspaceEdit();
      const everything = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      restore.replace(document.uri, everything, original);
      await vscode.workspace.applyEdit(restore);
      await document.save();
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
  });

  test('an edited file is dirty until it is saved, and saving is reported', async () => {
    const { editor } = await activateExtension();
    const saved: string[] = [];
    const unsubscribe = editor.onDidSave((p) => saved.push(p));
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      assert.deepStrictEqual(editor.dirtyFiles(), []);
      assert.strictEqual(editor.isDirty(file), false);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), 'edited ');
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

      assert.ok(editor.dirtyFiles().includes(document.uri.fsPath));
      assert.strictEqual(editor.isDirty(file), true);
      assert.strictEqual(
        editor.isDirty(path.join(path.dirname(file), '.', path.basename(file))),
        true,
      );

      assert.strictEqual(await document.save(), true);
      await waitFor('the save notification', () => saved.length > 0);
      assert.deepStrictEqual(saved, [document.uri.fsPath]);
      assert.strictEqual(editor.isDirty(file), false);
      assert.deepStrictEqual(editor.dirtyFiles(), []);
    } finally {
      unsubscribe();
    }
  });

  test('an untitled document is not a dirty file', async () => {
    const { editor } = await activateExtension();
    const document = await vscode.workspace.openTextDocument({
      content: 'draft',
      language: 'text',
    });
    assert.strictEqual(document.uri.scheme, 'untitled');
    assert.ok(!editor.dirtyFiles().includes(document.uri.fsPath));
    assert.ok(editor.dirtyFiles().every((p) => path.isAbsolute(p)));
    assert.strictEqual(editor.isDirty(document.uri.fsPath), false);
  });

  test('after unsubscribing the listener is not called, and a throwing one breaks nobody', async () => {
    const { editor } = await activateExtension();
    const before: string[] = [];
    const after: string[] = [];
    const unsubscribeFirst = editor.onDidSave((p) => before.push(p));
    const throwing = editor.onDidSave(() => {
      throw new Error('listener failure');
    });
    const unsubscribeLast = editor.onDidSave((p) => after.push(p));
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), 'x');
      await vscode.workspace.applyEdit(edit);
      await document.save();
      await waitFor('both listeners', () =>
        before.length > 0 && after.length > 0 ? true : undefined,
      );

      unsubscribeFirst();
      await vscode.workspace.applyEdit(edit);
      await document.save();
      await waitFor('the second save', () => (after.length > 1 ? true : undefined));
      assert.strictEqual(before.length, 1, 'the unsubscribed listener was called again');
    } finally {
      unsubscribeFirst();
      throwing();
      unsubscribeLast();
    }
  });
  test('a decomposed spelling of a composed file name still matches', async () => {
    const { editor } = await activateExtension();
    const folder = path.dirname(file);
    const composed = path.join(folder, 'caf\u00e9.txt');
    const decomposed = path.join(folder, 'cafe\u0301.txt');
    assert.notStrictEqual(composed, decomposed);
    fs.writeFileSync(composed, 'coffee\n');
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(composed));
      await vscode.window.showTextDocument(document);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(document.uri, new vscode.Position(0, 0), 'edited ');
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
      assert.strictEqual(editor.isDirty(composed), true);
      assert.strictEqual(editor.isDirty(decomposed), true);
      assert.strictEqual(editor.dirtyFiles().length, 1);
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      fs.rmSync(composed, { force: true });
    }
  });

  test('a dirty notebook is a dirty file, and saving it is reported', async () => {
    const { editor } = await activateExtension();
    const notebook = path.join(path.dirname(file), 'scratch.ipynb');
    fs.writeFileSync(
      notebook,
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
    );
    const saved: string[] = [];
    const unsubscribe = editor.onDidSave((p) => saved.push(p));
    try {
      const document = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebook));
      assert.strictEqual(editor.isDirty(notebook), false);
      const edit = new vscode.WorkspaceEdit();
      edit.set(document.uri, [
        vscode.NotebookEdit.insertCells(0, [
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'print(1)', 'python'),
        ]),
      ]);
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
      assert.strictEqual(editor.isDirty(notebook), true);
      assert.ok(editor.dirtyFiles().includes(document.uri.fsPath));

      assert.strictEqual(await document.save(), true);
      await waitFor('the notebook save notification', () => (saved.length > 0 ? true : undefined));
      assert.deepStrictEqual(saved, [document.uri.fsPath]);
      assert.strictEqual(editor.isDirty(notebook), false);
    } finally {
      unsubscribe();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      // VS Code copies a saved file into its local history a moment later: do not pull it away.
      await new Promise((resolve) => setTimeout(resolve, 500));
      fs.rmSync(notebook, { force: true });
    }
  });
});
