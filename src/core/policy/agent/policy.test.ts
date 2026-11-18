import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  type FolderKey,
  type PromptAnswer,
  type Settings,
} from '../../../shared';
import type { AgentEvent } from '../../../shared';
import type { PermissionRequest, PolicyDecision } from '../../contracts';
import type { GrantStore } from '../grants';
import { projectSlug } from '../readonly/claude-memory';
import {
  makeContext,
  makeTempDir,
  openGrantStore,
  recordingLogger,
  removeDir,
  sessionEvent,
  useHome,
  writeTree,
  type FakeAsk,
} from '../readonly/test-support';
import { createAgentPolicy, createRuleStore, type RuleStore } from './index';

// The path check the policy awaits, with a way to hold it open: a test can then change the context
// while the policy waits. Passes through when nothing is held.
const pathChecks = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
}));
vi.mock('../readonly/targets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../readonly/targets')>();
  return {
    ...actual,
    checkPath: async (...args: Parameters<typeof actual.checkPath>) => {
      const result = await actual.checkPath(...args);
      pathChecks.started?.();
      if (pathChecks.hold) await pathChecks.hold;
      return result;
    },
  };
});

const ALLOW_ONCE: PromptAnswer = { kind: 'permission', choice: 'allow-once' };
const ALLOW_ALWAYS: PromptAnswer = { kind: 'permission', choice: 'allow-always' };
const DENY: PromptAnswer = { kind: 'permission', choice: 'deny' };

function request(toolName: string, input: unknown): PermissionRequest {
  return {
    toolCallId: 'toolu_1',
    toolName,
    input: input as Record<string, unknown>,
    signal: new AbortController().signal,
  };
}

const allowUser: PolicyDecision = { response: { behavior: 'allow' }, approval: 'user' };
const allowPolicy: PolicyDecision = { response: { behavior: 'allow' }, approval: 'policy' };
const deny = (message: string, approval: 'policy' | 'user' = 'policy'): PolicyDecision => ({
  response: { behavior: 'deny', message },
  approval,
});

function fakeRules(initial: Record<string, string[]> = {}) {
  const calls: { op: string; key: string; rule: string }[] = [];
  const data = new Map(Object.entries(initial));
  const store: RuleStore = {
    init: () => Promise.resolve(),
    list: (key) => [...(data.get(key) ?? [])],
    add: (key, rule) => {
      calls.push({ op: 'add', key, rule });
      data.set(key, [...(data.get(key) ?? []), rule]);
      return Promise.resolve();
    },
    remove: (key, rule) => {
      calls.push({ op: 'remove', key, rule });
      data.set(
        key,
        (data.get(key) ?? []).filter((entry) => entry !== rule),
      );
      return Promise.resolve();
    },
  };
  return { store, calls };
}

