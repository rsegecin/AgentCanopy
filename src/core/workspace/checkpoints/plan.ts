import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type {
  Attribution,
  CheckpointSummary,
  FileState,
  FolderKey,
  OperationId,
  RelPath,
  RestoreItem,
} from '../../../shared';
import type { EditorPort, LogRecord, OperationRecord } from '../../contracts';
import { readDisk, readToState, type DiskRead } from '../review/disk';
import { planWrite, type ExecutorContext, type WriteRequest } from '../review/executor';
import { statesEqual } from '../review/states';
import { checkParents, resolveInside } from '../store';
import type { FolderWorkspace } from '../tracker';

export const NOT_CAPTURED_NOTE = 'The content of this file at that point was not kept.';
export const UNSAVED_NOTE =
  'This file has unsaved changes in the editor. Save or discard them first.';
export const CHANGED_SINCE_NOTE =
  'This file changed after the last recorded state. Restoring it discards that change.';
export const USER_EDIT_NOTE =
  "This file also contains changes that were not the agent's since that point. Restoring it discards them.";

/** Changes made by these hands may include the user's own work. */
const UNCERTAIN: ReadonlySet<Attribution> = new Set<Attribution>([
  'user',
  'mixed',
  'unattributed',
  'external',
  'after-interruption',
]);

export function summarize(op: OperationRecord): CheckpointSummary {
  return {
    operationId: op.id,
    kind: op.kind,
    at: op.at,
    ...(op.conversationId === undefined ? {} : { conversationId: op.conversationId }),
    ...(op.turnId === undefined ? {} : { turnId: op.turnId }),
    filesChanged: op.changes.length,
    interrupted: op.status === 'interrupted',
  };
}

/** The operations that count as checkpoints: those that changed at least one path. */
export function listedOperations(records: readonly LogRecord[]): OperationRecord[] {
  return records.filter(
    (record): record is OperationRecord => record.type === 'operation' && record.changes.length > 0,
  );
}

/** What the log says about one path from a checkpoint onward. */
export interface PathHistory {
  /** The state just before the earliest record that touched the path at or after the checkpoint. */
  target: FileState;
  /** The attribution of that earliest change; `external` when it was a foreign change. */
  attribution: Attribution;
  /** The state after the last record of any kind that touched it. */
  last: FileState;
  /** Whether a foreign change, or a change by uncertain hands, touched it since. */
  uncertain: boolean;
}

export interface Analysis {
  /** The checkpoint and the listed operations after it, in log order. */
  operations: OperationRecord[];
  paths: Map<RelPath, PathHistory>;
}

/** Works out, from the log alone, what restoring to before `operationId` has to put back. */
export function analyze(
  records: readonly LogRecord[],
  operationId: OperationId,
): Analysis | undefined {
  const start = records.findIndex(
    (record) =>
      record.type === 'operation' && record.id === operationId && record.changes.length > 0,
  );
  if (start < 0) return undefined;
  const operations: OperationRecord[] = [];
  const touched = new Set<RelPath>();
  for (const record of records.slice(start)) {
    if (record.type !== 'operation' || record.changes.length === 0) continue;
    operations.push(record);
    for (const change of record.changes) touched.add(change.path);
  }
  const paths = new Map<RelPath, PathHistory>();
  for (const record of records.slice(start)) {
    if (record.type === 'review') continue;
    const isOperation = record.type === 'operation';
    for (const change of record.changes) {
      if (!touched.has(change.path)) continue;
      const attribution: Attribution = isOperation
        ? (change as { attribution: Attribution }).attribution
        : 'external';
      const known = paths.get(change.path);
      if (known === undefined) {
        paths.set(change.path, {
          target: change.before,
          attribution,
          last: change.after,
          uncertain: !isOperation || UNCERTAIN.has(attribution),
        });
      } else {
        // The record starts from a state other than the one the previous record left: someone changed
        // the file in between and no record says so (an edit the tracker did not see, a path it does
        // not scan). A state without a hash is never equal to anything.
        if (!statesEqual(known.last, change.before)) known.uncertain = true;
        known.last = change.after;
        if (!isOperation || UNCERTAIN.has(attribution)) known.uncertain = true;
      }
    }
  }
  return { operations, paths };
}

export interface PlanItem {
  item: RestoreItem;
  target: FileState;
  /** What was on the disk when the plan was made. */
  disk: DiskRead;
  /** The write that applies the item, with its content still to be loaded. */
  request: WriteRequest | undefined;
  /**
   * Other items that this one cannot be restored without: a write that waits for the deletion of the
   * same name in another spelling, of a file where a folder must be, or of the contents of a folder.
   * Selecting one without the others is refused.
   */
  ties: RelPath[];
  /** The disk is read again after the deletions, before this write is planned. */
  reread: boolean;
}

export interface Plan {
  operationId: OperationId;
  /** Newest first. */
  affected: CheckpointSummary[];
  items: PlanItem[];
  token: string;
  bytesNeeded: number;
}

