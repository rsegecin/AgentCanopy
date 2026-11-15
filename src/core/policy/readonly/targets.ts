import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isInside, realPathOf } from './paths';

/** Where a tool wants to look, judged against the workspace folder. */
export interface TargetCheck {
  /** True when it lies inside the folder (by real path). */
  inside: boolean;
  /** What to show the user when it does not: a real absolute path, or the text as given. */
  shown: string;
  /** The real path, when it could be determined. */
  real: string | undefined;
}

const GLOB_CHARS = /[*?[\]{}]/;

export async function realFolderPath(folderPath: string): Promise<string> {
  try {
    return await fs.realpath(folderPath);
  } catch {
    return resolve(folderPath);
  }
}

/**
 * Expands a leading `~` or `~/` to the home folder. Any other leading `~` (such as `~other/x`)
 * cannot be judged here and gives `undefined`: the caller treats it as outside the folder.
 */
function expandHome(value: string): string | undefined {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  if (value.startsWith('~')) return undefined;
  return value;
}

async function judge(absolute: string, folderPath: string): Promise<TargetCheck> {
  let real: string | undefined;
  try {
    real = await realPathOf(absolute);
  } catch {
    // Cannot tell where it really is (permission denied, a link loop): not treated as inside.
    real = undefined;
  }
  const inside = real !== undefined && isInside(await realFolderPath(folderPath), real);
  return { inside, shown: real ?? absolute, real };
}

/** True for whitespace and for control characters (C0 controls and U+007F). */
function isSpaceOrControl(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f || /\s/u.test(char);
}

function isSeparator(char: string | undefined): boolean {
  return char === '/' || char === '\\';
}

/** The rules that look at the whole text: a, b and c of `cannotJudge`. */
function cannotJudgeWhole(value: string, platform: NodeJS.Platform): boolean {
  if (isSpaceOrControl(value[0]) || isSpaceOrControl(value[value.length - 1])) return true;
  if (platform !== 'win32') return false;
  // Rooted without a drive: one separator, then something that is not a separator (or nothing).
  if (isSeparator(value[0]) && !isSeparator(value[1])) return true;
  // A drive letter and a colon, not followed by a separator: relative to that drive's own folder.
  return /^[A-Za-z]:/.test(value) && !isSeparator(value[2]);
}

/** Rule d of `cannotJudge`: a segment (other than `.` and `..`) that ends in a dot or a space. */
function hasTrailingDotOrSpace(text: string): boolean {
  return text
    .split(/[/\\]/)
    .some((segment) => segment !== '.' && segment !== '..' && /[. ]$/.test(segment));
}

/**
 * True when the host cannot be sure to resolve `value` the way the CLI will, so it is judged as
 * outside the folder. This is the case when:
 * - its first or last character is whitespace or a control character (the CLI may trim it);
 * - on Windows, it is rooted without a drive (`/c/x`, `\x`) or has a drive letter with no separator
 *   after the colon (`C:x`, `C:`): the result depends on the current drive or on how the CLI reads it;
 * - on Windows, a segment other than `.` and `..` ends in a dot or a space: Windows drops them, so
 *   `.ssh.` is `.ssh`.
 * An empty string is not flagged.
 */
export function cannotJudge(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (cannotJudgeWhole(value, platform)) return true;
  return platform === 'win32' && hasTrailingDotOrSpace(value);
}

/**
 * Splits a glob pattern into its literal directory prefix (the segments before the first one that
 * contains `* ? [ ] { }`, joined with `/`) and the rest. On Windows a backslash separates segments
 * too; elsewhere only `/` does.
 */
export function splitPattern(
  pattern: string,
  platform: NodeJS.Platform = process.platform,
): { prefix: string; rest: string } {
  const segments = pattern.split(platform === 'win32' ? /[/\\]/ : '/');
  let end = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (end === -1) end = segments.length;
  let prefix = segments.slice(0, end).join('/');
  const rest = segments.slice(end).join('/');
  if (prefix === '' && pattern.startsWith('/')) prefix = '/';
  return { prefix, rest };
}

/**
 * A file or directory path as a tool gave it. `base` is what a relative path is resolved against.
 * A path the host cannot be sure to resolve like the CLI (see `cannotJudge`) is outside the folder,
 * with no real path, and is shown as given.
 */
export async function checkPath(
  value: string,
  base: string,
  folderPath: string,
): Promise<TargetCheck> {
  if (cannotJudge(value)) return { inside: false, shown: value, real: undefined };
  const expanded = expandHome(value);
  if (expanded === undefined) return { inside: false, shown: value, real: undefined };
  return judge(resolve(base, expanded), folderPath);
}

/**
 * A glob pattern: its literal directory prefix (the segments before the first one that contains
 * `* ? [ ] { }`; on Windows a backslash separates segments too) is judged like a path, against
 * `base`, by where it really is. An absolute pattern that points inside the folder is therefore
 * allowed, like an absolute path.
 *
 * A pattern the host cannot be sure to resolve like the CLI is outside the folder, with no real
 * path, and is shown as given: the cases of `cannotJudge` for the whole pattern, and, on Windows, a
 * prefix segment that ends in a dot or a space. The part after the prefix is not looked at, so
 * a last segment such as `*.` is fine.
 *
 * Brace expansion that reaches a parent folder (`{a,../b}/*`) is not analysed: a brace segment ends
 * the literal prefix.
 */
export async function checkPattern(
  pattern: string,
  base: string,
  folderPath: string,
): Promise<TargetCheck> {
  const unjudged: TargetCheck = { inside: false, shown: pattern, real: undefined };
  if (pattern.startsWith('~') && pattern !== '~' && !pattern.startsWith('~/')) return unjudged;
  if (cannotJudgeWhole(pattern, process.platform)) return unjudged;
  const { prefix, rest } = splitPattern(pattern);
  if (process.platform === 'win32' && hasTrailingDotOrSpace(prefix)) return unjudged;

  const expanded = expandHome(prefix) ?? prefix;
  const result = await judge(resolve(base, expanded), folderPath);
  const shown =
    rest === '' ? result.shown : `${result.shown}${result.shown.endsWith('/') ? '' : '/'}${rest}`;
  return { ...result, shown };
}
