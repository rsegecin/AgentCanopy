import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PromptAnswer } from '../../../shared';
import type { PermissionRequest, PolicyContext, PolicyDecision } from '../../contracts';
import { createReadOnlyPolicy, escapeForDisplay } from './index';
import { makeContext, makeTempDir, removeDir, writeTree } from './test-support';

const DENIAL = 'This action is not allowed in Ask mode because the mode is read-only.';
const PLAN_DENIAL = 'This action is not allowed in Plan mode because the mode is read-only.';
const PLAN_TOOL_DENIAL =
  'Plans are saved through the plan tool directly; this request was not expected.';
const policy = createReadOnlyPolicy();

function request(toolName: string, input: unknown): PermissionRequest {
  return {
    toolCallId: 'toolu_1',
    toolName,
    input: input as Record<string, unknown>,
    signal: new AbortController().signal,
  };
}

const allow = (approval: 'policy' | 'user'): PolicyDecision => ({
  response: { behavior: 'allow' },
  approval,
});
const deny = (message: string, approval: 'policy' | 'user' = 'policy'): PolicyDecision => ({
  response: { behavior: 'deny', message },
  approval,
});

const ALLOW_ONCE: PromptAnswer = { kind: 'permission', choice: 'allow-once' };
const DENY: PromptAnswer = { kind: 'permission', choice: 'deny' };