export interface PlanContext {
  folderKey: FolderKey;
  folder: FolderWorkspace;
  editor: EditorPort;
  executor: ExecutorContext;
}

function targetKey(state: FileState): string {
  if (state.kind === 'absent') return 'absent';
  if (state.kind === 'symlink') return `link:${state.target}`;
  return `file:${state.hash ?? 'unknown'}:${state.mode}`;
}

function diskKey(read: DiskRead): string {
  switch (read.kind) {
    case 'absent':
      return 'absent';
    case 'symlink':
      return `link:${read.target}`;
    case 'file':
      return `file:${read.hash}:${read.mode}`;
    case 'other':
      return read.directory ? 'directory' : 'other';
    default:
      return `too-large:${read.size}`;
  }
}

function sizeOf(state: FileState): number {
  return state.kind === 'file' ? state.size : 0;
}

/** The same name, ignoring case and Unicode form, in the same folder. */
function sameName(a: string, b: string): boolean {
  if (a === b) return false;
  const fold = (path: string): string => path.normalize('NFC').toLowerCase();
  const parent = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf('/')));
  return parent(a) === parent(b) && fold(a) === fold(b);
}

/** How much a conflict weighs when items that go together are given one answer. */
function weight(item: RestoreItem): number {
  if (!item.selectable) return 3;
  if (item.conflict === 'changed-since') return 2;
  if (item.conflict === 'user-edit-between') return 1;
  return 0;
}

interface Draft {
  path: RelPath;
  history: PathHistory;
  target: FileState;
  disk: DiskRead;
  diskState: FileState | undefined;
  chmodOnly: boolean;
  action: RestoreItem['action'];
}

/**
 * What a write waits for: items of this plan that delete what is in its way. `dependsOn` empty and
 * `plannedAs` a read means the write can be planned as if that read were the disk.
 */
async function waitsFor(
  root: string,
  draft: Draft,
  deletes: ReadonlySet<string>,
): Promise<{ dependsOn: RelPath[]; plannedAs: DiskRead }> {
  const { path, disk } = draft;
  const none = { dependsOn: [] as RelPath[], plannedAs: disk };
  if (disk.kind === 'other' && !disk.directory) {
    // Another spelling of the name answers to it (a volume that ignores case).
    const alias = [...deletes].find((other) => sameName(other, path));
    return alias === undefined ? none : { dependsOn: [alias], plannedAs: { kind: 'absent' } };
  }
  if (disk.kind === 'other' && disk.directory) {
    let names: string[];
    try {
      names = await fs.readdir(resolveInside(root, path));
    } catch {
      return none;
    }
    const inside = names.map((name) => `${path}/${name}`);
    // An empty folder is removed when it is time to write; one holding only what the plan deletes, too.
    if (inside.every((name) => deletes.has(name))) {
      return { dependsOn: inside, plannedAs: { kind: 'absent' } };
    }
    return none;
  }
  const parents = await checkParents(root, path);
  if (!parents.ok && parents.reason === 'not-directory' && deletes.has(parents.at)) {
    return { dependsOn: [parents.at], plannedAs: { kind: 'absent' } };
  }
  return none;
}

