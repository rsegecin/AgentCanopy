import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeModels,
  compareVersions,
  detectClaude,
  MINIMUM_CLAUDE_VERSION,
  modelDisplayName,
} from './index';
import type { ExecFn } from './index';

let dir: string;
let binDir: string;
let homeDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'agc-detect-'));
  binDir = join(dir, 'bin');
  homeDir = join(dir, 'home');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(join(homeDir, '.local', 'bin'), { recursive: true });
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function touch(path: string, executable = true): Promise<string> {
  await fs.writeFile(path, '#!/bin/sh\n');
  if (executable) await fs.chmod(path, 0o755);
  return path;
}

type Reply = { exitCode?: number | null; stdout?: string; stderr?: string; error?: string };

interface Script {
  version?: Reply;
  auth?: Reply;
  probe?: Reply;
}

function fakeExec(script: Script): { exec: ExecFn; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = [];
  const exec: ExecFn = (command, args) => {
    calls.push({ command, args });
    const key = args.includes('--version')
      ? 'version'
      : args.includes('auth')
        ? 'auth'
        : args.includes('--resume-session-at')
          ? 'probe'
          : undefined;
    const reply = (key ? script[key] : undefined) ?? { exitCode: 1, error: 'unscripted' };
    return Promise.resolve({
      exitCode: reply.exitCode === undefined ? 0 : reply.exitCode,
      stdout: reply.stdout ?? '',
      stderr: reply.stderr ?? '',
      ...(reply.error !== undefined ? { error: reply.error } : {}),
    });
  };
  return { exec, calls };
}

const GOOD: Script = {
  version: { stdout: '2.1.322 (Claude Code)\n' },
  auth: { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) },
  probe: { exitCode: 1, stderr: "error: option '--resume-session-at <uuid>' argument missing" },
};

function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: binDir, ...extra };
}

