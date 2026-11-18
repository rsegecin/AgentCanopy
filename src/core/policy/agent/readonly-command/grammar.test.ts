import { describe, expect, it } from 'vitest';
import type { CommandSpec, Parsed } from './grammar';
import { parseSimpleCommand, parseWithSpec } from './grammar';
import { isPrintOnlySedScript } from './sed';
import { lexicalPathReason } from './paths';
import { tokenize } from './tokenize';

/** Parses the first simple command of a line, as the entry point does. */
function parse(line: string, platform: NodeJS.Platform = 'linux'): Parsed {
  const tokens = tokenize(line);
  if (!tokens.ok) throw new Error(`tokenizer refused ${JSON.stringify(line)}: ${tokens.reason}`);
  const [name, ...args] = tokens.commands[0]?.words ?? [];
  return parseSimpleCommand(name?.text ?? '', args, platform);
}

function reasonOf(line: string, platform: NodeJS.Platform = 'linux'): string {
  const parsed = parse(line, platform);
  if (parsed.ok) throw new Error(`accepted: ${line}`);
  return parsed.reason;
}

describe('grammar: accepted', () => {
  it.each([
    'ls',
    'ls -la src',
    'ls -1 --color=never',
    'ls --color',
    "ls --ignore='*.o' --width=80 -l",
    'ls --width=80',
    'ls -R --sort=size --format=long --time-style=+%F --group-directories-first',
    'cat -n a b',
    'cat -- -x',
    'head -n 5 f',
    'head -n5 f',
    'head -5 f',
    'head --lines=5 f',
    'head -c -5 f',
    'head -qv f',
    'tail -n +5 f',
    'tail -qn3 f',
    'wc -l f',
    'nl -ba -n rz -w 3 -s, f',
    'stat -c %s f',
    'stat --format=%s --printf=%n f',
    'file -b f',
    'du -sh .',
    'du -d 1 -t +10K .',
    'du --max-depth=2 --threshold=-5M .',
    'df -h',
    'cut -d, -f1,3-5 f',
    'cut -c 1-5 f',
    'cut --fields=1 --delimiter=: f',
    "tr -d '\\n'",
    'tr a-z A-Z',
    'diff -u a b',
    'diff -U 5 a b',
    'diff -C3 a b',
    'diff --color a b',
    'cmp -n 5 a b',
    'cmp -i 2:3 a b',
    'sort -u -k 2,3 -t , f',
    'sort -nr f',
    'sort --check=quiet f',
    'sort --check f',
    'uniq -c f',
    'uniq -f 2 f',
    'uniq',
    'grep -n pat f',
    'grep -rn "x" src --include=*.ts',
    'grep -e a -e b f',
    'grep -epattern f',
    'grep -A3 x f',
    'grep -5 x f',
    'grep --exclude-dir=node_modules -r x .',
    'grep --exclude=a*/b* --include=*.[ch] x f',
    'grep --color=never x f',
    "grep -nE 'a|b' f",
    'grep -- -x f',
    'egrep x f',
    'fgrep x f',
    'rg foo',
    'rg -n foo src',
    'rg --glob=*.ts foo',
    "rg -g '*.ts' foo",
    'rg --files',
    'rg --files src',
    'rg -e foo src',
    'rg -t ts foo',
    'rg --type=ts foo',
    'rg -C 2 foo',
    'rg --sort=path --files',
    'rg -uu x',
    'rg -. x',
    'rg --no-config --color=never x',
    'sed -n 432,500p f',
    "sed -n '/^export/p' f",
    "sed 's/a/b/g' f",
    "sed -n '1p;3p' f",
    "sed -E 's/(a)/\\1/' f",
    'sed p f',
    'echo -n x',
    "printf '%s\\n' x",
    'printf %s -v',
    "printf '%5.2f' 1",
    "printf '100%%\\n'",
    "printf '50% done'",
    "printf '%d items\\n' 3",
    "printf '%b' 'a%n'",
    "printf '%s' '%n'",
    'pwd -P',
    'which -a git',
    'which git',
    'which node.exe c++',
    'whoami',
    'uname -a',
    'date +%s',
    'date -u +%FT%T',
    'date -I',
    'date -Idate',
    'date --iso-8601=seconds',
    'date -R',
    'basename -a x y',
    'basename -s .ts x.ts',
    'dirname x',
    'realpath --relative-to=src src/a',
    'realpath -m x',
    "find . -name '*.ts' -type f",
    'find -P . -maxdepth 2',
    'find src -type f -o -type d',
    'find . -size +10k -mtime -1',
    'find . -newer src/a.ts',
    'find . -perm -u+x -type f,d',
    "find . -regextype posix-extended -regex '.*'",
    'find . -name x -print0',
    'find',
  ])('%s', (line) => {
    expect(parse(line)).toMatchObject({ ok: true });
  });

  it('collects the files an invocation names', () => {
    const parsed = parse('diff -U 2 a/x b --color=never');
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.refs).toEqual([
        { word: 'a/x', kind: 'path', notDirectory: true },
        { word: 'b', kind: 'path', notDirectory: true },
        { word: '--color=never', kind: 'path' },
      ]);
    }
    const find = parse('find src -newer docs/list -name x');
    if (find.ok) {
      expect(find.refs.map((ref) => ref.word)).toEqual(['src', 'docs/list']);
    }
  });

  it('does not take a pattern as a file', () => {
    const parsed = parse('grep -n pat f');
    if (parsed.ok) expect(parsed.refs.map((ref) => ref.word)).toEqual(['f']);
    const withE = parse('grep -e pat f');
    if (withE.ok) expect(withE.refs.map((ref) => ref.word)).toEqual(['f']);
  });
});

