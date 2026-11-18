import { describe, expect, it } from 'vitest';
import { MAX_COMMANDS, MAX_LENGTH, MAX_WORDS, tokenize } from './tokenize';

/** The texts of the words of each simple command, or the reason. */
function texts(input: string): string[][] | string {
  const result = tokenize(input);
  return result.ok
    ? result.commands.map((command) => command.words.map((w) => w.text))
    : result.reason;
}

function refusal(input: string): string {
  const result = tokenize(input);
  if (result.ok) throw new Error(`accepted: ${JSON.stringify(input)}`);
  return result.reason;
}

describe('tokenize: accepted', () => {
  it.each<[string, string[][]]>([
    ['ls', [['ls']]],
    ['ls -la src', [['ls', '-la', 'src']]],
    ['  ls   -l  ', [['ls', '-l']]],
    ['ls\t-l', [['ls', '-l']]],
    ['grep -n "a\\|b" src/a.ts', [['grep', '-n', 'a\\|b', 'src/a.ts']]],
    ['echo "a\\"b" "a\\\\b" "a\\xb"', [['echo', 'a"b', 'a\\b', 'a\\xb']]],
    ["echo 'a b' c", [['echo', 'a b', 'c']]],
    ['echo a\'b c\'"d e"f', [['echo', 'ab cd ef']]],
    ["echo ''", [['echo', '']]],
    ["echo '$x `y` \\ ( ) ! # > <'", [['echo', '$x `y` \\ ( ) ! # > <']]],
    ['echo "a b" \'\'"x"', [['echo', 'a b', 'x']]],
    [
      'git log HEAD~1 HEAD^~2 a_b-c.d,e+f%g:h@i',
      [['git', 'log', 'HEAD~1', 'HEAD^~2', 'a_b-c.d,e+f%g:h@i']],
    ],
    [
      'git log @{u}..HEAD HEAD@{1} stash@{0} @{-1}',
      [['git', 'log', '@{u}..HEAD', 'HEAD@{1}', 'stash@{0}', '@{-1}']],
    ],
    ['ls && pwd || date ; ls | wc', [['ls'], ['pwd'], ['date'], ['ls'], ['wc']]],
    ['ls&&pwd', [['ls'], ['pwd']]],
    ['ls;pwd', [['ls'], ['pwd']]],
    ['ls|wc', [['ls'], ['wc']]],
    ['ls 2>/dev/null | head', [['ls'], ['head']]],
    ['ls >/dev/null', [['ls']]],
    ['ls > /dev/null', [['ls']]],
    ['ls >\t/dev/null', [['ls']]],
    ['ls 1>/dev/null', [['ls']]],
    ['ls &>/dev/null', [['ls']]],
    ['ls 2>&1', [['ls']]],
    ['echo x >&2', [['echo', 'x']]],
    ['ls 2>&1 | head', [['ls'], ['head']]],
    ['ls 2>&1|head', [['ls'], ['head']]],
    ['ls >/dev/null;pwd', [['ls'], ['pwd']]],
    ['ls >/dev/null x', [['ls', 'x']]],
    ['2>/dev/null ls', [['ls']]],
    ['ls | >/dev/null cat', [['ls'], ['cat']]],
    ['cat 2x', [['cat', '2x']]],
    ['cat 12 1 2', [['cat', '12', '1', '2']]],
    ['cat a=b', [['cat', 'a=b']]],
    ["cat '=ssh'", [['cat', '=ssh']]],
    ['cat \'é\' "\u{A0}"', [['cat', 'é', '\u{A0}']]],
  ])('%j', (input, expected) => {
    expect(texts(input)).toEqual(expected);
  });

  it('keeps the separator that follows each command', () => {
    const result = tokenize('ls && pwd || date ; ls | wc');
    expect(result.ok && result.commands.map((c) => c.separator)).toEqual([
      '&&',
      '||',
      ';',
      '|',
      undefined,
    ]);
  });

  it('records the unquoted glob characters and where they are', () => {
    const result = tokenize("cat *.ts 'a*' a?[b]");
    if (!result.ok) throw new Error(result.reason);
    const [, star, quoted, mixed] = result.commands[0]?.words ?? [];
    expect(star?.globs).toEqual([0]);
    expect(quoted?.globs).toEqual([]);
    expect(mixed?.globs).toEqual([1, 2, 4]);
  });

  it('records how much of a word is unquoted at its start', () => {
    const result = tokenize("grep --in'clude'=x --include=a 'x'y");
    if (!result.ok) throw new Error(result.reason);
    const words = result.commands[0]?.words ?? [];
    expect(words.map((w) => [w.unquotedPrefix, w.quoted])).toEqual([
      [4, false],
      [4, true],
      [11, false],
      [0, true],
    ]);
  });

  it('accepts the limits exactly', () => {
    const longest = `ls ${'a'.repeat(MAX_LENGTH - 3)}`;
    expect(longest.length).toBe(MAX_LENGTH);
    expect(tokenize(longest).ok).toBe(true);
    expect(tokenize(`ls${' a'.repeat(MAX_WORDS - 1)}`).ok).toBe(true);
    expect(tokenize(Array(MAX_COMMANDS).fill('ls').join(' | ')).ok).toBe(true);
  });
});

