import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, writeTree } from '../readonly/test-support';
import { inspectProjectConfig } from './index';

describe('inspectProjectConfig', () => {
  let root: string;
  let folder: string;
  beforeEach(async () => {
    root = await makeTempDir('project-config');
    folder = join(root, 'folder');
    await fs.mkdir(folder);
  });
  afterEach(() => removeDir(root));

  const settings = (value: unknown, name = 'settings.json') =>
    writeTree(folder, { [`.claude/${name}`]: JSON.stringify(value) });
  const mcp = (value: unknown) => writeTree(folder, { '.mcp.json': JSON.stringify(value) });

  it('an empty folder needs nothing', async () => {
    const result = await inspectProjectConfig(folder);
    expect(result).toMatchObject({
      items: [],
      needsSettingsDecision: false,
      needsMcpDecision: false,
      hasClaudeMd: false,
    });
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  describe('the safe set of settings', () => {
    it.each([
      ['only permissions.deny', { permissions: { deny: ['Bash(rm:*)'] } }],
      ['deny and ask', { permissions: { deny: ['Edit'], ask: ['Bash'] } }],
      [
        'all four safe keys',
        {
          permissions: { deny: [], ask: [] },
          includeCoAuthoredBy: false,
          cleanupPeriodDays: 7,
        },
      ],
      ['an empty object', {}],
    ])('%s needs no decision', async (_name, value) => {
      await settings(value);
      await settings({ includeCoAuthoredBy: true }, 'settings.local.json');
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: [],
        needsSettingsDecision: false,
        needsMcpDecision: false,
      });
    });
  });

  describe('items', () => {
    const items = async (value: unknown) => {
      await settings(value);
      const result = await inspectProjectConfig(folder);
      expect(result.needsSettingsDecision).toBe(true);
      expect(result.needsMcpDecision).toBe(false);
      return result.items;
    };

    it('hooks', async () => {
      expect(await items({ hooks: { SessionStart: [], PreToolUse: [] } })).toEqual([
        'Hooks that run commands: SessionStart, PreToolUse',
      ]);
    });

    it('environment variables', async () => {
      expect(await items({ env: { ANTHROPIC_BASE_URL: 'http://x', NODE_OPTIONS: '--x' } })).toEqual(
        ['Environment variables: ANTHROPIC_BASE_URL, NODE_OPTIONS'],
      );
    });

    it('helper commands', async () => {
      expect(await items({ apiKeyHelper: './key.sh', statusLine: { command: 'x' } })).toEqual([
        'Helper commands: apiKeyHelper, statusLine',
      ]);
    });

    it('pre-approved permissions', async () => {
      expect(await items({ permissions: { allow: ['Bash', 'Read(//**)'], deny: ['x'] } })).toEqual([
        'Pre-approved permissions: Bash, Read(//**)',
      ]);
    });

    it('extra folders', async () => {
      expect(await items({ permissions: { additionalDirectories: ['/'] } })).toEqual([
        'Extra folders the agent may read: /',
      ]);
    });

    it('other settings, including keys inside permissions', async () => {
      expect(
        await items({
          model: 'opus',
          enableAllProjectMcpServers: true,
          permissions: { defaultMode: 'bypassPermissions', deny: [] },
        }),
      ).toEqual(['Other settings: model, enableAllProjectMcpServers, permissions.defaultMode']);
    });

    it('a safe key with the wrong shape is not safe', async () => {
      expect(await items({ permissions: 'all' })).toEqual(['Other settings: permissions']);
      await settings({ permissions: { deny: 'Bash' } });
      expect((await inspectProjectConfig(folder)).items).toEqual([
        'Other settings: permissions.deny',
      ]);
      await settings({ hooks: {}, env: [], permissions: { allow: [] } });
      expect((await inspectProjectConfig(folder)).items).toEqual([
        'Other settings: hooks, env, permissions.allow',
      ]);
    });

    it('everything together, in a fixed order', async () => {
      expect(
        await items({
          model: 'x',
          hooks: { SessionStart: [] },
          env: { A: '1' },
          apiKeyHelper: 'k',
          permissions: { allow: ['Bash'], additionalDirectories: ['/'] },
        }),
      ).toEqual([
        'Hooks that run commands: SessionStart',
        'Environment variables: A',
        'Helper commands: apiKeyHelper',
        'Pre-approved permissions: Bash',
        'Extra folders the agent may read: /',
        'Other settings: model',
      ]);
    });

    it('settings.local.json is inspected and merged with settings.json', async () => {
      await settings({ hooks: { PreToolUse: [] } });
      await settings(
        { hooks: { PreToolUse: [], Stop: [] }, env: { B: '2' } },
        'settings.local.json',
      );
      expect((await inspectProjectConfig(folder)).items).toEqual([
        'Hooks that run commands: PreToolUse, Stop',
        'Environment variables: B',
      ]);
    });

    it('names are escaped and each item is cut to 120 characters', async () => {
      await settings({ hooks: { 'Pre‮Tool': [] }, env: { ['V'.repeat(200)]: '1' } });
      const { items: found } = await inspectProjectConfig(folder);
      expect(found[0]).toBe('Hooks that run commands: Pre\\u{202E}Tool');
      expect(found[1]).toHaveLength(120);
      expect(found[1]?.startsWith('Environment variables: VVV')).toBe(true);
    });

    it('more than 20 items end with "and N more"', async () => {
      const servers: Record<string, unknown> = {};
      for (let i = 0; i < 25; i += 1) servers[`s${i}`] = { command: 'x' };
      await mcp({ mcpServers: servers });
      const { items: found } = await inspectProjectConfig(folder);
      expect(found).toHaveLength(21);
      expect(found[0]).toBe('Tool server s0: x');
      expect(found[20]).toBe('and 5 more');
    });
  });

  describe('files that cannot be used', () => {
    it('invalid JSON in a settings file', async () => {
      await writeTree(folder, { '.claude/settings.json': '{ nope' });
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: ['.claude/settings.json is not valid JSON'],
        needsSettingsDecision: true,
        needsMcpDecision: false,
      });
    });

    it('invalid JSON in .mcp.json', async () => {
      await writeTree(folder, { '.mcp.json': 'x' });
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: ['.mcp.json is not valid JSON'],
        needsSettingsDecision: false,
        needsMcpDecision: true,
      });
    });

    it('a settings file that is not an object', async () => {
      await writeTree(folder, { '.claude/settings.local.json': '[1]' });
      const result = await inspectProjectConfig(folder);
      expect(result.needsSettingsDecision).toBe(true);
      expect(result.items).toEqual(['.claude/settings.local.json is not a settings object']);
    });

    it('a symlinked settings file is not read', async () => {
      await writeTree(root, { 'real.json': JSON.stringify({ permissions: { deny: [] } }) });
      await fs.mkdir(join(folder, '.claude'));
      await fs.symlink(join(root, 'real.json'), join(folder, '.claude/settings.json'));
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: ['.claude/settings.json could not be read safely'],
        needsSettingsDecision: true,
      });
    });

    it('a symlinked .mcp.json is not read', async () => {
      await writeTree(root, { 'real.json': '{}' });
      await fs.symlink(join(root, 'real.json'), join(folder, '.mcp.json'));
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: ['.mcp.json could not be read safely'],
        needsMcpDecision: true,
        needsSettingsDecision: false,
      });
    });

    it('a symlinked .claude folder is not followed', async () => {
      await writeTree(root, { 'other/settings.json': JSON.stringify({ hooks: { A: [] } }) });
      await fs.symlink(join(root, 'other'), join(folder, '.claude'));
      const result = await inspectProjectConfig(folder);
      expect(result.needsSettingsDecision).toBe(true);
      expect(result.items).toEqual([
        '.claude/settings.json could not be read safely',
        '.claude/settings.local.json could not be read safely',
      ]);
    });

    it('a directory where a file should be', async () => {
      await fs.mkdir(join(folder, '.mcp.json'));
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: ['.mcp.json could not be read safely'],
        needsMcpDecision: true,
      });
    });

    it('a file over 1 MiB is not read; a file of exactly 1 MiB is', async () => {
      const pad = (size: number) => `{"permissions":{"deny":[]},"x":"${'a'.repeat(size)}"}`;
      const prefix = pad(0).length;
      await writeTree(folder, { '.claude/settings.json': pad(1024 * 1024 - prefix) });
      expect((await inspectProjectConfig(folder)).items).toEqual(['Other settings: x']);
      await writeTree(folder, { '.claude/settings.json': pad(1024 * 1024 - prefix + 1) });
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: ['.claude/settings.json could not be read safely'],
        needsSettingsDecision: true,
      });
    });
  });

  describe('.mcp.json', () => {
    it('lists each server by command and arguments, or by address', async () => {
      await mcp({
        mcpServers: {
          files: { command: 'npx', args: ['-y', 'server-files', '/'] },
          remote: { type: 'http', url: 'https://example.com/mcp' },
          odd: { type: 'stdio' },
          bare: { command: 'tool', args: [1, 'x'] },
        },
      });
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: [
          'Tool server files: npx -y server-files /',
          'Tool server remote: https://example.com/mcp',
          'Tool server odd: (no command or address)',
          'Tool server bare: tool x',
        ],
        needsMcpDecision: true,
        needsSettingsDecision: false,
      });
    });

    it('escapes the server name and command', async () => {
      await mcp({ mcpServers: { 'a‮b': { command: 'x\u0007y' } } });
      expect((await inspectProjectConfig(folder)).items).toEqual([
        'Tool server a\\u{202E}b: x\\u{0007}y',
      ]);
    });

    it('a file without servers needs no decision', async () => {
      await mcp({ mcpServers: {} });
      expect(await inspectProjectConfig(folder)).toMatchObject({
        items: [],
        needsMcpDecision: false,
      });
      await mcp({ other: 1 });
      expect((await inspectProjectConfig(folder)).needsMcpDecision).toBe(false);
    });
  });

  describe('the git root', () => {
    it('inspects the same three files above the folder', async () => {
      const sub = join(folder, 'packages/app');
      await fs.mkdir(sub, { recursive: true });
      await writeTree(folder, {
        '.claude/settings.json': JSON.stringify({ env: { A: '1' } }),
        '.mcp.json': JSON.stringify({ mcpServers: { s: { command: 'x' } } }),
      });
      const without = await inspectProjectConfig(sub);
      expect(without).toMatchObject({ items: [], needsSettingsDecision: false });
      const result = await inspectProjectConfig(sub, { gitRoot: folder });
      expect(result.needsSettingsDecision).toBe(true);
      expect(result.needsMcpDecision).toBe(true);
      expect(result.items).toEqual(['Environment variables: A', 'Tool server s: x']);
      expect(result.fingerprint).not.toBe(without.fingerprint);
    });

    it('a problem at the git root names the full path', async () => {
      const sub = join(folder, 'app');
      await fs.mkdir(sub);
      await writeTree(folder, { '.mcp.json': '{' });
      expect((await inspectProjectConfig(sub, { gitRoot: folder })).items).toEqual([
        `${join(folder, '.mcp.json')} is not valid JSON`,
      ]);
    });

    it('a git root equal to the folder changes nothing', async () => {
      await settings({ env: { A: '1' } });
      const plain = await inspectProjectConfig(folder);
      expect(await inspectProjectConfig(folder, { gitRoot: folder })).toEqual(plain);
      expect(await inspectProjectConfig(folder, { gitRoot: `${folder}/` })).toEqual(plain);
    });
  });

  describe('the fingerprint', () => {
    it('is stable for unchanged files', async () => {
      await settings({ env: { A: '1' } });
      const a = await inspectProjectConfig(folder);
      const b = await inspectProjectConfig(folder);
      expect(a.fingerprint).toBe(b.fingerprint);
    });

    it('changes when a file changes, appears or disappears', async () => {
      const none = (await inspectProjectConfig(folder)).fingerprint;
      await mcp({ mcpServers: {} });
      const appeared = (await inspectProjectConfig(folder)).fingerprint;
      expect(appeared).not.toBe(none);
      await mcp({ mcpServers: { s: { command: 'x' } } });
      const changed = (await inspectProjectConfig(folder)).fingerprint;
      expect(changed).not.toBe(appeared);
      await fs.rm(join(folder, '.mcp.json'));
      expect((await inspectProjectConfig(folder)).fingerprint).toBe(none);
    });

    it('changes for a change that keeps the same length', async () => {
      await settings({ env: { A: '1' } });
      const one = (await inspectProjectConfig(folder)).fingerprint;
      await settings({ env: { A: '2' } });
      expect((await inspectProjectConfig(folder)).fingerprint).not.toBe(one);
    });

    it('tells the same bytes in different files apart', async () => {
      await settings({ env: { A: '1' } });
      const a = (await inspectProjectConfig(folder)).fingerprint;
      await fs.rename(
        join(folder, '.claude/settings.json'),
        join(folder, '.claude/settings.local.json'),
      );
      expect((await inspectProjectConfig(folder)).fingerprint).not.toBe(a);
    });

    it('changes when an unreadable file changes its kind', async () => {
      const none = (await inspectProjectConfig(folder)).fingerprint;
      await fs.mkdir(join(folder, '.mcp.json'));
      expect((await inspectProjectConfig(folder)).fingerprint).not.toBe(none);
    });

    it('is not changed by CLAUDE.md or by other files', async () => {
      const before = (await inspectProjectConfig(folder)).fingerprint;
      await writeTree(folder, { 'CLAUDE.md': 'x', 'src/a.ts': 'y', '.claude/other.json': '{}' });
      expect((await inspectProjectConfig(folder)).fingerprint).toBe(before);
    });
  });

  describe('hasClaudeMd', () => {
    it('finds CLAUDE.md in the folder', async () => {
      await writeTree(folder, { 'CLAUDE.md': 'x' });
      expect((await inspectProjectConfig(folder)).hasClaudeMd).toBe(true);
    });

    it('finds .claude/CLAUDE.md', async () => {
      await writeTree(folder, { '.claude/CLAUDE.md': 'x' });
      expect((await inspectProjectConfig(folder)).hasClaudeMd).toBe(true);
    });

    it('does not look elsewhere', async () => {
      await writeTree(folder, { 'docs/CLAUDE.md': 'x' });
      await writeTree(root, { 'CLAUDE.md': 'x' });
      expect((await inspectProjectConfig(folder)).hasClaudeMd).toBe(false);
    });
  });

  it('never changes the folder', async () => {
    await settings({ hooks: { A: [] } });
    await mcp({ mcpServers: { s: { command: 'touch', args: ['marker'] } } });
    const before = await fs.readdir(folder);
    await inspectProjectConfig(folder);
    expect(await fs.readdir(folder)).toEqual(before);
    expect(before).not.toContain('marker');
  });
});