describe('grammar: refused', () => {
  it.each<[string, string]>([
    // Options that write, run a program, or read a list of file names.
    ['sort -o f x', 'option-not-allowed'],
    ['sort --co=sh x', 'option-not-allowed'],
    ['sort --compress-program=sh x', 'option-not-allowed'],
    ['sort --files0-from=-', 'option-not-allowed'],
    ['sort --out=f x', 'option-not-allowed'],
    ['sort -T /tmp x', 'option-not-allowed'],
    ['sort --reverse=x f', 'option-not-allowed'],
    ['sort -k', 'missing-value'],
    ['sort --key 1 f', 'missing-value'],
    ["sort -k 'a;b' f", 'value-not-allowed'],
    ['sort -t abcde f', 'value-not-allowed'],
    ['wc --files0-from=docs/list', 'option-not-allowed'],
    ['du --files0-from=x', 'option-not-allowed'],
    ['file -f docs/list', 'option-not-allowed'],
    ['file -m x:/c/y src/a.ts', 'option-not-allowed'],
    ['file --comp', 'option-not-allowed'],
    ['file -C', 'option-not-allowed'],
    ['file -z f', 'option-not-allowed'],
    ['find . -exec ls', 'find-expression'],
    ['find . -delete', 'find-expression'],
    ['find . -fprint x', 'find-expression'],
    ['find . -fls x', 'find-expression'],
    ['find . -ok x', 'find-expression'],
    ['find . -follow', 'find-expression'],
    ['find -L .', 'option-not-allowed'],
    ['find -H .', 'option-not-allowed'],
    ['find . -files0-from x', 'find-expression'],
    ['find . -P', 'find-expression'],
    ['find . -name', 'missing-value'],
    ['find . -type x', 'value-not-allowed'],
    ['find . -size 1T', 'value-not-allowed'],
    ['find . -name x y', 'find-expression'],
    ["find . '!' -name x -exec", 'find-expression'],
    ['find . -newer ../x', 'path-form'],
    ['find ../x', 'path-form'],
    ['find . -newer -', 'path-form'],
    ['sed -i s/a/b/ f', 'option-not-allowed'],
    ['sed -e p f', 'option-not-allowed'],
    ['sed -f x', 'option-not-allowed'],
    ['sed --in-place p f', 'option-not-allowed'],
    ['sed --expression=p f', 'option-not-allowed'],
    ['sed', 'missing-value'],
    ['sed -n p ../x', 'path-form'],
    ['printf -v x %s 1', 'option-not-allowed'],
    ['printf -- x', 'option-not-allowed'],
    ['printf', 'missing-value'],
    ["printf '%n' 'a[$(id)]'", 'value-not-allowed'],
    ["printf 'a%ln' x", 'value-not-allowed'],
    ["printf '%5n' x", 'value-not-allowed'],
    ["printf '%1$n' x", 'value-not-allowed'],
    ["printf '%s%n' a x", 'value-not-allowed'],
    ["printf '%-n' x", 'value-not-allowed'],
    ['date -f../x', 'option-not-allowed'],
    ['date -fC:/x', 'option-not-allowed'],
    ['date -s 2001-01-01', 'option-not-allowed'],
    ['date --s=1', 'option-not-allowed'],
    ['date -d x', 'option-not-allowed'],
    ['date -r x', 'option-not-allowed'],
    ['date x', 'operand-not-allowed'],
    ['date +a +b', 'operand-not-allowed'],
    ['date -Ix', 'value-not-allowed'],
    ['date --iso-8601=x', 'value-not-allowed'],
    ['tail -f x', 'option-not-allowed'],
    ['tail -F x', 'option-not-allowed'],
    ['tail --follow x', 'option-not-allowed'],
    ['tail --pid=1 x', 'option-not-allowed'],
    ['tail --retry x', 'option-not-allowed'],
    ['head -5q f', 'option-not-allowed'],
    ['head -q5 f', 'option-not-allowed'],
    ['head -n abc f', 'value-not-allowed'],
    ['head -n 1234567890 f', 'value-not-allowed'],
    ['head -n', 'missing-value'],
    ['head --lines', 'missing-value'],
    ['head --lines=', 'value-not-allowed'],
    ['head --lines 5 f', 'missing-value'],
    ['echo -x', 'option-not-allowed'],
    ['echo --help', 'option-not-allowed'],
    ['pwd -W', 'option-not-allowed'],
    ['pwd x', 'operand-not-allowed'],
    ['whoami x', 'operand-not-allowed'],
    ['stat -x f', 'option-not-allowed'],
    ['tr', 'missing-value'],
    ['tr a b c', 'operand-not-allowed'],
    ['cut -n x', 'option-not-allowed'],
    ['cut -f a f', 'value-not-allowed'],
    ['cut -d abcde f', 'value-not-allowed'],
    ['cmp a', 'missing-value'],
    ['cmp a b c d', 'operand-not-allowed'],
    ['cmp -i x a b', 'value-not-allowed'],
    ['diff a', 'missing-value'],
    ['diff --unified a b', 'missing-value'],
    ['du -t 5X .', 'value-not-allowed'],
    ['nl -b pfoo f', 'value-not-allowed'],
    ['nl -n xx f', 'value-not-allowed'],
    ['realpath --relative-to=../x a', 'path-form'],
    ['realpath --relative-to', 'missing-value'],
    // Operands.
    ['uniq a b', 'operand-not-allowed'],
    ['uniq - out', 'operand-not-allowed'],
    ['uniq -- a b', 'option-not-allowed'],
    ['uniq --', 'option-not-allowed'],
    ['uniq -', 'path-form'],
    ['cat ../x', 'path-form'],
    ["cat ''", 'path-form'],
    ['cat a/../b', 'path-form'],
    ['cat ..', 'path-form'],
    ['cat //host/x', 'path-form'],
    ['cat /a/..', 'path-form'],
    // Following symlinks.
    ['grep -R x .', 'option-not-allowed'],
    ['grep -nR x .', 'option-not-allowed'],
    ['grep --der x .', 'option-not-allowed'],
    ['grep --dereference-recursive x .', 'option-not-allowed'],
    ['grep -f patterns x', 'option-not-allowed'],
    ['grep -fpatterns x', 'option-not-allowed'],
    ['grep -d recurse x .', 'option-not-allowed'],
    ['grep', 'missing-value'],
    ['grep --binary-files=x p f', 'value-not-allowed'],
    ['ls -RL .', 'option-not-allowed'],
    ['ls -L x', 'option-not-allowed'],
    ['ls -H x', 'option-not-allowed'],
    ['ls --dereference x', 'option-not-allowed'],
    ['ls --sort=x', 'value-not-allowed'],
    ['ls -I x .', 'option-not-allowed'],
    ['ls -w 80 .', 'option-not-allowed'],
    ['ls -w80 .', 'option-not-allowed'],
    ['which ../x', 'operand-not-allowed'],
    ['which /etc/x', 'operand-not-allowed'],
    ['which a/b', 'operand-not-allowed'],
    ['which -a ../x', 'operand-not-allowed'],
    ['du -L .', 'option-not-allowed'],
    ['du -H .', 'option-not-allowed'],
    ['du --dereference .', 'option-not-allowed'],
    ['diff -rN a b', 'option-not-allowed'],
    ['diff -r a b', 'option-not-allowed'],
    ['diff --from-file=a b', 'option-not-allowed'],
    ['diff -X x a b', 'option-not-allowed'],
    ['rg -L x', 'option-not-allowed'],
    ['rg --follow x', 'option-not-allowed'],
    // Other options that run a program.
    ['rg -z x', 'option-not-allowed'],
    ['rg --pre cat x', 'option-not-allowed'],
    ['rg --pre=cat x', 'option-not-allowed'],
    ['rg --hostname-bin=x x', 'option-not-allowed'],
    ['rg --ignore-file=x x', 'option-not-allowed'],
    ['rg -f x', 'option-not-allowed'],
    ['rg', 'missing-value'],
    ['rg --color=x y', 'value-not-allowed'],
    ['rg -t "a b" x', 'value-not-allowed'],
    // Commands.
    ['jq -n env', 'unknown-command'],
    ['tree', 'unknown-command'],
    ['npx tsc', 'unknown-command'],
    ['constructor', 'unknown-command'],
    ['__proto__', 'unknown-command'],
    // Globs.
    ['cat *', 'glob'],
    ['cat -- --a=*', 'glob'],
    ['cat --a=*', 'glob'],
    ['ls *.ts', 'glob'],
    ['cat a?b', 'glob'],
    ['cat [ab]', 'glob'],
    ['find . -name *.ts', 'glob'],
    ['grep -e * f', 'glob'],
    ['grep x *.ts', 'glob'],
    ['grep -- --include=* x', 'glob'],
    ["grep '--include'=*.ts x", 'glob'],
    ['grep --in"clude"=*.ts x', 'glob'],
    ['grep --include*=a x', 'glob'],
    ['grep --color=n* x', 'glob'],
    ['grep --exclude-from=* x', 'glob'],
    ['grep --glob=*.ts x', 'glob'],
    ['egrep --glob=*.ts x', 'glob'],
    ['rg --include=*.ts x', 'glob'],
    ['rg -g *.ts x', 'glob'],
    ['sort --include=*.ts', 'glob'],
  ])('%s gives %s', (line, code) => {
    expect(reasonOf(line)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ["cat '\\\\host\\s\\x'", 'path-form'],
    ['cat C:/x/a:stream', 'path-form'],
    ['cat a:b', 'path-form'],
    ["cat 'a\\\\b'", 'path-form'],
    ["cat '..\\b'", 'path-form'],
    ["cat 'a\\..\\b'", 'path-form'],
  ])('on win32 %s gives %s', (line, code) => {
    expect(reasonOf(line, 'win32')).toMatch(new RegExp(`^${code}`));
  });

  it.each(['cat C:/x/a.ts', "cat 'C:\\x\\a.ts'", "cat 'src\\a.ts'", 'cat /dev/null'])(
    'on win32 %s passes the lexical rules',
    (line) => {
      expect(parse(line, 'win32')).toMatchObject({ ok: true });
    },
  );

  it.each(["cat '..\\b'", "cat 'a\\\\b'", 'cat a:b', 'cat C:/x'])(
    'on linux %s passes the lexical rules',
    (line) => {
      expect(parse(line, 'linux')).toMatchObject({ ok: true });
    },
  );
});

describe('grammar: path values are never attached', () => {
  const spec: CommandSpec = {
    flags: 'q',
    longFlags: [],
    values: [
      { short: 'f', value: { type: 'path' } },
      { short: 'g', value: { type: 'gitArg' } },
      { short: 'n', value: { type: 'number' } },
    ],
    operands: { kind: 'path' },
  };
  const run = (line: string): Parsed => {
    const tokens = tokenize(line);
    if (!tokens.ok) throw new Error(tokens.reason);
    return parseWithSpec(spec, tokens.commands[0]?.words.slice(1) ?? [], 'linux');
  };

  it.each(['x -f a', 'x -qf a', 'x -g a', 'x -n5 a', 'x -qn 5 a'])('%s passes', (line) => {
    expect(run(line)).toMatchObject({ ok: true });
  });

  it.each([['x -fa'], ['x -qfa'], ['x -ga']])('%s is refused', (line) => {
    const parsed = run(line);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.reason).toMatch(/^option-not-allowed/);
  });

  it('refuses a path value that fails the lexical rules', () => {
    const parsed = run('x -f ../a');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toMatch(/^path-form/);
  });
});

