import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { DEFAULT_SETTINGS } from '../../src/shared';
import { readSettings } from '../../src/vscode/host/settings';

const MB = 1024 * 1024;

suite('settings', () => {
  const configuration = (): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration('agentCanopy');
  const set = (key: string, value: unknown): Thenable<void> =>
    configuration().update(key, value, vscode.ConfigurationTarget.Global);
  const touched = new Set<string>();
  const change = async (key: string, value: unknown): Promise<void> => {
    touched.add(key);
    await set(key, value);
  };

  teardown(async () => {
    for (const key of touched) await set(key, undefined);
    touched.clear();
  });

  test('the defaults are read', () => {
    assert.deepStrictEqual(readSettings(), DEFAULT_SETTINGS);
  });

  test('a changed value is read', async () => {
    await change('defaultMode', 'agent');
    assert.strictEqual(readSettings().defaultMode, 'agent');
  });

  test('megabytes become bytes', async () => {
    await change('snapshots.maxFileSizeMB', 2);
    await change('snapshots.maxTotalSizeMB', 64);
    const settings = readSettings();
    assert.strictEqual(settings.snapshotMaxFileBytes, 2 * MB);
    assert.strictEqual(settings.snapshotMaxTotalBytes, 64 * MB);
  });

  test('an invalid value falls back to its default and is logged by key', async () => {
    await change('defaultMode', 'nonsense');
    await change('agent.sandbox', true);
    const warnings: { message: string; data?: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (message: string, data?: Record<string, unknown>) => {
        warnings.push(data ? { message, data } : { message });
      },
      error: () => undefined,
    };
    const settings = readSettings(logger);
    assert.strictEqual(settings.defaultMode, DEFAULT_SETTINGS.defaultMode);
    assert.strictEqual(settings.sandbox, true, 'valid keys are kept');
    assert.ok(warnings.some((w) => w.data?.key === 'agentCanopy.defaultMode'));
  });
});
