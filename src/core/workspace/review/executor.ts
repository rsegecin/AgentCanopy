import { randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileState, RelPath } from '../../../shared';
import { PathEscapeError, checkParents, resolveInside, type BlobStore } from '../store';
import { isVanished } from '../tracker/fs-util';
import { captureReadState, readDisk, readToState, sameRead, sha256, type DiskRead } from './disk';

/**
 * The one place where the review engine (and, later, checkpoint restore) writes to the workspace.
 *
 * `planWrite` checks a write without making it. `applyWrite` makes it: the file's current content is
 * put in the blob store first, the new content goes to a temporary file in the same directory and is
 * renamed over the target, the result is read back and compared, and when it does not match the
 * previous content is put back. Directories are never removed, and nothing is followed through a link.
 * Every check is repeated right before the rename, because the disk can change under us.
 */

export const LINK_PARENT_MESSAGE =
  'A parent folder of this path is a link, so AgentCanopy will not write through it.';
export const PARENT_NOT_FOLDER_MESSAGE =
  'Something that is not a folder is in the way of this path, so nothing was written.';
export const FOLDER_IN_THE_WAY_MESSAGE = 'A folder now exists at this path.';
export const OTHER_IN_THE_WAY_MESSAGE =
  'Something other than a regular file or link is at this path, so AgentCanopy left it alone.';
export const TOO_LARGE_MESSAGE =
  'This file is too large for AgentCanopy to replace safely, so it was left alone.';
export const OUTSIDE_MESSAGE = 'This path is not inside the workspace folder.';
export const NO_SPACE_MESSAGE =
  'There is not enough free disk space to write this file safely, so nothing was written.';
export const CHANGED_DURING_MESSAGE =
  'This file changed while AgentCanopy was working on it, so nothing was written.';
export const CHANGED_WHILE_WRITING_MESSAGE =
  'The file changed while AgentCanopy was writing it. It was left as it is now.';
export const CHANGED_WHILE_WRITING_NOTE =
  'The file was changed by something else while AgentCanopy was writing it. AgentCanopy left it as it found it and kept a copy of that version.';

/** Room kept free on top of the content size. */
const FREE_SPACE_MARGIN = 1024 * 1024;

export type WriteTarget =
  /** The path becomes a regular file with these bytes and permission bits. */
  | { kind: 'file'; data: Uint8Array; mode: number }
  | { kind: 'symlink'; target: string }
  /** The path is removed with `unlink`. */
  | { kind: 'delete' };

export interface WriteRequest {
  path: RelPath;
  target: WriteTarget;
  /**
   * How many bytes the write needs when `target.data` is not loaded yet (a plan made before the
   * content is read). Only used for the free-space check.
   */
  sizeHint?: number;
  /**
   * What the caller saw on the disk when it decided to write. The write is refused if the disk shows
   * anything else at the moment of writing.
   */
  observed: DiskRead;
}

export interface ExecutorHooks {
  /** Changes the bytes that are written to the temporary file. For tests that simulate a bad write. */
  filterWrite?(path: string, data: Buffer): Buffer;
  /** Free bytes on the volume of `dir`, undefined when unknown. Default: `fs.statfs`. */
  freeBytes?(dir: string): Promise<number | undefined>;
  /** Runs after the temporary file exists and before the final checks and the rename. */
  beforeRename?(path: string): Promise<void>;
  /** Runs right after the rename, before the result is read back. */
  afterRename?(path: string): Promise<void>;
  /** Runs after the safety copy of a file to delete and before the last look and the `unlink`. */
  beforeUnlink?(path: string): Promise<void>;
}

export interface ExecutorContext {
  /** The workspace folder. */
  root: string;
  blobs: BlobStore;
  hooks?: ExecutorHooks;
}

export interface WritePlan {
  request: WriteRequest;
  abs: string;
  /** Bytes the write needs on the volume, without the safety margin. */
  bytesNeeded: number;
}

export type PlanResult = { ok: true; plan: WritePlan } | { ok: false; message: string };

export type WriteOutcome =
  | {
      ok: true;
      path: RelPath;
      /** The disk before the write, with its content in the blob store. */
      before: FileState;
      /** The disk after the write, read back. */
      after: FileState;
    }
  /** Nothing on the disk changed. */
  | { ok: false; changed: false; path: RelPath; message: string }
  /** The disk is not as it was and not as intended; `before` and `after` say what it was and is, and `after` is kept in the blob store. */
  | {
      ok: false;
      changed: true;
      path: RelPath;
      message: string;
      /** For the log: why the record exists although the write failed. */
      note: string;
      before: FileState;
      after: FileState;
    };