describe('later words are path-checked (no permutation on BSD)', () => {
  const refsOf = (line: string): string[] => {
    const parsed = parse(line);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.refs.map((ref) => ref.word);
  };

  it.each<[string, string[]]>([
    ['cat a -n', ['a', '-n']],
    ['head a -n 5', ['a', '-n', '5']],
    ['cat a -- b', ['a', 'b', '--']],
    ['grep -rn x src --include=*.ts', ['src', '--include=*.ts']],
    ['sed -n p f -s', ['f', '-s']],
    ['rg x src --glob=*.ts', ['src', '--glob=*.ts']],
    ['cat -n a b', ['a', 'b']],
    ['ls -la src', ['src']],
    ['echo a -n', []],
    ['tr a b', []],
  ])('%s refers to %j', (line, expected) => {
    expect(refsOf(line)).toEqual(expected);
  });

  it('applies the lexical path rules to them', () => {
    expect(reasonOf('cat a -n ../x')).toMatch(/^path-form/);
    expect(reasonOf('grep x a --include=x/../b')).toMatch(/^path-form/);
  });
});

describe('BSD grep takes the context count only attached', () => {
  it.each<[string, NodeJS.Platform, boolean]>([
    ['grep -C 3 x src/a.ts', 'darwin', false],
    ['grep -C 3 x src/a.ts', 'linux', true],
    ['grep -C3 x src/a.ts', 'darwin', true],
    ['grep -C3 x src/a.ts', 'linux', true],
    ['grep -nC 3 x src/a.ts', 'darwin', false],
    ['grep -nC3 x src/a.ts', 'darwin', true],
    ['grep -A 3 x src/a.ts', 'darwin', true],
    ['egrep -C 3 x f', 'darwin', false],
  ])('%s on %s is accepted: %s', (line, platform, accepted) => {
    expect(parse(line, platform).ok).toBe(accepted);
    if (!accepted) expect(reasonOf(line, platform)).toMatch(/^option-not-allowed/);
  });
});

