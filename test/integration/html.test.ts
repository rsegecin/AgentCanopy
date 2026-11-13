import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { renderHtml, webviewOptions } from '../../src/vscode/host/html';
import { EXTENSION_ID } from './support/host';

function extensionUri(): vscode.Uri {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension);
  return extension.extensionUri;
}

function cspOf(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html);
  assert.ok(match?.[1], 'no CSP meta tag');
  return match[1];
}

function nonceOf(html: string): string {
  const match = /<script type="module" nonce="([^"]+)"/.exec(html);
  assert.ok(match?.[1], 'no module script tag with a nonce');
  return match[1];
}

suite('webview html', () => {
  let panel: vscode.WebviewPanel;

  suiteSetup(() => {
    panel = vscode.window.createWebviewPanel(
      'agentcanopy.test',
      'html test',
      vscode.ViewColumn.Active,
      webviewOptions(extensionUri()),
    );
  });

  suiteTeardown(() => {
    panel.dispose();
  });

  test('the CSP is closed by default and allows no remote origin', () => {
    const html = renderHtml(panel.webview, extensionUri(), 'panel');
    const csp = cspOf(html);
    assert.ok(csp.includes("default-src 'none'"), csp);
    assert.ok(!csp.includes('unsafe-eval'), csp);
    assert.ok(!csp.includes('connect-src'), csp);
    assert.ok(!csp.includes('frame-src'), csp);
    assert.ok(csp.includes("base-uri 'none'"), csp);
    assert.ok(csp.includes("form-action 'none'"), csp);
    const sources = csp.split(/[;\s]+/);
    for (const wildcard of ['http:', 'https:', 'ws:', 'wss:', '*']) {
      assert.ok(!sources.includes(wildcard), `${wildcard} is allowed: ${csp}`);
    }
    const script = csp.split(';').find((d) => d.trim().startsWith('script-src'));
    assert.ok(script && !script.includes('unsafe-inline'), csp);
  });

  test('the script carries the nonce the CSP allows', () => {
    const html = renderHtml(panel.webview, extensionUri(), 'panel');
    const nonce = nonceOf(html);
    assert.ok(cspOf(html).includes(`'nonce-${nonce}'`));
    assert.strictEqual(html.match(/<script\b/g)?.length, 1, 'exactly one script tag');
  });

  test('every render uses a new nonce', () => {
    const first = nonceOf(renderHtml(panel.webview, extensionUri(), 'panel'));
    const second = nonceOf(renderHtml(panel.webview, extensionUri(), 'panel'));
    assert.notStrictEqual(first, second);
  });

  test('resources come from asWebviewUri', () => {
    const html = renderHtml(panel.webview, extensionUri(), 'panel');
    const asset = (name: string): string =>
      panel.webview
        .asWebviewUri(vscode.Uri.joinPath(extensionUri(), 'dist', 'webview', name))
        .toString();
    assert.ok(html.includes(`src="${asset('main.js')}"`), 'main.js');
    assert.ok(html.includes(`href="${asset('main.css')}"`), 'main.css');
    assert.ok(!/(?:src|href)="https?:\/\/(?!.*vscode-cdn)/.test(html), 'no remote resource');
  });

  test('the page has a root, a language and the view kind', () => {
    assert.ok(renderHtml(panel.webview, extensionUri(), 'panel').includes('<div id="root"></div>'));
    assert.ok(renderHtml(panel.webview, extensionUri(), 'panel').includes('<html lang="en">'));
    assert.ok(
      renderHtml(panel.webview, extensionUri(), 'panel').includes('data-view-kind="panel"'),
    );
    assert.ok(
      renderHtml(panel.webview, extensionUri(), 'sidebar').includes('data-view-kind="sidebar"'),
    );
  });

  test('the webview options allow scripts but not command URIs or forms', () => {
    const options = webviewOptions(extensionUri());
    assert.strictEqual(options.enableScripts, true);
    assert.ok(!options.enableCommandUris);
    assert.ok(!options.enableForms);
    const roots = (options.localResourceRoots ?? []).map((uri) => uri.fsPath);
    assert.deepStrictEqual(roots, [
      vscode.Uri.joinPath(extensionUri(), 'dist', 'webview').fsPath,
      vscode.Uri.joinPath(extensionUri(), 'media').fsPath,
    ]);
  });
});
