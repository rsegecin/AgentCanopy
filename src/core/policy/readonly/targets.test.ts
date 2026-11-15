import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cannotJudge, checkPath, checkPattern, splitPattern } from './targets';
import { makeTempDir, removeDir, writeTree } from './test-support';

describe('cannotJudge', () => {
  describe('rule a: whitespace or a control character at either end (every platform)', () => {
    it.each([
      ['a leading space', ' C:\\Users\\you\\.ssh'],
      ['a trailing space', 'src/a.ts '],
      ['a leading tab', '\tsrc/a.ts'],
      ['a trailing newline', 'src/a.ts\n'],
      ['a leading NUL', '\u0000src'],
      ['a trailing DEL', 'src\u007f'],
      ['a leading no-break space', '\u00a0src'],
      ['only a space', ' '],
    ])('flags %s', (_name, value) => {
      for (const platform of ['win32', 'linux', 'darwin'] as const) {
        expect(cannotJudge(value, platform)).toBe(true);
      }
    });

    it('does not flag the empty string or spaces inside', () => {
      for (const platform of ['win32', 'linux'] as const) {
        expect(cannotJudge('', platform)).toBe(false);
        expect(cannotJudge('my file/a b.txt', platform)).toBe(false);
      }
    });
  });

  describe('rule b: rooted without a drive (win32 only)', () => {
    it.each(['/c/Users/x', '\\Users\\x', '/', '\\', '/etc/passwd'])('flags %s', (value) => {
      expect(cannotJudge(value, 'win32')).toBe(true);
    });

    it.each(['\\\\server\\share', '//server/share', '\\\\?\\C:\\x', '\\/server'])(
      'does not flag %s, which starts with two separators',
      (value) => {
        expect(cannotJudge(value, 'win32')).toBe(false);
      },
    );
  });

  describe('rule c: a drive letter without a separator after the colon (win32 only)', () => {
    it.each(['C:Users', 'C:', 'c:foo\\bar', 'z:x'])('flags %s', (value) => {
      expect(cannotJudge(value, 'win32')).toBe(true);
    });

    it.each(['C:\\x', 'C:/x', 'c:\\', 'C:/'])('does not flag %s', (value) => {
      expect(cannotJudge(value, 'win32')).toBe(false);
    });
  });

  describe('rule d: a segment that ends in a dot or a space (win32 only)', () => {
    it.each(['C:\\Users\\x\\.ssh.\\id', 'a\\b \\c', 'a/b./c', 'dir.', '...\\x', 'a\\...'])(
      'flags %s',
      (value) => {
        expect(cannotJudge(value, 'win32')).toBe(true);
      },
    );

    it.each([
      'a.b',
      'my file',
      '.ssh',
      '.',
      '..',
      'a/./b/../c',
      '..\\..\\Windows',
      'src/a.ts',
      'C:\\Users\\x',
    ])('does not flag %s', (value) => {
      expect(cannotJudge(value, 'win32')).toBe(false);
    });
  });

  describe('other platforms', () => {
    it.each(['/etc/passwd', 'C:Users', 'a/.ssh./b', 'C:', '\\x', 'dir.', 'a b /c'])(
      'does not flag %s on linux',
      (value) => {
        expect(cannotJudge(value, 'linux')).toBe(false);
      },
    );

    it('flags a leading-space and a trailing-space value on linux', () => {
      expect(cannotJudge(' /etc/passwd', 'linux')).toBe(true);
      expect(cannotJudge('/etc/passwd ', 'linux')).toBe(true);
    });
  });
});