describe('sed scripts', () => {
  it.each([
    'p',
    'p;p',
    ' p ; p ',
    'p;',
    '5p',
    '432,500p',
    '$p',
    '$=',
    '3q',
    '1,3d',
    '2,+3p',
    '/a/,/b/p',
    '/^export/p',
    '/a\\/b/d',
    '1,$p',
    's/a/b/',
    's/a/b/g',
    's/a/b/gpiI',
    's/a/b/2',
    's/a\\/b/c\\/d/g',
    's/\\(a\\)/\\1&/',
    's/a/b/;s/c/d/',
    '10,20s/x/y/g;30q',
    's//x/',
    's/a//',
    's/[^/]*$//',
    's/[]/]/X/',
    '/[/]/p',
    '/[a/]/p',
    's/[[:alpha:]/]/X/g',
    's/[a\\]/X/',
    's/x\\[/y/',
    's/[/]/X/;p',
    's/[^]/]/X/',
    's/[[.a.]/]/X/',
    's/[[=a=]/]/X/',
    '/^export/p',
  ])('%j is accepted', (script) => {
    expect(isPrintOnlySedScript(script)).toBe(true);
  });

  it.each([
    '',
    ' ',
    ';',
    'w out',
    'p;w out',
    'e ls',
    'r f',
    'R f',
    'W f',
    'F',
    '}',
    '{p}',
    '#x',
    'y/a/b/',
    'a text',
    'i text',
    'c text',
    'l',
    'n',
    'N',
    'x',
    '!p',
    '1!p',
    '1~2p',
    '1 p',
    '1,p',
    '1,+p',
    '1,~3p',
    '/a p',
    '/a/Ip',
    's|a|b|',
    's,a,b,',
    's/a/b',
    's/a',
    's/a/b/w out',
    's/a/b/e',
    's/a/b/m',
    's/a/b/ w out',
    's/a/b/p w',
    's/a/b/g;w out',
    'p p',
    'pp',
    'p\\',
    's/a\\',
    '=x',
    'p;;p',
    '/a/;p',
    's/[/]/;p;s/w../../g',
    's/[/]/;s/e;p/z/g',
    's/[abc/x/',
    's/[[:alpha]/x/',
    's/a/[/]/',
    's/[]/x/',
    's/[^]/x/',
    's/[[.a]/x/',
    '/[/p',
    's/[a\\]/]/w out',
  ])('%j is refused', (script) => {
    expect(isPrintOnlySedScript(script)).toBe(false);
  });

  it.each([
    ["sed 'w out' f", 'sed-script'],
    ["sed 'e ls'", 'sed-script'],
    ["sed 's/a/b/w out' f", 'sed-script'],
    ["sed -n '1p;w out' f", 'sed-script'],
    ["sed -n '1p 2p' f", 'sed-script'],
    ["sed ''", 'sed-script'],
    ["sed 's/[/]/;p;s/w../../g' f", 'sed-script'],
    ["sed -n 's/[/]/;s/e;p/z/g' f", 'sed-script'],
  ])('%s gives %s', (line, code) => {
    expect(reasonOf(line)).toMatch(new RegExp(`^${code}`));
  });
});