describe('decide: read tools', () => {
  let root: string;
  let folder: string;
  let outside: string;

  beforeEach(async () => {
    root = await makeTempDir('readonly-decide');
    folder = join(root, 'folder');
    outside = join(root, 'outside');
    await writeTree(folder, { 'src/a.ts': 'a', 'inside/real.txt': 'x' });
    await writeTree(outside, { 'secret.txt': 's', 'dir/inner.txt': 'i' });
    await fs.symlink(outside, join(folder, 'link-out'));
    await fs.symlink(join(folder, 'inside'), join(folder, 'link-in'));
  });
  afterEach(() => removeDir(root));

  async function run(
    toolName: string,
    input: Record<string, unknown>,
    answer?: PromptAnswer,
  ): Promise<{ decision: PolicyDecision; prompts: ReturnType<typeof makeContext>['prompts'] }> {
    const { context, prompts } = makeContext({ folderPath: folder, answer });
    // Glob always has a pattern; the tests that look at patterns set their own.
    const full = toolName === 'Glob' ? { pattern: '*.ts', ...input } : input;
    return { decision: await policy.decide(request(toolName, full), context), prompts };
  }

  describe.each([
    ['Read', 'file_path'],
    ['Grep', 'path'],
    ['Glob', 'path'],
  ])('%s inside the folder', (tool, key) => {
    it.each([
      ['a relative path', 'src/a.ts'],
      ['an absolute path', () => join(folder, 'src', 'a.ts')],
      ['the folder itself', () => folder],
      ['a path with ./ and a harmless ..', 'src/../src/./a.ts'],
      ['a path that does not exist yet', 'src/new/file.ts'],
      ['a symlink that points back inside', 'link-in/real.txt'],
    ])('allows %s without asking', async (_name, path) => {
      const value = typeof path === 'function' ? path() : path;
      const { decision, prompts } = await run(tool, { [key]: value });
      expect(decision).toEqual(allow('policy'));
      expect(prompts).toEqual([]);
    });
  });

  it.each(['Grep', 'Glob'])('%s with no path searches the folder itself', async (tool) => {
    const { decision, prompts } = await run(tool, { pattern: '*.ts' });
    expect(decision).toEqual(allow('policy'));
    expect(prompts).toEqual([]);
  });

  it('Read without a path is denied', async () => {
    const { decision, prompts } = await run('Read', {});
    expect(decision.response.behavior).toBe('deny');
    expect(prompts).toEqual([]);
  });

  it.each([
    ['Read', 'file_path'],
    ['Grep', 'path'],
    ['Glob', 'path'],
  ])('%s with a path that is not a string is denied', async (tool, key) => {
    for (const value of [42, null, ['a'], { a: 1 }, true]) {
      const { decision, prompts } = await run(tool, { [key]: value });
      expect(decision.response.behavior).toBe('deny');
      expect(prompts).toEqual([]);
    }
  });

  describe('paths that leave the folder ask the user', () => {
    it.each([
      [
        'an absolute path outside',
        () => join(outside, 'secret.txt'),
        () => join(outside, 'secret.txt'),
      ],
      ['a ../ escape', () => '../outside/secret.txt', () => join(outside, 'secret.txt')],
      [
        'a deep ../ escape',
        () => 'src/../../outside/dir/inner.txt',
        () => join(outside, 'dir', 'inner.txt'),
      ],
      [
        'a sibling with the folder name as a prefix',
        () => `${folder}-evil/x`,
        () => `${folder}-evil/x`,
      ],
      [
        'a symlink inside pointing out',
        () => 'link-out/secret.txt',
        () => join(outside, 'secret.txt'),
      ],
      [
        'a file that does not exist yet under a symlinked directory leaving the folder',
        () => 'link-out/new/file.txt',
        () => join(outside, 'new', 'file.txt'),
      ],
      ['the symlink itself', () => 'link-out', () => outside],
    ])('%s', async (_name, path, expectedReal) => {
      const { decision, prompts } = await run('Read', { file_path: path() }, ALLOW_ONCE);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ category: 'read-outside', detail: expectedReal() });
      expect(decision).toEqual(allow('user'));
    });

    it('a dangling symlink inside that points outside asks', async () => {
      await fs.symlink(join(outside, 'not-yet'), join(folder, 'dangling'));
      const { prompts } = await run('Read', { file_path: 'dangling' }, DENY);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ detail: join(outside, 'not-yet') });
    });

    it('a symlink loop is not treated as inside', async () => {
      await fs.symlink(join(folder, 'loop-b'), join(folder, 'loop-a'));
      await fs.symlink(join(folder, 'loop-a'), join(folder, 'loop-b'));
      const { prompts } = await run('Read', { file_path: 'loop-a' }, DENY);
      expect(prompts).toHaveLength(1);
    });

    it('Grep and Glob use the search title and Read the read title', async () => {
      const path = join(outside, 'dir');
      expect((await run('Read', { file_path: path }, DENY)).prompts[0]).toMatchObject({
        title: 'Read a file outside the workspace',
        toolName: 'Read',
      });
      expect((await run('Grep', { path }, DENY)).prompts[0]).toMatchObject({
        title: 'Search outside the workspace',
        toolName: 'Grep',
      });
      expect((await run('Glob', { path }, DENY)).prompts[0]).toMatchObject({
        title: 'Search outside the workspace',
        toolName: 'Glob',
      });
    });
  });

  describe('home folder', () => {
    let home: string;
    beforeEach(async () => {
      home = await fs.realpath(homedir());
    });

    it.each(['Read', 'Grep', 'Glob'])('%s: ~ and ~/x are expanded, then ask', async (tool) => {
      const key = tool === 'Read' ? 'file_path' : 'path';
      // Glob always has a pattern too; when both leave the folder the pattern is shown.
      const suffix = tool === 'Glob' ? '/*.ts' : '';
      const a = await run(tool, { [key]: '~' }, DENY);
      expect(a.prompts).toHaveLength(1);
      expect(a.prompts[0]).toMatchObject({ category: 'read-outside', detail: home + suffix });
      const b = await run(tool, { [key]: '~/x/y.txt' }, DENY);
      expect(b.prompts).toHaveLength(1);
      expect(b.prompts[0]).toMatchObject({ detail: join(home, 'x', 'y.txt') + suffix });
    });

    it('~other/x asks and shows the path as given', async () => {
      const { prompts, decision } = await run('Read', { file_path: '~other/x' }, ALLOW_ONCE);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ detail: '~other/x' });
      expect(decision).toEqual(allow('user'));
      expect((await run('Grep', { path: '~other' }, DENY)).prompts).toHaveLength(1);
    });

    it('a tilde later in the path is just a name and is allowed', async () => {
      await writeTree(folder, { 'a/~b.txt': 'x' });
      for (const value of ['a/~b.txt', 'a/~', 'a/~/c']) {
        const { decision, prompts } = await run('Read', { file_path: value });
        expect(decision).toEqual(allow('policy'));
        expect(prompts).toEqual([]);
      }
    });

    it('the home folder itself can be inside the folder', async () => {
      // A workspace folder that is the home folder: ~/x is inside.
      const { context, prompts } = makeContext({ folderPath: home });
      const decision = await policy.decide(request('Read', { file_path: '~/x' }), context);
      expect(decision).toEqual(allow('policy'));
      expect(prompts).toEqual([]);
    });
  });

  describe('glob patterns', () => {
    let home: string;
    beforeEach(async () => {
      home = await fs.realpath(homedir());
    });

    it.each([
      ['a pattern inside the folder', 'src/**/*.ts'],
      ['a pattern with no directory', '**/*.ts'],
      ['a literal file', 'src/a.ts'],
      ['an empty pattern', ''],
      ['a harmless ..', 'src/../src/*.ts'],
      ['a pattern through a symlink that points back inside', 'link-in/**'],
      // Brace expansion to a parent is not analysed: the brace segment ends the literal prefix, so
      // the prefix here is the base, which is inside.
      ['a brace segment that would expand to a parent', '{a,../b}/*'],
      ['a tilde later in a segment', 'a/~b/*'],
    ])('allows %s', async (_name, pattern) => {
      for (const tool of ['Glob', 'Grep']) {
        const input = tool === 'Glob' ? { pattern } : { pattern: 'x', glob: pattern };
        const { decision, prompts } = await run(tool, input);
        expect(decision).toEqual(allow('policy'));
        expect(prompts).toEqual([]);
      }
    });

    it.each([
      ['/etc/*', async () => `${await fs.realpath('/etc')}/*`],
      ['/*', '/*'],
      ['../../**/*', () => `${join(folder, '..', '..')}/**/*`],
      ['src/../../x/*', () => `${join(root, 'x')}/*`],
      ['../outside/dir/inner.txt', () => join(outside, 'dir', 'inner.txt')],
      ['~/.ssh/*', () => `${join(home, '.ssh')}/*`],
      ['~other/x/*', '~other/x/*'],
      ['~*/x', '~*/x'],
      ['link-out/**/*.txt', () => `${outside}/**/*.txt`],
      ['link-out/new/*', () => `${join(outside, 'new')}/*`],
    ])('asks for %s', async (pattern, expected) => {
      const detail = typeof expected === 'function' ? await expected() : expected;
      for (const tool of ['Glob', 'Grep']) {
        const input = tool === 'Glob' ? { pattern } : { pattern: 'x', glob: pattern };
        const { decision, prompts } = await run(tool, input, ALLOW_ONCE);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({
          category: 'read-outside',
          title: 'Search outside the workspace',
          detail,
        });
        expect(decision).toEqual(allow('user'));
      }
    });

    it('an absolute pattern is judged by where it points', async () => {
      const inside = await run('Glob', { pattern: `${folder}/src/*.ts` }, DENY);
      expect(inside.prompts).toHaveLength(0);
      expect(inside.decision.response.behavior).toBe('allow');
      expect(
        (await run('Grep', { pattern: 'x', glob: `${folder}/*.ts` }, DENY)).prompts,
      ).toHaveLength(0);
      expect((await run('Grep', { pattern: 'x', glob: '/etc/*' }, DENY)).prompts).toHaveLength(1);
    });

    it('a pattern relative to an outside path gives one prompt, showing the pattern', async () => {
      const { prompts, decision } = await run(
        'Glob',
        { path: outside, pattern: 'dir/**/*.txt' },
        ALLOW_ONCE,
      );
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ detail: `${join(outside, 'dir')}/**/*.txt` });
      expect(decision).toEqual(allow('user'));
      const grep = await run('Grep', { path: outside, pattern: 'x', glob: '*.txt' }, DENY);
      expect(grep.prompts).toHaveLength(1);
      expect(grep.prompts[0]).toMatchObject({ detail: `${outside}/*.txt` });
    });

    it('a pattern is resolved against the path inside the folder', async () => {
      const inside = await run('Glob', { path: 'src', pattern: '*.ts' });
      expect(inside.prompts).toEqual([]);
      const escape = await run('Glob', { path: 'src', pattern: '../../outside/*' }, DENY);
      expect(escape.prompts).toHaveLength(1);
      expect(escape.prompts[0]).toMatchObject({ detail: `${outside}/*` });
    });

    it('an outside path with a pattern that comes back inside shows the path, one prompt', async () => {
      const { prompts } = await run('Glob', { path: outside, pattern: '../folder/src/*.ts' }, DENY);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ detail: outside });
    });

    it('a Glob pattern that is not a string is denied without asking', async () => {
      for (const pattern of [undefined, null, 42, ['a'], { a: 1 }]) {
        const input: Record<string, unknown> =
          pattern === undefined ? { path: 'src' } : { pattern };
        const { context, prompts } = makeContext({ folderPath: folder, answer: ALLOW_ONCE });
        const decision = await policy.decide(request('Glob', input), context);
        expect(decision).toEqual(deny('The request could not be checked.'));
        expect(prompts).toEqual([]);
      }
    });

    it('a Grep glob that is not a string is ignored, as it is optional', async () => {
      const { decision, prompts } = await run('Grep', { pattern: 'x', glob: 42 });
      expect(decision).toEqual(allow('policy'));
      expect(prompts).toEqual([]);
    });

    it('the pattern shown is escaped', async () => {
      const { prompts } = await run('Glob', { pattern: '/etc/\u202e*' }, DENY);
      const detail = (prompts[0] as { detail: string }).detail;
      expect(detail).not.toContain('\u202e');
      expect(detail).toContain('\\u{202E}*');
    });
  });

  describe('the three outcomes of the prompt', () => {
    const input = (): Record<string, unknown> => ({ file_path: join(outside, 'secret.txt') });

    it('allow-once allows, approval user', async () => {
      expect((await run('Read', input(), ALLOW_ONCE)).decision).toEqual(allow('user'));
    });

    it('deny carries the feedback when given', async () => {
      const answer: PromptAnswer = { kind: 'permission', choice: 'deny', feedback: 'Not that one' };
      expect((await run('Read', input(), answer)).decision).toEqual(deny('Not that one', 'user'));
    });

    it('deny without feedback says the user declined', async () => {
      expect((await run('Read', input(), DENY)).decision).toEqual(
        deny('The user declined.', 'user'),
      );
      const blank: PromptAnswer = { kind: 'permission', choice: 'deny', feedback: '  ' };
      expect((await run('Read', input(), blank)).decision).toEqual(
        deny('The user declined.', 'user'),
      );
    });

    it('no answer denies', async () => {
      expect((await run('Read', input(), undefined)).decision).toEqual(
        deny('The user did not answer.'),
      );
    });

    it('an answer of the wrong kind denies, and "always" never allows', async () => {
      const wrong: PromptAnswer = { kind: 'question', answers: { q: ['a'] } };
      expect((await run('Read', input(), wrong)).decision.response.behavior).toBe('deny');
      const always: PromptAnswer = { kind: 'permission', choice: 'allow-always' };
      expect((await run('Read', input(), always)).decision.response.behavior).toBe('deny');
    });
  });

  describe('the prompt fields', () => {
    it('escapes the detail and offers only allow-once and deny', async () => {
      const name = 'bad‮gnp.txt\nsecond line';
      await fs.writeFile(join(outside, name), 'x');
      const { prompts } = await run('Read', { file_path: join(outside, name) }, DENY);
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0];
      expect(prompt).toMatchObject({
        kind: 'permission',
        toolCallId: 'toolu_1',
        toolName: 'Read',
        category: 'read-outside',
        title: 'Read a file outside the workspace',
        choices: ['allow-once', 'deny'],
      });
      expect(prompt).not.toHaveProperty('alwaysRule');
      const detail = (prompt as { detail: string }).detail;
      expect(detail).toBe(escapeForDisplay(join(outside, name)));
      expect(detail).toContain('\\u{202E}');
      expect(detail).toContain('second line');
      expect(detail).not.toContain('‮');
    });

    it('the preview is the input as pretty JSON, cut to 4000 characters', async () => {
      const input = { file_path: join(outside, 'secret.txt'), extra: 'x'.repeat(10_000) };
      const { prompts } = await run('Read', input, DENY);
      const preview = (prompts[0] as { inputPreview: string }).inputPreview;
      expect(preview.length).toBe(4000);
      expect(preview.startsWith('{\n  "file_path": ')).toBe(true);
      const small = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY);
      expect((small.prompts[0] as { inputPreview: string }).inputPreview).toBe(
        JSON.stringify({ file_path: join(outside, 'secret.txt') }, null, 2),
      );
    });
  });
});

