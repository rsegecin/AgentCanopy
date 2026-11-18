import type { PathKind, PathRef } from './paths';
import { lexicalPathReason } from './paths';
import { isPrintOnlySedScript } from './sed';
import type { Word } from './tokenize';

/**
 * An option parser driven by one spec per command. A spec is a list of what the command may do:
 * anything not on it is refused, because GNU tools and git accept abbreviated long options
 * (`sort --co=sh` runs a program) and a list of forbidden options can never be complete.
 */

/** What a value may look like. `text` is only for values the program never opens as a file. */
export type ValueKind =
  | { type: 'number'; pattern?: RegExp }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'regex'; pattern: RegExp }
  | { type: 'text'; maxLength?: number; reject?: RegExp }
  | { type: 'path' }
  | { type: 'gitArg' };

export interface ValueOption {
  short?: string;
  /** The long name, without the dashes. */
  long?: string;
  value: ValueKind;
  /** The value may be left out. It is then only ever given attached: `-Idate`, `--color=never`. */
  optional?: boolean;
  /** A long option whose value may be the next word (`--max-depth 2`). Otherwise only `=`. */
  separate?: boolean;
  /**
   * BSD (macOS) grep takes the value of this short option only attached: `-C3`. In `-C 3 x f` it
   * would take `3` as the pattern and `x` as a file. On darwin only the attached form passes.
   */
  bsdAttachedOnly?: boolean;
}

export interface Operands {
  kind: 'path' | 'gitArg' | 'text';
  min?: number;
  max?: number;
  /** Operands are allowed only when one of these options was given (`git branch -l pattern`). */
  onlyWith?: readonly string[];
  /**
   * The first operand is a text pattern, unless one of these options was given: then every operand
   * is of `kind`. The patterns of grep and rg are never files.
   */
  pattern?: readonly string[];
  /**
   * An operand may not be a directory. `diff dirA dirB` compares same-named entries and follows
   * a symlink among them to a file outside the folder, which no path check of the operands sees.
   */
  notDirectory?: boolean;
  /** The first operand is a sed script. Needs `pattern`. */
  script?: boolean;
  /** Every text operand must match. */
  textMatch?: RegExp;
}

export interface CommandSpec {
  /** Short flag letters that take no value. */
  flags: string;
  /** Long flags, without the dashes, that take no value. */
  longFlags: readonly string[];
  values: readonly ValueOption[];
  operands: Operands;
  /** Accept `-NUM`: a dash and digits only. */
  numericShort?: boolean;
  /** Default true. `uniq` refuses `--` because its second operand is an output file. */
  dashDashEnds?: boolean;
  /** Default true. Whether `-n5` may carry its value; never for path kinds. */
  attachedValues?: boolean;
  /** Every word is an operand (printf). */
  noOptions?: boolean;
  /** The long options (without dashes) whose value may hold unquoted glob characters. */
  globOptions?: readonly string[];
}

export type Parsed =
  | { ok: true; refs: PathRef[]; seen: ReadonlySet<string>; operands: readonly string[] }
  | { ok: false; reason: string };

export const NUMBER = /^[+-]?\d{1,9}$/;

function words(list: string): string[] {
  return list === '' ? [] : list.split(' ');
}

const NONE: Operands = { kind: 'text', max: 0 };
const PATHS: Operands = { kind: 'path' };
const number: ValueKind = { type: 'number' };
const text: ValueKind = { type: 'text' };
const path: ValueKind = { type: 'path' };
const enumOf = (list: string): ValueKind => ({ type: 'enum', values: words(list) });

function spec(
  flags: string,
  longFlags: string,
  values: readonly ValueOption[],
  operands: Operands,
  extra: Partial<CommandSpec> = {},
): CommandSpec {
  return { flags, longFlags: words(longFlags), values, operands, ...extra };
}

