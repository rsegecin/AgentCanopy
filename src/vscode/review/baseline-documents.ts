import * as vscode from 'vscode';
import type { ReviewService } from '../../core/contracts';
import { FolderKeySchema, RelPathSchema, type FolderKey } from '../../shared';

export const BASELINE_SCHEME = 'agentcanopy-baseline';

let cacheBuster = 0;

/** The URI of a path's review baseline. The query only makes each open diff load fresh content. */
export function baselineUri(folderKey: FolderKey, path: string, buster?: string): vscode.Uri {
  cacheBuster += 1;
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: `/${folderKey}/${path}`,
    query: buster ?? String(cacheBuster),
  });
}

function parse(uri: vscode.Uri): { folderKey: FolderKey; path: string } {
  const [, key = '', ...rest] = uri.path.split('/');
  const folderKey = FolderKeySchema.safeParse(key);
  const path = RelPathSchema.safeParse(rest.join('/'));
  if (!folderKey.success || !path.success) throw vscode.FileSystemError.FileNotFound(uri);
  return { folderKey: folderKey.data, path: path.data };
}

export interface BaselineDocuments extends vscode.Disposable {
  /** Open diffs of this folder refresh: the review changed. */
  changed(folderKey: FolderKey): void;
}

/**
 * Serves the earlier content of reviewed files, read-only, for the left side of a diff.
 * Everything it knows comes from the review service; it never touches the disk itself.
 */
export function registerBaselineDocuments(
  getReview: () => ReviewService | undefined,
): BaselineDocuments {
  const emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  /** URIs that were read, per folder, so a change can be announced for them. */
  const known = new Map<FolderKey, Map<string, vscode.Uri>>();
  const versions = new Map<FolderKey, number>();

  async function content(uri: vscode.Uri): Promise<Uint8Array> {
    const { folderKey, path } = parse(uri);
    const review = getReview();
    if (!review) throw vscode.FileSystemError.Unavailable(uri);
    const folderUris = known.get(folderKey) ?? new Map<string, vscode.Uri>();
    folderUris.set(uri.toString(), uri);
    known.set(folderKey, folderUris);
    const baseline = await review.baselineContent(folderKey, path);
    return baseline.kind === 'content' ? baseline.data : new Uint8Array();
  }

  const noPermission = (uri: vscode.Uri): never => {
    throw vscode.FileSystemError.NoPermissions(uri);
  };

  const provider: vscode.FileSystemProvider = {
    onDidChangeFile: emitter.event,
    watch: () => new vscode.Disposable(() => undefined),
    async stat(uri) {
      const data = await content(uri);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: versions.get(parse(uri).folderKey) ?? 0,
        size: data.byteLength,
        permissions: vscode.FilePermission.Readonly,
      };
    },
    readDirectory: (uri) => {
      throw vscode.FileSystemError.FileNotFound(uri);
    },
    readFile: (uri) => content(uri),
    createDirectory: noPermission,
    writeFile: noPermission,
    delete: noPermission,
    rename: (oldUri) => noPermission(oldUri),
  };

  const registration = vscode.workspace.registerFileSystemProvider(BASELINE_SCHEME, provider, {
    isCaseSensitive: true,
    isReadonly: true,
  });

  return {
    changed(folderKey) {
      versions.set(folderKey, (versions.get(folderKey) ?? 0) + 1);
      const uris = known.get(folderKey);
      if (!uris || uris.size === 0) return;
      emitter.fire([...uris.values()].map((uri) => ({ type: vscode.FileChangeType.Changed, uri })));
    },
    dispose() {
      registration.dispose();
      emitter.dispose();
    },
  };
}