describe('locating the executable', () => {
  it('finds claude on PATH', async () => {
    const claude = await touch(join(binDir, 'claude'));
    const { exec, calls } = fakeExec(GOOD);
    const { status, launch } = await detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec,
    });
    expect(status.installed).toBe(true);
    expect(status.version).toBe('2.1.322');
    expect(status.meetsMinimum).toBe(true);
    expect(launch).toEqual({ command: claude, prefixArgs: [] });
    expect(calls[0]).toEqual({ command: claude, args: ['--version'] });
  });

  it('finds claude only in the home location', async () => {
    const claude = await touch(join(homeDir, '.local', 'bin', 'claude'));
    const { exec } = fakeExec(GOOD);
    const { status, launch } = await detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'linux',
      homeDir,
      exec,
    });
    expect(status.installed).toBe(true);
    expect(launch?.command).toBe(claude);
  });

  it('skips a non-executable file on PATH', async () => {
    await touch(join(binDir, 'claude'), false);
    const { exec } = fakeExec(GOOD);
    const { status } = await detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec,
    });
    expect(status.installed).toBe(false);
  });

  it('reports not installed when nothing is found', async () => {
    const { exec, calls } = fakeExec(GOOD);
    const { status, launch } = await detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec,
    });
    expect(status.installed).toBe(false);
    expect(status.meetsMinimum).toBe(false);
    expect(status.problems).toEqual([
      'Claude Code was not found. Install it, or set the path in the AgentCanopy settings.',
    ]);
    expect(launch).toBeUndefined();
    expect(calls).toEqual([]);
    expect(Object.values(status.capabilities).every((v) => v === false || v === 'none')).toBe(true);
  });

  it('uses an explicit path and ignores PATH', async () => {
    await touch(join(binDir, 'claude'));
    const explicit = await touch(join(dir, 'custom-claude'));
    const { exec, calls } = fakeExec(GOOD);
    const { launch } = await detectClaude({
      claudePath: explicit,
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec,
    });
    expect(launch?.command).toBe(explicit);
    expect(calls[0]?.command).toBe(explicit);
  });

  it('does not fall back to PATH when the explicit path is missing', async () => {
    await touch(join(binDir, 'claude'));
    const { exec } = fakeExec(GOOD);
    const { status } = await detectClaude({
      claudePath: join(dir, 'nope'),
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec,
    });
    expect(status.installed).toBe(false);
    expect(status.problems[0]).toContain('was not found');
  });

  it('rejects a relative explicit path', async () => {
    const { exec } = fakeExec(GOOD);
    const { status } = await detectClaude({
      claudePath: 'claude',
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec,
    });
    expect(status.installed).toBe(false);
  });

  it('lets launchOverride win and puts its prefix args first', async () => {
    await touch(join(binDir, 'claude'));
    const { exec, calls } = fakeExec(GOOD);
    const { status, launch } = await detectClaude({
      claudePath: join(dir, 'nope'),
      env: envFor(),
      launchOverride: { command: 'node', prefixArgs: ['fake-claude.js'] },
      platform: 'darwin',
      homeDir,
      exec,
    });
    expect(status.installed).toBe(true);
    expect(launch).toEqual({ command: 'node', prefixArgs: ['fake-claude.js'] });
    expect(calls.map((c) => c.args)).toContainEqual(['fake-claude.js', '--version']);
    expect(calls.every((c) => c.command === 'node' && c.args[0] === 'fake-claude.js')).toBe(true);
  });

  it('on win32 looks for claude.exe', async () => {
    const claude = await touch(join(binDir, 'claude.exe'), false);
    const { exec } = fakeExec(GOOD);
    const { status, launch } = await detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'win32',
      homeDir,
      exec,
    });
    expect(launch?.command).toBe(claude);
    expect(status.capabilities.cancellation).toBe('hard');
    expect(status.capabilities.sandbox).toBe(false);
  });

  it('on win32 reports an npm shim as not installed', async () => {
    for (const name of ['claude.cmd', 'claude.bat', 'claude.ps1']) {
      await touch(join(binDir, name), false);
      const { exec, calls } = fakeExec(GOOD);
      const { status } = await detectClaude({
        claudePath: '',
        env: envFor(),
        platform: 'win32',
        homeDir,
        exec,
      });
      expect(status.installed).toBe(false);
      expect(status.problems).toEqual([
        'AgentCanopy needs the native Claude Code install (claude.exe). An npm shim was found instead.',
      ]);
      expect(calls).toEqual([]);
      await fs.rm(join(binDir, name));
    }
  });

  it('on win32 prefers claude.exe found later over a shim found earlier', async () => {
    const otherBin = join(dir, 'bin2');
    await fs.mkdir(otherBin);
    await touch(join(binDir, 'claude.cmd'), false);
    const exe = await touch(join(otherBin, 'claude.exe'), false);
    const { exec } = fakeExec(GOOD);
    const { launch } = await detectClaude({
      claudePath: '',
      env: { PATH: [binDir, otherBin].join(delimiter) },
      platform: 'win32',
      homeDir,
      exec,
    });
    expect(launch?.command).toBe(exe);
  });

  it('on win32 reads the Path variable regardless of case', async () => {
    const exe = await touch(join(binDir, 'claude.exe'), false);
    const { exec } = fakeExec(GOOD);
    const { launch } = await detectClaude({
      claudePath: '',
      env: { Path: binDir },
      platform: 'win32',
      homeDir,
      exec,
    });
    expect(launch?.command).toBe(exe);
  });
});

