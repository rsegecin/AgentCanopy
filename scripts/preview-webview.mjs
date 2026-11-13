// Serves the built webview in a plain browser with sample state, under the same Content Security
// Policy the extension uses. It exists to look at the UI and to check that it really renders
// (Markdown, code, Mermaid, cards, plan view) without starting VS Code.
//
//   node scripts/preview-webview.mjs            serve on http://127.0.0.1:<port> until Ctrl+C
//   node scripts/preview-webview.mjs --check    render in headless Chrome, write screenshots and a
//                                               report to the folder in AGENTCANOPY_PREVIEW_OUT
//
// Run `npm run build` first. Nothing here ships in the extension.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webviewDir = join(root, 'dist', 'webview');
if (!existsSync(join(webviewDir, 'main.js'))) {
  console.error('dist/webview/main.js is missing. Run "npm run build" first.');
  process.exit(1);
}

// The shared schemas, bundled on the fly, so the sample state is validated like a real one.
const sharedOut = join(mkdtempSync(join(tmpdir(), 'agc-preview-')), 'shared.mjs');
await esbuild.build({
  entryPoints: [join(root, 'src/shared/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: sharedOut,
  logLevel: 'silent',
});
const shared = await import(pathToFileURL(sharedOut).href);

const now = Date.now();
const conv = 'c1';
const plan = {
  id: 'p1',
  conversationId: conv,
  createdAt: now,
  versions: [1, 2].map((version) => ({
    version,
    author: 'agent',
    createdAt: now - (2 - version) * 60000,
    contentHash: `hash${version}`,
    content: shared.PlanContentSchema.parse({
      title: 'Add rate limiting to the public API',
      objective: 'Protect the API from bursts without affecting normal clients.',
      requirements: ['Limit by API key', 'Return 429 with a Retry-After header'],
      analysis:
        'Requests enter through `src/server/router.ts`. There is **no** shared middleware yet.',
      architecture: 'A token bucket per key, stored in Redis.',
      relevantFiles: [
        { path: 'src/server/router.ts', action: 'modify', role: 'Mount the middleware' },
        { path: 'src/server/rate-limit.ts', action: 'create', role: 'Token bucket' },
      ],
      stages: [
        {
          id: 's1',
          title: 'Token bucket module',
          description: 'Pure logic with tests.',
          files: ['src/server/rate-limit.ts'],
          acceptance: ['Unit tests pass'],
        },
        {
          id: 's2',
          title: 'Redis store',
          description: 'Atomic refill with a Lua script.',
          dependsOn: ['s1'],
        },
        {
          id: 's3',
          title: 'Middleware and wiring',
          description: 'Mount on the router.',
          dependsOn: ['s1', 's2'],
          files: ['src/server/router.ts'],
        },
      ],
      dependencies: ['Redis 7'],
      diagrams: [
        {
          id: 'd1',
          title: 'Request flow',
          mermaid:
            'sequenceDiagram\n  Client->>API: request\n  API->>Limiter: take(key)\n  Limiter-->>API: allowed or 429\n  API-->>Client: response',
        },
      ],
      alternatives: [
        {
          id: 'a1',
          title: 'Token bucket',
          summary: 'Smooth bursts.',
          pros: ['Simple'],
          cons: ['Needs a store'],
          chosen: true,
        },
        {
          id: 'a2',
          title: 'Fixed window',
          summary: 'Count per minute.',
          pros: ['Trivial'],
          cons: ['Bursts at window edges'],
        },
      ],
      decisionPoints: [
        {
          id: 'q-store',
          question: 'Where should counters live?',
          options: [
            { id: 'redis', label: 'Redis', description: 'Shared across instances' },
            { id: 'memory', label: 'In memory', description: 'Single instance only' },
          ],
          recommendedOptionId: 'redis',
        },
      ],
      openQuestions: [
        { id: 'q-limit', question: 'What is the default limit per minute?', kind: 'text' },
      ],
      testingStrategy: 'Unit tests for the bucket, an integration test against a Redis container.',
      acceptanceCriteria: ['Bursts above the limit receive 429', 'Normal traffic is unaffected'],
      changeSummary: version === 2 ? 'Added the Redis stage.' : '',
    }),
  })),
  decisions: [
    {
      targetId: 'q-store',
      kind: 'decision-point',
      values: ['redis'],
      decidedAt: now,
      planVersion: 2,
    },
  ],
  approvals: [],
};

const tool = (id, name, input, extra = {}) => ({
  kind: 'tool',
  call: {
    id,
    name,
    input,
    inputTruncated: false,
    status: 'done',
    approval: 'provider',
    parentId: null,
    startedAt: now,
    endedAt: now,
    ...extra,
  },
});

const meta = {
  id: conv,
  title: 'Rate limiting for the API',
  createdAt: now - 3600000,
  updatedAt: now,
  folder: 'f1',
  providerId: 'claude-code',
  model: 'sonnet',
  mode: 'plan',
  sessionId: '11111111-1111-4111-8111-111111111111',
  planId: 'p1',
  planLocked: false,
  fork: {
    parentId: 'c2',
    atMessageId: 'm-parent',
    exactness: 'reconstructed',
    lost: ['Tool inputs and outputs', "The model's reasoning"],
  },
};

const state = {
  ...shared.EMPTY_VIEW_STATE,
  trusted: true,
  folders: [{ key: 'f1', name: 'api-server' }],
  provider: {
    providerId: 'claude-code',
    displayName: 'Claude Code',
    installed: true,
    version: '2.1.322',
    meetsMinimum: true,
    minimumVersion: '2.1.295',
    auth: 'signed-in',
    credential: 'subscription',
    capabilities: {
      streaming: true,
      resume: true,
      forkWhole: true,
      forkAtMessage: 'exact',
      modelSelection: true,
      interactiveApproval: true,
      readOnlyEnforcement: 'tool-layer',
      cancellation: 'graceful',
      toolEvents: true,
      interactiveQuestions: true,
      usage: true,
      hostTools: true,
      sandbox: true,
      sessionHistory: false,
    },
    problems: [],
  },
  models: [
    { id: 'default', label: 'Default (Claude Code decides)', custom: false },
    { id: 'sonnet', label: 'Sonnet', custom: false },
    { id: 'haiku', label: 'Haiku', custom: false },
  ],
  defaults: { mode: 'ask', model: 'default' },
  conversations: [
    { ...meta, preview: 'Here is how requests flow today…', running: true, pendingPrompts: 1 },
    {
      ...meta,
      id: 'c2',
      title: 'Why is the build slow?',
      mode: 'ask',
      updatedAt: now - 90000000,
      preview: 'The slow step is type checking.',
      running: false,
      pendingPrompts: 0,
      planId: undefined,
    },
  ],
  active: {
    meta,
    turns: [
      {
        id: 't1',
        mode: 'ask',
        model: 'sonnet',
        startedAt: now - 120000,
        endedAt: now - 100000,
        status: 'completed',
      },
      { id: 't2', mode: 'plan', model: 'sonnet', startedAt: now - 60000, status: 'running' },
    ],
    messages: [
      {
        role: 'user',
        id: 'm1',
        turnId: 't1',
        createdAt: now - 120000,
        text: 'How do requests reach the handlers?',
        mode: 'ask',
        attachments: [{ kind: 'file', path: 'src/server/router.ts' }],
      },
      {
        role: 'assistant',
        id: 'm2',
        turnId: 't1',
        createdAt: now - 110000,
        parts: [
          { kind: 'thinking', text: 'Look at the router first.' },
          tool(
            'toolu_1',
            'Read',
            { file_path: 'src/server/router.ts', offset: 1, limit: 40 },
            { resultPreview: '1\timport express from "express";' },
          ),
          tool(
            'toolu_2',
            'Grep',
            { pattern: 'app\\.use', path: 'src' },
            { resultPreview: 'src/server/router.ts:12' },
          ),
          {
            kind: 'text',
            text: 'Requests enter in `src/server/router.ts:12` and go through **no** shared middleware.\n\n```ts\napp.use("/v1", v1Router);\n```\n\n```mermaid\nflowchart LR\n  A[Client] --> B[Router]\n  B --> C[Handler]\n```\n\n| Layer | File |\n| :- | :- |\n| Router | `src/server/router.ts` |\n\nSee [the Express docs](https://expressjs.com/) for details.',
          },
        ],
      },
      {
        role: 'user',
        id: 'm3',
        turnId: 't2',
        createdAt: now - 60000,
        text: 'Plan rate limiting for it.',
        mode: 'plan',
        attachments: [],
      },
      {
        role: 'assistant',
        id: 'm4',
        turnId: 't2',
        createdAt: now - 50000,
        parts: [
          { kind: 'plan-update', planId: 'p1', version: 2 },
          {
            kind: 'notice',
            level: 'warning',
            text: "A Claude Code plugin is loaded (example). Plugins run outside AgentCanopy's read-only guarantee.",
          },
          tool(
            'toolu_3',
            'AskUserQuestion',
            { questions: [] },
            { status: 'awaiting-approval', approval: undefined, endedAt: undefined },
          ),
          { kind: 'prompt', promptId: 'pr1' },
          tool(
            'toolu_4',
            'Read',
            { file_path: '/etc/hosts' },
            { status: 'awaiting-approval', approval: undefined, endedAt: undefined },
          ),
          { kind: 'prompt', promptId: 'pr2' },
        ],
      },
    ],
    prompts: [
      {
        id: 'pr1',
        conversationId: conv,
        turnId: 't2',
        toolCallId: 'toolu_3',
        createdAt: now,
        state: 'pending',
        displayHash: 'h1',
        kind: 'question',
        questions: [
          {
            question: 'Which clients need a higher limit?',
            header: 'Clients',
            multiSelect: true,
            options: [
              { label: 'Internal services', description: 'Calls from our own backends' },
              { label: 'Partners', description: 'Keys issued to partners' },
            ],
          },
        ],
      },
      {
        id: 'pr2',
        conversationId: conv,
        turnId: 't2',
        toolCallId: 'toolu_4',
        createdAt: now,
        state: 'pending',
        displayHash: 'h2',
        kind: 'permission',
        toolName: 'Read',
        category: 'read-outside',
        title: 'Read a file outside the workspace',
        detail: '/etc/hosts',
        inputPreview: '{\n  "file_path": "/etc/hosts"\n}',
        choices: ['allow-once', 'deny'],
      },
    ],
    plan,
    activity: 'Working…',
  },
  checkpoints: [
    {
      operationId: 'op-2',
      kind: 'agent-turn',
      at: now - 600000,
      conversationId: conv,
      conversationTitle: 'Rate limiting for the API',
      turnId: 't2',
      filesChanged: 3,
      interrupted: true,
    },
    { operationId: 'op-1', kind: 'reject', at: now - 7200000, filesChanged: 1, interrupted: false },
  ],
  draftAttachments: [{ kind: 'folder', path: 'src/server' }],
  review: {
    entries: [
      {
        path: 'src/cache.ts',
        changeType: 'modified',
        attribution: 'agent-tool',
        status: 'pending',
        baseline: {
          kind: 'file',
          hash: 'aaa111',
          size: 812,
          mode: 420,
          stored: true,
          binary: false,
        },
        current: {
          kind: 'file',
          hash: 'bbb222',
          size: 1040,
          mode: 420,
          stored: true,
          binary: false,
        },
        restorable: true,
        includesUserEdits: false,
        operationIds: [],
        linesAdded: 14,
        linesRemoved: 3,
      },
      {
        path: 'src/store/index.ts',
        changeType: 'created',
        attribution: 'mixed',
        status: 'pending',
        baseline: { kind: 'absent' },
        current: {
          kind: 'file',
          hash: 'ccc333',
          size: 540,
          mode: 420,
          stored: true,
          binary: false,
        },
        restorable: true,
        includesUserEdits: true,
        renamedFrom: 'src/store.ts',
        operationIds: [],
        linesAdded: 22,
      },
      {
        path: 'assets/logo.png',
        changeType: 'deleted',
        attribution: 'unattributed',
        status: 'pending',
        baseline: { kind: 'file', size: 904221, mode: 420, stored: false, binary: true },
        current: { kind: 'absent' },
        restorable: false,
        note: 'The earlier content of this file was not kept, so it cannot be put back.',
        includesUserEdits: false,
        operationIds: [],
      },
      {
        path: 'README.md',
        changeType: 'modified',
        attribution: 'agent-tool',
        status: 'accepted',
        baseline: {
          kind: 'file',
          hash: 'ddd444',
          size: 300,
          mode: 420,
          stored: true,
          binary: false,
        },
        current: {
          kind: 'file',
          hash: 'ddd444',
          size: 300,
          mode: 420,
          stored: true,
          binary: false,
        },
        restorable: true,
        includesUserEdits: false,
        operationIds: [],
      },
    ],
    hunks: {
      'src/cache.ts': [
        {
          id: 'h0',
          index: 0,
          baselineStart: 4,
          baselineLines: ['const cache = new Map();\r\n', 'export function get(key) {\r\n'],
          currentStart: 4,
          currentLines: [
            'const cache = new Map<string, Value>();\r\n',
            'const MAX = 500;\r\n',
            'export function get(key: string) {\r\n',
          ],
        },
        {
          id: 'h1',
          index: 1,
          baselineStart: 40,
          baselineLines: ['module.exports = { get };\n'],
          currentStart: 41,
          currentLines: ['export { get };'],
        },
      ],
    },
    configChanges: [
      {
        id: 'cfg-1',
        displayPath: '.claude/settings.json',
        changeType: 'modified',
        revertible: true,
        detectedAt: now,
      },
      {
        id: 'cfg-2',
        displayPath: '.husky/pre-commit',
        changeType: 'created',
        revertible: false,
        detectedAt: now,
      },
    ],
  },
  baseline: {
    state: 'degraded',
    filesDone: 1200,
    filesTotal: 1200,
    note: '3 files are tracked without their content, so changes a command makes to them can be detected but not undone.',
  },

  banners: [
    { id: 'b1', level: 'info', text: 'This is a preview with sample data.', dismissible: true },
  ],
};

const restorePreview = shared.RestorePreviewSchema.parse({
  token: 'preview-token-1',
  targetOperationId: 'op-2',
  affectedOperations: [
    {
      operationId: 'op-2',
      kind: 'agent-turn',
      at: now - 600000,
      conversationId: conv,
      conversationTitle: 'Rate limiting for the API',
      turnId: 't2',
      filesChanged: 3,
      interrupted: true,
    },
  ],
  items: [
    {
      path: 'src/cache.ts',
      action: 'write',
      attribution: 'agent-tool',
      selectedByDefault: true,
      selectable: true,
    },
    {
      path: 'src/store.ts',
      action: 'write',
      conflict: 'user-edit-between',
      note: "This file also contains changes that were not the agent's since that point. Restoring it discards them.",
      attribution: 'mixed',
      selectedByDefault: false,
      selectable: true,
    },
    {
      path: 'assets/logo.png',
      action: 'write',
      conflict: 'not-captured',
      note: 'The content of this file at that point was not kept.',
      attribution: 'agent-command',
      selectedByDefault: false,
      selectable: false,
    },
  ],
  bytesNeeded: 20480,
});

const parsed = shared.ViewStateSchema.safeParse(state);
if (!parsed.success) {
  console.error('The sample state is not a valid view state:');
  console.error(JSON.stringify(parsed.error.issues.slice(0, 10), null, 2));
  process.exit(1);
}

const TYPES = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// A few theme variables with VS Code's default dark and light values, so the page is readable.
const THEMES = {
  dark: {
    fg: '#cccccc',
    bg: '#1f1f1f',
    inputBg: '#313131',
    border: '#3c3c3c',
    button: '#0078d4',
    buttonFg: '#ffffff',
    muted: '#9d9d9d',
    hover: '#2a2d2e',
    warn: '#cca700',
    error: '#f14c4c',
    badge: '#616161',
    codeBg: '#2b2b2b',
    link: '#4daafc',
  },
  light: {
    fg: '#3b3b3b',
    bg: '#ffffff',
    inputBg: '#ffffff',
    border: '#cecece',
    button: '#005fb8',
    buttonFg: '#ffffff',
    muted: '#616161',
    hover: '#f2f2f2',
    warn: '#bf8803',
    error: '#e51400',
    badge: '#cccccc',
    codeBg: '#f3f3f3',
    link: '#005fb8',
  },
};

function themeCss(t) {
  const v = {
    foreground: t.fg,
    'editor-foreground': t.fg,
    'editor-background': t.bg,
    'sideBar-background': t.bg,
    'input-background': t.inputBg,
    'input-foreground': t.fg,
    'input-border': t.border,
    'panel-border': t.border,
    'widget-border': t.border,
    'editorWidget-background': t.inputBg,
    'editorWidget-border': t.border,
    'button-background': t.button,
    'button-foreground': t.buttonFg,
    'button-hoverBackground': t.button,
    'button-secondaryBackground': t.inputBg,
    'button-secondaryForeground': t.fg,
    'button-secondaryHoverBackground': t.hover,
    descriptionForeground: t.muted,
    'list-hoverBackground': t.hover,
    'list-activeSelectionBackground': t.hover,
    'list-activeSelectionForeground': t.fg,
    focusBorder: t.button,
    'textLink-foreground': t.link,
    'textLink-activeForeground': t.link,
    'textCodeBlock-background': t.codeBg,
    'textPreformat-foreground': t.fg,
    'textBlockQuote-background': t.codeBg,
    'textBlockQuote-border': t.border,
    'editorWarning-foreground': t.warn,
    'editorError-foreground': t.error,
    errorForeground: t.error,
    'badge-background': t.badge,
    'badge-foreground': t.fg,
    'inputValidation-warningBackground': t.codeBg,
    'inputValidation-warningBorder': t.warn,
    'inputValidation-errorBackground': t.codeBg,
    'inputValidation-errorBorder': t.error,
    'inputValidation-infoBackground': t.codeBg,
    'inputValidation-infoBorder': t.button,
    'toolbar-hoverBackground': t.hover,
    'dropdown-background': t.inputBg,
    'dropdown-foreground': t.fg,
    'dropdown-border': t.border,
    'checkbox-background': t.inputBg,
    'checkbox-border': t.border,
    'checkbox-foreground': t.fg,
    'scrollbarSlider-background': t.badge,
    'editorGutter-addedBackground': '#2ea043',
    'editorGutter-deletedBackground': t.error,
    'diffEditor-insertedTextBackground': '#2ea04333',
    'diffEditor-removedTextBackground': '#f8514933',
    'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    'font-size': '13px',
    'font-weight': 'normal',
    'editor-font-family': 'Menlo, Monaco, "Courier New", monospace',
    'editor-font-size': '12px',
  };
  return `body{${Object.entries(v)
    .map(([k, val]) => `--vscode-${k}:${val}`)
    .join(
      ';',
    )};margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}html,body,#root{height:100%}`;
}

function page(origin, query) {
  const nonce = randomBytes(16).toString('base64');
  const theme = query.get('theme') === 'light' ? 'light' : 'dark';
  const kind = query.get('kind') === 'panel' ? 'panel' : 'sidebar';
  const tab = query.get('tab') ?? 'chat';
  // Same policy as src/vscode/host/html.ts, with this server's origin in place of the webview source.
  const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${origin}; style-src ${origin} 'unsafe-inline'; font-src ${origin}; img-src ${origin} data:`;
  const boot = `
    const diag = [];
    window.__diag = diag;
    document.addEventListener('securitypolicyviolation', (e) => diag.push('CSP ' + e.violatedDirective + ' ' + e.blockedURI));
    window.addEventListener('error', (e) => diag.push('ERROR ' + e.message));
    window.addEventListener('unhandledrejection', (e) => diag.push('REJECTION ' + String(e.reason)));
    const state = ${JSON.stringify(parsed.data).replace(/</g, '\\u003c')};
    if (new URLSearchParams(location.search).get('restore') === '1') state.restorePreview = ${JSON.stringify(restorePreview)};
    const sent = [];
    window.__sent = sent;
    let saved;
    const deliver = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
    window.acquireVsCodeApi = () => ({
      postMessage(message) {
        sent.push(message);
        if (message.type === 'ready' || message.type === 'resync') {
          setTimeout(() => {
            deliver({ type: 'init', seq: 0, state });
            ${tab !== 'chat' ? `setTimeout(() => deliver({ type: 'event', event: { kind: 'show-tab', tab: ${JSON.stringify(tab)} } }), 50);` : ''}
          }, 0);
        }
      },
      getState: () => saved,
      setState: (value) => { saved = value; },
    });
    setInterval(() => {
      let node = document.getElementById('preview-diag');
      if (!node) { node = document.createElement('script'); node.type = 'application/json'; node.id = 'preview-diag'; document.body.appendChild(node); }
      node.textContent = JSON.stringify({ diag, sent: sent.map((m) => m.type) });
    }, 250);`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${themeCss(THEMES[theme])}</style>
<link rel="stylesheet" href="/main.css">
<title>AgentCanopy preview</title>
</head>
<body class="vscode-${theme}" data-view-kind="${kind}">
<div id="root"></div>
<script nonce="${nonce}">${boot}</script>
<script type="module" nonce="${nonce}" src="/main.js"></script>
</body>
</html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const origin = `http://${req.headers.host}`;
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page(origin, url.searchParams));
    return;
  }
  const file = normalize(join(webviewDir, decodeURIComponent(url.pathname)));
  if (!file.startsWith(webviewDir) || !existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

if (!process.argv.includes('--check')) {
  console.log(`Preview: ${base}/   (add ?tab=plan, ?theme=light, ?kind=panel)`);
} else {
  const chrome =
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (!existsSync(chrome)) {
    console.error('Chrome was not found. Set CHROME_PATH.');
    process.exit(1);
  }
  const out =
    process.env.AGENTCANOPY_PREVIEW_OUT ?? mkdtempSync(join(tmpdir(), 'agc-preview-out-'));
  mkdirSync(out, { recursive: true });
  const run = (args) =>
    new Promise((done) => {
      const child = spawn(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          `--user-data-dir=${mkdtempSync(join(tmpdir(), 'agc-chrome-'))}`,
          ...args,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', () => done(stdout));
    });
  const views = [
    { name: 'chat-dark', query: '?tab=chat', size: '520,1900' },
    { name: 'plan-dark', query: '?tab=plan', size: '520,3600' },
    { name: 'plan-panel-light', query: '?tab=plan&theme=light&kind=panel', size: '1100,2600' },
    { name: 'history-light', query: '?tab=history&theme=light', size: '520,700' },
    { name: 'review-dark', query: '?tab=review', size: '520,1500' },
    { name: 'checkpoints-dark', query: '?tab=checkpoints', size: '520,700' },
    {
      name: 'restore-preview-light',
      query: '?tab=checkpoints&restore=1&theme=light',
      size: '520,1100',
    },
  ];
  const report = [];
  for (const view of views) {
    const url = `${base}/${view.query}`;
    await run([
      `--window-size=${view.size}`,
      '--virtual-time-budget=15000',
      `--screenshot=${join(out, `${view.name}.png`)}`,
      url,
    ]);
    const dom = await run(['--virtual-time-budget=15000', '--dump-dom', url]);
    writeFileSync(join(out, `${view.name}.html`), dom);
    const diag = /<script type="application\/json" id="preview-diag">(.*?)<\/script>/s.exec(dom);
    report.push({
      view: view.name,
      svgDiagrams: (dom.match(/<svg[^>]*aria-roledescription=/g) ?? []).length,
      diagramFailures: (dom.match(/could not be drawn/g) ?? []).length,
      stillDrawing: (dom.match(/Drawing diagram/g) ?? []).length,
      rendered: dom.includes('role="tablist"'),
      diagnostics: diag
        ? JSON.parse(diag[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
        : 'none captured',
    });
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`Output: ${out}`);
  server.close();
  process.exit(0);
}
