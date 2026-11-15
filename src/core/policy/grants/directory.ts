import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isInside, realPathOf } from '../readonly/paths';
import { realFolderPath } from '../readonly/targets';
import { canGrantDirectory, isSensitivePath, resolveSensitiveEnv } from './sensitive';
import { isValidGrant, type FolderGrants } from './store';

/** Why a folder the user picked cannot be saved as a directory to read from. */
export type DirectoryRefusal =
  'not-a-directory' | 'inside-folder' | 'sensitive' | 'too-broad' | 'covered';

/**
 * Whether the folder the user picked may be saved, and as which real path. The host calls this
 * before it asks the user to confirm, and saves exactly `dir`.
 */
export async function checkDirectoryToGrant(input: {
  /** As the folder picker gave it. */
  path: string;
  /** The workspace folder. */
  folderPath: string;
  /** What the folder has saved now. */
  granted: FolderGrants;
  sensitiveRoots: () => string[];
}): Promise<{ dir: string } | { refused: DirectoryRefusal }> {
  // A relative path would be read against the process's own folder, which is not what was picked.
  if (!isAbsolute(input.path)) return { refused: 'not-a-directory' };
  let real: string;
  try {
    real = await realPathOf(input.path);
    if (!(await fs.stat(real)).isDirectory()) return { refused: 'not-a-directory' };
  } catch {
    return { refused: 'not-a-directory' };
  }
  // Reads inside the workspace folder never ask, so there is nothing to allow.
  if (isInside(await realFolderPath(input.folderPath), real)) return { refused: 'inside-folder' };
  const env = await resolveSensitiveEnv(input.sensitiveRoots);
  if (isSensitivePath(real, env)) return { refused: 'sensitive' };
  if (!canGrantDirectory(real, env)) return { refused: 'too-broad' };
  const covered = input.granted.grants.some(
    (grant) =>
      grant.kind === 'read-directory' &&
      canGrantDirectory(grant.path, env) &&
      isInside(grant.path, real),
  );
  if (covered) return { refused: 'covered' };
  // The switch being on is not a reason to refuse: the directory still covers more once it is off.
  return isValidGrant({ kind: 'read-directory', path: real })
    ? { dir: real }
    : { refused: 'too-broad' };
}
