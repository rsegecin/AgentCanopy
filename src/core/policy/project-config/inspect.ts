import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { escapeForDisplay } from '../readonly/escape';

export interface ProjectConfigSummary {
  /** sha256 over the paths and bytes of every file inspected (absent files included as absent). */
  fingerprint: string;
  /** Plain-language lines for the confirmation dialog, at most 20 (then "and N more"). Empty when nothing needs a decision. */
  items: string[];
  /** A project settings file has anything outside the safe set, or cannot be parsed. */
  needsSettingsDecision: boolean;
  /** A project `.mcp.json` defines at least one server, or cannot be parsed. */
  needsMcpDecision: boolean;
  /** CLAUDE.md or .claude/CLAUDE.md exists in the folder (it is skipped when settings are ignored). */
  hasClaudeMd: boolean;
}

const MAX_BYTES = 1024 * 1024;
const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 120;
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const MCP_FILE = '.mcp.json';

/** Keys of a project settings file that cannot run code or widen what the agent may do. */
const SAFE_TOP_LEVEL = new Set(['permissions', 'includeCoAuthoredBy', 'cleanupPeriodDays']);
const SAFE_PERMISSION_KEYS = new Set(['deny', 'ask']);
/** Settings that name a command Claude Code runs on its own. */
const HELPER_KEYS = new Set([
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'statusLine',
  'fileSuggestion',
]);

type FileState =
  { kind: 'absent' } | { kind: 'unsafe'; detail: string } | { kind: 'file'; bytes: Buffer };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Reads a file without following a link, and without reading more than the limit. */