const GREP = spec(
  'abcEFGhHiIlLnoPqrsTvwxzZ',
  'text byte-offset count extended-regexp fixed-strings basic-regexp no-filename with-filename ' +
    'ignore-case files-with-matches files-without-match line-number only-matching perl-regexp ' +
    'quiet silent recursive no-messages initial-tab invert-match word-regexp line-regexp ' +
    'null-data null',
  [
    { short: 'A', long: 'after-context', value: number },
    { short: 'B', long: 'before-context', value: number },
    { short: 'C', long: 'context', value: number, bsdAttachedOnly: true },
    { short: 'm', long: 'max-count', value: number },
    { short: 'e', long: 'regexp', value: text },
    { long: 'include', value: text },
    { long: 'exclude', value: text },
    { long: 'exclude-dir', value: text },
    { long: 'color', value: enumOf('always never auto'), optional: true },
    { long: 'colour', value: enumOf('always never auto'), optional: true },
    { long: 'binary-files', value: enumOf('binary text without-match') },
  ],
  { kind: 'path', pattern: ['-e', '--regexp'] },
  { numericShort: true, globOptions: ['include', 'exclude', 'exclude-dir'] },
);

const RG = spec(
  'acFHiIlnNopqsSuUvwx0.',
  'count count-matches fixed-strings with-filename no-filename ignore-case smart-case ' +
    'case-sensitive files files-with-matches files-without-match line-number no-line-number ' +
    'only-matching hidden no-ignore no-ignore-vcs no-ignore-parent no-ignore-dot invert-match ' +
    'word-regexp line-regexp null no-heading heading column vimgrep json trim multiline quiet ' +
    'text pretty no-messages stats unrestricted one-file-system passthru no-config',
  [
    { short: 'A', long: 'after-context', value: number },
    { short: 'B', long: 'before-context', value: number },
    { short: 'C', long: 'context', value: number },
    { short: 'm', long: 'max-count', value: number },
    { short: 'd', long: 'max-depth', value: number },
    { short: 'M', long: 'max-columns', value: number },
    { short: 'j', long: 'threads', value: number },
    { short: 'e', long: 'regexp', value: text },
    { short: 'g', long: 'glob', value: text },
    { long: 'iglob', value: text },
    { short: 't', long: 'type', value: { type: 'regex', pattern: /^[A-Za-z0-9_-]+$/ } },
    { short: 'T', long: 'type-not', value: { type: 'regex', pattern: /^[A-Za-z0-9_-]+$/ } },
    { long: 'sort', value: enumOf('none path modified accessed created') },
    { long: 'sortr', value: enumOf('none path modified accessed created') },
    { long: 'color', value: enumOf('never auto always ansi') },
    { short: 'r', long: 'replace', value: text },
  ],
  { kind: 'path', pattern: ['-e', '--regexp', '--files'] },
  { globOptions: ['glob', 'iglob'] },
);