describe('decide: web tools', () => {
  const cases = [
    ['WebFetch', 'url', 'https://example.com/a?b=c', 'Fetch a web page'],
    ['WebSearch', 'query', 'how do symlinks work', 'Search the web'],
  ] as const;

  describe.each(cases)('%s', (tool, key, value, title) => {
    it('is denied with the setting off, without asking', async () => {
      const { context, prompts } = makeContext({ folderPath: '/x', answer: ALLOW_ONCE });
      const decision = await policy.decide(request(tool, { [key]: value }), context);
      expect(decision.response.behavior).toBe('deny');
      expect(decision.approval).toBe('policy');
      expect(prompts).toEqual([]);
    });

    it('asks with the setting on and follows the answer', async () => {
      const settings = { askWebTools: true };
      const asked = makeContext({ folderPath: '/x', answer: ALLOW_ONCE, settings });
      expect(await policy.decide(request(tool, { [key]: value }), asked.context)).toEqual(
        allow('user'),
      );
      expect(asked.prompts).toHaveLength(1);
      expect(asked.prompts[0]).toMatchObject({
        kind: 'permission',
        category: 'network',
        title,
        detail: value,
        choices: ['allow-once', 'deny'],
        toolName: tool,
      });
      expect(asked.prompts[0]).not.toHaveProperty('alwaysRule');

      const declined = makeContext({ folderPath: '/x', answer: DENY, settings });
      expect(await policy.decide(request(tool, { [key]: value }), declined.context)).toEqual(
        deny('The user declined.', 'user'),
      );
      const silent = makeContext({ folderPath: '/x', answer: undefined, settings });
      expect(await policy.decide(request(tool, { [key]: value }), silent.context)).toEqual(
        deny('The user did not answer.'),
      );
    });

    it('denies a missing or non-string value without asking', async () => {
      for (const input of [{}, { [key]: 42 }, { [key]: null }, { [key]: ['a'] }, { [key]: '' }]) {
        const { context, prompts } = makeContext({
          folderPath: '/x',
          answer: ALLOW_ONCE,
          settings: { askWebTools: true },
        });
        const decision = await policy.decide(request(tool, input), context);
        expect(decision.response.behavior).toBe('deny');
        expect(prompts).toEqual([]);
      }
    });
  });

  it('escapes the URL in the detail', async () => {
    const { context, prompts } = makeContext({
      folderPath: '/x',
      answer: DENY,
      settings: { askWebTools: true },
    });
    await policy.decide(request('WebFetch', { url: 'https://a.example/‮evil\r\n' }), context);
    expect(prompts[0]).toMatchObject({ detail: 'https://a.example/\\u{202E}evil\\u{000D}\n' });
  });
});

