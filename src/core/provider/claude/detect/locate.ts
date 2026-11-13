import { constants, promises as fs } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export type LocateResult =
  { kind: 'found'; command: string } | { kind: 'shim' } | { kind: 'missing' };

const SHIM_NAMES = ['claude.cmd', 'claude.bat', 'claude.ps1'];

async function isUsableFile(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') await fs.access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isShimPath(path: string): boolean {
  return /\.(cmd|bat|ps1)$/i.test(path);
}

function pathVariable(env: NodeJS.ProcessEnv): string {
  // Windows spells it Path; the environment object keeps whatever case it was given.
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return (key !== undefined ? env[key] : undefined) ?? '';
}

/**
 * Finds the Claude Code executable. An explicit path is never replaced by a PATH search. PATH
 * entries that are not absolute are skipped, so the result is always an absolute path.
 */
export async function locateClaude(options: {
  claudePath: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
}): Promise<LocateResult> {
  const { claudePath, env, platform, homeDir } = options;
  const exeName = platform === 'win32' ? 'claude.exe' : 'claude';

  if (claudePath.trim() !== '') {
    const path = claudePath.trim();
    if (!isAbsolute(path)) return { kind: 'missing' };
    if (platform === 'win32' && isShimPath(path) && (await isUsableFile(path, platform))) {
      return { kind: 'shim' };
    }
    return (await isUsableFile(path, platform))
      ? { kind: 'found', command: path }
      : { kind: 'missing' };
  }

  let shimSeen = false;
  const dirs = pathVariable(env)
    .split(delimiter)
    .map((d) => d.trim())
    // A relative entry (".", "node_modules/.bin", "") would resolve against the workspace.
    .filter((d) => d !== '' && isAbsolute(d));
  if (isAbsolute(homeDir)) dirs.push(join(homeDir, '.local', 'bin'));

  for (const dir of dirs) {
    const candidate = join(dir, exeName);
    if (await isUsableFile(candidate, platform)) return { kind: 'found', command: candidate };
    if (platform === 'win32' && !shimSeen) {
      for (const shim of SHIM_NAMES) {
        if (await isUsableFile(join(dir, shim), platform)) {
          shimSeen = true;
          break;
        }
      }
    }
  }
  return shimSeen ? { kind: 'shim' } : { kind: 'missing' };
}
