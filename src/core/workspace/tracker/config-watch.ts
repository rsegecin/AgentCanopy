import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { ConfigChange } from '../../../shared';
import { writeFileAtomic } from '../../util/files';
import type { BlobStore } from '../store';
import { checkParents } from '../store';
import { writeFileAtomicWithMode, errorCode, isVanished } from './fs-util';
import type { GitLocation } from './git-state';

/** Tool and editor configuration a command could use to make later commands run without asking. */
const FOLDER_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.mcp.json',
  '.vscode/settings.json',
  '.vscode/tasks.json',
  '.vscode/launch.json',
  '.vscode/mcp.json',
];
/** Directories whose files can add commands, hooks, skills or agents. Every file below them is watched. */
const FOLDER_DIRS = [
  '.claude/skills',
  '.claude/hooks',
  '.claude/commands',
  '.claude/agents',
  '.husky',
];
/** At most this many files are taken from those directories in one listing. */
export const MAX_WATCHED_TREE_FILES = 500;
const MAX_TREE_DEPTH = 8;
/** Contents up to this size are kept so the change can be shown and reverted. */
const MAX_STORED_BYTES = 1024 * 1024;
const MAX_HASHED_BYTES = 16 * 1024 * 1024;

export interface WatchedFile {
  abs: string;
  /** The directory it is relative to; revert checks parents from here. */
  root: string;
  /** Forward-slash path below `root`. */
  rel: string;
  /** Relative to the folder when inside it, else to the git root, else absolute. */
  display: string;
}

export interface ConfigFileState {
  /** `unreadable`: it could not be read or kept; it never counts as a change and cannot be reverted. */
  state: 'absent' | 'file' | 'other' | 'unreadable';
  hash?: string;
  mode: number;
  size: number;
  /** True when the content is in the blob store. */
  stored: boolean;
}

export const ABSENT: ConfigFileState = { state: 'absent', mode: 0, size: 0, stored: false };
export const UNREADABLE: ConfigFileState = { state: 'unreadable', mode: 0, size: 0, stored: false };

const ConfigFileStateSchema = z.object({
  state: z.enum(['absent', 'file', 'other', 'unreadable']),
  hash: z.string().optional(),
  mode: z.number(),
  size: z.number(),
  stored: z.boolean(),
});

export const ConfigChangeRecordSchema = z.object({
  id: z.string(),
  displayPath: z.string(),
  abs: z.string(),
  root: z.string(),
  rel: z.string(),
  changeType: z.enum(['created', 'modified', 'deleted']),
  revertible: z.boolean(),
  detectedAt: z.number(),
  before: ConfigFileStateSchema,
  after: ConfigFileStateSchema,
});
export type ConfigChangeRecord = z.infer<typeof ConfigChangeRecordSchema>;

const StoredChangesSchema = z.object({
  version: z.literal(1),
  folder: z.object({ key: z.string(), name: z.string(), path: z.string() }),
  changes: z.array(ConfigChangeRecordSchema),
});
export type StoredChanges = z.infer<typeof StoredChangesSchema>;

function sha256(text: string | Uint8Array): string {
  return createHash('sha256').update(text).digest('hex');
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(/[\\/]/).join('/');
}

function insideDir(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function displayFor(abs: string, folderPath: string, gitRoot: string | undefined): string {
  if (insideDir(folderPath, abs)) return posixRelative(folderPath, abs);
  if (gitRoot && insideDir(gitRoot, abs)) return posixRelative(gitRoot, abs);
  return abs;
}

/** Regular files and symlinks below a directory, sorted, depth-limited, sharing one budget. */
async function walkTree(
  dir: string,
  rel: string,
  budget: { left: number },
  depth: number,
): Promise<string[]> {
  if (depth > MAX_TREE_DEPTH || budget.left <= 0) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    const childRel = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkTree(join(dir, entry.name), childRel, budget, depth + 1)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      budget.left -= 1;
      out.push(childRel);
    }
  }
  return out;
}

