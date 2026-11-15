import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderKey } from '../../../shared';
import { makeTempDir, recordingLogger, removeDir } from '../readonly/test-support';
import { createGrantStore, isValidGrant, MAX_GRANTS_PER_FOLDER, type Grant } from './index';

const KEY = 'folder-1' as FolderKey;
const DIR_GRANT: Grant = {
  kind: 'read-directory',
  path: process.platform === 'win32' ? 'D:\\libs\\shared' : '/libs/shared',
};
const SITE: Grant = { kind: 'web-site', host: 'docs.example.com' };
const PS: Grant = { kind: 'powershell-command', command: 'npm test' };

describe('isValidGrant', () => {
  const absolute = DIR_GRANT.kind === 'read-directory' ? DIR_GRANT.path : '';

  it.each([
    ['a directory', DIR_GRANT],
    ['a site', SITE],
    ['a site with a port', { kind: 'web-site', host: 'example.com:8080' }],
    ['an IPv6 site', { kind: 'web-site', host: '[::1]:8080' }],
    ['a punycode site', { kind: 'web-site', host: 'xn--bcher-kva.example' }],
    ['a PowerShell command', PS],
    ['a PowerShell command with a path', { kind: 'powershell-command', command: '.\\run.ps1 -x' }],
  ])('accepts %s', (_name, grant) => {
    expect(isValidGrant(grant)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['an unknown kind', { kind: 'other', path: absolute }],
    ['no kind', { path: absolute }],
    ['a relative directory', { kind: 'read-directory', path: 'libs/shared' }],
    ['an empty directory', { kind: 'read-directory', path: '' }],
    ['a directory that is not a string', { kind: 'read-directory', path: 42 }],
    [
      'a directory of 4097 characters',
      { kind: 'read-directory', path: `${absolute}${'a'.repeat(4100)}` },
    ],
    ['a directory with a control character', { kind: 'read-directory', path: `${absolute}\nx` }],
    ['a directory with a bidi control', { kind: 'read-directory', path: `${absolute}\u202ex` }],
    ['a site in upper case', { kind: 'web-site', host: 'Example.com' }],
    ['a site with a user name', { kind: 'web-site', host: 'a@example.com' }],
    ['a site with a path', { kind: 'web-site', host: 'example.com/x' }],
    ['a site with a space', { kind: 'web-site', host: 'example .com' }],
    ['an empty site', { kind: 'web-site', host: '' }],
    ['a site of 262 characters', { kind: 'web-site', host: 'a'.repeat(262) }],
    ['a site that is not normal', { kind: 'web-site', host: '127.1' }],
    ['a site that is not a string', { kind: 'web-site', host: 7 }],
    ['a command with $', { kind: 'powershell-command', command: 'echo $x' }],
    ['a command with a semicolon', { kind: 'powershell-command', command: 'a; b' }],
    ['a command with a space at the end', { kind: 'powershell-command', command: 'ls ' }],
    ['a command of 301 characters', { kind: 'powershell-command', command: 'a'.repeat(301) }],
    ['an empty command', { kind: 'powershell-command', command: '' }],
  ])('rejects %s', (_name, grant) => {
    expect(isValidGrant(grant)).toBe(false);
  });
});

describe('grant store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await makeTempDir('grants'), 'permissions');
  });
  afterEach(() => removeDir(join(dir, '..')));

  async function open(logger?: Parameters<typeof createGrantStore>[0]['logger']) {
    const store = createGrantStore(logger ? { dir, logger } : { dir });
    await store.init();
    return store;
  }

  it('starts empty and creates its directory', async () => {
    const store = await open();
    expect(store.get(KEY)).toEqual({ switches: [], grants: [] });
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it('round trips grants and switches through a second store, per folder', async () => {
    const store = await open();
    await store.add(KEY, DIR_GRANT);
    await store.add(KEY, SITE);
    await store.add(KEY, PS);
    await store.setSwitch(KEY, 'read-outside', true);
    await store.setSwitch(KEY, 'web-search', true);
    await store.add('other' as FolderKey, SITE);
    const again = await open();
    expect(again.get(KEY)).toEqual({
      switches: ['read-outside', 'web-search'],
      grants: [DIR_GRANT, SITE, PS],
    });
    expect(again.get('other' as FolderKey)).toEqual({ switches: [], grants: [SITE] });
    expect(JSON.parse(await fs.readFile(join(dir, `${KEY}.json`), 'utf8'))).toEqual({
      version: 1,
      switches: ['read-outside', 'web-search'],
      grants: [DIR_GRANT, SITE, PS],
    });
  });

  it('get returns a copy', async () => {
    const store = await open();
    await store.add(KEY, SITE);
    const got = store.get(KEY);
    got.grants.push(PS);
    got.switches.push('web-fetch');
    (got.grants[0] as { host: string }).host = 'evil.com';
    expect(store.get(KEY)).toEqual({ switches: [], grants: [SITE] });
  });

  it('leaves no temporary file behind', async () => {
    const store = await open();
    await store.add(KEY, SITE);
    await store.remove(KEY, SITE);
    await store.setSwitch(KEY, 'web-fetch', true);
    expect((await fs.readdir(dir)).sort()).toEqual([`${KEY}.json`]);
  });

  it('ignores a grant that is already there, and keeps only its own fields', async () => {
    const store = await open();
    await store.add(KEY, SITE);
    await store.add(KEY, { ...SITE, extra: 'x' } as Grant);
    expect(store.get(KEY).grants).toEqual([SITE]);
    await store.add(KEY, { kind: 'web-site', host: 'other.example', extra: 'x' } as Grant);
    expect(store.get(KEY).grants[1]).toEqual({ kind: 'web-site', host: 'other.example' });
  });

  it('removes a grant, and removing an absent one does nothing', async () => {
    const store = await open();
    await store.add(KEY, SITE);
    await store.add(KEY, PS);
    await store.remove(KEY, SITE);
    await store.remove(KEY, { kind: 'web-site', host: 'nothing.example' });
    await store.remove('unknown' as FolderKey, SITE);
    expect(store.get(KEY).grants).toEqual([PS]);
    expect((await open()).get(KEY).grants).toEqual([PS]);
  });

  it('turns a switch on and off, and doing it twice does nothing', async () => {
    const store = await open();
    await store.setSwitch(KEY, 'read-outside', true);
    await store.setSwitch(KEY, 'read-outside', true);
    await store.setSwitch(KEY, 'web-fetch', true);
    expect(store.get(KEY).switches).toEqual(['read-outside', 'web-fetch']);
    await store.setSwitch(KEY, 'read-outside', false);
    await store.setSwitch(KEY, 'web-search', false);
    expect(store.get(KEY).switches).toEqual(['web-fetch']);
    expect((await open()).get(KEY).switches).toEqual(['web-fetch']);
    await expect(store.setSwitch(KEY, 'everything' as 'web-fetch', true)).rejects.toThrow(
      'That permission cannot be saved.',
    );
  });

  it('rejects an invalid grant with a plain message', async () => {
    const store = await open();
    for (const bad of [
      { kind: 'powershell-command', command: 'a; b' },
      { kind: 'read-directory', path: 'relative' },
      { kind: 'web-site', host: 'A.com' },
      null,
    ]) {
      await expect(store.add(KEY, bad as unknown as Grant)).rejects.toThrow(
        'That permission cannot be saved.',
      );
    }
    expect(store.get(KEY).grants).toEqual([]);
  });

  it('rejects the 201st grant with a plain message, and removing makes room', async () => {
    const store = await open();
    for (let i = 0; i < MAX_GRANTS_PER_FOLDER; i += 1) {
      await store.add(KEY, { kind: 'powershell-command', command: `cmd ${i}` });
    }
    await expect(store.add(KEY, SITE)).rejects.toThrow(
      'This folder already has 200 saved permissions. Remove some before adding more.',
    );
    expect(store.get(KEY).grants).toHaveLength(200);
    // One that is there is still fine.
    await store.add(KEY, { kind: 'powershell-command', command: 'cmd 5' });
    await store.remove(KEY, { kind: 'powershell-command', command: 'cmd 5' });
    await store.add(KEY, SITE);
    expect(store.get(KEY).grants).toHaveLength(200);
  });

  it.each(['', 'a/b', '..', 'a b', 'x'.repeat(65), 'a.json', 'ä'])(
    'refuses the folder key %j',
    async (key) => {
      const store = await open();
      await expect(store.add(key as FolderKey, SITE)).rejects.toThrow();
      await expect(store.remove(key as FolderKey, SITE)).rejects.toThrow();
      await expect(store.setSwitch(key as FolderKey, 'web-fetch', true)).rejects.toThrow();
      expect(store.get(key as FolderKey)).toEqual({ switches: [], grants: [] });
    },
  );

  it('rejects every method before init', async () => {
    const store = createGrantStore({ dir });
    await expect(store.add(KEY, SITE)).rejects.toThrow('not been opened');
    await expect(store.remove(KEY, SITE)).rejects.toThrow('not been opened');
    await expect(store.setSwitch(KEY, 'web-fetch', true)).rejects.toThrow('not been opened');
  });

  it('keeps the old state when a write fails', async () => {
    const store = await open();
    await store.add(KEY, SITE);
    await store.setSwitch(KEY, 'web-fetch', true);
    await fs.rm(dir, { recursive: true, force: true });
    await expect(store.add(KEY, PS)).rejects.toThrow();
    await expect(store.remove(KEY, SITE)).rejects.toThrow();
    await expect(store.setSwitch(KEY, 'web-fetch', false)).rejects.toThrow();
    expect(store.get(KEY)).toEqual({ switches: ['web-fetch'], grants: [SITE] });
  });

  it('keeps every change made at the same time', async () => {
    const store = await open();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.add(KEY, { kind: 'powershell-command', command: `cmd ${i}` }),
      ),
    );
    expect(store.get(KEY).grants).toHaveLength(20);
    expect((await open()).get(KEY).grants).toHaveLength(20);
  });

  it('counts a broken file, a file of another shape and another version as empty, and logs each', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${KEY}.json`), '{ not json');
    await fs.writeFile(join(dir, 'shape.json'), JSON.stringify({ version: 1, grants: 'x' }));
    await fs.writeFile(
      join(dir, 'newer.json'),
      JSON.stringify({ version: 2, switches: ['web-fetch'], grants: [SITE] }),
    );
    await fs.writeFile(join(dir, 'old.json'), JSON.stringify({ allow: ['Bash(ls)'] }));
    const { logger, warnings } = recordingLogger();
    const store = await open(logger);
    for (const key of [KEY, 'shape', 'newer', 'old']) {
      expect(store.get(key as FolderKey)).toEqual({ switches: [], grants: [] });
    }
    expect(warnings).toHaveLength(4);
    // The store still works for that folder afterwards.
    await store.add('newer' as FolderKey, SITE);
    expect((await open()).get('newer' as FolderKey).grants).toEqual([SITE]);
  });

  it('drops invalid, repeated and too many entries on load, logs a count and keeps the rest', async () => {
    await fs.mkdir(dir, { recursive: true });
    const many = Array.from({ length: 250 }, (_, i) => ({
      kind: 'powershell-command',
      command: `cmd ${i}`,
    }));
    await fs.writeFile(
      join(dir, `${KEY}.json`),
      JSON.stringify({
        version: 1,
        switches: ['web-fetch', 'web-fetch', 'everything', 7, 'read-outside'],
        grants: [
          SITE,
          SITE,
          { kind: 'web-site', host: 'Evil.com' },
          { kind: 'powershell-command', command: 'rm $x' },
          { kind: 'read-directory', path: 'relative' },
          { kind: 'unknown' },
          'text',
          ...many,
        ],
      }),
    );
    const logged: string[] = [];
    const store = await open({
      debug: () => undefined,
      info: () => undefined,
      warn: (message, data) => void logged.push(JSON.stringify([message, data])),
      error: () => undefined,
    });
    const got = store.get(KEY);
    expect(got.switches).toEqual(['web-fetch', 'read-outside']);
    expect(got.grants).toHaveLength(200);
    expect(got.grants[0]).toEqual(SITE);
    expect(got.grants[1]).toEqual({ kind: 'powershell-command', command: 'cmd 0' });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"keptGrants":200');
    expect(logged[0]).toContain('"foundGrants":257');
    expect(logged[0]).not.toContain('Evil');
  });

  it('ignores files that are not permission files', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'notes.txt'), 'x');
    await fs.writeFile(
      join(dir, 'bad key.json'),
      JSON.stringify({ version: 1, switches: [], grants: [SITE] }),
    );
    const store = await open();
    expect(store.get('bad key' as FolderKey)).toEqual({ switches: [], grants: [] });
  });

  it.runIf(process.platform !== 'win32')('writes the file with mode 0600', async () => {
    const store = await open();
    await store.add(KEY, SITE);
    expect((await fs.stat(join(dir, `${KEY}.json`))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  });
});
