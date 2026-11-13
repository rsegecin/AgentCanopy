import type { ChangeType, FileState } from '../../../shared';
import { BlobCorruptError, BlobMissingError, type BlobStore } from '../store';
import { MAX_TEXT_BYTES, decodeText } from './hunks';

export const NOT_RESTORABLE_NOTE =
  'The earlier content of this file was not kept, so it cannot be put back.';

/**
 * Whether two states are the same. Files are equal only when both have a hash and the hashes and
 * modes match: a state without a hash is never equal to anything, so nothing is overwritten on a guess.
 */
export function statesEqual(a: FileState, b: FileState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'absent') return true;
  if (a.kind === 'symlink') return b.kind === 'symlink' && a.target === b.target;
  if (b.kind !== 'file') return false;
  if (a.hash === undefined || b.hash === undefined) return false;
  return a.hash === b.hash && a.mode === b.mode;
}

export function hashOf(state: FileState): string | undefined {
  return state.kind === 'file' ? state.hash : undefined;
}

/** Whether the earlier content can be put back: absent, a link, or a file whose bytes were kept. */
export function isRestorable(baseline: FileState): boolean {
  if (baseline.kind === 'absent' || baseline.kind === 'symlink') return true;
  return baseline.stored && baseline.hash !== undefined;
}

export function changeTypeOf(baseline: FileState, current: FileState): ChangeType {
  if (baseline.kind === 'absent') return 'created';
  if (current.kind === 'absent') return 'deleted';
  if (baseline.kind !== current.kind) return 'type';
  if (
    baseline.kind === 'file' &&
    current.kind === 'file' &&
    baseline.hash !== undefined &&
    baseline.hash === current.hash &&
    baseline.mode !== current.mode
  ) {
    return 'mode';
  }
  return 'modified';
}

/** The stored bytes of a file state, or undefined when they are not there or not trustworthy. */
export async function readStoredBytes(
  blobs: BlobStore,
  state: FileState,
): Promise<Buffer | undefined> {
  if (state.kind !== 'file' || !state.stored || state.hash === undefined) return undefined;
  try {
    const data = await blobs.get(state.hash);
    // The hash was verified by the store; the size recorded in the state must agree as well.
    return data.length === state.size ? data : undefined;
  } catch (error) {
    if (error instanceof BlobMissingError || error instanceof BlobCorruptError) return undefined;
    throw error;
  }
}

/** The text of a stored file state: UTF-8 without NUL, within the size limit. */
export async function readStoredText(
  blobs: BlobStore,
  state: FileState,
): Promise<string | undefined> {
  if (state.kind !== 'file' || state.binary || state.size > MAX_TEXT_BYTES) return undefined;
  const data = await readStoredBytes(blobs, state);
  return data === undefined ? undefined : decodeText(data);
}

/**
 * The mode after undoing the agent's part of a change while keeping the user's. `agentMode` is the
 * mode the agent left, `earlierMode` the mode before the agent, `userMode` the mode the user's version
 * has. The user's mode wins whenever the user changed it.
 */
export function mergeMode(agentMode: number, earlierMode: number, userMode: number): number {
  return userMode === agentMode ? earlierMode : userMode;
}