describe('tokenize: refused', () => {
  it.each<[string, string]>([
    ['ls\nls', 'control-character'],
    ['ls\r', 'control-character'],
    ["cat '.\r.'", 'control-character'],
    ['ls\v', 'control-character'],
    ['ls\f', 'control-character'],
    ['ls\0', 'control-character'],
    ['ls\u0085', 'control-character'],
    ['ls \u{200B}', 'control-character'],
    ['ls \u{202E}', 'control-character'],
    ['ls \u{FEFF}', 'control-character'],
    ['ls \u{2028}', 'control-character'],
    ['ls \u{2029}', 'control-character'],
    ['ls \uD800', 'control-character'],
    ["echo 'a\tb'", 'control-character'],
    ['echo "a\tb"', 'control-character'],
    ['echo "a\\\tb"', 'control-character'],
    ['a'.repeat(MAX_LENGTH + 1), 'too-long'],
    [`ls${' a'.repeat(MAX_WORDS)}`, 'too-many-words'],
    [
      Array(MAX_COMMANDS + 1)
        .fill('ls')
        .join(' | '),
      'too-many-commands',
    ],
  ])('%j gives %s', (input, code) => {
    expect(refusal(input)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ['echo $x', 'unquoted-character'],
    ['echo $(id)', 'unquoted-character'],
    ['echo `id`', 'unquoted-character'],
    ['echo (x)', 'unquoted-character'],
    ['echo !x', 'unquoted-character'],
    ['echo a#b', 'unquoted-character'],
    ['echo a\\ b', 'unquoted-character'],
    ['echo a>b', 'unquoted-character'],
    ['cat x2>/dev/null', 'unquoted-character'],
    ['cat x<y', 'unquoted-character'],
    ['echo {a,b}', 'unquoted-character'],
    ['echo a{b}', 'unquoted-character'],
    ['echo @{a.b}', 'unquoted-character'],
    ['echo @{}', 'unquoted-character'],
    ['echo @{a', 'unquoted-character'],
    ['echo x}', 'unquoted-character'],
    ['echo é', 'unquoted-character'],
    ['echo a\u{A0}b', 'unquoted-character'],
    ['echo "$HOME"', 'unquoted-character'],
    ['echo "\\$HOME"', 'unquoted-character'],
    ['echo "a`b"', 'unquoted-character'],
    ['echo "a\\`b"', 'unquoted-character'],
    ["echo 'a", 'unterminated-quote'],
    ['echo "a', 'unterminated-quote'],
    ['echo "a\\', 'unterminated-quote'],
    ['for f in a; do cat $f; done', 'unquoted-character'],
  ])('%j gives %s', (input, code) => {
    expect(refusal(input)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ['ls &', 'separator'],
    ['ls & pwd', 'separator'],
    ['ls |& cat', 'separator'],
    ['ls ;; pwd', 'separator'],
    ['ls && && pwd', 'separator'],
    ['ls ; ; pwd', 'separator'],
    ['&& ls', 'separator'],
    ['; ls', 'separator'],
    ['| ls', 'separator'],
    ['ls &&', 'separator'],
    ['ls |', 'separator'],
    ['ls ;', 'separator'],
    ['', 'separator'],
    ['   ', 'separator'],
    ['>/dev/null', 'separator'],
    ['ls | >/dev/null', 'separator'],
  ])('%j gives %s', (input, code) => {
    expect(refusal(input)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ['cat < x', 'redirection'],
    ['<x cat', 'redirection'],
    ['cat > y', 'redirection'],
    ['cat >y', 'redirection'],
    ['cat 2>y', 'redirection'],
    ['cat >> /dev/null', 'redirection'],
    ['cat >>/dev/null', 'redirection'],
    ['cat >| /dev/null', 'redirection'],
    ['cat &>>/dev/null', 'redirection'],
    ['cat 1>>/dev/null', 'redirection'],
    ['echo x >&2evil', 'redirection'],
    ['echo x 2>&1evil', 'redirection'],
    ['echo x >&1', 'redirection'],
    ['echo x 1>&2', 'redirection'],
    ['echo x 2>&-', 'redirection'],
    ['echo x &>&2', 'redirection'],
    ['ls > /dev/nullx', 'redirection'],
    ['ls > /dev/null/x', 'redirection'],
    ["ls >/dev/null'x'", 'redirection'],
    ["ls > '/dev/null'", 'redirection'],
    ['ls >', 'redirection'],
    ['ls >(cat)', 'redirection'],
  ])('%j gives %s', (input, code) => {
    expect(refusal(input)).toMatch(new RegExp(`^${code}`));
  });

  it.each<[string, string]>([
    ['ls ~/x', 'tilde'],
    ['ls ~', 'tilde'],
    ['ls a=~/x', 'tilde'],
    ['ls a:~', 'tilde'],
    ["ls 'a'~", 'tilde'],
    ['cat =ssh', 'equals-word'],
    ['X=1 ls', 'assignment'],
    ['X= ls', 'assignment'],
    ['ls=1', 'assignment'],
    ["'ls' x", 'unknown-command'],
    ['"ls" x', 'unknown-command'],
    ["l's'", 'unknown-command'],
    ['ls | "wc"', 'unknown-command'],
  ])('%j gives %s', (input, code) => {
    expect(refusal(input)).toMatch(new RegExp(`^${code}`));
  });
});
