const PROTECTED_DIRECTORIES = new Set(['.git', '.vscode', '.claude', '.husky', '.devcontainer']);
const PROTECTED_FILES = new Set(['.mcp.json', '.npmrc', '.netrc', '.env']);

/**
 * True for files that configure the editor, Claude Code, git or the build, or that hold secrets:
 * a change to them can run code or approve things later, so every edit asks. `relPath` is relative
 * to the workspace folder and uses forward slashes (a backslash also separates). Case is ignored.
 * Directory names count at any depth, so `packages/x/.vscode/tasks.json` is protected too.
 *
 * Windows ignores trailing dots and spaces in a name, so `.git./hooks` is `.git/hooks`: they are
 * removed before the check. A segment with a colon (an alternate data stream, a drive letter) is
 * protected whatever its name.
 */
export function isProtectedPath(relPath: string): boolean {
  const segments: string[] = [];
  for (const raw of relPath.toLowerCase().split(/[\\/]/)) {
    if (raw.includes(':')) return true;
    const segment = raw.replace(/[. ]+$/, '');
    if (segment !== '') segments.push(segment);
  }
  const last = segments.length - 1;
  for (let i = 0; i <= last; i += 1) {
    const segment = segments[i] as string;
    if (PROTECTED_DIRECTORIES.has(segment)) return true;
    if (segment === '.github' && segments[i + 1] === 'workflows') return true;
  }
  const name = segments[last];
  if (name === undefined) return false;
  return PROTECTED_FILES.has(name) || name.startsWith('.env.');
}
