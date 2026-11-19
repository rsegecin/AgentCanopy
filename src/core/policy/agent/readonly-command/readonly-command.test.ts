import { promises as fs } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeTempDir, removeDir, useHome, writeTree } from '../../readonly/test-support';
import { checkReadOnlyCommand, type ReadOnlyCheck, type ReadOnlyCheckOptions } from './index';

const IS_WINDOWS = process.platform === 'win32';
const DIRECTORY_LINK = IS_WINDOWS ? 'junction' : 'dir';

/** A path as the command text spells it: forward slashes, quoted, so any folder name is safe. */
function quoted(path: string): string {
  return `'${path.replaceAll('\\', '/')}'`;
}

let root: string;
let folder: string;
let plain: string;
let bsd: string;
let home: string;
let binDir: string;
let restoreHome: () => void;
let env: NodeJS.ProcessEnv;

async function makeGitDirectory(dotGit: string): Promise<void> {
  await fs.mkdir(join(dotGit, 'objects'), { recursive: true });
  await fs.mkdir(join(dotGit, 'refs'), { recursive: true });
  await fs.writeFile(join(dotGit, 'HEAD'), 'ref: refs/heads/main\n');
}

beforeAll(async () => {
  root = await makeTempDir('readonly-command');
  folder = join(root, 'folder');
  plain = join(root, 'plain');
  bsd = join(root, 'bsd');
  home = join(root, 'home');
  binDir = join(root, 'bin');
  const outside = join(root, 'outside');
  await writeTree(folder, { 'src/a.ts': 'a', 'docs/list': 'x', 'package.json': '{}', 'd2/x': 'y' });
  await makeGitDirectory(join(folder, '.git'));
  await writeTree(plain, { 'a.txt': 'a' });
  await writeTree(bsd, { 'a.txt': 'a' });
  await writeTree(outside, { 'secret.txt': 's' });
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.symlink(outside, join(folder, 'link-out'), DIRECTORY_LINK);
  await fs.symlink(join(folder, 'src'), join(folder, 'link-in'), DIRECTORY_LINK);
  await fs.symlink(join(outside, 'secret.txt'), join(folder, 'file-link-out'), 'file');
  // Files named like options, as BSD getopt (no permutation) would open them.
  await fs.symlink(join(outside, 'secret.txt'), join(bsd, '-n'), 'file');
  await fs.symlink(join(outside, 'secret.txt'), join(bsd, '5'), 'file');
  await fs.mkdir(join(folder, 'd1'));
  await fs.symlink(join(outside, 'secret.txt'), join(folder, 'd1', 'x'), 'file');
  // A home of its own, so that what is sensitive is under the test's control: the temporary folder
  // lies under the real home, whose credential locations must not be in play (and, before Phase 18,
  // on Windows the temporary folder itself was sensitive).
  restoreHome = useHome(home);
  env = { PATH: binDir };
});

