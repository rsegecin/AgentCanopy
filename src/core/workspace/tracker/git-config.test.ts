import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_PENDING_MESSAGE } from './tracker';
import { GIT_CHANGED_NOTE } from './git-state';
import { Turn, makeEnv, openWorkspace, operations, sha, type Env } from './test-support';

const posix = process.platform !== 'win32';

let env: Env;
afterEach(async () => {
  await env.cleanup();
});

async function makeGit(dir: string): Promise<void> {
  await fs.mkdir(join(dir, 'logs'), { recursive: true });
  await fs.mkdir(join(dir, 'refs', 'heads'), { recursive: true });
  await fs.writeFile(join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  await fs.writeFile(join(dir, 'refs', 'heads', 'main'), `${'a'.repeat(40)}\n`);
  await fs.writeFile(join(dir, 'logs', 'HEAD'), `${'0'.repeat(40)} ${'a'.repeat(40)} init\n`);
}

async function simulateCommit(gitDir: string): Promise<void> {
  await fs.writeFile(join(gitDir, 'refs', 'heads', 'main'), `${'b'.repeat(40)}\n`);
  await fs.appendFile(join(gitDir, 'logs', 'HEAD'), `${'a'.repeat(40)} ${'b'.repeat(40)} commit\n`);
}

describe('git state', () => {
  beforeEach(async () => {
    env = await makeEnv();
  });

  it('notes a commit made during the turn', async () => {
    await makeGit(env.abs('.git'));
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'a2');
    await turn.command(() => simulateCommit(env.abs('.git')));
    const notices = await turn.end();
    expect(notices).toEqual([{ level: 'warning', text: GIT_CHANGED_NOTE }]);
    expect(GIT_CHANGED_NOTE).toBe(
      'The agent changed Git state (commits, branch or stash). Undoing file changes does not undo that.',
    );
    expect(operations(ws)[0]?.notes).toEqual([GIT_CHANGED_NOTE]);
  });

  it('notes a switched branch and a new stash', async () => {
    await makeGit(env.abs('.git'));
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await fs.writeFile(env.abs('.git/HEAD'), 'ref: refs/heads/other\n');
    expect((await turn.end()).map((n) => n.text)).toEqual([GIT_CHANGED_NOTE]);

    const turn2 = new Turn(tracker, env);
    await turn2.begin();
    await fs.writeFile(env.abs('.git/refs/stash'), `${'c'.repeat(40)}\n`);
    expect((await turn2.end()).map((n) => n.text)).toEqual([GIT_CHANGED_NOTE]);
  });

  it('says nothing when Git did not change', async () => {
    await makeGit(env.abs('.git'));
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'a2');
    expect(await turn.end()).toEqual([]);
  });

  it('follows a gitdir: file, as a worktree has', async () => {
    const real = join(env.base, 'actual-gitdir');
    await makeGit(real);
    await fs.writeFile(env.abs('.git'), `gitdir: ${real}\n`);
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await simulateCommit(real);
    expect((await turn.end()).map((n) => n.text)).toEqual([GIT_CHANGED_NOTE]);
  });

  it('follows a relative gitdir: file', async () => {
    await makeGit(join(env.base, 'rel-gitdir'));
    await fs.writeFile(env.abs('.git'), 'gitdir: ../rel-gitdir\n');
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await simulateCommit(join(env.base, 'rel-gitdir'));
    expect((await turn.end()).map((n) => n.text)).toEqual([GIT_CHANGED_NOTE]);
  });

  it('finds a .git above the folder', async () => {
    await makeGit(join(env.base, '.git'));
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await simulateCommit(join(env.base, '.git'));
    expect((await turn.end()).map((n) => n.text)).toEqual([GIT_CHANGED_NOTE]);
  });

  it('gives no note without a .git', async () => {
    await env.write({ 'a.txt': 'a' });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'a2');
    expect(await turn.end()).toEqual([]);
  });

  it('does not run git: a hook that would write a marker never fires', async () => {
    await makeGit(env.abs('.git'));
    await fs.mkdir(env.abs('.git/hooks'), { recursive: true });
    const marker = join(env.base, 'hook-ran');
    await fs.writeFile(env.abs('.git/hooks/post-checkout'), `#!/bin/sh\ntouch ${marker}\n`, {
      mode: 0o755,
    });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.end();
    await expect(fs.access(marker)).rejects.toThrow();
  });
});

