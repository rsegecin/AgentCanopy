import type { BlobStore } from './blob-store';

/**
 * Deletes every blob that is not in `referenced`. The caller must make sure no capture is running
 * and that `referenced` covers everything that points at a blob, or a blob written a moment ago and
 * not yet referenced would be deleted.
 */
export async function collectGarbage(
  blobs: BlobStore,
  referenced: Set<string>,
): Promise<{ deleted: number; kept: number }> {
  let deleted = 0;
  let kept = 0;
  for (const hash of await blobs.list()) {
    if (referenced.has(hash)) {
      kept += 1;
    } else {
      await blobs.delete(hash);
      deleted += 1;
    }
  }
  return { deleted, kept };
}
