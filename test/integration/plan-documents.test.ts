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

  test('the same key gives the same document, and setting it again replaces the text', async () => {
    const first = createVirtualDocument('one\n', 'Plan v1', 'plan-p1-v1');
    const again = createVirtualDocument('two\n', 'Plan v1', 'plan-p1-v1');
    const other = createVirtualDocument('two\n', 'Plan v1', 'plan-p1-v2');
    assert.strictEqual(first.toString(), again.toString());
    assert.notStrictEqual(first.toString(), other.toString());
    assert.strictEqual((await vscode.workspace.openTextDocument(first)).getText(), 'two\n');
    // Without a key every call is a new document.
    assert.notStrictEqual(
      createVirtualDocument('x', 'Plan v1').toString(),
      createVirtualDocument('x', 'Plan v1').toString(),
    );
  });

  test('showReadOnlyDocument opens the text once per key, even when called twice', async () => {
    const { ui } = await activateExtension();
    const key = 'plan-integration-v1';
    const text = '# Plan\n\nstep one\n';
    await ui.showReadOnlyDocument({ key, title: 'Plan (version 1)', text });
    await ui.showReadOnlyDocument({ key, title: 'Plan (version 1)', text, beside: true });

    const tabs = (): vscode.Tab[] =>
      vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.filter(
          (tab) =>
            tab.input instanceof vscode.TabInputText &&
            tab.input.uri.scheme === VIRTUAL_DOCUMENT_SCHEME,
        ),
      );
    await waitFor('the document tab', () => (tabs().length > 0 ? true : undefined));
    assert.strictEqual(tabs().length, 1);
    const input = tabs()[0]?.input;
    assert.ok(input instanceof vscode.TabInputText);
    assert.strictEqual(tabs()[0]?.isPreview, false);
    const document = await vscode.workspace.openTextDocument(input.uri);
    assert.strictEqual(document.getText(), text);
    assert.notStrictEqual(vscode.workspace.fs.isWritableFileSystem(input.uri.scheme), true);
    await assert.rejects(async () => {
      await vscode.workspace.fs.writeFile(input.uri, new TextEncoder().encode('x'));
    });
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      input.uri.toString(),
    );
  });

  test('a long label cannot cut off the version prefix of a keyed document', () => {
    const uri = createVirtualDocument('x', `Plan v3 - ${'L'.repeat(300)}`, 'plan-long-v3');
    const basename = uri.path.split('/').pop() ?? '';
    assert.ok(basename.startsWith('Plan v3 - '), basename);
  });

  test('setting a keyed document again reloads the open editor with the new text', async () => {
    const key = 'plan-reload-v1';
    const uri = createVirtualDocument('old text\n', 'Plan v1 - Reload', key);
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(document.getText(), 'old text\n');
    createVirtualDocument('new text\n', 'Plan v1 - Reload', key);
    await waitFor('the document to reload', () =>
      document.getText() === 'new text\n' ? true : undefined,
    );
  });

  test('a keyed document that was set again counts as the newest entry', async () => {
    const key = 'plan-order-v1';
    const uri = createVirtualDocument('keyed first\n', 'Plan v1 - Order', key);
    for (let i = 0; i < 39; i++) createVirtualDocument(`filler ${String(i)}`, 'filler');
    // Setting it again makes it the newest: the next 39 fillers must not evict it.
    createVirtualDocument('keyed first\n', 'Plan v1 - Order', key);
    for (let i = 0; i < 39; i++) createVirtualDocument(`more ${String(i)}`, 'filler');
    const document = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(document.getText(), 'keyed first\n');
  });
});