describe('agent policy', () => {
  let root: string;
  let folder: string;
  let outside: string;

  beforeEach(async () => {
    root = await makeTempDir('agent-policy');
    folder = join(root, 'folder');
    outside = join(root, 'outside');
    await writeTree(folder, { 'src/a.ts': 'a', '.env': 'S=1', '.vscode/settings.json': '{}' });
    await writeTree(outside, { 'secret.txt': 's' });
    await fs.symlink(outside, join(folder, 'link-out'));
    await fs.symlink(join(folder, 'src'), join(folder, 'link-in'));
    await fs.symlink(join(folder, '.vscode'), join(folder, 'link-vscode'));
  });
  afterEach(() => removeDir(root));

  function setup(
    options: {
      answer?: PromptAnswer | undefined;
      settings?: Partial<Settings>;
      rules?: ReturnType<typeof fakeRules>;
      /** Agent mode's Auto applies. Default false, which every test outside the Auto block uses. */
      auto?: boolean;
    } = {},
  ) {
    const rules = options.rules ?? fakeRules();
    const policy = createAgentPolicy({ rules: rules.store });
    const ask: FakeAsk = makeContext({
      folderPath: folder,
      answer: options.answer,
      settings: options.settings,
      mode: 'agent',
      ...(options.auto !== undefined ? { auto: options.auto } : {}),
    });
    const decide = (toolName: string, input: unknown) =>
      policy.decide(request(toolName, input), ask.context);
    return { policy, rules, ask, decide, prompts: ask.prompts };
  }

  describe('profile', () => {
    const profile = (mode: 'ask' | 'plan' | 'agent', settings: Partial<Settings> = {}) => {
      const { context } = makeContext({ folderPath: folder, mode, settings });
      return createAgentPolicy({
        rules: fakeRules({ 'folder-1': ['Bash(npm test)', 'mcp__x__y'] }).store,
      }).profile({
        mode,
        settings: context.settings,
        conversation: context.conversation,
      });
    };

    it('agent mode carries the stored rules and the settings', () => {
      expect(profile('agent')).toEqual({
        kind: 'agent',
        allowRules: ['Bash(npm test)', 'mcp__x__y'],
        alwaysAskCommands: false,
        sandbox: false,
        sandboxLocked: false,
      });
      expect(profile('agent', { sandbox: true })).toMatchObject({ sandbox: true });
    });

    it('locks the sandbox only with the sandbox setting, the Auto setting and the conversation on', () => {
      const locked = (settings: Partial<Settings>, agentAuto: boolean | undefined) => {
        const { context } = makeContext({
          folderPath: folder,
          mode: 'agent',
          settings,
          ...(agentAuto !== undefined ? { conversation: { agentAuto } } : {}),
        });
        const result = createAgentPolicy({ rules: fakeRules().store }).profile({
          mode: 'agent',
          settings: context.settings,
          conversation: context.conversation,
        });
        return 'kind' in result && result.kind === 'agent' ? result.sandboxLocked : undefined;
      };
      expect(locked({ sandbox: true, agentAuto: true }, true)).toBe(true);
      expect(locked({ sandbox: false, agentAuto: true }, true)).toBe(false);
      expect(locked({ sandbox: true, agentAuto: false }, true)).toBe(false);
      expect(locked({ sandbox: true, agentAuto: true }, false)).toBe(false);
      expect(locked({ sandbox: true, agentAuto: true }, undefined)).toBe(false);
    });

    it('alwaysAskCommands gives no allow rules', () => {
      expect(profile('agent', { alwaysAskCommands: true })).toEqual({
        kind: 'agent',
        allowRules: [],
        alwaysAskCommands: true,
        sandbox: false,
        sandboxLocked: false,
      });
    });

    it('other modes are unavailable', () => {
      expect(profile('ask')).toHaveProperty('unavailable');
      expect(profile('plan')).toHaveProperty('unavailable');
    });
  });

  describe('edits', () => {
    it.each(['Edit', 'Write'])(
      '%s inside the folder is allowed with editApproval auto',
      async (tool) => {
        const { decide, prompts } = setup();
        expect(await decide(tool, { file_path: join(folder, 'src/a.ts') })).toEqual(allowPolicy);
        expect(await decide(tool, { file_path: 'src/a.ts' })).toEqual(allowPolicy);
        expect(prompts).toEqual([]);
      },
    );

    it('NotebookEdit uses notebook_path', async () => {
      const { decide, prompts } = setup();
      expect(await decide('NotebookEdit', { notebook_path: 'src/n.ipynb' })).toEqual(allowPolicy);
      expect(prompts).toEqual([]);
      const out = setup({ answer: DENY });
      await out.decide('NotebookEdit', { notebook_path: join(outside, 'n.ipynb') });
      expect(out.prompts[0]).toMatchObject({ category: 'outside-workspace' });
    });

    it('a Write to a new file under a directory that does not exist yet is inside', async () => {
      const { decide, prompts } = setup();
      expect(await decide('Write', { file_path: 'new/deep/dir/file.ts' })).toEqual(allowPolicy);
      expect(prompts).toEqual([]);
    });

    it('with editApproval ask every edit asks, with the right title and fields', async () => {
      const { decide, prompts } = setup({
        settings: { editApproval: 'ask' },
        answer: ALLOW_ONCE,
      });
      expect(await decide('Edit', { file_path: 'src/a.ts', old_string: 'a' })).toEqual(allowUser);
      expect(await decide('Write', { file_path: 'src/a.ts', content: 'x' })).toEqual(allowUser);
      expect(await decide('Write', { file_path: 'src/new.ts', content: 'x' })).toEqual(allowUser);
      expect(await decide('NotebookEdit', { notebook_path: 'src/n.ipynb' })).toEqual(allowUser);
      expect(prompts.map((p) => (p as { title: string }).title)).toEqual([
        'Edit src/a.ts',
        'Write src/a.ts',
        'Create src/new.ts',
        'Edit src/n.ipynb',
      ]);
      expect(prompts[0]).toMatchObject({
        kind: 'permission',
        toolCallId: 'toolu_1',
        toolName: 'Edit',
        category: 'edit',
        detail: 'src/a.ts',
        choices: ['allow-once', 'deny'],
      });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
    });

    it.each([
      ['a top-level .env', '.env', '.env'],
      ['a file under .vscode', '.vscode/settings.json', '.vscode/settings.json'],
      ['a nested protected path', 'packages/x/.git/config', 'packages/x/.git/config'],
      [
        'a protected file that does not exist yet',
        '.claude/settings.json',
        '.claude/settings.json',
      ],
      [
        'a protected file through a symlink inside',
        'link-vscode/settings.json',
        '.vscode/settings.json',
      ],
      ['an absolute protected path', () => join(folder, '.env.local'), '.env.local'],
    ])('%s asks, even with editApproval auto', async (_name, path, rel) => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      const value = typeof path === 'function' ? path() : path;
      expect(await decide('Edit', { file_path: value })).toEqual(allowUser);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        category: 'protected-path',
        title: 'Edit a protected file',
        detail: rel,
        choices: ['allow-once', 'deny'],
      });
    });

    it.each([
      ['an absolute path outside', () => join(outside, 'x.txt'), () => join(outside, 'x.txt')],
      ['a ../ escape', () => '../outside/x.txt', () => join(outside, 'x.txt')],
      [
        'a symlink inside that leads outside',
        () => 'link-out/secret.txt',
        () => join(outside, 'secret.txt'),
      ],
      [
        'a new file under a symlink that leads outside',
        () => 'link-out/new/f.txt',
        () => join(outside, 'new', 'f.txt'),
      ],
      ['the home folder', () => '~/x.txt', async () => join(await fs.realpath(homedir()), 'x.txt')],
      ['another user home', () => '~other/x.txt', () => '~other/x.txt'],
    ])('%s asks as outside the workspace', async (_name, path, expected) => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      expect(await decide('Write', { file_path: path() })).toEqual(allowUser);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        category: 'outside-workspace',
        title: 'Edit a file outside the workspace',
        detail: await expected(),
        choices: ['allow-once', 'deny'],
      });
    });

    it("an Edit of Claude Code's memory file still asks", async () => {
      const config = join(root, 'config');
      const memdir = join(config, 'projects', projectSlug(folder) ?? '', 'memory');
      await writeTree(memdir, { 'MEMORY.md': '# memory' });
      const saved = process.env['CLAUDE_CONFIG_DIR'];
      process.env['CLAUDE_CONFIG_DIR'] = config;
      try {
        const { decide, prompts } = setup({ answer: DENY });
        await decide('Edit', { file_path: join(memdir, 'MEMORY.md') });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
          category: 'outside-workspace',
          title: 'Edit a file outside the workspace',
        });
      } finally {
        if (saved === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
        else process.env['CLAUDE_CONFIG_DIR'] = saved;
      }
    });

    it('a symlink inside that points back inside is judged by where it leads', async () => {
      const { decide, prompts } = setup();
      expect(await decide('Edit', { file_path: 'link-in/a.ts' })).toEqual(allowPolicy);
      expect(prompts).toEqual([]);
    });

    it('the detail is escaped', async () => {
      const { decide, prompts } = setup({ answer: DENY, settings: { editApproval: 'ask' } });
      await decide('Edit', { file_path: 'src/x‮y\nz.ts' });
      expect(prompts[0]).toMatchObject({
        detail: 'src/x\\u{202E}y\nz.ts',
        title: 'Edit src/x\\u{202E}y\nz.ts',
      });
    });

    it('the three answers', async () => {
      const input = { file_path: '.env' };
      expect(await setup({ answer: ALLOW_ONCE }).decide('Edit', input)).toEqual(allowUser);
      expect(await setup({ answer: DENY }).decide('Edit', input)).toEqual(
        deny('The user declined.', 'user'),
      );
      expect(
        await setup({
          answer: { kind: 'permission', choice: 'deny', feedback: 'no secrets' },
        }).decide('Edit', input),
      ).toEqual(deny('The user declined: no secrets', 'user'));
      expect(await setup({ answer: undefined }).decide('Edit', input)).toEqual(
        deny('The user did not answer.'),
      );
    });

    it('an answer the prompt did not offer denies', async () => {
      const result = await setup({ answer: ALLOW_ALWAYS }).decide('Edit', { file_path: '.env' });
      expect(result.response.behavior).toBe('deny');
      const wrong = await setup({ answer: { kind: 'question', answers: {} } }).decide('Edit', {
        file_path: '.env',
      });
      expect(wrong).toEqual(deny('The user did not answer.'));
    });

    it('a missing or non-string path is denied without asking', async () => {
      for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
        for (const input of [{}, { file_path: 42 }, { file_path: '' }, { notebook_path: null }]) {
          const { decide, prompts } = setup({ answer: ALLOW_ONCE });
          expect(await decide(tool, input)).toEqual(deny('The request could not be checked.'));
          expect(prompts).toEqual([]);
        }
      }
    });
  });

  describe('commands', () => {
    it('Bash with a plain command offers always, with the rule and the project-code flag', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      expect(await decide('Bash', { command: 'npm test' })).toEqual(allowUser);
      expect(await decide('Bash', { command: 'git status' })).toEqual(allowUser);
      expect(prompts[0]).toMatchObject({
        kind: 'permission',
        toolName: 'Bash',
        category: 'command',
        title: 'Run a terminal command',
        detail: 'npm test',
        choices: ['allow-once', 'allow-always', 'deny'],
        alwaysRule: { rule: 'Bash(npm test)', runsProjectCode: true },
      });
      expect(prompts[1]).toMatchObject({
        alwaysRule: { rule: 'Bash(git status)', runsProjectCode: false },
      });
    });

    it('a command with a leading assignment offers no always rule', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      await decide('Bash', { command: 'PATH=./bin ls' });
      expect(prompts[0]).toMatchObject({ choices: ['allow-once', 'deny'] });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
    });

    it('a command with no exact rule offers allow-once and deny only', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      await decide('Bash', { command: 'echo hi > f' });
      expect(prompts[0]).toMatchObject({ choices: ['allow-once', 'deny'] });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
    });

    it('PowerShell asks and offers no always', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      expect(await decide('PowerShell', { command: 'Get-ChildItem' })).toEqual(allowUser);
      expect(prompts[0]).toMatchObject({
        toolName: 'PowerShell',
        category: 'command',
        choices: ['allow-once', 'deny'],
      });
    });

    it('the detail is the full command, escaped, never cut', async () => {
      const command = `echo ${'x'.repeat(4990)}`;
      expect(command).toHaveLength(4995);
      const { decide, prompts } = setup({ answer: DENY });
      await decide('Bash', { command });
      expect((prompts[0] as { detail: string }).detail).toBe(command);
      const odd = setup({ answer: DENY });
      await odd.decide('Bash', { command: 'echo a‮b\u001b[31m' });
      expect(odd.prompts[0]).toMatchObject({ detail: 'echo a\\u{202E}b\\u{001B}[31m' });
    });

    it('the preview is the input as JSON, cut', async () => {
      const { decide, prompts } = setup({ answer: DENY });
      await decide('Bash', { command: 'x'.repeat(5000) });
      const preview = (prompts[0] as { inputPreview: string }).inputPreview;
      expect(preview.length).toBe(4000);
      expect(preview.startsWith('{\n  "command": "xxx')).toBe(true);
    });

    it('allow-always saves the rule and allows; the same command then passes without a prompt', async () => {
      const { decide, prompts, rules } = setup({ answer: ALLOW_ALWAYS });
      expect(await decide('Bash', { command: 'npm test' })).toEqual(allowUser);
      expect(rules.calls).toEqual([{ op: 'add', key: 'folder-1', rule: 'Bash(npm test)' }]);
      expect(prompts).toHaveLength(1);

      expect(await decide('Bash', { command: 'npm test' })).toEqual(allowUser);
      expect(prompts).toHaveLength(1);
      expect(rules.calls).toHaveLength(1);

      // A different command still prompts.
      await decide('Bash', { command: 'npm test -- --watch' });
      expect(prompts).toHaveLength(2);
    });

    it('a removed rule asks again, and a rule of another folder does not count', async () => {
      const { decide, prompts, rules, policy, ask } = setup({ answer: ALLOW_ALWAYS });
      await decide('Bash', { command: 'npm test' });
      await decide('mcp__github__create_issue', {});
      expect(prompts).toHaveLength(2);
      expect(await decide('Bash', { command: 'npm test' })).toEqual(allowUser);
      expect(await decide('mcp__github__create_issue', {})).toEqual(allowUser);
      expect(prompts).toHaveLength(2);

      await rules.store.remove('folder-1' as FolderKey, 'Bash(npm test)');
      await rules.store.remove('folder-1' as FolderKey, 'mcp__github__create_issue');
      await decide('Bash', { command: 'npm test' });
      await decide('mcp__github__create_issue', {});
      expect(prompts).toHaveLength(4);

      // Rules saved for another folder do not allow anything here.
      const other = {
        ...ask.context,
        conversation: { ...ask.context.conversation, folder: 'folder-2' as FolderKey },
      };
      await rules.store.add('folder-2' as FolderKey, 'Bash(ls)');
      await policy.decide(request('Bash', { command: 'ls' }), ask.context);
      expect(prompts).toHaveLength(5);
      expect(await policy.decide(request('Bash', { command: 'ls' }), other)).toEqual(allowUser);
      expect(prompts).toHaveLength(5);
    });

    it('a rule that is already stored allows the command without a prompt', async () => {
      const { decide, prompts } = setup({
        answer: DENY,
        rules: fakeRules({ 'folder-1': ['Bash(npm test)'] }),
      });
      expect(await decide('Bash', { command: 'npm test' })).toEqual(allowUser);
      expect(prompts).toEqual([]);
    });

    it('the stored rule is per folder and per store', async () => {
      const first = setup({ answer: ALLOW_ALWAYS });
      await first.decide('Bash', { command: 'npm test' });
      const other = makeContext({
        folderPath: folder,
        answer: DENY,
        mode: 'agent',
      });
      // Same policy, another folder key.
      const elsewhere = {
        ...other.context,
        conversation: { ...other.context.conversation, folder: 'folder-2' as FolderKey },
      };
      const result = await first.policy.decide(request('Bash', { command: 'npm test' }), elsewhere);
      expect(result.response.behavior).toBe('deny');
      expect(other.prompts).toHaveLength(1);
      // A new policy instance has no memory.
      const fresh = setup({ answer: DENY });
      await fresh.decide('Bash', { command: 'npm test' });
      expect(fresh.prompts).toHaveLength(1);
    });

    it('allow-once saves nothing and is not remembered', async () => {
      const { decide, prompts, rules } = setup({ answer: ALLOW_ONCE });
      await decide('Bash', { command: 'npm test' });
      await decide('Bash', { command: 'npm test' });
      expect(prompts).toHaveLength(2);
      expect(rules.calls).toEqual([]);
    });

    it('deny keeps the feedback and saves nothing', async () => {
      const { decide, rules } = setup({
        answer: { kind: 'permission', choice: 'deny', feedback: 'use pnpm' },
      });
      expect(await decide('Bash', { command: 'npm test' })).toEqual(
        deny('The user declined: use pnpm', 'user'),
      );
      expect(rules.calls).toEqual([]);
    });

    it('a rule that cannot be saved is logged, the call still goes ahead and nothing is remembered', async () => {
      const warnings: string[] = [];
      const failing: RuleStore = {
        init: () => Promise.resolve(),
        list: () => [],
        add: () => Promise.reject(new Error('full')),
        remove: () => Promise.resolve(),
      };
      const policy = createAgentPolicy({
        rules: failing,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (message) => void warnings.push(message),
          error: () => undefined,
        },
      });
      const ask = makeContext({ folderPath: folder, answer: ALLOW_ALWAYS, mode: 'agent' });
      expect(await policy.decide(request('Bash', { command: 'ls' }), ask.context)).toEqual(
        allowUser,
      );
      expect(warnings).toHaveLength(1);
      await policy.decide(request('Bash', { command: 'ls' }), ask.context);
      expect(ask.prompts).toHaveLength(2);
    });

    it('alwaysAskCommands removes the always choice, and a remembered command asks again', async () => {
      const { decide, prompts, rules } = setup({
        answer: ALLOW_ALWAYS,
        settings: { alwaysAskCommands: true },
      });
      const result = await decide('Bash', { command: 'npm test' });
      expect(prompts[0]).toMatchObject({ choices: ['allow-once', 'deny'] });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
      // The answer was not offered, so it denies and saves nothing.
      expect(result.response.behavior).toBe('deny');
      expect(rules.calls).toEqual([]);

      const first = setup({ answer: ALLOW_ALWAYS });
      await first.decide('Bash', { command: 'ls' });
      const strict = makeContext({
        folderPath: folder,
        answer: ALLOW_ONCE,
        settings: { alwaysAskCommands: true },
        mode: 'agent',
      });
      expect(await first.policy.decide(request('Bash', { command: 'ls' }), strict.context)).toEqual(
        allowUser,
      );
      expect(strict.prompts).toHaveLength(1);
    });

    it('a missing, empty or non-string command is denied without asking', async () => {
      for (const tool of ['Bash', 'PowerShell']) {
        for (const input of [{}, { command: '' }, { command: 42 }, { command: ['ls'] }]) {
          const { decide, prompts } = setup({ answer: ALLOW_ONCE });
          expect(await decide(tool, input)).toEqual(deny('The request could not be checked.'));
          expect(prompts).toEqual([]);
        }
      }
    });
  });

  describe('read tools and questions', () => {
    it('reads inside the folder are allowed, outside they ask read-outside', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      expect(await decide('Read', { file_path: 'src/a.ts' })).toEqual(allowPolicy);
      expect(await decide('Grep', { pattern: 'x' })).toEqual(allowPolicy);
      expect(await decide('Glob', { pattern: '**/*.ts' })).toEqual(allowPolicy);
      expect(prompts).toEqual([]);
      expect(await decide('Read', { file_path: join(outside, 'secret.txt') })).toEqual(allowUser);
      expect(prompts[0]).toMatchObject({
        category: 'read-outside',
        detail: join(outside, 'secret.txt'),
      });
    });

    it('AskUserQuestion behaves as in the read-only policy', async () => {
      const questions = [
        {
          question: 'Which?',
          header: 'H',
          options: [{ label: 'A', description: 'a' }],
          multiSelect: false,
        },
      ];
      const { decide, prompts } = setup({
        answer: { kind: 'question', answers: { 'Which?': ['A', 'B'] } },
      });
      expect(await decide('AskUserQuestion', { questions })).toEqual({
        response: {
          behavior: 'allow',
          updatedInput: { questions, answers: { 'Which?': 'A, B' } },
        },
        approval: 'user',
      });
      expect(prompts).toEqual([{ kind: 'question', toolCallId: 'toolu_1', questions }]);
      expect(await decide('AskUserQuestion', { questions: [] })).toEqual(
        deny('The question could not be shown.'),
      );
      expect(await setup().decide('AskUserQuestion', { questions })).toEqual(
        deny('The user did not answer.'),
      );
    });
  });

  describe('web tools', () => {
    it.each([
      ['WebFetch', 'url', 'https://example.com/a?b=c‮', 'Fetch a web page'],
      ['WebSearch', 'query', 'how do links work', 'Search the web'],
    ])('%s asks with category network', async (tool, key, value, title) => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      expect(await decide(tool, { [key]: value })).toEqual(allowUser);
      expect(prompts[0]).toMatchObject({
        category: 'network',
        title,
        detail: value.replace('‮', '\\u{202E}'),
        choices: ['allow-once', 'deny'],
      });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
      expect(await setup({ answer: ALLOW_ALWAYS }).decide(tool, { [key]: value })).toMatchObject({
        response: { behavior: 'deny' },
      });
    });

    it('a missing or non-string url or query is denied without asking', async () => {
      for (const [tool, key] of [
        ['WebFetch', 'url'],
        ['WebSearch', 'query'],
      ] as const) {
        for (const input of [{}, { [key]: 42 }, { [key]: '' }]) {
          const { decide, prompts } = setup({ answer: ALLOW_ONCE });
          expect(await decide(tool, input)).toEqual(deny('The request could not be checked.'));
          expect(prompts).toEqual([]);
        }
      }
    });
  });

  describe('MCP and other tools', () => {
    it.each([
      'mcp__agentcanopy__permission_prompt',
      'mcp__agentcanopy__submit_plan',
      'mcp__agentcanopy__x',
    ])('our own tool %s is denied without asking', async (name) => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      expect(await decide(name, {})).toEqual(
        deny('This tool cannot be approved through a permission request.'),
      );
      expect(prompts).toEqual([]);
    });

    it('another MCP tool asks as external with an always rule of its exact name', async () => {
      const { decide, prompts, rules } = setup({ answer: ALLOW_ALWAYS });
      expect(await decide('mcp__github__create_issue', { title: 't' })).toEqual(allowUser);
      expect(prompts[0]).toMatchObject({
        category: 'external',
        title: 'Use the tool create_issue from github',
        detail: 'mcp__github__create_issue',
        choices: ['allow-once', 'allow-always', 'deny'],
        alwaysRule: { rule: 'mcp__github__create_issue', runsProjectCode: false },
      });
      expect((prompts[0] as { inputPreview: string }).inputPreview).toBe(
        JSON.stringify({ title: 't' }, null, 2),
      );
      expect(rules.calls).toEqual([
        { op: 'add', key: 'folder-1', rule: 'mcp__github__create_issue' },
      ]);
      // Chosen "always": the same tool passes without a prompt in this session.
      expect(await decide('mcp__github__create_issue', {})).toEqual(allowUser);
      expect(prompts).toHaveLength(1);
      await decide('mcp__github__other', {});
      expect(prompts).toHaveLength(2);
    });

    it('alwaysAskCommands removes the always choice for MCP tools too', async () => {
      const { decide, prompts } = setup({
        answer: ALLOW_ONCE,
        settings: { alwaysAskCommands: true },
      });
      await decide('mcp__github__create_issue', {});
      expect(prompts[0]).toMatchObject({ choices: ['allow-once', 'deny'] });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
    });

    it('an MCP name that does not split has a plain title, and an unusable name has no always', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      await decide('mcp__lonely', {});
      expect(prompts[0]).toMatchObject({ title: 'Use the tool mcp__lonely' });
      await decide('mcp__x__y\nz', {});
      expect(prompts[1]).toMatchObject({ choices: ['allow-once', 'deny'] });
      expect(prompts[1]).not.toHaveProperty('alwaysRule');
    });

    it.each(['Task', 'Skill', 'TodoWrite', 'EnterPlanMode', 'KillShell', 'x‮y'])(
      'the unknown tool %j asks as external with allow-once and deny',
      async (name) => {
        const { decide, prompts } = setup({ answer: ALLOW_ONCE });
        expect(await decide(name, { a: 1 })).toEqual(allowUser);
        expect(prompts[0]).toMatchObject({
          category: 'external',
          title: `Use the tool ${name.replace('‮', '\\u{202E}')}`,
          choices: ['allow-once', 'deny'],
        });
        expect(prompts[0]).not.toHaveProperty('alwaysRule');
      },
    );

    it('an unknown tool is denied when the user denies or does not answer', async () => {
      expect(await setup({ answer: DENY }).decide('Task', {})).toEqual(
        deny('The user declined.', 'user'),
      );
      expect(await setup().decide('Task', {})).toEqual(deny('The user did not answer.'));
    });
  });

  describe('malformed requests never throw', () => {
    const tools = [
      'Edit',
      'Write',
      'NotebookEdit',
      'Bash',
      'PowerShell',
      'Read',
      'Grep',
      'Glob',
      'WebFetch',
      'WebSearch',
      'AskUserQuestion',
    ];
    it.each(tools)('%s with a malformed input is denied', async (tool) => {
      for (const input of [null, undefined, [], [1], 42, 'text', true]) {
        const { decide, prompts } = setup({ answer: ALLOW_ONCE });
        expect(await decide(tool, input)).toEqual(deny('The request could not be checked.'));
        expect(prompts).toEqual([]);
      }
    });

    it('a malformed request object is denied', async () => {
      const { policy, ask } = setup();
      for (const bad of [null, undefined, 42, {}, { toolName: 5, input: {} }]) {
        const result = await policy.decide(bad as unknown as PermissionRequest, ask.context);
        expect(result).toEqual(deny('The request could not be checked.'));
      }
    });

    it('a failing askUser becomes a denial and is logged', async () => {
      const warnings: string[] = [];
      const policy = createAgentPolicy({
        rules: fakeRules().store,
        logger: {
          debug: () => undefined,
          info: () => undefined,
          warn: (message) => void warnings.push(message),
          error: () => undefined,
        },
      });
      const { context } = makeContext({ folderPath: folder, mode: 'agent' });
      const failing = { ...context, askUser: () => Promise.reject(new Error('boom')) };
      expect(await policy.decide(request('Bash', { command: 'ls' }), failing)).toEqual(
        deny('The request could not be checked.'),
      );
      expect(warnings).toHaveLength(1);
    });
  });

  describe('inspect', () => {
    const inspect = (event: AgentEvent) => {
      const { policy, ask } = setup();
      return policy.inspect?.(event, {
        ...ask.context,
        folder: { ...ask.context.folder, path: '/work' },
      });
    };

    it('a clean session passes', () => {
      expect(inspect(sessionEvent({ tools: ['Bash', 'Edit'], mcpServers: [] }))).toBeUndefined();
    });

    it('another permission mode stops', () => {
      expect(inspect(sessionEvent({ permissionMode: 'bypassPermissions' }))).toEqual({
        stop: 'Claude Code did not start in its default permission mode, so the turn was stopped.',
      });
    });

    it('another folder stops', () => {
      expect(inspect(sessionEvent({ cwd: '/elsewhere' }))).toEqual({
        stop: 'Claude Code started in a different folder, so the turn was stopped.',
      });
    });

    describe('project tool servers', () => {
      const withServers = sessionEvent({
        mcpServers: [
          { name: 'agentcanopy', status: 'connected' },
          { name: 'project-server', status: 'connected' },
        ],
      });
      const stop =
        'Claude Code started a tool server the project configured although it was set to be ignored, so the turn was stopped.';
      const run = (
        event: AgentEvent,
        projectConfig?: { settings: 'use' | 'ignore'; mcp: 'use' | 'ignore' },
      ) => {
        const { policy, ask } = setup();
        return policy.inspect?.(event, {
          ...ask.context,
          folder: { ...ask.context.folder, path: '/work' },
          ...(projectConfig ? { projectConfig } : {}),
        });
      };

      it('stops when the project servers are ignored or no choice is given', () => {
        expect(run(withServers)).toEqual({ stop });
        expect(run(withServers, { settings: 'use', mcp: 'ignore' })).toEqual({ stop });
        expect(run(withServers, { settings: 'ignore', mcp: 'ignore' })).toEqual({ stop });
        expect(run(sessionEvent({ mcpServers: [{ name: 'x', status: 'failed' }] }))).toEqual({
          stop,
        });
      });

      it('passes when the user chose to use them, or when only our server is listed', () => {
        expect(run(withServers, { settings: 'ignore', mcp: 'use' })).toBeUndefined();
        expect(run(sessionEvent())).toBeUndefined();
        expect(run(sessionEvent({ mcpServers: [] }))).toBeUndefined();
      });

      it('the mode and folder checks come first', () => {
        expect(run({ ...withServers, permissionMode: 'plan' })?.stop).toContain(
          'default permission mode',
        );
        expect(run({ ...withServers, cwd: '/elsewhere' })?.stop).toContain('different folder');
      });
    });

    it('nothing else is checked', () => {
      const events: AgentEvent[] = [
        {
          type: 'tool-call',
          toolCallId: 't',
          name: 'Bash',
          input: {},
          providerEventId: 'e',
          parentToolCallId: null,
        },
        { type: 'text-delta', kind: 'text', text: 'x', parentToolCallId: null },
        { type: 'hook', phase: 'started', name: 'PreToolUse:Bash' },
      ];
      for (const event of events) expect(inspect(event)).toBeUndefined();
      expect(inspect(sessionEvent({ plugins: [{ name: 'p', builtin: false }] }))).toBeUndefined();
    });
  });

  describe('Auto', () => {
    type Expected = 'auto' | 'policy' | 'user' | 'asks' | 'question' | 'denied';
    interface Row {
      name: string;
      tool: string;
      input: (dirs: { folder: string; outside: string }) => Record<string, unknown>;
      settings?: Partial<Settings>;
      rules?: string[];
      expected: Expected;
    }
    const bash = { command: 'npm test' };
    const QUESTIONS = [
      {
        question: 'Which?',
        header: 'H',
        options: [{ label: 'A', description: 'a' }],
        multiSelect: false,
      },
    ];
    const rows: Row[] = [
      // R3: what Auto approves.
      { name: 'a Bash command', tool: 'Bash', input: () => bash, expected: 'auto' },
      {
        name: 'a PowerShell command',
        tool: 'PowerShell',
        input: () => ({ command: 'Get-ChildItem' }),
        expected: 'auto',
      },
      {
        name: 'an edit inside the folder with editApproval ask',
        tool: 'Edit',
        input: (d) => ({ file_path: join(d.folder, 'src/a.ts') }),
        settings: { editApproval: 'ask' },
        expected: 'auto',
      },
      {
        name: 'a Write inside the folder with editApproval ask',
        tool: 'Write',
        input: (d) => ({ file_path: join(d.folder, 'src/new.ts') }),
        settings: { editApproval: 'ask' },
        expected: 'auto',
      },
      {
        name: 'an edit inside the folder with editApproval auto',
        tool: 'Edit',
        input: (d) => ({ file_path: join(d.folder, 'src/a.ts') }),
        settings: { editApproval: 'auto' },
        expected: 'policy',
      },
      {
        name: 'WebFetch with the web setting',
        tool: 'WebFetch',
        input: () => ({ url: 'https://example.com' }),
        settings: { agentAutoWebTools: true },
        expected: 'auto',
      },
      {
        name: 'WebSearch with the web setting',
        tool: 'WebSearch',
        input: () => ({ query: 'q' }),
        settings: { agentAutoWebTools: true },
        expected: 'auto',
      },
      // R4: what Auto never approves.
      {
        name: 'a Bash command with alwaysAskCommands',
        tool: 'Bash',
        input: () => bash,
        settings: { alwaysAskCommands: true },
        expected: 'asks',
      },
      {
        name: 'a PowerShell command with alwaysAskCommands',
        tool: 'PowerShell',
        input: () => ({ command: 'Get-ChildItem' }),
        settings: { alwaysAskCommands: true },
        expected: 'asks',
      },
      {
        name: 'a command that asks to leave the sandbox',
        tool: 'Bash',
        input: () => ({ ...bash, dangerouslyDisableSandbox: true }),
        expected: 'asks',
      },
      {
        name: 'a command that asks to leave the sandbox, with a stored rule for it',
        tool: 'Bash',
        input: () => ({ ...bash, dangerouslyDisableSandbox: true }),
        rules: ['Bash(npm test)'],
        expected: 'asks',
      },
      {
        name: 'an edit on a protected path',
        tool: 'Edit',
        input: (d) => ({ file_path: join(d.folder, '.vscode/settings.json') }),
        expected: 'asks',
      },
      {
        name: 'an edit on a protected path with editApproval ask',
        tool: 'Write',
        input: (d) => ({ file_path: join(d.folder, '.env') }),
        settings: { editApproval: 'ask' },
        expected: 'asks',
      },
      {
        name: 'an edit outside the folder',
        tool: 'Edit',
        input: (d) => ({ file_path: join(d.outside, 'secret.txt') }),
        expected: 'asks',
      },
      {
        name: 'a read outside the folder',
        tool: 'Read',
        input: (d) => ({ file_path: join(d.outside, 'secret.txt') }),
        expected: 'asks',
      },
      {
        name: 'WebFetch without the web setting',
        tool: 'WebFetch',
        input: () => ({ url: 'https://example.com' }),
        expected: 'asks',
      },
      {
        name: 'WebSearch without the web setting',
        tool: 'WebSearch',
        input: () => ({ query: 'q' }),
        expected: 'asks',
      },
      { name: 'an MCP tool', tool: 'mcp__x__y', input: () => ({}), expected: 'asks' },
      { name: 'Skill', tool: 'Skill', input: () => ({ skill: 'x' }), expected: 'asks' },
      { name: 'Monitor', tool: 'Monitor', input: () => ({ command: 'ls' }), expected: 'asks' },
      {
        name: 'ExitPlanMode',
        tool: 'ExitPlanMode',
        input: () => ({ plan: 'p' }),
        expected: 'asks',
      },
      { name: 'EnterWorktree', tool: 'EnterWorktree', input: () => ({}), expected: 'asks' },
      { name: 'Workflow', tool: 'Workflow', input: () => ({}), expected: 'asks' },
      { name: 'an unknown tool', tool: 'SomethingNew', input: () => ({}), expected: 'asks' },
      {
        name: "a tool named 'constructor'",
        tool: 'constructor',
        input: () => ({}),
        expected: 'asks',
      },
      {
        name: 'AskUserQuestion',
        tool: 'AskUserQuestion',
        input: () => ({ questions: QUESTIONS }),
        expected: 'question',
      },
      {
        name: 'our own MCP tool',
        tool: 'mcp__agentcanopy__permission_prompt',
        input: () => ({}),
        expected: 'denied',
      },
      // R5: a stored rule is checked first and approves as the user.
      {
        name: 'a command with a stored rule',
        tool: 'Bash',
        input: () => bash,
        rules: ['Bash(npm test)'],
        expected: 'user',
      },
      {
        name: 'an MCP tool with a stored rule',
        tool: 'mcp__x__y',
        input: () => ({}),
        rules: ['mcp__x__y'],
        expected: 'user',
      },
    ];

    it.each(rows)('with Auto on: $name -> $expected', async (row) => {
      const { decide, prompts } = setup({
        answer: DENY,
        auto: true,
        ...(row.settings ? { settings: row.settings } : {}),
        ...(row.rules ? { rules: fakeRules({ 'folder-1': row.rules }) } : {}),
      });
      const decision = await decide(row.tool, row.input({ folder, outside }));
      switch (row.expected) {
        case 'auto':
        case 'policy':
        case 'user':
          expect(decision).toEqual({ response: { behavior: 'allow' }, approval: row.expected });
          expect(prompts).toEqual([]);
          break;
        case 'asks':
          // The user's denial is what came back: the call was put to the user.
          expect(decision).toEqual(deny('The user declined.', 'user'));
          expect(prompts).toHaveLength(1);
          expect(prompts[0]?.kind).toBe('permission');
          break;
        case 'question':
          expect(decision).toEqual(deny('The user did not answer.'));
          expect(prompts).toEqual([
            { kind: 'question', toolCallId: 'toolu_1', questions: QUESTIONS },
          ]);
          break;
        case 'denied':
          expect(decision).toEqual(
            deny('This tool cannot be approved through a permission request.'),
          );
          expect(prompts).toEqual([]);
          break;
      }
    });

    it.each(rows.filter((row) => row.expected === 'auto'))(
      'with Auto off: $name asks (or is as before)',
      async (row) => {
        const { decide, prompts } = setup({
          answer: DENY,
          ...(row.settings ? { settings: row.settings } : {}),
        });
        expect(await decide(row.tool, row.input({ folder, outside }))).toEqual(
          deny('The user declined.', 'user'),
        );
        expect(prompts).toHaveLength(1);
      },
    );

    it.each([true, false])(
      'a command that asks to leave the sandbox has its own title, two choices and no rule (Auto %s)',
      async (auto) => {
        const { decide, prompts, rules } = setup({
          answer: ALLOW_ALWAYS,
          auto,
          rules: fakeRules({ 'folder-1': ['Bash(npm test)'] }),
        });
        // allow-always is not offered, so it is not accepted either.
        expect(await decide('Bash', { ...bash, dangerouslyDisableSandbox: true })).toMatchObject({
          response: { behavior: 'deny' },
        });
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
          kind: 'permission',
          category: 'command',
          title: 'Run a terminal command outside the sandbox',
          detail: 'npm test',
          choices: ['allow-once', 'deny'],
        });
        expect(prompts[0]).not.toHaveProperty('alwaysRule');
        expect(rules.calls).toEqual([]);
        const once = setup({ answer: ALLOW_ONCE, auto });
        expect(await once.decide('Bash', { ...bash, dangerouslyDisableSandbox: true })).toEqual(
          allowUser,
        );
      },
    );

    it('only dangerouslyDisableSandbox === true counts as leaving the sandbox', async () => {
      for (const value of [false, 'true', 1, null]) {
        const { decide, prompts } = setup({ answer: DENY, auto: true });
        expect(await decide('Bash', { ...bash, dangerouslyDisableSandbox: value })).toEqual({
          response: { behavior: 'allow' },
          approval: 'auto',
        });
        expect(prompts).toEqual([]);
      }
    });

    it('reads Auto when it approves: an edit whose Auto is turned off during the path check asks', async () => {
      let on = true;
      const { context, prompts } = makeContext({
        folderPath: folder,
        answer: DENY,
        mode: 'agent',
        settings: { editApproval: 'ask' },
      });
      const live = Object.defineProperty({ ...context }, 'auto', { get: () => on });
      let release: () => void = () => undefined;
      pathChecks.hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const checking = new Promise<void>((resolve) => {
        pathChecks.started = resolve;
      });
      try {
        const policy = createAgentPolicy({ rules: fakeRules().store });
        const pending = policy.decide(
          request('Write', { file_path: join(folder, 'src/new.ts'), content: 'x' }),
          live,
        );
        await checking;
        // The policy is waiting for the path check now: Auto goes off before it has decided.
        on = false;
        release();
        expect(await pending).toEqual(deny('The user declined.', 'user'));
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({ kind: 'permission', category: 'edit' });
      } finally {
        pathChecks.hold = undefined;
        pathChecks.started = undefined;
      }
      // The same edit with Auto left on is approved by it.
      const kept = makeContext({
        folderPath: folder,
        answer: DENY,
        mode: 'agent',
        settings: { editApproval: 'ask' },
        auto: true,
      });
      const decision = await createAgentPolicy({ rules: fakeRules().store }).decide(
        request('Write', { file_path: join(folder, 'src/new.ts'), content: 'x' }),
        kept.context,
      );
      expect(decision).toEqual({ response: { behavior: 'allow' }, approval: 'auto' });
      expect(kept.prompts).toEqual([]);
    });

    it('every other test here runs with Auto off', () => {
      expect(setup().ask.context.auto).toBe(false);
    });
  });
});

