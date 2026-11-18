import { describe, expect, it } from 'vitest';
import { parseGit } from './git';
import type { Parsed } from './grammar';
import { tokenize } from './tokenize';

/** Parses the words after `git` in the first simple command of a line. */
function parse(line: string, platform: NodeJS.Platform = 'linux'): Parsed {
  const tokens = tokenize(line);
  if (!tokens.ok) throw new Error(`tokenizer refused ${JSON.stringify(line)}: ${tokens.reason}`);
  const words = tokens.commands[0]?.words ?? [];
  if (words[0]?.text !== 'git') throw new Error('not a git command');
  return parseGit(words.slice(1), platform);
}

function reasonOf(line: string, platform: NodeJS.Platform = 'linux'): string {
  const parsed = parse(line, platform);
  if (parsed.ok) throw new Error(`accepted: ${line}`);
  return parsed.reason;
}

function refsOf(line: string): string[] {
  const parsed = parse(line);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.refs.map((ref) => ref.word);
}

describe('git: accepted', () => {
  it.each([
    'git status',
    'git status --short',
    'git status -s -b',
    'git status -sb',
    'git status -uno',
    'git status -unormal',
    'git status -uall',
    'git status -u',
    'git status --untracked-files=no',
    'git status --porcelain',
    'git status --porcelain=v2',
    'git status --ignored',
    'git status --ignored=matching',
    'git status --ignore-submodules=all',
    'git status --short -- src',
    'git --no-pager log --oneline -5',
    "git log -5 --format='%h %s'",
    'git log -n 5',
    'git log -n5',
    'git log --max-count=5 --skip=2',
    'git log --oneline @{u}..HEAD',
    'git log -S foo -- src',
    'git log -Sfoo',
    "git log -G 'a.*b'",
    "git log --since='2 days ago' --author=x --grep=fix --date=iso",
    'git log --decorate --graph --all',
    'git log --decorate=short --color=never',
    'git log --diff-filter=AM --name-status',
    'git log --stat -p -w -M -C',
    'git log --pretty=oneline',
    'git log --format=%h',
    'git log -- src/a.ts',
    'git log main..HEAD a...b',
    'git log --abbrev=8',
    'git show abc123',
    "git show abc123 --format='%h %ad' -- src/a.ts",
    'git show HEAD:src/a.ts',
    'git show HEAD --stat -3',
    'git diff HEAD~1 --stat',
    'git diff --cached',
    'git diff -U5 a..b',
    'git diff --word-diff=color --color',
    'git diff -- src',
    'git diff --name-only HEAD~3 -M',
    'git shortlog -sn --since=2.weeks',
    'git shortlog -5',
    'git rev-list --count HEAD',
    'git rev-list -n 3 HEAD',
    'git rev-list --max-count=3 --skip=1 HEAD',
    'git rev-list -5 HEAD',
    'git rev-parse --abbrev-ref HEAD',
    'git rev-parse --short HEAD',
    'git rev-parse --short=8 HEAD',
    'git rev-parse --verify -q HEAD',
    'git rev-parse --show-toplevel',
    'git ls-files -o --exclude-standard',
    'git ls-files --abbrev -s',
    "git ls-files --format='%(objectname)'",
    'git ls-tree -r --name-only HEAD',
    'git ls-tree HEAD src/',
    'git blame -L 1,5 src/a.ts',
    'git blame -L1,5 src/a.ts',
    'git blame -w -M --abbrev=8 src/a.ts',
    'git blame -L10,+5 -- f',
    'git describe --tags --always',
    "git describe --abbrev=7 --match='v*'",
    'git cat-file -p HEAD:src/a.ts',
    'git cat-file -t HEAD',
    'git cat-file -s HEAD',
    'git cat-file -e HEAD',
    'git check-ignore -v src/a.ts',
    'git check-ignore --non-matching -v x',
    'git reflog',
    'git reflog -8 --date=iso',
    'git reflog show',
    'git reflog show HEAD',
    'git reflog -n 5 HEAD@{1}',
    'git reflog --oneline',
    'git reflog --format=%h',
    'git branch',
    'git branch -vv',
    'git branch -a',
    'git branch -r',
    'git branch --show-current',
    'git branch --list',
    "git branch -l 'feat*'",
    "git branch --list 'a*' -v",
    'git branch --contains=abc',
    'git branch --contains',
    'git branch --merged',
    'git branch --merged=main',
    'git branch --points-at HEAD',
    'git branch --sort=-committerdate',
    "git branch --format='%(refname)'",
    'git branch -i -l x',
    'git tag',
    'git tag -l',
    "git tag -l 'v*'",
    'git tag -n',
    'git tag -n5',
    'git tag -n5 -l',
    'git tag --sort=-v:refname -l',
    'git tag --points-at HEAD',
    'git remote',
    'git remote -v',
    'git remote --verbose',
    'git grep foo',
    'git grep -n foo -- src',
    'git grep -e foo -e bar',
    'git grep -C 3 foo',
    'git grep -A3 foo',
    'git grep --max-depth 2 foo',
    'git grep --max-depth=2 foo',
    'git grep --context 2 foo',
    'git grep -i -l foo HEAD',
    'git grep --cached foo',
    "git grep -P 'a' src",
    'git ls-files :/',
  ])('%s', (line) => {
    expect(parse(line)).toMatchObject({ ok: true });
  });

  it('collects revisions and pathspecs, not patterns or option text', () => {
    expect(refsOf('git log -S foo --author=x main..HEAD -- src/a.ts')).toEqual([
      'main..HEAD',
      'src/a.ts',
    ]);
    expect(refsOf('git grep -n foo HEAD -- src')).toEqual(['HEAD', 'src']);
    expect(refsOf('git grep -e foo src')).toEqual(['src']);
    expect(refsOf("git branch -l 'feat*'")).toEqual([]);
    expect(refsOf('git blame -L 1,5 f')).toEqual(['f']);
    expect(refsOf('git show HEAD:src/a.ts')).toEqual(['HEAD:src/a.ts']);
    expect(refsOf('git reflog show HEAD@{1}')).toEqual(['HEAD@{1}']);
  });
});

