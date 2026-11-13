import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export const VIRTUAL_DOCUMENT_SCHEME = 'agentcanopy-doc';

const MAX_ENTRIES = 40;
const MAX_LABEL_LENGTH = 80;

/** Oldest first: a Map iterates in insertion order. */
const texts = new Map<string, string>();

/** Letters, digits, space, dot, dash and underscore only; anything else becomes an underscore. */
function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, MAX_LABEL_LENGTH);
  return cleaned.trim() === '' ? 'document' : cleaned;
}

/**
 * Keeps `text` in memory and returns a read-only URI for it. The id selects the content; the label
 * only gives the editor tab a readable name.
 */
export function createVirtualDocument(text: string, label: string): vscode.Uri {
  const id = randomBytes(12).toString('hex');
  texts.set(id, text);
  while (texts.size > MAX_ENTRIES) {
    const oldest = texts.keys().next();
    if (oldest.done) break;
    texts.delete(oldest.value);
  }
  return vscode.Uri.from({
    scheme: VIRTUAL_DOCUMENT_SCHEME,
    path: `/${id}/${sanitizeLabel(label)}.md`,
  });
}

/** Registers the provider that serves the texts. Dispose it with the extension. */
export function registerVirtualDocuments(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(VIRTUAL_DOCUMENT_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      const id = uri.path.split('/')[1] ?? '';
      return texts.get(id) ?? '';
    },
  });
}