describe('decide: AskUserQuestion', () => {
  const questions = [
    {
      question: 'Which color?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'r' },
        { label: 'Blue', description: 'b' },
      ],
      multiSelect: true,
    },
    {
      question: 'Which name?',
      header: 'Name',
      options: [{ label: 'A', description: 'a' }],
      multiSelect: false,
    },
  ];

  async function ask(input: unknown, answer?: PromptAnswer) {
    const { context, prompts } = makeContext({ folderPath: '/x', answer });
    return { decision: await policy.decide(request('AskUserQuestion', input), context), prompts };
  }

  it('shows the questions as a question prompt', async () => {
    const { prompts } = await ask({ questions }, { kind: 'question', answers: {} });
    expect(prompts).toEqual([{ kind: 'question', toolCallId: 'toolu_1', questions }]);
  });

  it('a single answer', async () => {
    const { decision } = await ask(
      { questions: [questions[1]] },
      { kind: 'question', answers: { 'Which name?': ['A'] } },
    );
    expect(decision).toEqual({
      response: {
        behavior: 'allow',
        updatedInput: { questions: [questions[1]], answers: { 'Which name?': 'A' } },
      },
      approval: 'user',
    });
  });

  it('a multi-select answer joins the values, and a left-out question is omitted', async () => {
    const { decision } = await ask(
      { questions, metadata: { source: 'x' } },
      { kind: 'question', answers: { 'Which color?': ['Red', 'Blue'] } },
    );
    expect(decision).toEqual({
      response: {
        behavior: 'allow',
        updatedInput: {
          questions,
          metadata: { source: 'x' },
          answers: { 'Which color?': 'Red, Blue' },
        },
      },
      approval: 'user',
    });
  });

  it('a free-text answer and answers for questions that were not asked', async () => {
    const { decision } = await ask(
      { questions },
      {
        kind: 'question',
        answers: { 'Which name?': ['Something else entirely'], 'Not asked': ['x'] },
      },
    );
    expect((decision.response as { updatedInput: unknown }).updatedInput).toEqual({
      questions,
      answers: { 'Which name?': 'Something else entirely' },
    });
  });

  it('no answer, or an answer of the wrong kind, denies', async () => {
    expect((await ask({ questions })).decision).toEqual(deny('The user did not answer.'));
    expect((await ask({ questions }, DENY)).decision).toEqual(deny('The user did not answer.'));
  });

  it('invalid input is denied without showing anything', async () => {
    const five = Array.from({ length: 5 }, () => questions[1]);
    for (const input of [
      {},
      { questions: [] },
      { questions: 'x' },
      { questions: [{ question: '' }] },
      { questions: five },
      { questions: [{ ...questions[0], options: 'no' }] },
    ]) {
      const { decision, prompts } = await ask(input, { kind: 'question', answers: {} });
      expect(decision).toEqual(deny('The question could not be shown.'));
      expect(prompts).toEqual([]);
    }
  });

  it('four questions are fine', async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ ...questions[1], question: `Q${i}` }));
    const { prompts } = await ask({ questions: four }, { kind: 'question', answers: {} });
    expect(prompts).toHaveLength(1);
  });
});

