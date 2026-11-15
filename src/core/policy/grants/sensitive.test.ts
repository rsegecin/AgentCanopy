import { promises as fs } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, useHome } from '../readonly/test-support';
import {
  canGrantDirectory,
  containsSensitive,
  isSensitivePath,
  resolveSensitiveEnv,
  type SensitiveEnv,
} from './sensitive';

const HOME_NAMES = [
  '.ssh',
  '.aws',
  '.azure',
  '.gnupg',
  '.kube',
  '.docker',
  '.config',
  '.claude',
  '.claude.json',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.pypirc',
];
const onWindowsHost = process.platform === 'win32';

describe('sensitive paths', () => {
  let root: string;
  let home: string;
  let storage: string;
  let ordinary: string;
  const env = (platform: NodeJS.Platform): SensitiveEnv => ({ home, roots: [storage], platform });

  beforeEach(async () => {
    root = await makeTempDir('sensitive');
    home = join(root, 'home');
    storage = join(root, 'ext', 'storage');
    ordinary = join(root, 'libs', 'shared');
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(storage, { recursive: true });
    await fs.mkdir(ordinary, { recursive: true });
  });
  afterEach(() => removeDir(root));

  describe('isSensitivePath', () => {
    it.each(HOME_NAMES)('%s under the home directory, and below it', (name) => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(isSensitivePath(join(home, name), env(platform))).toBe(true);
        expect(isSensitivePath(join(home, name, 'a', 'b'), env(platform))).toBe(true);
      }
    });

    it('does not take a name that only starts like a listed one, or the same name elsewhere', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(isSensitivePath(join(home, '.ssh-keys', 'x'), env(platform))).toBe(false);
        expect(isSensitivePath(join(home, '.sshx'), env(platform))).toBe(false);
        expect(isSensitivePath(join(ordinary, '.ssh', 'x'), env(platform))).toBe(false);
        expect(isSensitivePath(join(home, 'projects', '.ssh'), env(platform))).toBe(false);
        expect(isSensitivePath(join(home, 'Documents', 'x'), env(platform))).toBe(false);
      }
    });

    it('AppData counts on win32 only, Library on darwin only', () => {
      const appData = join(home, 'AppData', 'Local', 'x');
      const library = join(home, 'Library', 'Preferences', 'x');
      expect(isSensitivePath(appData, env('win32'))).toBe(true);
      expect(isSensitivePath(appData, env('linux'))).toBe(false);
      expect(isSensitivePath(appData, env('darwin'))).toBe(false);
      expect(isSensitivePath(library, env('darwin'))).toBe(true);
      expect(isSensitivePath(library, env('linux'))).toBe(false);
      expect(isSensitivePath(library, env('win32'))).toBe(false);
    });

    it('a storage root and a path below it', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(isSensitivePath(storage, env(platform))).toBe(true);
        expect(isSensitivePath(join(storage, 'permissions', 'k.json'), env(platform))).toBe(true);
        expect(isSensitivePath(join(dirname(storage), 'other'), env(platform))).toBe(false);
        expect(isSensitivePath(`${storage}-more`, env(platform))).toBe(false);
      }
    });

    it('ignores case on win32 and darwin', () => {
      for (const platform of ['win32', 'darwin'] as const) {
        expect(isSensitivePath(join(home, '.SSH', 'id'), env(platform))).toBe(true);
        expect(isSensitivePath(join(home, '.Claude.JSON'), env(platform))).toBe(true);
        expect(isSensitivePath(storage.toUpperCase(), env(platform))).toBe(true);
      }
      expect(isSensitivePath(join(home, 'APPDATA', 'x'), env('win32'))).toBe(true);
      expect(isSensitivePath(join(home, 'LIBRARY', 'x'), env('darwin'))).toBe(true);
    });

    // path.relative of a Windows host ignores case whatever platform the environment names.
    it.skipIf(onWindowsHost)('keeps case on linux', () => {
      expect(isSensitivePath(join(home, '.SSH', 'id'), env('linux'))).toBe(false);
      expect(isSensitivePath(join(home, '.ssh', 'id'), env('linux'))).toBe(true);
      expect(isSensitivePath(storage.toUpperCase(), env('linux'))).toBe(false);
    });

    it('a path that starts with two backslashes counts on win32 only', () => {
      for (const path of ['\\\\server\\share\\x', '\\\\localhost\\C$\\Windows', '\\\\?\\C:\\x']) {
        expect(isSensitivePath(path, env('win32'))).toBe(true);
        expect(isSensitivePath(path, env('linux'))).toBe(false);
        expect(isSensitivePath(path, env('darwin'))).toBe(false);
      }
    });

    it('an ordinary directory is not sensitive', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(isSensitivePath(ordinary, env(platform))).toBe(false);
        expect(isSensitivePath(home, env(platform))).toBe(false);
      }
    });
  });

  describe('containsSensitive', () => {
    it('is true for the home directory, an ancestor of it, a storage root and a parent of it', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(containsSensitive(home, env(platform))).toBe(true);
        expect(containsSensitive(dirname(home), env(platform))).toBe(true);
        expect(containsSensitive(root, env(platform))).toBe(true);
        expect(containsSensitive(parse(root).root, env(platform))).toBe(true);
        expect(containsSensitive(storage, env(platform))).toBe(true);
        expect(containsSensitive(dirname(storage), env(platform))).toBe(true);
        expect(containsSensitive(join(home, '.ssh'), env(platform))).toBe(true);
      }
    });

    it('is false for an ordinary sibling and for a place below a sensitive one', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(containsSensitive(ordinary, env(platform))).toBe(false);
        expect(containsSensitive(join(root, 'libs'), env(platform))).toBe(false);
        expect(containsSensitive(join(home, 'Documents'), env(platform))).toBe(false);
        expect(containsSensitive(join(home, '.ssh', 'keys'), env(platform))).toBe(false);
        expect(containsSensitive(`${home}-other`, env(platform))).toBe(false);
      }
    });

    it('a directory that holds AppData holds a sensitive location on win32 only', () => {
      // `home` itself holds every location, so look at a place that holds only AppData.
      const alone: SensitiveEnv = { home: join(root, 'h2'), roots: [], platform: 'win32' };
      expect(containsSensitive(join(alone.home, 'AppData'), alone)).toBe(true);
      expect(containsSensitive(join(alone.home, 'AppData', 'Local'), alone)).toBe(false);
      expect(containsSensitive(join(alone.home, 'AppData'), { ...alone, platform: 'linux' })).toBe(
        false,
      );
    });
  });

  describe('canGrantDirectory', () => {
    it('is true for an ordinary directory', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(canGrantDirectory(ordinary, env(platform))).toBe(true);
        expect(canGrantDirectory(join(home, 'Documents'), env(platform))).toBe(true);
      }
    });

    it('is false for a filesystem or drive root', () => {
      expect(canGrantDirectory(parse(root).root, env('linux'))).toBe(false);
    });

    it('is false for the home directory and an ancestor of it', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(canGrantDirectory(home, env(platform))).toBe(false);
        expect(canGrantDirectory(dirname(home), env(platform))).toBe(false);
        expect(canGrantDirectory(root, env(platform))).toBe(false);
      }
    });

    it('is false for a sensitive directory and for one that holds a storage root', () => {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        expect(canGrantDirectory(join(home, '.ssh'), env(platform))).toBe(false);
        expect(canGrantDirectory(join(home, '.aws', 'sso'), env(platform))).toBe(false);
        expect(canGrantDirectory(storage, env(platform))).toBe(false);
        expect(canGrantDirectory(join(storage, 'x'), env(platform))).toBe(false);
        expect(canGrantDirectory(dirname(storage), env(platform))).toBe(false);
      }
    });

    it('is false for a path that is not absolute or that would be changed for display', () => {
      expect(canGrantDirectory('libs/shared', env('linux'))).toBe(false);
      expect(canGrantDirectory('', env('linux'))).toBe(false);
      expect(canGrantDirectory(`${ordinary}\u0001x`, env('linux'))).toBe(false);
      expect(canGrantDirectory(`${ordinary}\nx`, env('linux'))).toBe(false);
      expect(canGrantDirectory(`${ordinary}\u202ex`, env('linux'))).toBe(false);
    });

    it('is false for a network path on win32 only', () => {
      expect(canGrantDirectory('\\\\server\\share\\x', env('win32'))).toBe(false);
      expect(canGrantDirectory('\\\\localhost\\C$\\x', env('win32'))).toBe(false);
    });
  });

  describe('resolveSensitiveEnv', () => {
    it('gives the real home directory, the real roots without empty ones, and the platform', async () => {
      const restore = useHome(home);
      try {
        const link = join(root, 'link-to-storage');
        await fs.symlink(storage, link);
        const resolved = await resolveSensitiveEnv(() => [link, '', ordinary]);
        expect(resolved).toEqual({
          home: await fs.realpath(home),
          roots: [await fs.realpath(storage), await fs.realpath(ordinary)],
          platform: process.platform,
        });
      } finally {
        restore();
      }
    });
  });
});
