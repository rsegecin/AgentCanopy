import { promises as fs } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { containsSensitive, isSensitivePath, resolveSensitiveEnv } from '../../grants/sensitive';
import { isInside } from '../../readonly/paths';
import { realFolderPath } from '../../readonly/targets';
import { parseSimpleCommand } from './grammar';
import { GIT_ENVIRONMENT, parseGit } from './git';
import type { PathContext, PathRef } from './paths';
import { lexicalPathReason, pathRefReason, resolveRef } from './paths';
import type { SimpleCommand } from './tokenize';
import { tokenize } from './tokenize';

/**
 * Decides whether a shell command can do nothing but read files inside the workspace folder and
 * print to stdout or stderr. The text comes from a model that repository content may have
 * prompt-injected, so a wrong "not read-only" costs one prompt and a wrong "read-only" is a hole:
 * whatever is not understood is refused. Every refusal carries a reason code, optionally followed
 * by `:` and a short detail.
 */

export interface ReadOnlyCheckOptions {
  /** Absolute, as VS Code gives it (may be `d:\...` with a lower-case drive). */
  folderPath: string;
  /** The storage directories of AgentCanopy, which are sensitive. Default: none. */
  sensitiveRoots?: () => string[];
  /** Used by the lexical rules. Default: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Used by the PATH and GIT_* gates. Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export type ReadOnlyCheck = { readOnly: true } | { readOnly: false; reason: string };

const WIN32_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function refused(reason: string): ReadOnlyCheck {
  return { readOnly: false, reason };
}

/** What the synchronous part found: everything the file system must still confirm. */
interface Analysis {
  refs: PathRef[];
  cdTarget: string | undefined;
  usesGit: boolean;
}

/**
 * The only `cd` that passes is the first command, `cd /absolute/folder &&`, followed by another
 * command. An absolute path means CDPATH does not apply.
 */
function cdReason(
  commands: readonly SimpleCommand[],
  platform: NodeJS.Platform,
): { reason: string } | { target: string } {
  const first = commands[0];
  const target = first?.words[1];
  if (first === undefined || target === undefined) return { reason: 'cd' };
  if (first.words.length !== 2 || first.separator !== '&&' || commands.length < 2) {
    return { reason: 'cd:needs one argument and a command after &&' };
  }
  if (target.globs.length > 0) return { reason: 'glob' };
  const absolute = platform === 'win32' ? WIN32_ABSOLUTE.test(target.text) : target.text[0] === '/';
  if (!absolute) return { reason: 'cd:not an absolute path' };
  const lexical = lexicalPathReason(target.text, 'path', platform);
  return lexical === undefined ? { target: target.text } : { reason: lexical };
}

/** Tokenizes and checks every simple command against its grammar. No file system access. */
function analyze(command: string, platform: NodeJS.Platform): Analysis | { reason: string } {
  const tokens = tokenize(command);
  if (!tokens.ok) return { reason: tokens.reason };
  const analysis: Analysis = { refs: [], cdTarget: undefined, usesGit: false };
  for (const [index, simple] of tokens.commands.entries()) {
    const name = simple.words[0]?.text ?? '';
    if (name === 'cd') {
      const cd = index === 0 ? cdReason(tokens.commands, platform) : { reason: 'cd:not first' };
      if ('reason' in cd) return cd;
      analysis.cdTarget = cd.target;
      continue;
    }
    if (name === 'git') analysis.usesGit = true;
    const args = simple.words.slice(1);
    const parsed =
      name === 'git' ? parseGit(args, platform) : parseSimpleCommand(name, args, platform);
    if (!parsed.ok) return { reason: parsed.reason };
    analysis.refs.push(...parsed.refs);
  }
  return analysis;
}

function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

/** True when `entry` is the folder or lies under it, by its text. */
function lexicallyUnder(root: string, entry: string, platform: NodeJS.Platform): boolean {
  const flavor = platform === 'win32' ? win32 : posix;
  const fold = (value: string): string => (foldsCase(platform) ? value.toLowerCase() : value);
  const relative = flavor.relative(fold(root), fold(entry));
  if (relative === '') return true;
  if (relative === '..' || relative.startsWith(`..${flavor.sep}`)) return false;
  return !flavor.isAbsolute(relative);
}

function isAbsoluteEntry(entry: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|\\\\|\/\/)/.test(entry);
  return entry.startsWith('/');
}

