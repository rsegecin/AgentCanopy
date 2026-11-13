import { promises as fs } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectClaude } from './detect';
import type { ExecFn } from './exec';
import { locateClaude } from './locate';

const posix = process.platform !== 'win32';
const exeName = posix ? 'claude' : 'claude.exe';

let dir: string;
let binDir: string;
let homeDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'agc-locate-'));
  binDir = join(dir, 'bin');
  homeDir = join(dir, 'home');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function touch(path: string): Promise<string> {
  await fs.writeFile(path, '#!/bin/sh\n');
  await fs.chmod(path, 0o755);
  return path;
}

describe('locateClaude with relative PATH entries', () => {
  it('never picks an executable through a relative entry, even one that resolves to a real file', async () => {
    await touch(join(binDir, exeName));
    // Relative to the current directory, this entry names the real binDir.
    const relativeToCwd = relative(process.cwd(), binDir);
    expect(isAbsolute(relativeToCwd)).toBe(false);
    const path = ['.', 'node_modules/.bin', '', '  ', relativeToCwd, './bin'].join(delimiter);
    const result = await locateClaude({
      claudePath: '',
      env: { PATH: path },
      platform: process.platform,
      homeDir,
    });
    expect(result).toEqual({ kind: 'missing' });
  });

  it('still finds claude in an absolute entry listed after relative ones', async () => {
    const claude = await touch(join(binDir, exeName));
    const result = await locateClaude({
      claudePath: '',
      env: { PATH: ['.', '', 'node_modules/.bin', binDir].join(delimiter) },
      platform: process.platform,
      homeDir,
    });
    expect(result).toEqual({ kind: 'found', command: claude });
    if (result.kind === 'found') expect(isAbsolute(result.command)).toBe(true);
  });

  it('ignores a relative home directory', async () => {
    const result = await locateClaude({
      claudePath: '',
      env: { PATH: '' },
      platform: process.platform,
      homeDir: relative(process.cwd(), homeDir),
    });
    expect(result).toEqual({ kind: 'missing' });
  });
});

describe('detectClaude probes', () => {
  it('runs every command with the home directory as cwd', async () => {
    const claude = await touch(join(binDir, exeName));
    const seen: { args: string[]; cwd: string | undefined }[] = [];
    const exec: ExecFn = (_command, args, opts) => {
      seen.push({ args, cwd: opts.cwd });
      const stdout = args.includes('--version')
        ? '2.1.322 (Claude Code)\n'
        : args.includes('auth')
          ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })
          : '';
      return Promise.resolve({
        exitCode: args.includes('--resume-session-at') ? 1 : 0,
        stdout,
        stderr: "error: option '--resume-session-at <uuid>' argument missing",
      });
    };
    const { launch } = await detectClaude({
      claudePath: '',
      env: { PATH: binDir },
      platform: process.platform,
      homeDir,
      exec,
    });
    expect(launch?.command).toBe(claude);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.some((s) => s.args.includes('--version'))).toBe(true);
    expect(seen.some((s) => s.args.includes('auth'))).toBe(true);
    expect(seen.some((s) => s.args.includes('--resume-session-at'))).toBe(true);
    for (const call of seen) expect(call.cwd).toBe(homeDir);
  });

  it('uses the real home directory by default', async () => {
    await touch(join(binDir, exeName));
    const cwds: (string | undefined)[] = [];
    const exec: ExecFn = (_c, _a, opts) => {
      cwds.push(opts.cwd);
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
    };
    await detectClaude({ claudePath: '', env: { PATH: binDir }, platform: process.platform, exec });
    expect(cwds.length).toBeGreaterThan(0);
    for (const cwd of cwds) expect(cwd).toBe(homedir());
  });

  it('the default exec honours cwd', async () => {
    if (!posix) return;
    const { defaultExec } = await import('./exec');
    const result = await defaultExec(
      process.execPath,
      ['-e', 'process.stdout.write(process.cwd())'],
      {
        timeoutMs: 5000,
        env: process.env,
        cwd: await fs.realpath(homeDir),
      },
    );
    expect(result.stdout).toBe(await fs.realpath(homeDir));
  });
});