const SPECS: ReadonlyMap<string, CommandSpec> = new Map<string, CommandSpec>([
  [
    'ls',
    spec(
      'aAbBcCdfFgGhiklmnNopqQrRsStuUvxX1',
      'all almost-all directory classify human-readable si inode numeric-uid-gid recursive ' +
        'reverse size group-directories-first full-time literal',
      [
        { long: 'color', value: enumOf('always never auto'), optional: true },
        { long: 'sort', value: enumOf('none size time version extension') },
        {
          long: 'format',
          value: enumOf('across commas horizontal long single-column verbose vertical'),
        },
        { long: 'time-style', value: text },
        // Long forms only: `-I` and `-w` are flags in BSD ls, so their value would be a file there.
        { long: 'ignore', value: text },
        { long: 'width', value: number },
      ],
      PATHS,
    ),
  ],
  [
    'cat',
    spec(
      'AbeEnstTuv',
      'number number-nonblank squeeze-blank show-all show-ends show-tabs show-nonprinting',
      [],
      PATHS,
    ),
  ],
  [
    'head',
    spec(
      'qv',
      'quiet silent verbose',
      [
        { short: 'n', long: 'lines', value: number },
        { short: 'c', long: 'bytes', value: number },
      ],
      PATHS,
      { numericShort: true },
    ),
  ],
  [
    'tail',
    spec(
      'qv',
      'quiet silent verbose',
      [
        { short: 'n', long: 'lines', value: number },
        { short: 'c', long: 'bytes', value: number },
      ],
      PATHS,
      { numericShort: true },
    ),
  ],
  ['wc', spec('clmwL', 'bytes lines chars words max-line-length', [], PATHS)],
  [
    'nl',
    spec(
      '',
      '',
      [
        { short: 'b', long: 'body-numbering', value: enumOf('a t n') },
        { short: 'n', long: 'number-format', value: enumOf('ln rn rz') },
        { short: 'w', long: 'number-width', value: number },
        { short: 'v', long: 'starting-line-number', value: number },
        { short: 'i', long: 'line-increment', value: number },
        { short: 's', long: 'number-separator', value: text },
      ],
      PATHS,
    ),
  ],
  [
    'stat',
    spec(
      'Lft',
      'dereference file-system terse',
      [
        { short: 'c', long: 'format', value: text },
        { long: 'printf', value: text },
      ],
      PATHS,
    ),
  ],
  [
    'file',
    spec(
      'biLhk',
      'brief mime mime-type mime-encoding dereference no-dereference keep-going',
      [],
      PATHS,
    ),
  ],
  [
    'du',
    spec(
      'abchkmsx0',
      'all apparent-size bytes total human-readable summarize one-file-system null si',
      [
        { short: 'd', long: 'max-depth', value: number },
        { short: 't', long: 'threshold', value: { type: 'regex', pattern: /^[+-]?\d+[KMGTPE]?$/ } },
      ],
      PATHS,
    ),
  ],
  [
    'df',
    spec('ahHiklPT', 'all human-readable si inodes local portability print-type total', [], PATHS),
  ],
  [
    'cut',
    spec(
      'sz',
      'only-delimited complement zero-terminated',
      [
        { short: 'b', long: 'bytes', value: { type: 'regex', pattern: /^[0-9,-]+$/ } },
        { short: 'c', long: 'characters', value: { type: 'regex', pattern: /^[0-9,-]+$/ } },
        { short: 'f', long: 'fields', value: { type: 'regex', pattern: /^[0-9,-]+$/ } },
        { short: 'd', long: 'delimiter', value: { type: 'text', maxLength: 4 } },
        { long: 'output-delimiter', value: text },
      ],
      PATHS,
    ),
  ],
  [
    'tr',
    spec('cCdst', 'complement delete squeeze-repeats truncate-set1', [], {
      kind: 'text',
      min: 1,
      max: 2,
    }),
  ],
  [
    'diff',
    spec(
      'abBcdiNpqstTuwy',
      'text ignore-space-change ignore-blank-lines ignore-case new-file show-c-function brief ' +
        'report-identical-files expand-tabs initial-tab ignore-all-space side-by-side ' +
        'suppress-common-lines strip-trailing-cr minimal left-column',
      [
        { short: 'U', long: 'unified', value: number },
        { short: 'C', long: 'context', value: number },
        { short: 'W', long: 'width', value: number },
        { long: 'color', value: enumOf('never always auto'), optional: true },
      ],
      { kind: 'path', min: 2, max: 2, notDirectory: true },
    ),
  ],
  [
    'cmp',
    spec(
      'bls',
      'print-bytes verbose quiet silent',
      [
        { short: 'n', long: 'bytes', value: number },
        { short: 'i', long: 'ignore-initial', value: { type: 'regex', pattern: /^\d+(:\d+)?$/ } },
      ],
      { kind: 'path', min: 2, max: 2 },
    ),
  ],
  [
    'sort',
    spec(
      'bcCdfghimMnrRsuVz',
      'ignore-leading-blanks dictionary-order ignore-case general-numeric-sort ' +
        'human-numeric-sort ignore-nonprinting month-sort numeric-sort random-sort reverse stable ' +
        'unique version-sort zero-terminated merge',
      [
        { long: 'check', value: enumOf('diagnose-first quiet silent'), optional: true },
        { short: 'k', long: 'key', value: { type: 'regex', pattern: /^[0-9.,a-zA-Z]+$/ } },
        { short: 't', long: 'field-separator', value: { type: 'text', maxLength: 4 } },
      ],
      PATHS,
    ),
  ],
  [
    'uniq',
    spec(
      'cdDiuz',
      'count repeated ignore-case unique zero-terminated',
      [
        { short: 'f', long: 'skip-fields', value: number },
        { short: 's', long: 'skip-chars', value: number },
        { short: 'w', long: 'check-chars', value: number },
      ],
      { kind: 'path', max: 1 },
      { dashDashEnds: false },
    ),
  ],
  ['grep', GREP],
  ['egrep', GREP],
  ['fgrep', GREP],
  ['rg', RG],
  [
    'sed',
    spec('nEruzs', 'quiet silent regexp-extended unbuffered null-data separate', [], {
      kind: 'path',
      pattern: [],
      script: true,
    }),
  ],
  ['echo', spec('neE', '', [], { kind: 'text' })],
  ['printf', spec('', '', [], { kind: 'text', min: 1 }, { noOptions: true })],
  ['pwd', spec('LP', '', [], NONE)],
  // Command names only: `which ../x/y` would test for a file outside the folder.
  ['which', spec('a', '', [], { kind: 'text', textMatch: /^[A-Za-z0-9._+-]+$/ })],
  ['whoami', spec('', '', [], NONE)],
  [
    'uname',
    spec(
      'asnrvmpio',
      'all kernel-name nodename kernel-release kernel-version machine processor ' +
        'hardware-platform operating-system',
      [],
      NONE,
    ),
  ],
  [
    'date',
    spec(
      'uR',
      'utc universal rfc-email',
      [
        {
          short: 'I',
          long: 'iso-8601',
          value: enumOf('date hours minutes seconds ns'),
          optional: true,
        },
      ],
      { kind: 'text', max: 1, textMatch: /^\+/ },
    ),
  ],
  [
    'basename',
    spec('az', 'multiple zero', [{ short: 's', long: 'suffix', value: text }], {
      kind: 'text',
      min: 1,
    }),
  ],
  ['dirname', spec('z', 'zero', [], { kind: 'text', min: 1 })],
  [
    'realpath',
    spec(
      'emLPqsz',
      'canonicalize-existing canonicalize-missing logical physical quiet strip no-symlinks zero',
      [
        { long: 'relative-to', value: path },
        { long: 'relative-base', value: path },
      ],
      PATHS,
    ),
  ],
]);

