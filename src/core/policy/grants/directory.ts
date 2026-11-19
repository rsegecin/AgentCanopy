import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isProtectedAbsolutePath } from '../agent/protected';
import { isInside, realPathOf } from '../readonly/paths';
import { realFolderPath } from '../readonly/targets';
import {
  canGrantDirectory,
  isSensitivePath,
  resolveSensitiveEnv,
  type SensitiveEnv,
} from './sensitive';
import { isValidGrant, type FolderGrants, type Grant } from './store';

/** What a saved directory outside the workspace folder lets through without asking. */
export type DirectoryAccess = 'read' | 'edit';

/** Why a folder the user picked cannot be saved as a directory to read from or to edit in. */
export type DirectoryRefusal =
  'not-a-directory' | 'inside-folder' | 'sensitive' | 'protected' | 'too-broad' | 'covered';

/**
 * True when the saved grant lets a read or search of the real path through: a directory saved for
 * reads or for edits that holds it and may still be granted. Whether the path itself is sensitive is
 * the caller's check.
 */
export function coversRead(grant: Grant, real: string, env: SensitiveEnv): boolean {
  return (
    (grant.kind === 'read-directory' || grant.kind === 'edit-directory') &&
    canGrantDirectory(grant.path, env) &&
    isInside(grant.path, real)
  );
}

/**
 * True when the saved grant lets an edit of the real path through: a directory saved for edits that
 * holds it and may still be granted. A directory saved for reads never does. Whether the path itself
 * is sensitive or protected is the caller's check.
 */
export function coversEdit(grant: Grant, real: string, env: SensitiveEnv): boolean {
  return (
    grant.kind === 'edit-directory' &&
    canGrantDirectory(grant.path, env) &&
    isInside(grant.path, real)
  );
}

/**
 * Whether the folder the user picked may be saved, and as which real path. The host calls this
 * before it asks the user to confirm, and saves exactly `dir`, as a `read-directory` or an
 * `edit-directory` by `access`.
 */
export async function checkDirectoryToGrant(input: {
  /** As the folder picker gave it. */
  path: string;
  /** The workspace folder. */
  folderPath: string;
  /** What the folder has saved now. */
  granted: FolderGrants;
  sensitiveRoots: () => string[];
  /** What the directory is to allow. Reads when left out. */
  access?: DirectoryAccess;
}): Promise<{ dir: string } | { refused: DirectoryRefusal }> {
  const access = input.access ?? 'read';
  // A relative path would be read against the process's own folder, which is not what was picked.
  if (!isAbsolute(input.path)) return { refused: 'not-a-directory' };
  let real: string;
  try {
    real = await realPathOf(input.path);
    if (!(await fs.stat(real)).isDirectory()) return { refused: 'not-a-directory' };
  } catch {
    return { refused: 'not-a-directory' };
  }
  // Reads inside the workspace folder never ask, and edits there are reviewed: nothing to allow.
  if (isInside(await realFolderPath(input.folderPath), real)) return { refused: 'inside-folder' };
  const env = await resolveSensitiveEnv(input.sensitiveRoots);
  if (isSensitivePath(real, env)) return { refused: 'sensitive' };
  // Every edit in a protected directory asks, so allowing one would allow nothing.
  if (access === 'edit' && isProtectedAbsolutePath(real)) return { refused: 'protected' };
  if (!canGrantDirectory(real, env)) return { refused: 'too-broad' };
  const covers = access === 'edit' ? coversEdit : coversRead;
  if (input.granted.grants.some((grant) => covers(grant, real, env))) return { refused: 'covered' };
  // The switch being on is not a reason to refuse: the directory still covers more once it is off.
  const kind = access === 'edit' ? 'edit-directory' : 'read-directory';
  return isValidGrant({ kind, path: real }) ? { dir: real } : { refused: 'too-broad' };
}
