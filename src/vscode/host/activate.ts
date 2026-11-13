import * as vscode from 'vscode';
import { z } from 'zod';
import type {
  AppController,
  AppEnvironment,
  EditorPort,
  FolderInfo,
  UiPort,
} from '../../core/contracts';
import { createHostToolServer } from '../../core/mcp-host';
import { createClaudeProvider, type ClaudeProviderOptions } from '../../core/provider/claude';
import { createProviderRegistry } from '../../core/provider/registry';
import { createAppController } from '../../core/session';
import { createVirtualDocument, registerVirtualDocuments } from '../plan/virtual-documents';
import { registerBaselineDocuments } from '../review/baseline-documents';
import { createReviewController, type ReviewController } from '../review/controller';
import { createEditorPort } from './editor-port';
import { createEnvironment } from './environment';
import { createLogger } from './logger';
import { readSettings } from './settings';
import { createUiPort, relativeInside } from './ui';
import { registerViews } from './views';

const DEACTIVATE_TIMEOUT_MS = 4000;
const CLAUDE_PROVIDER_ID = 'claude-code';

/** What the extension hands to the integration tests. Only returned in `ExtensionMode.Test`. */
export interface HostTestApi {
  controller: AppController;
  environment: AppEnvironment;
  ui: UiPort;
  editor: EditorPort;
  review: ReviewController;
  /** The extension's own `createVirtualDocument`: its texts live in the extension's module copy. */
  createVirtualDocument: typeof createVirtualDocument;
}

const TestLaunchSchema = z.object({
  command: z.string().min(1),
  prefixArgs: z.array(z.string()),
  env: z.record(z.string(), z.string()).optional(),
});

/** The test hook: only in `ExtensionMode.Test`, and only when the variable is set. */
function testLaunch(
  context: vscode.ExtensionContext,
): Pick<ClaudeProviderOptions, 'launchOverride' | 'env'> {
  const raw = process.env.AGENTCANOPY_TEST_LAUNCH;
  if (context.extensionMode !== vscode.ExtensionMode.Test || !raw) return {};
  const launch = TestLaunchSchema.parse(JSON.parse(raw));
  const extra = launch.env ?? {};
  return {
    launchOverride: { command: launch.command, prefixArgs: launch.prefixArgs },
    env: () => ({ ...process.env, ...extra }),
  };
}

let active: { controller: AppController } | undefined;

export async function activateHost(
  context: vscode.ExtensionContext,
): Promise<HostTestApi | undefined> {
  const logger = createLogger();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  context.subscriptions.push(registerVirtualDocuments());

  const editor = createEditorPort();
  context.subscriptions.push(editor);

  const environment = createEnvironment(context, logger);
  // The UI port opens panels, panels need the controller, and the controller needs the UI port.
  const holder: { controller?: AppController } = {};
  const requireController = (): AppController => {
    if (!holder.controller) throw new Error('AgentCanopy is not ready');
    return holder.controller;
  };
  const views = registerViews(context, requireController);
  const ui: UiPort = createUiPort({
    openPanel: (conversationId) => {
      views.openPanel(conversationId);
    },
    showLogs: () => {
      logger.show();
    },
    review: () => holder.controller?.review(),
  });

  const provider = createClaudeProvider({
    claudePath: () => readSettings(logger).claudePath,
    logger,
    ...testLaunch(context),
  });
  const created = createAppController({
    env: environment,
    ui,
    providers: createProviderRegistry([provider]),
    hostTools: createHostToolServer({ logger }),
    logger,
    editor,
  });
  holder.controller = created;
  active = { controller: created };

  const baseline = registerBaselineDocuments(() => created.review());
  const reviewController = createReviewController({
    app: created,
    getReview: () => created.review(),
    environment,
    ui,
    baseline,
    logger,
  });
  context.subscriptions.push(baseline, reviewController);

  registerSubscriptions(context, created);
  registerCommands(context, created, environment, ui, () => provider.signInCommand?.());
  registerStatusBar(context, created);

  try {
    await created.start();
  } catch (error) {
    logger.error('start failed', { error });
    void vscode.window.showErrorMessage(
      'AgentCanopy could not start. See the AgentCanopy log for details.',
    );
  }
  logger.info('AgentCanopy activated');

  return context.extensionMode === vscode.ExtensionMode.Test
    ? {
        controller: created,
        environment,
        ui,
        editor,
        review: reviewController,
        createVirtualDocument,
      }
    : undefined;
}

