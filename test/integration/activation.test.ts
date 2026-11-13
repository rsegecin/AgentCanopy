import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { EXTENSION_ID, activateExtension } from './support/host';

interface Manifest {
  contributes: { commands: { command: string }[]; views: Record<string, { id: string }[]> };
}

suite('activation', () => {
  test('the extension activates', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test('the extension returns the test API in test mode', async () => {
    const api = await activateExtension();
    assert.strictEqual(typeof api.controller.attachView, 'function');
    assert.strictEqual(typeof api.environment.folders, 'function');
  });

  test('every command declared in package.json is registered', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    await extension.activate();
    const manifest = extension.packageJSON as Manifest;
    const declared = manifest.contributes.commands.map((c) => c.command);
    assert.ok(declared.length >= 7, 'expected the declared commands');
    const registered = new Set(await vscode.commands.getCommands(true));
    for (const command of declared) {
      assert.ok(registered.has(command), `${command} is not registered`);
    }
  });

  test('the chat view can be focused', async () => {
    await activateExtension();
    await vscode.commands.executeCommand('agentcanopy.chat.focus');
  });

  test('the focus command runs', async () => {
    await activateExtension();
    await vscode.commands.executeCommand('agentcanopy.focusChat');
  });
});
