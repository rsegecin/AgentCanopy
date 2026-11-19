import * as vscode from 'vscode';
import type { ReviewService } from '../../core/contracts';
import type { FolderKey, ReviewEntry } from '../../shared';
import { createVirtualDocument } from '../plan/virtual-documents';
import { baselineUri } from './baseline-documents';

/** What a diff of this entry can show, decided from the entry alone. */
function diffability(entry: ReviewEntry): 'ok' | 'unavailable' | 'binary' | 'unsupported' {
  const { baseline, current } = entry;
  if (baseline.kind === 'symlink' || current.kind === 'symlink') return 'unsupported';
  if (baseline.kind === 'file') {
    if (baseline.binary) return 'binary';
    if (!baseline.stored) return 'unavailable';
  }
  if (current.kind === 'file' && current.binary) return 'binary';
  return 'ok';
}

/** The earlier version against the file on disk, in the native diff editor. */
export async function openChangeDiff(
  review: ReviewService,
  folderKey: FolderKey,
  path: string,
): Promise<void> {
  const entry = (await review.entries(folderKey)).find((e) => e.path === path);
  const absolute = review.absolutePath(folderKey, path);
  if (!entry || absolute === undefined) {
    void vscode.window.showInformationMessage('There are no agent changes to show for this file.');
    return;
  }
  let verdict = diffability(entry);
  if (verdict === 'ok' && entry.baseline.kind === 'file') {
    // The entry says the content was kept; the store has the last word.
    const baseline = await review.baselineContent(folderKey, path);
    if (baseline.kind === 'unavailable') verdict = 'unavailable';
    else if (baseline.kind === 'content' && baseline.binary) verdict = 'binary';
  }
  if (verdict === 'unavailable') {
    void vscode.window.showWarningMessage(
      'The earlier content of this file was not kept, so there is nothing to compare with.',
    );
    return;
  }
  if (verdict !== 'ok') {
    void vscode.window.showInformationMessage(
      'This file is not a text file, so there is no diff to show.',
    );
    return;
  }
  const left = baselineUri(folderKey, path);
  const right =
    entry.current.kind === 'absent' ? createVirtualDocument('', path) : vscode.Uri.file(absolute);
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path} (agent changes)`, {
    preview: true,
  });
}

/** Every pending file of a folder, or only those in `paths`, in one multi-file diff editor. */
export async function openAllChanges(
  review: ReviewService,
  folderKey: FolderKey,
  paths?: readonly string[],
): Promise<void> {
  const only = paths === undefined ? undefined : new Set<string>(paths);
  const entries = (await review.entries(folderKey)).filter(
    (entry) =>
      entry.status === 'pending' &&
      diffability(entry) === 'ok' &&
      (only === undefined || only.has(entry.path)),
  );
  const resources: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
  for (const entry of entries) {
    const absolute = review.absolutePath(folderKey, entry.path);
    if (absolute === undefined) continue;
    const label = vscode.Uri.file(absolute);
    resources.push([
      label,
      entry.baseline.kind === 'absent' ? undefined : baselineUri(folderKey, entry.path),
      entry.current.kind === 'absent' ? undefined : label,
    ]);
  }
  if (resources.length === 0) {
    void vscode.window.showInformationMessage('There are no agent changes to show.');
    return;
  }
  await vscode.commands.executeCommand('vscode.changes', 'Agent changes', resources);
}
