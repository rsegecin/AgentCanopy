import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { escapeOneLine } from '../readonly/escape';
import { isInside } from '../readonly/paths';
import { realFolderPath } from '../readonly/targets';

/**
 * Where the sensitive locations are. Every path is a real path. This is a backstop for the common
 * credential stores and for AgentCanopy's own storage, not a complete list of what is private.
 * On Windows the user's temp folder lies under `AppData` and is the one place there that is not
 * sensitive (see `tempFolder`).
 */
export interface SensitiveEnv {
  home: string;
  /** AgentCanopy's storage directories. */
  roots: readonly string[];
  platform: NodeJS.Platform;
}

/** Under the home directory, on every platform. */
const HOME_NAMES = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.config',
  '.claude',
  '.claude.json',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.pypirc',
];

/** The real home directory and storage directories, read now. Call it at every decision. */
export async function resolveSensitiveEnv(sensitiveRoots: () => string[]): Promise<SensitiveEnv> {
  const roots: string[] = [];
  for (const root of sensitiveRoots()) {
    if (root !== '') roots.push(await realFolderPath(root));
  }
  return { home: await realFolderPath(homedir()), roots, platform: process.platform };
}

function foldsCase(env: SensitiveEnv): boolean {
  return env.platform === 'win32' || env.platform === 'darwin';
}

/** The credential locations under the home directory. */
function homeLocations(env: SensitiveEnv): string[] {
  const names = [...HOME_NAMES];
  if (env.platform === 'win32') names.push('AppData');
  if (env.platform === 'darwin') names.push('Library');
  return names.map((name) => join(env.home, name));
}

function locations(env: SensitiveEnv): string[] {
  return [...homeLocations(env), ...env.roots];
}

/**
 * Windows keeps the user's temp folder under AppData. It holds scratch files of every program, not
 * credential stores, so it is the one place under AppData that is an ordinary location. The path is
 * fixed, not read from TEMP: a variable must not be able to declare part of AppData ordinary.
 */
function tempFolder(env: SensitiveEnv): string | undefined {
  return env.platform === 'win32' ? join(env.home, 'AppData', 'Local', 'Temp') : undefined;
}

/** The location and the path, both lower case when the file system ignores case. */
function folded(env: SensitiveEnv, ...paths: string[]): string[] {
  return foldsCase(env) ? paths.map((path) => path.toLowerCase()) : paths;
}

/** True when the real path is one of the places or lies below one. */
function insideAny(env: SensitiveEnv, real: string, places: readonly string[]): boolean {
  return places.some((place) => {
    const [root, path] = folded(env, place, real);
    return root !== undefined && path !== undefined && isInside(root, path);
  });
}

/**
 * True when the real path is a sensitive location or lies below one. On Windows it is also true for
 * every path that starts with two backslashes: a network share or an administrative share such as
 * `\\localhost\C$` cannot be told apart from a local path. The temp folder of Windows is not
 * sensitive although it lies under `AppData`; AgentCanopy's own storage is, wherever it lies, so it
 * is looked at first.
 */
export function isSensitivePath(real: string, env: SensitiveEnv): boolean {
  if (env.platform === 'win32' && (real.startsWith('\\\\') || real.startsWith('//'))) return true;
  if (insideAny(env, real, env.roots)) return true;
  const temp = tempFolder(env);
  if (temp !== undefined && insideAny(env, real, [temp])) return false;
  return insideAny(env, real, homeLocations(env));
}

/**
 * True when a sensitive location is the path itself or lies below it: the home directory, every
 * ancestor of it, a drive root that holds it, and a parent of the extension's storage.
 */
export function containsSensitive(real: string, env: SensitiveEnv): boolean {
  return locations(env).some((location) => {
    const [root, path] = folded(env, real, location);
    return root !== undefined && path !== undefined && isInside(root, path);
  });
}

/**
 * Whether a directory may be saved so that reads and searches in it and below it no longer ask. Not a
 * filesystem or drive root, not a sensitive location or below one, not one that holds a sensitive
 * location (so not the home directory or its ancestors), and a plain absolute path.
 */
export function canGrantDirectory(real: string, env: SensitiveEnv): boolean {
  if (!isAbsolute(real) || escapeOneLine(real) !== real) return false;
  const resolved = resolve(real);
  if (parse(resolved).root === resolved) return false;
  return !isSensitivePath(real, env) && !containsSensitive(real, env);
}