afterAll(async () => {
  restoreHome();
  await removeDir(root);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function check(
  command: string,
  options: Partial<ReadOnlyCheckOptions> = {},
): Promise<ReadOnlyCheck> {
  // `{{folder}}` stands for the folder, spelled with forward slashes, in tables built before it exists.
  const text = command.replaceAll('{{folder}}', folder.replaceAll('\\', '/'));
  return checkReadOnlyCommand(text, { folderPath: folder, env, ...options });
}

async function reasonOf(
  command: string,
  options: Partial<ReadOnlyCheckOptions> = {},
): Promise<string> {
  const result = await check(command, options);
  if (result.readOnly) throw new Error(`accepted: ${command}`);
  return result.reason;
}

describe('checkReadOnlyCommand: allowed', () => {
  it.each([
    'grep -n "a\\|b" src/a.ts',
    'sed -n 432,500p src/a.ts',
    'git status --short && git branch --show-current && git log --oneline -1',
    'git branch -vv | head -20 && git reflog -8 --date=iso',
    'grep -rn "x" src --include=*.ts 2>/dev/null | head',
    "git show abc123 --format='%h %ad' -- src/a.ts",
    'cat package.json; git check-ignore -v src/a.ts',
    'git diff HEAD~1 --stat',
    'git log --oneline @{u}..HEAD',
    "sed -n '/^export/p' src/a.ts",
    "sed 's/a/b/g' src/a.ts",
    'cat link-in/a.ts',
    'ls -la src | head -5',
    "find . -name '*.ts' -type f | wc -l",
    'rg -n foo src',
    "git log -5 --format='%h %s'",
    'git status -uno',
    'git show HEAD:src/a.ts',
    'git ls-files',
    'cat src/missing.ts docs/new/file.txt',
    'cat /dev/null',
    'ls 2>&1 | head -3',
    'echo hello && date +%s',
    'pwd',
    'diff src/a.ts package.json',
  ])('%s', async (command) => {
    expect(await check(command)).toEqual({ readOnly: true });
  });

  it('allows an absolute path inside the folder', async () => {
    expect(await check(`cat ${quoted(join(folder, 'src', 'a.ts'))}`)).toEqual({ readOnly: true });
  });

  it('allows the folder cd and the commands after it', async () => {
    expect(await check(`cd ${quoted(folder)} && git status`)).toEqual({ readOnly: true });
    expect(await check(`cd ${quoted(`${folder}/`)} && ls src`)).toEqual({ readOnly: true });
  });

  it.runIf(IS_WINDOWS)('allows the folder spelled with a lower-case drive letter', async () => {
    const lower = `${folder.charAt(0).toLowerCase()}${folder.slice(1)}`;
    const options = { folderPath: lower };
    expect(await check('cat src/a.ts', options)).toEqual({ readOnly: true });
    expect(await check(`cd ${quoted(lower)} && git status`, options)).toEqual({ readOnly: true });
    expect(await check(`cat ${quoted(join(lower, 'src', 'a.ts'))}`, options)).toEqual({
      readOnly: true,
    });
    expect(await check(`cd ${quoted(folder)} && ls`, options)).toEqual({ readOnly: true });
  });

  it('does not need a repository for commands other than git', async () => {
    expect(await check('cat a.txt', { folderPath: plain })).toEqual({ readOnly: true });
  });
});

describe('checkReadOnlyCommand: words after the first operand', () => {
  // On macOS `cat a.txt -n` opens a file named `-n`; here it is a link to a file outside.
  it.each([
    ['cat a.txt -n', 'path-outside'],
    ['head a.txt -n 5', 'path-outside'],
    ['head -n 5 a.txt', undefined],
    ['cat -n a.txt', undefined],
  ])('%s', async (command, code) => {
    const result = await check(command, { folderPath: bsd });
    if (code === undefined) expect(result).toEqual({ readOnly: true });
    else expect(result.readOnly === false && result.reason.startsWith(code)).toBe(true);
  });

  it('passes when no such file exists', async () => {
    expect(await check('cat a.txt -n', { folderPath: plain })).toEqual({ readOnly: true });
    expect(await check('head a.txt -n 5', { folderPath: plain })).toEqual({ readOnly: true });
  });
});

describe('checkReadOnlyCommand: refused', () => {
  it.each<[string, string]>([
    ['cat x > y', 'redirection'],
    ['cat < x', 'redirection'],
    ['a & b', 'separator'],
    ['echo x >&2evil', 'redirection'],
    ['cat x2>/dev/null', 'unquoted-character'],
    ['cat x >> /dev/null', 'redirection'],
    ['echo $(id)', 'unquoted-character'],
    ['echo `id`', 'unquoted-character'],
    ['echo "$HOME"', 'unquoted-character'],
    ['for f in a; do cat $f; done', 'unquoted-character'],
    ['X=1 ls', 'assignment'],
    ['cat *', 'glob'],
    ['cat -- --a=*', 'glob'],
    ['ls ~/x', 'tilde'],
    ['cat =ssh', 'equals-word'],
    ['ls\nls', 'control-character'],
    ["cat '.\r./x'", 'control-character'],
    ['cat a\u{A0}b', 'unquoted-character'],
    ['cat a\u{202E}b', 'control-character'],
    ['npx tsc', 'unknown-command'],
    ['jq -n env', 'unknown-command'],
    ['tree', 'unknown-command'],
  ])('%j gives %s', async (command, code) => {
    expect(await reasonOf(command)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ['cat /etc/passwd', 'path-outside'],
    ['cat ../x', 'path-form'],
    ['cat link-out/secret.txt', 'path-outside'],
    ['cat link-out', 'path-outside'],
    ['cat file-link-out', 'path-outside'],
    ['ls link-out', 'path-outside'],
    ['ls && cat /etc/passwd', 'path-outside'],
    ['cat src/a.ts | head -n 3 file-link-out', 'path-outside'],
    ['grep -r x link-out', 'path-outside'],
    // diff of two directories follows a symlink among their entries to a file outside.
    ['diff d1 d2', 'operand-not-allowed'],
    ['diff src docs', 'operand-not-allowed'],
    ['diff src/a.ts docs', 'operand-not-allowed'],
    ['git show HEAD:../x', 'path-form'],
    ['cd /tmp && ls', 'cd'],
    ['cd src && ls', 'cd'],
    ['cd .. && ls', 'cd'],
    [`cd '{{folder}}/src' && ls`, 'cd'],
    [`cd '{{folder}}/link-in' && ls`, 'cd'],
    [`cd '{{folder}}/link-out' && ls`, 'cd'],
    [`cd '{{folder}}'`, 'cd'],
    [`cd '{{folder}}' ; ls`, 'cd'],
    [`cd '{{folder}}' || ls`, 'cd'],
    [`cd '{{folder}}' && cd '{{folder}}' && ls`, 'cd'],
    [`ls && cd '{{folder}}' && ls`, 'cd'],
    [`cd '{{folder}}' src && ls`, 'cd'],
    ['cd && ls', 'cd'],
    ['cd /dev/null && ls', 'cd'],
  ])('%s gives %s', async (command, code) => {
    expect(await reasonOf(command)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ["sed -i 's/a/b/' f", 'option-not-allowed'],
    ["sed 'e ls'", 'sed-script'],
    ["sed 's/a/b/w out' f", 'sed-script'],
    ["sed -n '1p;w out' f", 'sed-script'],
    ['uniq a b', 'operand-not-allowed'],
    ['uniq - out', 'operand-not-allowed'],
    ['uniq -- a b', 'option-not-allowed'],
    ['sort -o f x', 'option-not-allowed'],
    ['sort --co=sh x', 'option-not-allowed'],
    ['sort --files0-from=-', 'option-not-allowed'],
    ['sort --out=f x', 'option-not-allowed'],
    ['wc --files0-from=docs/list', 'option-not-allowed'],
    ['du --files0-from=x', 'option-not-allowed'],
    ['file -f docs/list', 'option-not-allowed'],
    ['file -m x:/c/y src/a.ts', 'option-not-allowed'],
    ['find . -exec ls', 'find-expression'],
    ['find . -delete', 'find-expression'],
    ['find . -fprint x', 'find-expression'],
    ['find -L .', 'option-not-allowed'],
    ['find . -files0-from x', 'find-expression'],
    ['grep -R x .', 'option-not-allowed'],
    ['grep -nR x .', 'option-not-allowed'],
    ['grep --der x .', 'option-not-allowed'],
    ['ls -RL .', 'option-not-allowed'],
    ['ls -L x', 'option-not-allowed'],
    ['du -L .', 'option-not-allowed'],
    ['du --dereference .', 'option-not-allowed'],
    ['diff -rN a b', 'option-not-allowed'],
    ['rg -L x', 'option-not-allowed'],
    ['rg --follow x', 'option-not-allowed'],
    ['rg -z x', 'option-not-allowed'],
    ['rg --pre cat x', 'option-not-allowed'],
    ['date -f../x', 'option-not-allowed'],
    ['date -fC:/x', 'option-not-allowed'],
    ['date -s 2001-01-01', 'option-not-allowed'],
    ['date --s=1', 'option-not-allowed'],
    ['file --comp', 'option-not-allowed'],
    ['printf -v x %s 1', 'option-not-allowed'],
    ['printf -- x', 'option-not-allowed'],
    ['tail -f x', 'option-not-allowed'],
    ['tail -F x', 'option-not-allowed'],
    ['git grep --op=x -e y', 'option-not-allowed'],
    ['git grep -nOx -e y', 'option-not-allowed'],
    ['git --config-env=core.pager=X status', 'git-shape'],
    ['git -c a=b status', 'git-shape'],
    ['git -C .. status', 'git-shape'],
    ['git -p log', 'git-shape'],
    ['git remote -v show origin', 'git-shape'],
    ['git remote add x y', 'git-shape'],
    ['git branch newname', 'operand-not-allowed'],
    ['git branch -D x', 'option-not-allowed'],
    ['git branch --set-upstream-to=x', 'option-not-allowed'],
    ['git tag v1', 'operand-not-allowed'],
    ['git tag -d v1', 'option-not-allowed'],
    ['git reflog expire', 'git-shape'],
    ['git reflog delete x', 'git-shape'],
    ['git diff --output=f', 'option-not-allowed'],
    ['git diff --outp=f', 'option-not-allowed'],
    ['git diff --ext-diff', 'option-not-allowed'],
    ['git diff --no-index a b', 'option-not-allowed'],
    ['git cat-file --batch', 'option-not-allowed'],
    ['git cat-file --textconv HEAD:x', 'option-not-allowed'],
    ['git log --show-signature', 'option-not-allowed'],
    ["git log --format='%G?'", 'value-not-allowed'],
    ["git branch --format='%(signature)'", 'value-not-allowed'],
    ['git blame --contents x f', 'option-not-allowed'],
    ['git describe --dirty', 'option-not-allowed'],
  ])('%s gives %s', async (command, code) => {
    expect(await reasonOf(command)).toMatch(new RegExp(`^${code}`));
  });
});

describe('checkReadOnlyCommand: Windows lexical rules', () => {
  it.each<[string, string]>([
    ["cat '\\\\host\\s\\x'", 'path-form'],
    ['cat //host/s/x', 'path-form'],
    ["cat 'a\\..\\b'", 'path-form'],
    ['cat C:/x/a:stream', 'path-form'],
    ['cat C:x', 'path-form'],
    ['git show HEAD:/x', 'path-form'],
    ['cat CON', 'path-form'],
    ['cat src/nul.txt', 'path-form'],
    ['cat src/a.ts aux', 'path-form'],
    ['git show HEAD:src/prn', 'path-form'],
  ])('%s gives %s', async (command, code) => {
    expect(await reasonOf(command, { platform: 'win32' })).toMatch(new RegExp(`^${code}`));
  });

  it('refuses a UNC word before anything touches the file system', async () => {
    const lstat = vi.spyOn(fs, 'lstat');
    const realpath = vi.spyOn(fs, 'realpath');
    const stat = vi.spyOn(fs, 'stat');
    for (const command of ["cat '\\\\host\\s\\x'", 'cat //host/s/x', 'cat src/a.ts ../x']) {
      expect(await reasonOf(command, { platform: 'win32' })).toMatch(/^path-form/);
    }
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });

  it('refuses an absolute word outside the folder without looking at it', async () => {
    const lstat = vi.spyOn(fs, 'lstat');
    const realpath = vi.spyOn(fs, 'realpath');
    expect(await reasonOf('cat /elsewhere/secret ')).toMatch(/^path-outside/);
    expect(await reasonOf('cat Z:/elsewhere/secret', { platform: 'win32' })).toMatch(
      /^path-outside/,
    );
    const looked = [...lstat.mock.calls, ...realpath.mock.calls].map((call) => String(call[0]));
    expect(looked.filter((path) => path.includes('elsewhere'))).toEqual([]);
  });

  it.runIf(IS_WINDOWS)('refuses MSYS and drive-relative words', async () => {
    expect(await reasonOf('cat /c/x')).toMatch(/^path-outside/);
    expect(await reasonOf('cat C:x')).toMatch(/^path-form/);
    expect(await reasonOf("cat 'src/a.ts.'")).toMatch(/^path-outside/);
  });
});

describe('checkReadOnlyCommand: git gates', () => {
  it('refuses git in a folder without .git', async () => {
    expect(await reasonOf('git status', { folderPath: plain })).toBe('git-no-repository');
    expect(
      await reasonOf("git ls-files ':/'", { folderPath: plain, platform: 'linux', env: {} }),
    ).toMatch(/^git-no-repository/);
  });

  it('refuses a .git that is a file', async () => {
    const dir = join(root, 'worktree');
    await writeTree(dir, { '.git': 'gitdir: /elsewhere\n' });
    expect(await reasonOf('git status', { folderPath: dir })).toBe('git-no-repository');
  });

  it('refuses a .git that is a link', async () => {
    const dir = join(root, 'linked');
    await fs.mkdir(dir, { recursive: true });
    await fs.symlink(join(folder, '.git'), join(dir, '.git'), DIRECTORY_LINK);
    expect(await reasonOf('git status', { folderPath: dir })).toBe('git-no-repository');
  });

  it.each(['HEAD', 'objects', 'refs'])('refuses a .git that lacks %s', async (missing) => {
    const dir = join(root, `no-${missing}`);
    await makeGitDirectory(join(dir, '.git'));
    await fs.rm(join(dir, '.git', missing), { recursive: true });
    expect(await reasonOf('git status', { folderPath: dir })).toBe('git-no-repository');
  });

  it('refuses git when GIT_DIR is set, and not other commands', async () => {
    const withGitDir = { ...env, GIT_DIR: join(root, 'elsewhere') };
    expect(await reasonOf('git status', { env: withGitDir })).toMatch(/^git-environment/);
    expect(await check('cat src/a.ts', { env: withGitDir })).toEqual({ readOnly: true });
  });

  it.each([
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_CONFIG',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_EXEC_PATH',
  ])('refuses git when %s is set', async (name) => {
    expect(await reasonOf('git log', { env: { ...env, [name]: 'x' } })).toMatch(/^git-environment/);
  });

  it('compares the names without case on Windows only', async () => {
    const lower = { git_dir: 'x' };
    expect(await reasonOf('git status', { env: lower, platform: 'win32' })).toMatch(
      /^git-environment/,
    );
    expect(await check('git status', { env: lower, platform: 'linux' })).toEqual({
      readOnly: true,
    });
  });
});

describe('checkReadOnlyCommand: folder and PATH gates', () => {
  it('refuses a folder that is the home folder', async () => {
    const restore = useHome(folder);
    try {
      expect(await reasonOf('ls')).toBe('sensitive-folder');
    } finally {
      restore();
    }
  });

  it('refuses a folder inside a credential location', async () => {
    const inside = join(home, '.config', 'project');
    await writeTree(inside, { 'a.txt': 'a' });
    expect(await reasonOf('cat a.txt', { folderPath: inside })).toBe('sensitive-folder');
  });

  it('refuses a folder inside a storage root', async () => {
    expect(await reasonOf('ls', { sensitiveRoots: () => [root] })).toBe('sensitive-folder');
    expect(await check('ls', { sensitiveRoots: () => [join(root, 'unrelated')] })).toEqual({
      readOnly: true,
    });
  });

  it.each<[string, () => string]>([
    ['a relative entry', () => `${binDir}${delimiter}./bin`],
    ['a bare relative entry', () => 'bin'],
    ['an entry inside the folder', () => join(folder, 'bin')],
    ['an entry that is the folder', () => folder],
    ['an entry below a link in the folder', () => join(folder, 'link-in', 'bin')],
  ])('refuses PATH with %s', async (_label, value) => {
    const result = await reasonOf('ls', { env: { PATH: value() }, platform: process.platform });
    expect(result).toMatch(/^path-variable/);
  });

  it('allows a missing PATH and an unrelated absolute one', async () => {
    expect(await check('ls', { env: {} })).toEqual({ readOnly: true });
    expect(await check('ls', { env: { PATH: `${binDir}${delimiter}${home}` } })).toEqual({
      readOnly: true,
    });
  });

  it('skips empty PATH entries on Windows, where Git Bash drops them', async () => {
    const result = await check('ls', {
      env: { PATH: 'C:\\Windows\\System32;;C:\\x;' },
      platform: 'win32',
    });
    expect(result).toEqual({ readOnly: true });
  });

  it.runIf(!IS_WINDOWS)('refuses an empty PATH, or an empty entry, on this host', async () => {
    expect(await reasonOf('ls', { env: { PATH: '' } })).toMatch(/^path-variable/);
    expect(
      await reasonOf('ls', { env: { PATH: `${binDir}${delimiter}${delimiter}${binDir}` } }),
    ).toMatch(/^path-variable/);
  });

  it('refuses an empty PATH entry elsewhere, where it means the current directory', async () => {
    expect(await reasonOf('ls', { env: { PATH: '/usr/bin::/bin' }, platform: 'linux' })).toMatch(
      /^path-variable/,
    );
    expect(await reasonOf('ls', { env: { PATH: '/usr/bin:' }, platform: 'darwin' })).toMatch(
      /^path-variable/,
    );
  });

  it('finds the variable on Windows whatever its case, and refuses a relative entry there', async () => {
    const result = await reasonOf('ls', {
      env: { Path: 'C:\\Windows;.\\bin' },
      platform: 'win32',
    });
    expect(result).toMatch(/^path-variable/);
  });

  it.runIf(IS_WINDOWS)('compares the entries with the folder without case', async () => {
    const result = await reasonOf('ls', { env: { PATH: join(folder, 'BIN').toUpperCase() } });
    expect(result).toMatch(/^path-variable/);
  });
});
