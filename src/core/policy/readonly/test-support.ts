import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentEvent,
  ConversationId,
  ConversationMeta,
  FolderKey,
  Mode,
  PromptAnswer,
  Settings,
} from '../../../shared';
import { DEFAULT_SETTINGS } from '../../../shared';
import type { Logger, NewPrompt, PolicyContext } from '../../contracts';
import { createGrantStore, type GrantStore } from '../grants';

/** Test support for this package. Not exported from the package. */

/** A grant store on a directory that is created now (the caller removes it). */
export async function openGrantStore(dir: string, logger?: Logger): Promise<GrantStore> {
  const store = createGrantStore(logger ? { dir, logger } : { dir });
  await store.init();
  return store;
}

/** A logger that keeps its warnings. */
export function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => void warnings.push(message),
      error: () => undefined,
    },
  };
}

/**
 * Makes `os.homedir()` answer with this directory until the returned function is called. The
 * temporary directories of the tests lie under the real home directory (and, on Windows, under
 * `AppData`, which is sensitive), so a test of what is sensitive needs a home of its own.
 */
export function useHome(home: string): () => void {
  const saved = { HOME: process.env['HOME'], USERPROFILE: process.env['USERPROFILE'] };
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export async function makeTempDir(prefix: string): Promise<string> {
  // realpath, so that /var -> /private/var on macOS does not confuse comparisons.
  return fs.realpath(await fs.mkdtemp(join(tmpdir(), `${prefix}-`)));
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/** Every entry below `dir` (files, directories and links), relative, sorted. */
export async function listAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    out.push(entry.name);
    if (entry.isDirectory()) {
      for (const inner of await listAll(join(dir, entry.name))) out.push(`${entry.name}/${inner}`);
    }
  }
  return out.sort();
}

export function meta(
  id = 'conversation-1',
  mode: Mode = 'ask',
  planLocked = false,
): ConversationMeta {
  return {
    id: id as ConversationId,
    title: 'Test',
    createdAt: 0,
    updatedAt: 0,
    folder: 'folder-1' as FolderKey,
    providerId: 'claude',
    model: 'default',
    mode,
    planLocked,
  };
}

export interface FakeAsk {
  context: PolicyContext;
  prompts: NewPrompt[];
}

/** A policy context whose `askUser` records the prompts and gives the stated answer. */
export function makeContext(options: {
  folderPath: string;
  answer?: PromptAnswer | undefined;
  settings?: Partial<Settings>;
  conversationId?: string;
  mode?: Mode;
  planLocked?: boolean;
  /** Agent mode's Auto applies to the decision. Default false. */
  auto?: boolean;
  /** Fields of the conversation meta to override. */
  conversation?: Partial<ConversationMeta>;
}): FakeAsk {
  const prompts: NewPrompt[] = [];
  const context: PolicyContext = {
    conversation: {
      ...meta(options.conversationId, options.mode, options.planLocked),
      ...options.conversation,
    },
    mode: options.mode ?? 'ask',
    folder: { key: 'folder-1' as FolderKey, name: 'folder', path: options.folderPath },
    settings: { ...DEFAULT_SETTINGS, ...options.settings },
    auto: options.auto ?? false,
    askUser(prompt) {
      prompts.push(prompt);
      return Promise.resolve(options.answer);
    },
  };
  return { context, prompts };
}

export function sessionEvent(overrides: Partial<Extract<AgentEvent, { type: 'session' }>> = {}) {
  const event: Extract<AgentEvent, { type: 'session' }> = {
    type: 'session',
    sessionId: 'session-1',
    model: 'claude-haiku-5-5',
    cliVersion: '2.1.322',
    tools: ['AskUserQuestion', 'Glob', 'Grep', 'Read'],
    mcpServers: [{ name: 'agentcanopy', status: 'connected' }],
    plugins: [{ name: 'cc-plugin-privacy', builtin: true }],
    permissionMode: 'default',
    cwd: '/work',
    credential: 'subscription',
    ...overrides,
  };
  return event;
}
