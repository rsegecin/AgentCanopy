import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { activateExtension, waitFor } from './support/host';

function panelTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) =>
    group.tabs.filter((tab) => tab.label === 'AgentCanopy'),
  );
}

suite('editor panel', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('openInEditor opens a tab labelled AgentCanopy', async () => {
    await activateExtension();
    await vscode.commands.executeCommand('agentcanopy.openInEditor');
    const tabs = await waitFor('the AgentCanopy tab', () => {
      const found = panelTabs();
      return found.length > 0 ? found : undefined;
    });
    assert.ok(tabs[0]?.input instanceof vscode.TabInputWebview);
  });

  test('several panels can be open', async () => {
    await activateExtension();
    await vscode.commands.executeCommand('agentcanopy.openInEditor');
    await vscode.commands.executeCommand('agentcanopy.openInEditor');
    await waitFor('two AgentCanopy tabs', () => (panelTabs().length >= 2 ? true : undefined));
  });
});
