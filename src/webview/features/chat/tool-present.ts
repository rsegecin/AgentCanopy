import type { ToolCallView } from '../../../shared';
import { commandLines } from './command-lines';

/** How many lines of an Edit's before/after view are shown. */
export const DIFF_MAX_LINES = 40;
const SUMMARY_MAX = 120;
const OPEN_FILE_MAX = 4096;

export interface FileLink {
  path: string;
  /** First line to reveal, when known. */
  line?: number;
}

export interface DiffLine {
  sign: '-' | '+';
  text: string;
}

export type ToolBody =
  | { kind: 'command'; text: string }
  | { kind: 'diff'; lines: DiffLine[]; total: number }
  | { kind: 'fields'; fields: { label: string; text: string }[] };

/** What a card shows for a call, derived from its name and input. Never throws. */
export interface ToolPresentation {
  icon: string;
  /** The words inside the disclosure button. */
  title: string;
  /** A workspace path that opens in the editor, shown after the title. */
  link?: FileLink;
  /** The number of lines of a command of more than one line, so it cannot pass for a one-liner. */
  lines?: number;
  /** One muted line after the title; cut with an ellipsis when it does not fit. */
  detail?: string;
  /** Specialised content shown first in the expanded card. */
  body?: ToolBody;
  /** True when calls made by this one (a subagent) are the point of the card. */
  parent?: boolean;
}

export interface InputInfo {
  /** True when the host stored only part of the input. */
  truncated: boolean;
  /** The raw input as text: formatted JSON, or the stored preview of a truncated input. */
  text: string;
}

function clip(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A string field that has something in it. */
function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** The `{ truncated: true, preview }` shape the host stores for an input it had to cut. */
function truncatedPreview(input: unknown): string | undefined {
  const record = asRecord(input);
  if (record?.truncated === true && typeof record.preview === 'string') return record.preview;
  return undefined;
}

/** A single line that says what a tool call is about: its command, path, pattern and so on. */
export function summarizeToolInput(input: unknown): string {
  const preview = truncatedPreview(input);
  if (preview !== undefined) return clip(preview);
  if (typeof input === 'string') return clip(input);
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of [
    'command',
    'file_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
  ] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return clip(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() !== '') return clip(value);
  }
  try {
    const json = JSON.stringify(input);
    return json === '{}' || json === '[]' ? '' : clip(json);
  } catch {
    return '';
  }
}

export function describeInput(call: ToolCallView): InputInfo {
  const preview = truncatedPreview(call.input);
  if (preview !== undefined) return { truncated: true, text: preview };
  let formatted = '(no input)';
  try {
    const json = JSON.stringify(call.input, null, 2) as string | undefined;
    if (json !== undefined) formatted = json;
  } catch {
    formatted = '(input cannot be shown)';
  }
  return { truncated: call.inputTruncated, text: formatted };
}

function fileLink(path: string, line?: number): FileLink | undefined {
  if (path.length > OPEN_FILE_MAX) return undefined;
  return line !== undefined ? { path, line } : { path };
}

function lineRange(offset: unknown, limit: unknown): { detail?: string; first?: number } {
  const start = positiveInt(offset);
  const count = positiveInt(limit);
  if (start !== undefined && count !== undefined) {
    return { detail: `lines ${String(start)}-${String(start + count - 1)}`, first: start };
  }
  if (count !== undefined) return { detail: `lines 1-${String(count)}` };
  if (start !== undefined) return { detail: `from line ${String(start)}`, first: start };
  return {};
}

