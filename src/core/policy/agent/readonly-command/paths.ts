import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { isInside } from '../../readonly/paths';
import { checkPath } from '../../readonly/targets';

/**
 * A word that names a file or a revision. `path` is a file name; `gitArg` is a revision or a
 * pathspec, so it may hold `:` (`HEAD:src/a.ts`) and `..` (`main..HEAD`).
 */
export type PathKind = 'path' | 'gitArg';

export interface PathRef {
  word: string;
  kind: PathKind;
  /** The real path must not be a directory (see `Operands.notDirectory`). */
  notDirectory?: boolean;
}

const DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;

function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/**
 * The checks that need no file system. They run before anything touches the disk: on Windows an
 * `lstat` of `\\host\share` would make the extension host contact that server.
 * Returns the reason, or undefined when the word passes.
 */
export function lexicalPathReason(
  word: string,
  kind: PathKind,
  platform: NodeJS.Platform,
): string | undefined {
  if (kind === 'path' && word === '/dev/null') return undefined;
  if (word === '' || word === '-') return 'path-form:empty or -';
  if (word.startsWith('~')) return 'path-form:~';
  if (word.startsWith('//') || word.startsWith('\\\\')) return 'path-form:UNC';
  if (hasParentComponent(word, kind, platform)) return 'path-form:..';
  return platform === 'win32' ? windowsFormReason(word, kind) : undefined;
}

function hasParentComponent(word: string, kind: PathKind, platform: NodeJS.Platform): boolean {
  // `HEAD:../x` is a path relative to the work tree, so a revision is split on `:` too.
  let separators = '/';
  if (platform === 'win32') separators += '\\';
  if (kind === 'gitArg') separators += ':';
  let start = 0;
  for (let i = 0; i <= word.length; i += 1) {
    if (i === word.length || separators.includes(word[i] ?? '')) {
      if (word.slice(start, i) === '..') return true;
      start = i + 1;
    }
  }
  return false;
}

/** Windows opens these in every folder, with or without an extension: `CON`, `nul.txt`. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function isDeviceName(word: string, kind: PathKind): boolean {
  const separators = kind === 'gitArg' ? /[/\\:]/ : /[/\\]/;
  const last = word.split(separators).pop() ?? '';
  return DEVICE_NAME.test(last);
}

function windowsFormReason(word: string, kind: PathKind): string | undefined {
  if (isDeviceName(word, kind)) return 'path-form:device name';
  if (word.includes('\\\\')) return 'path-form:\\\\';
  if (kind === 'gitArg') return /:[\\/]/.test(word) ? 'path-form::/' : undefined;
  // A colon other than a drive prefix is an alternate data stream, or an MSYS path-list (`a:/c/x`).
  const rest = DRIVE_PREFIX.test(word) ? word.slice(2) : word;
  return rest.includes(':') ? 'path-form:colon' : undefined;
}

export interface PathContext {
  folderPath: string;
  /** The folder's real path. */
  realFolder: string;
  platform: NodeJS.Platform;
}

function isAbsoluteWord(word: string, platform: NodeJS.Platform): boolean {
  if (word.startsWith('/')) return true;
  return platform === 'win32' && DRIVE_PREFIX.test(word);
}

function fold(path: string, platform: NodeJS.Platform): string {
  return foldsCase(platform) ? path.toLowerCase() : path;
}

/** True when the text of an absolute path lies under the folder, by either spelling of the folder. */
function lexicallyInside(word: string, context: PathContext): boolean {
  const absolute = fold(resolve(word), context.platform);
  return [context.folderPath, context.realFolder].some((root) =>
    isInside(fold(resolve(root), context.platform), absolute),
  );
}

export type Resolved = { ok: true; real: string | undefined } | { ok: false; reason: string };

/**
 * Where the word really is. Words that pass `lexicalPathReason` only. An absolute word that is not
 * under the folder by its text is refused here without a file system call: it cannot be inside.
 */
export async function resolveRef(ref: PathRef, context: PathContext): Promise<Resolved> {
  if (ref.kind === 'path' && ref.word === '/dev/null') return { ok: true, real: undefined };
  if (isAbsoluteWord(ref.word, context.platform) && !lexicallyInside(ref.word, context)) {
    return { ok: false, reason: 'path-outside' };
  }
  const check = await checkPath(ref.word, context.folderPath, context.folderPath);
  if (!check.inside || check.real === undefined) {
    return { ok: false, reason: `path-outside:${check.shown}` };
  }
  return { ok: true, real: check.real };
}

export async function pathRefReason(
  ref: PathRef,
  context: PathContext,
): Promise<string | undefined> {
  const resolved = await resolveRef(ref, context);
  if (!resolved.ok) return resolved.reason;
  if (ref.notDirectory === true && resolved.real !== undefined) {
    if (await isDirectory(resolved.real)) return 'operand-not-allowed:directory';
  }
  return undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}
