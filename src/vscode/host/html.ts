import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export type ViewKind = 'sidebar' | 'panel';

/** The options every AgentCanopy webview is created with. No command URIs, no forms. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [
      vscode.Uri.joinPath(extensionUri, 'dist', 'webview'),
      vscode.Uri.joinPath(extensionUri, 'media'),
    ],
  };
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The page for a webview. A fresh nonce is generated on every call. */
export function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  kind: ViewKind = 'sidebar',
): string {
  const nonce = randomBytes(16).toString('base64');
  const source = webview.cspSource;
  const asset = (name: string): string =>
    escapeAttribute(
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name)).toString(),
    );
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${source}`,
    `style-src ${source} 'unsafe-inline'`,
    `font-src ${source}`,
    `img-src ${source} data:`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentCanopy</title>
<link rel="stylesheet" href="${asset('main.css')}">
</head>
<body data-view-kind="${kind}">
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${asset('main.js')}"></script>
</body>
</html>
`;
}
