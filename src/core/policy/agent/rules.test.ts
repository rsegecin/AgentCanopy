import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FolderKey } from '../../../shared';
import { makeTempDir, removeDir } from '../readonly/test-support';
import { createRuleStore } from './index';

const KEY = 'folder-1' as FolderKey;

describe('rule store', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await makeTempDir('rules'), 'rules');
  });
  afterEach(() => removeDir(join(dir, '..')));

  async function open(logger?: Parameters<typeof createRuleStore>[0]['logger']) {
    const store = createRuleStore(logger ? { dir, logger } : { dir });
    await store.init();
    return store;
  }

  it('starts empty and creates its directory', async () => {
    const store = await open();
    expect(store.list(KEY)).toEqual([]);
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it('persists rules per folder, in order, across instances', async () => {
    const store = await open();
    await store.add(KEY, 'Bash(npm test)');
    await store.add(KEY, 'mcp__x__y');
    await store.add('other' as FolderKey, 'Bash(ls)');
    expect(store.list(KEY)).toEqual(['Bash(npm test)', 'mcp__x__y']);
    const again = await open();
    expect(again.list(KEY)).toEqual(['Bash(npm test)', 'mcp__x__y']);
    expect(again.list('other' as FolderKey)).toEqual(['Bash(ls)']);
    expect(JSON.parse(await fs.readFile(join(dir, `${KEY}.json`), 'utf8'))).toEqual({
      allow: ['Bash(npm test)', 'mcp__x__y'],
    });
  });

  it('leaves no temporary file behind', async () => {
    const store = await open();
    await store.add(KEY, 'Bash(ls)');
    await store.remove(KEY, 'Bash(ls)');
    expect((await fs.readdir(dir)).sort()).toEqual([`${KEY}.json`]);
  });

  it('list returns a copy', async () => {
    const store = await open();
    await store.add(KEY, 'Bash(ls)');
    store.list(KEY).push('x');
    expect(store.list(KEY)).toEqual(['Bash(ls)']);
  });

  it('ignores a duplicate', async () => {
    const store = await open();
    await store.add(KEY, 'Bash(ls)');
    await store.add(KEY, 'Bash(ls)');
    expect(store.list(KEY)).toEqual(['Bash(ls)']);
  });

  it('removes a rule, and removing an unknown one does nothing', async () => {
    const store = await open();
    await store.add(KEY, 'Bash(ls)');
    await store.add(KEY, 'Bash(pwd)');
    await store.remove(KEY, 'Bash(ls)');
    await store.remove(KEY, 'Bash(nothing)');
    expect(store.list(KEY)).toEqual(['Bash(pwd)']);
    expect((await open()).list(KEY)).toEqual(['Bash(pwd)']);
  });

  it.each([
    ['empty', ''],
    ['more than 500 characters', 'x'.repeat(501)],
    ['a bare tool name', 'Bash'],
    ['a wildcard', 'Bash(*)'],
    ['a prefix rule', 'Bash(curl:*)'],
    ['a command with a glob', 'Bash(rm *.txt)'],
    ['a command with a quote', 'Bash(echo "x")'],
    ['an empty command', 'Bash()'],
    ['a command with outer spaces', 'Bash( ls)'],
    ['a command of 301 characters', `Bash(${'a'.repeat(301)})`],
    ['an unclosed rule', 'Bash(ls'],
    ['a command with a leading assignment', 'Bash(PATH=./bin ls)'],
    ['an edit rule', 'Edit'],
    ['a path rule', 'Read(/etc/passwd)'],
    ['our own tool', 'mcp__agentcanopy__submit_plan'],
    ['a server-wide MCP rule', 'mcp__x'],
    ['an MCP wildcard', 'mcp__x__*'],
    ['an MCP name with a dot', 'mcp__x__y.z'],
    ['a newline', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['a NUL', 'a\u0000b'],
    ['a C1 control', 'a\u0085b'],
    ['a line separator', 'a b'],
    ['not a string', 42 as unknown as string],
  ])('rejects a rule that is %s', async (_name, rule) => {
    const store = await open();
    await expect(store.add(KEY, rule)).rejects.toThrow('That rule cannot be saved.');
    expect(store.list(KEY)).toEqual([]);
  });

  it('accepts the longest command rule and an MCP tool name', async () => {
    const store = await open();
    await store.add(KEY, `Bash(${'a'.repeat(300)})`);
    await store.add(KEY, 'mcp__my-server__do_it-2');
    expect(store.list(KEY)).toHaveLength(2);
  });

  it('rejects the 201st rule with a plain message', async () => {
    const store = await open();
    for (let i = 0; i < 200; i += 1) await store.add(KEY, `Bash(cmd ${i})`);
    await expect(store.add(KEY, 'Bash(one more)')).rejects.toThrow(
      'This folder already has 200 saved rules. Remove some before adding more.',
    );
    expect(store.list(KEY)).toHaveLength(200);
    // An existing rule is still fine, and removing makes room.
    await store.add(KEY, 'Bash(cmd 5)');
    await store.remove(KEY, 'Bash(cmd 5)');
    await store.add(KEY, 'Bash(one more)');
  });

  it.each(['', 'a/b', '..', 'a b', 'x'.repeat(65), 'a.json', 'ä'])(
    'rejects the folder key %j',
    async (key) => {
      const store = await open();
      await expect(store.add(key as FolderKey, 'Bash(ls)')).rejects.toThrow();
      await expect(store.remove(key as FolderKey, 'Bash(ls)')).rejects.toThrow();
      expect(store.list(key as FolderKey)).toEqual([]);
    },
  );

  it('accepts a 64-character folder key', async () => {
    const store = await open();
    const key = `${'a'.repeat(32)}_${'B-'.repeat(15)}z` as FolderKey;
    expect(key.length).toBeLessThanOrEqual(64);
    await store.add(key, 'Bash(ls)');
    expect((await open()).list(key)).toEqual(['Bash(ls)']);
  });

  it('treats an invalid file as empty and logs it', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, `${KEY}.json`), '{ not json');
    await fs.writeFile(join(dir, 'shape.json'), JSON.stringify({ allow: 'Bash(ls)' }));
    const warnings: string[] = [];
    const store = await open({
      debug: () => undefined,
      info: () => undefined,
      warn: (message) => void warnings.push(message),
      error: () => undefined,
    });
    expect(store.list(KEY)).toEqual([]);
    expect(store.list('shape' as FolderKey)).toEqual([]);
    expect(warnings).toHaveLength(2);
    // The store still works for that folder afterwards.
    await store.add(KEY, 'Bash(ls)');
    expect((await open()).list(KEY)).toEqual(['Bash(ls)']);
  });

  it('drops invalid and repeated entries from a file and keeps the rest', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, `${KEY}.json`),
      JSON.stringify({ allow: ['Bash(ls)', 42, 'bad\nrule', 'Bash(ls)', ''] }),
    );
    expect((await open()).list(KEY)).toEqual(['Bash(ls)']);
  });

  it('keeps only the two allowed shapes of a tampered file, and logs a count without the content', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, `${KEY}.json`),
      JSON.stringify({
        allow: [
          'Bash',
          'Bash(*)',
          'Bash(curl:*)',
          'Bash(npm test)',
          'mcp__x__y',
          'mcp__agentcanopy__submit_plan',
          'Edit',
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
    expect(store.list(KEY)).toEqual(['Bash(npm test)', 'mcp__x__y']);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('"kept":2');
    expect(logged[0]).toContain('"found":7');
    expect(logged[0]).not.toContain('curl');
  });

  it('ignores files that are not rule files', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'notes.txt'), 'x');
    await fs.writeFile(join(dir, 'bad key.json'), JSON.stringify({ allow: ['Bash(ls)'] }));
    const store = await open();
    expect(store.list('bad key' as FolderKey)).toEqual([]);
  });

  it('refuses to add before init', async () => {
    const store = createRuleStore({ dir });
    await expect(store.add(KEY, 'Bash(ls)')).rejects.toThrow('not been opened');
  });

  it('adds made at the same time are all kept', async () => {
    const store = await open();
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(KEY, `Bash(cmd ${i})`)));
    expect(store.list(KEY)).toHaveLength(20);
    expect((await open()).list(KEY)).toHaveLength(20);
  });

  it('keeps the old state when a write fails', async () => {
    const store = await open();
    await store.add(KEY, 'Bash(ls)');
    await fs.rm(dir, { recursive: true, force: true });
    await expect(store.add(KEY, 'Bash(pwd)')).rejects.toThrow();
    expect(store.list(KEY)).toEqual(['Bash(ls)']);
  });
});
