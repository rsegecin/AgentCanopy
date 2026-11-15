import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderKey } from '../../../shared';
import { createRuleStore, type RuleStore } from '../agent';
import { makeTempDir, removeDir } from '../readonly/test-support';
import { createGrantStore, createSavedPermissions, type GrantStore } from './index';

const KEY = 'folder-1' as FolderKey;
const DIR = process.platform === 'win32' ? 'D:\\libs\\shared' : '/libs/shared';

describe('saved permissions', () => {
  let root: string;
  let rules: RuleStore;
  let grants: GrantStore;

  async function open() {
    rules = createRuleStore({ dir: join(root, 'rules') });
    grants = createGrantStore({ dir: join(root, 'permissions') });
    await rules.init();
    await grants.init();
    return createSavedPermissions({ rules, grants });
  }

  beforeEach(async () => {
    root = await makeTempDir('saved');
  });
  afterEach(() => removeDir(root));

  async function fill() {
    const saved = await open();
    // Added in an order that is not the order of the list.
    await rules.add(KEY, 'mcp__github__create_issue');
    await grants.add(KEY, { kind: 'powershell-command', command: 'Get-ChildItem' });
    await rules.add(KEY, 'Bash(npm test)');
    await grants.add(KEY, { kind: 'web-site', host: 'docs.example.com' });
    await rules.add(KEY, 'Bash(git status)');
    await grants.add(KEY, { kind: 'read-directory', path: DIR });
    await grants.add(KEY, { kind: 'powershell-command', command: '.\\run.ps1' });
    return saved;
  }

  it('is empty for a folder with nothing', async () => {
    const saved = await open();
    expect(saved.list(KEY)).toEqual([]);
    expect(await saved.remove(KEY, 'a'.repeat(32))).toBe(false);
  });

  it('lists directories, sites, Bash commands, PowerShell commands and MCP tools, with their fields', async () => {
    const saved = await fill();
    const list = saved.list(KEY);
    expect(list).toMatchObject([
      { kind: 'read-directory', text: DIR },
      { kind: 'web-site', text: 'docs.example.com' },
      { kind: 'command', text: 'npm test', shell: 'bash', runsProjectCode: true },
      { kind: 'command', text: 'git status', shell: 'bash', runsProjectCode: false },
      { kind: 'command', text: 'Get-ChildItem', shell: 'powershell', runsProjectCode: false },
      { kind: 'command', text: '.\\run.ps1', shell: 'powershell', runsProjectCode: true },
      { kind: 'mcp-tool', text: 'mcp__github__create_issue' },
    ]);
    for (const entry of list) expect(entry.id).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(list.map((entry) => entry.id)).size).toBe(list.length);
  });

  it('ids are stable across restarts', async () => {
    const first = (await fill()).list(KEY).map((entry) => entry.id);
    const again = await open();
    expect(again.list(KEY).map((entry) => entry.id)).toEqual(first);
  });

  it('the text of a rule is escaped for display', async () => {
    await open();
    // The rule store refuses such a rule, so build one by hand to see the escape.
    const raw: RuleStore = {
      init: () => Promise.resolve(),
      list: () => ['Bash(echo a‮b)'],
      add: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const list = createSavedPermissions({ rules: raw, grants }).list(KEY);
    expect(list[0]?.text).toBe('echo a\\u{202E}b');
  });

  it('an id differs between a Bash and a PowerShell command with the same text', async () => {
    const saved = await open();
    await rules.add(KEY, 'Bash(ls)');
    await grants.add(KEY, { kind: 'powershell-command', command: 'ls' });
    const [bash, powershell] = saved.list(KEY);
    expect(bash?.id).not.toBe(powershell?.id);
  });

  it('removes by id from the store the entry came from, and returns false for an unknown id', async () => {
    const saved = await fill();
    const byText = (text: string) => saved.list(KEY).find((entry) => entry.text === text)?.id ?? '';

    expect(await saved.remove(KEY, byText('npm test'))).toBe(true);
    expect(rules.list(KEY)).toEqual(['mcp__github__create_issue', 'Bash(git status)']);
    expect(await saved.remove(KEY, byText('mcp__github__create_issue'))).toBe(true);
    expect(rules.list(KEY)).toEqual(['Bash(git status)']);

    expect(await saved.remove(KEY, byText('docs.example.com'))).toBe(true);
    expect(await saved.remove(KEY, byText('Get-ChildItem'))).toBe(true);
    expect(await saved.remove(KEY, byText(DIR))).toBe(true);
    expect(grants.get(KEY).grants).toEqual([{ kind: 'powershell-command', command: '.\\run.ps1' }]);

    expect(await saved.remove(KEY, 'f'.repeat(32))).toBe(false);
    expect(await saved.remove(KEY, '')).toBe(false);
    expect(await saved.remove(KEY, byText('npm test'))).toBe(false);
    // The id of another folder's entry does not remove anything here.
    const id = byText('git status');
    expect(await saved.remove('folder-2' as FolderKey, id)).toBe(false);
    expect(rules.list(KEY)).toEqual(['Bash(git status)']);
    expect(saved.list(KEY)).toHaveLength(2);
  });

  it('has: tells whether what a card offered is saved, by kind', async () => {
    const saved = await fill();
    const rule = (value: string, kind?: 'read-directory' | 'web-site' | 'command' | 'tool') => ({
      ...(kind ? { kind } : {}),
      rule: value,
      runsProjectCode: false,
    });
    expect(saved.has(KEY, rule(DIR, 'read-directory'))).toBe(true);
    expect(saved.has(KEY, rule(`${DIR}-x`, 'read-directory'))).toBe(false);
    expect(saved.has(KEY, rule('docs.example.com', 'web-site'))).toBe(true);
    expect(saved.has(KEY, rule('example.com', 'web-site'))).toBe(false);
    expect(saved.has(KEY, rule('PowerShell(Get-ChildItem)', 'command'))).toBe(true);
    expect(saved.has(KEY, rule('PowerShell(Get-Content)', 'command'))).toBe(false);
    expect(saved.has(KEY, rule('Bash(npm test)', 'command'))).toBe(true);
    expect(saved.has(KEY, rule('Bash(npm test)'))).toBe(true);
    expect(saved.has(KEY, rule('Bash(npm run build)'))).toBe(false);
    expect(saved.has(KEY, rule('mcp__github__create_issue', 'tool'))).toBe(true);
    expect(saved.has(KEY, rule('mcp__github__create_issue'))).toBe(true);
    expect(saved.has(KEY, rule('mcp__github__other'))).toBe(false);
    // A kind does not read the other store: a directory name is not a Bash rule.
    expect(saved.has(KEY, rule('Bash(npm test)', 'read-directory'))).toBe(false);
    expect(saved.has(KEY, rule(DIR, 'web-site'))).toBe(false);
    expect(saved.has('folder-2' as FolderKey, rule(DIR, 'read-directory'))).toBe(false);
    // A PowerShell rule is looked up in the grants, never in the rules.
    await rules.add(KEY, 'Bash(ls)');
    expect(saved.has(KEY, rule('PowerShell(ls)', 'command'))).toBe(false);
  });
});
