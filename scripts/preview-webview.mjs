// Serves the built webview in a plain browser with sample state, under the same Content Security
// Policy the extension uses. It exists to look at the UI and to check that it really renders
// (Markdown, code, Mermaid, cards, plan cards) without starting VS Code.
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
      title: version === 1 ? 'Rate limiting for the API' : 'Add rate limiting to the public API',
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
      targetId: 'Which clients need a higher limit?',
      kind: 'interactive-question',
      values: ['Internal services'],
      decidedAt: now - 55000,
    },
    {
      targetId: 'q-store',
      kind: 'decision-point',
      values: ['redis'],
      decidedAt: now - 40000,
      planVersion: 2,
    },
    {
      targetId: 'q-limit',
      kind: 'open-question',
      values: ['600 requests per minute'],
      decidedAt: now - 38000,
      planVersion: 2,
    },
  ],
  approvals: [{ version: 2, contentHash: 'hash2', approvedAt: now - 30000, executionTurnId: 't3' }],
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
      {
        id: 't2',
        mode: 'plan',
        model: 'sonnet',
        startedAt: now - 60000,
        endedAt: now - 31000,
        status: 'completed',
      },
      { id: 't3', mode: 'agent', model: 'sonnet', startedAt: now - 30000, status: 'running' },
    ],
    messages: [
      {
        role: 'user',
        id: 'm1',
        turnId: 't1',
        createdAt: now - 120000,
        text: 'How do requests reach the handlers?',
        mode: 'ask',
        attachments: [
          { kind: 'file', path: 'src/server/router.ts' },
          {
            kind: 'image',
            id: '3f2a9c71d0b84e5a96c1f7e2a4d8b03c5e6f1a2b7c9d0e8f4a3b2c1d0e9f8a7b',
            mediaType: 'image/png',
            bytes: 123456,
          },
        ],
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
          {
            kind: 'notice',
            level: 'warning',
            text: "A Claude Code plugin is loaded (example). Plugins run outside AgentCanopy's read-only guarantee.",
          },
          tool('toolu_p1', 'Read', { file_path: 'src/server/rate-limit.ts' }),
          tool(
            'toolu_3',
            'AskUserQuestion',
            {
              questions: [
                {
                  question: 'Which clients need a higher limit?',
                  header: 'Clients',
                  multiSelect: false,
                  options: [{ label: 'Internal services' }, { label: 'Partners' }],
                },
              ],
            },
            { approval: 'user', resultPreview: 'Internal services' },
          ),
          { kind: 'prompt', promptId: 'pr1' },
          tool('toolu_p2', 'Grep', { pattern: 'rateLimit', path: 'src' }),
          tool('toolu_s1', 'mcp__agentcanopy__submit_plan', { plan: '# Plan' }),
          { kind: 'plan-update', planId: 'p1', version: 1 },
          { kind: 'text', text: 'Thanks. I added a Redis stage and wrote the choices down.' },
          tool('toolu_s2', 'mcp__agentcanopy__submit_plan', { plan: '# Plan' }),
          { kind: 'plan-update', planId: 'p1', version: 2 },
        ],
      },
      {
        role: 'user',
        id: 'm5',
        turnId: 't3',
        createdAt: now - 30000,
        text: 'Execute plan version 2',
        mode: 'agent',
        attachments: [],
      },
      {
        role: 'assistant',
        id: 'm6',
        turnId: 't3',
        createdAt: now - 25000,
        parts: [
          tool(
            'toolu_e1',
            'Edit',
            {
              file_path: 'src/server/rate-limit.ts',
              old_string: 'const LIMIT = 60;',
              new_string: 'const LIMIT = 600;',
            },
            { approval: 'policy' },
          ),
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
        createdAt: now - 56000,
        state: 'answered',
        answered: { 'Which clients need a higher limit?': 'Internal services' },
        displayHash: 'h1',
        kind: 'question',
        questions: [
          {
            question: 'Which clients need a higher limit?',
            header: 'Clients',
            multiSelect: false,
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
        turnId: 't3',
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
    queued: null,
    asides: [],
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
    busy: false,
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

// Side questions of the running Agent turn: asked while it was writing its last message (m6), after
// its first part. `streaming` is mid-answer; `done` has finished. Used by ?aside=running|done.
const asideAnchor = { messageId: 'm6', afterParts: 1 };
const asideSamples = {
  streaming: shared.AsideSchema.parse({
    conversationId: 'c-aside-1',
    anchor: asideAnchor,
    question: 'Which header does the limiter key on today?',
    parts: [
      tool(
        'toolu_a1',
        'Grep',
        { pattern: 'x-api-key', path: 'src' },
        { resultPreview: 'src/server/rate-limit.ts:31' },
      ),
      {
        kind: 'text',
        text: 'It keys on the `x-api-key` header, falling back to the client IP when that is missing. The lookup is in `src/server/rate-limit.ts:31`, and the',
      },
    ],
    prompts: [],
    status: 'running',
  }),
  done: shared.AsideSchema.parse({
    conversationId: 'c-aside-1',
    anchor: asideAnchor,
    question: 'Which header does the limiter key on today?',
    parts: [
      tool(
        'toolu_a1',
        'Grep',
        { pattern: 'x-api-key', path: 'src' },
        { resultPreview: 'src/server/rate-limit.ts:31' },
      ),
      {
        kind: 'text',
        text: 'It keys on the `x-api-key` header, falling back to the client IP when that is missing. The lookup is in `src/server/rate-limit.ts:31`.\n\n- Keys are hashed before they are stored.\n- Anonymous clients share one bucket per IP.',
      },
    ],
    prompts: [],
    status: 'completed',
  }),
};
// Side questions in History: one under its parent, one whose parent is gone.
const asideSummaries = [
  shared.ConversationSummarySchema.parse({
    ...meta,
    id: 'c-aside-1',
    title: 'Which header does the limiter key on today?',
    mode: 'ask',
    updatedAt: now - 20000,
    preview: 'It keys on the x-api-key header…',
    running: false,
    pendingPrompts: 0,
    planId: undefined,
    fork: { parentId: conv, atMessageId: 'm5', exactness: 'reconstructed', lost: [] },
    aside: { parentId: conv, anchor: asideAnchor },
  }),
  shared.ConversationSummarySchema.parse({
    ...meta,
    id: 'c-aside-2',
    title: 'Is the build cache shared between branches?',
    mode: 'ask',
    updatedAt: now - 95000000,
    preview: 'No, each branch has its own cache.',
    running: false,
    pendingPrompts: 0,
    planId: undefined,
    fork: { parentId: 'c-deleted', atMessageId: 'm1', exactness: 'reconstructed', lost: [] },
    aside: { parentId: 'c-deleted', anchor: { messageId: 'm1', afterParts: 0 } },
  }),
];

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
    const params = new URLSearchParams(location.search);
    // ?busy=1: an Agent turn runs in the folder, so the changes card hides its Files section.
    if (params.get('busy') === '1') state.review.busy = true;
    // ?empty=1: no conversation is open, one configuration change is pending, and the composer is in Agent mode.
    if (params.get('empty') === '1') {
      state.active = null;
      state.review = { entries: [], configChanges: state.review.configChanges.slice(0, 1), busy: false };
      state.baseline = { state: 'idle', filesDone: 0, filesTotal: 0 };
      state.defaults = { ...state.defaults, mode: 'agent' };
    }
    // ?plan=pending: the plan was just submitted, its questions are open and no turn runs, while the
    // configuration changes are still pending, so Approve and Execute is disabled for that reason.
    // ?plan=ready: the same, and the configuration changes are settled too, so Approve and Execute is enabled.
    const planVariant = params.get('plan');
    if ((planVariant === 'pending' || planVariant === 'ready') && state.active) {
      const a = state.active;
      a.messages = a.messages.filter((m) => m.turnId !== 't3');
      a.turns = a.turns
        .filter((t) => t.id !== 't3')
        .map((t) => ({ ...t, status: 'completed', endedAt: t.endedAt ?? Date.now() }));
      a.prompts = a.prompts.filter((p) => p.turnId !== 't3');
      a.activity = null;
      a.plan = {
        ...a.plan,
        approvals: [],
        decisions: a.plan.decisions.filter((d) => d.kind === 'interactive-question'),
      };
      if (planVariant === 'ready') state.review = { ...state.review, configChanges: [], busy: false };
    }
    // ?queued=running: an Agent message waits behind the running turn (Stop and Send both show; the chip offers Send now).
    // ?queued=stopped: the turn was stopped, so the message is held and the chip offers Send.
    const queuedVariant = params.get('queued');
    if ((queuedVariant === 'running' || queuedVariant === 'stopped') && state.active) {
      const a = state.active;
      a.meta = { ...a.meta, mode: 'agent' };
      a.prompts = a.prompts.filter((p) => p.turnId !== 't3');
      state.review = { ...state.review, configChanges: [], busy: false };
      if (queuedVariant === 'stopped') {
        a.turns = a.turns.map((t) => (t.id === 't3' ? { ...t, status: 'interrupted', endedAt: Date.now() } : t));
        a.activity = null;
      }
      a.queued = {
        text: 'Also add a test for the burst limit, and update the README section on rate limiting. Keep the existing public API as it is.',
        mode: 'agent',
        model: 'sonnet',
        attachments: [{ kind: 'file', path: 'src/server/rate-limit.ts' }],
        queuedAt: Date.now(),
      };
    }
    // ?aside=running: a side question streams in the middle of the running turn's message, and the
    // composer is in Ask mode: it shows the hint "A side question is already running" and Send is disabled.
    // ?aside=done: the same, with the side question finished: the composer shows the note that a message
    // in Ask mode is asked as a side question, and Send is enabled.
    // ?aside=history: the conversations list has two side questions (use with ?tab=history).
    const asideVariant = params.get('aside');
    if ((asideVariant === 'running' || asideVariant === 'done') && state.active) {
      const a = state.active;
      a.meta = { ...a.meta, mode: 'ask' };
      a.prompts = a.prompts.filter((p) => p.turnId !== 't3');
      state.review = { ...state.review, configChanges: [], busy: false };
      a.messages = a.messages.map((m) =>
        m.id === 'm6'
          ? {
              ...m,
              parts: [
                m.parts[0],
                { kind: 'text', text: 'The limit is raised. Now I am updating the tests that pinned the old value.' },
                m.parts[1] && { ...m.parts[1], call: { ...m.parts[1].call, status: 'done', approval: 'policy', endedAt: Date.now() } },
              ].filter(Boolean),
            }
          : m,
      );
      a.asides = [${JSON.stringify(asideSamples)}[asideVariant === 'running' ? 'streaming' : 'done']];
    }
    // ?sendMode=ask: the parent's turn runs in Agent mode and the user has switched the composer to Ask
    // while it runs. No side question runs, so the composer shows the note "Asked as a side question: the
    // agent keeps working and does not see it." The choice is view-local (in memory, not part of the
    // state), so the boot script clicks the radio once the composer is on the page.
    const sendMode = params.get('sendMode');
    if ((sendMode === 'ask' || sendMode === 'plan') && state.active) {
      const a = state.active;
      a.meta = { ...a.meta, mode: 'agent' };
      a.prompts = a.prompts.filter((p) => p.turnId !== 't3');
      state.review = { ...state.review, configChanges: [], busy: false };
      const pick = setInterval(() => {
        const radio = document.querySelector('input[type="radio"][value="' + sendMode + '"]');
        if (!radio) return;
        clearInterval(pick);
        radio.click();
      }, 50);
    }
    if (asideVariant === 'history') {
      state.conversations = [...state.conversations, ...${JSON.stringify(asideSummaries)}];
    }
    const sent = [];
    window.__sent = sent;
    // ?collapsed=1: the user has collapsed the changes card.
    let saved = params.get('collapsed') === '1' ? { expanded: { 'changes-dock-collapsed': true } } : undefined;
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
  console.log(
    `Preview: ${base}/   (add ?plan=pending, ?plan=ready, ?tab=history, ?theme=light, ?kind=panel, ?busy=1, ?empty=1, ?collapsed=1, ?queued=running, ?queued=stopped, ?aside=running, ?aside=done, ?aside=history, ?sendMode=ask)`,
  );
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
    { name: 'chat-dark', query: '?tab=chat', size: '520,3200' },
    { name: 'chat-plan-pending-dark', query: '?tab=chat&plan=pending', size: '520,2600' },
    { name: 'chat-plan-ready-dark', query: '?tab=chat&plan=ready', size: '520,2600' },
    {
      name: 'chat-plan-pending-panel-light',
      query: '?tab=chat&plan=pending&theme=light&kind=panel',
      size: '1100,1400',
    },
    { name: 'chat-changes-dark', query: '?tab=chat', size: '520,900' },
    { name: 'chat-changes-collapsed-dark', query: '?tab=chat&collapsed=1', size: '520,900' },
    { name: 'chat-changes-busy-dark', query: '?tab=chat&busy=1', size: '520,900' },
    { name: 'chat-queued-running-dark', query: '?tab=chat&queued=running', size: '520,900' },
    { name: 'chat-queued-stopped-dark', query: '?tab=chat&queued=stopped', size: '520,900' },
    { name: 'chat-empty-config-dark', query: '?tab=chat&empty=1', size: '520,700' },
    {
      name: 'chat-panel-changes-light',
      query: '?tab=chat&theme=light&kind=panel',
      size: '1100,900',
    },
    { name: 'chat-aside-streaming-dark', query: '?tab=chat&aside=running', size: '520,1500' },
    { name: 'chat-aside-switch-dark', query: '?tab=chat&sendMode=ask', size: '520,1500' },
    { name: 'chat-aside-done-light', query: '?tab=chat&aside=done&theme=light', size: '520,1500' },
    { name: 'history-light', query: '?tab=history&theme=light', size: '520,700' },
    { name: 'history-aside-dark', query: '?tab=history&aside=history', size: '520,700' },
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
