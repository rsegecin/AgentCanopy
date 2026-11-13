import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Test support: a temp directory per test, removed afterwards. Not part of the public API. */
export async function makeTempDir(prefix: string): Promise<string> {
  // realpath so that comparisons are not confused by /var -> /private/var on macOS.
  return fs.realpath(await fs.mkdtemp(join(tmpdir(), `${prefix}-`)));
}

export async function removeDir(dir: string): Promise<void> {
  await fs.chmod(dir, 0o700).catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true });
}

/** Writes files given as `{ 'a/b.txt': 'content' }`, creating directories as needed. */
export async function writeTree(
  root: string,
  files: Record<string, string | Buffer>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split('/'));
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/** Every file below `dir`, as paths relative to it. */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const inner of await listFilesRecursive(join(dir, entry.name))) {
        out.push(`${entry.name}/${inner}`);
      }
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}
