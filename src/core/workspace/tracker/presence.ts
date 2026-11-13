import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { FileState } from '../../../shared';
import { ALWAYS_CAPTURE_LIMIT, toStatEntry, type BlobStore } from '../store';
import { errorCode, isVanished } from './fs-util';

/** What the helpers here need from a folder. */
export interface FolderLike {
  info: { path: string };
  blobs: BlobStore;
}

/**
 * Tells whether a path is really there, exactly as named: the parent directory's listing must hold
 * that very name, byte for byte, as a file or a symlink. `lstat` is not enough: on a
 * case-insensitive volume it finds a renamed file under its old name, and a directory that replaced
 * a file is not that file. Listings are cached for the life of the checker.
 */
export class PresenceChecker {
  private readonly listings = new Map<string, Map<string, boolean> | null | 'unknown'>();

  constructor(private readonly root: string) {}

  async isPresent(rel: string): Promise<boolean> {
    const slash = rel.lastIndexOf('/');
    const parent = slash < 0 ? '' : rel.slice(0, slash);
    const name = rel.slice(slash + 1);
    let listing = this.listings.get(parent);
    if (listing === undefined) {
      try {
        const entries = await fs.readdir(
          join(this.root, ...parent.split('/').filter((part) => part !== '')),
          { withFileTypes: true },
        );
        listing = new Map(
          entries.map((entry) => [entry.name, entry.isFile() || entry.isSymbolicLink()]),
        );
      } catch (error) {
        listing = isVanished(error) ? null : 'unknown';
      }
      this.listings.set(parent, listing);
    }
    // A folder we cannot list says nothing: do not claim the file is gone.
    if (listing === 'unknown') return true;
    return listing?.get(name) === true;
  }
}

async function lstatBig(abs: string) {
  try {
    return await fs.lstat(abs, { bigint: true });
  } catch (error) {
    if (isVanished(error) || errorCode(error) === 'ENAMETOOLONG') return undefined;
    throw error;
  }
}

/** The state of a path right now, captured into the blob store when it is a file. */
export async function captureCurrentState(folder: FolderLike, rel: string): Promise<FileState> {
  const abs = join(folder.info.path, ...rel.split('/'));
  const current = await lstatBig(abs);
  if (current === undefined) return { kind: 'absent' };
  if (current.isSymbolicLink()) return { kind: 'symlink', target: await fs.readlink(abs) };
  if (!current.isFile()) return { kind: 'absent' };
  const stat = toStatEntry(current, 'file');
  const result = await folder.blobs.captureFile(abs, ALWAYS_CAPTURE_LIMIT, { store: true });
  if (result.kind === 'captured') {
    return {
      kind: 'file',
      hash: result.hash,
      size: result.size,
      mode: stat.mode,
      stored: true,
      binary: result.binary,
    };
  }
  if (result.kind === 'too-large') {
    return { kind: 'file', size: result.size, mode: stat.mode, stored: false, binary: false };
  }
  return { kind: 'absent' };
}