describe('version', () => {
  async function detectWith(script: Script) {
    await touch(join(binDir, 'claude'));
    return detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec: fakeExec(script).exec,
    });
  }

  it('compares versions numerically', () => {
    expect(compareVersions('2.1.295', '2.1.295')).toBe(0);
    expect(compareVersions('2.1.294', '2.1.295')).toBeLessThan(0);
    expect(compareVersions('2.1.1000', '2.1.295')).toBeGreaterThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('3', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
  });

  it('accepts exactly the minimum', async () => {
    const { status, launch } = await detectWith({
      ...GOOD,
      version: { stdout: `${MINIMUM_CLAUDE_VERSION} (Claude Code)` },
    });
    expect(status.meetsMinimum).toBe(true);
    expect(launch).toBeDefined();
  });

  it('reports a version that is too old, naming both versions', async () => {
    const { status, launch } = await detectWith({ ...GOOD, version: { stdout: '2.1.294' } });
    expect(status.installed).toBe(true);
    expect(status.version).toBe('2.1.294');
    expect(status.meetsMinimum).toBe(false);
    expect(status.minimumVersion).toBe(MINIMUM_CLAUDE_VERSION);
    expect(status.problems).toHaveLength(1);
    expect(status.problems[0]).toContain('2.1.294');
    expect(status.problems[0]).toContain(MINIMUM_CLAUDE_VERSION);
    expect(Object.values(status.capabilities).every((v) => v === false || v === 'none')).toBe(true);
    expect(launch).toBeUndefined();
  });

  it('reports an unparseable version', async () => {
    const { status, launch } = await detectWith({ ...GOOD, version: { stdout: 'hello' } });
    expect(status.installed).toBe(true);
    expect(status.version).toBeUndefined();
    expect(status.meetsMinimum).toBe(false);
    expect(status.problems[0]).toContain('version could not be read');
    expect(launch).toBeUndefined();
  });

  it('survives an exec error and a non-zero exit at the version step', async () => {
    const failed = await detectWith({ ...GOOD, version: { exitCode: null, error: 'timed out' } });
    expect(failed.status.installed).toBe(true);
    expect(failed.status.meetsMinimum).toBe(false);
    expect(failed.status.problems).toHaveLength(1);
    const nonZero = await detectWith({ ...GOOD, version: { exitCode: 2, stdout: '2.1.322' } });
    expect(nonZero.status.meetsMinimum).toBe(false);
    expect(nonZero.launch).toBeUndefined();
  });
});

describe('sign-in state', () => {
  async function detectWith(script: Script, env: NodeJS.ProcessEnv = {}) {
    await touch(join(binDir, 'claude'));
    return detectClaude({
      claudePath: '',
      env: envFor(env),
      platform: 'darwin',
      homeDir,
      exec: fakeExec(script).exec,
    });
  }
  const auth = (loggedIn: boolean, authMethod?: string): Script => ({
    ...GOOD,
    auth: { stdout: JSON.stringify({ loggedIn, ...(authMethod ? { authMethod } : {}) }) },
  });

  it('maps each auth method to a credential', async () => {
    const credential = async (method: string) =>
      (await detectWith(auth(true, method))).status.credential;
    expect(await credential('claude.ai')).toBe('subscription');
    expect(await credential('oauth_token')).toBe('subscription');
    expect(await credential('api_key')).toBe('api-key');
    expect(await credential('api_key_helper')).toBe('api-key');
    expect(await credential('third_party')).toBe('other');
    expect(await credential('something_new')).toBe('unknown');
    const { status } = await detectWith(auth(true, 'claude.ai'));
    expect(status.auth).toBe('signed-in');
    expect(status.problems).toEqual([]);
  });

  it('reports signed out, even when auth status exits non-zero', async () => {
    const { status, launch } = await detectWith({
      ...GOOD,
      auth: { exitCode: 1, stdout: JSON.stringify({ loggedIn: false }) },
    });
    expect(status.auth).toBe('signed-out');
    expect(status.credential).toBe('unknown');
    expect(status.problems).toEqual([
      'Claude Code is not signed in. Use Sign in to open a terminal and run its login.',
    ]);
    expect(status.meetsMinimum).toBe(true);
    expect(launch).toBeDefined();
  });

  it('reports unknown for unparseable output, an exec error or a missing field', async () => {
    for (const reply of [
      { stdout: 'not json' },
      { stdout: '' },
      { stdout: '[1]' },
      { stdout: '{}' },
      { exitCode: null, error: 'timed out' },
    ]) {
      const { status } = await detectWith({ ...GOOD, auth: reply });
      expect(status.auth).toBe('unknown');
      expect(status.credential).toBe('unknown');
      expect(status.capabilities.streaming).toBe(true);
    }
  });

  it('flags an ANTHROPIC_API_KEY variable and reports an api-key credential', async () => {
    const { status } = await detectWith(auth(true, 'claude.ai'), { ANTHROPIC_API_KEY: 'sk-test' });
    expect(status.credential).toBe('api-key');
    expect(status.problems).toEqual([
      'An ANTHROPIC_API_KEY environment variable is set, so Claude Code bills the API account instead of your subscription.',
    ]);
    expect(JSON.stringify(status)).not.toContain('sk-test');
  });

  it('ignores an empty ANTHROPIC_API_KEY', async () => {
    const { status } = await detectWith(auth(true, 'claude.ai'), { ANTHROPIC_API_KEY: '' });
    expect(status.credential).toBe('subscription');
    expect(status.problems).toEqual([]);
  });

  it('puts the signed-out problem before the API key notice', async () => {
    const { status } = await detectWith(auth(false), { ANTHROPIC_API_KEY: 'k' });
    expect(status.problems).toHaveLength(2);
    expect(status.problems[0]).toContain('not signed in');
    expect(status.problems[1]).toContain('ANTHROPIC_API_KEY');
  });

  it('never leaks account details from auth status', async () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      authMethod: 'claude.ai',
      email: 'jane.doe@example.com',
      orgName: 'Acme Secret Industries',
      orgId: 'org-123',
    });
    const result = await detectWith({ ...GOOD, auth: { stdout, stderr: 'jane.doe@example.com' } });
    const json = JSON.stringify(result);
    expect(json).not.toContain('jane.doe');
    expect(json).not.toContain('example.com');
    expect(json).not.toContain('Acme');
    expect(json).not.toContain('org-123');
    const signedOut = await detectWith({
      ...GOOD,
      auth: { stdout: JSON.stringify({ loggedIn: false, email: 'jane.doe@example.com' }) },
    });
    expect(JSON.stringify(signedOut)).not.toContain('jane.doe');
  });
});

