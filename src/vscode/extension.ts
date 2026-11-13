import type * as vscode from 'vscode';
import { activateHost, deactivateHost, type HostTestApi } from './host';

export function activate(context: vscode.ExtensionContext): Promise<HostTestApi | undefined> {
  return activateHost(context);
}

export function deactivate(): Promise<void> {
  return deactivateHost();
}