describe('decide: everything else is denied', () => {
  const names = [
    'Bash',
    'Write',
    'Edit',
    'NotebookEdit',
    'Task',
    'Skill',
    'mcp__x__y',
    'mcp__agentcanopy__permission_prompt',
    'KillShell',
    'Monitor',
    'ToolSearch',
    'EnterPlanMode',
    'ExitPlanMode',
    'Workflow',
    'CronCreate',
    'TodoWrite',
    'MultiEdit',
    'read',
    'READ',
    'Read ',
    'EndConversation',
    '',
  ];

  it.each(names)('%j is denied without asking', async (name) => {
    const { context, prompts } = makeContext({
      folderPath: '/x',
      answer: ALLOW_ONCE,
      settings: { askWebTools: true },
    });
    const decision = await policy.decide(
      request(name, { command: 'rm -rf /', file_path: '/x/a', content: 'z' }),
      context,
    );
    expect(decision).toEqual(deny(DENIAL));
    expect(prompts).toEqual([]);
  });
});

describe('decide: Plan mode', () => {
  it('uses the Plan wording for what it refuses', async () => {
    for (const tool of ['Bash', 'Write', 'mcp__x__y', 'Task']) {
      const { context, prompts } = makeContext({
        folderPath: '/x',
        answer: ALLOW_ONCE,
        mode: 'plan',
      });
      expect(await policy.decide(request(tool, { command: 'x' }), context)).toEqual(
        deny(PLAN_DENIAL),
      );
      expect(prompts).toEqual([]);
    }
  });

  it('the plan tool is never approved here, in any mode, locked or not', async () => {
    for (const [mode, planLocked] of [
      ['plan', false],
      ['plan', true],
      ['ask', false],
    ] as const) {
      const { context, prompts } = makeContext({
        folderPath: '/x',
        answer: ALLOW_ONCE,
        mode,
        planLocked,
      });
      const decision = await policy.decide(
        request('mcp__agentcanopy__submit_plan', { title: 't' }),
        context,
      );
      expect(decision).toEqual(deny(PLAN_TOOL_DENIAL));
      expect(prompts).toEqual([]);
    }
  });

  it('the web-tools-off message names both modes', async () => {
    for (const mode of ['ask', 'plan'] as const) {
      const { context } = makeContext({ folderPath: '/x', mode });
      const decision = await policy.decide(
        request('WebFetch', { url: 'https://a.example' }),
        context,
      );
      expect(decision).toEqual(
        deny('Web access is turned off for Ask and Plan modes in the AgentCanopy settings.'),
      );
    }
  });

  it('reads and questions work as in Ask mode', async () => {
    const { context, prompts } = makeContext({ folderPath: '/x', mode: 'plan' });
    expect(await policy.decide(request('Read', { file_path: 'a.ts' }), context)).toEqual(
      allow('policy'),
    );
    expect(prompts).toEqual([]);
  });
});