describe('agent policy with saved permissions', () => {
  const KEY = 'folder-1' as FolderKey;
  const ONCE_DENY = ['allow-once', 'deny'];
  const ONCE_ALWAYS_DENY = ['allow-once', 'allow-always', 'deny'];
  let root: string;
  let folder: string;
  let outside: string;
  let home: string;
  let storage: string;
  let restoreHome: () => void;
  let grants: GrantStore;

  // The temporary directories lie under the real home (under AppData on Windows, which is
  // sensitive), so these tests run with a home directory of their own.
  beforeEach(async () => {
    root = await makeTempDir('agent-saved');
    folder = join(root, 'folder');
    outside = join(root, 'outside');
    home = join(root, 'home');
    storage = join(root, 'ext', 'storage');
    await writeTree(folder, { 'src/a.ts': 'a' });
    await writeTree(outside, { 'secret.txt': 's' });
    await fs.mkdir(join(home, '.ssh'), { recursive: true });
    await fs.mkdir(storage, { recursive: true });
    restoreHome = useHome(home);
    grants = await openGrantStore(join(root, 'permissions'));
  });
  afterEach(async () => {
    restoreHome();
    await removeDir(root);
  });

  function setup(
    options: {
      answer?: PromptAnswer | undefined;
      settings?: Partial<Settings>;
      auto?: boolean;
      grants?: GrantStore | null;
      logger?: Parameters<typeof createAgentPolicy>[0]['logger'];
    } = {},
  ) {
    const rules = fakeRules();
    const store = options.grants === null ? undefined : (options.grants ?? grants);
    const policy = createAgentPolicy({
      rules: rules.store,
      ...(store ? { grants: store, sensitiveRoots: () => [storage] } : {}),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    const ask = makeContext({
      folderPath: folder,
      answer: options.answer,
      settings: options.settings,
      mode: 'agent',
      ...(options.auto !== undefined ? { auto: options.auto } : {}),
    });
    const decide = (toolName: string, input: unknown) =>
      policy.decide(request(toolName, input), ask.context);
    return { policy, rules, ask, decide, prompts: ask.prompts };
  }

  describe('reads', () => {
    it('the switch allows an outside read as the user, a saved directory allows below it', async () => {
      const { decide, prompts } = setup({ answer: DENY });
      expect(
        (await decide('Read', { file_path: join(outside, 'secret.txt') })).response.behavior,
      ).toBe('deny');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        category: 'read-outside',
        choices: ONCE_ALWAYS_DENY,
        alwaysRule: { kind: 'read-directory', rule: outside, runsProjectCode: false },
      });

      await grants.setSwitch(KEY, 'read-outside', true);
      expect(await decide('Read', { file_path: join(outside, 'secret.txt') })).toEqual(allowUser);
      await grants.setSwitch(KEY, 'read-outside', false);
      expect(
        (await decide('Read', { file_path: join(outside, 'secret.txt') })).response.behavior,
      ).toBe('deny');

      await grants.add(KEY, { kind: 'read-directory', path: outside });
      expect(await decide('Grep', { pattern: 'x', path: outside })).toEqual(allowUser);
      expect(await decide('Glob', { pattern: `${outside}/*.txt` })).toEqual(allowUser);
      expect(prompts).toHaveLength(2);
    });

    it('always saves the directory and the next read passes', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ALWAYS });
      expect(await decide('Read', { file_path: join(outside, 'secret.txt') })).toEqual(allowUser);
      expect(grants.get(KEY).grants).toEqual([{ kind: 'read-directory', path: outside }]);
      expect(await decide('Read', { file_path: join(outside, 'secret.txt') })).toEqual(allowUser);
      expect(prompts).toHaveLength(1);
    });

    it('a sensitive target asks with once and deny only, although the switch is on', async () => {
      await grants.setSwitch(KEY, 'read-outside', true);
      for (const path of [join(home, '.ssh', 'id'), join(storage, 'permissions', 'k.json')]) {
        const { decide, prompts } = setup({ answer: ALLOW_ALWAYS });
        const decision = await decide('Read', { file_path: path });
        expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
        expect(prompts[0]).not.toHaveProperty('alwaysRule');
        expect(decision).toEqual(deny('That answer was not one the prompt offered.'));
      }
    });

    it('edits outside the folder and protected files still ask, with the switch on', async () => {
      await grants.setSwitch(KEY, 'read-outside', true);
      await grants.add(KEY, { kind: 'read-directory', path: outside });
      const { decide, prompts } = setup({ answer: DENY });
      await decide('Write', { file_path: join(outside, 'x.txt') });
      await decide('Edit', { file_path: '.env' });
      expect(prompts.map((p) => (p as { category: string }).category)).toEqual([
        'outside-workspace',
        'protected-path',
      ]);
      for (const prompt of prompts) expect(prompt).toMatchObject({ choices: ONCE_DENY });
    });
  });

  describe('web tools', () => {
    it('a saved site and the switches allow as the user, and Auto stays auto when nothing is saved', async () => {
      const fetch = { url: 'https://docs.example.com/a' };
      const settings = { agentAutoWebTools: true };
      const unsaved = setup({ answer: DENY, auto: true, settings });
      expect(await unsaved.decide('WebFetch', fetch)).toEqual({
        response: { behavior: 'allow' },
        approval: 'auto',
      });
      expect(await unsaved.decide('WebSearch', { query: 'q' })).toMatchObject({ approval: 'auto' });

      await grants.add(KEY, { kind: 'web-site', host: 'docs.example.com' });
      const saved = setup({ answer: DENY, auto: true, settings });
      expect(await saved.decide('WebFetch', fetch)).toEqual(allowUser);
      expect(await saved.decide('WebFetch', { url: 'https://other.example.com/' })).toMatchObject({
        approval: 'auto',
      });
      expect(await saved.decide('WebSearch', { query: 'q' })).toMatchObject({ approval: 'auto' });
      expect(saved.prompts).toEqual([]);

      await grants.setSwitch(KEY, 'web-search', true);
      expect(await saved.decide('WebSearch', { query: 'q' })).toEqual(allowUser);
      await grants.setSwitch(KEY, 'web-fetch', true);
      expect(await saved.decide('WebFetch', { url: 'https://u:p@x.example/' })).toEqual(allowUser);
    });

    it('a fetch offers always for its site, saves it on always and then passes', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ALWAYS });
      expect(await decide('WebFetch', { url: 'https://Docs.Example.com:8443/a' })).toEqual(
        allowUser,
      );
      expect(prompts[0]).toMatchObject({
        category: 'network',
        choices: ONCE_ALWAYS_DENY,
        alwaysRule: { kind: 'web-site', rule: 'docs.example.com:8443', runsProjectCode: false },
      });
      expect(grants.get(KEY).grants).toEqual([{ kind: 'web-site', host: 'docs.example.com:8443' }]);
      expect(await decide('WebFetch', { url: 'https://docs.example.com:8443/b' })).toEqual(
        allowUser,
      );
      expect(prompts).toHaveLength(1);
      // The exact host and port only.
      await decide('WebFetch', { url: 'https://docs.example.com/b' });
      expect(prompts).toHaveLength(2);
    });

    it.each([
      ['a user name', 'https://u@docs.example.com/'],
      ['a file address', 'file:///etc/passwd'],
      ['an unparsable address', 'not a url'],
    ])('an address with %s asks without always, and a search never offers it', async (_n, url) => {
      const { decide, prompts } = setup({ answer: ALLOW_ALWAYS });
      expect((await decide('WebFetch', { url })).response.behavior).toBe('deny');
      expect(await decide('WebSearch', { query: 'q' })).toMatchObject({
        response: { behavior: 'deny' },
      });
      for (const prompt of prompts) {
        expect(prompt).toMatchObject({ choices: ONCE_DENY });
        expect(prompt).not.toHaveProperty('alwaysRule');
      }
      expect(grants.get(KEY).grants).toEqual([]);
    });

    it('a failed save is logged and the fetch still goes ahead', async () => {
      const { logger, warnings } = recordingLogger();
      const failing: GrantStore = { ...grants, add: () => Promise.reject(new Error('full')) };
      const { decide } = setup({ answer: ALLOW_ALWAYS, grants: failing, logger });
      expect(await decide('WebFetch', { url: 'https://docs.example.com/' })).toEqual(allowUser);
      expect(warnings).toHaveLength(1);
    });
  });

  describe('PowerShell', () => {
    it('a plain command offers always with its rule, saves it and then passes', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ALWAYS });
      expect(await decide('PowerShell', { command: 'npm test' })).toEqual(allowUser);
      expect(prompts[0]).toMatchObject({
        toolName: 'PowerShell',
        category: 'command',
        choices: ONCE_ALWAYS_DENY,
        alwaysRule: { kind: 'command', rule: 'PowerShell(npm test)', runsProjectCode: true },
      });
      expect(grants.get(KEY).grants).toEqual([{ kind: 'powershell-command', command: 'npm test' }]);

      expect(await decide('PowerShell', { command: 'npm test' })).toEqual(allowUser);
      expect(prompts).toHaveLength(1);
      // Another command, and the same text under Bash, still ask.
      await decide('PowerShell', { command: 'npm test -- x' });
      await decide('Bash', { command: 'npm test' });
      expect(prompts).toHaveLength(3);
    });

    it('an inert command is labelled so', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      await decide('PowerShell', { command: 'Get-ChildItem -Path src' });
      expect(prompts[0]).toMatchObject({
        alwaysRule: { rule: 'PowerShell(Get-ChildItem -Path src)', runsProjectCode: false },
      });
    });

    it.each(['echo $x', 'a; b', 'ls | wc', 'echo `n', 'echo "x"', '(Get-Date)', ' ls', 'ls '])(
      'the command %j offers no always',
      async (command) => {
        const { decide, prompts } = setup({ answer: ALLOW_ALWAYS });
        const decision = await decide('PowerShell', { command });
        expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
        expect(prompts[0]).not.toHaveProperty('alwaysRule');
        expect(decision.response.behavior).toBe('deny');
        expect(grants.get(KEY).grants).toEqual([]);
      },
    );

    it('alwaysAskCommands removes the choice and ignores the saved command', async () => {
      await grants.add(KEY, { kind: 'powershell-command', command: 'npm test' });
      const { decide, prompts } = setup({
        answer: ALLOW_ONCE,
        settings: { alwaysAskCommands: true },
      });
      expect(await decide('PowerShell', { command: 'npm test' })).toEqual(allowUser);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
      // With Auto on it asks as well.
      const auto = setup({ answer: DENY, auto: true, settings: { alwaysAskCommands: true } });
      await auto.decide('PowerShell', { command: 'npm test' });
      expect(auto.prompts).toHaveLength(1);
    });

    it('leaving the sandbox still asks first, once, whatever is saved', async () => {
      await grants.add(KEY, { kind: 'powershell-command', command: 'npm test' });
      const { decide, prompts } = setup({ answer: ALLOW_ALWAYS, auto: true });
      const decision = await decide('PowerShell', {
        command: 'npm test',
        dangerouslyDisableSandbox: true,
      });
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        title: 'Run a terminal command outside the sandbox',
        choices: ONCE_DENY,
      });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
      expect(decision.response.behavior).toBe('deny');
    });

    it('a saved command is approved as the user, before Auto; Auto approves the rest', async () => {
      await grants.add(KEY, { kind: 'powershell-command', command: 'npm test' });
      const { decide, prompts } = setup({ answer: DENY, auto: true });
      expect(await decide('PowerShell', { command: 'npm test' })).toEqual(allowUser);
      expect(await decide('PowerShell', { command: 'npm run build' })).toMatchObject({
        approval: 'auto',
      });
      expect(prompts).toEqual([]);
    });

    it('a removed command asks again, and one saved for another folder does not count', async () => {
      await grants.add(KEY, { kind: 'powershell-command', command: 'npm test' });
      await grants.add('folder-2' as FolderKey, { kind: 'powershell-command', command: 'ls' });
      const { decide, prompts } = setup({ answer: DENY });
      expect(await decide('PowerShell', { command: 'npm test' })).toEqual(allowUser);
      await decide('PowerShell', { command: 'ls' });
      expect(prompts).toHaveLength(1);
      await grants.remove(KEY, { kind: 'powershell-command', command: 'npm test' });
      await decide('PowerShell', { command: 'npm test' });
      expect(prompts).toHaveLength(2);
    });

    it('a failed save is logged and the command still runs once', async () => {
      const { logger, warnings } = recordingLogger();
      const failing: GrantStore = { ...grants, add: () => Promise.reject(new Error('full')) };
      const { decide, prompts } = setup({ answer: ALLOW_ALWAYS, grants: failing, logger });
      expect(await decide('PowerShell', { command: 'ls' })).toEqual(allowUser);
      expect(warnings).toHaveLength(1);
      await decide('PowerShell', { command: 'ls' });
      expect(prompts).toHaveLength(2);
    });

    it('Bash rules keep no kind, and so do MCP rules', async () => {
      const { decide, prompts } = setup({ answer: ALLOW_ONCE });
      await decide('Bash', { command: 'npm test' });
      await decide('mcp__github__create_issue', {});
      expect(prompts[0]).toMatchObject({ alwaysRule: { rule: 'Bash(npm test)' } });
      expect(prompts[1]).toMatchObject({ alwaysRule: { rule: 'mcp__github__create_issue' } });
      for (const prompt of prompts) {
        expect((prompt as { alwaysRule: object }).alwaysRule).not.toHaveProperty('kind');
      }
    });
  });

  describe('without a grant store', () => {
    it('everything is as before, whatever is in the store', async () => {
      await grants.setSwitch(KEY, 'read-outside', true);
      await grants.setSwitch(KEY, 'web-fetch', true);
      await grants.add(KEY, { kind: 'powershell-command', command: 'npm test' });
      await grants.add(KEY, { kind: 'web-site', host: 'docs.example.com' });
      const { decide, prompts } = setup({ answer: ALLOW_ALWAYS, grants: null });
      const results = [
        await decide('Read', { file_path: join(outside, 'secret.txt') }),
        await decide('PowerShell', { command: 'npm test' }),
        await decide('WebFetch', { url: 'https://docs.example.com/' }),
      ];
      for (const result of results) expect(result.response.behavior).toBe('deny');
      expect(prompts).toHaveLength(3);
      for (const prompt of prompts) {
        expect(prompt).toMatchObject({ choices: ONCE_DENY });
        expect(prompt).not.toHaveProperty('alwaysRule');
      }
    });
  });
});

describe('agent policy with the real rule store', () => {
  let root: string;
  beforeEach(async () => {
    root = await makeTempDir('agent-policy-store');
  });
  afterEach(() => removeDir(root));

  it('an always rule is saved to disk and appears in the next turn profile', async () => {
    const dir = join(root, 'rules');
    const rules = createRuleStore({ dir });
    await rules.init();
    const policy = createAgentPolicy({ rules });
    const ask = makeContext({ folderPath: root, answer: ALLOW_ALWAYS, mode: 'agent' });
    await policy.decide(request('Bash', { command: 'npm test' }), ask.context);

    const reopened = createRuleStore({ dir });
    await reopened.init();
    const profile = createAgentPolicy({ rules: reopened }).profile({
      mode: 'agent',
      settings: { ...DEFAULT_SETTINGS },
      conversation: ask.context.conversation,
    });
    expect(profile).toMatchObject({ kind: 'agent', allowRules: ['Bash(npm test)'] });
  });
});
