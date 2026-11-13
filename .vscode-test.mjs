import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';
import { prepareIntegrationRun } from './test/integration/support/prepare.ts';

// The executable is `Code` in current macOS builds and `Electron` in older ones.
const macAppBinaries = [
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
];
const installed = process.env.AGENTCANOPY_VSCODE_PATH ?? macAppBinaries.find((p) => existsSync(p));

// Keep the profile inside the repository and the paths short (macOS socket path limit).
const root = join(import.meta.dirname, '.vscode-test');

// A scratch workspace folder and a scenario for the fake CLI that stands in for Claude Code.
const run = await prepareIntegrationRun(root);

// Both runs share the profile and the workspace folder, so the second one is a real restart.
const shared = {
  // Use an installed VS Code when available, otherwise download one (CI).
  ...(installed ? { useInstallation: { fromPath: installed } } : { version: 'stable' }),
  workspaceFolder: run.workspaceFolder,
  // An isolated profile. Trust prompts are off so the scratch folder counts as trusted.
  launchArgs: [
    `--user-data-dir=${join(root, 'ud')}`,
    `--extensions-dir=${join(root, 'ext')}`,
    '--disable-workspace-trust',
  ],
  mocha: { ui: 'tdd', timeout: 20000 },
};

export default defineConfig([
  {
    ...shared,
    label: 'main',
    // `last/` holds the test that prepares the restart run; it has to run after everything else.
    files: ['dist-test/integration/*.test.cjs', 'dist-test/integration/last/*.test.cjs'],
    env: run.env,
  },
  {
    ...shared,
    label: 'restart',
    files: 'dist-test/integration/restart/*.test.cjs',
    env: { ...run.env, FAKE_CLAUDE_RECORD: join(root, 'restart-record.json') },
  },
]);
