import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FolderInfo } from '../contracts';
import { isNotFound } from '../util';

/** Whether `target` is `root` or lies below it. Both must be absolute. */
export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** The real path of a path, or of its nearest ancestor that exists. */
async function realPathOfNearest(path: string): Promise<string | undefined> {
  let current = path;
  for (;;) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if (!isNotFound(error)) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

/**
 * Resolves a path from the webview against a folder and returns it only when it lies inside one of
 * the workspace folders, also after symbolic links are followed. Anything else gives undefined.
 */
export async function resolveInsideWorkspace(
  folders: readonly FolderInfo[],
  base: FolderInfo,
  requested: string,
): Promise<string | undefined> {
  if (requested.includes('\0')) return undefined;
  const target = resolve(base.path, requested);
  const roots = folders.map((folder) => resolve(folder.path));
  if (!roots.some((root) => isInside(root, target))) return undefined;

  const realTarget = await realPathOfNearest(target);
  if (realTarget === undefined) return undefined;
  for (const root of roots) {
    const realRoot = (await realPathOfNearest(root)) ?? root;
    if (isInside(realRoot, realTarget)) return target;
  }
  return undefined;
}
