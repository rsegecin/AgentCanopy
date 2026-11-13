import ignore, { type Ignore } from 'ignore';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface IgnoreRules {
  /**
   * True when the path is excluded from tracking. Uses the rules loaded so far, so call
   * `enterDirectory` for a directory before asking about its children.
   */
  isIgnored(relPath: string, isDirectory: boolean): boolean;
  /** True for files that may hold secrets: they are hashed but never stored. */
  isSensitive(relPath: string): boolean;
  /** Reads `<relDir>/.gitignore` if present. `''` is the root. Safe to call more than once. */
  enterDirectory(relDir: string): Promise<void>;
}

const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
]);
const EXCLUDED_FILE_NAMES = new Set(['.DS_Store']);
const EXCLUDED_PATH = '.claude/.cc-writes';
/** A .gitignore larger than this is not read; it is not a real ignore file. */
const MAX_GITIGNORE_BYTES = 1024 * 1024;

function newMatcher(): Ignore {
  // Git matches case-sensitively unless core.ignorecase is set; we never fold case.
  return ignore({ ignorecase: false });
}

function safeTest(matcher: Ignore, path: string): { ignored: boolean; unignored: boolean } {
  try {
    return matcher.test(path);
  } catch {
    // The `ignore` package refuses some path spellings; a path it cannot test matches no rule.
    return { ignored: false, unignored: false };
  }
}

export async function loadIgnoreRules(root: string, extraExcludes: string[]): Promise<IgnoreRules> {
  const extras = newMatcher().add(extraExcludes);
  const hasExtras = extraExcludes.length > 0;
  /** `.gitignore` matchers by directory (`''` is the root). */
  const matchers = new Map<string, Ignore>();
  const loading = new Map<string, Promise<void>>();

  async function readGitignore(relDir: string): Promise<void> {
    const file = join(root, ...(relDir === '' ? [] : relDir.split('/')), '.gitignore');
    try {
      const stats = await fs.lstat(file);
      // Like git, do not follow a symlinked .gitignore.
      if (!stats.isFile() || stats.size > MAX_GITIGNORE_BYTES) return;
      let text = await fs.readFile(file, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      matchers.set(relDir, newMatcher().add(text));
    } catch {
      // No .gitignore, or one that cannot be read: it contributes no rules.
    }
  }

  const rules: IgnoreRules = {
    enterDirectory(relDir) {
      let pending = loading.get(relDir);
      if (!pending) {
        pending = readGitignore(relDir);
        loading.set(relDir, pending);
      }
      return pending;
    },

    isIgnored(relPath, isDirectory) {
      const segments = relPath.split('/');
      const last = segments.length - 1;
      for (let i = 0; i <= last; i += 1) {
        const segment = segments[i] as string;
        const isDir = i < last || isDirectory;
        if (isDir && EXCLUDED_DIRECTORY_NAMES.has(segment)) return true;
        if (i === last && !isDirectory && EXCLUDED_FILE_NAMES.has(segment)) return true;
      }
      if (relPath === EXCLUDED_PATH || relPath.startsWith(`${EXCLUDED_PATH}/`)) return true;

      if (hasExtras) {
        const probe = isDirectory ? `${relPath}/` : relPath;
        if (safeTest(extras, probe).ignored) return true;
      }

      // The deepest .gitignore that has an opinion wins, as in git.
      for (let depth = last; depth >= 0; depth -= 1) {
        const matcher = matchers.get(segments.slice(0, depth).join('/'));
        if (!matcher) continue;
        const sub = segments.slice(depth).join('/');
        const result = safeTest(matcher, isDirectory ? `${sub}/` : sub);
        if (result.ignored) return true;
        if (result.unignored) return false;
      }
      return false;
    },

    isSensitive(relPath) {
      const segments = relPath.split('/');
      const name = (segments[segments.length - 1] ?? '').toLowerCase();
      for (let i = 0; i < segments.length - 1; i += 1) {
        const dir = (segments[i] as string).toLowerCase();
        if (dir === '.ssh' || dir === '.aws') return true;
      }
      return (
        name === '.env' ||
        name.startsWith('.env.') ||
        name.endsWith('.pem') ||
        name.endsWith('.key') ||
        name.endsWith('.p12') ||
        name.endsWith('.pfx') ||
        name.startsWith('id_rsa') ||
        name.startsWith('id_ed25519') ||
        name === '.npmrc' ||
        name === '.netrc' ||
        name === 'credentials' ||
        name === 'credentials.json'
      );
    },
  };

  await rules.enterDirectory('');
  return rules;
}