function refuse(reason: string): Parsed {
  return { ok: false, reason };
}

/** The state of one parse: the words not yet read, and what has been collected. */
class Run {
  readonly refs: PathRef[] = [];
  readonly seen = new Set<string>();
  readonly operands: Word[] = [];
  private index = 0;
  private afterDashDash = false;
  private firstOperandAt: number | undefined;

  constructor(
    private readonly spec: CommandSpec,
    private readonly input: readonly Word[],
    private readonly platform: NodeJS.Platform,
  ) {}

  /** Returns the reason it refused, or undefined. */
  go(): string | undefined {
    // Unquoted glob characters are expanded by the shell into words that were never checked.
    if (this.input.some((word) => word.globs.length > 0 && !this.isGlobOption(word))) return 'glob';
    for (;;) {
      const word = this.input[this.index];
      if (word === undefined) return this.finishOperands();
      this.index += 1;
      const reason = this.word(word);
      if (reason !== undefined) return reason;
    }
  }

  private word(word: Word): string | undefined {
    const isOption =
      !this.spec.noOptions && !this.afterDashDash && word.text.startsWith('-') && word.text !== '-';
    if (!isOption) {
      if (word.globs.length > 0) return 'glob';
      this.firstOperandAt ??= this.index - 1;
      this.operands.push(word);
      return undefined;
    }
    if (word.text === '--') return this.dashDash();
    if (word.text.startsWith('--')) return this.longOption(word.text);
    return this.shortWord(word.text);
  }

