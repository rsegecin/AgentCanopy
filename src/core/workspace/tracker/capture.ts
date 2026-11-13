import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { RelPathSchema, type FileState, type RelPath } from '../../../shared';
import type { Logger } from '../../contracts';
import { ALWAYS_CAPTURE_LIMIT, isRacy, scanWorkspace, statChanged, toStatEntry } from '../store';
import { isVanished } from './fs-util';
import type { FolderState } from './folder';
import { FILE_TOOLS, READ_ONLY_TOOLS, type ToolCall, type TurnState } from './turn-state';

/** The path a file tool names, or undefined when the input is not what we expect. */
export function toolPath(toolName: string, input: unknown): string | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  if (typeof input !== 'object' || input === null) return undefined;
  const fields = input as Record<string, unknown>;
  const value = toolName === 'NotebookEdit' ? fields.notebook_path : fields.file_path;
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : undefined;
}

/** Follows symlinks as far as the path exists; the rest is appended unchanged. */
async function realLocation(path: string): Promise<string | undefined> {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await fs.realpath(current), ...tail.reverse());
    } catch (error) {
      if (!isVanished(error)) return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/** Where a file tool's path really is, as a path relative to the folder. Undefined when outside it. */
export async function resolveToolPath(
  folder: FolderState,
  raw: string,
): Promise<{ rel: RelPath; abs: string } | undefined> {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(folder.info.path, raw);
  const real = await realLocation(absolute);
  if (real === undefined) return undefined;
  const rel = relative(folder.realRoot, real).split(/[\\/]/).join('/');
  if (rel === '' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
  if (!RelPathSchema.safeParse(rel).success) return undefined;
  return { rel, abs: real };
}

async function lstatBig(abs: string) {
  try {
    return await fs.lstat(abs, { bigint: true });
  } catch (error) {
    if (isVanished(error)) return undefined;
    throw error;
  }
}

/** The call with this id, created on first sight. */
export function callFor(turn: TurnState, toolCallId: string, toolName: string): ToolCall {
  let call = turn.calls.get(toolCallId);
  if (!call) {
    call = {
      name: toolName,
      fileTool: FILE_TOOLS.has(toolName),
      readOnly: READ_ONLY_TOOLS.has(toolName),
      open: false,
      ran: undefined,
    };
    turn.calls.set(toolCallId, call);
  }
  return call;
}

/**
 * For a file tool about to run: works out which path it names and, when B does not already hold
 * that path's content, captures it now so it can be put back. The capture belongs to the call and
 * only becomes the turn's before-state of the path if the call turns out to have run. Called at the
 * `pre` hook and again at the permission request, which is later and so closer to the write.
 * Never throws: a failure is logged and the turn goes on.
 */
export async function captureForCall(
  folder: FolderState,
  turn: TurnState,
  call: ToolCall,
  input: unknown,
  logger: Logger,
  /** Paths the scan just before this call found changed: it has already moved the turn's last scan on. */
  changedByScan: ReadonlySet<RelPath> = new Set(),
): Promise<void> {
  try {
    if (call.namedRel === undefined) {
      const raw = toolPath(call.name, input);
      if (raw === undefined) return;
      const target = await resolveToolPath(folder, raw);
      if (target === undefined) return;
      call.namedRel = target.rel;
      call.abs = target.abs;
    }
    const rel = call.namedRel;
    const abs = call.abs;
    if (abs === undefined) return;
    // After the agent's own write (a file tool, or a command seen to change it) what is there is the
    // agent's work, unless someone touched it since the last scan: then it is an intermediate version.
    const later = turn.named.has(rel) || turn.windows.get(rel)?.command === true;
    const scanned = turn.lastScan.get(rel);

    const current = await lstatBig(abs);
    let state: FileState | undefined;
    if (later) {
      const unchanged =
        !changedByScan.has(rel) &&
        scanned !== undefined &&
        current !== undefined &&
        (current.isFile() || current.isSymbolicLink()) &&
        !statChanged(scanned, toStatEntry(current, current.isFile() ? 'file' : 'symlink'));
      // Nothing new since the last look (or nothing to capture): an earlier capture of this call stands.
      if (unchanged || current === undefined || (!current.isFile() && !current.isSymbolicLink())) {
        return;
      }
    }
    if (current === undefined) {
      state = { kind: 'absent' };
    } else if (current.isSymbolicLink()) {
      state = { kind: 'symlink', target: await fs.readlink(abs) };
    } else if (current.isFile()) {
      const stat = toStatEntry(current, 'file');
      const baseline = turn.baseline.get(rel);
      if (
        baseline &&
        baseline.kind === 'file' &&
        baseline.stored &&
        !isRacy(baseline) &&
        !statChanged(baseline, stat)
      ) {
        call.capture = undefined; // B already holds it.
        return;
      }
      const result = await folder.blobs.captureFile(abs, ALWAYS_CAPTURE_LIMIT, { store: true });
      if (result.kind === 'captured') {
        state = {
          kind: 'file',
          hash: result.hash,
          size: result.size,
          mode: stat.mode,
          stored: true,
          binary: result.binary,
        };
      } else if (result.kind === 'too-large') {
        state = { kind: 'file', size: result.size, mode: stat.mode, stored: false, binary: false };
      } else if (result.kind === 'gone') {
        state = { kind: 'absent' };
      }
    }
    if (state)
      call.capture = { state, seq: (turn.seq += 1), ...(later ? { intermediate: true } : {}) };
  } catch (error) {
    logger.warn('could not capture a file before an edit', {
      tool: call.name,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Stat-only scan of the folder compared with the turn's last scan. Returns every path that changed,
 * appeared or disappeared, and keeps the new scan for the next comparison.
 */
export async function scanForChanges(folder: FolderState, turn: TurnState): Promise<RelPath[]> {
  const scan = await scanWorkspace(folder.info.path, turn.rules);
  const changed: RelPath[] = [];
  for (const [path, stat] of scan.entries) {
    const before = turn.lastScan.get(path);
    if (before === undefined || statChanged(before, stat)) changed.push(path);
  }
  if (!scan.truncated) {
    const prefixes = scan.unreadable.map((dir) => `${dir}/`);
    for (const path of turn.lastScan.keys()) {
      if (scan.entries.has(path)) continue;
      if (prefixes.some((prefix) => path.startsWith(prefix))) continue;
      changed.push(path);
    }
    const next = new Map(scan.entries);
    for (const [path, stat] of turn.lastScan) {
      if (!next.has(path) && prefixes.some((prefix) => path.startsWith(prefix)))
        next.set(path, stat);
    }
    turn.lastScan = next;
  } else {
    // An incomplete scan: remember what it saw, keep the rest as it was.
    for (const [path, stat] of scan.entries) turn.lastScan.set(path, stat);
  }
  return changed;
}