function splitLines(value: string): string[] {
  if (value === '') return [];
  const lines = value.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffBody(oldText: string, newText: string): ToolBody {
  const all: DiffLine[] = [
    ...splitLines(oldText).map((t): DiffLine => ({ sign: '-', text: t })),
    ...splitLines(newText).map((t): DiffLine => ({ sign: '+', text: t })),
  ];
  return { kind: 'diff', lines: all.slice(0, DIFF_MAX_LINES), total: all.length };
}

function joinDetail(parts: (string | undefined)[]): string | undefined {
  const used = parts.filter((p): p is string => p !== undefined);
  return used.length > 0 ? used.join(', ') : undefined;
}

/** Splits `mcp__server__tool`. Returns null when the name does not have that shape. */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const at = rest.indexOf('__');
  if (at <= 0 || at + 2 >= rest.length) return null;
  return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

function specialised(call: ToolCallView): ToolPresentation | null {
  const input = asRecord(call.input);
  const name = call.name;

  if (name === 'mcp__agentcanopy__submit_plan') {
    return { icon: 'checklist', title: 'Submitted a plan' };
  }
  const mcp = parseMcpName(name);
  if (mcp) {
    const detail = summarizeToolInput(call.input);
    return {
      icon: 'plug',
      title: `${mcp.server}: ${mcp.tool}`,
      ...(detail !== '' ? { detail } : {}),
    };
  }
  if (input === null) return null;

  switch (name) {
    case 'Read': {
      const path = text(input, 'file_path');
      if (path === undefined) return null;
      const range = lineRange(input.offset, input.limit);
      const link = fileLink(path, range.first);
      return {
        icon: 'file',
        title: 'Read',
        ...(link ? { link } : { detail: path }),
        ...(range.detail !== undefined && link ? { detail: range.detail } : {}),
      };
    }
    case 'Grep': {
      const pattern = text(input, 'pattern');
      if (pattern === undefined) return null;
      const path = text(input, 'path');
      const glob = text(input, 'glob');
      const detail = joinDetail([
        path !== undefined ? `in ${path}` : undefined,
        glob !== undefined ? `files matching ${glob}` : undefined,
      ]);
      return { icon: 'search', title: `Search for ${pattern}`, ...(detail ? { detail } : {}) };
    }
    case 'Glob': {
      const pattern = text(input, 'pattern');
      if (pattern === undefined) return null;
      const path = text(input, 'path');
      return {
        icon: 'search',
        title: `Find files matching ${pattern}`,
        ...(path !== undefined ? { detail: `in ${path}` } : {}),
      };
    }
    case 'Bash':
    case 'PowerShell': {
      const command = text(input, 'command');
      if (command === undefined) return null;
      const description = text(input, 'description');
      const lines = commandLines(command);
      return {
        icon: 'terminal',
        title: description ?? (name === 'Bash' ? 'Run command' : 'Run PowerShell command'),
        // A flattened summary would turn a command of many lines into one line.
        detail: lines.length > 1 ? `${clip(lines[0] ?? '', 110)} \u23CE \u2026` : clip(command),
        ...(lines.length > 1 ? { lines: lines.length } : {}),
        body: { kind: 'command', text: command },
      };
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit': {
      const path =
        name === 'NotebookEdit'
          ? (text(input, 'notebook_path') ?? text(input, 'file_path'))
          : text(input, 'file_path');
      if (path === undefined) return null;
      const link = fileLink(path);
      const oldText = input.old_string;
      const newText = input.new_string;
      return {
        icon: name === 'Write' ? 'new-file' : 'edit',
        title: name === 'NotebookEdit' ? 'Edit notebook' : name,
        ...(link ? { link } : { detail: path }),
        ...(name === 'Edit' && typeof oldText === 'string' && typeof newText === 'string'
          ? { body: diffBody(oldText, newText) }
          : {}),
      };
    }
    case 'WebFetch': {
      const url = text(input, 'url');
      if (url === undefined) return null;
      const prompt = text(input, 'prompt');
      return {
        icon: 'globe',
        title: 'Fetch',
        detail: clip(url),
        body: {
          kind: 'fields',
          fields: [
            { label: 'URL', text: url },
            ...(prompt !== undefined ? [{ label: 'Prompt', text: prompt }] : []),
          ],
        },
      };
    }
    case 'WebSearch': {
      const query = text(input, 'query');
      if (query === undefined) return null;
      return { icon: 'globe', title: 'Web search', detail: clip(query) };
    }
    case 'Task': {
      const description = text(input, 'description');
      if (description === undefined) return null;
      const kind = text(input, 'subagent_type');
      return {
        icon: 'robot',
        title: description,
        ...(kind !== undefined ? { detail: kind } : {}),
        parent: true,
      };
    }
    case 'AskUserQuestion': {
      if (!Array.isArray(input.questions)) return null;
      const count = input.questions.length;
      return {
        icon: 'comment-discussion',
        title: `Asked you ${String(count)} ${count === 1 ? 'question' : 'questions'}`,
      };
    }
    default:
      return null;
  }
}

/** Picks the presentation for a call by tool name, and falls back to the generic one. */
export function presentTool(call: ToolCallView): ToolPresentation {
  let result: ToolPresentation | null;
  try {
    result = specialised(call);
  } catch {
    result = null;
  }
  if (result) return result;
  const detail = summarizeToolInput(call.input);
  return { icon: 'tools', title: call.name, ...(detail !== '' ? { detail } : {}) };
}