/**
 * Checks that every existing parent is a real directory (not a link) and that its real path is where
 * the name says. Returns the reason in plain words, or undefined when the parents are fine.
 */
export async function parentProblem(root: string, rel: string): Promise<string | undefined> {
  const check = await checkParents(root, rel);
  if (!check.ok)
    return check.reason === 'symlink' ? LINK_PARENT_MESSAGE : PARENT_NOT_FOLDER_MESSAGE;
  const segments = rel.split('/').slice(0, -1);
  if (segments.length === 0) return undefined;
  const realRoot = await fs.realpath(root);
  try {
    const real = await fs.realpath(join(root, ...segments));
    if (real !== join(realRoot, ...segments)) return LINK_PARENT_MESSAGE;
  } catch (error) {
    if (!isVanished(error)) throw error;
  }
  return undefined;
}

async function defaultFreeBytes(dir: string): Promise<number | undefined> {
  const statfs = (
    fs as {
      statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
    }
  ).statfs;
  if (typeof statfs !== 'function') return undefined;
  try {
    const stats = await statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

/** The nearest directory at or above `dir` that exists. */
async function existingDirectory(root: string, dir: string): Promise<string> {
  let current = dir;
  while (current !== root && current !== dirname(current)) {
    try {
      await fs.stat(current);
      return current;
    } catch (error) {
      if (!isVanished(error)) throw error;
      current = dirname(current);
    }
  }
  return root;
}

/** Checks a write without making it: the path, its parents, what is there, and the free space. */
export async function planWrite(ctx: ExecutorContext, request: WriteRequest): Promise<PlanResult> {
  let abs: string;
  try {
    abs = resolveInside(ctx.root, request.path);
  } catch (error) {
    if (error instanceof PathEscapeError) return { ok: false, message: OUTSIDE_MESSAGE };
    throw error;
  }
  const problem = await parentProblem(ctx.root, request.path);
  if (problem !== undefined) return { ok: false, message: problem };

  const { observed, target } = request;
  if (observed.kind === 'other') {
    return {
      ok: false,
      message: observed.directory ? FOLDER_IN_THE_WAY_MESSAGE : OTHER_IN_THE_WAY_MESSAGE,
    };
  }
  if (observed.kind === 'too-large') return { ok: false, message: TOO_LARGE_MESSAGE };

  const bytesNeeded =
    target.kind === 'file' ? Math.max(target.data.length, request.sizeHint ?? 0) : 0;
  if (target.kind !== 'delete') {
    const free = await (ctx.hooks?.freeBytes ?? defaultFreeBytes)(
      await existingDirectory(ctx.root, dirname(abs)),
    );
    if (free !== undefined && free < bytesNeeded + FREE_SPACE_MARGIN) {
      return { ok: false, message: NO_SPACE_MESSAGE };
    }
  }
  return { ok: true, plan: { request, abs, bytesNeeded } };
}

async function createTemp(abs: string, target: WriteTarget, data?: Buffer): Promise<string> {
  const tmp = join(dirname(abs), `.agentcanopy-${randomBytes(6).toString('hex')}.tmp`);
  if (target.kind === 'symlink') {
    await fs.symlink(target.target, tmp);
    return tmp;
  }
  if (target.kind !== 'file' || data === undefined) throw new Error('nothing to write');
  const handle = await fs.open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(data);
    if (process.platform !== 'win32') await handle.chmod(target.mode);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  return tmp;
}

function matches(read: DiskRead, target: WriteTarget): boolean {
  if (target.kind === 'delete') return read.kind === 'absent';
  if (target.kind === 'symlink') return read.kind === 'symlink' && read.target === target.target;
  return read.kind === 'file' && read.hash === sha256(target.data);
}

/**
 * The disk is not what a write left. Whatever is there now was put there by someone else: it is
 * kept in the blob store and reported, never written over. When it is what was there before, nothing happened.
 */
async function foundAfterwards(
  ctx: ExecutorContext,
  path: RelPath,
  before: DiskRead,
  beforeState: FileState,
): Promise<WriteOutcome> {
  const now = await readDisk(ctx.root, path).catch(() => undefined);
  if (now !== undefined && sameRead(now, before)) {
    return { ok: false, changed: false, path, message: CHANGED_WHILE_WRITING_MESSAGE };
  }
  const after = now === undefined ? undefined : await captureReadState(ctx.blobs, now);
  return {
    ok: false,
    changed: true,
    path,
    message: CHANGED_WHILE_WRITING_MESSAGE,
    note: CHANGED_WHILE_WRITING_NOTE,
    before: beforeState,
    after: after ?? beforeState,
  };
}

/**
 * Makes one planned write. Never throws for a problem that left the disk unchanged: that is a
 * `changed: false` outcome. It throws only when something unexpected happened before anything was changed.
 */
export async function applyWrite(ctx: ExecutorContext, plan: WritePlan): Promise<WriteOutcome> {
  const { path, target, observed } = plan.request;
  const abs = plan.abs;
  const refused = (message: string): WriteOutcome => ({ ok: false, changed: false, path, message });
  let tmp: string | undefined;
  let mutated = false;
  let before: DiskRead | undefined;
  let beforeState: FileState | undefined;
  try {
    const problem = await parentProblem(ctx.root, path);
    if (problem !== undefined) return refused(problem);
    // The disk must still show what the caller decided on. This read is also the copy we keep.
    before = await readDisk(ctx.root, path);
    if (!sameRead(before, observed)) return refused(CHANGED_DURING_MESSAGE);
    beforeState = await captureReadState(ctx.blobs, before);
    if (beforeState === undefined) return refused(OTHER_IN_THE_WAY_MESSAGE);

    if (target.kind === 'delete') {
      if (before.kind === 'absent')
        return { ok: true, path, before: beforeState, after: beforeState };
      await ctx.hooks?.beforeUnlink?.(path);
      // Last look before the unlink, as before a rename.
      const lastProblem = await parentProblem(ctx.root, path);
      if (lastProblem !== undefined) return refused(lastProblem);
      if (!sameRead(await readDisk(ctx.root, path), observed)) {
        return refused(CHANGED_DURING_MESSAGE);
      }
      await fs.unlink(abs);
      mutated = true;
      const after = await readDisk(ctx.root, path);
      if (after.kind !== 'absent') return await foundAfterwards(ctx, path, before, beforeState);
      return { ok: true, path, before: beforeState, after: { kind: 'absent' } };
    }

    // The new content is stored before anything refers to it.
    let data: Buffer | undefined;
    if (target.kind === 'file') {
      data = Buffer.from(target.data);
      await ctx.blobs.put(data);
    }
    await fs.mkdir(dirname(abs), { recursive: true });
    const afterMkdir = await parentProblem(ctx.root, path);
    if (afterMkdir !== undefined) return refused(afterMkdir);

    const toWrite = data === undefined ? undefined : (ctx.hooks?.filterWrite?.(path, data) ?? data);
    tmp = await createTemp(abs, target, toWrite);
    await ctx.hooks?.beforeRename?.(path);

    // Last look before the rename.
    const lastProblem = await parentProblem(ctx.root, path);
    if (lastProblem !== undefined) return refused(lastProblem);
    if (!sameRead(await readDisk(ctx.root, path), observed)) return refused(CHANGED_DURING_MESSAGE);

    await fs.rename(tmp, abs);
    tmp = undefined;
    mutated = true;

    await ctx.hooks?.afterRename?.(path);
    const written = await readDisk(ctx.root, path);
    if (!matches(written, target)) return await foundAfterwards(ctx, path, before, beforeState);
    const after = readToState(written, true);
    if (after === undefined) return await foundAfterwards(ctx, path, before, beforeState);
    return { ok: true, path, before: beforeState, after };
  } catch (error) {
    if (!mutated || before === undefined || beforeState === undefined) throw error;
    // Something went wrong after the disk may have changed: say what is there now.
    return await foundAfterwards(ctx, path, before, beforeState);
  } finally {
    if (tmp !== undefined) await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Applies planned writes one after the other. A failed write does not stop the rest. */
export async function applyWrites(
  ctx: ExecutorContext,
  plans: readonly WritePlan[],
): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = [];
  for (const plan of plans) {
    try {
      outcomes.push(await applyWrite(ctx, plan));
    } catch (error) {
      outcomes.push({
        ok: false,
        changed: false,
        path: plan.request.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}