describe('capabilities', () => {
  async function detectWith(script: Script, platform: NodeJS.Platform = 'darwin') {
    const name = platform === 'win32' ? 'claude.exe' : 'claude';
    await touch(join(binDir, name), platform !== 'win32');
    return detectClaude({
      claudePath: '',
      env: envFor(),
      platform,
      homeDir,
      exec: fakeExec(script).exec,
    });
  }

  it('enables fork at message when the probe says an argument is missing', async () => {
    const { status } = await detectWith(GOOD);
    expect(status.capabilities).toEqual({
      streaming: true,
      resume: true,
      forkWhole: true,
      forkAtMessage: 'exact',
      modelSelection: true,
      interactiveApproval: true,
      readOnlyEnforcement: 'tool-layer',
      cancellation: 'graceful',
      toolEvents: true,
      interactiveQuestions: true,
      usage: true,
      hostTools: true,
      sandbox: true,
      sessionHistory: false,
    });
  });

  it('finds the message on stdout as well', async () => {
    const { status } = await detectWith({ ...GOOD, probe: { stdout: 'Argument Missing' } });
    expect(status.capabilities.forkAtMessage).toBe('exact');
  });

  it('disables fork at message for unknown option, a timeout and an exec error', async () => {
    for (const probe of [
      { exitCode: 1, stderr: "error: unknown option '--resume-session-at'" },
      { exitCode: null, error: 'timed out' },
      { exitCode: null, error: 'ENOENT', stderr: 'argument missing' },
      { exitCode: 0 },
    ]) {
      const { status } = await detectWith({ ...GOOD, probe });
      expect(status.capabilities.forkAtMessage).toBe('none');
      expect(status.capabilities.streaming).toBe(true);
    }
  });

  it('runs the probe with no value', async () => {
    await touch(join(binDir, 'claude'));
    const { exec, calls } = fakeExec(GOOD);
    await detectClaude({ claudePath: '', env: envFor(), platform: 'darwin', homeDir, exec });
    expect(calls.map((c) => c.args)).toEqual([
      ['--version'],
      ['auth', 'status'],
      ['--resume-session-at'],
    ]);
  });

  it('differs per platform', async () => {
    const linux = (await detectWith(GOOD, 'linux')).status.capabilities;
    expect(linux.sandbox).toBe(true);
    expect(linux.cancellation).toBe('graceful');
    const win = (await detectWith(GOOD, 'win32')).status.capabilities;
    expect(win.sandbox).toBe(false);
    expect(win.cancellation).toBe('hard');
  });

  it('identifies the provider', async () => {
    const { status } = await detectWith(GOOD);
    expect(status.providerId).toBe('claude-code');
    expect(status.displayName).toBe('Claude Code');
    expect(status.minimumVersion).toBe('2.1.295');
  });
});