describe('splitPattern', () => {
  it('on win32 splits at backslashes too and joins with /', () => {
    expect(splitPattern('C:\\Users\\x\\.ssh\\*', 'win32')).toEqual({
      prefix: 'C:/Users/x/.ssh',
      rest: '*',
    });
    expect(splitPattern('..\\..\\Windows\\*', 'win32')).toEqual({
      prefix: '../../Windows',
      rest: '*',
    });
    expect(splitPattern('a\\b/c\\**\\*.ts', 'win32')).toEqual({
      prefix: 'a/b/c',
      rest: '**/*.ts',
    });
  });

  it('on linux a backslash is part of a segment', () => {
    expect(splitPattern('C:\\Users\\x\\.ssh\\*', 'linux')).toEqual({
      prefix: '',
      rest: 'C:\\Users\\x\\.ssh\\*',
    });
    expect(splitPattern('a\\b/c/*', 'linux')).toEqual({ prefix: 'a\\b/c', rest: '*' });
  });

  it.each(['win32', 'linux'] as const)('forward-slash patterns are the same on %s', (platform) => {
    expect(splitPattern('src/**/*.ts', platform)).toEqual({ prefix: 'src', rest: '**/*.ts' });
    expect(splitPattern('**/*.ts', platform)).toEqual({ prefix: '', rest: '**/*.ts' });
    expect(splitPattern('src/a.ts', platform)).toEqual({ prefix: 'src/a.ts', rest: '' });
    expect(splitPattern('', platform)).toEqual({ prefix: '', rest: '' });
    expect(splitPattern('/*', platform)).toEqual({ prefix: '/', rest: '*' });
    expect(splitPattern('/etc/*', platform)).toEqual({ prefix: '/etc', rest: '*' });
    expect(splitPattern('{a,../b}/*', platform)).toEqual({ prefix: '', rest: '{a,../b}/*' });
  });
});

describe('checkPath and checkPattern on real folders', () => {
  let root: string;
  let folder: string;
  let outside: string;

  beforeEach(async () => {
    root = await makeTempDir('readonly-targets');
    folder = join(root, 'folder');
    outside = join(root, 'outside');
    await writeTree(folder, { 'src/a.ts': 'a', 'inside/real.txt': 'x' });
    await writeTree(outside, { 'secret.txt': 's', 'dir/inner.txt': 'i' });
  });
  afterEach(() => removeDir(root));

  describe('checkPath', () => {
    it('a value with a leading space is outside, with no real path, shown as given', async () => {
      for (const value of [' src/a.ts', ' src', 'src/a.ts ', '\tsrc']) {
        expect(await checkPath(value, folder, folder)).toEqual({
          inside: false,
          shown: value,
          real: undefined,
        });
      }
    });

    it('the same value without the space is inside', async () => {
      for (const value of ['src/a.ts', 'src']) {
        const result = await checkPath(value, folder, folder);
        expect(result.inside).toBe(true);
        expect(result.real).toBe(join(folder, value));
      }
    });

    it('a leading space is not judged by its prefix, even before ~ is expanded', async () => {
      expect(await checkPath(' ~/x', folder, folder)).toEqual({
        inside: false,
        shown: ' ~/x',
        real: undefined,
      });
    });
  });

  describe('checkPattern', () => {
    it('a pattern with a leading or trailing space is outside, shown as given', async () => {
      for (const pattern of [' src/*.ts', 'src/*.ts ', ' **/*']) {
        expect(await checkPattern(pattern, folder, folder)).toEqual({
          inside: false,
          shown: pattern,
          real: undefined,
        });
      }
    });

    it('a last segment that ends in a dot is not flagged', async () => {
      const result = await checkPattern('**/*.', folder, folder);
      expect(result.inside).toBe(true);
    });

    it.runIf(process.platform === 'win32')(
      'a backslash pattern into a real directory outside is outside, with its real path',
      async () => {
        const result = await checkPattern(`${join(outside, 'dir')}\\*`, folder, folder);
        expect(result.inside).toBe(false);
        expect(result.real).toBe(join(outside, 'dir'));
        expect(result.shown).toBe(`${join(outside, 'dir')}/*`);
      },
    );

    it.runIf(process.platform === 'win32')(
      'a backslash pattern into a real directory inside is inside',
      async () => {
        const result = await checkPattern(`${join(folder, 'inside')}\\*`, folder, folder);
        expect(result.inside).toBe(true);
        expect(result.real).toBe(join(folder, 'inside'));
        expect((await checkPattern('src\\*.ts', folder, folder)).inside).toBe(true);
      },
    );

    it.runIf(process.platform === 'win32')('..\\..\\* from the folder is outside', async () => {
      const result = await checkPattern('..\\..\\*', folder, folder);
      expect(result.inside).toBe(false);
      expect(result.real).toBe(join(root, '..'));
    });

    it.runIf(process.platform === 'win32')(
      'a rooted, drive-relative or dot-ending prefix is outside with no real path',
      async () => {
        for (const pattern of ['\\Users\\x\\*', 'C:Users\\*', `${outside}.\\*`, 'src \\*']) {
          expect(await checkPattern(pattern, folder, folder)).toEqual({
            inside: false,
            shown: pattern,
            real: undefined,
          });
        }
      },
    );
  });
});