  /**
   * `--include=*.ts`: the shell expands the star into other words that begin with the same
   * `--include=`, so the name must be unquoted and the glob characters only in the value. Each
   * expansion is then the same option with another value, and the value is text.
   */
  private isGlobOption(word: Word): boolean {
    const equals = word.text.indexOf('=');
    if (!word.text.startsWith('--') || equals === -1) return false;
    if (!this.spec.globOptions?.includes(word.text.slice(2, equals))) return false;
    return word.unquotedPrefix > equals && word.globs.every((position) => position > equals);
  }

  private dashDash(): string | undefined {
    if (this.spec.dashDashEnds === false) return 'option-not-allowed:--';
    this.afterDashDash = true;
    return undefined;
  }

  private longOption(text: string): string | undefined {
    const equals = text.indexOf('=');
    const name = text.slice(2, equals === -1 ? undefined : equals);
    let value = equals === -1 ? undefined : text.slice(equals + 1);
    if (this.spec.longFlags.includes(name)) {
      if (value !== undefined) return `option-not-allowed:--${name} takes no value`;
      this.seen.add(`--${name}`);
      return undefined;
    }
    const option = this.spec.values.find((candidate) => candidate.long === name);
    if (option === undefined) return `option-not-allowed:--${name}`;
    this.seen.add(`--${name}`);
    if (value === undefined) {
      if (option.optional) return undefined;
      if (!option.separate) return `missing-value:--${name}`;
      value = this.nextValue();
      if (value === undefined) return `missing-value:--${name}`;
    }
    return this.checkValue(option.value, value, `--${name}`);
  }

  private shortWord(text: string): string | undefined {
    const letters = text.slice(1);
    if (this.spec.numericShort && /^\d{1,9}$/.test(letters)) {
      this.seen.add('-NUM');
      return undefined;
    }
    for (let i = 0; i < letters.length; i += 1) {
      const letter = letters[i] ?? '';
      if (this.spec.flags.includes(letter)) {
        this.seen.add(`-${letter}`);
        continue;
      }
      const option = this.spec.values.find((candidate) => candidate.short === letter);
      if (option === undefined) return `option-not-allowed:-${letter}`;
      this.seen.add(`-${letter}`);
      return this.shortValue(option, letter, letters.slice(i + 1));
    }
    return undefined;
  }

  /** The value of a short option is the rest of the word, or else the next word (getopt). */
  private shortValue(option: ValueOption, letter: string, rest: string): string | undefined {
    let value: string | undefined = rest;
    if (rest !== '') {
      const attachable =
        this.spec.attachedValues !== false &&
        option.value.type !== 'path' &&
        option.value.type !== 'gitArg';
      if (!attachable) return `option-not-allowed:-${letter} needs a separate value`;
    } else if (option.optional) {
      return undefined;
    } else {
      if (option.bsdAttachedOnly === true && this.platform === 'darwin') {
        return `option-not-allowed:-${letter} needs an attached value on macOS`;
      }
      value = this.nextValue();
      if (value === undefined) return `missing-value:-${letter}`;
    }
    return this.checkValue(option.value, value, `-${letter}`);
  }

  /** The next word as an option value; undefined at the end. */
  private nextValue(): string | undefined {
    const word = this.input[this.index];
    if (word === undefined) return undefined;
    this.index += 1;
    return word.text;
  }

  private checkValue(kind: ValueKind, value: string, label: string): string | undefined {
    const bad = `value-not-allowed:${label}`;
    switch (kind.type) {
      case 'number':
        return (kind.pattern ?? NUMBER).test(value) ? undefined : bad;
      case 'enum':
        return kind.values.includes(value) ? undefined : bad;
      case 'regex':
        return kind.pattern.test(value) ? undefined : bad;
      case 'text':
        if (kind.maxLength !== undefined && value.length > kind.maxLength) return bad;
        return kind.reject?.test(value) ? bad : undefined;
      case 'path':
      case 'gitArg':
        return this.addRef(value, kind.type);
    }
  }