/** The files to watch for this folder right now. */
export async function listWatched(
  folderPath: string,
  git: GitLocation | undefined,
): Promise<WatchedFile[]> {
  const out = new Map<string, WatchedFile>();
  const add = (root: string, rel: string): void => {
    const abs = join(root, ...rel.split('/'));
    if (!out.has(abs)) {
      out.set(abs, { abs, root, rel, display: displayFor(abs, folderPath, git?.root) });
    }
  };
  const roots = [folderPath];
  if (git && git.root !== folderPath) roots.push(git.root);
  const budget = { left: MAX_WATCHED_TREE_FILES };
  for (const root of roots) {
    for (const rel of FOLDER_FILES) add(root, rel);
    for (const dirRel of FOLDER_DIRS) {
      for (const rel of await walkTree(join(root, ...dirRel.split('/')), dirRel, budget, 0)) {
        add(root, rel);
      }
    }
  }
  if (git) {
    add(git.commonDir, 'config');
    if (git.gitDir !== git.commonDir) add(git.gitDir, 'config');
    for (const dir of new Set([git.commonDir, git.gitDir])) {
      try {
        for (const entry of await fs.readdir(join(dir, 'hooks'), { withFileTypes: true })) {
          if ((entry.isFile() || entry.isSymbolicLink()) && !entry.name.endsWith('.sample')) {
            add(dir, `hooks/${entry.name}`);
          }
        }
      } catch {
        // No hooks directory.
      }
    }
  }
  return [...out.values()];
}

/**
 * Reads one file's state. With `blobs`, content up to 1 MB is stored so it can be shown and restored;
 * without, it is only hashed.
 */
export async function readConfigState(abs: string, blobs?: BlobStore): Promise<ConfigFileState> {
  let stats;
  try {
    stats = await fs.lstat(abs);
  } catch (error) {
    if (isVanished(error)) return ABSENT;
    throw error;
  }
  const mode = process.platform === 'win32' ? 0 : stats.mode & 0o7777;
  if (stats.isSymbolicLink()) {
    const target = await fs.readlink(abs).catch(() => '');
    return { state: 'other', hash: sha256(`symlink:${target}`), mode, size: 0, stored: false };
  }
  if (!stats.isFile()) {
    return { state: 'other', hash: sha256('not-a-file'), mode, size: 0, stored: false };
  }
  if (stats.size > MAX_HASHED_BYTES) {
    return {
      state: 'file',
      hash: sha256(`too-large:${stats.size}`),
      mode,
      size: stats.size,
      stored: false,
    };
  }
  const store = blobs !== undefined && stats.size <= MAX_STORED_BYTES;
  if (blobs) {
    const result = await blobs.captureFile(abs, MAX_HASHED_BYTES, { store });
    if (result.kind === 'captured') {
      return { state: 'file', hash: result.hash, mode, size: result.size, stored: store };
    }
    if (result.kind === 'gone') return ABSENT;
    return { state: 'other', hash: sha256('not-a-file'), mode, size: 0, stored: false };
  }
  try {
    const bytes = await fs.readFile(abs);
    return { state: 'file', hash: sha256(bytes), mode, size: bytes.length, stored: false };
  } catch (error) {
    if (isVanished(error)) return ABSENT;
    throw error;
  }
}

export function sameConfigState(a: ConfigFileState, b: ConfigFileState): boolean {
  return a.state === b.state && a.hash === b.hash && (a.state !== 'file' || a.mode === b.mode);
}

export type ConfigSnapshot = Map<string, ConfigFileState>;

export async function snapshotConfig(
  watched: WatchedFile[],
  blobs: BlobStore,
): Promise<ConfigSnapshot> {
  const snapshot: ConfigSnapshot = new Map();
  for (const file of watched) {
    try {
      snapshot.set(file.abs, await readConfigState(file.abs, blobs));
    } catch {
      // Could not be read or kept: it must not block the turn, and must never look created or changed.
      snapshot.set(file.abs, UNREADABLE);
    }
  }
  return snapshot;
}