describe('git: refused', () => {
  it.each<[string, string]>([
    // The shape: nothing may come before the subcommand but --no-pager.
    ['git', 'git-shape'],
    ['git --no-pager', 'git-shape'],
    ['git --no-pager --no-pager log', 'git-shape'],
    ['git -c a=b status', 'git-shape'],
    ['git -C .. status', 'git-shape'],
    ['git --config-env=core.pager=X status', 'git-shape'],
    ['git -p log', 'git-shape'],
    ['git --git-dir=x status', 'git-shape'],
    ['git --work-tree=x status', 'git-shape'],
    ['git --exec-path=x status', 'git-shape'],
    ['git --version', 'git-shape'],
    ['git -h', 'git-shape'],
    // Subcommands that change something, and the ones that are not listed.
    ['git push', 'git-subcommand'],
    ['git commit', 'git-subcommand'],
    ['git fetch', 'git-subcommand'],
    ['git config user.name', 'git-subcommand'],
    ['git stash', 'git-subcommand'],
    ['git checkout x', 'git-subcommand'],
    ['git add .', 'git-subcommand'],
    ['git clean', 'git-subcommand'],
    ['git worktree list', 'git-subcommand'],
    ['git for-each-ref', 'git-subcommand'],
    ['git archive HEAD', 'git-subcommand'],
    ['git help', 'git-subcommand'],
    ['git STATUS', 'git-subcommand'],
    ['git sta', 'git-subcommand'],
    // remote
    ['git remote -v show origin', 'git-shape'],
    ['git remote add x y', 'git-shape'],
    ['git remote show origin', 'git-shape'],
    ['git remote -vv', 'git-shape'],
    ['git remote get-url x', 'git-shape'],
    // branch and tag
    ['git branch newname', 'operand-not-allowed'],
    ['git branch -D x', 'option-not-allowed'],
    ['git branch -d x', 'option-not-allowed'],
    ['git branch -m a b', 'option-not-allowed'],
    ['git branch -c a b', 'option-not-allowed'],
    ['git branch -f x', 'option-not-allowed'],
    ['git branch -u x', 'option-not-allowed'],
    ['git branch --delete x', 'option-not-allowed'],
    ['git branch --set-upstream-to=x', 'option-not-allowed'],
    ['git branch --unset-upstream', 'option-not-allowed'],
    ['git branch --edit-description', 'option-not-allowed'],
    ["git branch --format='%(signature)'", 'value-not-allowed'],
    ["git branch --format='%(contents:SIGNATURE)'", 'value-not-allowed'],
    ['git branch --contains abc', 'operand-not-allowed'],
    ['git branch --points-at', 'missing-value'],
    ['git tag v1', 'operand-not-allowed'],
    ['git tag -d v1', 'option-not-allowed'],
    ['git tag -a v1 -m x', 'option-not-allowed'],
    ['git tag -s v1', 'option-not-allowed'],
    ['git tag -v v1', 'option-not-allowed'],
    ['git tag -f v1', 'option-not-allowed'],
    ['git tag -u x', 'option-not-allowed'],
    ['git tag -F x', 'option-not-allowed'],
    ["git tag -l --format='%(contents:signature)'", 'value-not-allowed'],
    ['git tag -n5 v1', 'operand-not-allowed'],
    ['git tag -nx -l', 'value-not-allowed'],
    // reflog
    ['git reflog expire', 'git-shape'],
    ['git reflog delete x', 'git-shape'],
    ['git reflog exists x', 'git-shape'],
    ['git reflog drop', 'git-shape'],
    ['git reflog write', 'git-shape'],
    ['git reflog list', 'git-shape'],
    ['git reflog HEAD', 'git-shape'],
    ['git reflog show expire', 'git-subcommand'],
    ['git reflog show list', 'git-subcommand'],
    ['git reflog -8 delete', 'git-subcommand'],
    ['git reflog show HEAD HEAD~1', 'operand-not-allowed'],
    ['git reflog -p', 'option-not-allowed'],
    ['git reflog --expire=now', 'option-not-allowed'],
    ['git reflog --format=%G?', 'glob'],
    ["git reflog --format='%G?'", 'value-not-allowed'],
    // diff and log
    ['git diff --output=f', 'option-not-allowed'],
    ['git diff --outp=f', 'option-not-allowed'],
    ['git diff --output f', 'option-not-allowed'],
    ['git diff --ext-diff', 'option-not-allowed'],
    ['git diff --no-index a b', 'option-not-allowed'],
    ['git diff --textconv', 'option-not-allowed'],
    ['git diff -O x', 'option-not-allowed'],
    ['git diff -S foo', 'option-not-allowed'],
    ['git diff --src-prefix=x', 'option-not-allowed'],
    ['git diff --word-diff=x', 'value-not-allowed'],
    ['git diff ../x', 'path-form'],
    ['git diff -- ../x', 'path-form'],
    ['git diff //x', 'path-form'],
    ['git log --show-signature', 'option-not-allowed'],
    ['git log --format=%G?', 'glob'],
    ["git log --format='%G?'", 'value-not-allowed'],
    ['git log --format=x%GGy', 'value-not-allowed'],
    ['git log --pretty=format:%GS', 'value-not-allowed'],
    ["git show --format='%G?'", 'value-not-allowed'],
    ['git log --output=f', 'option-not-allowed'],
    ['git log --exec=x', 'option-not-allowed'],
    ['git log --stdin', 'option-not-allowed'],
    ['git log -L 1,2:f', 'option-not-allowed'],
    ['git log --ignore-revs-file=x', 'option-not-allowed'],
    ['git log --walk-reflogs', 'option-not-allowed'],
    ['git log --no-pager', 'option-not-allowed'],
    ['git log --decorate=x', 'value-not-allowed'],
    ['git log -n abc', 'value-not-allowed'],
    ['git log --diff-filter=Z', 'value-not-allowed'],
    ['git log --abbrev', 'missing-value'],
    ['git log --max-count 5', 'missing-value'],
    ['git log -5q', 'option-not-allowed'],
    ['git status -5', 'option-not-allowed'],
    ['git status -ux', 'value-not-allowed'],
    ['git status --porcelain=v3', 'value-not-allowed'],
    ['git rev-parse --short=x HEAD', 'value-not-allowed'],
    ['git show HEAD:../x', 'path-form'],
    ['git show HEAD:a/../../x', 'path-form'],
    ['git log ../x', 'path-form'],
    ['git log -- ..', 'path-form'],
    // blame
    ['git blame --contents x f', 'option-not-allowed'],
    ['git blame -S x f', 'option-not-allowed'],
    ['git blame --ignore-revs-file=x f', 'option-not-allowed'],
    ['git blame --incremental f', 'option-not-allowed'],
    ['git blame -L 1,2:f f', 'value-not-allowed'],
    ['git blame -L', 'missing-value'],
    ['git blame -5 f', 'option-not-allowed'],
    // describe
    ['git describe --dirty', 'option-not-allowed'],
    ['git describe --dirty=x', 'option-not-allowed'],
    ['git describe --broken', 'option-not-allowed'],
    // cat-file
    ['git cat-file --batch', 'option-not-allowed'],
    ['git cat-file --batch-check', 'option-not-allowed'],
    ['git cat-file --textconv HEAD:x', 'option-not-allowed'],
    ['git cat-file --filters HEAD:x', 'option-not-allowed'],
    ['git cat-file --batch-all-objects', 'option-not-allowed'],
    ['git cat-file -p', 'missing-value'],
    ['git cat-file -p -t HEAD', 'git-shape'],
    ['git cat-file HEAD', 'git-shape'],
    ['git cat-file -p a b', 'operand-not-allowed'],
    // grep
    ['git grep --op=x -e y', 'option-not-allowed'],
    ['git grep -nOx -e y', 'option-not-allowed'],
    ['git grep -O x', 'option-not-allowed'],
    ['git grep --open-files-in-pager=x x', 'option-not-allowed'],
    ['git grep --no-index x', 'option-not-allowed'],
    ['git grep -f file', 'option-not-allowed'],
    ['git grep --textconv x', 'option-not-allowed'],
    ['git grep --recurse-submodules x', 'option-not-allowed'],
    ['git grep --and x', 'option-not-allowed'],
    ['git grep -5 x', 'option-not-allowed'],
    ['git grep -e', 'missing-value'],
    ['git grep', 'missing-value'],
    ['git grep -C x foo', 'value-not-allowed'],
    ['git grep foo ../x', 'path-form'],
    // ls-files, ls-tree, rev-parse
    ['git ls-files --exclude-from=x', 'option-not-allowed'],
    ['git ls-files -x pat', 'option-not-allowed'],
    ['git ls-files -X file', 'option-not-allowed'],
    ['git ls-files --with-tree=HEAD', 'option-not-allowed'],
    ['git ls-files --debug', 'option-not-allowed'],
    ['git ls-tree --long=x HEAD', 'option-not-allowed'],
    ['git rev-parse --git-path x', 'option-not-allowed'],
    ['git rev-parse --parseopt', 'option-not-allowed'],
    // globs
    ['git log *.ts', 'glob'],
    ['git log -- src/*', 'glob'],
    ['git grep --include=*.ts x', 'glob'],
  ])('%s gives %s', (line, code) => {
    expect(reasonOf(line)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ['git show HEAD:/x', 'path-form'],
    ["git show 'HEAD:\\x'", 'path-form'],
    ["git log 'a\\\\b'", 'path-form'],
    ["git log 'HEAD:..\\x'", 'path-form'],
  ])('on win32 %s gives %s', (line, code) => {
    expect(reasonOf(line, 'win32')).toMatch(new RegExp(`^${code}`));
  });

  it('refuses `:/` on win32 only', () => {
    expect(parse("git ls-files ':/'", 'linux')).toMatchObject({ ok: true });
    expect(reasonOf("git ls-files ':/'", 'win32')).toMatch(/^path-form/);
  });
});