describe('lexicalPathReason', () => {
  it.each<[string, 'path' | 'gitArg', NodeJS.Platform, string | undefined]>([
    ['/dev/null', 'path', 'linux', undefined],
    ['/dev/null', 'gitArg', 'linux', undefined],
    ['src/a.ts', 'path', 'linux', undefined],
    ['/abs/x', 'path', 'linux', undefined],
    ['a..b', 'path', 'linux', undefined],
    ['...', 'path', 'linux', undefined],
    ['a\\..\\b', 'path', 'linux', undefined],
    ['', 'path', 'linux', 'path-form'],
    ['-', 'path', 'linux', 'path-form'],
    ['~', 'path', 'linux', 'path-form'],
    ['~x', 'path', 'linux', 'path-form'],
    ['//x', 'path', 'linux', 'path-form'],
    ['\\\\x', 'path', 'linux', 'path-form'],
    ['../x', 'path', 'linux', 'path-form'],
    ['a/../x', 'path', 'linux', 'path-form'],
    ['a/..', 'path', 'linux', 'path-form'],
    ['a\\..\\b', 'path', 'win32', 'path-form'],
    ['C:/a/b', 'path', 'win32', undefined],
    ['C:\\a\\b', 'path', 'win32', undefined],
    ['C:/a:b', 'path', 'win32', 'path-form'],
    ['a:b', 'path', 'win32', 'path-form'],
    ['a\\\\b', 'path', 'win32', 'path-form'],
    ['/dev/null', 'path', 'win32', undefined],
    ['HEAD:src/a.ts', 'gitArg', 'linux', undefined],
    ['HEAD@{1}', 'gitArg', 'linux', undefined],
    ['main..HEAD', 'gitArg', 'linux', undefined],
    ['a...b', 'gitArg', 'linux', undefined],
    ['HEAD:../x', 'gitArg', 'linux', 'path-form'],
    ['HEAD:a/../x', 'gitArg', 'linux', 'path-form'],
    ['../x', 'gitArg', 'linux', 'path-form'],
    [':/', 'gitArg', 'linux', undefined],
    [':/', 'gitArg', 'win32', 'path-form'],
    ['HEAD:/x', 'gitArg', 'win32', 'path-form'],
    ['HEAD:\\x', 'gitArg', 'win32', 'path-form'],
    ['HEAD:src/a.ts', 'gitArg', 'win32', undefined],
    ['/dev/null', 'gitArg', 'win32', undefined],
    ['CON', 'path', 'win32', 'path-form'],
    ['con', 'path', 'win32', 'path-form'],
    ['src/nul.txt', 'path', 'win32', 'path-form'],
    ['a\\Com1', 'path', 'win32', 'path-form'],
    ['C:/x/LPT9.log', 'path', 'win32', 'path-form'],
    ['aux', 'path', 'win32', 'path-form'],
    ['PRN.', 'path', 'win32', 'path-form'],
    ['HEAD:src/prn', 'gitArg', 'win32', 'path-form'],
    ['HEAD:CON', 'gitArg', 'win32', 'path-form'],
    ['src/Aux.c', 'gitArg', 'win32', 'path-form'],
    ['CON', 'path', 'linux', undefined],
    ['src/nul.txt', 'path', 'linux', undefined],
    ['console', 'path', 'win32', undefined],
    ['nulx.txt', 'path', 'win32', undefined],
    ['com0', 'path', 'win32', undefined],
    ['src/con/a.ts', 'path', 'win32', undefined],
    ['null', 'path', 'win32', undefined],
  ])('%j as %s on %s', (word, kind, platform, expected) => {
    const reason = lexicalPathReason(word, kind, platform);
    if (expected === undefined) expect(reason).toBeUndefined();
    else expect(reason).toMatch(new RegExp(`^${expected}`));
  });
});
