import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EditorPort } from '../../core/contracts';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

/** One spelling for paths that name the same file: separators, Unicode form and, where it applies, case. */
function comparable(fsPath: string): string {
  const normalized = path.normalize(fsPath).normalize('NFC');
  return CASE_INSENSITIVE ? normalized.toLowerCase() : normalized;
}

/** The `fsPath` of every dirty `file` document: text documents and notebooks. */
function dirtyPaths(): string[] {
  const paths: string[] = [];
  for (const document of vscode.workspace.textDocuments) {
    if (document.isDirty && document.uri.scheme === 'file') paths.push(document.uri.fsPath);
  }
  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.isDirty && notebook.uri.scheme === 'file') paths.push(notebook.uri.fsPath);
  }
  return paths;
}

/** What the editor knows about open files, for the change tracker and the unsaved-files warning. */
export function createEditorPort(): EditorPort & vscode.Disposable {
  const listeners = new Set<(absolutePath: string) => void>();

  const saved = (uri: vscode.Uri): void => {
    if (uri.scheme !== 'file') return;
    for (const listener of [...listeners]) {
      try {
        listener(uri.fsPath);
      } catch {
        // One failing listener must not keep the others from hearing about the save.
      }
    }
  };
  const subscriptions = [
    vscode.workspace.onDidSaveTextDocument((document) => {
      saved(document.uri);
    }),
    vscode.workspace.onDidSaveNotebookDocument((notebook) => {
      saved(notebook.uri);
    }),
  ];

  return {
    dirtyFiles: () => [...new Map(dirtyPaths().map((p) => [comparable(p), p])).values()],

    isDirty: (absolutePath) => {
      const wanted = comparable(absolutePath);
      return dirtyPaths().some((p) => comparable(p) === wanted);
    },

    onDidSave: (listener) => {
      // A new wrapper per subscription, so subscribing the same function twice is two subscriptions.
      const entry = (absolutePath: string): void => {
        listener(absolutePath);
      };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },

    dispose: () => {
      listeners.clear();
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