export async function deactivateHost(): Promise<void> {
  const current = active;
  active = undefined;
  if (!current) return;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, DEACTIVATE_TIMEOUT_MS);
  });
  try {
    await Promise.race([current.controller.dispose(), timeout]);
  } catch {
    // Deactivation must finish; there is nowhere left to report to.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function registerSubscriptions(context: vscode.ExtensionContext, controller: AppController): void {
  context.subscriptions.push(
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      controller.environmentChanged();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      controller.environmentChanged();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('agentCanopy')) return;
      controller.environmentChanged();
      if (event.affectsConfiguration('agentCanopy.claude.path')) {
        void controller.refreshProvider();
      }
    }),
  );
}

function registerCommands(
  context: vscode.ExtensionContext,
  controller: AppController,
  environment: AppEnvironment,
  ui: UiPort,
  signInCommand: () => { executable: string; args: string[] } | undefined,
): void {
  const focusChat = (): Thenable<unknown> =>
    vscode.commands.executeCommand('agentcanopy.chat.focus');
  const register = (id: string, run: () => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, run));
  };

  register('agentcanopy.newChat', async () => {
    await focusChat();
    controller.newConversation();
  });
  register('agentcanopy.focusChat', focusChat);
  register('agentcanopy.openInEditor', () => {
    ui.openEditorPanel();
  });
  register('agentcanopy.addSelectionToChat', async () => {
    const file = vscode.window.activeTextEditor?.document.uri;
    const folder =
      file?.scheme === 'file'
        ? environment.folders().find((f) => relativeInside(f, file.fsPath) !== undefined)
        : undefined;
    const selection = folder ? ui.currentSelection(folder) : undefined;
    if (!selection) {
      void vscode.window.showInformationMessage(
        'Select some text inside a workspace folder to add it to the chat.',
      );
      return;
    }
    controller.addAttachment(selection);
    await focusChat();
  });
  register('agentcanopy.refreshProvider', () => controller.refreshProvider());
  register('agentcanopy.signIn', () => {
    // The same command the Sign In buttons use: the executable found by detection, so a custom
    // `agentCanopy.claude.path` is honoured.
    ui.startSignIn(CLAUDE_PROVIDER_ID, signInCommand());
  });
  register('agentcanopy.purgeStoredFileData', async () => {
    const folder = await chooseFolder(environment);
    if (folder) await controller.purgeStoredFileData(folder.key);
  });
  register('agentcanopy.resetProjectConfigDecision', async () => {
    const folder = await chooseFolder(environment);
    if (folder) await controller.resetProjectConfigDecision(folder.key);
  });
  register('agentcanopy.showLogs', () => {
    ui.showLogs();
  });
}

/** The folder a folder-wide command acts on: the active file's, the only one, or the user's pick. */
async function chooseFolder(environment: AppEnvironment): Promise<FolderInfo | undefined> {
  const folders = environment.folders();
  if (folders.length === 0) {
    void vscode.window.showInformationMessage('Open a folder first.');
    return undefined;
  }
  const file = vscode.window.activeTextEditor?.document.uri;
  if (file?.scheme === 'file') {
    const containing = folders.find((f) => relativeInside(f, file.fsPath) !== undefined);
    if (containing) return containing;
  }
  if (folders.length === 1) return folders[0];
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({ label: folder.name, description: folder.path, folder })),
    { placeHolder: 'Choose a workspace folder' },
  );
  return picked?.folder;
}

function registerStatusBar(context: vscode.ExtensionContext, controller: AppController): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  item.command = 'agentcanopy.focusChat';
  const update = (): void => {
    const running = controller.runningTurns();
    item.text =
      running > 0
        ? `$(sync~spin) AgentCanopy ${String(running)}`
        : '$(comment-discussion) AgentCanopy';
    item.tooltip =
      running > 0 ? `AgentCanopy: ${String(running)} running` : 'AgentCanopy: open the chat';
  };
  update();
  item.show();
  const unsubscribe = controller.onDidChangeRunning(update);
  context.subscriptions.push(item, { dispose: unsubscribe });
}