/**
 * Commands are found through PATH. A program that the agent could write into the folder, and that
 * PATH reaches, would run under a read-only name, so every entry must be absolute and outside the
 * folder. An empty entry means the current directory, except on Windows, where Git Bash drops it.
 */
function pathVariableReason(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  roots: readonly string[],
): string | undefined {
  const names = Object.keys(env).filter((name) =>
    platform === 'win32' ? name.toLowerCase() === 'path' : name === 'PATH',
  );
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    for (const entry of value.split(platform === 'win32' ? ';' : ':')) {
      if (entry === '' && platform === 'win32') continue;
      if (entry === '') return 'path-variable:empty entry';
      if (!isAbsoluteEntry(entry, platform)) return `path-variable:relative entry ${entry}`;
      if (roots.some((root) => lexicallyUnder(root, entry, platform))) {
        return `path-variable:entry inside the folder ${entry}`;
      }
    }
  }
  return undefined;
}

/**
 * These variables point git at another repository, another configuration, or another program. The
 * comparison ignores case on Windows, where variable names do.
 */
function gitEnvironmentReason(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  const upper = (name: string): string => (platform === 'win32' ? name.toUpperCase() : name);
  const forbidden = new Set<string>(GIT_ENVIRONMENT);
  const found = Object.keys(env).find(
    (name) => env[name] !== undefined && forbidden.has(upper(name)),
  );
  return found === undefined ? undefined : `git-environment:${found}`;
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * git needs a `.git` directory of its own at the folder root. Without one, git walks up to a parent
 * repository (and `:/` or `HEAD:../x` then reach outside the folder), or treats the folder as a bare
 * repository when the agent has written `HEAD`, `objects` and `refs` into it, and runs its
 * configuration. A `.git` file (a linked worktree or a submodule) points elsewhere: refused too.
 */
async function gitRepositoryReason(realFolder: string): Promise<string | undefined> {
  const dotGit = join(realFolder, '.git');
  const ok =
    (await isRealDirectory(dotGit)) &&
    (await exists(join(dotGit, 'HEAD'))) &&
    (await isRealDirectory(join(dotGit, 'objects'))) &&
    (await isRealDirectory(join(dotGit, 'refs')));
  return ok ? undefined : 'git-no-repository';
}

/** True when both paths are the same real folder. */
function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string): string => (foldsCase(platform) ? value.toLowerCase() : value);
  return isInside(fold(a), fold(b)) && isInside(fold(b), fold(a));
}

async function cdFileSystemReason(
  target: string,
  context: PathContext,
): Promise<string | undefined> {
  const resolved = await resolveRef({ word: target, kind: 'path' }, context);
  if (!resolved.ok) return `cd:${resolved.reason}`;
  if (
    resolved.real === undefined ||
    !sameFolder(resolved.real, context.realFolder, context.platform)
  ) {
    return 'cd:not the workspace folder';
  }
  return undefined;
}

async function gateReason(
  analysis: Analysis,
  options: ReadOnlyCheckOptions,
  context: PathContext,
): Promise<string | undefined> {
  const { platform, realFolder, folderPath } = context;
  const env = options.env ?? process.env;
  const sensitive = await resolveSensitiveEnv(options.sensitiveRoots ?? (() => []));
  if (isSensitivePath(realFolder, sensitive) || containsSensitive(realFolder, sensitive)) {
    return 'sensitive-folder';
  }
  const pathReason = pathVariableReason(env, platform, [folderPath, realFolder]);
  if (pathReason !== undefined) return pathReason;
  if (!analysis.usesGit) return undefined;
  return gitEnvironmentReason(env, platform) ?? (await gitRepositoryReason(realFolder));
}

export async function checkReadOnlyCommand(
  command: string,
  options: ReadOnlyCheckOptions,
): Promise<ReadOnlyCheck> {
  const platform = options.platform ?? process.platform;
  // Synchronous first: every word is judged by its text before anything touches the disk.
  const analysis = analyze(command, platform);
  if ('reason' in analysis) return refused(analysis.reason);

  const realFolder = await realFolderPath(options.folderPath);
  const context: PathContext = { folderPath: options.folderPath, realFolder, platform };
  const gate = await gateReason(analysis, options, context);
  if (gate !== undefined) return refused(gate);

  if (analysis.cdTarget !== undefined) {
    const reason = await cdFileSystemReason(analysis.cdTarget, context);
    if (reason !== undefined) return refused(reason);
  }
  for (const ref of analysis.refs) {
    const reason = await pathRefReason(ref, context);
    if (reason !== undefined) return refused(reason);
  }
  return { readOnly: true };
}
