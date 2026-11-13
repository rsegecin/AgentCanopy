import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isVanished } from './internal';

/** A relative path that is absolute, climbs out of the root, or is otherwise not a plain workspace path. */
export class PathEscapeError extends Error {
  override name = 'PathEscapeError';
  constructor(
    readonly relPath: string,
    reason: string,
  ) {
    super(`Path is not inside the workspace folder (${reason}): ${JSON.stringify(relPath)}`);
  }
}

/**
 * Joins a workspace-relative path (forward slashes) to the root. Throws `PathEscapeError` when the
 * path is absolute, has a `..` or empty segment, contains a NUL, or resolves outside the root. This
 * is a textual check only; use `checkParents` for symlinks.
 */
export function resolveInside(root: string, relPath: string): string {
  if (relPath.includes('\0')) throw new PathEscapeError(relPath, 'contains a NUL');
  if (relPath.length === 0) throw new PathEscapeError(relPath, 'empty path');
  if (relPath.startsWith('/') || isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw new PathEscapeError(relPath, 'absolute path');
  }
  if (process.platform === 'win32' && (relPath.includes('\\') || relPath.includes(':'))) {
    throw new PathEscapeError(relPath, 'backslash or colon');
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '') throw new PathEscapeError(relPath, 'empty segment');
    if (segment === '..') throw new PathEscapeError(relPath, 'parent segment');
  }
  const base = resolve(root);
  const absolute = resolve(base, ...segments);
  const back = relative(base, absolute);
  if (back === '..' || back.startsWith(`..${sep}`) || isAbsolute(back)) {
    throw new PathEscapeError(relPath, 'resolves outside the root');
  }
  return absolute;
}

export type ParentCheck =
  { ok: true } | { ok: false; at: string; reason: 'symlink' | 'not-directory' };

/**
 * Examines every existing parent directory between the root and the target. A parent that is a symlink
 * or not a directory fails the check (`at` is its workspace-relative path). Parents that do not exist
 * are fine: they will be created. The root itself and the target are not examined.
 */
export async function checkParents(root: string, relPath: string): Promise<ParentCheck> {
  resolveInside(root, relPath);
  const segments = relPath.split('/');
  const base = resolve(root);
  for (let i = 1; i < segments.length; i += 1) {
    const at = segments.slice(0, i).join('/');
    let stats;
    try {
      stats = await fs.lstat(join(base, ...segments.slice(0, i)));
    } catch (error) {
      if (isVanished(error)) return { ok: true };
      throw error;
    }
    if (stats.isSymbolicLink()) return { ok: false, at, reason: 'symlink' };
    if (!stats.isDirectory()) return { ok: false, at, reason: 'not-directory' };
  }
  return { ok: true };
}

/** Swaps the case of every letter that has a single-character counterpart. */
function swapCase(name: string): string {
  let out = '';
  for (const char of name) {
    const upper = char.toUpperCase();
    const lower = char.toLowerCase();
    if (upper === lower || upper.length !== char.length || lower.length !== char.length) {
      out += char;
    } else {
      out += char === lower ? upper : lower;
    }
  }
  return out;
}

/**
 * Tells whether the volume holding `dir` treats names that differ only in case as the same file. It
 * looks at the directory under a case-swapped spelling of its own name and compares device and inode;
 * nothing is created. A name without letters defers to its parent; when nothing decides, false.
 */
export async function isCaseInsensitiveVolume(dir: string): Promise<boolean> {
  let current = resolve(dir);
  for (;;) {
    const name = basename(current);
    const parent = dirname(current);
    const swapped = swapCase(name);
    if (name !== '' && swapped !== name) {
      let original;
      try {
        original = await fs.lstat(current, { bigint: true });
      } catch (error) {
        if (!isVanished(error)) throw error;
      }
      if (original !== undefined) {
        try {
          const alias = await fs.lstat(join(parent, swapped), { bigint: true });
          if (original.ino !== 0n || alias.ino !== 0n) {
            return original.dev === alias.dev && original.ino === alias.ino;
          }
        } catch (error) {
          // The alias does not exist: names are case-sensitive here.
          if (isVanished(error)) return false;
          throw error;
        }
      }
    }
    if (parent === current) return false;
    current = parent;
  }
}

/** True when both paths exist and are the same file (same device and inode). Symlinks are not followed. */
export async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([
      fs.lstat(a, { bigint: true }),
      fs.lstat(b, { bigint: true }),
    ]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch (error) {
    if (isVanished(error)) return false;
    throw error;
  }
}
