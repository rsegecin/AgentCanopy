/** The only characters a command may contain for AgentCanopy to build a rule from it. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SAFE_COMMAND = /^[A-Za-z0-9 _./:=@%+,~-]{1,300}$/;

/**
 * The Claude Code rule that allows exactly this command, or `undefined` when the command is not
 * plain enough to be sure of that. With no quotes, parentheses, shell operators, substitutions,
 * redirections, globs or backslashes, the rule can only ever match the one literal command.
 */
export function exactCommandRule(command: string): string | undefined {
  if (!SAFE_COMMAND.test(command)) return undefined;
  // A command with spaces at its ends is not the plain command it looks like.
  if (command.trim() !== command) return undefined;
  // Any environment variable can redirect what runs (PATH, LD_PRELOAD), so such a command is
  // never turned into a rule.
  if (ASSIGNMENT.test(command)) return undefined;
  return `Bash(${command})`;
}

/** Commands that only look at things. Anything not named here is assumed to be able to run code. */
const INERT_COMMANDS = new Set([
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
]);

const INERT_GIT = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
]);
/** Git subcommands that list when given no argument but change things when given one. */
const INERT_GIT_LISTING = new Set(['branch', 'remote', 'tag']);
const FIND_ACTIONS = new Set([
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-delete',
  '-fprint',
  '-fprint0',
  '-fprintf',
  '-fls',
]);
/** Shell syntax that can chain another command or substitute one. */
const SHELL_SYNTAX = /[;&|<>()`$\n\r]/;
/** A short-option cluster that contains `o`, such as `-o`, `-ro` or `-ofile`. */
const SHORT_O = /^-[^-]*o/;

/** Options that make an otherwise inert command run a program or write a file. */
function hasDangerousOption(command: string, rest: string[]): boolean {
  switch (command) {
    case 'git':
      return rest.some(
        (word) =>
          word.startsWith('--output') || word.startsWith('--ext-diff') || word.startsWith('-c'),
      );
    case 'rg':
    case 'grep':
      return rest.some((word) => word.startsWith('--pre') || word.startsWith('--hostname-bin'));
    case 'find':
      return rest.some((word) => FIND_ACTIONS.has(word));
    case 'sort':
      return rest.some(
        (word) =>
          word.startsWith('--output') ||
          word.startsWith('--compress-program') ||
          SHORT_O.test(word),
      );
    case 'tree':
      return rest.some((word) => word.startsWith('--output') || SHORT_O.test(word));
    default:
      return false;
  }
}

/** True for a `git` command (the words after `git`) that is not a plain look at history or listing. */
function gitRunsProjectCode(rest: string[]): boolean {
  if (hasDangerousOption('git', rest)) return true;
  const sub = rest[0];
  if (sub === undefined) return true;
  if (INERT_GIT.has(sub)) return false;
  return !(INERT_GIT_LISTING.has(sub) && rest.slice(1).every((word) => word.startsWith('-')));
}

/**
 * False only for a command known to be inert: a plain look at files or git history. True for
 * everything else, because a package script, a build file, a test runner, a repository script or a
 * wrapper such as `env` or `time` can run code from the project, which could rewrite the files that
 * hold the approvals. An "always" rule for such a command is labelled.
 *
 * A leading `NAME=value` always counts: any environment variable can redirect what runs
 * (`PATH=./bin ls`, `LD_PRELOAD=...`).
 */
export function runsProjectCode(command: string): boolean {
  if (SHELL_SYNTAX.test(command)) return true;
  const words = command.trim().split(/\s+/);
  const first = words[0];
  if (first === undefined || first === '' || ASSIGNMENT.test(first) || first.includes('/')) {
    return true;
  }
  const rest = words.slice(1);
  if (first === 'git') return gitRunsProjectCode(rest);
  if (hasDangerousOption(first, rest)) return true;
  return !INERT_COMMANDS.has(first);
}

/**
 * The only characters a PowerShell command may contain to be saved: letters, digits, space and
 * `_ . / \ : -`. Nothing in it can chain, substitute, quote or expand, so the saved text can only
 * ever match the one literal command.
 */
const SAFE_POWERSHELL_COMMAND = /^[A-Za-z0-9 _./\\:-]{1,300}$/;

/** The command itself when it is plain enough to be saved and matched by exact text, else `undefined`. */
export function exactPowerShellCommand(command: string): string | undefined {
  if (!SAFE_POWERSHELL_COMMAND.test(command)) return undefined;
  // A command with spaces at its ends is not the plain command it looks like.
  if (command.startsWith(' ') || command.endsWith(' ')) return undefined;
  return command;
}

/** Cmdlets and aliases that only look at things. Compared in lower case: PowerShell ignores case. */
const INERT_POWERSHELL = new Set([
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
]);

/**
 * False only for a PowerShell command known to be inert: one of a short list of cmdlets and
 * aliases that look at things, or `git` with the checks `runsProjectCode` applies. True for
 * everything else: a first word that is a path (`.\run.ps1`, `\\server\x.exe`, `C:\x`) runs that file,
 * and any other word may be a script, a program or a function from the project. A command with
 * characters outside the plain set (which `exactPowerShellCommand` refuses) always counts.
 */
export function runsProjectCodePowerShell(command: string): boolean {
  if (exactPowerShellCommand(command) === undefined) return true;
  const words = command.trim().split(/\s+/);
  const first = words[0];
  if (first === undefined || first === '') return true;
  if (/[/\\:]/.test(first) || first.startsWith('.')) return true;
  const lower = first.toLowerCase();
  if (lower === 'git') return gitRunsProjectCode(words.slice(1));
  return !INERT_POWERSHELL.has(lower);
}
