import * as vscode from 'vscode';
import type { AppController, ViewHandle } from '../../core/contracts';
import { ConversationIdSchema, type ConversationId } from '../../shared';
import { renderHtml, webviewOptions, type ViewKind } from './html';

export const CHAT_VIEW_ID = 'agentcanopy.chat';
export const PANEL_VIEW_TYPE = 'agentcanopy.chatPanel';

export interface Views {
  /** Opens a chat in an editor tab. Several can be open at once. */
  openPanel(conversationId?: ConversationId): void;
}

/** What the webview saves with `setState` and the panel serializer gets back after a reload. */
function restoredConversationId(state: unknown): ConversationId | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const value = (state as { conversationId?: unknown }).conversationId;
  if (typeof value !== 'string') return undefined;
  const parsed = ConversationIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Registers the sidebar view and the editor panels. The controller is looked up when a view is
 * created, because the UI port that opens panels is itself an input of the controller.
 */
export function registerViews(
  context: vscode.ExtensionContext,
  getController: () => AppController,
): Views {
  const extensionUri = context.extensionUri;

  /** Connects a webview to the controller. The returned disposable detaches it. */
  function attach(
    webview: vscode.Webview,
    kind: ViewKind,
    initial?: { conversationId?: ConversationId },
  ): vscode.Disposable {
    webview.options = webviewOptions(extensionUri);
    webview.html = renderHtml(webview, extensionUri, kind);
    const handle: ViewHandle = getController().attachView(
      kind,
      { post: (message) => void webview.postMessage(message) },
      initial,
    );
    const subscription = webview.onDidReceiveMessage((payload: unknown) => {
      handle.receive(payload);
    });
    return new vscode.Disposable(() => {
      subscription.dispose();
      handle.dispose();
    });
  }

  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(view) {
      const attached = attach(view.webview, 'sidebar');
      view.onDidDispose(() => {
        attached.dispose();
      });
    },
  };

  function bindPanel(panel: vscode.WebviewPanel, conversationId?: ConversationId): void {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'sidebar.svg');
    const attached = attach(
      panel.webview,
      'panel',
      conversationId ? { conversationId } : undefined,
    );
    panel.onDidDispose(() => {
      attached.dispose();
    });
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
      deserializeWebviewPanel(panel, state: unknown): Promise<void> {
        panel.title = 'AgentCanopy';
        bindPanel(panel, restoredConversationId(state));
        return Promise.resolve();
      },
    }),
  );

  return {
    openPanel(conversationId) {
      const panel = vscode.window.createWebviewPanel(
        PANEL_VIEW_TYPE,
        'AgentCanopy',
        vscode.ViewColumn.Active,
        { ...webviewOptions(extensionUri), retainContextWhenHidden: true },
      );
      bindPanel(panel, conversationId);
    },
  };
}
