import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { FolderInfo, ReviewService, UiPort } from '../../core/contracts';
import { openAllChanges, openChangeDiff } from '../review/diffs';
import { createVirtualDocument } from '../plan/virtual-documents';
import { RelPathSchema, type Attachment, type ConversationId } from '../../shared';

const MAX_SELECTION_CHARS = 100_000;
const MAX_DIAGNOSTICS = 200;
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export interface UiParts {
  openPanel(conversationId?: ConversationId): void;
  showLogs(): void;
  /** The id of this extension (`publisher.name`), which the publisher override at packaging changes. */
  extensionId: string;
  /** The review service, once it is ready. */
  review(): ReviewService | undefined;
}

function realOrSame(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

function relativeWithin(root: string, target: string): string | undefined {
  const relative = path.relative(root, target);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join('/');
}

/** The path of `absolute` relative to the folder with forward slashes, when it lies inside it. */
export function relativeInside(folder: FolderInfo, absolute: string): string | undefined {
  const direct = relativeWithin(folder.path, absolute);
  const relative = direct ?? relativeWithin(realOrSame(folder.path), realOrSame(absolute));
  if (relative === undefined) return undefined;
  return RelPathSchema.safeParse(relative).success ? relative : undefined;
}

function activeFileInside(
  folder: FolderInfo,
): { editor: vscode.TextEditor; relative: string } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return undefined;
  const relative = relativeInside(folder, editor.document.uri.fsPath);
  return relative === undefined ? undefined : { editor, relative };
}

const SEVERITY: Record<vscode.DiagnosticSeverity, string> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'info',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

function notReady(): void {
  void vscode.window.showInformationMessage(
    'Agent changes are not ready yet. Try again in a moment.',
  );
}

export function createUiPort(parts: UiParts): UiPort {
  return {
    async confirm({ title, detail, confirmLabel }) {
      const answer = await vscode.window.showWarningMessage(
        title,
        { modal: true, detail },
        confirmLabel,
      );
      return answer === confirmLabel;
    },

    async pickPaths({ folder, what }) {
      const picked = await vscode.window.showOpenDialog({
        defaultUri: vscode.Uri.file(folder.path),
        canSelectFiles: what === 'file',
        canSelectFolders: what === 'folder',
        canSelectMany: true,
        openLabel: what === 'file' ? 'Add file' : 'Add folder',
      });
      const result: string[] = [];
      for (const uri of picked ?? []) {
        if (uri.scheme !== 'file') continue;
        const relative = relativeInside(folder, uri.fsPath);
        if (relative !== undefined) result.push(relative);
      }
      return result;
    },

    currentSelection(folder): Attachment | undefined {
      const active = activeFileInside(folder);
      if (!active) return undefined;
      const { editor, relative } = active;
      const selection = editor.selection;
      if (selection.isEmpty) return undefined;
      const text = editor.document.getText(selection);
      if (text.length === 0) return undefined;
      // A selection that ends at column 0 of a line does not include that line.
      const endLine =
        selection.end.character === 0 && selection.end.line > selection.start.line
          ? selection.end.line
          : selection.end.line + 1;
      return {
        kind: 'selection',
        path: relative,
        startLine: selection.start.line + 1,
        endLine,
        text: text.slice(0, MAX_SELECTION_CHARS),
      };
    },

    currentDiagnostics(folder): Attachment | undefined {
      const active = activeFileInside(folder);
      if (!active) return undefined;
      const diagnostics = vscode.languages.getDiagnostics(active.editor.document.uri);
      if (diagnostics.length === 0) return undefined;
      const text = diagnostics
        .slice(0, MAX_DIAGNOSTICS)
        .map((d) => {
          const message = d.message.replace(/\s*\r?\n\s*/g, ' ');
          return `${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity]} ${message}`;
        })
        .join('\n');
      return {
        kind: 'diagnostics',
        path: active.relative,
        text: text.slice(0, MAX_SELECTION_CHARS),
      };
    },

    async openFile(absolutePath, line) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      const editor = await vscode.window.showTextDocument(document);
      if (line !== undefined && Number.isInteger(line) && line > 0) {
        const position = new vscode.Position(Math.min(line - 1, document.lineCount - 1), 0);
        const range = new vscode.Range(position, position);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    },

    async openExternal(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return;
      // The link text came from model output, so the user sees the real destination before it opens.
      const open = 'Open Link';
      const choice = await vscode.window.showWarningMessage(
        'Open this link outside VS Code?',
        { modal: true, detail: parsed.href },
        open,
      );
      if (choice !== open) return;
      await vscode.env.openExternal(vscode.Uri.parse(parsed.href, true));
    },

    async copyToClipboard(text) {
      await vscode.env.clipboard.writeText(text);
    },

    startSignIn(_providerId, command) {
      if (command) {
        // The executable and its arguments go to the terminal as they are: no shell, no quoting.
        const terminal = vscode.window.createTerminal({
          name: 'Claude Code sign-in',
          shellPath: command.executable,
          shellArgs: command.args,
        });
        terminal.show();
        return;
      }
      // Not in the workspace: a repository must not decide which `claude` the sign-in runs.
      const terminal = vscode.window.createTerminal({
        name: 'Claude Code sign-in',
        cwd: os.homedir(),
      });
      terminal.show();
      terminal.sendText('claude auth login');
    },

    async showReadOnlyDocument({ key, title, text, beside }) {
      const uri = createVirtualDocument(text, title, key);
      // A tab for this document may be open already, in any group: show that one, where it is.
      let openIn: vscode.ViewColumn | undefined;
      for (const group of vscode.window.tabGroups.all) {
        const open = group.tabs.some(
          (tab) =>
            tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString(),
        );
        if (open) {
          openIn = group.viewColumn;
          break;
        }
      }
      await vscode.window.showTextDocument(uri, {
        preview: false,
        viewColumn: openIn ?? (beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active),
      });
    },

    async showDiff({ title, leftLabel, leftText, rightLabel, rightText }) {
      const left = createVirtualDocument(leftText, leftLabel);
      const right = createVirtualDocument(rightText, rightLabel);
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    },

    async choose({ title, detail, options }) {
      const labels = options.map((option) => option.label);
      const answer = await vscode.window.showWarningMessage(
        title,
        { modal: true, detail },
        ...labels,
      );
      return options.find((option) => option.label === answer)?.id;
    },

    async openChangeDiff(folderKey, relativePath) {
      const review = parts.review();
      if (!review) return notReady();
      await openChangeDiff(review, folderKey, relativePath);
    },

    async openAllChanges(folderKey, paths) {
      const review = parts.review();
      if (!review) return notReady();
      await openAllChanges(review, folderKey, paths);
    },

    openEditorPanel: (conversationId) => {
      parts.openPanel(conversationId);
    },
    showLogs: () => {
      parts.showLogs();
    },

    async pickDirectory({ title, openLabel, defaultPath }) {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title,
        openLabel,
        ...(defaultPath === undefined ? {} : { defaultUri: vscode.Uri.file(defaultPath) }),
      });
      const first = picked?.[0];
      return first?.scheme === 'file' ? first.fsPath : undefined;
    },

    openSettings: () => {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${parts.extensionId}`,
      );
    },
  };
}
