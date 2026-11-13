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
  if (hasDangerousOption(first, rest)) return true;
  if (first === 'git') {
    const sub = rest[0];
    if (sub === undefined) return true;
    if (INERT_GIT.has(sub)) return false;
    return !(INERT_GIT_LISTING.has(sub) && rest.slice(1).every((word) => word.startsWith('-')));
  }
  return !INERT_COMMANDS.has(first);
}
