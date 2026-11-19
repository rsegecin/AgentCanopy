import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  exactCommandRule,
  exactPowerShellCommand,
  isProtectedPath,
  runsProjectCode,
  runsProjectCodePowerShell,
} from './index';
import { isProtectedAbsolutePath } from './protected';

describe('isProtectedPath', () => {
  it.each([
    '.git',
    '.git/config',
    '.git/hooks/pre-commit',
    '.vscode/settings.json',
    '.vscode/tasks.json',
    '.claude/settings.json',
    '.claude/skills/x/SKILL.md',
    '.husky/pre-commit',
    '.devcontainer/devcontainer.json',
    '.github/workflows/ci.yml',
    '.github/workflows',
    '.mcp.json',
    '.env',
    '.env.local',
    '.env.production',
    '.npmrc',
    '.netrc',
    'packages/x/.vscode/tasks.json',
    'a/b/.git/config',
    'apps/web/.env',
    'apps/web/.env.test',
    'packages/x/.github/workflows/y.yml',
    'sub/.claude/settings.local.json',
    '.GIT/config',
    '.VSCode/Settings.json',
    '.ENV',
    '.Env.Local',
    './.git/config',
    'a//.vscode/x',
    'deep/.husky',
    // Windows spellings: trailing dots and spaces are dropped, colons mean streams or drives.
    '.claude./settings.json',
    '.git./hooks/pre-commit',
    '.vscode /tasks.json',
    '.mcp.json.',
    '.env ',
    'a/.git:stream',
    '.env. .',
    '.vscode../tasks.json',
    'a/.GIT. /config',
    '.claude\\settings.json',
    'C:/x',
    'src/a.ts:stream',
    '.env.local.',
    '.github./workflows./ci.yml',
    '.gitattributes',
    'sub/.gitattributes',
  ])('%s is protected', (path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each([
    '',
    'src/index.ts',
    'README.md',
    '.gitignore',
    '.gitkeep',
    '.github/CODEOWNERS',
    '.github/ISSUE_TEMPLATE/bug.md',
    '.github',
    'github/workflows/ci.yml',
    '.envrc',
    'env',
    'src/.environment.ts',
    'src/environment.ts',
    '.vscode-test/x',
    'vscode/settings.json',
    'src/gitlab.ts',
    'docs/.git-notes.md',
    '.npmrc.example',
    'mcp.json',
    'x.mcp.json',
    'a/.config/app.json',
    'claude/settings.json',
  ])('%j is not protected', (path) => {
    expect(isProtectedPath(path)).toBe(false);
  });
});

describe('isProtectedAbsolutePath', () => {
  // The root of the current platform: a drive on Windows, / elsewhere.
  const base = parse(process.cwd()).root;

  it.each([
    ['a .git directory', ['repo', '.git', 'config']],
    ['a file below a .git directory', ['repo', '.git', 'hooks', 'pre-commit']],
    ['a .claude directory at any depth', ['home', 'u', '.claude', 'settings.json']],
    ['a .vscode directory', ['x', '.vscode', 'tasks.json']],
    ['a .env file', ['repo', '.env']],
    ['a .env.local file', ['repo', '.env.local']],
    ['a workflow file', ['repo', '.github', 'workflows', 'ci.yml']],
    ['an upper-case name', ['repo', '.GIT', 'config']],
  ])('%s is protected', (_name, parts) => {
    expect(isProtectedAbsolutePath(join(base, ...parts))).toBe(true);
  });

  it.each([
    ['a plain file', ['repo', 'src', 'a.ts']],
    ['a file directly below the root', ['a.txt']],
    ['a .gitignore', ['repo', '.gitignore']],
    ['a .github file that is not a workflow', ['repo', '.github', 'CODEOWNERS']],
  ])('%s is not protected', (_name, parts) => {
    expect(isProtectedAbsolutePath(join(base, ...parts))).toBe(false);
  });

  it('the root alone, with its drive colon, is not protected', () => {
    expect(isProtectedAbsolutePath(base)).toBe(false);
    expect(isProtectedAbsolutePath(join(base, 'repo'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'judges a Windows path from the part after the drive',
    () => {
      expect(isProtectedAbsolutePath('D:\\repo\\.git\\config')).toBe(true);
      expect(isProtectedAbsolutePath('D:\\repo\\src\\a.ts')).toBe(false);
      expect(isProtectedAbsolutePath('D:\\repo\\.git.\\hooks')).toBe(true);
      // A colon after the root is a stream, whatever the name.
      expect(isProtectedAbsolutePath('D:\\repo\\a.ts:stream')).toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')('judges a POSIX path', () => {
    expect(isProtectedAbsolutePath('/repo/.git/config')).toBe(true);
    expect(isProtectedAbsolutePath('/repo/src/a.ts')).toBe(false);
  });
});

describe('exactCommandRule', () => {
  it.each([
    ['npm test', 'Bash(npm test)'],
    ['git status', 'Bash(git status)'],
    ['ls -la', 'Bash(ls -la)'],
    ['node ./scripts/build.js --mode=prod', 'Bash(node ./scripts/build.js --mode=prod)'],
    ['cat ~/a_b-c.txt', 'Bash(cat ~/a_b-c.txt)'],
    ['git log --format=%h,%s', 'Bash(git log --format=%h,%s)'],
    ['npm run x@1+2', 'Bash(npm run x@1+2)'],
    ['env A=1 npm test', 'Bash(env A=1 npm test)'],
    ['npm test --foo=bar', 'Bash(npm test --foo=bar)'],
    ['a'.repeat(300), `Bash(${'a'.repeat(300)})`],
  ])('builds the rule for %j', (command, rule) => {
    expect(exactCommandRule(command)).toBe(rule);
  });

  it.each([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['a redirection', 'echo hi > f'],
    ['an append', 'echo hi >> f'],
    ['a pipe', 'ls | wc'],
    ['and-and', 'a && b'],
    ['or-or', 'a || b'],
    ['a semicolon', 'a; b'],
    ['an ampersand', 'sleep 1 &'],
    ['a substitution', 'ls $(pwd)'],
    ['a variable', 'echo $HOME'],
    ['a backtick', 'echo `id`'],
    ['double quotes', 'rm -rf "x y"'],
    ['single quotes', "echo 'x'"],
    ['parentheses', '(cd x)'],
    ['a glob star', 'rm *.txt'],
    ['a glob question mark', 'ls a?'],
    ['brackets', 'ls [a]'],
    ['braces', 'echo {a,b}'],
    ['a backslash', 'echo a\\ b'],
    ['a newline', 'ls\nrm x'],
    ['a carriage return', 'ls\rrm x'],
    ['a tab', 'ls\tx'],
    ['a NUL', 'ls\u0000'],
    ['a bang', 'echo !!'],
    ['a hash', 'ls #x'],
    ['a non-ASCII letter', 'echo ü'],
    ['a bidi control', 'ls ‮'],
    ['301 characters', 'a'.repeat(301)],
    ['leading space', ' ls'],
    ['a leading assignment', 'NAME=x ls'],
    ['a leading PATH assignment', 'PATH=./bin ls'],
    ['an assignment alone', 'A=1'],
    ['an empty assignment', 'A= ls'],
    ['trailing space', 'ls '],
  ])('builds no rule for %s', (_name, command) => {
    expect(exactCommandRule(command)).toBeUndefined();
  });
});

describe('runsProjectCode', () => {
  const INERT_WORDS = [
    'ls',
    'pwd',
    'cat',
    'head',
    'tail',
    'wc',
    'echo',
    'printf',
    'which',
    'whoami',
    'date',
    'uname',
    'stat',
    'file',
    'du',
    'df',
    'tree',
    'grep',
    'rg',
    'find',
    'sort',
    'uniq',
    'cut',
    'diff',
    'basename',
    'dirname',
    'realpath',
  ];

  it.each(INERT_WORDS)(
    '%s alone, and with arguments, is inert, but not after an assignment',
    (word) => {
      expect(runsProjectCode(word)).toBe(false);
      expect(runsProjectCode(`${word} -a src/index.ts`)).toBe(false);
      expect(runsProjectCode(`CI=1 ${word} x`)).toBe(true);
    },
  );

  it.each([
    'git status',
    'git status -s',
    'git diff',
    'git diff HEAD~1 -- src',
    'git log --oneline -5',
    'git show HEAD',
    'git rev-parse HEAD',
    'git ls-files',
    'git blame src/a.ts',
    'git describe --tags',
    'git branch',
    'git branch -a',
    'git branch -a -v',
    'git remote',
    'git remote -v',
    'git tag',
    'git tag -l',
    'find . -name x.ts',
    'find src -type f',
    'cat package.json',
    'sort -r in.txt',
    'sort -u -k2 in.txt',
    'tree -a -L 2',
    'git log --oneline --color',
    'rg -n --no-heading foo',
    'grep -rn --include=x foo .',
    'grep -r npm .',
    'echo npm',
  ])('%j is inert', (command) => {
    expect(runsProjectCode(command)).toBe(false);
  });

  it.each([
    // The commands an earlier version missed.
    'scripts/deploy.sh',
    'node_modules/.bin/jest',
    'bin/rails test',
    'env A=1 npm test',
    'time make',
    'git commit -m x',
    'jest',
    'vitest run',
    // Known tools.
    'npm test',
    'npx vitest',
    'pnpm run build',
    'yarn',
    'bun test',
    'node script.js',
    'python3 -m pytest',
    'make',
    'cargo test',
    'go test ./...',
    'mvn test',
    'bash x.sh',
    './gradlew test',
    '../tools/run.sh',
    'CI=1 npm test',
    '  npm test',
    // A leading assignment always counts: any variable can redirect what runs.
    'PATH=./bin ls',
    'LD_PRELOAD=./x.so ls',
    'NAME=x ls',
    'A=1 B=2 ls',
    'GIT_EXTERNAL_DIFF=./x git diff',
    // Options that run a program or write a file.
    'git log --output=out.txt',
    'git diff --output out.txt',
    'git show --output=x',
    'git diff --ext-diff',
    'git log --ext-diff -p',
    'git status -c core.pager=x',
    'git log -ccore.pager=x',
    'git -c core.pager=x log',
    'rg --pre ./filter foo',
    'rg --pre=./filter foo',
    'rg --pre-glob "*.x" foo',
    'grep --pre x y',
    'find . -fprint out.txt',
    'find . -fprintf out.txt %p',
    'find . -fls out.txt',
    'sort -o out.txt in.txt',
    'sort --output=out.txt in.txt',
    'sort -ro out.txt in.txt',
    'sort -oout.txt in.txt',
    'sort --compress-program=./x in.txt',
    'tree -o out.txt',
    'tree -ao out.txt',
    // Not on the inert list.
    'rm -rf x',
    'curl x',
    'git',
    'git -C x status',
    'git push',
    'git checkout x',
    'git config core.hooksPath x',
    'git diff2',
    'git branch -d x extra',
    'git branch new-branch',
    'git remote add x y',
    'git tag v1',
    'lsx',
    'npmx test',
    'makefile',
    'tasks',
    // A first word with a slash is never inert.
    '/bin/ls',
    './ls',
    'a/ls',
    '/usr/bin/true',
    // find with an action.
    'find . -exec sh {} +',
    'find . -execdir x',
    'find . -delete',
    'find . -ok rm {}',
    'find . -okdir rm {}',
    // Anything chained or substituted.
    'ls && npm test',
    'ls; npm test',
    'cat x | sh',
    'echo $(npm test)',
    'echo `id`',
    'ls\nnpm test',
    'echo hi > f',
    'ls &',
    // Nothing to judge.
    '',
    '   ',
    'CI=1',
  ])('%j can run project code', (command) => {
    expect(runsProjectCode(command)).toBe(true);
  });
});

describe('exactPowerShellCommand', () => {
  it.each([
    'npm test',
    'Get-ChildItem',
    'Get-Content -Path .\\notes.txt',
    '.\\run.ps1',
    'C:\\tools\\build.ps1 -Release',
    './scripts/build.sh',
    'git status',
    'a  b',
    'a'.repeat(300),
  ])('keeps %j', (command) => {
    expect(exactPowerShellCommand(command)).toBe(command);
  });

  it.each([
    ['an empty string', ''],
    ['only spaces', '   '],
    ['a variable', 'echo $x'],
    ['a semicolon', 'a; b'],
    ['a pipe', 'ls | wc'],
    ['a backtick', 'echo `n'],
    ['double quotes', 'echo "x"'],
    ['single quotes', "echo 'x'"],
    ['parentheses', '(Get-Date)'],
    ['an ampersand', 'a & b'],
    ['a call operator', '& .\\x.ps1'],
    ['a redirection', 'ls > f'],
    ['braces', '@{a=1}'],
    ['a glob', 'ls *.txt'],
    ['a comma', 'a,b'],
    ['an equals sign', 'x=1'],
    ['a newline', 'ls\nrm x'],
    ['a tab', 'ls\tx'],
    ['a non-ASCII letter', 'echo ü'],
    ['a bidi control', 'ls \u202e'],
    ['a leading space', ' ls'],
    ['a trailing space', 'ls '],
    ['301 characters', 'a'.repeat(301)],
  ])('refuses %s', (_name, command) => {
    expect(exactPowerShellCommand(command)).toBeUndefined();
  });
});

describe('runsProjectCodePowerShell', () => {
  const INERT_WORDS = [
    'get-childitem',
    'get-content',
    'get-location',
    'get-item',
    'test-path',
    'resolve-path',
    'select-string',
    'get-date',
    'ls',
    'dir',
    'gci',
    'cat',
    'type',
    'gc',
    'pwd',
    'gl',
  ];

  it.each(INERT_WORDS)('%s is inert in any case, alone and with arguments', (word) => {
    const mixed = [...word].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('');
    for (const name of [word, word.toUpperCase(), mixed]) {
      expect(runsProjectCodePowerShell(name)).toBe(false);
      expect(runsProjectCodePowerShell(`${name} -Path src`)).toBe(false);
    }
  });

  it.each(['git status', 'git status -s', 'git diff HEAD', 'GIT log --oneline', 'git branch -a'])(
    '%j is inert',
    (command) => {
      expect(runsProjectCodePowerShell(command)).toBe(false);
    },
  );

  it.each([
    'git',
    'git -c x status',
    'git -C x status',
    'git push',
    'git commit -m x',
    'git log --output=out.txt',
    'git diff --ext-diff',
    '.\\run.ps1',
    '. .\\x.ps1',
    '\\\\server\\x.exe',
    'C:\\tools\\x.exe',
    './build.sh',
    'scripts/x',
    'npm test',
    'npx vitest',
    'node x.js',
    'Invoke-Expression x',
    'iex x',
    'Start-Process x',
    'Remove-Item x',
    'lsx',
    'get-childitem2',
    'ls; npm test',
    'Get-Content x | iex',
    'echo $(npm test)',
    ' ls',
    'ls ',
    '',
  ])('%j can run project code', (command) => {
    expect(runsProjectCodePowerShell(command)).toBe(true);
  });
});