describe('configuration tripwire', () => {
  beforeEach(async () => {
    env = await makeEnv({ folderSubdir: 'repo/packages/app' });
  });

  /** A repository at `base/repo` with the workspace folder inside it. */
  async function repo(): Promise<string> {
    const gitRoot = join(env.base, 'repo');
    await makeGit(join(gitRoot, '.git'));
    return gitRoot;
  }

  it('flags a changed, a created and a deleted watched file, at the folder and at the git root', async () => {
    const gitRoot = await repo();
    await fs.mkdir(join(gitRoot, '.git', 'hooks'), { recursive: true });
    await env.write({
      '.claude/settings.json': '{"a":1}',
      'src.txt': 'code',
      '.vscode/tasks.json': '{}',
    });
    await fs.writeFile(join(gitRoot, '.mcp.json'), '{"servers":{}}');
    await fs.writeFile(join(gitRoot, '.git', 'config'), '[core]\n');
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.command(async () => {
      await fs.writeFile(env.abs('.claude/settings.json'), '{"a":2}'); // changed
      await fs.writeFile(env.abs('.vscode/settings.json'), '{"x":1}'); // created
      await fs.rm(env.abs('.vscode/tasks.json')); // deleted
      await fs.writeFile(join(gitRoot, '.mcp.json'), '{"servers":{"evil":{}}}'); // at the git root
      await fs.writeFile(join(gitRoot, '.git', 'config'), '[core]\n[alias]\n  x = !sh\n');
      await fs.writeFile(join(gitRoot, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n'); // new hook
      await fs.writeFile(join(gitRoot, '.git', 'hooks', 'pre-push.sample'), '#!/bin/sh\n'); // sample: not watched
      await fs.writeFile(env.abs('src.txt'), 'code2'); // not config
    });
    const notices = await turn.end();

    const changes = tracker.configChanges(env.folder.key);
    const byPath = new Map(changes.map((c) => [c.displayPath, c]));
    expect([...byPath.keys()].sort()).toEqual(
      [
        '.claude/settings.json',
        '.vscode/settings.json',
        '.vscode/tasks.json',
        '.mcp.json',
        '.git/config',
        '.git/hooks/pre-commit',
      ].sort(),
    );
    expect(byPath.get('.claude/settings.json')).toMatchObject({
      changeType: 'modified',
      revertible: true,
    });
    expect(byPath.get('.vscode/settings.json')).toMatchObject({
      changeType: 'created',
      revertible: true,
    });
    expect(byPath.get('.vscode/tasks.json')).toMatchObject({
      changeType: 'deleted',
      revertible: true,
    });
    expect(byPath.get('.mcp.json')).toMatchObject({ changeType: 'modified' });
    expect(byPath.get('.git/hooks/pre-commit')).toMatchObject({ changeType: 'created' });

    const warning = notices.find((n) =>
      n.text.startsWith('This turn changed tool or editor configuration'),
    );
    expect(warning?.level).toBe('warning');
    expect(warning?.text).toContain('.claude/settings.json');
    expect(warning?.text).toContain(
      'Review it before the next turn: such files can make later commands run without asking.',
    );
    await expect(new Turn(tracker, env).begin()).rejects.toThrow(CONFIG_PENDING_MESSAGE);
  });

  it('a turn that changes no configuration changes nothing here', async () => {
    await repo();
    await env.write({ '.claude/settings.json': '{}', 'a.txt': 'a' });
    const tracker = env.tracker();
    const ws = await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.edit('a.txt', 'a2');
    expect(await turn.end()).toEqual([]);
    expect(tracker.configChanges(env.folder.key)).toEqual([]);
    expect(operations(ws)).toHaveLength(1);
  });

  it('fires the change event on every change of the list', async () => {
    await repo();
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const events: number[] = [];
    tracker.onDidChangeConfigChanges(() =>
      events.push(tracker.configChanges(env.folder.key).length),
    );
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.shellWrite({ '.mcp.json': '{}', '.vscode/launch.json': '{}' });
    await turn.end();
    const [first, second] = tracker.configChanges(env.folder.key);
    await tracker.resolveConfigChange(env.folder.key, first!.id, 'keep');
    await tracker.resolveConfigChange(env.folder.key, second!.id, 'keep');
    expect(events).toEqual([2, 1, 0]);
    await tracker.resolveConfigChange(env.folder.key, 'no-such-id', 'keep');
    expect(events).toEqual([2, 1, 0]);
    const next = new Turn(tracker, env);
    await next.begin();
    await next.end();
  });

  async function oneChange(
    initial: string | undefined,
    after: string | undefined,
    mode?: number,
    afterMode?: number,
  ) {
    const tracker = env.tracker();
    const file = env.abs('.vscode/settings.json');
    if (initial !== undefined) {
      await env.write({ '.vscode/settings.json': initial });
      if (mode !== undefined) await fs.chmod(file, mode);
    }
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.command(async () => {
      if (after === undefined) await fs.rm(file);
      else {
        await fs.mkdir(dirname(file), { recursive: true });
        await fs.writeFile(file, after);
        if (afterMode !== undefined) await fs.chmod(file, afterMode);
      }
    });
    await turn.end();
    const [change] = tracker.configChanges(env.folder.key);
    return { tracker, change: change!, file };
  }

  it('keep drops the entry and leaves the file', async () => {
    const { tracker, change, file } = await oneChange('before', 'after');
    await tracker.resolveConfigChange(env.folder.key, change.id, 'keep');
    expect(tracker.configChanges(env.folder.key)).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe('after');
  });

  it.skipIf(!posix)('revert puts back the bytes and the mode', async () => {
    const { tracker, change, file } = await oneChange('before bytes', 'after', 0o600, 0o644);
    await tracker.resolveConfigChange(env.folder.key, change.id, 'revert');
    expect(await fs.readFile(file, 'utf8')).toBe('before bytes');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(tracker.configChanges(env.folder.key)).toEqual([]);
    expect((await fs.readdir(join(env.root, '.vscode'))).sort()).toEqual(['settings.json']);
  });

  it('revert of a created file deletes it', async () => {
    const { tracker, change, file } = await oneChange(undefined, 'new file');
    expect(change.changeType).toBe('created');
    await tracker.resolveConfigChange(env.folder.key, change.id, 'revert');
    await expect(fs.access(file)).rejects.toThrow();
    expect(tracker.configChanges(env.folder.key)).toEqual([]);
  });

  it('revert of a deleted file brings it back', async () => {
    const { tracker, change, file } = await oneChange('keep me', undefined);
    expect(change.changeType).toBe('deleted');
    await tracker.resolveConfigChange(env.folder.key, change.id, 'revert');
    expect(await fs.readFile(file, 'utf8')).toBe('keep me');
  });

  it('revert is refused when the file changed again', async () => {
    const { tracker, change, file } = await oneChange('before', 'after');
    await fs.writeFile(file, 'changed yet again');
    await expect(tracker.resolveConfigChange(env.folder.key, change.id, 'revert')).rejects.toThrow(
      'The file changed again since the turn ended.',
    );
    expect(await fs.readFile(file, 'utf8')).toBe('changed yet again');
    expect(tracker.configChanges(env.folder.key)).toHaveLength(1);
  });

  it.skipIf(!posix)('revert is refused when a parent directory has become a symlink', async () => {
    const { tracker, change, file } = await oneChange('before', 'after');
    const elsewhere = join(env.base, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.writeFile(join(elsewhere, 'settings.json'), 'after');
    await fs.rm(join(env.root, '.vscode'), { recursive: true });
    await fs.symlink(elsewhere, join(env.root, '.vscode'));
    await expect(tracker.resolveConfigChange(env.folder.key, change.id, 'revert')).rejects.toThrow(
      /symbolic link/,
    );
    expect(await fs.readFile(join(elsewhere, 'settings.json'), 'utf8')).toBe('after');
    void file;
  });

  it('shows both sides as text, and nothing for what was not kept', async () => {
    const { tracker, change } = await oneChange('old text', 'new text');
    expect(await tracker.configChangeTexts(env.folder.key, change.id)).toEqual({
      before: 'old text',
      after: 'new text',
    });
    expect(await tracker.configChangeTexts(env.folder.key, 'unknown')).toBeUndefined();
  });

  it('shows an empty side for a created or deleted file', async () => {
    const created = await oneChange(undefined, 'made');
    expect(await created.tracker.configChangeTexts(env.folder.key, created.change.id)).toEqual({
      before: '',
      after: 'made',
    });
  });

  it('gives no text for a binary file or a file too large to keep, which cannot be reverted', async () => {
    const bin = Buffer.from([0, 1, 2, 3, 255]);
    await env.write({ '.vscode/settings.json': bin });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.command(() => fs.writeFile(env.abs('.vscode/settings.json'), 'text now'));
    await turn.end();
    const [binChange] = tracker.configChanges(env.folder.key);
    expect(await tracker.configChangeTexts(env.folder.key, binChange!.id)).toBeUndefined();
    await tracker.resolveConfigChange(env.folder.key, binChange!.id, 'keep');

    const huge = Buffer.alloc(1024 * 1024 + 10, 97);
    await fs.writeFile(env.abs('.vscode/tasks.json'), huge);
    const turn2 = new Turn(tracker, env);
    await turn2.begin();
    await turn2.command(() => fs.writeFile(env.abs('.vscode/tasks.json'), 'small'));
    await turn2.end();
    const [bigChange] = tracker.configChanges(env.folder.key);
    expect(bigChange).toMatchObject({ revertible: false });
    expect(await tracker.configChangeTexts(env.folder.key, bigChange!.id)).toBeUndefined();
    await expect(
      tracker.resolveConfigChange(env.folder.key, bigChange!.id, 'revert'),
    ).rejects.toThrow(/cannot be reverted/);
    expect(sha(await fs.readFile(env.abs('.vscode/tasks.json')))).toBe(sha('small'));
  });

  it('survives a new tracker on the same storage', async () => {
    const { tracker, change } = await oneChange('before', 'after');
    await tracker.dispose();

    const second = env.tracker();
    // Readable before the folder is opened again.
    expect(second.configChanges(env.folder.key)).toMatchObject([
      { id: change.id, displayPath: '.vscode/settings.json', changeType: 'modified' },
    ]);
    await expect(new Turn(second, env).begin()).rejects.toThrow(CONFIG_PENDING_MESSAGE);
    expect(await second.configChangeTexts(env.folder.key, change.id)).toEqual({
      before: 'before',
      after: 'after',
    });
    await second.resolveConfigChange(env.folder.key, change.id, 'revert');
    expect(await env.read('.vscode/settings.json')).toBe('before');
    const turn = new Turn(second, env);
    await turn.begin();
    await turn.end();
  });

  it('revert after a restart works on a fresh tracker', async () => {
    const { tracker, change } = await oneChange('before', 'after');
    await tracker.dispose();
    const second = env.tracker();
    await second.resolveConfigChange(env.folder.key, change.id, 'revert');
    expect(await env.read('.vscode/settings.json')).toBe('before');
  });

  it('a changed file mode alone is a change', async () => {
    if (!posix) return;
    await repo();
    await fs.mkdir(env.abs('../../.git/hooks'), { recursive: true });
    const hook = env.abs('../../.git/hooks/pre-commit');
    await fs.writeFile(hook, '#!/bin/sh\n', { mode: 0o644 });
    const tracker = env.tracker();
    await openWorkspace(tracker, env);
    const turn = new Turn(tracker, env);
    await turn.begin();
    await turn.command(() => fs.chmod(hook, 0o755));
    await turn.end();
    expect(tracker.configChanges(env.folder.key)).toMatchObject([
      { displayPath: '.git/hooks/pre-commit', changeType: 'modified' },
    ]);
  });
});
