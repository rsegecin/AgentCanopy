import * as vscode from 'vscode';
import type { HostTestApi } from '../../../src/vscode/host';

export const EXTENSION_ID = 'agentcanopy-local.agentcanopy';

/** Activates the extension and returns what it exports in test mode. */
export async function activateExtension(): Promise<HostTestApi> {
  const extension = vscode.extensions.getExtension<HostTestApi | undefined>(EXTENSION_ID);
  if (!extension) throw new Error(`extension ${EXTENSION_ID} not found`);
  const api = await extension.activate();
  if (!api) throw new Error('the extension returned no test API: is it running in test mode?');
  return api;
}

export async function waitFor<T>(
  describe: string,
  probe: () => T | undefined | false,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Like `waitFor`, for a probe that has to ask something asynchronously. */
export async function waitForAsync<T>(
  describe: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
