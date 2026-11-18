import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderKey, PromptAnswer, Settings } from '../../../shared';
import type { PermissionRequest, PolicyContext, PolicyDecision } from '../../contracts';
import type { GrantStore } from '../grants';
import { projectSlug } from './claude-memory';
import { createReadOnlyPolicy, escapeForDisplay } from './index';
import {
  makeContext,
  makeTempDir,
  openGrantStore,
  recordingLogger,
  removeDir,
  useHome,
  writeTree,
} from './test-support';

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

const ALLOW_ALWAYS: PromptAnswer = { kind: 'permission', choice: 'allow-always' };
const FOLDER_KEY = 'folder-1' as FolderKey;
const ONCE_DENY = ['allow-once', 'deny'];
const ONCE_ALWAYS_DENY = ['allow-once', 'allow-always', 'deny'];

describe('decide: saved permissions for reads', () => {
  let root: string;
  let folder: string;
  let outside: string;
  let other: string;
  let home: string;
  let storage: string;
  let restoreHome: () => void;
  let grants: GrantStore;

  // The temporary directories lie under the real home (under AppData on Windows, which is
  // sensitive), so these tests run with a home directory of their own.
  beforeEach(async () => {
    root = await makeTempDir('readonly-saved');
    folder = join(root, 'folder');
    outside = join(root, 'outside');
    other = join(root, 'other');
    home = join(root, 'home');
    storage = join(root, 'ext', 'storage');
    await writeTree(folder, { 'src/a.ts': 'a' });
    await writeTree(outside, { 'secret.txt': 's', 'dir/inner.txt': 'i' });
    await writeTree(other, { 'x.txt': 'x' });
    await fs.mkdir(join(home, '.ssh'), { recursive: true });
    await fs.mkdir(storage, { recursive: true });
    await fs.symlink(other, join(outside, 'link-other'));
    await fs.symlink(outside, join(folder, 'link-out'));
    restoreHome = useHome(home);
    grants = await openGrantStore(join(root, 'permissions'));
  });
  afterEach(async () => {
    restoreHome();
    await removeDir(root);
  });

  const secured = (
    store: GrantStore = grants,
    logger?: Parameters<typeof createReadOnlyPolicy>[0],
  ) => createReadOnlyPolicy({ ...logger, grants: store, sensitiveRoots: () => [storage] });

  async function run(
    toolName: string,
    input: Record<string, unknown>,
    answer?: PromptAnswer,
    options: { mode?: 'ask' | 'plan'; policy?: ReturnType<typeof secured> } = {},
  ) {
    const { context, prompts } = makeContext({
      folderPath: folder,
      answer,
      mode: options.mode ?? 'ask',
    });
    const full = toolName === 'Glob' ? { pattern: '*.ts', ...input } : input;
    const decision = await (options.policy ?? secured()).decide(request(toolName, full), context);
    return { decision, prompts };
  }

  const fwd = (path: string): string => path.split('\\').join('/');

  it('inside the folder is unchanged, with nothing saved and with the switch on', async () => {
    await grants.setSwitch(FOLDER_KEY, 'read-outside', true);
    for (const tool of ['Read', 'Grep', 'Glob']) {
      const key = tool === 'Read' ? 'file_path' : 'path';
      const { decision, prompts } = await run(tool, { [key]: 'src/a.ts' });
      expect(decision).toEqual(allow('policy'));
      expect(prompts).toEqual([]);
    }
  });

  it('outside with nothing saved offers once, always and deny, and names the directory', async () => {
    const file = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY);
    expect(file.prompts).toHaveLength(1);
    expect(file.prompts[0]).toMatchObject({
      kind: 'permission',
      category: 'read-outside',
      title: 'Read a file outside the workspace',
      detail: join(outside, 'secret.txt'),
      choices: ONCE_ALWAYS_DENY,
      alwaysRule: { kind: 'read-directory', rule: outside, runsProjectCode: false },
    });
    expect(file.decision).toEqual(deny('The user declined.', 'user'));

    // A directory is offered itself; a file gives its parent.
    const dir = await run('Grep', { pattern: 'x', path: join(outside, 'dir') }, DENY);
    expect(dir.prompts[0]).toMatchObject({
      choices: ONCE_ALWAYS_DENY,
      alwaysRule: { kind: 'read-directory', rule: join(outside, 'dir') },
    });
    // Of a path and a pattern, the directory that holds the other.
    const both = await run('Glob', { path: outside, pattern: 'dir/**/*.txt' }, DENY);
    expect(both.prompts[0]).toMatchObject({
      detail: `${join(outside, 'dir')}/**/*.txt`,
      alwaysRule: { rule: outside },
    });
    // A file that does not exist yet gives its parent.
    const missing = await run('Read', { file_path: join(outside, 'new', 'f.txt') }, DENY);
    expect(missing.prompts[0]).toMatchObject({ alwaysRule: { rule: join(outside, 'new') } });
  });

  it('works the same in Plan mode', async () => {
    const { prompts } = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY, {
      mode: 'plan',
    });
    expect(prompts[0]).toMatchObject({ choices: ONCE_ALWAYS_DENY });
    await grants.setSwitch(FOLDER_KEY, 'read-outside', true);
    const allowed = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY, {
      mode: 'plan',
    });
    expect(allowed.decision).toEqual(allow('user'));
  });

  it('the read-outside switch allows with approval user and no prompt, and off asks again', async () => {
    await grants.setSwitch(FOLDER_KEY, 'read-outside', true);
    for (const [tool, input] of [
      ['Read', { file_path: join(other, 'x.txt') }],
      ['Grep', { pattern: 'x', path: outside }],
      ['Glob', { path: outside, pattern: '../other/*' }],
      ['Read', { file_path: 'link-out/secret.txt' }],
    ] as const) {
      const { decision, prompts } = await run(tool, { ...input }, DENY);
      expect(decision).toEqual(allow('user'));
      expect(prompts).toEqual([]);
    }
    await grants.setSwitch(FOLDER_KEY, 'read-outside', false);
    expect((await run('Read', { file_path: join(other, 'x.txt') }, DENY)).prompts).toHaveLength(1);
  });

  it('another folder is not affected by the switch or a saved directory', async () => {
    await grants.setSwitch('folder-2' as FolderKey, 'read-outside', true);
    await grants.add('folder-2' as FolderKey, { kind: 'read-directory', path: outside });
    const { prompts } = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY);
    expect(prompts).toHaveLength(1);
  });

  it('a saved directory allows a file below it and asks for a sibling', async () => {
    await grants.add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    for (const [tool, input] of [
      ['Read', { file_path: join(outside, 'secret.txt') }],
      ['Read', { file_path: join(outside, 'dir', 'inner.txt') }],
      ['Read', { file_path: join(outside, 'not', 'yet.txt') }],
      ['Grep', { pattern: 'x', path: outside }],
      ['Glob', { path: outside, pattern: 'dir/**/*.txt' }],
      ['Glob', { pattern: `${fwd(outside)}/*.txt` }],
      ['Read', { file_path: 'link-out/secret.txt' }],
    ] as const) {
      const { decision, prompts } = await run(tool, { ...input }, DENY);
      expect(decision).toEqual(allow('user'));
      expect(prompts).toEqual([]);
    }
    for (const path of [join(other, 'x.txt'), `${outside}-evil/x`, root]) {
      const { prompts } = await run('Read', { file_path: path }, DENY);
      expect(prompts).toHaveLength(1);
    }
  });

  it('a symlink inside a saved directory that points out of it asks', async () => {
    await grants.add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    const { prompts, decision } = await run(
      'Read',
      { file_path: join(outside, 'link-other', 'x.txt') },
      DENY,
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ detail: join(other, 'x.txt') });
    expect(decision.response.behavior).toBe('deny');
  });

  it('a path and a pattern that are both outside need both covered', async () => {
    await grants.add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    const { prompts } = await run('Glob', { path: outside, pattern: '../other/*' }, DENY);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ detail: `${other}/*`, choices: ONCE_DENY });
    expect(prompts[0]).not.toHaveProperty('alwaysRule');

    // With both saved, nothing asks.
    await grants.add(FOLDER_KEY, { kind: 'read-directory', path: other });
    const covered = await run('Glob', { path: outside, pattern: '../other/*' }, DENY);
    expect(covered.decision).toEqual(allow('user'));
    expect(covered.prompts).toEqual([]);

    // Only the pattern covered: the path is the one that asks.
    await grants.remove(FOLDER_KEY, { kind: 'read-directory', path: outside });
    const grep = await run('Grep', { pattern: 'x', path: outside, glob: `${fwd(other)}/*` }, DENY);
    expect(grep.prompts).toHaveLength(1);
  });

  describe('what is sensitive always asks', () => {
    beforeEach(async () => {
      await grants.setSwitch(FOLDER_KEY, 'read-outside', true);
    });

    it.each([
      ['a file under a storage root', () => join(storage, 'permissions', 'k.json')],
      ['the storage root', () => storage],
      ['a file under ~/.ssh', () => join(home, '.ssh', 'x')],
      ['the credentials file in the home directory', () => join(home, '.npmrc')],
    ])('%s, with the switch on, gives once and deny only', async (_name, path) => {
      const { prompts, decision } = await run('Read', { file_path: path() }, ALLOW_ONCE);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ category: 'read-outside', choices: ONCE_DENY });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
      expect(decision).toEqual(allow('user'));
    });

    it('Grep and Glob below a sensitive location ask too', async () => {
      for (const [tool, input] of [
        ['Grep', { pattern: 'x', path: join(home, '.ssh') }],
        ['Glob', { path: storage, pattern: '**/*' }],
        ['Glob', { pattern: `${fwd(join(home, '.ssh'))}/*` }],
      ] as const) {
        const { prompts } = await run(tool, { ...input }, DENY);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
      }
    });

    it('a search whose path is the home directory asks, because it would reach the credentials', async () => {
      const { prompts } = await run('Grep', { pattern: 'x', path: home }, DENY);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
    });

    it('a sensitive target beside a covered one asks', async () => {
      const { prompts } = await run(
        'Glob',
        { path: outside, pattern: `${fwd(join(home, '.ssh'))}/*` },
        DENY,
      );
      expect(prompts).toHaveLength(1);
    });

    it('a pattern with .. after a wildcard asks without always', async () => {
      for (const pattern of [
        `${fwd(outside)}/*/../x`,
        `${fwd(outside)}/**/../../x`,
        '{a,../b}/*',
        '{..,a}/*',
      ]) {
        const input = pattern.startsWith('{') ? { path: outside, pattern } : { pattern };
        const { prompts } = await run('Glob', input, DENY);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
        expect(prompts[0]).not.toHaveProperty('alwaysRule');
      }
    });

    it('a pattern with an alternative in braces that starts at a root, a drive or the home folder asks without always', async () => {
      for (const pattern of ['{a,/etc/*}', '{a,~/x}/*', '{C:/x,a}/*', '{a, /etc/*}']) {
        const { prompts } = await run('Glob', { path: outside, pattern }, DENY);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
        expect(prompts[0]).not.toHaveProperty('alwaysRule');
      }
    });

    it('a pattern with plain alternatives stays covered', async () => {
      const { decision, prompts } = await run(
        'Glob',
        { path: outside, pattern: '**/*.{ts,tsx}' },
        DENY,
      );
      expect(decision).toEqual(allow('user'));
      expect(prompts).toEqual([]);
    });

    it('a pattern that only looks like .. is fine', async () => {
      const { decision, prompts } = await run(
        'Glob',
        { pattern: `${fwd(outside)}/*/a..b/x...` },
        DENY,
      );
      expect(decision).toEqual(allow('user'));
      expect(prompts).toEqual([]);
    });

    it('a path the host cannot judge asks without always', async () => {
      const { prompts } = await run('Grep', { pattern: 'x', path: ' src' }, DENY);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({ detail: ' src', choices: ONCE_DENY });
      expect(prompts[0]).not.toHaveProperty('alwaysRule');
      const trailing = await run('Read', { file_path: 'src/a.ts ' }, DENY);
      expect(trailing.prompts).toHaveLength(1);
      expect(trailing.prompts[0]).not.toHaveProperty('alwaysRule');
    });

    it.runIf(process.platform === 'win32')(
      'a Windows path the host cannot judge asks without always',
      async () => {
        for (const value of ['\\Users\\x', 'C:Users', 'src\\.ssh.\\x']) {
          const { prompts } = await run('Read', { file_path: value }, DENY);
          expect(prompts).toHaveLength(1);
          expect(prompts[0]).not.toHaveProperty('alwaysRule');
        }
      },
    );

    it('a saved directory does not cover a sensitive location', async () => {
      await grants.setSwitch(FOLDER_KEY, 'read-outside', false);
      await grants.add(FOLDER_KEY, { kind: 'read-directory', path: join(home, '.ssh') });
      await grants.add(FOLDER_KEY, { kind: 'read-directory', path: storage });
      for (const path of [join(home, '.ssh', 'x'), join(storage, 'k.json')]) {
        const { prompts } = await run('Read', { file_path: path }, DENY);
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
      }
    });
  });

  it('a saved directory that may not be granted covers nothing', async () => {
    // `add` checks the shape only, so a hand-written file can hold these.
    for (const path of [home, root, storage, parse(root).root]) {
      await grants.add(FOLDER_KEY, { kind: 'read-directory', path });
    }
    const { prompts } = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY);
    expect(prompts).toHaveLength(1);
    await writeTree(home, { 'docs/n.txt': 'n' });
    const inHome = await run('Read', { file_path: join(home, 'docs', 'n.txt') }, DENY);
    expect(inHome.prompts).toHaveLength(1);
  });

  it('always saves the directory, the next request passes, and removing it makes the next ask', async () => {
    const first = await run('Read', { file_path: join(outside, 'secret.txt') }, ALLOW_ALWAYS);
    expect(first.decision).toEqual(allow('user'));
    expect(first.prompts).toHaveLength(1);
    expect(grants.get(FOLDER_KEY).grants).toEqual([{ kind: 'read-directory', path: outside }]);

    const next = await run('Grep', { pattern: 'x', path: join(outside, 'dir') });
    expect(next.decision).toEqual(allow('user'));
    expect(next.prompts).toEqual([]);

    await grants.remove(FOLDER_KEY, { kind: 'read-directory', path: outside });
    const again = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY);
    expect(again.prompts).toHaveLength(1);
    expect(again.decision.response.behavior).toBe('deny');
  });

  it('once saves nothing, and deny keeps its feedback', async () => {
    await run('Read', { file_path: join(outside, 'secret.txt') }, ALLOW_ONCE);
    expect(grants.get(FOLDER_KEY).grants).toEqual([]);
    const feedback: PromptAnswer = { kind: 'permission', choice: 'deny', feedback: 'no' };
    const { decision } = await run('Read', { file_path: join(outside, 'secret.txt') }, feedback);
    expect(decision).toEqual(deny('no', 'user'));
    expect((await run('Read', { file_path: join(outside, 'secret.txt') })).decision).toEqual(
      deny('The user did not answer.'),
    );
  });

  it('an allow-always answer to a prompt that did not offer it is denied, and saves nothing', async () => {
    const { decision, prompts } = await run(
      'Read',
      { file_path: join(storage, 'k') },
      ALLOW_ALWAYS,
    );
    expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
    expect(decision).toEqual(deny('That answer was not one the prompt offered.'));
    expect(grants.get(FOLDER_KEY)).toEqual({ switches: [], grants: [] });
  });

  it('a store whose add fails is logged, and the call still goes ahead once', async () => {
    const { logger, warnings } = recordingLogger();
    const failing: GrantStore = { ...grants, add: () => Promise.reject(new Error('disk full')) };
    const policy = secured(failing, { logger });
    const { decision } = await run(
      'Read',
      { file_path: join(outside, 'secret.txt') },
      ALLOW_ALWAYS,
      { policy },
    );
    expect(decision).toEqual(allow('user'));
    expect(warnings).toHaveLength(1);
    const next = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY, { policy });
    expect(next.prompts).toHaveLength(1);
  });

  it('reads the store after the awaits, so a removal made while it waited counts', async () => {
    await grants.add(FOLDER_KEY, { kind: 'read-directory', path: outside });
    await grants.setSwitch(FOLDER_KEY, 'read-outside', true);
    // `sensitiveRoots` is called before the policy awaits the real paths: from then on the store
    // answers as if everything was removed, so a value read before that would still approve.
    let removed = false;
    const live: GrantStore = {
      ...grants,
      get: (key) => (removed ? { switches: [], grants: [] } : grants.get(key)),
    };
    const policy = createReadOnlyPolicy({
      grants: live,
      sensitiveRoots: () => {
        removed = true;
        return [storage];
      },
    });
    const { context, prompts } = makeContext({ folderPath: folder, answer: DENY });
    const decision = await policy.decide(
      request('Read', { file_path: join(outside, 'secret.txt') }),
      context,
    );
    expect(prompts).toHaveLength(1);
    expect(decision.response.behavior).toBe('deny');
  });

  it('a policy without a grant store behaves as before', async () => {
    await grants.setSwitch(FOLDER_KEY, 'read-outside', true);
    const plain = createReadOnlyPolicy();
    const { prompts } = await run('Read', { file_path: join(outside, 'secret.txt') }, DENY, {
      policy: plain,
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
    expect(prompts[0]).not.toHaveProperty('alwaysRule');
  });
});