describe('robustness', () => {
  it('never throws when exec throws', async () => {
    await touch(join(binDir, 'claude'));
    const result = await detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec: () => {
        throw new Error('boom');
      },
    });
    expect(result.status.problems).toHaveLength(1);
    expect(result.status.meetsMinimum).toBe(false);
  });

  it('never throws when exec rejects', async () => {
    await touch(join(binDir, 'claude'));
    const result = await detectClaude({
      claudePath: '',
      env: envFor(),
      platform: 'darwin',
      homeDir,
      exec: () => Promise.reject(new Error('boom')),
    });
    expect(result.status.meetsMinimum).toBe(false);
  });

  it('runs the real default exec against a script, without a shell', async () => {
    const script = await touch(join(binDir, 'claude'));
    await fs.writeFile(
      script,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.322 (Claude Code)"; exit 0; fi\n' +
        'if [ "$1" = "auth" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi\n' +
        'echo "error: option \'--resume-session-at <uuid>\' argument missing" >&2; exit 1\n',
    );
    const { status } = await detectClaude({
      claudePath: script,
      env: envFor(),
      platform: process.platform === 'win32' ? 'linux' : process.platform,
      homeDir,
    });
    expect(status.version).toBe('2.1.322');
    expect(status.auth).toBe('signed-in');
    expect(status.capabilities.forkAtMessage).toBe('exact');
  });
});

