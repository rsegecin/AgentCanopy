import type { CommandSpec, Operands, Parsed, ValueKind, ValueOption } from './grammar';
import { parseWithSpec } from './grammar';
import type { Word } from './tokenize';

/**
 * git, as `git [--no-pager] <subcommand> ...` and nothing else before the subcommand: `-c`,
 * `-C`, `--config-env`, `--git-dir`, `--exec-path` and the rest change what git runs or where it
 * looks. Each subcommand has an allowlist, like every other command; `--output`, `--ext-diff`,
 * `--textconv`, `--no-index`, `--contents`, `--batch*`, `-O` and the like are simply not on it.
 */

export const GIT_ENVIRONMENT = [
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
] as const;

function words(list: string): string[] {
  return list === '' ? [] : list.split(' ');
}

const number: ValueKind = { type: 'number' };
const text: ValueKind = { type: 'text' };
const enumOf = (list: string): ValueKind => ({ type: 'enum', values: words(list) });

/** `%G` in a format runs gpg to check a signature. */
const PRETTY: ValueKind = { type: 'text', reject: /%G/ };
/** `%(signature)` and `%(contents:signature)` in a ref format run gpg too. */
const REF_FORMAT: ValueKind = { type: 'text', reject: /signature/i };

const GIT_ARGS: Operands = { kind: 'gitArg' };

function spec(
  flags: string,
  longFlags: string,
  values: readonly ValueOption[],
  operands: Operands = GIT_ARGS,
  extra: Partial<CommandSpec> = {},
): CommandSpec {
  return { flags, longFlags: words(longFlags), values, operands, ...extra };
}

/** Options with a value that log, show and reflog share (reflog uses only a few of them). */
const LOG_VALUES: ValueOption[] = [
  { short: 'n', long: 'max-count', value: number },
  { long: 'skip', value: number },
  { short: 'U', long: 'unified', value: number },
  { long: 'abbrev', value: number },
  { long: 'since', value: text },
  { long: 'until', value: text },
  { long: 'after', value: text },
  { long: 'before', value: text },
  { long: 'author', value: text },
  { long: 'committer', value: text },
  { long: 'grep', value: text },
  { long: 'date', value: text },
  { short: 'S', value: text },
  { short: 'G', value: text },
  { long: 'format', value: PRETTY },
  { long: 'pretty', value: PRETTY },
  { long: 'decorate', value: enumOf('short full auto no'), optional: true },
  { long: 'color', value: enumOf('always never auto'), optional: true },
  { long: 'diff-filter', value: { type: 'regex', pattern: /^[ACDMRTUXBacdmrtuxb*]+$/ } },
];

const LOG = spec(
  'pusiEFmcwbMCz',
  'oneline graph no-decorate all branches tags remotes stat shortstat numstat name-only ' +
    'name-status summary compact-summary patch no-patch abbrev-commit no-abbrev-commit reverse ' +
    'first-parent no-merges merges follow left-right cherry-pick cherry-mark boundary topo-order ' +
    'date-order author-date-order source simplify-by-decoration full-history no-renames no-color ' +
    'relative-date regexp-ignore-case all-match invert-grep cc find-renames find-copies ' +
    'no-ext-diff no-textconv raw minimal patience histogram full-diff use-mailmap',
  LOG_VALUES,
  GIT_ARGS,
  { numericShort: true },
);

/** `branch` and `tag` list with these; the commit given is a name, never a file. */
const LIST_FILTERS: ValueOption[] = [
  { long: 'contains', value: text, optional: true },
  { long: 'no-contains', value: text, optional: true },
  { long: 'merged', value: text, optional: true },
  { long: 'no-merged', value: text, optional: true },
  { long: 'points-at', value: text, separate: true },
  { long: 'sort', value: text },
  { long: 'format', value: REF_FORMAT },
];

const LIST_OPERANDS: Operands = { kind: 'text', onlyWith: ['-l', '--list'] };