/** Builds what restoring to before `operationId` would do. Reads the disk; writes nothing. */
export async function buildPlan(
  ctx: PlanContext,
  operationId: OperationId,
): Promise<Plan | undefined> {
  const records = ctx.folder.log.records().slice();
  const analysis = analyze(records, operationId);
  if (analysis === undefined) return undefined;
  const root = ctx.folder.info.path;

  // First, what each path needs. Which ones are deletions matters for the writes that wait for them.
  const drafts: Draft[] = [];
  for (const path of [...analysis.paths.keys()].sort()) {
    const history = analysis.paths.get(path) as PathHistory;
    const target = history.target;
    const disk = await readDisk(root, path);
    const diskState = readToState(disk, false);
    // Already as it was: nothing to do.
    if (diskState !== undefined && statesEqual(diskState, target)) continue;
    const chmodOnly =
      disk.kind === 'file' &&
      target.kind === 'file' &&
      target.hash !== undefined &&
      disk.hash === target.hash;
    drafts.push({
      path,
      history,
      target,
      disk,
      diskState,
      chmodOnly,
      action: target.kind === 'absent' ? 'delete' : chmodOnly ? 'chmod' : 'write',
    });
  }
  const deletes = new Set<string>(drafts.filter((d) => d.action === 'delete').map((d) => d.path));

  const items: PlanItem[] = [];
  for (const draft of drafts) {
    const { path, history, target, disk, diskState, chmodOnly, action } = draft;
    const make = (
      conflict: RestoreItem['conflict'],
      note: string | undefined,
      selectable: boolean,
      request: WriteRequest | undefined,
      ties: RelPath[] = [],
      reread = false,
    ): PlanItem => ({
      item: {
        path,
        action,
        attribution: history.attribution,
        ...(conflict === undefined ? {} : { conflict }),
        ...(note === undefined ? {} : { note }),
        selectedByDefault: conflict === undefined,
        selectable,
      },
      target,
      disk,
      request,
      ties,
      reread,
    });

    // 2. Unsaved editor changes.
    let abs: string | undefined;
    try {
      abs = resolveInside(root, path);
    } catch {
      abs = undefined;
    }
    if (abs === undefined) {
      items.push(
        make('blocked-path', 'This path is not inside the workspace folder.', false, undefined),
      );
      continue;
    }
    if (ctx.editor.isDirty(abs)) {
      items.push(make('unsaved-editor', UNSAVED_NOTE, false, undefined));
      continue;
    }
    // 3. The content of the target must be available: stored, or what the file already holds.
    if (target.kind === 'file' && !chmodOnly) {
      const stored =
        target.stored && target.hash !== undefined && (await ctx.folder.blobs.has(target.hash));
      if (!stored) {
        items.push(make('not-captured', NOT_CAPTURED_NOTE, false, undefined));
        continue;
      }
    }
    // 4. Can the executor write there at all, now or once the plan's own deletions are done?
    const wait =
      target.kind === 'absent'
        ? { dependsOn: [] as RelPath[], plannedAs: disk }
        : await waitsFor(root, draft, deletes);
    const request: WriteRequest = {
      path,
      observed: wait.plannedAs,
      sizeHint: sizeOf(target),
      target:
        target.kind === 'absent'
          ? { kind: 'delete' }
          : target.kind === 'symlink'
            ? { kind: 'symlink', target: target.target }
            : { kind: 'file', data: new Uint8Array(0), mode: target.mode },
    };
    const reread = wait.plannedAs !== disk;
    if (wait.dependsOn.length === 0) {
      const planned = await planWrite(ctx.executor, request);
      if (!planned.ok) {
        items.push(make('blocked-path', planned.message, false, undefined));
        continue;
      }
    }
    const ties = wait.dependsOn;
    // 5. Someone changed the file and no sync has recorded it yet. (A write that waits for a deletion
    // is judged by what will be there once it is done.)
    const seen = reread ? readToState(wait.plannedAs, false) : diskState;
    if (seen === undefined || !statesEqual(seen, history.last)) {
      items.push(make('changed-since', CHANGED_SINCE_NOTE, true, request, ties, reread));
      continue;
    }
    // 6. The file holds changes that were not the agent's.
    if (history.uncertain) {
      items.push(make('user-edit-between', USER_EDIT_NOTE, true, request, ties, reread));
      continue;
    }
    items.push(make(undefined, undefined, true, request, ties, reread));
  }

  tieItems(items);

  let bytesNeeded = 0;
  for (const { item, target, disk } of items) {
    if (!item.selectedByDefault) continue;
    bytesNeeded += sizeOf(target) + (disk.kind === 'file' ? disk.size : 0);
  }
  const token = createHash('sha256')
    .update(
      JSON.stringify([
        ctx.folderKey,
        operationId,
        records.length,
        items.map(({ item, target, disk, ties }) => [
          item.path,
          item.action,
          item.conflict ?? null,
          item.selectedByDefault,
          targetKey(target),
          diskKey(disk),
          ties,
        ]),
      ]),
    )
    .digest('hex');
  return {
    operationId,
    affected: analysis.operations.map(summarize).reverse(),
    items,
    token,
    bytesNeeded,
  };
}

/**
 * Makes ties two-way and gives every group of tied items the answer of its heaviest member: they
 * are restored together or not at all, so they have to be selectable, and ticked, together.
 */
function tieItems(items: PlanItem[]): void {
  const byPath = new Map(items.map((entry) => [entry.item.path, entry]));
  for (const entry of items) {
    for (const other of entry.ties) {
      const partner = byPath.get(other);
      if (partner !== undefined && !partner.ties.includes(entry.item.path)) {
        partner.ties.push(entry.item.path);
      }
    }
  }
  const seen = new Set<string>();
  for (const start of items) {
    if (start.ties.length === 0 || seen.has(start.item.path)) continue;
    const group: PlanItem[] = [];
    const queue = [start];
    seen.add(start.item.path);
    while (queue.length > 0) {
      const next = queue.pop() as PlanItem;
      group.push(next);
      for (const other of next.ties) {
        const partner = byPath.get(other);
        if (partner !== undefined && !seen.has(partner.item.path)) {
          seen.add(partner.item.path);
          queue.push(partner);
        }
      }
    }
    const heaviest = group.reduce((a, b) => (weight(b.item) > weight(a.item) ? b : a));
    for (const member of group) {
      if (weight(member.item) >= weight(heaviest.item)) continue;
      member.item = {
        ...member.item,
        ...(heaviest.item.conflict === undefined ? {} : { conflict: heaviest.item.conflict }),
        ...(heaviest.item.note === undefined ? {} : { note: heaviest.item.note }),
        selectable: heaviest.item.selectable,
        selectedByDefault: heaviest.item.selectedByDefault,
      };
    }
    group.sort((a, b) => (a.item.path < b.item.path ? -1 : 1));
  }
}
