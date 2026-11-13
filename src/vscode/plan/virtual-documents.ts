import { createHash, randomBytes } from 'node:crypto';
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

/** Fires with the URI of a document whose text was replaced. Exists while the provider is registered. */
let changed: vscode.EventEmitter<vscode.Uri> | undefined;

/**
 * Keeps `text` in memory and returns a read-only URI for it. The id selects the content; the label
 * only gives the editor tab a readable name.
 *
 * With a `key` the id is derived from the key, so the same key always gives the same URI (one editor
 * tab per key). Setting it again replaces the text, makes it the newest entry for eviction and, when
 * the text changed, tells open editors to reload it.
 */
export function createVirtualDocument(text: string, label: string, key?: string): vscode.Uri {
  const id =
    key === undefined
      ? randomBytes(12).toString('hex')
      : createHash('sha256').update(key).digest('hex').slice(0, 24);
  const previous = texts.get(id);
  // Delete first: setting an existing key would keep its old place in the insertion order.
  texts.delete(id);
  texts.set(id, text);
  while (texts.size > MAX_ENTRIES) {
    const oldest = texts.keys().next();
    if (oldest.done) break;
    texts.delete(oldest.value);
  }
  const uri = vscode.Uri.from({
    scheme: VIRTUAL_DOCUMENT_SCHEME,
    path: `/${id}/${sanitizeLabel(label)}.md`,
  });
  if (key !== undefined && previous !== text) changed?.fire(uri);
  return uri;
}

/** Registers the provider that serves the texts. Dispose it with the extension. */
export function registerVirtualDocuments(): vscode.Disposable {
  const emitter = new vscode.EventEmitter<vscode.Uri>();
  changed = emitter;
  const registration = vscode.workspace.registerTextDocumentContentProvider(
    VIRTUAL_DOCUMENT_SCHEME,
    {
      onDidChange: emitter.event,
      provideTextDocumentContent(uri: vscode.Uri): string {
        const id = uri.path.split('/')[1] ?? '';
        return texts.get(id) ?? '';
      },
    },
  );
  return new vscode.Disposable(() => {
    registration.dispose();
    if (changed === emitter) changed = undefined;
    emitter.dispose();
  });
}
