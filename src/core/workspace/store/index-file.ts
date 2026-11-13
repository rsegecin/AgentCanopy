import { promises as fs } from 'node:fs';
import type { FileState, RelPath } from '../../../shared';
import { writeFileAtomic } from '../../util/files';
import type { StatEntry } from './scanner';

/** What we last saw at a path, plus what we know about its content. */
export type IndexEntry = StatEntry & {
  /** sha256 of the content. Absent for symlinks and for files tracked by stat only. */
  hash?: string;
  /** True when the content is in the blob store. */
  stored: boolean;
  binary: boolean;
  /** Wall-clock time (ns since the epoch) when the content was read for hashing. */
  hashedAtNs?: bigint;
};

export type WorkspaceIndex = Map<RelPath, IndexEntry>;

const INDEX_VERSION = 1;
/** Timestamps have limited resolution; a file changed within this window of being hashed may look unchanged. */
const RACY_WINDOW_NS = 2_000_000_000n;

interface SerializedEntry {
  kind: 'file' | 'symlink';
  size: number;
  mtimeNs: string;
  ctimeNs: string;
  ino: string;
  dev: string;
  mode: number;
  target?: string;
  hash?: string;
  stored: boolean;
  binary: boolean;
  hashedAtNs?: string;
}

function serialize(entry: IndexEntry): SerializedEntry {
  const out: SerializedEntry = {
    kind: entry.kind,
    size: entry.size,
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
    ino: entry.ino.toString(),
    dev: entry.dev.toString(),
    mode: entry.mode,
    stored: entry.stored,
    binary: entry.binary,
  };
  if (entry.target !== undefined) out.target = entry.target;
  if (entry.hash !== undefined) out.hash = entry.hash;
  if (entry.hashedAtNs !== undefined) out.hashedAtNs = entry.hashedAtNs.toString();
  return out;
}

const DECIMAL = /^-?\d+$/;

function parseBig(value: unknown): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error('not a decimal string');
  return BigInt(value);
}

function parseEntry(raw: unknown): IndexEntry {
  if (typeof raw !== 'object' || raw === null) throw new Error('entry is not an object');
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'file' && r.kind !== 'symlink') throw new Error('bad kind');
  if (typeof r.size !== 'number' || !Number.isFinite(r.size) || r.size < 0)
    throw new Error('bad size');
  if (typeof r.mode !== 'number' || !Number.isInteger(r.mode) || r.mode < 0)
    throw new Error('bad mode');
  if (typeof r.stored !== 'boolean' || typeof r.binary !== 'boolean') throw new Error('bad flags');
  const entry: IndexEntry = {
    kind: r.kind,
    size: r.size,
    mtimeNs: parseBig(r.mtimeNs),
    ctimeNs: parseBig(r.ctimeNs),
    ino: parseBig(r.ino),
    dev: parseBig(r.dev),
    mode: r.mode,
    stored: r.stored,
    binary: r.binary,
  };
  if (r.target !== undefined) {
    if (typeof r.target !== 'string') throw new Error('bad target');
    entry.target = r.target;
  }
  if (r.hash !== undefined) {
    if (typeof r.hash !== 'string' || !/^[0-9a-f]{64}$/.test(r.hash)) throw new Error('bad hash');
    entry.hash = r.hash;
  }
  if (r.hashedAtNs !== undefined) entry.hashedAtNs = parseBig(r.hashedAtNs);
  return entry;
}

/** Loads the index. A missing or damaged file gives an empty index (everything is then re-examined). */
export async function loadIndex(file: string): Promise<WorkspaceIndex> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return new Map();
    const doc = parsed as { version?: unknown; entries?: unknown };
    if (doc.version !== INDEX_VERSION) return new Map();
    if (typeof doc.entries !== 'object' || doc.entries === null || Array.isArray(doc.entries)) {
      return new Map();
    }
    const index: WorkspaceIndex = new Map();
    for (const [path, raw] of Object.entries(doc.entries)) index.set(path, parseEntry(raw));
    return index;
  } catch {
    return new Map();
  }
}

/** Writes the index atomically. */
export async function saveIndex(file: string, index: WorkspaceIndex): Promise<void> {
  const entries: Record<string, SerializedEntry> = Object.create(null) as Record<
    string,
    SerializedEntry
  >;
  for (const [path, entry] of index) entries[path] = serialize(entry);
  await writeFileAtomic(file, JSON.stringify({ version: INDEX_VERSION, entries }));
}

/** True when anything the stat records differs. Says nothing about the content. */
export function statChanged(a: StatEntry, b: StatEntry): boolean {
  return (
    a.kind !== b.kind ||
    a.size !== b.size ||
    a.mtimeNs !== b.mtimeNs ||
    a.ctimeNs !== b.ctimeNs ||
    a.ino !== b.ino ||
    a.dev !== b.dev ||
    a.mode !== b.mode ||
    a.target !== b.target
  );
}

/**
 * True when the entry was hashed within two seconds of its own mtime or ctime. The file may have
 * changed again inside the timestamp resolution without any stat field moving, so it must be
 * re-hashed next time.
 */
export function isRacy(entry: IndexEntry): boolean {
  if (entry.hashedAtNs === undefined) return false;
  return (
    entry.hashedAtNs - entry.mtimeNs < RACY_WINDOW_NS ||
    entry.hashedAtNs - entry.ctimeNs < RACY_WINDOW_NS
  );
}

export function toFileState(entry: IndexEntry | undefined): FileState {
  if (entry === undefined) return { kind: 'absent' };
  if (entry.kind === 'symlink') return { kind: 'symlink', target: entry.target ?? '' };
  const state: FileState = {
    kind: 'file',
    size: entry.size,
    mode: entry.mode,
    stored: entry.stored,
    binary: entry.binary,
  };
  if (entry.hash !== undefined) state.hash = entry.hash;
  return state;
}