/** Every difference between two snapshots, as persisted records. */
export function diffConfig(
  before: ConfigSnapshot,
  after: ConfigSnapshot,
  watched: Map<string, WatchedFile>,
  now: number,
): ConfigChangeRecord[] {
  const records: ConfigChangeRecord[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const abs of [...paths].sort()) {
    const file = watched.get(abs);
    if (!file) continue;
    const b = before.get(abs) ?? ABSENT;
    const a = after.get(abs) ?? ABSENT;
    if (b.state === 'unreadable' || a.state === 'unreadable') continue;
    if (sameConfigState(b, a)) continue;
    records.push({
      id: randomUUID(),
      displayPath: file.display,
      abs,
      root: file.root,
      rel: file.rel,
      changeType: b.state === 'absent' ? 'created' : a.state === 'absent' ? 'deleted' : 'modified',
      revertible: b.state === 'absent' || (b.state === 'file' && b.stored),
      detectedAt: now,
      before: b,
      after: a,
    });
  }
  return records;
}

export function toConfigChange(record: ConfigChangeRecord): ConfigChange {
  return {
    id: record.id,
    displayPath: record.displayPath,
    changeType: record.changeType,
    revertible: record.revertible,
    detectedAt: record.detectedAt,
  };
}

/** The persisted list of configuration changes waiting for a decision, for one folder. */
export class ConfigChangeList {
  private records: ConfigChangeRecord[] = [];

  constructor(
    private readonly file: string,
    private folder: { key: string; name: string; path: string },
  ) {}

  /** Synchronous so that the list is available before the folder has been opened. */
  static loadSync(
    file: string,
    folder: { key: string; name: string; path: string },
    readFileSync: (path: string) => string,
  ): ConfigChangeList {
    const list = new ConfigChangeList(file, folder);
    try {
      const parsed = StoredChangesSchema.safeParse(JSON.parse(readFileSync(file)));
      if (parsed.success) {
        list.records = parsed.data.changes;
        list.folder = parsed.data.folder;
      }
    } catch {
      // Missing or damaged: no pending changes known.
    }
    return list;
  }

  /** Remembers where the folder is, so a later run can open it from the list alone. */
  adopt(folder: { key: string; name: string; path: string }): void {
    this.folder = folder;
  }

  get folderInfo(): { key: string; name: string; path: string } {
    return this.folder;
  }

  all(): readonly ConfigChangeRecord[] {
    return this.records;
  }

  find(id: string): ConfigChangeRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  async add(records: ConfigChangeRecord[]): Promise<void> {
    this.records = [...this.records, ...records];
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.records = this.records.filter((record) => record.id !== id);
    await this.save();
  }

  private async save(): Promise<void> {
    const stored: StoredChanges = { version: 1, folder: this.folder, changes: this.records };
    await writeFileAtomic(this.file, JSON.stringify(stored));
  }
}

/**
 * Puts the file back as it was before the turn. Refuses when the file is not as the turn left it,
 * or when a parent directory is a symlink. Writes by temp file and rename.
 */
export async function revertConfigFile(
  record: ConfigChangeRecord,
  blobs: BlobStore,
): Promise<void> {
  if (!record.revertible) {
    throw new Error('The earlier content of this file was not kept, so it cannot be reverted.');
  }
  const current = await readConfigState(record.abs);
  if (!sameConfigState(current, record.after)) {
    throw new Error('The file changed again since the turn ended.');
  }
  const parents = await checkParents(record.root, record.rel);
  if (!parents.ok) {
    throw new Error(
      `AgentCanopy will not write through ${parents.at}: it is ${
        parents.reason === 'symlink' ? 'a symbolic link' : 'not a folder'
      }.`,
    );
  }
  if (record.before.state === 'absent') {
    try {
      await fs.unlink(record.abs);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    return;
  }
  if (!record.before.hash) throw new Error('The earlier content of this file was not kept.');
  const bytes = await blobs.get(record.before.hash);
  await fs.mkdir(dirname(record.abs), { recursive: true });
  await writeFileAtomicWithMode(record.abs, bytes, record.before.mode || 0o644);
}

/** Both sides as UTF-8, or undefined when either was not kept or is not text. */
export async function configTexts(
  record: ConfigChangeRecord,
  blobs: BlobStore,
): Promise<{ before: string; after: string } | undefined> {
  const text = async (state: ConfigFileState): Promise<string | undefined> => {
    if (state.state === 'absent') return '';
    if (state.state !== 'file' || !state.stored || !state.hash) return undefined;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(await blobs.get(state.hash));
    } catch {
      return undefined;
    }
  };
  const [before, after] = [await text(record.before), await text(record.after)];
  return before === undefined || after === undefined ? undefined : { before, after };
}
