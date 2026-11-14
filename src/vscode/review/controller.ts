import * as vscode from 'vscode';
import type {
  AppEnvironment,
  AppController,
  FolderInfo,
  Logger,
  RejectResult,
  ReviewService,
  UiPort,
} from '../../core/contracts';
import { RelPathSchema, type FolderKey, type Hunk, type ReviewEntry } from '../../shared';
import { relativeInside } from '../host/ui';
import type { BaselineDocuments } from './baseline-documents';
import { UNSAVED_MESSAGE, hunkProblemMessage } from './hunk-messages';
import { hunkAt, lensLine, marksFor, neighbourLine, type Mark } from './hunk-geometry';

const SAVE_DEBOUNCE_MS = 300;
const POLL_INTERVAL_MS = 1000;
const POLL_ATTEMPTS = 60;

const CONTEXT_ANY = 'agentcanopy.hasPendingChanges';
const CONTEXT_ACTIVE = 'agentcanopy.activeFileHasPendingChanges';

export { UNSAVED_MESSAGE };

/** Tells the user why a hunk action did not happen. A finished action says nothing. */
function reportHunkResult(result: RejectResult): void {
  const message = hunkProblemMessage(result);
  if (message !== undefined) void vscode.window.showWarningMessage(message);
}

export interface ReviewControllerOptions {
  /** The interactive reject flows live in the application core. */
  app: Pick<AppController, 'rejectFileInteractive' | 'rejectAllInteractive'>;
  getReview(): ReviewService | undefined;
  environment: AppEnvironment;
  ui: UiPort;
  baseline: BaselineDocuments;
  logger: Logger;
}

/** Decoration ranges of one editor, by kind. Lines are zero-based and inclusive. */
export type AppliedDecorations = Record<
  'added' | 'modified' | 'removed' | 'removedAtEnd',
  { startLine: number; endLine: number }[]
>;

export interface ReviewController extends vscode.Disposable {
  /** The status bar text, or undefined while the item is hidden (no pending changes). */
  statusText(): string | undefined;
  /** What was last applied to the editor showing this file. Undefined when there is no such editor. */
  appliedDecorations(file: vscode.Uri): AppliedDecorations | undefined;
  /** Reads the review state again and updates lenses, decorations, context keys and the status bar. */
  refresh(): Promise<void>;
}

/** A pending file that is open in an editor, with its hunks as of the last save. */
interface OpenFile {
  folder: FolderInfo;
  path: string;
  hunks: Hunk[];
}

interface Target {
  folder: FolderInfo;
  path: string;
}

function decoration(
  borderWidth: string,
  color: string,
  ruler: boolean,
): vscode.TextEditorDecorationType {
  const colour = new vscode.ThemeColor(color);
  return vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderStyle: 'solid',
    borderWidth,
    borderColor: colour,
    ...(ruler
      ? { overviewRulerColor: colour, overviewRulerLane: vscode.OverviewRulerLane.Left }
      : {}),
  });
}

