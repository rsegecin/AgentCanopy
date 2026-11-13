import { constants, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { FileState } from '../../../shared';
import { ALWAYS_CAPTURE_LIMIT, resolveInside, type BlobStore } from '../store';
import { errorCode, isVanished } from '../tracker/fs-util';
import { PresenceChecker } from '../tracker/presence';
import { decodeText } from './hunks';

/** What is on the disk at a path, read once. */
export type DiskRead =
  | { kind: 'absent' }
  | {
      kind: 'file';
      data: Buffer;
      hash: string;
      size: number;
      mode: number;
      binary: boolean;
    }
  | { kind: 'symlink'; target: string }
  /** A folder, a device, a pipe, or an item that only has this name in a different spelling. Never written over. */
  | { kind: 'other'; directory: boolean }
  /** A file too large to read into memory. */
  | { kind: 'too-large'; size: number };

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Reads the path exactly as named, once. A symlink is never followed. A name that is not in the
 * parent's listing byte for byte is "absent" unless something else answers to it, in which case it is
 * `other`: on a case-insensitive volume that something is a different file.
 */
export async function readDisk(root: string, rel: string): Promise<DiskRead> {
  const abs = resolveInside(root, rel);
  const present = await new PresenceChecker(root).isPresent(rel);
  let stats;
  try {
    stats = await fs.lstat(abs);
  } catch (error) {
    if (isVanished(error)) return { kind: 'absent' };
    throw error;
  }
  if (!present) return { kind: 'other', directory: stats.isDirectory() };
  if (stats.isSymbolicLink()) {
    try {
      return { kind: 'symlink', target: await fs.readlink(abs) };
    } catch (error) {
      if (isVanished(error)) return { kind: 'absent' };
      throw error;
    }
  }
  if (!stats.isFile()) return { kind: 'other', directory: stats.isDirectory() };

  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      abs,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isVanished(error)) return { kind: 'absent' };
    const code = errorCode(error);
    if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'other', directory: false };
    throw error;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) return { kind: 'other', directory: false };
    if (opened.size > ALWAYS_CAPTURE_LIMIT) return { kind: 'too-large', size: opened.size };
    // The file may grow while we read: read to the end, within the limit.
    let buffer = Buffer.allocUnsafe(opened.size + 1);
    let total = 0;
    for (;;) {
      if (total === buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, ALWAYS_CAPTURE_LIMIT + 1));
        buffer.copy(grown, 0, 0, total);
        buffer = grown;
      }
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > ALWAYS_CAPTURE_LIMIT) return { kind: 'too-large', size: total };
    }
    const data = Buffer.from(buffer.subarray(0, total));
    return {
      kind: 'file',
      data,
      hash: sha256(data),
      size: total,
      mode: process.platform === 'win32' ? 0 : opened.mode & 0o7777,
      binary: decodeText(data) === undefined,
    };
  } finally {
    await handle.close();
  }
}

/** Whether two reads show the same thing at the same name. `other` is never the same as anything. */
export function sameRead(a: DiskRead, b: DiskRead): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'absent') return true;
  if (a.kind === 'symlink') return b.kind === 'symlink' && a.target === b.target;
  if (a.kind === 'file') return b.kind === 'file' && a.hash === b.hash && a.mode === b.mode;
  return false;
}

/** The state of a read, for comparing and for records. `stored` says whether the bytes are in the blob store. */
export function readToState(read: DiskRead, stored: boolean): FileState | undefined {
  switch (read.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'symlink':
      return { kind: 'symlink', target: read.target };
    case 'file':
      return {
        kind: 'file',
        hash: read.hash,
        size: read.size,
        mode: read.mode,
        stored,
        binary: read.binary,
      };
    default:
      return undefined;
  }
}

/** The state of a read, with a file's bytes put into the blob store first so that `stored` is true. */
export async function captureReadState(
  blobs: BlobStore,
  read: DiskRead,
): Promise<FileState | undefined> {
  if (read.kind === 'file') await blobs.put(read.data);
  return readToState(read, true);
}
