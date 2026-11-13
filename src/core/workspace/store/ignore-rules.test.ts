import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIgnoreRules } from './ignore-rules';
import { makeTempDir, removeDir, writeTree } from './test-helpers';

let root: string;
beforeEach(async () => {
  root = await makeTempDir('agc-ignore');
});
afterEach(async () => {
  await removeDir(root);
});

describe('built-in exclusions', () => {
  it('excludes VCS and dependency directories at any depth', async () => {
    const rules = await loadIgnoreRules(root, []);
    for (const name of ['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__']) {
      expect(rules.isIgnored(name, true), name).toBe(true);
      expect(rules.isIgnored(`a/b/${name}`, true), name).toBe(true);
      expect(rules.isIgnored(`a/${name}/c.txt`, false), name).toBe(true);
    }
  });

  it('only excludes those names as directories, and similar names are kept', async () => {
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('venv', false)).toBe(false);
    expect(rules.isIgnored('src/venv2', true)).toBe(false);
    expect(rules.isIgnored('src/node_modules_backup', true)).toBe(false);
    expect(rules.isIgnored('.github', true)).toBe(false);
    expect(rules.isIgnored('.gitignore', false)).toBe(false);
  });

  it('excludes .DS_Store files at any depth', async () => {
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('.DS_Store', false)).toBe(true);
    expect(rules.isIgnored('a/b/.DS_Store', false)).toBe(true);
    expect(rules.isIgnored('a/.DS_Store.bak', false)).toBe(false);
  });

  it('excludes .claude/.cc-writes but not the rest of .claude', async () => {
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('.claude/.cc-writes', true)).toBe(true);
    expect(rules.isIgnored('.claude/.cc-writes/abc', false)).toBe(true);
    expect(rules.isIgnored('.claude', true)).toBe(false);
    expect(rules.isIgnored('.claude/settings.json', false)).toBe(false);
    expect(rules.isIgnored('.claude/.cc-writes-other', true)).toBe(false);
  });
});

describe('gitignore semantics', () => {
  it('applies the root .gitignore, including negations', async () => {
    await writeTree(root, { '.gitignore': '*.log\n!keep.log\n/build\n# comment\n\ntmp/\n' });
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('a.log', false)).toBe(true);
    expect(rules.isIgnored('x/y/a.log', false)).toBe(true);
    expect(rules.isIgnored('keep.log', false)).toBe(false);
    expect(rules.isIgnored('build', true)).toBe(true);
    expect(rules.isIgnored('x/build', true)).toBe(false);
    expect(rules.isIgnored('a.txt', false)).toBe(false);
  });

  it('directory-only patterns match directories and what is below them, not files of that name', async () => {
    await writeTree(root, { '.gitignore': 'out/\n' });
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('out', true)).toBe(true);
    expect(rules.isIgnored('out/file.txt', false)).toBe(true);
    expect(rules.isIgnored('src/out', true)).toBe(true);
    expect(rules.isIgnored('out', false)).toBe(false);
  });

  it('loads nested .gitignore files lazily, relative to their directory, with negation', async () => {
    await writeTree(root, {
      '.gitignore': '*.gen.ts\n',
      'pkg/.gitignore': '/local.txt\n!important.gen.ts\n*.tmp\n',
      'pkg/sub/.gitignore': '!x.tmp\n',
    });
    const rules = await loadIgnoreRules(root, []);

    // Not entered yet: only the root rules are known.
    expect(rules.isIgnored('pkg/local.txt', false)).toBe(false);

    await rules.enterDirectory('pkg');
    expect(rules.isIgnored('pkg/local.txt', false)).toBe(true);
    expect(rules.isIgnored('pkg/deeper/local.txt', false)).toBe(false);
    expect(rules.isIgnored('local.txt', false)).toBe(false);
    expect(rules.isIgnored('other/local.txt', false)).toBe(false);
    expect(rules.isIgnored('pkg/a.gen.ts', false)).toBe(true);
    expect(rules.isIgnored('pkg/important.gen.ts', false)).toBe(false);
    expect(rules.isIgnored('pkg/sub/y.tmp', false)).toBe(true);

    await rules.enterDirectory('pkg/sub');
    expect(rules.isIgnored('pkg/sub/x.tmp', false)).toBe(false);
    expect(rules.isIgnored('pkg/sub/y.tmp', false)).toBe(true);
    // The negation in pkg/sub does not leak out of it.
    expect(rules.isIgnored('pkg/x.tmp', false)).toBe(true);
  });

  it('enterDirectory is safe for a directory without .gitignore and when repeated', async () => {
    await writeTree(root, { 'a/file.txt': 'x' });
    const rules = await loadIgnoreRules(root, []);
    await rules.enterDirectory('a');
    await rules.enterDirectory('a');
    await rules.enterDirectory('does/not/exist');
    expect(rules.isIgnored('a/file.txt', false)).toBe(false);
  });

  it('does not follow a symlinked .gitignore', async () => {
    await writeTree(root, { 'real-ignore': '*.secret\n' });
    await fs.symlink(join(root, 'real-ignore'), join(root, '.gitignore'));
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('a.secret', false)).toBe(false);
  });

  it('matches case-sensitively', async () => {
    await writeTree(root, { '.gitignore': 'Build/\n' });
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('Build', true)).toBe(true);
    expect(rules.isIgnored('build', true)).toBe(false);
  });

  it('copes with unusual names', async () => {
    await writeTree(root, { '.gitignore': '*.log\n' });
    const rules = await loadIgnoreRules(root, []);
    expect(rules.isIgnored('-dash.txt', false)).toBe(false);
    expect(rules.isIgnored('a b/c d.log', false)).toBe(true);
    expect(rules.isIgnored('café/x.txt', false)).toBe(false);
  });
});