export function createReviewController(options: ReviewControllerOptions): ReviewController {
  const { environment, ui, baseline, logger } = options;
  const disposables: vscode.Disposable[] = [];
  const pending = new Map<FolderKey, ReviewEntry[]>();
  const open = new Map<string, OpenFile>();
  const dirtyState = new Map<string, boolean>();
  const saveTimers = new Map<string, NodeJS.Timeout>();
  const contextValues = new Map<string, boolean>();
  const applied = new Map<string, AppliedDecorations>();
  let statusText: string | undefined;
  let chain: Promise<void> = Promise.resolve();
  let attached: ReviewService | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const lensEmitter = new vscode.EventEmitter<void>();
  const typeAdded = decoration('0 0 0 3px', 'editorGutter.addedBackground', true);
  const typeModified = decoration('0 0 0 3px', 'editorGutter.modifiedBackground', true);
  const typeRemoved = decoration('2px 0 0 0', 'editorGutter.deletedBackground', true);
  const typeRemovedAtEnd = decoration('0 0 2px 0', 'editorGutter.deletedBackground', true);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.command = 'agentcanopy.review.openAll';
  disposables.push(lensEmitter, typeAdded, typeModified, typeRemoved, typeRemovedAtEnd, statusBar);

  /* -------------------------------------------------------------------------- helpers */

  const review = (): ReviewService | undefined => options.getReview();

  function locate(fsPath: string): Target | undefined {
    for (const folder of environment.folders()) {
      const path = relativeInside(folder, fsPath);
      if (path !== undefined) return { folder, path };
    }
    return undefined;
  }

  function isPending(target: Target): boolean {
    return (pending.get(target.folder.key) ?? []).some((entry) => entry.path === target.path);
  }

  function setContext(key: string, value: boolean): void {
    if (contextValues.get(key) === value) return;
    contextValues.set(key, value);
    void vscode.commands.executeCommand('setContext', key, value);
  }

  function totalPending(): number {
    let total = 0;
    for (const entries of pending.values()) total += entries.length;
    return total;
  }

  function activeOpenFile(): { editor: vscode.TextEditor; file: OpenFile } | undefined {
    const editor = vscode.window.activeTextEditor;
    const file = editor ? open.get(editor.document.uri.toString()) : undefined;
    return editor && file ? { editor, file } : undefined;
  }

  /* ------------------------------------------------------------------------ decorations */

  function applyDecorations(editor: vscode.TextEditor): void {
    const file = open.get(editor.document.uri.toString());
    const marks: Mark[] =
      file && !editor.document.isDirty ? marksFor(file.hunks, editor.document.lineCount) : [];
    const toRange = (r: { startLine: number; endLine: number }): vscode.Range =>
      new vscode.Range(r.startLine, 0, r.endLine, 0);
    const ranges = (predicate: (mark: Mark) => boolean): AppliedDecorations['added'] =>
      marks.filter(predicate).map((m) => ({ startLine: m.startLine, endLine: m.endLine }));
    const next: AppliedDecorations = {
      added: ranges((m) => m.kind === 'added'),
      modified: ranges((m) => m.kind === 'modified'),
      removed: ranges((m) => m.kind === 'removed' && !m.atEnd),
      removedAtEnd: ranges((m) => m.kind === 'removed' && m.atEnd),
    };
    editor.setDecorations(typeAdded, next.added.map(toRange));
    editor.setDecorations(typeModified, next.modified.map(toRange));
    editor.setDecorations(typeRemoved, next.removed.map(toRange));
    editor.setDecorations(typeRemovedAtEnd, next.removedAtEnd.map(toRange));
    applied.set(editor.document.uri.toString(), next);
  }

  function publish(): void {
    setContext(CONTEXT_ANY, totalPending() > 0);
    const active = vscode.window.activeTextEditor;
    const activeTarget =
      active && active.document.uri.scheme === 'file'
        ? locate(active.document.uri.fsPath)
        : undefined;
    setContext(CONTEXT_ACTIVE, activeTarget !== undefined && isPending(activeTarget));
    const total = totalPending();
    if (total === 0) {
      statusText = undefined;
      statusBar.hide();
    } else {
      statusText = `$(diff) ${String(total)} agent ${total === 1 ? 'change' : 'changes'}`;
      statusBar.text = statusText;
      statusBar.tooltip = 'Review the changes the agent made';
      statusBar.show();
    }
    for (const editor of vscode.window.visibleTextEditors) applyDecorations(editor);
    lensEmitter.fire();
  }

  /* ------------------------------------------------------------------------- state sync */

  async function loadDocument(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const service = review();
    const target = document.uri.scheme === 'file' ? locate(document.uri.fsPath) : undefined;
    if (!service || !target || !isPending(target)) {
      open.delete(key);
      dirtyState.delete(key);
      return;
    }
    let hunks: Hunk[] = [];
    try {
      hunks = await service.hunks(target.folder.key, target.path);
    } catch (error) {
      logger.warn('could not read hunks', { path: target.path, error });
    }
    if (document.isClosed) return;
    open.set(key, { folder: target.folder, path: target.path, hunks });
    dirtyState.set(key, document.isDirty);
  }

  async function sync(): Promise<void> {
    const service = review();
    if (!service || disposed) return;
    const seen = new Set<FolderKey>();
    for (const folder of environment.folders()) {
      seen.add(folder.key);
      try {
        const entries = await service.entries(folder.key);
        pending.set(
          folder.key,
          entries.filter((entry) => entry.status === 'pending'),
        );
      } catch (error) {
        logger.warn('could not read review entries', { error });
        pending.set(folder.key, []);
      }
    }
    for (const key of [...pending.keys()]) if (!seen.has(key)) pending.delete(key);
    for (const document of vscode.workspace.textDocuments) await loadDocument(document);
    if (!disposed) publish();
  }

  function refresh(): Promise<void> {
    chain = chain.then(sync, sync);
    return chain;
  }

  function attach(): boolean {
    const service = review();
    if (!service) return false;
    if (attached !== service) {
      unsubscribe?.();
      attached = service;
      unsubscribe = service.onDidChange((folderKey) => {
        baseline.changed(folderKey);
        void refresh();
      });
    }
    void refresh();
    return true;
  }

  // The review service exists once storage is ready, which can be a moment after activation.
  let attempts = 0;
  const poll = attach()
    ? undefined
    : setInterval(() => {
        attempts += 1;
        if (attach() || attempts >= POLL_ATTEMPTS) clearInterval(poll);
      }, POLL_INTERVAL_MS);
  disposables.push({
    dispose: () => {
      if (poll) clearInterval(poll);
    },
  });

  /* ---------------------------------------------------------------------------- events */

  disposables.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      void loadDocument(document).then(() => {
        if (!disposed) publish();
      });
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      open.delete(key);
      dirtyState.delete(key);
      clearTimeout(saveTimers.get(key));
      saveTimers.delete(key);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const key = document.uri.toString();
      if (!open.has(key)) return;
      clearTimeout(saveTimers.get(key));
      saveTimers.set(
        key,
        setTimeout(() => {
          saveTimers.delete(key);
          void loadDocument(document).then(() => {
            if (!disposed) publish();
          });
        }, SAVE_DEBOUNCE_MS),
      );
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const key = event.document.uri.toString();
      if (!open.has(key) || dirtyState.get(key) === event.document.isDirty) return;
      dirtyState.set(key, event.document.isDirty);
      for (const editor of vscode.window.visibleTextEditors) {
        if (editor.document === event.document) applyDecorations(editor);
      }
      lensEmitter.fire();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      publish();
    }),
    vscode.window.onDidChangeVisibleTextEditors((editors) => {
      for (const editor of editors) applyDecorations(editor);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refresh();
    }),
  );

  /* ------------------------------------------------------------------------------ lenses */

  disposables.push(
    vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      {
        onDidChangeCodeLenses: lensEmitter.event,
        provideCodeLenses(document) {
          const file = open.get(document.uri.toString());
          if (!file) return [];
          const top = new vscode.Range(0, 0, 0, 0);
          if (document.isDirty) {
            return [
              new vscode.CodeLens(top, {
                title: "Save to review the agent's changes",
                command: 'workbench.action.files.save',
                arguments: [document.uri],
              }),
            ];
          }
          const base = [file.folder.key, file.path];
          const lens = (
            range: vscode.Range,
            title: string,
            command: string,
            extra: string[] = [],
          ) => new vscode.CodeLens(range, { title, command, arguments: [...base, ...extra] });
          const lenses = [
            lens(top, 'Accept File', 'agentcanopy.review.acceptFile'),
            lens(top, 'Reject File', 'agentcanopy.review.rejectFile'),
          ];
          for (const hunk of file.hunks) {
            const line = lensLine(hunk, document.lineCount);
            const range = new vscode.Range(line, 0, line, 0);
            lenses.push(
              lens(range, 'Accept Change', 'agentcanopy.review.acceptHunk', [hunk.id]),
              lens(range, 'Reject Change', 'agentcanopy.review.rejectHunk', [hunk.id]),
              lens(range, 'Show Diff', 'agentcanopy.review.openDiff'),
            );
          }
          return lenses;
        },
      },
    ),
  );

  /* ---------------------------------------------------------------------------- commands */

  /** The file a command acts on: explicit arguments from a lens, a resource, or the active editor. */
  function targetOf(args: unknown[]): Target | undefined {
    const [first, second] = args;
    if (typeof first === 'string') {
      const folder = environment.folders().find((f) => f.key === first);
      const path = RelPathSchema.safeParse(second);
      return folder && path.success ? { folder, path: path.data } : undefined;
    }
    const uri = first instanceof vscode.Uri ? first : vscode.window.activeTextEditor?.document.uri;
    return uri?.scheme === 'file' ? locate(uri.fsPath) : undefined;
  }

  function noTarget(): void {
    void vscode.window.showInformationMessage('This file has no pending agent changes.');
  }

  function foldersWithPending(): FolderInfo[] {
    return environment.folders().filter((f) => (pending.get(f.key) ?? []).length > 0);
  }

  async function afterAction(): Promise<void> {
    await refresh();
  }

  async function fileAction(
    args: unknown[],
    run: (service: ReviewService, target: Target) => Promise<void>,
  ): Promise<void> {
    const service = review();
    const target = targetOf(args);
    if (!service || !target) return noTarget();
    await run(service, target);
    await afterAction();
  }

  async function hunkAction(
    args: unknown[],
    run: (service: ReviewService, target: Target, hunkId: string) => Promise<RejectResult>,
  ): Promise<void> {
    const service = review();
    const target = targetOf(args);
    if (!service || !target) return noTarget();
    let hunkId = typeof args[0] === 'string' && typeof args[2] === 'string' ? args[2] : undefined;
    if (hunkId === undefined) {
      const active = activeOpenFile();
      if (!active || active.editor.document.isDirty) {
        void vscode.window.showWarningMessage(
          active ? UNSAVED_MESSAGE : 'Put the cursor in a file with pending agent changes.',
        );
        return;
      }
      const line = active.editor.selection.active.line;
      hunkId = hunkAt(active.file.hunks, line, active.editor.document.lineCount)?.id;
      if (hunkId === undefined) {
        void vscode.window.showInformationMessage('There is no agent change at the cursor.');
        return;
      }
    }
    reportHunkResult(await run(service, target, hunkId));
    await afterAction();
  }

  function moveToHunk(direction: 1 | -1): void {
    const active = activeOpenFile();
    if (!active) return noTarget();
    const { editor, file } = active;
    const lines = file.hunks.map((h) => lensLine(h, editor.document.lineCount));
    const line = neighbourLine(lines, editor.selection.active.line, direction);
    if (line === undefined) return;
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
      new vscode.Range(position, position),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
  }

  /** The folder a folder-wide command opens: the one named, the active file's, or the first. */
  function folderForOpenAll(args: unknown[]): FolderInfo | undefined {
    if (typeof args[0] === 'string') return environment.folders().find((f) => f.key === args[0]);
    const withPending = foldersWithPending();
    const active = vscode.window.activeTextEditor;
    const located =
      active?.document.uri.scheme === 'file' ? locate(active.document.uri.fsPath) : undefined;
    return withPending.find((f) => f.key === located?.folder.key) ?? withPending[0];
  }

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'agentcanopy.review.acceptFile': (...args) =>
      fileAction(args, (service, t) => service.acceptFile(t.folder.key, t.path)),
    'agentcanopy.review.rejectFile': (...args) =>
      fileAction(args, (_service, t) => options.app.rejectFileInteractive(t.folder.key, t.path)),
    'agentcanopy.review.acceptHunk': (...args) =>
      hunkAction(args, (service, t, id) => service.acceptHunk(t.folder.key, t.path, id)),
    'agentcanopy.review.rejectHunk': (...args) =>
      hunkAction(args, (service, t, id) => service.rejectHunk(t.folder.key, t.path, id)),
    'agentcanopy.review.openDiff': async (...args) => {
      const target = targetOf(args);
      if (!target) return noTarget();
      await ui.openChangeDiff(target.folder.key, target.path);
    },
    'agentcanopy.review.openAll': async (...args) => {
      const folder = folderForOpenAll(args);
      if (!folder) {
        void vscode.window.showInformationMessage('There are no pending agent changes.');
        return;
      }
      await ui.openAllChanges(folder.key);
    },
    'agentcanopy.review.nextChange': () => {
      moveToHunk(1);
    },
    'agentcanopy.review.previousChange': () => {
      moveToHunk(-1);
    },
    'agentcanopy.review.acceptAll': async () => {
      const service = review();
      if (!service) return;
      const folders = foldersWithPending();
      if (folders.length === 0) {
        void vscode.window.showInformationMessage('There are no pending agent changes.');
        return;
      }
      for (const folder of folders) await service.acceptAll(folder.key);
      await afterAction();
    },
    'agentcanopy.review.rejectAll': async () => {
      const service = review();
      if (!service) return;
      const folders = foldersWithPending();
      if (folders.length === 0) {
        void vscode.window.showInformationMessage('There are no pending agent changes.');
        return;
      }
      for (const folder of folders) await options.app.rejectAllInteractive(folder.key, []);
      await afterAction();
    },
  };

  for (const [id, run] of Object.entries(commands)) {
    disposables.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await run(...args);
        } catch (error) {
          logger.error('review command failed', { command: id, error });
          void vscode.window.showErrorMessage(
            'The review action failed. See the AgentCanopy log for details.',
          );
        }
      }),
    );
  }

  return {
    refresh,
    statusText: () => statusText,
    appliedDecorations: (file) => applied.get(file.toString()),
    dispose() {
      disposed = true;
      unsubscribe?.();
      for (const timer of saveTimers.values()) clearTimeout(timer);
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
