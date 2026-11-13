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

/** A file or directory path as a tool gave it. `base` is what a relative path is resolved against. */
export async function checkPath(
  value: string,
  base: string,
  folderPath: string,
): Promise<TargetCheck> {
  const expanded = expandHome(value);
  if (expanded === undefined) return { inside: false, shown: value, real: undefined };
  return judge(resolve(base, expanded), folderPath);
}

/**
 * A glob pattern: its literal directory prefix (the segments before the first one that contains
 * `* ? [ ] { }`) is judged like a path, against `base`, by where it really is. An absolute pattern
 * that points inside the folder is therefore allowed, like an absolute path.
 *
 * Brace expansion that reaches a parent folder (`{a,../b}/*`) is not analysed: a brace segment ends
 * the literal prefix.
 */
export async function checkPattern(
  pattern: string,
  base: string,
  folderPath: string,
): Promise<TargetCheck> {
  if (pattern.startsWith('~') && pattern !== '~' && !pattern.startsWith('~/')) {
    return { inside: false, shown: pattern, real: undefined };
  }
  const segments = pattern.split('/');
  let end = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  if (end === -1) end = segments.length;
  let prefix = segments.slice(0, end).join('/');
  const rest = segments.slice(end).join('/');
  if (prefix === '' && pattern.startsWith('/')) prefix = '/';

  const expanded = expandHome(prefix) ?? prefix;
  const result = await judge(resolve(base, expanded), folderPath);
  const shown =
    rest === '' ? result.shown : `${result.shown}${result.shown.endsWith('/') ? '' : '/'}${rest}`;
  return { ...result, shown };
}