describe('decide: malformed requests never throw', () => {
  const inputs: unknown[] = [null, undefined, [], [1, 2], 42, 'text', true, () => 1];
  const tools = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'Bash'];

  it.each(tools)('%s with a malformed input is denied', async (tool) => {
    for (const input of inputs) {
      const { context, prompts } = makeContext({
        folderPath: '/x',
        answer: ALLOW_ONCE,
        settings: { askWebTools: true },
      });
      const decision = await policy.decide(request(tool, input), context);
      expect(decision.response.behavior).toBe('deny');
      expect(prompts).toEqual([]);
    }
  });

  it('a malformed request object is denied', async () => {
    const { context } = makeContext({ folderPath: '/x' });
    for (const bad of [null, undefined, 42, {}, { toolName: 5, input: {} }]) {
      const decision = await policy.decide(bad as unknown as PermissionRequest, context);
      expect(decision.response.behavior).toBe('deny');
    }
  });

  it('a failing askUser becomes a denial and is logged', async () => {
    const warnings: string[] = [];
    const logged = createReadOnlyPolicy({
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (message) => void warnings.push(message),
        error: () => undefined,
      },
    });
    const { context } = makeContext({ folderPath: '/x' });
    const failing: PolicyContext = {
      ...context,
      askUser: () => Promise.reject(new Error('boom')),
    };
    const decision = await logged.decide(request('Read', { file_path: '/etc/hosts' }), failing);
    expect(decision.response.behavior).toBe('deny');
    expect(warnings).toHaveLength(1);
  });
});