const SUBCOMMANDS: ReadonlyMap<string, CommandSpec> = new Map<string, CommandSpec>([
  [
    'status',
    spec(
      'sbvz',
      'short branch long verbose show-stash ahead-behind no-ahead-behind no-column renames ' +
        'no-renames',
      [
        { long: 'ignored', value: enumOf('traditional matching no'), optional: true },
        { long: 'porcelain', value: enumOf('v1 v2'), optional: true },
        { short: 'u', long: 'untracked-files', value: enumOf('no normal all'), optional: true },
        {
          long: 'ignore-submodules',
          value: enumOf('all dirty untracked none'),
          optional: true,
        },
      ],
    ),
  ],
  [
    'diff',
    spec(
      'puwbMCRz',
      'stat shortstat numstat name-only name-status summary compact-summary cached staged patch ' +
        'no-patch minimal patience histogram ignore-all-space ignore-space-change ' +
        'ignore-blank-lines ignore-cr-at-eol find-renames no-renames check exit-code quiet raw ' +
        'no-color merge-base no-ext-diff no-textconv binary',
      [
        { short: 'U', long: 'unified', value: number },
        { long: 'abbrev', value: number },
        { long: 'color', value: enumOf('always never auto'), optional: true },
        { long: 'word-diff', value: enumOf('color plain porcelain none'), optional: true },
        { long: 'diff-filter', value: { type: 'regex', pattern: /^[ACDMRTUXBacdmrtuxb*]+$/ } },
      ],
    ),
  ],
  ['log', LOG],
  ['show', LOG],
  [
    'shortlog',
    spec(
      'sne',
      'summary numbered email all no-merges',
      [
        { long: 'since', value: text },
        { long: 'until', value: text },
        { long: 'author', value: text },
      ],
      GIT_ARGS,
      { numericShort: true },
    ),
  ],
  [
    'rev-list',
    spec(
      '',
      'count all branches tags first-parent no-merges merges reverse left-right left-only ' +
        'right-only cherry-pick abbrev-commit topo-order date-order',
      [
        { short: 'n', long: 'max-count', value: number },
        { long: 'skip', value: number },
        { long: 'since', value: text },
        { long: 'until', value: text },
        { long: 'after', value: text },
        { long: 'before', value: text },
        { long: 'author', value: text },
      ],
      GIT_ARGS,
      { numericShort: true },
    ),
  ],
  [
    'rev-parse',
    spec(
      'q',
      'abbrev-ref verify quiet show-toplevel show-prefix show-cdup git-dir git-common-dir ' +
        'absolute-git-dir is-inside-work-tree is-inside-git-dir is-bare-repository ' +
        'is-shallow-repository symbolic symbolic-full-name all branches tags remotes ' +
        'show-object-format',
      [{ long: 'short', value: number, optional: true }],
    ),
  ],
  [
    'ls-files',
    spec(
      'cdmosutvz',
      'cached deleted modified others stage unmerged directory no-empty-directory ' +
        'exclude-standard full-name error-unmatch',
      [
        { long: 'abbrev', value: number, optional: true },
        { long: 'format', value: text },
      ],
    ),
  ],
  [
    'ls-tree',
    spec('drtlz', 'long name-only name-status object-only full-name full-tree', [
      { long: 'abbrev', value: number, optional: true },
      { long: 'format', value: text },
    ]),
  ],
  [
    'blame',
    spec(
      'ltsewcpnfMC',
      'porcelain line-porcelain root show-stats show-name show-number show-email color-lines ' +
        'color-by-age',
      [
        { short: 'L', value: { type: 'regex', pattern: /^[0-9,+-]+$/ } },
        { long: 'abbrev', value: number },
        { long: 'date', value: text },
      ],
    ),
  ],
  [
    'describe',
    spec('', 'tags all always long exact-match first-parent contains', [
      { long: 'abbrev', value: number },
      { long: 'candidates', value: number },
      { long: 'match', value: text },
      { long: 'exclude', value: text },
    ]),
  ],
  ['cat-file', spec('tspe', '', [], { kind: 'gitArg', min: 1, max: 1 })],
  ['check-ignore', spec('vnq', 'verbose non-matching quiet', [])],
  [
    'branch',
    spec(
      'arvli',
      'list all remotes verbose show-current no-column ignore-case',
      LIST_FILTERS,
      LIST_OPERANDS,
    ),
  ],
  [
    'tag',
    spec(
      'li',
      'list ignore-case no-column',
      [{ short: 'n', value: number, optional: true }, ...LIST_FILTERS],
      LIST_OPERANDS,
    ),
  ],
  [
    'grep',
    spec(
      'nilLcwvEFGPhHIoqz',
      'line-number ignore-case files-with-matches files-without-match count word-regexp ' +
        'invert-match extended-regexp fixed-strings basic-regexp perl-regexp full-name name-only ' +
        'cached untracked heading break column only-matching quiet null all-match',
      [
        { short: 'e', value: text },
        { short: 'A', long: 'after-context', value: number, separate: true },
        { short: 'B', long: 'before-context', value: number, separate: true },
        { short: 'C', long: 'context', value: number, separate: true },
        { short: 'm', long: 'max-count', value: number, separate: true },
        { long: 'max-depth', value: number, separate: true },
        { long: 'color', value: enumOf('always never auto'), optional: true },
      ],
      { kind: 'gitArg', pattern: ['-e'] },
    ),
  ],
]);

