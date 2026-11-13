import eslint from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const nodeBuiltins = [
  'assert',
  'buffer',
  'child_process',
  'cluster',
  'crypto',
  'dgram',
  'dns',
  'events',
  'fs',
  'http',
  'http2',
  'https',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'readline',
  'stream',
  'string_decoder',
  'tls',
  'url',
  'util',
  'worker_threads',
  'zlib',
];

const pureLayerGroups = [
  {
    group: ['vscode', 'react', 'react-dom', 'react-dom/*', 'react/*'],
    message: 'src/shared and src/core must stay free of vscode and react.',
  },
  {
    group: ['**/vscode', '**/vscode/**', '**/webview', '**/webview/**'],
    message: 'src/shared and src/core must not import from src/vscode or src/webview.',
  },
];

const webviewGroups = [
  {
    group: ['vscode'],
    message: 'The webview cannot import the vscode module.',
  },
  {
    group: ['node:*', ...nodeBuiltins, ...nodeBuiltins.map((m) => `${m}/*`)],
    message: 'The webview cannot import Node built-ins.',
  },
  {
    group: ['**/core', '**/core/**', '**/vscode', '**/vscode/**'],
    message: 'The webview may only import from src/shared and its own folder.',
  },
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-test/**',
      'node_modules/**',
      '.vscode-test/**',
      'spike/**',
      'docs/**',
      'coverage/**',
      'test/fixtures/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.config.mjs', 'esbuild.mjs', '.vscode-test.mjs', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    files: ['src/shared/**/*.{ts,tsx}', 'src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: pureLayerGroups }],
    },
  },
  {
    files: ['src/webview/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': ['error', { patterns: webviewGroups }],
    },
  },
);
