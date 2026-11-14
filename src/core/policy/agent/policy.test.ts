import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  type FolderKey,
  type PromptAnswer,
  type Settings,
} from '../../../shared';
import type { AgentEvent } from '../../../shared';
import type { PermissionRequest, PolicyDecision } from '../../contracts';
import {
  makeContext,
  makeTempDir,
  removeDir,
  sessionEvent,
  writeTree,
  type FakeAsk,
} from '../readonly/test-support';
import { createAgentPolicy, createRuleStore, type RuleStore } from './index';

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
    } = {},
  ) {
    const rules = options.rules ?? fakeRules();
    const policy = createAgentPolicy({ rules: rules.store });
    const ask: FakeAsk = makeContext({
      folderPath: folder,
      answer: options.answer,
      settings: options.settings,
      mode: 'agent',
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
