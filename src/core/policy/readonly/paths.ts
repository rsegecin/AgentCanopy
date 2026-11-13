import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const MAX_LINK_HOPS = 40;

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

type Step = { done: string } | { retry: string };

/** One pass: the real path of the longest existing prefix, with the rest appended. */
async function resolvePass(start: string, hop: () => void): Promise<Step> {
  const tail: string[] = [];
  let current = start;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return { done: tail.length === 0 ? real : join(real, ...tail) };
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    // Missing, or a symlink whose target is missing. A dangling link is followed by hand, so that a
    // file that does not exist yet is still judged by where the link would put it.
    let target: string | undefined;
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) target = await fs.readlink(current);
    } catch {
      // Not there at all: fall through to the parent.
    }
    if (target !== undefined) {
      hop();
      return { retry: resolve(dirname(current), target, ...tail) };
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('No part of the path exists');
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * The absolute path with every symlink resolved, using the longest prefix that exists. Throws when it
 * cannot be determined (permission denied, a loop); the caller then treats the path as outside.
 */
export async function realPathOf(input: string): Promise<string> {
  let hops = 0;
  const hop = (): void => {
    hops += 1;
    if (hops > MAX_LINK_HOPS) throw new Error('Too many symbolic links');
  };
  let path = resolve(input);
  for (;;) {
    const step = await resolvePass(path, hop);
    if ('done' in step) return step.done;
    path = step.retry;
  }
}

/** True when `path` is `root` or lies below it. Both must be absolute and already resolved. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