describe('decide: paths the host cannot judge', () => {
  let root: string;
  let folder: string;
  let outside: string;

  beforeEach(async () => {
    root = await makeTempDir('readonly-unjudged');
    folder = join(root, 'folder');
    outside = join(root, 'outside');
    await writeTree(folder, { 'src/a.ts': 'a' });
    await writeTree(outside, { 'dir/inner.txt': 'i' });
  });
  afterEach(() => removeDir(root));

  it('a Grep whose path has a leading space asks, showing the text as given', async () => {
    const value = ' src';
    const { context, prompts } = makeContext({ folderPath: folder, answer: DENY });
    const decision = await policy.decide(request('Grep', { pattern: 'x', path: value }), context);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: 'read-outside', detail: value });
    expect(decision.response.behavior).toBe('deny');
  });

  it.runIf(process.platform === 'win32')(
    'a Glob with a backslash pattern into a real directory outside asks',
    async () => {
      const { context, prompts } = makeContext({ folderPath: folder, answer: DENY });
      const pattern = `${join(outside, 'dir')}\\*`;
      const decision = await policy.decide(request('Glob', { pattern }), context);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        category: 'read-outside',
        detail: `${join(outside, 'dir')}/*`,
      });
      expect(decision.response.behavior).toBe('deny');
    },
  );
});
