import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { isInside } from './paths';
import { realFolderPath } from './targets';

/** The longest folder name the CLI uses as it is; a longer one it shortens with a hash. */
const MAX_SLUG_LENGTH = 200;

/**
 * The name the Claude Code CLI gives a project's folder under `<config>/projects`: every character
 * that is not a letter or a digit becomes a dash. There is no `u` flag, as in the CLI, so a
 * character outside the Basic Multilingual Plane becomes two dashes. `undefined` for a result longer
 * than 200 characters: the CLI hashes those, and the hash is not reproduced here.
 */
export function projectSlug(path: string): string | undefined {
  const slug = path.replace(/[^a-zA-Z0-9]/g, '-');
  return slug.length > MAX_SLUG_LENGTH ? undefined : slug;
}

function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** The path, in lower case when the file system ignores case. */
function folded(path: string): string {
  return foldsCase(process.platform) ? path.toLowerCase() : path;
}

/** True for a directory that is not a link (Node reports a Windows junction as a symbolic link). */
async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The directories of Claude Code's own memory for this workspace folder:
 * `<config>/projects/<slug>/memory`. The config directory is `CLAUDE_CONFIG_DIR` when that is an
 * absolute path, else `.claude` in the home folder. Only the config directory is resolved to its real
 * path; the rest is built from names, and a directory is kept only when it exists and is not a link.
 * The folder is tried as given and by its real path, which can differ in the case of the drive letter.
 */
export async function claudeMemoryDirs(
  folderPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const given = env['CLAUDE_CONFIG_DIR'];
  const configDir =
    given !== undefined && given !== '' && isAbsolute(given)
      ? given
      : join(await realFolderPath(homedir()), '.claude');
  const realConfig = await realFolderPath(configDir);

  const candidates = [folderPath, await realFolderPath(folderPath)];
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const slug = projectSlug(candidate);
    if (slug === undefined) continue;
    const dir = join(realConfig, 'projects', slug, 'memory');
    const key = folded(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (await isPlainDirectory(dir)) dirs.push(dir);
  }
  return dirs;
}

/** True when the real path is one of these directories or lies below one. */
export function isInsideClaudeMemory(real: string, memoryDirs: readonly string[]): boolean {
  const path = folded(real);
  return memoryDirs.some((dir) => isInside(folded(dir), path));
}
