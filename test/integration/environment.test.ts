import { createHash } from 'node:crypto';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { activateExtension } from './support/host';

suite('environment', () => {
  test('there is one folder with a 32 character key', async () => {
    const { environment } = await activateExtension();
    const folders = environment.folders();
    assert.strictEqual(folders.length, 1);
    const [folder] = folders;
    assert.ok(folder);
    assert.match(folder.key, /^[0-9a-f]{32}$/);
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace);
    assert.strictEqual(folder.path, workspace.uri.fsPath);
    assert.strictEqual(folder.name, workspace.name);
    const real = fs.realpathSync.native(workspace.uri.fsPath);
    assert.strictEqual(folder.key, createHash('sha256').update(real).digest('hex').slice(0, 32));
  });

  test('the workspace is trusted and storage is available', async () => {
    const { environment } = await activateExtension();
    assert.strictEqual(environment.trusted(), true);
    assert.ok(environment.storageDir());
  });
});