describe('claudeModels', () => {
  it('lists the built-in entries first, with versioned labels', () => {
    expect(claudeModels([])).toEqual([
      { id: 'default', label: 'Default (Claude Code decides)', custom: false },
      { id: 'sonnet', label: 'Sonnet 5.5', custom: false, resolved: 'claude-sonnet-5-5' },
      { id: 'opus', label: 'Opus 5.5', custom: false, resolved: 'claude-opus-5-5' },
      { id: 'haiku', label: 'Haiku 5.5', custom: false, resolved: 'claude-haiku-5-5' },
      { id: 'fable', label: 'Fable 5.2', custom: false, resolved: 'claude-fable-5-2' },
      {
        id: 'fable+delegate',
        label: 'Fable 5.2 · orchestrate and delegate',
        custom: false,
        resolved: 'claude-fable-5-2',
      },
    ]);
  });

  it('appends custom ids without duplicates', () => {
    const models = claudeModels(['my-model', ' my-model ', 'sonnet', '', 'other']);
    expect(models.slice(6)).toEqual([
      { id: 'my-model', label: 'my-model', custom: true },
      { id: 'other', label: 'other', custom: true },
    ]);
    expect(models).toHaveLength(8);
  });

  it('a learned id sets the label and resolved of its alias, and the delegate entry follows fable', () => {
    const models = claudeModels([], { opus: 'claude-opus-6', fable: 'claude-fable-6-1-20270101' });
    expect(models.find((m) => m.id === 'opus')).toEqual({
      id: 'opus',
      label: 'Opus 6',
      custom: false,
      resolved: 'claude-opus-6',
    });
    expect(models.find((m) => m.id === 'fable')).toMatchObject({
      label: 'Fable 6.1',
      resolved: 'claude-fable-6-1-20270101',
    });
    expect(models.find((m) => m.id === 'fable+delegate')).toEqual({
      id: 'fable+delegate',
      label: 'Fable 6.1 · orchestrate and delegate',
      custom: false,
      resolved: 'claude-fable-6-1-20270101',
    });
    expect(models.find((m) => m.id === 'sonnet')?.label).toBe('Sonnet 5.5');
  });

  it('default gains the version and resolved only when learned', () => {
    const unknown = claudeModels([])[0];
    expect(unknown).toEqual({
      id: 'default',
      label: 'Default (Claude Code decides)',
      custom: false,
    });
    expect(unknown).not.toHaveProperty('resolved');
    expect(claudeModels([], { default: 'claude-fable-5-2' })[0]).toEqual({
      id: 'default',
      label: 'Default (Claude Code decides) · Fable 5.2',
      custom: false,
      resolved: 'claude-fable-5-2',
    });
  });

  it('an unrecognised learned id keeps the table label and sets resolved', () => {
    const models = claudeModels([], {
      opus: 'anthropic.claude-opus-v1:0',
      default: 'anthropic.claude-opus-v1:0',
    });
    expect(models.find((m) => m.id === 'opus')).toEqual({
      id: 'opus',
      label: 'Opus 5.5',
      custom: false,
      resolved: 'anthropic.claude-opus-v1:0',
    });
    expect(models[0]).toEqual({
      id: 'default',
      label: 'Default (Claude Code decides)',
      custom: false,
      resolved: 'anthropic.claude-opus-v1:0',
    });
  });

  it.each([
    ['a space', 'claude opus-6'],
    ['101 characters', 'a'.repeat(101)],
    ['an empty string', ''],
    ['a number', 6],
    ['an object', {}],
  ])('ignores a learned value with %s', (_name, value) => {
    const models = claudeModels([], { opus: value as string, default: value as string });
    expect(models).toEqual(claudeModels([]));
    expect(models[0]).not.toHaveProperty('resolved');
  });

  it('does not read a learned id from the prototype', () => {
    const known = Object.create({ opus: 'claude-opus-9', default: 'claude-opus-9' }) as Record<
      string,
      string
    >;
    expect(claudeModels([], known)).toEqual(claudeModels([]));
    const polluted = JSON.parse('{"__proto__": "claude-opus-9"}') as Record<string, string>;
    expect(claudeModels(['__proto__+delegate'], polluted).at(-1)).toEqual({
      id: '__proto__+delegate',
      label: '__proto__ · orchestrate and delegate',
      custom: true,
    });
  });

  it('labels custom delegate choices from their base', () => {
    const models = claudeModels(
      [
        'opus+delegate',
        'default+delegate',
        'my-model+delegate',
        'fable+delegate',
        'sonnet+delegate',
      ],
      { sonnet: 'claude-sonnet-6' },
    );
    expect(models.slice(6)).toEqual([
      {
        id: 'opus+delegate',
        label: 'Opus 5.5 · orchestrate and delegate',
        custom: true,
        resolved: 'claude-opus-5-5',
      },
      { id: 'default+delegate', label: 'Default · orchestrate and delegate', custom: true },
      { id: 'my-model+delegate', label: 'my-model · orchestrate and delegate', custom: true },
      {
        id: 'sonnet+delegate',
        label: 'Sonnet 6 · orchestrate and delegate',
        custom: true,
        resolved: 'claude-sonnet-6',
      },
    ]);
    // 'fable+delegate' is the built-in entry and is listed once.
    expect(models.filter((m) => m.id === 'fable+delegate')).toHaveLength(1);
    expect(models.find((m) => m.id === 'fable+delegate')?.custom).toBe(false);
  });

  it('returns fresh objects on every call', () => {
    const first = claudeModels(['x']);
    first[1]!.label = 'changed';
    first.pop();
    const second = claudeModels(['x']);
    expect(second[1]?.label).toBe('Sonnet 5.5');
    expect(second).toHaveLength(7);
  });
});

describe('modelDisplayName', () => {
  it.each([
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-fable-5', 'Fable 5'],
    ['claude-haiku-5-5-20260101', 'Haiku 5.5'],
    ['claude-fable-5-20260101', 'Fable 5'],
    ['claude-opus-5-5[1m]', 'Opus 5.5 (1M)'],
    ['claude-3-5-sonnet-20241022', undefined],
    ['opus', undefined],
    ['', undefined],
    ['claude-opus-5-5-extra', undefined],
    ['anthropic.claude-opus-v1:0', undefined],
  ])('names %j as %j', (id, name) => {
    expect(modelDisplayName(id)).toBe(name);
  });
});