describe('decide: saved permissions for web tools', () => {
  let root: string;
  let grants: GrantStore;
  const settings: Partial<Settings> = { askWebTools: true };

  beforeEach(async () => {
    root = await makeTempDir('readonly-web');
    grants = await openGrantStore(join(root, 'permissions'));
  });
  afterEach(() => removeDir(root));

  async function run(
    tool: 'WebFetch' | 'WebSearch',
    value: string,
    answer?: PromptAnswer,
    options: { settings?: Partial<Settings>; mode?: 'ask' | 'plan'; policy?: PolicyPolicy } = {},
  ) {
    const { context, prompts } = makeContext({
      folderPath: '/x',
      answer,
      settings: options.settings ?? settings,
      mode: options.mode ?? 'ask',
    });
    const policy = options.policy ?? createReadOnlyPolicy({ grants });
    const decision = await policy.decide(
      request(tool, { [tool === 'WebFetch' ? 'url' : 'query']: value }),
      context,
    );
    return { decision, prompts };
  }
  type PolicyPolicy = ReturnType<typeof createReadOnlyPolicy>;

  it('a fetch with nothing saved offers once, always (the site) and deny', async () => {
    const { prompts, decision } = await run('WebFetch', 'https://Docs.Example.com/a?b=c', DENY);
    expect(prompts[0]).toMatchObject({
      category: 'network',
      title: 'Fetch a web page',
      choices: ONCE_ALWAYS_DENY,
      alwaysRule: { kind: 'web-site', rule: 'docs.example.com', runsProjectCode: false },
    });
    expect(decision).toEqual(deny('The user declined.', 'user'));
  });

  it('a saved site matches the exact host and port only', async () => {
    await grants.add(FOLDER_KEY, { kind: 'web-site', host: 'docs.example.com' });
    for (const url of [
      'https://docs.example.com/x',
      'http://docs.example.com/x',
      'https://DOCS.example.com:443/x',
    ]) {
      const { decision, prompts } = await run('WebFetch', url, DENY);
      expect(decision).toEqual(allow('user'));
      expect(prompts).toEqual([]);
    }
    for (const url of [
      'https://docs.example.com:8443/x',
      'https://example.com/',
      'https://a.docs.example.com/',
      'https://docs.example.com.evil.com/',
      'https://evil.com/?u=docs.example.com',
      'https://evil.com/docs.example.com',
    ]) {
      expect((await run('WebFetch', url, DENY)).prompts).toHaveLength(1);
    }
    await grants.add(FOLDER_KEY, { kind: 'web-site', host: 'docs.example.com:8443' });
    expect((await run('WebFetch', 'https://docs.example.com:8443/x', DENY)).prompts).toEqual([]);
    expect((await run('WebFetch', 'https://docs.example.com:9000/x', DENY)).prompts).toHaveLength(
      1,
    );
  });

  it.each([
    ['a user name', 'https://user@docs.example.com/'],
    ['a user name and password', 'https://u:p@docs.example.com/'],
    ['a host hidden behind a user name', 'http://docs.example.com:8080@evil.com/'],
    ['a file address', 'file:///etc/passwd'],
    ['an unparsable address', 'not a url'],
    ['a backslash', 'https://docs.example.com\\@evil.com/'],
  ])('an address with %s asks without always', async (_name, url) => {
    await grants.add(FOLDER_KEY, { kind: 'web-site', host: 'docs.example.com' });
    await grants.add(FOLDER_KEY, { kind: 'web-site', host: 'evil.com' });
    const { prompts } = await run('WebFetch', url, ALLOW_ALWAYS);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ choices: ONCE_DENY });
    expect(prompts[0]).not.toHaveProperty('alwaysRule');
  });

  it('always saves the site, and the next fetch there passes', async () => {
    const first = await run('WebFetch', 'https://docs.example.com/a', ALLOW_ALWAYS);
    expect(first.decision).toEqual(allow('user'));
    expect(grants.get(FOLDER_KEY).grants).toEqual([{ kind: 'web-site', host: 'docs.example.com' }]);
    const next = await run('WebFetch', 'https://docs.example.com/b');
    expect(next.decision).toEqual(allow('user'));
    expect(next.prompts).toEqual([]);
  });

  it('a search never offers always, and an always answer to it is denied', async () => {
    const { prompts, decision } = await run('WebSearch', 'how do links work', ALLOW_ALWAYS);
    expect(prompts[0]).toMatchObject({ title: 'Search the web', choices: ONCE_DENY });
    expect(prompts[0]).not.toHaveProperty('alwaysRule');
    expect(decision).toEqual(deny('That answer was not one the prompt offered.'));
    expect(grants.get(FOLDER_KEY).grants).toEqual([]);
  });

  it('each switch allows its own tool only, with approval user', async () => {
    await grants.setSwitch(FOLDER_KEY, 'web-fetch', true);
    const fetch = await run('WebFetch', 'https://anything.example/x', DENY);
    expect(fetch.decision).toEqual(allow('user'));
    expect(fetch.prompts).toEqual([]);
    expect((await run('WebFetch', 'https://u:p@anything.example/', DENY)).decision).toEqual(
      allow('user'),
    );
    expect((await run('WebSearch', 'q', DENY)).prompts).toHaveLength(1);

    await grants.setSwitch(FOLDER_KEY, 'web-fetch', false);
    await grants.setSwitch(FOLDER_KEY, 'web-search', true);
    const search = await run('WebSearch', 'q', DENY);
    expect(search.decision).toEqual(allow('user'));
    expect(search.prompts).toEqual([]);
    expect((await run('WebFetch', 'https://anything.example/x', DENY)).prompts).toHaveLength(1);
  });

  it('with the setting off, web tools are denied whatever is saved, in Ask and in Plan', async () => {
    await grants.setSwitch(FOLDER_KEY, 'web-fetch', true);
    await grants.setSwitch(FOLDER_KEY, 'web-search', true);
    await grants.add(FOLDER_KEY, { kind: 'web-site', host: 'docs.example.com' });
    for (const mode of ['ask', 'plan'] as const) {
      for (const [tool, value] of [
        ['WebFetch', 'https://docs.example.com/'],
        ['WebSearch', 'q'],
      ] as const) {
        const { decision, prompts } = await run(tool, value, ALLOW_ONCE, {
          settings: { askWebTools: false },
          mode,
        });
        expect(decision).toEqual(
          deny('Web access is turned off for Ask and Plan modes in the AgentCanopy settings.'),
        );
        expect(prompts).toEqual([]);
      }
    }
  });

  it('a store whose add fails is logged, and the fetch still goes ahead once', async () => {
    const { logger, warnings } = recordingLogger();
    const failing: GrantStore = { ...grants, add: () => Promise.reject(new Error('disk full')) };
    const policy = createReadOnlyPolicy({ grants: failing, logger });
    const { decision } = await run('WebFetch', 'https://docs.example.com/', ALLOW_ALWAYS, {
      policy,
    });
    expect(decision).toEqual(allow('user'));
    expect(warnings).toHaveLength(1);
  });

  it('a policy without a grant store behaves as before', async () => {
    await grants.setSwitch(FOLDER_KEY, 'web-fetch', true);
    const { prompts } = await run('WebFetch', 'https://docs.example.com/', DENY, {
      policy: createReadOnlyPolicy(),
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toHaveProperty('alwaysRule');
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

describe('decide: Claude Code memory directory', () => {
  let root: string;
  let folder: string;
  let config: string;
  let home: string;
  let slug: string;
  let memdir: string;
  let restoreHome: () => void;
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    root = await makeTempDir('readonly-memory');
    folder = join(root, 'folder');
    config = join(root, 'config');
    home = join(root, 'home');
    await writeTree(folder, { 'src/a.ts': 'a' });
    await fs.mkdir(home, { recursive: true });
    slug = projectSlug(folder) ?? '';
    memdir = join(config, 'projects', slug, 'memory');
    await writeTree(memdir, { 'MEMORY.md': '# memory', 'note.md': 'note' });
    await writeTree(config, {
      '.credentials.json': 'secret',
      [`projects/${slug}/session.jsonl`]: 's',
      'projects/other-project/memory/x.md': 'x',
    });
    savedConfigDir = process.env['CLAUDE_CONFIG_DIR'];
    process.env['CLAUDE_CONFIG_DIR'] = config;
    restoreHome = useHome(home);
  });
  afterEach(async () => {
    restoreHome();
    if (savedConfigDir === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
    else process.env['CLAUDE_CONFIG_DIR'] = savedConfigDir;
    await removeDir(root);
  });

  async function run(
    toolName: string,
    input: Record<string, unknown>,
    mode: 'ask' | 'plan' = 'ask',
  ): Promise<{ decision: PolicyDecision; prompts: ReturnType<typeof makeContext>['prompts'] }> {
    const { context, prompts } = makeContext({ folderPath: folder, answer: DENY, mode });
    return { decision: await policy.decide(request(toolName, input), context), prompts };
  }

  async function expectAllowed(toolName: string, input: Record<string, unknown>) {
    const { decision, prompts } = await run(toolName, input);
    expect(decision).toEqual(allow('policy'));
    expect(prompts).toEqual([]);
  }

  async function expectAsks(toolName: string, input: Record<string, unknown>) {
    const { decision, prompts } = await run(toolName, input);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ category: 'read-outside' });
    expect(decision.response.behavior).toBe('deny');
  }

  describe('reads and searches pass without asking', () => {
    it('Read of a memory file', async () => {
      await expectAllowed('Read', { file_path: join(memdir, 'MEMORY.md') });
    });

    it('Grep with the memory directory as its path', async () => {
      await expectAllowed('Grep', { path: memdir, pattern: 'note' });
    });

    it('Glob of the memory files', async () => {
      await expectAllowed('Glob', { pattern: `${memdir}/*.md` });
    });

    it.each(['ask', 'plan'] as const)('Read in %s mode', async (mode) => {
      const { decision, prompts } = await run('Read', { file_path: join(memdir, 'note.md') }, mode);
      expect(decision).toEqual(allow('policy'));
      expect(prompts).toEqual([]);
    });

    it('Read of a memory file that does not exist yet', async () => {
      await expectAllowed('Read', { file_path: join(memdir, 'new.md') });
    });

    it('is spelled with another case of the drive letter on Windows', async () => {
      if (process.platform !== 'win32') return;
      const swapped = memdir.replace(/^[A-Za-z]/, (letter) =>
        letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
      );
      await expectAllowed('Read', { file_path: join(swapped, 'MEMORY.md') });
    });
  });

  describe('everything else still asks', () => {
    it("a file in another project's memory directory", async () => {
      await expectAsks('Read', {
        file_path: join(config, 'projects', 'other-project', 'memory', 'x.md'),
      });
    });

    it('a file of this project that is outside memory', async () => {
      await expectAsks('Read', { file_path: join(config, 'projects', slug, 'session.jsonl') });
    });

    it('the credentials file next to it', async () => {
      await expectAsks('Read', { file_path: join(config, '.credentials.json') });
    });

    it('a symlink in memory that points to the credentials file', async () => {
      await fs.symlink(join(config, '.credentials.json'), join(memdir, 'link.md'), 'file');
      await expectAsks('Read', { file_path: join(memdir, 'link.md') });
    });

    it('a memory directory that is itself a link', async () => {
      const elsewhere = join(root, 'elsewhere');
      await writeTree(elsewhere, { 'f.md': 'f' });
      await fs.rm(memdir, { recursive: true });
      await fs.symlink(elsewhere, memdir, process.platform === 'win32' ? 'junction' : 'dir');
      await expectAsks('Read', { file_path: join(memdir, 'f.md') });
    });

    it('a glob that climbs out of the memory directory', async () => {
      await expectAsks('Glob', { pattern: `${memdir}/*/../../x` });
    });

    it('a glob with an alternative that starts somewhere else', async () => {
      await expectAsks('Glob', { pattern: `${memdir}/{a.md,${config}/*}` });
    });

    it('a folder with no memory directory', async () => {
      await fs.rm(memdir, { recursive: true });
      await expectAsks('Read', { file_path: join(memdir, 'MEMORY.md') });
    });

    it('the home folder when CLAUDE_CONFIG_DIR points elsewhere', async () => {
      await writeTree(join(home, '.claude', 'projects', slug, 'memory'), { 'x.md': 'x' });
      await expectAsks('Read', {
        file_path: join(home, '.claude', 'projects', slug, 'memory', 'x.md'),
      });
    });
  });

  it('uses the .claude folder in the home folder when CLAUDE_CONFIG_DIR is not set', async () => {
    delete process.env['CLAUDE_CONFIG_DIR'];
    const homeMemory = join(home, '.claude', 'projects', slug, 'memory');
    await writeTree(homeMemory, { 'note.md': 'note' });
    await expectAllowed('Read', { file_path: join(homeMemory, 'note.md') });
  });
});