  private addRef(word: string, kind: PathKind, notDirectory = false): string | undefined {
    const reason = lexicalPathReason(word, kind, this.platform);
    if (reason !== undefined) return reason;
    this.refs.push(notDirectory ? { word, kind, notDirectory } : { word, kind });
    return undefined;
  }

  /**
   * BSD getopt (macOS), and GNU with POSIXLY_CORRECT, do not permute: after the first operand every
   * later word is an operand. `cat README.md -n` then opens a file named `-n`, which may be a symlink
   * to the outside. So for commands that take files, each word after the first operand is also
   * path-checked, whether it is an option, an option's value, or `--name=value`.
   */
  private laterWordsReason(): string | undefined {
    if (this.spec.operands.kind !== 'path' || this.firstOperandAt === undefined) return undefined;
    for (const word of this.input.slice(this.firstOperandAt + 1)) {
      if (this.refs.some((ref) => ref.word === word.text && ref.kind === 'path')) continue;
      const reason = this.addRef(word.text, 'path');
      if (reason !== undefined) return reason;
    }
    return undefined;
  }

  private finishOperands(): string | undefined {
    const rule = this.spec.operands;
    let rest = this.operands.map((word) => word.text);
    if (rule.onlyWith !== undefined && rest.length > 0) {
      if (!rule.onlyWith.some((option) => this.seen.has(option))) {
        return 'operand-not-allowed';
      }
    }
    if (rule.pattern !== undefined && !rule.pattern.some((option) => this.seen.has(option))) {
      const first = rest[0];
      if (first === undefined) return 'missing-value:pattern';
      if (rule.script === true && !isPrintOnlySedScript(first)) return 'sed-script';
      rest = rest.slice(1);
    }
    if (rest.length < (rule.min ?? 0)) return 'missing-value:operand';
    if (rest.length > (rule.max ?? Infinity)) return 'operand-not-allowed:too many';
    for (const operand of rest) {
      const reason = this.checkOperand(rule, operand);
      if (reason !== undefined) return reason;
    }
    return this.laterWordsReason();
  }

  private checkOperand(rule: Operands, operand: string): string | undefined {
    if (rule.kind !== 'text') return this.addRef(operand, rule.kind, rule.notDirectory);
    if (rule.textMatch !== undefined && !rule.textMatch.test(operand)) {
      return 'operand-not-allowed:format';
    }
    return undefined;
  }
}

/** Parses the words after the command name against a spec. */
export function parseWithSpec(
  commandSpec: CommandSpec,
  args: readonly Word[],
  platform: NodeJS.Platform,
): Parsed {
  const run = new Run(commandSpec, args, platform);
  const reason = run.go();
  if (reason !== undefined) return refuse(reason);
  return { ok: true, refs: run.refs, seen: run.seen, operands: run.operands.map((w) => w.text) };
}

/** Checks one simple command that is not git: its name, then the rest against the spec. */
export function parseSimpleCommand(
  name: string,
  args: readonly Word[],
  platform: NodeJS.Platform,
): Parsed {
  if (name === 'find') return parseFind(args, platform);
  const commandSpec = SPECS.get(name);
  if (commandSpec === undefined) return refuse(`unknown-command:${name}`);
  if (commandSpec.noOptions) return parsePrintf(commandSpec, args, platform);
  return parseWithSpec(commandSpec, args, platform);
}

/**
 * `printf -v name` assigns a shell variable, and so does the conversion `%n` (bash 5): a name such
 * as `a[$(cmd)]`, which is harmless text in single quotes, would then run `cmd`. So: no options, and
 * no `%n` in the format (with any flags, width or length modifier before the `n`).
 */
const PRINTF_ASSIGNS = /%[^a-zA-Z%\\]*[hlLjzt]*n/;

function parsePrintf(
  commandSpec: CommandSpec,
  args: readonly Word[],
  platform: NodeJS.Platform,
): Parsed {
  const format = args[0]?.text ?? '';
  if (format.startsWith('-')) return refuse('option-not-allowed:printf takes no options');
  if (PRINTF_ASSIGNS.test(format)) return refuse('value-not-allowed:printf format with %n');
  return parseWithSpec(commandSpec, args, platform);
}

