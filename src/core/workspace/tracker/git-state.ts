import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { errorCode } from './fs-util';

/** Where a folder's Git data is. Found by looking at files only; Git is never run. */
export interface GitLocation {
  /** The directory that holds `.git`. */
  root: string;
  /** The git directory (what `.git` is, or what its `gitdir:` line points to). */
  gitDir: string;
  /** The directory that holds the shared `config` and `hooks` (differs from `gitDir` in a worktree). */
  commonDir: string;
}

export interface GitState {
  head: string;
  logSize: number;
  stash: string;
}

export const GIT_CHANGED_NOTE =
  'The agent changed Git state (commits, branch or stash). Undoing file changes does not undo that.';

const MAX_READ = 4096;

async function readSmall(file: string): Promise<string | undefined> {
  let handle;
  try {
    handle = await fs.open(file, 'r');
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(MAX_READ);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Walks up from the folder to the first `.git`. Follows a `gitdir:` file. Undefined when there is none. */
export async function findGit(folderPath: string): Promise<GitLocation | undefined> {
  let dir = resolve(folderPath);
  for (;;) {
    const candidate = join(dir, '.git');
    let stats;
    try {
      stats = await fs.lstat(candidate);
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
    }
    if (stats?.isDirectory()) return withCommon(dir, candidate);
    if (stats?.isFile()) {
      const text = await readSmall(candidate);
      const match = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
      if (match?.[1]) {
        const target = match[1];
        return withCommon(dir, isAbsolute(target) ? target : resolve(dir, target));
      }
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function withCommon(root: string, gitDir: string): Promise<GitLocation> {
  let commonDir = gitDir;
  const common = await readSmall(join(gitDir, 'commondir'));
  const line = common?.split('\n')[0]?.trim();
  if (line) commonDir = isAbsolute(line) ? line : resolve(gitDir, line);
  return { root, gitDir, commonDir };
}

export async function readGitState(git: GitLocation | undefined): Promise<GitState | undefined> {
  if (!git) return undefined;
  const head = (await readSmall(join(git.gitDir, 'HEAD'))) ?? '';
  let logSize: number;
  try {
    logSize = (await fs.stat(join(git.gitDir, 'logs', 'HEAD'))).size;
  } catch {
    logSize = 0;
  }
  const stash =
    (await readSmall(join(git.commonDir, 'refs', 'stash'))) ??
    (await readSmall(join(git.gitDir, 'refs', 'stash'))) ??
    '';
  return { head, logSize, stash };
}

export function gitStateChanged(
  before: GitState | undefined,
  after: GitState | undefined,
): boolean {
  if (before === undefined || after === undefined) return false;
  return (
    before.head !== after.head || before.logSize !== after.logSize || before.stash !== after.stash
  );
}
