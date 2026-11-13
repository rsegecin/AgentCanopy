/** Extensions common enough that a bare `name.ext` in inline code is probably a file. */
const KNOWN_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'md',
  'mdx',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'yml',
  'yaml',
  'toml',
  'xml',
  'sql',
  'txt',
  'lock',
  'swift',
  'vue',
  'svelte',
  'gradle',
  'ini',
  'cfg',
  'conf',
  'env',
  'csv',
  'svg',
  'dart',
  'lua',
  'scala',
]);

export interface FileTarget {
  path: string;
  line?: number;
}

const SEGMENT = '[A-Za-z0-9_@+~$%=,.\\-]+';
const PATH_PATTERN = new RegExp(
  `^(?:\\./)?(${SEGMENT}(?:/${SEGMENT})*)(?::(\\d{1,7})(?::\\d{1,7})?(?:-\\d{1,7})?|#L(\\d{1,7})(?:-L?\\d{1,7})?)?$`,
);

/**
 * Decides whether `text` looks like a path inside the workspace, with an optional `:line` suffix.
 * It is a heuristic for inline code and relative links: the host still validates the path before opening.
 * Returns null for absolute paths, `..` segments, URLs and bare words that are not file names.
 */
export function parseWorkspacePath(text: string): FileTarget | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 4096) return null;
  const match = PATH_PATTERN.exec(trimmed);
  if (!match) return null;
  const path = match[1];
  if (path === undefined) return null;
  const segments = path.split('/');
  if (segments.some((s) => s === '.' || s === '..' || s.startsWith('~'))) return null;
  const lineText = match[2] ?? match[3];
  const hasSlash = segments.length > 1;
  const last = segments[segments.length - 1] ?? '';
  const dot = last.lastIndexOf('.');
  const extension = dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
  const known = extension !== '' && KNOWN_EXTENSIONS.has(extension);
  const hasExtension = dot > 0 && /^[A-Za-z0-9]{1,6}$/.test(last.slice(dot + 1));
  // Known extension; or a slash plus any extension; or a slash plus an explicit line number.
  if (!(known || (hasSlash && (hasExtension || lineText !== undefined)))) return null;
  const line = lineText === undefined ? undefined : Number(lineText);
  return line !== undefined && line > 0 ? { path, line } : { path };
}

/** The last segment of a path, and the directory in front of it ('' when there is none). */
export function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split('/').filter((p) => p !== '');
  const name = parts[parts.length - 1] ?? path;
  return { name, dir: parts.slice(0, -1).join('/') };
}
