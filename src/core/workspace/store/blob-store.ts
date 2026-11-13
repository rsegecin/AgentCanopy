import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import { errorCode, isVanished } from './internal';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const SHARD_PATTERN = /^[0-9a-f]{2}$/;
const REST_PATTERN = /^[0-9a-f]{62}$/;

/** The blob exists but its bytes do not match its hash, or it is not a valid gzip stream. */
export class BlobCorruptError extends Error {
  override name = 'BlobCorruptError';
  constructor(
    readonly hash: string,
    detail: string,
  ) {
    super(`Blob ${hash} is corrupt: ${detail}`);
  }
}

/** No blob with this hash is stored. */
export class BlobMissingError extends Error {
  override name = 'BlobMissingError';
  constructor(readonly hash: string) {
    super(`Blob ${hash} is not in the store`);
  }
}

export interface CaptureOptions {
  /** Default true. When false the bytes are read and hashed but not written to the store. */
  store?: boolean;
}

export type CaptureResult =
  | {
      kind: 'captured';
      hash: string;
      /** Number of bytes read, which is exactly what `hash` describes. */
      size: number;
      binary: boolean;
      /** Compressed bytes newly written to the store (0 when the blob already existed or was not stored). */
      storedBytes?: number;
    }
  | { kind: 'too-large'; size: number }
  | { kind: 'gone' }
  | { kind: 'not-regular' };

export interface BlobStore {
  /** Stores the bytes and returns their sha256 hex. A blob that already exists is left alone. */
  put(data: Buffer): Promise<string>;
  has(hash: string): Promise<boolean>;
  /** Returns the verified bytes. Throws `BlobMissingError` or `BlobCorruptError`. */
  get(hash: string): Promise<Buffer>;
  delete(hash: string): Promise<void>;
  list(): Promise<string[]>;
  /** Compressed size of all blobs on disk. */
  totalBytes(): Promise<number>;
  /**
   * Reads a file once, from one handle, then hashes and stores exactly those bytes. Never follows a
   * symlink at the final path component.
   */
  captureFile(
    absolutePath: string,
    maxBytes: number,
    options?: CaptureOptions,
  ): Promise<CaptureResult>;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isBinary(data: Buffer): boolean {
  if (data.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
}

/**
 * Writes a blob by temp file and rename, so it is either absent or complete. It is not fsynced: that
 * costs about 5 ms a file (a 60,000-file baseline would take minutes), and a blob that a power loss
 * leaves empty is caught by the hash check in `get`, which reports it corrupt instead of returning bad bytes.
 */
async function writeBlobFile(path: string, data: Buffer): Promise<void> {
  const tmp = join(dirname(path), `.tmp-${randomBytes(8).toString('hex')}`);
  const handle = await fs.open(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(data);
  } catch (error) {
    await handle.close();
    await fs.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await fs.rename(tmp, path);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export function createBlobStore(dir: string): BlobStore {
  const pathOf = (hash: string): string => join(dir, hash.slice(0, 2), hash.slice(2));

  async function exists(hash: string): Promise<boolean> {
    try {
      return (await fs.lstat(pathOf(hash))).isFile();
    } catch (error) {
      if (isVanished(error)) return false;
      throw error;
    }
  }

  async function putBytes(data: Buffer): Promise<{ hash: string; written: number }> {
    const hash = sha256(data);
    if (await exists(hash)) return { hash, written: 0 };
    const compressed = await gzipAsync(data, { level: 1 });
    await fs.mkdir(join(dir, hash.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeBlobFile(pathOf(hash), compressed);
    return { hash, written: compressed.length };
  }

  /** Calls `visit` for every well-formed blob file, shard by shard. */
  async function visitBlobs(visit: (hash: string) => Promise<void>): Promise<void> {
    let shards: string[];
    try {
      shards = await fs.readdir(dir);
    } catch (error) {
      if (isVanished(error)) return;
      throw error;
    }
    for (const shard of shards.sort()) {
      if (!SHARD_PATTERN.test(shard)) continue;
      let names: string[];
      try {
        names = await fs.readdir(join(dir, shard));
      } catch (error) {
        if (isVanished(error)) continue;
        throw error;
      }
      await Promise.all(
        names.filter((name) => REST_PATTERN.test(name)).map((name) => visit(shard + name)),
      );
    }
  }

  return {
    async put(data) {
      return (await putBytes(data)).hash;
    },

    async has(hash) {
      return HASH_PATTERN.test(hash) && (await exists(hash));
    },

    async get(hash) {
      if (!HASH_PATTERN.test(hash)) throw new BlobMissingError(hash);
      let compressed: Buffer;
      try {
        compressed = await fs.readFile(pathOf(hash));
      } catch (error) {
        if (isVanished(error)) throw new BlobMissingError(hash);
        throw error;
      }
      let data: Buffer;
      try {
        data = await gunzipAsync(compressed);
      } catch (error) {
        throw new BlobCorruptError(hash, error instanceof Error ? error.message : 'gzip error');
      }
      if (sha256(data) !== hash)
        throw new BlobCorruptError(hash, 'content does not match its hash');
      return data;
    },

    async delete(hash) {
      if (!HASH_PATTERN.test(hash)) return;
      try {
        await fs.unlink(pathOf(hash));
      } catch (error) {
        if (!isVanished(error)) throw error;
      }
    },

    async list() {
      const hashes: string[] = [];
      await visitBlobs((hash) => {
        hashes.push(hash);
        return Promise.resolve();
      });
      return hashes.sort();
    },

    async totalBytes() {
      let total = 0;
      await visitBlobs(async (hash) => {
        try {
          total += (await fs.lstat(pathOf(hash))).size;
        } catch (error) {
          if (!isVanished(error)) throw error;
        }
      });
      return total;
    },

    async captureFile(absolutePath, maxBytes, options = {}) {
      try {
        const before = await fs.lstat(absolutePath);
        if (!before.isFile()) return { kind: 'not-regular' };
      } catch (error) {
        if (isVanished(error)) return { kind: 'gone' };
        throw error;
      }

      // O_NOFOLLOW closes the window between the lstat above and the open; O_NONBLOCK keeps a FIFO
      // swapped in at that moment from blocking us. Both are 0 where the platform lacks them.
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(
          absolutePath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
      } catch (error) {
        if (isVanished(error)) return { kind: 'gone' };
        const code = errorCode(error);
        if (code === 'ELOOP' || code === 'EMLINK') return { kind: 'not-regular' };
        throw error;
      }

      try {
        const stats = await handle.stat();
        if (!stats.isFile()) return { kind: 'not-regular' };
        if (stats.size > maxBytes) return { kind: 'too-large', size: stats.size };

        // The file may grow while we read, so read until EOF with the limit enforced as we go.
        let buffer = Buffer.allocUnsafe(stats.size + 1);
        let total = 0;
        for (;;) {
          if (total === buffer.length) {
            const grown = Buffer.allocUnsafe(
              Math.min(Math.max(buffer.length * 2, 64 * 1024), maxBytes + 1),
            );
            buffer.copy(grown, 0, 0, total);
            buffer = grown;
          }
          const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > maxBytes) return { kind: 'too-large', size: total };
        }

        const data = buffer.subarray(0, total);
        const binary = isBinary(data);
        if (options.store === false) {
          return { kind: 'captured', hash: sha256(data), size: total, binary, storedBytes: 0 };
        }
        const { hash, written } = await putBytes(data);
        return { kind: 'captured', hash, size: total, binary, storedBytes: written };
      } finally {
        await handle.close();
      }
    },
  };
}
