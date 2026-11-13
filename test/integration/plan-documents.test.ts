import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { VIRTUAL_DOCUMENT_SCHEME } from '../../src/vscode/plan/virtual-documents';
import type { HostTestApi } from '../../src/vscode/host';
import { activateExtension, waitFor } from './support/host';

suite('plan documents', () => {
  // The texts live in the extension's copy of the module, so the tests go through its API.
  let createVirtualDocument: HostTestApi['createVirtualDocument'];

  suiteSetup(async () => {
    ({ createVirtualDocument } = await activateExtension());
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('a virtual document can be read back', async () => {
    const uri = createVirtualDocument('# Plan\n\nstep one\n', 'Plan v1');
    assert.strictEqual(uri.scheme, VIRTUAL_DOCUMENT_SCHEME);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(document.getText(), '# Plan\n\nstep one\n');
  });

  test('an unknown id reads as empty', async () => {
    const uri = vscode.Uri.from({
      scheme: VIRTUAL_DOCUMENT_SCHEME,
      path: '/does-not-exist/Plan.md',
    });
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(document.getText(), '');
  });

  test('the label is sanitised to one path segment', () => {
    const uri = createVirtualDocument('x', '../../etc/pass\u0000wd\n\u001b[31m/..\\x');
    const segments = uri.path.split('/').slice(1);
    assert.strictEqual(segments.length, 2, uri.path);
    assert.match(segments[0] ?? '', /^[0-9a-f]+$/);
    assert.match(segments[1] ?? '', /^[A-Za-z0-9 ._-]+\.md$/);
    assert.ok(!(segments[1] ?? '').includes('/'));
  });

  test('a long label is cut and an empty one gets a name', () => {
    const long = createVirtualDocument('x', 'a'.repeat(500));
    assert.ok((long.path.split('/')[2] ?? '').length <= 80 + '.md'.length);
    const empty = createVirtualDocument('x', '');
    assert.match(empty.path, /^\/[0-9a-f]+\/[^/]+\.md$/);
  });

  test('the oldest documents are evicted past 40', async () => {
    const first = createVirtualDocument('first', 'first');
    for (let i = 0; i < 40; i++) createVirtualDocument(`text ${String(i)}`, 'filler');
    const document = await vscode.workspace.openTextDocument(first);
    assert.strictEqual(document.getText(), '');
  });

  test('showDiff opens a diff editor on two documents that cannot be written back', async () => {
    const { ui } = await activateExtension();
    await ui.showDiff({
      title: 'Plan v1 vs v2',
      leftLabel: 'v1',
      leftText: 'one\n',
      rightLabel: 'v2',
      rightText: 'two\n',
    });
    const input = await waitFor('the diff tab', () => {
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff) return tab.input;
        }
      }
      return undefined;
    });
    assert.strictEqual(input.original.scheme, VIRTUAL_DOCUMENT_SCHEME);
    assert.strictEqual(input.modified.scheme, VIRTUAL_DOCUMENT_SCHEME);
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(input.original)).getText(),
      'one\n',
    );
    assert.strictEqual(
      (await vscode.workspace.openTextDocument(input.modified)).getText(),
      'two\n',
    );

    // The API lets an extension edit the in-memory copy of a content-provider document (the editor
    // itself is read-only for the user), so what matters is that nothing can be written back.
    for (const uri of [input.original, input.modified]) {
      assert.notStrictEqual(vscode.workspace.fs.isWritableFileSystem(uri.scheme), true);
      await assert.rejects(async () => {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('x'));
      });
      const document = await vscode.workspace.openTextDocument(uri);
      assert.strictEqual(document.isUntitled, false);
      assert.strictEqual(document.isDirty, false);
    }
  });

  test('showDocument opens an untitled document with the text and language', async () => {
    const { ui } = await activateExtension();
    await ui.showDocument({ text: '# Exported plan\n', language: 'markdown' });
    const editor = vscode.window.activeTextEditor;
    assert.ok(editor);
    assert.strictEqual(editor.document.isUntitled, true);
    assert.strictEqual(editor.document.languageId, 'markdown');
    assert.strictEqual(editor.document.getText(), '# Exported plan\n');
  });
});