describe('extra excludes', () => {
  it('are gitignore-style patterns relative to the root', async () => {
    const rules = await loadIgnoreRules(root, ['/dist', '*.snap', 'cache/']);
    expect(rules.isIgnored('dist', true)).toBe(true);
    expect(rules.isIgnored('pkg/dist', true)).toBe(false);
    expect(rules.isIgnored('a/b.snap', false)).toBe(true);
    expect(rules.isIgnored('x/cache/y', false)).toBe(true);
    expect(rules.isIgnored('src/a.ts', false)).toBe(false);
  });

  it('cannot be re-included by a .gitignore negation', async () => {
    await writeTree(root, { '.gitignore': '!a.snap\n' });
    const rules = await loadIgnoreRules(root, ['*.snap']);
    expect(rules.isIgnored('a.snap', false)).toBe(true);
  });
});

describe('isSensitive', () => {
  it('flags secrets', async () => {
    const rules = await loadIgnoreRules(root, []);
    const sensitive = [
      '.env',
      'app/.env',
      '.env.local',
      '.env.production',
      'cert.pem',
      'a/b/server.key',
      'store.p12',
      'store.pfx',
      'id_rsa',
      'id_rsa.pub',
      'id_ed25519',
      'keys/id_ed25519_work',
      '.npmrc',
      'home/.netrc',
      'credentials',
      'x/credentials.json',
      '.ssh/config',
      'a/.ssh/known_hosts',
      '.aws/config',
      'deep/.aws/nested/file.txt',
    ];
    for (const path of sensitive) expect(rules.isSensitive(path), path).toBe(true);
  });

  it('does not flag look-alikes', async () => {
    const rules = await loadIgnoreRules(root, []);
    const ordinary = [
      'environment.ts',
      '.envrc',
      'env',
      'app.env',
      'key.ts',
      'keyboard.ts',
      'monkey',
      'pem',
      'publickey.txt.bak',
      'credentials.md',
      'my_id_rsa',
      'ssh/config',
      'aws/config',
      'src/.ssh',
      'README.md',
    ];
    for (const path of ordinary) expect(rules.isSensitive(path), path).toBe(false);
  });
});