// ---------------------------------------------------------------------------------------------
// find

const FIND_FLAGS = new Set(
  words(
    '-print -print0 -prune -quit -ls -empty -readable -writable -executable -true -false -o -or ' +
      '-a -and -not -depth -mount -xdev -noleaf -nouser -nogroup -daystart',
  ),
);

const FIND_TEXT = words(
  '-name -iname -path -ipath -wholename -iwholename -regex -iregex -lname -ilname -printf -user ' +
    '-group -perm',
);
const FIND_NUMBER = words('-maxdepth -mindepth -links -inum -uid -gid');
const FIND_COUNT = words('-mtime -atime -ctime -mmin -amin -cmin');
const FIND_PATH = words('-newer -anewer -cnewer -samefile');

const FIND_VALUES: ReadonlyMap<string, ValueKind> = new Map<string, ValueKind>([
  ...FIND_TEXT.map((name): [string, ValueKind] => [name, text]),
  ...FIND_NUMBER.map((name): [string, ValueKind] => [name, number]),
  ...FIND_COUNT.map((name): [string, ValueKind] => [
    name,
    { type: 'regex', pattern: /^[+-]?\d{1,9}$/ },
  ]),
  ...FIND_PATH.map((name): [string, ValueKind] => [name, path]),
  ['-size', { type: 'regex', pattern: /^[+-]?\d{1,9}[cwbkMG]?$/ }],
  ['-type', { type: 'regex', pattern: /^[bcdpflsD](,[bcdpflsD])*$/ }],
  ['-xtype', { type: 'regex', pattern: /^[bcdpflsD](,[bcdpflsD])*$/ }],
  ['-regextype', enumOf('emacs posix-awk posix-basic posix-egrep posix-extended')],
]);

/**
 * `find [-P] [path...] [expression]`. Every expression word must be a listed primary. `-exec`,
 * `-delete`, `-fprint*`, `-fls`, `-files0-from` and the options that follow links are not listed.
 */
function parseFind(args: readonly Word[], platform: NodeJS.Platform): Parsed {
  const refs: PathRef[] = [];
  let index = 0;
  if (args[0]?.text === '-P') index = 1;
  else if (/^-[HLDO]/.test(args[0]?.text ?? '')) {
    return refuse(`option-not-allowed:${args[0]?.text}`);
  }
  for (; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined || word.text.startsWith('-')) break;
    if (word.globs.length > 0) return refuse('glob');
    const reason = lexicalPathReason(word.text, 'path', platform);
    if (reason !== undefined) return refuse(reason);
    refs.push({ word: word.text, kind: 'path' });
  }
  for (; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    if (word.globs.length > 0) return refuse('glob');
    if (FIND_FLAGS.has(word.text)) continue;
    const kind = FIND_VALUES.get(word.text);
    if (kind === undefined) return refuse(`find-expression:${word.text}`);
    index += 1;
    const argument = args[index];
    if (argument === undefined) return refuse(`missing-value:${word.text}`);
    if (argument.globs.length > 0) return refuse('glob');
    const reason = findArgument(kind, argument.text, word.text, platform, refs);
    if (reason !== undefined) return refuse(reason);
  }
  return { ok: true, refs, seen: new Set(), operands: [] };
}

function findArgument(
  kind: ValueKind,
  value: string,
  primary: string,
  platform: NodeJS.Platform,
  refs: PathRef[],
): string | undefined {
  const bad = `value-not-allowed:${primary}`;
  switch (kind.type) {
    case 'number':
      return NUMBER.test(value) ? undefined : bad;
    case 'enum':
      return kind.values.includes(value) ? undefined : bad;
    case 'regex':
      return kind.pattern.test(value) ? undefined : bad;
    case 'path':
    case 'gitArg': {
      const reason = lexicalPathReason(value, 'path', platform);
      if (reason === undefined) refs.push({ word: value, kind: 'path' });
      return reason;
    }
    case 'text':
      return undefined;
  }
}
