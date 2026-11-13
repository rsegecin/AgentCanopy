// Prepares one integration run: a scratch workspace folder, the fake CLI's default scenario and
// the environment of the extension host. Imported by `.vscode-test.mjs`, so it runs on plain Node
// (type stripping, Node 22.18 or newer) and may only use erasable TypeScript syntax.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The fake CLI helpers, loaded at run time because TypeScript rejects `.ts` import specifiers. */
async function loadFakeCli(): Promise<typeof import('../../fake-cli/index')> {
  const url = new URL('../../fake-cli/index.ts', import.meta.url).href;
  return (await import(url)) as typeof import('../../fake-cli/index');
}

export interface IntegrationRun {
  /** Folder VS Code opens. It is created empty (plus one file) at the start of every run. */
  workspaceFolder: string;
  scenarioPath: string;
  /** Environment variables of the extension host. */
  env: Record<string, string>;
}

/** `root` is the `.vscode-test` directory of the repository. */
export async function prepareIntegrationRun(root: string): Promise<IntegrationRun> {
  const { resultEvent, textTurn } = await loadFakeCli();
  const workspaceFolder = join(root, 'ws');
  rmSync(workspaceFolder, { recursive: true, force: true });
  mkdirSync(workspaceFolder, { recursive: true });
  writeFileSync(join(workspaceFolder, 'hello.txt'), 'hello\n');

  const scenarioPath = join(root, 'scenario.json');
  const steps = [...textTurn('pong'), ...resultEvent('pong')];
  writeFileSync(scenarioPath, JSON.stringify({ steps }));

  const fakeClaude = resolve(import.meta.dirname, '..', '..', 'fake-cli', 'fake-claude.mjs');
  const launch = {
    command: process.execPath,
    prefixArgs: [fakeClaude],
    env: { FAKE_CLAUDE_SCENARIO: scenarioPath },
  };
  return {
    workspaceFolder,
    scenarioPath,
    env: {
      AGENTCANOPY_TEST_LAUNCH: JSON.stringify(launch),
      FAKE_CLAUDE_SCENARIO: scenarioPath,
    },
  };
}