async function readSafely(path: string): Promise<FileState> {
  let stats;
  try {
    stats = await fs.lstat(path);
  } catch (error) {
    return isMissing(error) ? { kind: 'absent' } : { kind: 'unsafe', detail: 'unreadable' };
  }
  if (stats.isSymbolicLink()) {
    const target = await fs.readlink(path).catch(() => '');
    return { kind: 'unsafe', detail: `link to ${target}` };
  }
  if (!stats.isFile()) return { kind: 'unsafe', detail: 'not a file' };
  if (stats.size > MAX_BYTES) return { kind: 'unsafe', detail: `too large (${stats.size})` };
  let handle;
  try {
    // O_NOFOLLOW closes the gap between the check above and the open.
    handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_BYTES) {
      return { kind: 'unsafe', detail: 'changed while reading' };
    }
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(buffer, 0, opened.size, 0);
    return { kind: 'file', bytes: buffer.subarray(0, bytesRead) };
  } catch {
    return { kind: 'unsafe', detail: 'unreadable' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** True when `path` exists as anything at all (a link, a directory, a file). */
async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

function parseJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(bytes.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** What a settings file holds beyond the safe set, by kind. Values keep their first-seen order. */
class Findings {
  readonly hooks = new Set<string>();
  readonly env = new Set<string>();
  readonly helpers = new Set<string>();
  readonly allow = new Set<string>();
  readonly directories = new Set<string>();
  readonly other = new Set<string>();

  get any(): boolean {
    return [this.hooks, this.env, this.helpers, this.allow, this.directories, this.other].some(
      (set) => set.size > 0,
    );
  }
}

function addNames(into: Set<string>, value: unknown, otherKey: string, findings: Findings): void {
  const names = isRecord(value) ? Object.keys(value) : [];
  if (names.length === 0) findings.other.add(otherKey);
  for (const name of names) into.add(name);
}

function addStrings(into: Set<string>, value: unknown, otherKey: string, findings: Findings): void {
  const entries = Array.isArray(value) ? value : [];
  if (entries.length === 0 || !entries.every((entry) => typeof entry === 'string')) {
    findings.other.add(otherKey);
    return;
  }
  for (const entry of entries) if (typeof entry === 'string') into.add(entry);
}

function analyseSettings(value: Record<string, unknown>, findings: Findings): void {
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'hooks') addNames(findings.hooks, entry, 'hooks', findings);
    else if (key === 'env') addNames(findings.env, entry, 'env', findings);
    else if (HELPER_KEYS.has(key)) findings.helpers.add(key);
    else if (key === 'permissions') analysePermissions(entry, findings);
    else if (!SAFE_TOP_LEVEL.has(key)) findings.other.add(key);
  }
}

function analysePermissions(value: unknown, findings: Findings): void {
  if (!isRecord(value)) {
    findings.other.add('permissions');
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (SAFE_PERMISSION_KEYS.has(key)) {
      if (!Array.isArray(entry)) findings.other.add(`permissions.${key}`);
    } else if (key === 'allow') {
      addStrings(findings.allow, entry, 'permissions.allow', findings);
    } else if (key === 'additionalDirectories') {
      addStrings(findings.directories, entry, 'permissions.additionalDirectories', findings);
    } else {
      findings.other.add(`permissions.${key}`);
    }
  }
}

function describeServer(name: string, server: unknown): string {
  const label = escapeForDisplay(name);
  if (isRecord(server)) {
    if (typeof server['url'] === 'string')
      return `Tool server ${label}: ${escapeForDisplay(server['url'])}`;
    if (typeof server['command'] === 'string') {
      const args = Array.isArray(server['args'])
        ? server['args'].filter((arg): arg is string => typeof arg === 'string')
        : [];
      return `Tool server ${label}: ${escapeForDisplay([server['command'], ...args].join(' '))}`;
    }
  }
  return `Tool server ${label}: (no command or address)`;
}

function cut(text: string): string {
  return text.length <= MAX_ITEM_CHARS ? text : text.slice(0, MAX_ITEM_CHARS);
}

function listLine(prefix: string, names: Set<string>): string | undefined {
  if (names.size === 0) return undefined;
  return `${prefix}: ${[...names].map((name) => escapeForDisplay(name)).join(', ')}`;
}

/**
 * Looks at the Claude Code configuration a project brings along: the settings files and
 * `.mcp.json`, in the folder and (when given and different) at the git root. Reads only; never
 * follows a link and never runs anything. The result tells the controller whether to ask the user
 * and what to show.
 */
export async function inspectProjectConfig(
  folderPath: string,
  options: { gitRoot?: string } = {},
): Promise<ProjectConfigSummary> {
  const folder = resolve(folderPath);
  const roots = [folder];
  if (options.gitRoot !== undefined && resolve(options.gitRoot) !== folder) {
    roots.push(resolve(options.gitRoot));
  }

  const hash = createHash('sha256');
  const problems: string[] = [];
  const findings = new Findings();
  const mcpItems: string[] = [];
  let needsSettings = false;
  let needsMcp = false;

  const label = (root: string, rel: string): string =>
    escapeForDisplay(root === folder ? rel : join(root, rel));

  for (const root of roots) {
    // A `.claude` that is a link would lead the settings files somewhere else.
    const claudeDir = join(root, '.claude');
    const dirState = await readDirectoryKind(claudeDir);

    for (const rel of [...SETTINGS_FILES, MCP_FILE]) {
      const path = join(root, rel);
      const isMcp = rel === MCP_FILE;
      const state: FileState =
        !isMcp && dirState === 'unsafe'
          ? { kind: 'unsafe', detail: '.claude is not a plain folder' }
          : await readSafely(path);

      hash.update(`${path}\0`);
      if (state.kind === 'absent') {
        hash.update('absent\0');
        continue;
      }
      if (state.kind === 'unsafe') {
        hash.update(`unsafe:${state.detail}\0`);
        problems.push(`${label(root, rel)} could not be read safely`);
        if (isMcp) needsMcp = true;
        else needsSettings = true;
        continue;
      }
      hash.update(`file:${state.bytes.length}\0`);
      hash.update(state.bytes);
      hash.update('\0');

      const parsed = parseJson(state.bytes);
      if (!parsed.ok) {
        problems.push(`${label(root, rel)} is not valid JSON`);
        if (isMcp) needsMcp = true;
        else needsSettings = true;
        continue;
      }
      if (isMcp) {
        const servers = isRecord(parsed.value) ? parsed.value['mcpServers'] : undefined;
        if (isRecord(servers)) {
          for (const [name, server] of Object.entries(servers)) {
            mcpItems.push(describeServer(name, server));
            needsMcp = true;
          }
        }
      } else if (isRecord(parsed.value)) {
        analyseSettings(parsed.value, findings);
      } else {
        problems.push(`${label(root, rel)} is not a settings object`);
        needsSettings = true;
      }
    }
  }
  if (findings.any) needsSettings = true;

  const lines = [
    ...problems,
    listLine('Hooks that run commands', findings.hooks),
    listLine('Environment variables', findings.env),
    listLine('Helper commands', findings.helpers),
    listLine('Pre-approved permissions', findings.allow),
    listLine('Extra folders the agent may read', findings.directories),
    listLine('Other settings', findings.other),
    ...mcpItems,
  ]
    .filter((line): line is string => line !== undefined)
    .map(cut);

  const items =
    lines.length > MAX_ITEMS
      ? [...lines.slice(0, MAX_ITEMS), `and ${lines.length - MAX_ITEMS} more`]
      : lines;

  return {
    fingerprint: hash.digest('hex'),
    items,
    needsSettingsDecision: needsSettings,
    needsMcpDecision: needsMcp,
    hasClaudeMd:
      (await exists(join(folder, 'CLAUDE.md'))) ||
      (await exists(join(folder, '.claude', 'CLAUDE.md'))),
  };
}

/** `absent`, `plain` (a real directory) or `unsafe` (a link, or something that is not a directory). */
async function readDirectoryKind(path: string): Promise<'absent' | 'plain' | 'unsafe'> {
  try {
    const stats = await fs.lstat(path);
    return stats.isDirectory() ? 'plain' : 'unsafe';
  } catch (error) {
    return isMissing(error) ? 'absent' : 'unsafe';
  }
}