/** The rest of `git reflog`: only `show` or an option may follow, then a ref that is not a subcommand. */
const REFLOG = spec(
  '',
  'oneline',
  [
    { short: 'n', long: 'max-count', value: number },
    { long: 'date', value: text },
    { long: 'format', value: PRETTY },
    { long: 'pretty', value: PRETTY },
  ],
  { kind: 'gitArg', max: 1 },
  { numericShort: true },
);

const REFLOG_SUBCOMMANDS = new Set(['expire', 'delete', 'exists', 'drop', 'write', 'list']);

function refuse(reason: string): Parsed {
  return { ok: false, reason };
}

function parseRemote(args: readonly Word[]): Parsed {
  const only = args[0]?.text;
  const fine = args.length === 0 || (args.length === 1 && (only === '-v' || only === '--verbose'));
  if (!fine) return refuse('git-shape:remote takes nothing but -v');
  return { ok: true, refs: [], seen: new Set(), operands: [] };
}

function parseReflog(args: readonly Word[], platform: NodeJS.Platform): Parsed {
  const first = args[0]?.text;
  if (first !== undefined && first !== 'show' && !first.startsWith('-')) {
    return refuse('git-shape:reflog');
  }
  const parsed = parseWithSpec(REFLOG, first === 'show' ? args.slice(1) : args, platform);
  if (!parsed.ok) return parsed;
  if (parsed.operands.some((operand) => REFLOG_SUBCOMMANDS.has(operand))) {
    return refuse('git-subcommand:reflog');
  }
  return parsed;
}

/** `cat-file` needs exactly one of the four modes: the others (`--batch`, `--textconv`) are not listed. */
function checkCatFile(parsed: Parsed): Parsed {
  if (!parsed.ok) return parsed;
  const modes = ['-t', '-s', '-p', '-e'].filter((mode) => parsed.seen.has(mode));
  return modes.length === 1 ? parsed : refuse('git-shape:cat-file needs one of -t -s -p -e');
}

/** `args` are the words after `git`. */
export function parseGit(args: readonly Word[], platform: NodeJS.Platform): Parsed {
  let index = 0;
  if (args[0]?.text === '--no-pager') index = 1;
  const name = args[index];
  if (name === undefined || name.text.startsWith('-')) {
    return refuse(`git-shape:${name?.text ?? 'no subcommand'}`);
  }
  const rest = args.slice(index + 1);
  if (name.text === 'remote') return parseRemote(rest);
  if (name.text === 'reflog') return parseReflog(rest, platform);
  const commandSpec = SUBCOMMANDS.get(name.text);
  if (commandSpec === undefined) return refuse(`git-subcommand:${name.text}`);
  const parsed = parseWithSpec(commandSpec, rest, platform);
  return name.text === 'cat-file' ? checkCatFile(parsed) : parsed;
}
