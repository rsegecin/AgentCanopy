import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import type { AppEnvironment, FolderInfo, Logger } from '../../core/contracts';
import { FolderKeySchema } from '../../shared';
import { readSettings } from './settings';

/** The first 32 hex characters of the sha256 of the folder's real path. */
export function folderKey(fsPath: string): FolderInfo['key'] {
  let real = fsPath;
  try {
    real = fs.realpathSync.native(fsPath);
  } catch {
    // The folder may be gone or unreadable: the path as given still identifies it.
  }
  return FolderKeySchema.parse(createHash('sha256').update(real).digest('hex').slice(0, 32));
}

export function createEnvironment(
  context: vscode.ExtensionContext,
  logger?: Logger,
): AppEnvironment {
  return {
    trusted: () => vscode.workspace.isTrusted,
    folders: () =>
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === 'file')
        .map((folder) => ({
          key: folderKey(folder.uri.fsPath),
          name: folder.name,
          path: folder.uri.fsPath,
        })),
    settings: () => readSettings(logger),
    storageDir: () => context.storageUri?.fsPath,
    globalStorageDir: () => context.globalStorageUri.fsPath,
  };
}
